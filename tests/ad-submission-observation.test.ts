/** Causal shared/engine AD reads, real queue journals and durable input holds. */
import { afterEach, expect, test } from 'bun:test'
import type { QueueRecord, SubmissionBlockedRecord } from '../src/delivery-queue.ts'
import { join } from 'node:path'
import type { GetResult, StatusResult } from 'agent-director'
import { existsSync } from 'node:fs'
import * as session from '../src/session-manager.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { createDeliveryLifecycle, DELIVERY_ROW_POLL_MS } from '../src/delivery-engine.ts'
import { AD_INPUT_UNCONFIRMED, AD_INPUT_LAUNCH_FINISHED, AD_INPUT_NEW_LAUNCH } from '../src/ad-input-custody.ts'
import { cannedStatusResult, cannedBusyResult, cannedDeliveryLookup, makeStubClient, makeStubCallLog, stubCallCount } from './test-helpers/agent-director-stub.ts'
import { makeRecoveryHarness, personaRow } from './test-helpers/recovery-harness.ts'
import { makeInputHoldFixture } from './test-helpers/ad-input-holds.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { makeBusyHarness } from './test-helpers/busy-send.ts'
import { deliveredRecord, makeQueue, sentRecord } from './test-helpers/delivery-queue.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const at = { site: 'causal regression', what: 'AD read' }
const stamp = '2026-11-19T00:00:00Z'
const binding = (row: GetResult) => ({ instanceId: row.instance_id, rowStartedAt: row.started_at, sessionId: row.session_id, launchStartedAt: row.launch_started_at ?? null })
const markers = (records: readonly QueueRecord[]) => records.filter((r): r is SubmissionBlockedRecord => r.kind === 'submission-blocked' && r.reason !== AD_INPUT_UNCONFIRMED)

async function sharedFixture() {
  const h = makeRecoveryHarness({ harnessNow: true, personas: [{ key: 'alpha' }, { key: 'beta' }] })
  const disk = await makeInputHoldFixture(h.stateDir, h.clock.now)
  const life = createDeliveryLifecycle({ clock: h.clock })
  let holds = disk.store
  for (const k of h.keys) holds.load(k)
  let queue = await makeQueue(h.stateDir, { now: h.clock.now })
  const rows = new Map(h.keys.map(k => [k, personaRow(h, k, { state: 'waiting', session_id: `${k}-conversation`, launch_started_at: stamp })]))
  const released: string[] = [], notices: string[] = []
  function install() {
    session.setDeliveryLifecycle(life)
    session.setSubmissionInputServices({ holds, notify: (_key, text) => notices.push(text), released: key => released.push(key), log: line => h.lines.push(line) })
  }
  install()
  let getRow: () => GetResult | Promise<GetResult> = () => ({ ...rows.get('alpha')! })
  let statusRow: () => StatusResult | Promise<StatusResult> = () => cannedStatusResult()
  h.stub.client.get = async params => { h.stub.calls.getCalls.push(params); return getRow() }
  h.stub.client.status = async params => { h.stub.calls.statusCalls.push(params); return statusRow() }
  cleanups.push(async () => {
    session.setSubmissionInputServices(undefined); session.setDeliveryLifecycle(undefined)
    await life.stop(); await queue.stop()
    try { assertNoLeak([h.captured(), released, notices]) } finally { h.cleanup() }
  })
  return { h, disk, life, rows, released, notices,
    get holds() { return holds }, get queue() { return queue },
    async seed(key = 'alpha', attempt = 1, seq?: number) {
      if (seq === undefined) {
        // Use the same acceptance format as the production engine harness.
        const { injectedInput } = await import('./test-helpers/delivery-queue.ts')
        const accepted = await queue.accept(key, injectedInput({ text: 'retained uncertain message' }))
        if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
        seq = accepted.seq
        await queue.append(key, { v: 1, kind: 'fixed', seq, parts: ['retained uncertain message'] })
      }
      const row = rows.get(key)!
      await queue.append(key, sentRecord(seq, attempt, 'text', { at: h.clock.now(), part: 1, session_id: row.session_id, transcript_path: join(h.stateDir, 'transcript.jsonl'), transcript_size: 0 }))
      await queue.append(key, { v: 1, kind: 'submission-blocked', seq, attempt, at: h.clock.now(), reason: AD_INPUT_UNCONFIRMED })
      return seq
    },
    hold(key = 'alpha', seq = 1, attempt = 1) {
      const result = holds.markUncertain(key, binding(rows.get(key)!), 'submission_unconfirmed', { seq, part: 1, attempt })
      expect(result.ok).toBe(true); life.holdInput(key)
      return holds.get(key)
    },
    async reopen() { await queue.stop(); queue = await makeQueue(h.stateDir, { now: h.clock.now }); holds = disk.fresh(); for (const k of h.keys) holds.load(k); install() },
    sharedGet(fn: typeof getRow) { getRow = fn },
    sharedStatus(fn: typeof statusRow) { statusRow = fn },
    read(key = 'alpha') { return session.readPersonaOwnRow(key, at) },
    status(key = 'alpha') { return session.readPersonaOwnRowStatus(key, at) },
    noRelease(key = 'alpha', attempt?: number) {
      expect(existsSync(`${holds.path(key)}.released`)).toBe(false)
      expect(holds.releasedDelivery(key)).toBeUndefined()
      expect(markers(queue.item(key, 1)!.records).filter(r => attempt === undefined || r.attempt === attempt)).toEqual([])
      expect(released).toEqual([])
      expect(h.stub.calls.sendKeysCalls).toEqual([])
    },
  }
}

