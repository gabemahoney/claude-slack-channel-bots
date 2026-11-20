import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createAdInputHoldIo, createAdInputHoldStore, type AdInputHoldRecord, type AdInputHoldResult } from '../src/ad-input-holds.ts'
import { buildAdInputHoldNotice } from '../src/ad-input-notices.ts'
import { createDeliveryLifecycle, ENTER_DELAY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS } from '../src/delivery-engine.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'
import * as session from '../src/session-manager.ts'
import { cannedStatusResult, errSubmissionUnconfirmed } from './test-helpers/agent-director-stub.ts'
import { makeRecoveryHarness, personaOf, personaRow } from './test-helpers/recovery-harness.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const uncertain = { outcome: 'submission_unconfirmed', keys_sent: true, submission_confirmed: false, enter_may_have_been_sent: true }
const command = `/mcp reconnect ${MCP_SERVER_NAME}`
const oldStamp = '2026-11-19T00:00:00Z', newStamp = '2026-11-21T00:00:00Z'
function saved(result: AdInputHoldResult<AdInputHoldRecord>): AdInputHoldRecord {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result.value
}
function reconnectFixture() {
  const h = makeRecoveryHarness({ harnessNow: true }), key = h.keys[0]!, sibling = h.keys[1]!
  const life = createDeliveryLifecycle({ clock: h.clock })
  session.setDeliveryLifecycle(life)
  const rows = new Map(h.keys.map(k => {
    const row = personaRow(h, k, { state: 'waiting', relay_mode: 'on' })
    row.labels = { ...row.labels, tag_prompt: '1' }
    return [k, row]
  }))
  const row = rows.get(key)!, faults = { remove: false }
  const realIo = createAdInputHoldIo()
  const io = { ...realIo, remove(path: string) { if (faults.remove) throw new Error('injected clear failure'); realIo.remove(path) } }
  const fresh = () => createAdInputHoldStore({ stateDir: h.stateDir, now: h.clock.now, io })
  let holds = fresh()
  for (const k of h.keys) holds.load(k)
  const services = (overrides: Partial<session.SubmissionInputServices> = {}) => session.setSubmissionInputServices({ holds,
    notify(k, text) { h.episodes.begin(k, 'ad-input-unconfirmed'); h.episodes.post(k, 'ad-input-unconfirmed', text) },
    log: line => h.lines.push(line), ...overrides,
  })
  services()
  h.script({ getFn: params => [...rows.values()].find(r => r.instance_id === params.instance_id)!, sendKeysFn: () => ({}) })
  cleanups.push(async () => {
    session.setSubmissionInputServices(undefined)
    await life.stop(); session.setDeliveryLifecycle(undefined)
    try { assertNoLeak(h.captured()) } finally { h.cleanup() }
  })
  return { h, key, sibling, row, life, faults, fresh, services,
    get holds() { return holds },
    reload(load = true) { holds = fresh(); if (load) for (const k of h.keys) holds.load(k); services() },
    seed(step: 'text-ready' | 'uncertain', k = key, stamp: string | null = oldStamp) {
      const r = rows.get(k)!
      const initial = saved(holds.begin(k, { instanceId: r.instance_id, rowStartedAt: r.started_at, sessionId: r.session_id, launchStartedAt: stamp }))
      return saved(holds.advance(k, initial.revision, step, step === 'uncertain' ? 'submission_unconfirmed' : undefined))
    },
    async run() {
      const work = session.reconnectMcpWithCause(key, latchRowStateRead('waiting'))
      await h.clock.flush(); await h.clock.advance(ENTER_DELAY_MS)
      return work
    },
  }
}

