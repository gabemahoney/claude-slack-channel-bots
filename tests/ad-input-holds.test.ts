import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inputBinding, makeInputHoldFixture } from './test-helpers/ad-input-holds.ts'
import { AD_INPUT_HOLD_MAX_BYTES } from '../src/ad-input-holds.ts'
import type { AdInputBinding, AdInputHoldRecord, AdInputHoldResult, AdInputLaunchObservation } from '../src/ad-input-holds.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ad-input-holds-')); roots.push(root)
  return { root, ...await makeInputHoldFixture(root) }
}
function value(result: AdInputHoldResult<AdInputHoldRecord>): AdInputHoldRecord {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result.value
}

describe('durable control-input safety records', () => {
  test('the durable input hold byte bound is pinned', () => {
    expect(AD_INPUT_HOLD_MAX_BYTES).toBe(16_384)
  })

  test('path hashes the UTF8 persona key and construction does no I/O', async () => {
    const f = await fixture(), key = '../alpha/雪'
    f.faults.read = true
    const store = f.fresh()
    expect(store.path(key)).toBe(join(f.root, 'ad-input-holds', `${createHash('sha256').update(key).digest('hex')}.json`))
    expect(f.writes).toEqual([])
  })

  test.each(['text-intent', 'text-ready', 'enter-intent', 'uncertain'] as const)('%s survives a fresh store with no text in the record', async step => {
    const f = await fixture(), binding = inputBinding()
    expect(f.store.load('alpha')).toEqual({ kind: 'clear' })
    let record = value(f.store.begin('alpha', binding))
    if (step !== 'text-intent') record = value(f.store.advance('alpha', record.revision, step, step === 'uncertain' ? 'submission_unconfirmed' : undefined))
    expect(f.fresh().load('alpha')).toEqual({ kind: 'record', record })
    expect(record).toEqual({ v: 1, key: 'alpha', revision: record.revision, binding, step, recordedAt: Date.parse('2026-11-20T02:00:00Z'), outcome: step === 'uncertain' ? 'submission_unconfirmed' : null })
  })

  test('CAS prevents a stale AD response from clearing or downgrading newer uncertainty', async () => {
    const { store } = await fixture()
    store.load('alpha')
    const first = value(store.begin('alpha', inputBinding()))
    const second = value(store.advance('alpha', first.revision, 'uncertain', 'partial_input_unconfirmed'))
    expect(second.revision).toBe(first.revision + 1)
    expect(store.clear('alpha', first.revision)).toEqual({ ok: false, code: 'INPUT_HOLD_STALE' })
    expect(store.advance('alpha', first.revision, 'text-ready')).toEqual({ ok: false, code: 'INPUT_HOLD_STALE' })
    expect(store.begin('alpha', inputBinding())).toEqual({ ok: false, code: 'INPUT_HOLD_STALE' })
    expect(store.get('alpha')).toEqual({ kind: 'record', record: second })
  })

  test.each(['read', 'invalid-json', 'wrong-key', 'revision', 'binding', 'step', 'outcome', 'oversized'] as const)('%s cannot load as a clear hold', async fault => {
    const f = await fixture()
    f.store.load('alpha'); value(f.store.begin('alpha', inputBinding()))
    const path = f.store.path('alpha')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (fault === 'read') f.faults.read = true
    else if (fault === 'invalid-json') writeFileSync(path, '{')
    else if (fault === 'oversized') writeFileSync(path, ' '.repeat(AD_INPUT_HOLD_MAX_BYTES + 1))
    else {
      if (fault === 'wrong-key') raw.key = 'beta'
      if (fault === 'revision') raw.revision = 0
      if (fault === 'binding') raw.binding.instanceId = null
      if (fault === 'step') raw.step = 'safe-to-retype'
      if (fault === 'outcome') raw.outcome = 'unknown_future_outcome'
      writeFileSync(path, JSON.stringify(raw))
    }
    expect(f.fresh().load('alpha')).toEqual({ kind: 'blocked', code: fault === 'read' ? 'INPUT_HOLD_UNREADABLE' : 'INPUT_HOLD_INVALID' })
  })

  test.each(['write', 'unsynced', 'remove'] as const)('%s failure remains blocked in memory even if the disk changes', async fault => {
    const f = await fixture()
    f.store.load('alpha')
    const first = value(f.store.begin('alpha', inputBinding()))
    f.faults[fault] = true
    const failed = fault === 'remove' ? f.store.clear('alpha', first.revision) : f.store.advance('alpha', first.revision, 'uncertain', 'submission_unconfirmed')
    expect(failed).toEqual({ ok: false, code: fault === 'remove' ? 'INPUT_HOLD_CLEAR_FAILED' : 'INPUT_HOLD_WRITE_FAILED' })
    rmSync(f.store.path('alpha'), { force: true })
    expect(f.store.get('alpha').kind).not.toBe('clear')
  })

  test.each(['waiting', 'working', 'ended', 'missing'] as const)('%s with a rotated session releases only a live new launch', async state => {
    const f = await fixture(), binding = inputBinding()
    f.store.load('alpha'); value(f.store.begin('alpha', binding))
    const live = state === 'waiting' || state === 'working'
    expect(f.store.observeLaunch('alpha', { ...binding, state, sessionId: 'rotated-session' })).toEqual({ ok: true, value: live ? 'cleared' : 'kept' })
    expect(f.fresh().load('alpha').kind).toBe(live ? 'clear' : 'record')
  })

  test.each(['ended', 'missing'] as const)('%s observation survives CSCB restart and releases a same-session resumed launch', async state => {
    const f = await fixture(), binding = inputBinding()
    f.store.load('alpha')
    const first = value(f.store.begin('alpha', binding))
    value(f.store.advance('alpha', first.revision, 'uncertain', 'submission_unconfirmed'))
    expect(f.store.observeLaunch('alpha', { ...binding, state })).toEqual({ ok: true, value: 'kept' })
    const restarted = f.fresh()
    expect(restarted.load('alpha')).toMatchObject({ kind: 'record', record: { step: 'uncertain' } })
    expect(restarted.observeLaunch('alpha', { ...binding, state: 'waiting' })).toEqual({ ok: true, value: 'cleared' })
    expect(f.fresh().load('alpha')).toEqual({ kind: 'clear' })
  })

  test.each(['row-replaced', 'pending-launch'] as const)('%s clears only the bound persona durably', async evidence => {
    const f = await fixture(), binding = inputBinding()
    for (const key of ['alpha', 'beta']) { f.store.load(key); value(f.store.begin(key, inputBinding({ instanceId: `cscb_${key}` }))) }
    const observation = { ...binding, state: evidence === 'pending-launch' ? 'pending' : 'waiting',
      ...(evidence === 'row-replaced' ? { rowStartedAt: '2026-11-20T03:00:00Z' } : { launchStartedAt: '2026-11-20T03:00:00Z' }) }
    expect(f.store.observeLaunch('beta', observation)).toEqual({ ok: true, value: 'kept' })
    expect(f.store.observeLaunch('alpha', observation)).toEqual({ ok: true, value: 'cleared' })
    expect(f.fresh().load('alpha')).toEqual({ kind: 'clear' })
    expect(f.fresh().load('beta').kind).toBe('record')
  })

  test.each(['2026-11-20T01:00:00Z', '2026-11-20T03:00:00Z'] as const)('unknown previous launch stamp requires pending evidence after the attempted-input boundary (%s)', async stamp => {
    const f = await fixture(), binding = inputBinding({ launchStartedAt: null })
    f.store.load('alpha'); value(f.store.begin('alpha', binding))
    expect(f.store.observeLaunch('alpha', { ...binding, state: 'pending', launchStartedAt: stamp })).toEqual({ ok: true, value: stamp > '2026-11-20T02:00:00Z' ? 'cleared' : 'kept' })
  })

  test('reviewed operator deletion is seen only by an explicit reload after stopping', async () => {
    const f = await fixture()
    f.store.load('alpha'); value(f.store.begin('alpha', inputBinding()))
    rmSync(f.store.path('alpha'))
    expect(f.store.get('alpha').kind).toBe('record')
    expect(f.fresh().load('alpha')).toEqual({ kind: 'clear' })
    expect(existsSync(f.store.path('alpha'))).toBe(false)
  })
})