for (const verb of ['get', 'status'] as const) test.each(['ended', 'missing'] as const)(`causal old ${verb} %s cannot finish newer uncertainty`, async dead => {
  const f = await sharedFixture(), entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
  const row = f.rows.get('alpha')!, old = { ...row, state: dead, session_id: 'older-session' }
  // A real existing uncertainty is replaced while the AD request is suspended.
  await f.seed(); f.hold()
  if (verb === 'get') f.sharedGet(async () => { entered.resolve(); await answer.promise; return old })
  else f.sharedStatus(async () => { entered.resolve(); await answer.promise; return cannedStatusResult({ state: dead }) })
  const work = verb === 'get' ? f.read() : f.status()
  try {
    await entered.promise
    const prior = f.holds.get('alpha'); if (prior.kind !== 'record') throw new Error('missing hold')
    expect(f.holds.clear('alpha', prior.record.revision).ok).toBe(true)
    row.session_id = 'resumed-session'
    await f.seed('alpha', 2, 1)
    const newer = f.hold('alpha', 1, 2)
    answer.resolve(); await work
    expect(f.holds.get('alpha')).toEqual(newer)
    f.sharedGet(() => ({ ...row }))
    await f.read()
    expect(f.holds.get('alpha')).toEqual(newer); f.noRelease()
    expect(f.h.stub.callCount()).toBe(2)
    await f.reopen(); await f.read()
    expect(f.holds.get('alpha')).toEqual(newer); f.noRelease()
    expect(f.h.stub.callCount()).toBe(3)
    expect(f.queue.openCount('alpha')).toBe(1)
    const engine = await makeEngineHarness({ stateDir: f.h.stateDir, queue: f.queue, inputHolds: f.holds, clientFor: async () => f.h.stub.client })
    cleanups.push(() => engine.cleanup())
    await engine.tick()
    expect(engine.lifecycle.inputHeld('alpha')).toBe(true)
    expect(engine.keyCalls()).toEqual([])
    expect((await session.reconnectMcpWithCause('alpha', latchRowStateRead('waiting'))).outcome).toBe('input-unconfirmed')
    // The genuinely older attempt can be released by this launch; the
    // newer uncertainty in that same launch must remain held.
    f.noRelease('alpha', 2)
    expect(markers(f.queue.item('alpha', 1)!.records).map(r => r.attempt)).toEqual([1])
    expect(f.h.stub.callCount()).toBe(5)
    expect(f.holds.get('alpha')).toEqual(newer)
  } finally { answer.resolve(); await work }
})

