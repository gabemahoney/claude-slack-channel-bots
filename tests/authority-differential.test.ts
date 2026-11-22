/** Scoped admission versus the independent production full-reader entry point.
 * Invalid-state tests never change src or the frozen performance guards. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableWriteFileSync } from '../src/atomic-write.ts'
import {
  applySharedMembership, createSharedChannelAuthority, parseSharedChannelState, type SharedChannelState,
} from '../src/shared-channels.ts'
import {
  botAttemptBinding, botAttemptKey, validateBotAttemptRecord, type SharedBotAttempt,
  type ChannelDeliveryFacts,
} from '../src/channel-delivery-attempt.ts'
import { createReviewObserver, reviewLedger, supersedeReview } from '../src/reload-review.ts'
import { buildReviewRequest, emptyOperatorIntent } from '../src/reload-request.ts'
import { slackInstallationKey } from '../src/persona-slack-validation.ts'
import {
  SHARED_CHANNEL_IDS as C, configBytes, deliveryAttempt, makeSharedAuthority, membershipJoin,
  sharedRecoveryRequest,
} from './test-helpers/shared-channels.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'

let root: string, sequence: number
const captured: unknown[] = [], consoleOutput: unknown[][] = [], restoreConsole: (() => void)[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'authority-differential-')); sequence = 0
  for (const method of ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleOutput.push(args) })
    restoreConsole.push(() => spy.mockRestore())
  }
})
afterEach(() => {
  try {
    // Keep a separate capture: functional assertions reset their write and
    // publication arrays, but secrecy checks must retain intermediate output.
    assertNoLeak({ consoleOutput, captured, files: writtenFile(root) })
  } finally {
    for (const restore of restoreConsole) restore()
    restoreConsole.length = 0; consoleOutput.length = 0; captured.length = 0
    rmSync(root, { recursive: true, force: true })
  }
})
function captureResult<T>(operation: () => T): T {
  try {
    const result = operation()
    captured.push({ result })
    return result
  } catch (error) {
    captured.push({ error })
    throw error
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Change = (state: SharedChannelState, order: number) => void
type Scope = 'review' | 'membership' | 'configuration'
const installation = { teamId: 'T0TEST', appId: 'A0TEST', botUserId: 'U0TEST', botId: 'B0TEST' }
const setup = (order: number) => ({ installation, subscriptions: { member_joined_channel: 'verified' as const, channel_left: 'verified' as const },
  reinstall: 'complete' as const, recordedAt: 1_795_200_000_000, order })
const life = (state: SharedChannelState) => state.personas['alpha']!
const application = (state: SharedChannelState) => Object.values(state.outcomes.botAttempts!).find((a): a is Extract<SharedBotAttempt, { status: 'applied' }> => a.status === 'applied')!
const rawAlpha = (state: SharedChannelState) => (state.applied['personas'] as Array<Record<string, unknown>>)[0]!
function fullRead(state: SharedChannelState, path: string) {
  // Native JSON, not a cached/scoped encoder, makes the comparison independent
  // of the scoped stage's representation and serialization caches.
  return captureResult(() => parseSharedChannelState(Buffer.from(JSON.stringify(state, null, 2) + '\n'), path))
}
function rig(retainAttempt = true) {
  const dir = join(root, String(sequence++)); mkdirSync(dir)
  const input = makePersonaConfigInput({ channel_mode: 'open', personas: [
    makePersona({ name: 'alpha', channels: [{ id: C.primary, delivery: 'all' }], permission_prompts: C.primary }, dir),
    makePersona({ name: 'beta', channels: [{ id: C.primary, delivery: 'all' }], permission_prompts: C.primary }, dir),
  ] }, dir)
  const writes: Buffer[] = [], publications: string[] = []
  const authority = makeSharedAuthority(dir, input, { write(path, bytes) {
    captured.push({ path, bytes: Buffer.from(bytes) })
    durableWriteFileSync(path, bytes); writes.push(Buffer.from(bytes))
  } })
  expect(authority.observeMembership('alpha', authority.incarnation('alpha')!, membershipJoin(C.primary, 'initial-member'), authority.revision).kind).toBe('applied')
  const request = deliveryAttempt('retained-applied', C.primary, 'all')
  if (retainAttempt) {
    expect(authority.botAttempt('alpha', authority.incarnation('alpha')!, request,
      () => ({ kind: 'authorized', facts: { saved: 'all', effective: 'all' } })).kind).toBe('applied')
  }
  expect(createReviewObserver()(authority, hash('active'), true, 0, hash('source')).result?.kind).toBe('applied')
  authority.subscribe(config => { captured.push({ config }); publications.push('config') })
  authority.subscribeChange(() => { captured.push({ publication: 'change' }); publications.push('change') })
  authority.subscribeThreadView(thread => { captured.push({ thread }); publications.push('thread') })
  writes.length = 0; publications.length = 0
  expect(fullRead(authority.snapshot(), authority.path)).toEqual(authority.snapshot())
  return { authority, writes, publications, request, input }
}
type Rig = ReturnType<typeof rig>
function commit(r: Rig, scope: Scope, change: Change) {
  const a = r.authority
  return captureResult(() => scope === 'membership' ? a.transactMembership('alpha', a.revision, change)
    : scope === 'review' ? a.transactReview(a.revision, change) : a.transactConfiguration(a.revision, (next, order) => {
      // This public callback owns constructing its changed configuration.
      // Committed branches are immutable; detach only non-attempt data, as a
      // reviewed application does, and keep the protected attempt map identity.
      const attempts = next.outcomes.botAttempts
      const draft: SharedChannelState = structuredClone({ ...next, outcomes: { ...next.outcomes, botAttempts: undefined } })
      if (attempts !== undefined) draft.outcomes.botAttempts = attempts
      Object.assign(next, draft)
      change(next, order)
    }))
}
function assertWritten(r: Rig) {
  expect(r.writes).toHaveLength(1)
  const bytes = readFileSync(r.authority.path), parsed = parseSharedChannelState(bytes, r.authority.path)
  expect(bytes.equals(r.writes[0]!)).toBe(true)
  expect(parsed).toEqual(r.authority.snapshot())
  expect(Buffer.from(JSON.stringify(parsed, null, 2) + '\n')).toEqual(bytes)
}
const valid: Record<Scope, Change> = {
  review: state => { state.pendingIntent['operator'] = emptyOperatorIntent() },
  membership: (state, order) => applySharedMembership(state, order, 'alpha', life(state).incarnation, membershipJoin(C.secondary, 'valid-member')),
  configuration: (state, order) => {
    life(state).assignments[C.primary] = { delivery: 'mentions', order }
    rawAlpha(state)['channels'] = [{ id: C.primary, delivery: 'mentions' }]
  },
}
function assertRejected(r: Rig, scope: Scope, change: Change) {
  const before = r.authority.snapshot(), bytes = readFileSync(r.authority.path)
  const candidate = structuredClone(before); candidate.revision++
  change(candidate, candidate.revision)
  expect(() => fullRead(candidate, r.authority.path)).toThrow()
  expect(commit(r, scope, change)).toEqual({ kind: 'failed', revision: before.revision })
  expect(r.writes).toEqual([])
  expect(r.publications).toEqual([])
  expect(r.authority.revision).toBe(before.revision)
  expect(r.authority.snapshot()).toEqual(before)
  expect(readFileSync(r.authority.path)).toEqual(bytes)
  expect(commit(r, scope, valid[scope]).kind).toBe('applied')
  assertWritten(r)
}
interface Family { name: string; scopes: Scope[]; change: Change }
const families: Family[] = [
  { name: 'invalid revision', scopes: ['review', 'membership', 'configuration'], change: state => { state.revision = 0 } },
  { name: 'outside-scope source mutation / reviewed-input disagreement', scopes: ['review', 'membership', 'configuration'], change: state => { state.source = {} } },
  { name: 'invalid intent generation', scopes: ['review', 'configuration'], change: state => { state.pendingIntent['operator'] = { ...emptyOperatorIntent(), generation: -1 } } },
  { name: 'review fingerprint mismatch', scopes: ['review', 'configuration'], change: state => { reviewLedger(state)!.active!.fingerprint = hash('foreign') } },
  { name: 'review outcome at reserved bot start', scopes: ['review', 'configuration'], change: state => {
    reviewLedger(state)!.outcomes[hash('reserved-outcome')] = { status: 'rejected', generation: 1, revision: application(state).startedOrder }
  } },
  { name: 'malformed recovery metadata', scopes: ['review', 'configuration'], change: state => { state.recovery = { phase: 'active' } as never } },
  { name: 'bot-map ownership and binding/hash mismatch', scopes: ['review', 'membership', 'configuration'], change: state => {
    state.outcomes = { ...state.outcomes, botAttempts: { wrongHash: { ...application(state) } } }
  } },
  { name: 'malformed assignment value', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).assignments[C.primary] = { delivery: 'invalid' as never, order }
  } },
  { name: 'hybrid assignment without its since stamp', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).assignments[C.primary] = { delivery: 'thread_hybrid', order }
    rawAlpha(state)['channels'] = [{ id: C.primary, delivery: 'thread_hybrid' }]
  } },
  { name: 'applied-choice disagreement', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).assignments[C.primary] = { delivery: 'mentions', order }
  } },
  { name: 'historical applied outcome disagrees at equal assignment order', scopes: ['membership', 'configuration'], change: state => {
    life(state).assignments[C.primary] = { delivery: 'mentions', order: application(state).resolvedOrder }
    rawAlpha(state)['channels'] = [{ id: C.primary, delivery: 'mentions' }]
  } },
  { name: 'missing membership with retained history', scopes: ['membership', 'configuration'], change: state => { life(state).membership = {} } },
  { name: 'membership event at reserved bot start', scopes: ['membership', 'configuration'], change: state => {
    const position = application(state).startedOrder
    const [id, event] = Object.entries(life(state).membershipEvents)[0]!
    life(state).membershipEvents[id] = { ...event, order: position, boundary: position }
    life(state).membership[C.primary] = { ...life(state).membership[C.primary]!, boundary: position }
  } },
  { name: 'missing leave proof event', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).leaves[C.primary] = { event: 'missing-event', incarnation: life(state).incarnation, boundary: order }
  } },
  { name: 'readiness identity-key mismatch', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).installationReadiness = { wrongKey: setup(order) }
  } },
  { name: 'readiness invalid evidence value', scopes: ['membership', 'configuration'], change: (state, order) => {
    life(state).installationReadiness = { [slackInstallationKey(installation)]: { ...setup(order), reinstall: 'invalid' as never } }
  } },
  { name: 'readiness at reserved bot resolution', scopes: ['membership', 'configuration'], change: state => {
    life(state).installationReadiness = { [slackInstallationKey(installation)]: setup(application(state).resolvedOrder) }
  } },
  { name: 'invalid source bytes', scopes: ['configuration'], change: state => { state.sourceBytesBase64 = 'invalid-base64' } },
  { name: 'applied schema invalid', scopes: ['configuration'], change: state => { state.applied['port'] = 'invalid' } },
  { name: 'source/applied non-channel disagreement', scopes: ['configuration'], change: state => { state.applied['port'] = 18888 } },
  { name: 'persona declaration mismatch', scopes: ['configuration'], change: state => { life(state).declaration.name = 'different' } },
  { name: 'duplicate incarnation', scopes: ['configuration'], change: state => { state.personas['beta']!.incarnation = life(state).incarnation } },
  { name: 'reset passes retained attempt start', scopes: ['configuration'], change: state => { life(state).resetOrder = application(state).startedOrder } },
  { name: 'retirement does not follow the latest retained resolution', scopes: ['configuration'], change: (state, order) => {
    const previous = life(state), old = previous.incarnation
    state.retiredIdentities[old] = { key: 'alpha', incarnation: old, declaration: { ...previous.declaration }, channels: [], order: application(state).resolvedOrder }
    state.personas['alpha'] = { ...previous, incarnation: 'replacement-life', resetOrder: order,
      assignments: { [C.primary]: { delivery: 'all', order } }, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {} }
  } },
  { name: 'invalid marker map', scopes: ['configuration'], change: state => { state.threadMemoryCreated = { alpha: false as never } } },
]
describe('scoped writes reject the same invalid states as the full reader', () => {
  for (const family of families) for (const scope of family.scopes) {
    test(`${scope}: ${family.name}; valid counterpart round-trips exact bytes`, () => assertRejected(rig(), scope, family.change))
  }
  for (const scope of ['membership', 'configuration'] as const) {
    test(`${scope}: valid installation readiness round-trips`, () => {
      const r = rig()
      expect(commit(r, scope, (state, order) => { life(state).installationReadiness = { [slackInstallationKey(installation)]: setup(order) } }).kind).toBe('applied')
      assertWritten(r)
    })
    test(`${scope}: readiness may share a non-bot membership position under the existing full reader`, () => {
      const r = rig(), candidate = r.authority.snapshot(); candidate.revision++
      const change: Change = state => { life(state).installationReadiness = { [slackInstallationKey(installation)]: setup(Object.values(life(state).membershipEvents)[0]!.order) } }
      change(candidate, candidate.revision)
      expect(fullRead(candidate, r.authority.path)).toEqual(candidate)
      expect(commit(r, scope, change).kind).toBe('applied')
      assertWritten(r)
    })
  }
})

type HookTarget = 'root' | 'outcomes'
function installEncodingHook<T extends object>(target: T, encode: (this: T) => unknown, enumerable: boolean, getter: boolean) {
  Object.defineProperty(target, 'toJSON', { enumerable, ...(getter ? { get() { return encode } } : { value: encode }) })
}
function attemptHook(target: HookTarget, remove: boolean, enumerable = true, getter = false): Change {
  const encode = (outcomes: SharedChannelState['outcomes']) => {
    const { botAttempts: _attempts, ...other } = outcomes
    return remove ? other : { ...other, botAttempts: { bad: {} } }
  }
  return next => {
    if (target === 'root') {
      installEncodingHook(next, function(this: SharedChannelState) {
        return { ...this, outcomes: encode(this.outcomes) }
      }, enumerable, getter)
    } else {
      // Membership scope shares the committed outcomes object. Replace it
      // explicitly so this tests scope admission, not a frozen-object throw.
      next.outcomes = { ...next.outcomes }
      installEncodingHook(next.outcomes, function(this: SharedChannelState['outcomes']) {
        return encode(this)
      }, enumerable, getter)
    }
  }
}
function assertUnchanged(r: Rig, before: SharedChannelState, bytes: Buffer<ArrayBuffer>) {
  expect(r.writes).toEqual([])
  expect(r.publications).toEqual([])
  expect(r.authority.revision).toBe(before.revision)
  expect(r.authority.snapshot()).toEqual(before)
  expect(readFileSync(r.authority.path)).toEqual(bytes)
}
function assertNativeRejected(r: Rig, scope: Scope, change: Change, message: string) {
  const before = r.authority.snapshot(), bytes = readFileSync(r.authority.path)
  const candidate = structuredClone(before); candidate.revision++
  change(candidate, candidate.revision)
  expect(() => fullRead(candidate, r.authority.path)).toThrow(message)
  expect(captureResult(() => r.authority.transact(r.authority.revision, change)))
    .toEqual({ kind: 'failed', revision: before.revision })
  assertUnchanged(r, before, bytes)
  expect(commit(r, scope, change)).toEqual({ kind: 'failed', revision: before.revision })
  assertUnchanged(r, before, bytes)
  expect(commit(r, scope, valid[scope]).kind).toBe('applied')
  assertWritten(r)
}
describe('R1: native hooks cannot substitute unvalidated attempt history', () => {
  for (const scope of ['configuration', 'review', 'membership'] as const) {
    for (const target of ['outcomes', 'root'] as const) {
      for (const retained of [false, true]) {
        test(`${scope}: ${target} hook ${retained ? 'replaces' : 'introduces'} attempts; native reader and ordinary transaction reject`, () => {
          const r = rig(retained)
          expect(Object.hasOwn(r.authority.snapshot().outcomes, 'botAttempts')).toBe(retained)
          assertNativeRejected(r, scope, attemptHook(target, false), 'Invalid durable bot attempt binding.')
        })
      }
      test(`${scope}: ${target} hook cannot remove retained attempts from a scoped commit`, () => {
        const r = rig(), before = r.authority.snapshot(), bytes = readFileSync(r.authority.path)
        const change = attemptHook(target, true), candidate = structuredClone(before); candidate.revision++
        change(candidate, candidate.revision)
        // A reader has no prior state: omission is globally valid, but a scope
        // may not silently lose the protected retained history it promised.
        const parsed = fullRead(candidate, r.authority.path)!
        expect(Object.hasOwn(parsed.outcomes, 'botAttempts')).toBe(false)
        const result = commit(r, scope, change)
        if (result.kind === 'failed') assertUnchanged(r, before, bytes)
        else {
          expect(result.kind).toBe('applied')
          expect(r.authority.snapshot().outcomes.botAttempts).toEqual(before.outcomes.botAttempts)
          expect(parseSharedChannelState(readFileSync(r.authority.path), r.authority.path)!.outcomes.botAttempts)
            .toEqual(before.outcomes.botAttempts)
          assertWritten(r)
        }
        r.writes.length = 0; r.publications.length = 0
        expect(commit(r, scope, valid[scope]).kind).toBe('applied')
        assertWritten(r)
      })
    }
  }
})

describe('R1 non-enumerable hooks retain native transaction behavior', () => {
  for (const scope of ['configuration', 'review', 'membership'] as const) {
    for (const target of ['root', 'outcomes'] as const) {
      for (const retained of [false, true]) {
        for (const kind of ['method', 'getter'] as const) {
          test(`${scope}: non-enumerable ${target} ${kind} ${retained ? 'replaces' : 'introduces'} malformed attempts`, () => {
            const r = rig(retained), hook = attemptHook(target, false, false, kind === 'getter')
            let calls = 0
            expect(Object.hasOwn(r.authority.snapshot().outcomes, 'botAttempts')).toBe(retained)
            assertNativeRejected(r, scope, (next, order) => { calls++; hook(next, order) }, 'Invalid durable bot attempt binding.')
            // Candidate construction, ordinary transaction, then scoped
            // transaction: a fallback must not execute the callback again.
            expect(calls).toBe(3)
          })
        }
      }
    }
  }
  for (const target of ['root', 'outcomes'] as const) {
    for (const retained of [false, true]) {
      for (const kind of ['method', 'getter'] as const) {
        test(`configuration: valid non-enumerable ${target} ${kind} preserves native output (${retained ? 'retained' : 'absent'} attempts)`, () => {
          const results: unknown[] = []
          for (const ordinary of [true, false]) {
            const r = rig(retained), a = r.authority, before = a.snapshot()
            let calls = 0, encodes = 0
            const change: Change = next => {
              calls++
              if (target === 'root') {
                installEncodingHook(next, function(this: SharedChannelState) {
                  encodes++
                  return { ...this, threadMemoryCreated: { ...this.threadMemoryCreated, alpha: true } }
                }, false, kind === 'getter')
              } else {
                next.outcomes = { ...next.outcomes }
                installEncodingHook(next.outcomes, function(this: SharedChannelState['outcomes']) {
                  encodes++
                  return { ...this, nativeHookProof: { preserved: true } }
                }, false, kind === 'getter')
              }
            }
            const result = captureResult(() => ordinary ? a.transact(a.revision, change) : commit(r, 'configuration', change))
            results.push(result)
            expect(result).toEqual({ kind: 'applied', revision: before.revision + 1 })
            expect(calls).toBe(1)
            assertWritten(r)
            const parsed = parseSharedChannelState(readFileSync(a.path), a.path)!
            const reopened = createSharedChannelAuthority(a.path, parsed)
            if (target === 'root') {
              expect(a.threadMemoryCreated('alpha')).toBe(true)
              expect(parsed.threadMemoryCreated?.['alpha']).toBe(true)
              expect(reopened.threadMemoryCreated('alpha')).toBe(true)
            } else {
              expect(a.snapshot().outcomes['nativeHookProof']).toEqual({ preserved: true })
              expect(parsed.outcomes['nativeHookProof']).toEqual({ preserved: true })
              expect(reopened.snapshot().outcomes['nativeHookProof']).toEqual({ preserved: true })
            }
            expect(a.snapshot().outcomes.botAttempts).toEqual(before.outcomes.botAttempts)
            expect(reopened.snapshot().outcomes.botAttempts).toEqual(before.outcomes.botAttempts)
            expect(encodes).toBeGreaterThan(0)
          }
          expect(results[1]).toEqual(results[0])
        })
      }
    }
  }
})

describe('R2: review scope validates introduced recovery and permits cancellation', () => {
  test('review introduction of a restoration stage rejects its bad anchor like the full reader', () => {
    const r = rig(false), evidence = Buffer.from('damaged')
    expect(r.authority.recoverySnapshot()).toBeUndefined()
    const change: Change = next => {
      next.recovery = { boundary: 'review-proof', phase: 'review',
        request: sharedRecoveryRequest('review-proof', evidence),
        evidenceBase64: evidence.toString('base64'), preparedBase64: configBytes(r.input).toString('base64'),
        anchorBase64: Buffer.from('{}').toString('base64') }
    }
    assertNativeRejected(r, 'review', change, 'Changed trustworthy restoration facts.')
  })
  test('review cancellation of a valid staged replacement still applies and round-trips', () => {
    const r = rig(), a = r.authority, evidence = Buffer.from('damaged'), prepared = configBytes(r.input)
    expect(a.transact(a.revision, next => {
      next.recovery = { boundary: 'cancellation-proof', phase: 'review',
        request: sharedRecoveryRequest('cancellation-proof', evidence, prepared),
        evidenceBase64: evidence.toString('base64'), preparedBase64: prepared.toString('base64') }
    }).kind).toBe('applied')
    r.writes.length = 0; r.publications.length = 0
    const before = a.snapshot(), request = buildReviewRequest('cancel-recovery-proof', 0, 'cancel')
    const cancel: Change = (next, order) => {
      if (next.recovery?.phase !== 'review') throw new Error('Expected staged recovery')
      next.recovery.cancelled = true
      next.pendingIntent['operator'] = { ...emptyOperatorIntent(), generation: 1,
        requests: { [request.request_id]: { request, generation: 1 } } }
      supersedeReview(next, order)
    }
    const candidate = structuredClone(before); candidate.revision++; cancel(candidate, candidate.revision)
    expect(fullRead(candidate, a.path)).toEqual(candidate)
    expect(commit(r, 'review', cancel)).toEqual({ kind: 'applied', revision: before.revision + 1 })
    expect(a.snapshot()).toEqual(candidate)
    expect(a.recoverySnapshot()).toMatchObject({ phase: 'review', cancelled: true })
    assertWritten(r)
  })
})

describe('bot record predicates and public attempt admission', () => {
  const changes: Array<[string, (record: SharedBotAttempt, state: SharedChannelState) => void]> = [
    ['binding/hash mismatch', record => { record.identifierHash = hash('changed') }],
    ['start outside active life', (record, state) => { record.startedOrder = life(state).resetOrder! }],
    ['resolution before start', record => { if (record.status === 'applied') record.resolvedOrder = record.startedOrder }],
    ['invalid facts', record => { if (record.status === 'applied') record.facts.effective = 'mentions' }],
    ['invalid previous delivery', record => { if (record.status === 'applied') record.previous = 'invalid' as never }],
    ['invalid status', record => { Object.assign(record, { status: 'invalid' }) }],
    ['surplus field', record => { Object.assign(record, { extra: true }) }],
  ]
  test.each(changes)('shared bot-record predicate and full reader reject %s', (_, change) => {
    const r = rig(), state = r.authority.snapshot(), record = application(state), id = botAttemptKey(record)
    const before = readFileSync(r.authority.path), revision = r.authority.revision
    change(record, state)
    expect(() => validateBotAttemptRecord(state, id, record)).toThrow()
    expect(() => fullRead(state, r.authority.path)).toThrow()
    expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
    expect(r.authority.revision).toBe(revision); expect(readFileSync(r.authority.path)).toEqual(before)
  })
  test('binding conflict and terminal retries do not create another pending write', () => {
    const r = rig(), a = r.authority, before = a.snapshot(), bytes = readFileSync(a.path)
    const authorize = () => { throw new Error('historical access must not authorize again') }
    expect(a.botAttempt('alpha', a.incarnation('alpha')!, { ...r.request, delivery: 'mentions' }, authorize)).toEqual({ kind: 'binding-conflict' })
    expect(a.botAttempt('alpha', a.incarnation('alpha')!, r.request, authorize)).toMatchObject({ kind: 'applied', historical: true })
    expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
    expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
    // A terminal->pending rewrite is a forbidden transition, but its isolated
    // final state is valid JSON authority data. The reader has no previous state.
    const state = structuredClone(before), applied = application(state), id = botAttemptKey(applied)
    state.outcomes.botAttempts![id] = { ...botAttemptBinding('alpha', applied.incarnation, r.request), status: 'pending', startedOrder: applied.startedOrder }
    expect(fullRead(state, a.path)).toEqual(state)
  })
  test('duplicate retained attempt positions are rejected by the full reader and scoped bot-map replacement', () => {
    assertRejected(rig(), 'configuration', state => {
      const prior = application(state), request = deliveryAttempt('duplicate-position', C.primary, 'all')
      const record = { ...prior, ...botAttemptBinding('alpha', prior.incarnation, request) }
      state.outcomes.botAttempts = { ...state.outcomes.botAttempts, [botAttemptKey(record)]: record }
    })
  })
  test('malformed authorized outcome never writes invalid application bytes; pending and durable failure remain', () => {
    const r = rig(), a = r.authority, before = a.revision, request = deliveryAttempt('malformed-facts', C.primary, 'all')
    let pending: SharedChannelState | undefined
    const result = a.botAttempt('alpha', a.incarnation('alpha')!, request, () => {
      pending = a.snapshot()
      return { kind: 'authorized', facts: { saved: 'all', effective: 'mentions' } as ChannelDeliveryFacts }
    })
    expect(result).toEqual({ kind: 'not-applied', reason: 'write-failed' })
    expect(r.writes).toHaveLength(2)
    const id = botAttemptKey(botAttemptBinding('alpha', a.incarnation('alpha')!, request))
    expect(r.writes.map(bytes => parseSharedChannelState(bytes, a.path)!.outcomes.botAttempts![id].status)).toEqual(['pending', 'not-applied'])
    expect(a.revision).toBe(before + 2)
    expect(r.publications).toEqual([])
    const invalid = pending!; invalid.revision++
    const record = invalid.outcomes.botAttempts![id]!
    invalid.outcomes.botAttempts![id] = { ...record, status: 'applied', resolvedOrder: invalid.revision, facts: { saved: 'all', effective: 'mentions' } }
    life(invalid).assignments[C.primary] = { delivery: 'all', order: invalid.revision }
    expect(() => fullRead(invalid, a.path)).toThrow()
    r.writes.length = 0
    expect(a.botAttempt('alpha', a.incarnation('alpha')!, deliveryAttempt('valid-after-failure', C.primary, 'all'),
      () => ({ kind: 'authorized', facts: { saved: 'all', effective: 'all' } })).kind).toBe('applied')
    const validId = botAttemptKey(botAttemptBinding('alpha', a.incarnation('alpha')!, deliveryAttempt('valid-after-failure', C.primary, 'all')))
    expect(r.writes.map(bytes => {
      const state = parseSharedChannelState(bytes, a.path)!
      expect(Buffer.from(JSON.stringify(state, null, 2) + '\n').equals(bytes)).toBe(true)
      return { revision: state.revision, status: state.outcomes.botAttempts![validId]!.status }
    })).toEqual([{ revision: a.revision - 1, status: 'pending' }, { revision: a.revision, status: 'applied' }])
  })
})

describe('exact native encoding and staged-recovery fallbacks', () => {
  test('marker fallback validates exact hook bytes, rejecting invalid encoding before persistence', () => {
    const r = rig(), a = r.authority
    let corrupt = false, calls = 0
    expect(a.transactMembership('alpha', a.revision, next => {
      Object.defineProperty(life(next).membership, 'toJSON', { enumerable: false, configurable: true,
        value(this: Record<string, unknown>) { calls++; return corrupt ? {} : Object.fromEntries(Object.entries(this)) } })
    }).kind).toBe('applied')
    r.writes.length = 0; r.publications.length = 0
    const before = a.snapshot(), bytes = readFileSync(a.path)
    corrupt = true; calls = 0
    expect(a.setThreadMemoryCreated('alpha')).toEqual({ kind: 'failed' })
    expect(calls).toBe(1)
    const invalid = structuredClone(before); invalid.threadMemoryCreated = { alpha: true }; life(invalid).membership = {}
    expect(() => fullRead(invalid, a.path)).toThrow()
    expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
    expect(a.revision).toBe(before.revision); expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
    corrupt = false
    expect(a.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
    expect(a.revision).toBe(before.revision); expect(r.publications).toEqual([])
    assertWritten(r)
  })
  test('marker rejects unknown persona without a write and a valid marker preserves revision', () => {
    const r = rig(), a = r.authority, before = a.snapshot(), bytes = readFileSync(a.path)
    expect(a.setThreadMemoryCreated('unknown')).toEqual({ kind: 'failed' })
    expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
    expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
    // Unknown-marker keys are globally valid historical persona markers. This
    // rejection is an admission rule, not a full-reader state-validity rule.
    expect(fullRead({ ...before, threadMemoryCreated: { unknown: true } }, a.path)).toBeDefined()
    expect(a.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
    expect(a.revision).toBe(before.revision); assertWritten(r)
  })
  for (const scope of ['review', 'configuration', 'membership'] as const) {
    test(`staged recovery: ${scope} uses full validation and rejects malformed stage bytes`, () => {
      const r = rig(), a = r.authority, prepared = configBytes(r.input), damage = Buffer.from('damaged authority')
      const request = sharedRecoveryRequest('differential-replace', damage, prepared)
      expect(a.transact(a.revision, state => {
        state.recovery = { phase: 'review', boundary: 'differential-boundary', request,
          evidenceBase64: damage.toString('base64'), preparedBase64: prepared.toString('base64') }
      }).kind).toBe('applied')
      r.writes.length = 0; r.publications.length = 0
      // Mutation of an otherwise forbidden branch distinguishes the full
      // fallback from ordinary membership/review ownership restrictions.
      const generic = a.transact.bind(a)
      const calls: Array<{ revision: number; selected: 'review' | undefined }> = []
      const spy = spyOn(a, 'transact').mockImplementation((revision, change, span, publish, selected) => {
        calls.push({ revision, selected }); return generic(revision, change, span, publish, selected)
      })
      try {
        const before = a.snapshot(), bytes = readFileSync(a.path)
        const invalid: Change = state => { if (state.recovery?.phase === 'review') state.recovery.preparedBase64 = 'invalid-base64' }
        const candidate = structuredClone(before); candidate.revision++; invalid(candidate, candidate.revision)
        expect(() => fullRead(candidate, a.path)).toThrow()
        expect(commit(r, scope, invalid)).toEqual({ kind: 'failed', revision: before.revision })
        expect(calls).toEqual(scope === 'review'
          ? [{ revision: before.revision, selected: 'review' }, { revision: before.revision, selected: undefined }]
          : [{ revision: before.revision, selected: undefined }])
        expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
        expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
        expect(commit(r, scope, state => { state.pendingIntent['fallback-proof'] = 'full-path' }).kind).toBe('applied')
        assertWritten(r)
      } finally { spy.mockRestore() }
    })
  }
})