describe('R1 strict launch evidence for durable uncertain input', () => {
  test.each(['rowStartedAt', 'launchStartedAt'] as const)('impossible persisted binding.%s loads blocked', async field => {
    const f = await fixture()
    f.store.load('alpha')
    const first = value(f.store.begin('alpha', inputBinding()))
    const uncertain = value(f.store.advance('alpha', first.revision, 'uncertain', 'submission_unconfirmed'))
    const bytes = JSON.stringify({ ...uncertain, binding: { ...uncertain.binding, [field]: '2026-11-31T03:00:00Z' } })
    const path = f.store.path('alpha')
    writeFileSync(path, bytes)
    const reopened = f.fresh()
    expect(reopened.load('alpha')).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_INVALID' })
    expect(reopened.get('alpha')).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_INVALID' })
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })

  const cases: { name: string; binding?: Partial<AdInputBinding>; observation: Partial<AdInputLaunchObservation>; expected: 'kept' | 'cleared' }[] = [
    { name: 'impossible pending launch after the attempted-input boundary keeps a null-prior hold', binding: { launchStartedAt: null }, observation: { launchStartedAt: '2026-11-31T03:00:00Z' }, expected: 'kept' },
    { name: 'impossible observed row start is not replacement evidence', observation: { rowStartedAt: '2026-11-31T03:00:00Z', state: 'waiting' }, expected: 'kept' },
    { name: 'valid replacement row with an impossible launch stamp fails closed', observation: { rowStartedAt: '2026-11-20T03:00:00Z', launchStartedAt: '2026-11-31T03:00:00Z', state: 'waiting' }, expected: 'kept' },
    { name: 'valid pending launch after the attempted-input boundary clears a null-prior hold', binding: { launchStartedAt: null }, observation: { launchStartedAt: '2026-11-20T03:00:00Z' }, expected: 'cleared' },
    { name: 'valid pending new launch clears a known-prior hold', observation: { launchStartedAt: '2026-11-20T03:00:00Z' }, expected: 'cleared' },
    { name: 'valid replacement row clears a hold', observation: { rowStartedAt: '2026-11-20T03:00:00Z', state: 'waiting' }, expected: 'cleared' },
    { name: 'same launch instant keeps a hold', observation: {}, expected: 'kept' },
    { name: 'ordinary waiting with a different launch stamp keeps a hold', observation: { launchStartedAt: '2026-11-20T03:00:00Z', state: 'waiting' }, expected: 'kept' },
    { name: 'pending launch at the attempted-input boundary keeps a null-prior hold', binding: { launchStartedAt: null }, observation: { launchStartedAt: '2026-11-20T02:00:00Z' }, expected: 'kept' },
    { name: 'offset spelling of the same launch instant keeps a hold', observation: { launchStartedAt: '2026-11-20T02:00:00+01:00' }, expected: 'kept' },
    { name: 'fractional spelling of the same launch instant keeps a hold', observation: { launchStartedAt: '2026-11-20T01:00:00.000Z' }, expected: 'kept' },
    { name: 'offset spelling of the same row instant is not replacement evidence', observation: { rowStartedAt: '2026-11-20T01:00:00+01:00', state: 'waiting' }, expected: 'kept' },
  ]
  test.each(cases)('$name', async ({ binding: overrides, observation, expected }) => {
    const f = await fixture(), binding = inputBinding(overrides)
    f.store.load('alpha')
    const first = value(f.store.begin('alpha', binding))
    const uncertain = value(f.store.advance('alpha', first.revision, 'uncertain', 'submission_unconfirmed'))
    expect(uncertain.recordedAt).toBe(Date.parse('2026-11-20T02:00:00Z'))
    const before = f.store.get('alpha'), path = f.store.path('alpha'), bytes = readFileSync(path)
    expect(f.fresh().load('alpha')).toEqual({ kind: 'record', record: uncertain })
    expect(f.store.observeLaunch('alpha', { ...binding, state: 'pending', ...observation })).toEqual({ ok: true, value: expected })
    if (expected === 'kept') {
      expect(f.store.get('alpha')).toBe(before)
      expect(f.store.get('alpha')).toEqual({ kind: 'record', record: uncertain })
      expect(readFileSync(path)).toEqual(bytes)
      expect(f.fresh().load('alpha')).toEqual({ kind: 'record', record: uncertain })
    } else {
      expect(f.store.get('alpha')).toEqual({ kind: 'clear' })
      expect(existsSync(path)).toBe(false)
      expect(f.fresh().load('alpha')).toEqual({ kind: 'clear' })
    }
  })
})