test.each(['ended', 'missing'] as const)('causal state-only status never releases (%s) but a later full row proves same-session resume', async dead => {
  const f = await sharedFixture(), row = f.rows.get('alpha')!
  await f.seed(); const held = f.hold()
  f.sharedStatus(() => cannedStatusResult({ state: 'pending', launch_started_at: '2026-11-21T00:00:00Z' }))
  await f.status()
  expect(f.holds.get('alpha')).toEqual(held); f.noRelease()
  // Even an exact explicit snapshot gives a state-only answer no identity.
  session.applyOwnRowStatusStep('alpha', { result: cannedStatusResult({ state: 'pending', launch_started_at: '2026-11-21T00:00:00Z' }) }, at, f.holds.get('alpha'))
  expect(f.holds.get('alpha')).toEqual(held); f.noRelease()
  f.sharedStatus(() => cannedStatusResult({ state: dead })); await f.status()
  expect(f.holds.get('alpha')).toMatchObject({ kind: 'record', record: { finished: true } })
  f.sharedStatus(() => cannedStatusResult({ state: 'waiting' })); await f.status()
  expect(f.holds.get('alpha')).toMatchObject({ kind: 'record', record: { finished: true } }); f.noRelease()
  await f.read()
  expect(f.holds.get('alpha')).toEqual({ kind: 'clear' })
  expect(f.released).toEqual(['alpha'])
  expect(f.h.stub.callCount()).toBe(4)
  expect(f.h.stub.calls.getCalls).toEqual([{ instance_id: row.instance_id }])
  await f.reopen()
  expect(f.holds.releasedDelivery('alpha')).toEqual({ seq: 1, part: 1, attempt: 1 })
  expect(markers(f.queue.item('alpha', 1)!.records)).toEqual([])
  expect(f.h.stub.callCount()).toBe(4)
})

// Inject the real engine's AD client, retaining every method's call log.
async function engineFixture(options: Parameters<typeof makeEngineHarness>[0] = {}) {
  const f = await sharedFixture(), calls = makeStubCallLog()
  let get: () => GetResult | Promise<GetResult> = () => ({ ...f.rows.get('alpha')!, state: 'working' })
  const client = makeStubClient(calls)
  client.get = async params => { calls.getCalls.push(params); return get() }
  const seen: string[] = []
  const engine = await makeEngineHarness({ keys: ['alpha', 'beta'], stateDir: f.h.stateDir, queue: f.queue, inputHolds: f.holds,
    clientFor: async key => key === 'alpha' ? client : siblingClient,
    onRow: key => { seen.push(key); return true }, ...options })
  const siblingCalls = makeStubCallLog()
  const siblingClient = makeStubClient({ ...siblingCalls, getFn: () => ({ ...f.rows.get('beta')!, state: 'working' }) })
  cleanups.push(() => engine.cleanup())
  return { ...f, engine, calls, siblingCalls, client, seen, get(fn: typeof get) { get = fn } }
}

for (const reader of ['shared', 'engine'] as const) test.each(['same-session', 'older-session'] as const)(`causal ${reader} old live %s cannot consume a later finished observation`, async identity => {
  const f = await engineFixture(), row = f.rows.get('alpha')!
  await f.seed(); f.hold()
  const entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
  const old = { ...row, state: 'working', ...(identity === 'older-session' ? { session_id: 'old-session', started_at: '2026-11-18T00:00:00Z' } : {}) }
  if (reader === 'shared') f.sharedGet(async () => { entered.resolve(); await answer.promise; return old })
  else f.get(async () => { entered.resolve(); await answer.promise; return old })
  const work = reader === 'shared' ? f.read() : f.engine.engine.tick('alpha')
  try {
    await entered.promise
    // This independent shared read observes the later finished state. Its queue
    // marker is durable before the delayed engine/shared read completes.
    f.sharedGet(() => ({ ...row, state: 'ended' })); await f.read()
    await f.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq: 1, attempt: 1, at: f.h.clock.now(), reason: AD_INPUT_LAUNCH_FINISHED })
    const finished = f.holds.get('alpha')
    expect(finished).toMatchObject({ kind: 'record', record: { finished: true } })
    answer.resolve(); await work
    expect(f.holds.get('alpha')).toEqual(finished)
    expect(existsSync(`${f.holds.path('alpha')}.released`)).toBe(false)
    expect(markers(f.queue.item('alpha', 1)!.records).map(r => r.reason)).toEqual([AD_INPUT_LAUNCH_FINISHED])
    expect(f.released).toEqual([])
    expect(f.h.stub.callCount() + stubCallCount(f.calls)).toBe(2)
    // Positive control: a new full read, started after finished, can release.
    f.sharedGet(() => ({ ...row })); await f.read()
    expect(f.holds.get('alpha')).toEqual({ kind: 'clear' })
    expect(f.released).toEqual(['alpha'])
    expect(f.h.stub.callCount() + stubCallCount(f.calls)).toBe(3)
    expect(f.calls.sendKeysCalls).toEqual([])
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect(stubCallCount(f.siblingCalls)).toBe(0)
  } finally { answer.resolve(); await work }
})