test('a suspended successful text reply cannot downgrade or clear newer uncertainty', async () => {
  const f = reconnectFixture(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>()
  f.h.script({ sendKeysFn: async params => { if (params.no_enter) { entered.resolve(); await reply.promise }; return {} } })
  const work = session.reconnectMcpWithCause(f.key, latchRowStateRead('waiting'))
  try {
    await entered.promise
    const intent = f.holds.get(f.key)
    expect(intent.kind).toBe('record')
    if (intent.kind !== 'record') throw new Error('expected durable text intent')
    expect(intent.record.step).toBe('text-intent')
    const newer = saved(f.holds.advance(f.key, intent.record.revision, 'uncertain', 'submission_unconfirmed'))
    reply.resolve(); await f.h.clock.flush(); await f.h.clock.advance(ENTER_DELAY_MS)
    expect((await work).outcome).toBe('input-unconfirmed')
    expect(f.h.stub.calls.sendKeysCalls).toEqual([{ instance_id: f.row.instance_id, text: command, no_enter: true }])
    expect(f.holds.get(f.key)).toEqual({ kind: 'record', record: newer })
    expect(f.fresh().load(f.key)).toEqual({ kind: 'record', record: newer })
    expect(f.life.inputHeld(f.key)).toBe(true)
  } finally { reply.resolve(); await work }
})

test('a persisted text-ready draft resumes with only Enter when waiting omits the pending stamp', async () => {
  const f = reconnectFixture()
  f.seed('text-ready')
  f.reload()
  f.row.launch_started_at = null
  expect((await f.run()).outcome).toBe('ok')
  expect(f.h.stub.calls.sendKeysCalls).toEqual([{ instance_id: f.row.instance_id, key: 'Enter' }])
  expect(f.holds.get(f.key)).toEqual({ kind: 'clear' })
  expect(f.fresh().load(f.key)).toEqual({ kind: 'clear' })
  expect(f.life.reconnectInput(f.key)).toBeUndefined()
})

test('state-only status stays held; a shared full row releases only the queried persona', async () => {
  const f = reconnectFixture()
  f.seed('uncertain'); const sibling = f.seed('uncertain', f.sibling)
  f.life.holdInput(f.key); f.life.holdInput(f.sibling)
  session.applyOwnRowStatusStep(f.key, { result: cannedStatusResult({ state: 'waiting', launch_started_at: newStamp }) }, { site: 'test', what: 'status' })
  expect(f.holds.get(f.key).kind).toBe('record')
  session.applyOwnRowStatusStep(f.sibling, { result: cannedStatusResult({ state: 'pending', launch_started_at: oldStamp }) }, { site: 'test', what: 'status' })
  expect(f.holds.get(f.sibling)).toEqual({ kind: 'record', record: sibling })
  session.applyOwnRowStatusStep(f.key, { result: cannedStatusResult({ state: 'pending', launch_started_at: newStamp }) }, { site: 'test', what: 'status' })
  expect(f.holds.get(f.key).kind).toBe('record')
  expect(existsSync(`${f.holds.path(f.key)}.released`)).toBe(false)
  f.row.state = 'pending'; f.row.launch_started_at = newStamp
  await session.readPersonaOwnRow(f.key, { site: 'test', what: 'get' })
  expect(f.holds.get(f.key)).toEqual({ kind: 'clear' })
  expect(f.fresh().load(f.key)).toEqual({ kind: 'clear' })
  expect(f.holds.get(f.sibling)).toEqual({ kind: 'record', record: sibling })
  expect(f.life.inputHeld(f.key)).toBe(false)
  expect(f.life.inputHeld(f.sibling)).toBe(true)
  expect(f.h.stub.callCount()).toBe(1)
  expect(f.h.stub.calls.getCalls).toEqual([{ instance_id: f.row.instance_id }])
})

test('prepare loads a new persona hold before any AD read, hold inspection or input', async () => {
  const f = reconnectFixture(), order: string[] = []
  f.seed('text-ready', f.key, null)
  f.reload(false)
  const get = f.holds.get
  f.holds.get = k => { order.push('inspect'); return get(k) }
  f.services({ prepare(k) { order.push('prepare'); expect(k).toBe(f.key); expect(f.holds.load(k).kind).toBe('record'); order.push('loaded') } })
  f.h.script({ getFn: () => { order.push('AD get'); expect(get(f.key).kind).toBe('record'); return f.row },
    sendKeysFn: () => { order.push('Enter'); return {} },
  })
  expect((await f.run()).outcome).toBe('ok')
  expect(order.slice(0, 4)).toEqual(['prepare', 'loaded', 'inspect', 'AD get'])
  expect(order.filter(event => event === 'prepare')).toHaveLength(1)
  expect(order.indexOf('inspect')).toBeGreaterThan(order.indexOf('loaded'))
  expect(order.at(-1)).toBe('Enter')
  expect(f.h.stub.calls.sendKeysCalls).toEqual([{ instance_id: f.row.instance_id, key: 'Enter' }])
  expect(f.fresh().load(f.key)).toEqual({ kind: 'clear' })
})

test.each(['saved clear', 'failed clear'] as const)('released ends the notice episode only after durable and lifecycle release (%s)', async outcome => {
  const f = reconnectFixture(), order: string[] = []
  f.seed('uncertain'); f.life.holdInput(f.key)
  f.life.rememberReconnectInput(f.key, { session: f.row.session_id })
  f.h.episodes.begin(f.key, 'ad-input-unconfirmed')
  f.h.episodes.post(f.key, 'ad-input-unconfirmed', buildAdInputHoldNotice(personaOf(f.h, f.key), f.holds.path(f.key)))
  f.faults.remove = outcome === 'failed clear'
  f.services({ released(k) {
    order.push('released')
    expect(k).toBe(f.key)
    expect(existsSync(f.holds.path(k))).toBe(false)
    expect(f.holds.get(k)).toEqual({ kind: 'clear' })
    expect(f.life.inputHeld(k)).toBe(false)
    expect(f.life.reconnectInput(k)).toBeUndefined()
    expect(f.h.episodes.isOpen(k, 'ad-input-unconfirmed')).toBe(true)
    f.h.episodes.end(k, 'ad-input-unconfirmed')
  }, log() { order.push('log') } })
  f.row.state = 'pending'; f.row.launch_started_at = newStamp
  await session.readPersonaOwnRow(f.key, { site: 'test', what: 'get' })
  expect(order).toEqual(outcome === 'saved clear' ? ['released', 'log'] : [])
  expect(f.h.episodes.isOpen(f.key, 'ad-input-unconfirmed')).toBe(outcome === 'failed clear')
  expect(f.life.inputHeld(f.key)).toBe(outcome === 'failed clear')
  if (outcome === 'failed clear') expect(f.holds.get(f.key)).toEqual({ kind: 'blocked', code: 'INPUT_HOLD_CLEAR_FAILED' })
  expect(f.h.stub.callCount()).toBe(1)
  expect(f.h.stub.calls.getCalls).toEqual([{ instance_id: f.row.instance_id }])
})

test.each(['same engine', 'restarted engine'] as const)('new covered capability cannot replay a legacy uncertain submission (%s)', async mode => {
  const coveredBlocks: unknown[] = []
  const h = await makeEngineHarness({ onCoveredBlocked: (...args) => { coveredBlocks.push(args) } }); cleanups.push(() => h.cleanup())
  await h.accept('legacy retained')
  h.p().autoReceipt = false
  let refused = false
  h.p().keyHook = params => { if (!refused && params.no_enter) { refused = true; return errSubmissionUnconfirmed(uncertain) }; return undefined }
  await h.tick()
  const keys = [...h.keyCalls()], errors = [...h.errors]
  expect(keys).toHaveLength(1)
  expect(h.records().filter(r => r.kind === 'submission-blocked')).toHaveLength(1)
  h.p().row.busy_send = 'covered'
  if (mode === 'restarted engine') await h.restartServer()
  for (const state of ['working', 'waiting'] as const) { h.p().row.state = state; await h.advance(RECEIPT_WAIT_MS + RETYPE_BACKOFF_MS[0]) }
  expect(h.keyCalls()).toEqual(keys)
  expect(h.records().filter(r => r.kind === 'submitted' || r.kind === 'delivered')).toEqual([])
  expect(h.queue.openCount('alpha')).toBe(1)
  expect(h.restarts).toEqual([])
  expect(h.errors).toEqual(errors)
  expect(coveredBlocks).toEqual([])
  assertNoLeak([h.events, h.errors, h.records(), coveredBlocks])
})