for (const response of ['ended', 'different-session'] as const) test.each(['new-attempt', 'replace-attempt'] as const)(`causal queue-only ${response} cannot bookkeep an uncertainty published during the read (%s)`, async mode => {
  const f = await engineFixture(), entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
  const seq = await f.seed(); await f.seed('alpha', 2, seq); await f.seed('beta')
  const beforeBeta = [...f.queue.item('beta', 1)!.records]
  f.get(async () => { entered.resolve(); await answer.promise; return { ...f.rows.get('alpha')!, launch_started_at: null,
    state: response === 'ended' ? 'ended' : 'working', ...(response === 'different-session' ? { session_id: 'old-other-session' } : {}) } })
  const work = f.engine.engine.tick('alpha')
  try {
    await entered.promise
    if (mode === 'new-attempt') await f.seed('alpha', 3, seq)
    else await f.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq, attempt: 2, at: f.h.clock.now() + 1, reason: AD_INPUT_UNCONFIRMED })
    // A brand-new item was absent from the pre-request snapshot as well.
    const added = await f.seed('alpha')
    answer.resolve(); await work
    expect(markers(f.queue.item('alpha', added)!.records)).toEqual([])
    const records = markers(f.queue.item('alpha', seq)!.records)
    // The append replaces this item's public snapshot, conservatively
    // invalidating the read for its earlier attempts too.
    expect(records).toEqual([])
    expect(f.queue.item('beta', 1)!.records).toEqual(beforeBeta)
    expect(f.holds.get('alpha')).toEqual({ kind: 'clear' })
    expect(f.calls.getCalls).toHaveLength(1); expect(stubCallCount(f.calls)).toBe(1)
    expect(f.h.stub.callCount()).toBe(0); expect(f.released).toEqual([])
    expect(f.engine.errors).toEqual([])
    expect(stubCallCount(f.siblingCalls)).toBe(0)
  } finally { answer.resolve(); await work }
})

for (const stop of ['stop', 'forget'] as const) test.each(['resolve', 'reject', 'continue'] as const)(`causal ${stop} during bookkeeping append (%s)`, async outcome => {
  const f = await engineFixture(), entered = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
  await f.seed(); await f.seed('alpha', 2, 1); f.hold()
  f.get(() => ({ ...f.rows.get('alpha')!, state: 'working', session_id: 'new-session' }))
  const append = f.queue.append, writes = [...f.disk.writes], held = f.holds.get('alpha'), attempts: number[] = []
  f.queue.append = async (key, record) => {
    if (key === 'alpha' && record.kind === 'submission-blocked' && record.reason === AD_INPUT_NEW_LAUNCH) {
      attempts.push(record.attempt)
      if (attempts.length === 1) {
        entered.resolve(); await answer.promise
        if (outcome === 'reject') throw new Error('injected pending bookkeeping failure')
      }
    }
    await append(key, record)
  }
  const observed: string[] = [], observe = f.engine.lifecycle.observeRow, release = f.engine.lifecycle.releaseInput
  f.engine.lifecycle.observeRow = (key, row) => { observed.push(key); observe(key, row) }
  f.engine.lifecycle.releaseInput = key => { observed.push(`release:${key}`); release(key) }
  const work = f.engine.engine.tick('alpha')
  let stopping: Promise<void> | undefined
  try {
    await entered.promise
    if (outcome !== 'continue') stopping = stop === 'stop' ? f.engine.engine.stop() : f.engine.engine.forget('alpha')
    answer.resolve(); await work; await stopping
    expect(attempts).toEqual([1])
    if (outcome !== 'continue') {
      expect(f.holds.get('alpha')).toEqual(held)
      expect(f.disk.writes).toEqual(writes)
      expect(existsSync(`${f.holds.path('alpha')}.released`)).toBe(false)
      expect(f.seen).toEqual([]); expect(observed).toEqual([])
      expect(f.released).toEqual([]); expect(f.notices).toEqual([])
      expect(f.engine.errors).toEqual([])
      expect(markers(f.queue.item('alpha', 1)!.records)).toHaveLength(outcome === 'resolve' ? 1 : 0)
    } else {
      expect(f.holds.get('alpha')).toEqual({ kind: 'clear' })
      expect(f.seen).toEqual(['alpha']); expect(observed).toContain('alpha')
      expect(existsSync(`${f.holds.path('alpha')}.released`)).toBe(true)
      expect(markers(f.queue.item('alpha', 1)!.records)).toHaveLength(1)
      // The first append replaces the item's immutable snapshot. The next
      // ordinary poll captures the remaining attempt and completes it.
      await f.engine.clock.advance(DELIVERY_ROW_POLL_MS)
      await f.engine.engine.tick('alpha')
      expect(attempts).toEqual([1, 2])
      expect(markers(f.queue.item('alpha', 1)!.records)).toHaveLength(2)
    }
    expect(stubCallCount(f.calls)).toBe(outcome === 'continue' ? 2 : 1); expect(f.h.stub.callCount()).toBe(0)
    expect(stubCallCount(f.siblingCalls)).toBe(0)
    // Forget is persona-local: the sibling still receives its normal row read.
    if (stop === 'forget') {
      await f.engine.accept('sibling', 'beta'); await f.engine.tick('beta')
      expect(f.seen.at(-1)).toBe('beta')
      expect(f.engine.keyCalls('beta')).toEqual([])
      expect(stubCallCount(f.siblingCalls)).toBe(1)
      expect(f.siblingCalls.getCalls).toEqual([{ instance_id: f.rows.get('beta')!.instance_id }])
    }
  } finally { answer.resolve(); await work; await stopping; f.queue.append = append }
})

test.each(['lookup', 'later-part', 'unresolved', 'covered-block', 'raw-input', 'missing-client'] as const)('causal covered transition with legacy history (%s)', async mode => {
  const h = await makeBusyHarness(); cleanups.push(() => h.cleanup())
  let seq = h.seq
  if (mode === 'later-part') {
    const { injectedInput } = await import('./test-helpers/delivery-queue.ts')
    const accepted = await h.queue.accept('alpha', injectedInput({ text: 'multipart' }))
    if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
    seq = accepted.seq
    await h.queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: ['first', 'next'] })
  }
  await h.queue.append('alpha', sentRecord(seq, 1, 'text', { part: 1, session_id: h.row.session_id, at: 1000, transcript_path: join(h.root, 'transcript.jsonl'), transcript_size: 0 }))
  await h.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq, attempt: 1, at: 1000, reason: AD_INPUT_UNCONFIRMED })
  if (mode !== 'unresolved') await h.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq, attempt: 1, at: 1001, reason: AD_INPUT_NEW_LAUNCH })
  if (mode === 'covered-block') await h.queue.append('alpha', { v: 1, kind: 'submission-blocked', seq, attempt: 1, at: 1002, reason: 'cant_send:id_conflict' })
  if (mode === 'later-part') {
    await h.queue.append('alpha', deliveredRecord(seq, 1002, { part: 1 }))
  }
  if (mode === 'lookup') {
    await h.queue.append('alpha', { v: 1, kind: 'submitted', seq, attempt: 2, part: 1, at: 1002,
      caller_uuid: h.queue.callerUuid!(), delivery_request_id: 'existing-covered-request', instance_id: h.row.instance_id, session_id: h.row.session_id })
    h.script.getDeliveryResult = cannedDeliveryLookup(cannedBusyResult())
  }
  let rowReads = 0
  h.read(async () => { rowReads++; return h.row })
  const action = await h.step({ item: h.queue.item('alpha', seq)!, ...(mode === 'later-part' ? { part: 2 } : {}),
    ...(mode === 'missing-client' ? { client: async () => ({ ...h.client, getDelivery: undefined }) } : {}) })
  expect(action).toBe(mode === 'lookup' || mode === 'later-part' ? 'waiting' : 'blocked')
  expect(h.calls.getDeliveryCalls).toHaveLength(mode === 'lookup' ? 1 : 0)
  expect(h.calls.sendKeysCalls).toHaveLength(mode === 'later-part' ? 1 : 0)
  expect(h.calls.readPaneCalls).toEqual([])
  expect(stubCallCount(h.calls)).toBe(mode === 'lookup' || mode === 'later-part' ? 1 : 0)
  expect(rowReads).toBe(mode === 'later-part' ? 2 : 0)
  if (mode === 'later-part') expect(h.calls.sendKeysCalls[0]).toMatchObject({ text: 'next', confirmed_delivery: true })
  expect(h.completions).toBe(0)
  assertNoLeak([h.calls, h.notices, h.logs, h.records()])
})
