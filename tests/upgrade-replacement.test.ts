/** one fresh conversation through the real collision/checked lifecycle paths. */
import type { Client, GetResult, SpawnParams } from 'agent-director'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { createDeliveryAdScope } from '../src/delivery-ad-scope.ts'
import { DELIVERY_MAX_AD_CALLS_PER_S, RECEIPT_WAIT_MS } from '../src/delivery-engine.ts'
import { _buildReconnectSessionAdapter } from '../src/server.ts'
import { _resetInFlightLaunches, applyDeliveryOwnRowRead, inspectPersonaUpgrade, isTagUpgradePending, reconnectMcpWithCause, setDeliveryLifecycle, setDeliveryPersonaLookup } from '../src/session-manager.ts'
import { cannedFindMissing, cannedKillResult, cannedResumeResult, cannedSpawnResult, cannedStatusResult, errInstanceIdCollision, errTmuxKillFailed } from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { makeRecoveryHarness, personaOf, personaRow, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
import { endedTurn, writeTranscript } from './test-helpers/working-row-panes.ts'
useImmediateTypingLifecycle()
const cleanups: RecoveryHarness[] = []
const engines: EngineHarness[] = []
afterEach(async () => { for (const engine of engines.splice(0)) { try { assertNoLeak({ calls: engine.calls, events: engine.events, errors: engine.errors }) } finally { await engine.cleanup() } } })
afterEach(() => { setDeliveryPersonaLookup(() => undefined); for (const h of cleanups.splice(0)) { try { assertNoLeak(h.captured()) } finally { h.cleanup() } } })

function fleet(state: string, marked = false) {
  const scope = createDeliveryAdScope()
  const h = makeRecoveryHarness({ harnessNow: true, deliveryScope: scope })
  cleanups.push(h)
  const [p, q] = h.keys as [string, string]
  const persona = personaOf(h, p)
  const old = personaRow(h, p, { state, session_id: 'earlier-release-conversation' })
  const { tag_prompt: _tag, ...oldLabels } = old.labels
  let row: GetResult = { ...old, labels: marked ? old.labels : oldLabels }
  let fresh = 0
  let kills = 0
  let refuseKill = false
  const memory = join(h.home, '.claude', 'projects', 'persona', 'memory', 'MEMORY.md')
  mkdirSync(join(memory, '..'), { recursive: true })
  writeFileSync(memory, 'retained memory\n\u0000exact bytes')
  const memoryBefore = readFileSync(memory)
  setDeliveryPersonaLookup(key => h.config.personas.find(persona => persona.key === key))
  h.script({
    getFn: params => params.instance_id === old.instance_id ? row : personaRow(h, q),
    statusFn: params => cannedStatusResult({ state: params.instance_id === old.instance_id ? row.state : 'waiting', ...(row.state === 'pending' ? { launch_started_at: old.launch_started_at } : {}) }),
    spawnFn: params => {
      if (params.instance_id !== old.instance_id) return cannedSpawnResult(params.instance_id)
      if (!params.reuse_finished) return errInstanceIdCollision()
      fresh++
      const labels = Object.fromEntries((params.label ?? []).map(label => label.split('=')))
      row = { ...row, state: 'waiting', session_id: `replacement-${fresh}`, labels }
      return cannedSpawnResult(params.instance_id)
    },
    resumeFn: params => cannedResumeResult(params.instance_id),
    killFn: () => { kills++; if (refuseKill) return errTmuxKillFailed(); row = { ...row, state: 'ended' }; return cannedKillResult(true) },
    findMissingResult: cannedFindMissing(),
  })
  return { h, p, q, persona, old, memory, memoryBefore, scope, row: () => row,
    change: (patch: Partial<GetResult>) => { row = { ...row, ...patch } },
    refuseKills: () => { refuseKill = true }, fresh: () => fresh, kills: () => kills,
    replacements: (): SpawnParams[] => h.stub.calls.spawnCalls.filter(call => call.reuse_finished === true),
  }
}

async function settle(f: ReturnType<typeof fleet>) {
  if (f.h.sequenceRunning(f.p)) await f.h.driveSequence(f.h.sequenceSettled(f.p))
  await f.h.settle()
}
function kept(f: ReturnType<typeof fleet>) {
  expect(readFileSync(f.memory)).toEqual(f.memoryBefore)
  expect(f.h.stub.calls.deleteCalls).toEqual([])
}

/** The server's actual own-row and async-local upgrade wiring, using the
 * engine's client rather than the recovery fixture's separate client. */
async function deliveryFleet(f: ReturnType<typeof fleet>, responseMs?: { get: number; readPane: number; sendKeys: number }) {
  const engine = await makeEngineHarness({ keys: [f.p], onRow: applyDeliveryOwnRowRead,
    inspectUpgrade: (key, _row, client, beforeCall) => f.scope.run(key, client as Client, beforeCall, async () => { await inspectPersonaUpgrade(key, f.persona) }),
  })
  engines.push(engine)
  setDeliveryLifecycle(engine.lifecycle)
  const live = engine.p(f.p)
  live.path = join(engine.root, `${f.row().session_id}.jsonl`)
  writeTranscript(live.path, endedTurn())
  f.change({ jsonl_path: live.path })
  Object.defineProperty(live, 'row', { get: f.row, configurable: true })
  if (responseMs) {
    const client = engine.client(f.p)
    // Match the native get/read-pane/key response cadence without real waits.
    // Shared inspectors call this very same client through DeliveryAdScope.
    const delayed = <P, R>(original: (params: P) => Promise<R>, delay: number) => async (params: P): Promise<R> => {
      const result = await original(params)
      await new Promise<void>(resolve => engine.clock.setTimeout(resolve, delay))
      return result
    }
    client.get = delayed(client.get.bind(client), responseMs.get)
    client.readPane = delayed(client.readPane.bind(client), responseMs.readPane)
    client.sendKeys = delayed(client.sendKeys.bind(client), responseMs.sendKeys)
  }
  return engine
}

async function driveDelivery(engine: EngineHarness, key: string, until = () => !engine.engine.running(key)) {
  for (let turn = 0; turn < 4000 && !until(); turn++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await engine.clock.runNext()
  }
  if (!until()) throw new Error(JSON.stringify({ at: engine.clock.now(), snapshot: engine.engine.snapshot(key), errors: engine.errors, events: engine.events.slice(-3), pending: engine.clock.pending(), calls: engine.calls.slice(-8) }))
}

function withinBudget(engine: EngineHarness) {
  for (const call of engine.calls) expect(engine.calls.filter(other => other.at > call.at - 10000 && other.at <= call.at).length).toBeLessThanOrEqual(DELIVERY_MAX_AD_CALLS_PER_S * 10)
}

describe('earlier-release replacement', () => {
  test.each(['recorded window', 'immediate ready followups'] as const)('%s: ready-message cadence meets with production upgrade reads inside the 40-call budget', async cadence => {
    const f = fleet('waiting', true)
    const engine = await deliveryFleet(f, { get: 8, readPane: 25, sendKeys: 25 })
    // Native280 Test32, decision19 job-01: seq33 -> seq34 idle gap, then
    // seq34..53's observed receipt-to-next-accept gaps (ms). The second row
    // uses the existing engine latency regression's 50 ms idle gap, now with
    // production upgrade wiring. Longer native reply gaps can hide the cost
    // of redundant gets, so both the recorded and sustained loads matter.
    const responseGaps = cadence === 'recorded window'
      ? [2081, 784, 559, 2987, 2050, 797, 3374, 727, 4632, 5753, 2225, 818, 817, 644, 2005, 1292, 835, 535, 2641, 1532]
      : [2081, ...Array.from({ length: 19 }, () => 50)]
    const precedingHeads = ['preceding FIFO head']
    for (const text of precedingHeads) await engine.accept(text, f.p)
    engine.engine.wake(f.p)
    await driveDelivery(engine, f.p)
    const typing: number[] = [], confirmation: number[] = []
    for (const [i, gap] of responseGaps.entries()) {
      const before = engine.calls.length
      await engine.clock.advance(gap)
      expect(engine.calls).toHaveLength(before)
      expect(engine.clock.pending()).toEqual([])
      expect([f.row().state, engine.p(f.p).box]).toEqual(['waiting', ''])
      const accepted = await engine.accept(`ready DM ${i + 1}`, f.p)
      engine.engine.wake(f.p)
      await driveDelivery(engine, f.p)
      typing.push(engine.textCalls(f.p).at(-1)!.at - accepted.accepted.received_at)
      const done = engine.events.find(event => event.type === 'item-delivered' && event.seq === accepted.accepted.seq)!
      expect(done.type).toBe('item-delivered')
      if (done.type === 'item-delivered') confirmation.push(done.waitMs)
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!
    expect(p95(typing)).toBeLessThanOrEqual(2000)
    expect(p95(confirmation)).toBeLessThanOrEqual(10000)
    expect(engine.events.filter(event => event.type === 'delivered').map(event => event.seq)).toEqual(Array.from({ length: precedingHeads.length + 20 }, (_, i) => i + 1))
    expect(engine.keyCalls(f.p).map(call => call.params.key ?? call.params.text)).toEqual([...precedingHeads, ...responseGaps.map((_, i) => `ready DM ${i + 1}`)].flatMap(text => [text, 'Enter']))
    expect(engine.queue.openCount(f.p)).toBe(0)
    expect(engine.errors).toEqual([])
    withinBudget(engine)
    expect(f.h.stub.calls.getCalls).toEqual([])
    kept(f)
  })

  test('a marker disappearing at the independent gate read prevents keys in the earlier conversation', async () => {
    const f = fleet('waiting', true)
    const engine = await deliveryFleet(f)
    await engine.accept('queued before marker loss', f.p)
    let readyRowReads = 0
    engine.p(f.p).getHook = () => {
      if (++readyRowReads === 2) {
        const { tag_prompt: _tag, ...labels } = f.row().labels
        f.change({ state: 'working', labels })
      }
    }
    await engine.tick(f.p)
    expect(readyRowReads).toBeGreaterThan(0)
    expect(engine.keyCalls(f.p)).toEqual([])
    expect(engine.queue.openCount(f.p)).toBe(1)
    expect(isTagUpgradePending(f.p)).toBe(true)
    expect(f.fresh()).toBe(0)
    expect(f.kills()).toBe(0)
    kept(f)
  })

  test.each([undefined, '', '0', 'true', ' 1', 1] as const)('an absent or malformed marker %s retains fresh inspection and never types', async marker => {
    const f = fleet('working')
    const labels = { ...f.row().labels }
    if (marker === undefined) delete labels.tag_prompt
    else labels.tag_prompt = marker as string
    f.change({ labels })
    const engine = await deliveryFleet(f)
    await engine.accept('held for upgrade', f.p)
    await engine.tick(f.p)
    // Pending is only set by the production inspector's fresh scoped read.
    expect(isTagUpgradePending(f.p)).toBe(true)
    expect(engine.calls.filter(call => call.verb === 'get')).toHaveLength(2)
    expect(engine.keyCalls(f.p)).toEqual([])
    expect(f.h.stub.calls.getCalls).toEqual([])
    expect(f.fresh()).toBe(0)
    kept(f)
  })

  test.each(['busy', 'already current'] as const)('a markerless engine observation followed by a fresh %s row prevents replacement', async change => {
    const f = fleet('waiting')
    const engine = await deliveryFleet(f)
    const client = engine.client(f.p), get = client.get.bind(client)
    let reads = 0
    client.get = async params => {
      const row = await get(params)
      if (++reads === 1) f.change(change === 'busy' ? { state: 'working' } : { labels: { ...row.labels, tag_prompt: '1' } })
      return row
    }
    await engine.accept('fresh provenance required', f.p)
    await engine.tick(f.p)
    expect(reads).toBe(2)
    expect(engine.keyCalls(f.p)).toEqual([])
    expect(isTagUpgradePending(f.p)).toBe(change === 'busy')
    expect(f.kills()).toBe(0)
    expect(f.fresh()).toBe(0)
    expect(engine.queue.openCount(f.p)).toBe(1)
    kept(f)
  })

  test('a marked response for another instance still requires fresh own-row upgrade inspection', async () => {
    const f = fleet('working')
    const engine = await deliveryFleet(f)
    const client = engine.client(f.p), get = client.get.bind(client)
    let reads = 0
    client.get = async params => {
      const row = await get(params)
      return ++reads === 1 ? { ...row, instance_id: row.instance_id + '_other', labels: { ...row.labels, tag_prompt: '1' } } : row
    }
    await engine.accept('only own provenance counts', f.p)
    await engine.tick(f.p)
    expect(reads).toBe(2)
    expect(isTagUpgradePending(f.p)).toBe(true)
    expect(engine.keyCalls(f.p)).toEqual([])
    expect(f.kills()).toBe(0)
    expect(f.fresh()).toBe(0)
    kept(f)
  })

  test.each(['other instance', 'provenance conflict', 'pending without launch start'] as const)('%s cannot clear a previously observed E5 upgrade candidate', async change => {
    const f = fleet('working')
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('deferred')
    f.change({ labels: { ...f.row().labels, tag_prompt: '1' },
      ...(change === 'other instance' ? { instance_id: f.old.instance_id + '_other' } : {}),
      ...(change === 'provenance conflict' ? { liveness_note: 'provenance_conflict' as const } : {}),
      ...(change === 'pending without launch start' ? { state: 'pending' as const, launch_started_at: null } : {}),
    })
    expect(applyDeliveryOwnRowRead(f.p, f.row())).toBe(change !== 'other instance')
    expect(isTagUpgradePending(f.p)).toBe(true)
    expect(f.fresh()).toBe(0)
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    kept(f)
  })

  test('a fresh current delivery reading clears upgrade pending after replacement without another inspector', async () => {
    const f = fleet('working')
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('deferred')
    expect(isTagUpgradePending(f.p)).toBe(true)
    f.change({ state: 'waiting' })
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('replacing')
    await settle(f)
    expect(f.fresh()).toBe(1)
    expect(f.row().labels.tag_prompt).toBe('1')
    // Replacement itself hasn't supplied the later delivery observation.
    expect(isTagUpgradePending(f.p)).toBe(true)
    const reads = f.h.stub.calls.getCalls.length
    expect(applyDeliveryOwnRowRead(f.p, f.row())).toBe(false)
    expect(isTagUpgradePending(f.p)).toBe(false)
    expect(f.h.stub.calls.getCalls).toHaveLength(reads)
    expect(f.fresh()).toBe(1)
    kept(f)
  })

  test.each(['ended', 'missing'])('%s: never resumes the old conversation, reuses once with the marker, retains memory and later resumes normally', async state => {
    const f = fleet(state)
    expect((await f.h.launch(f.p)).action).toBe('spawned')
    await settle(f)
    expect(f.replacements()).toHaveLength(1)
    expect(f.replacements()[0]!.label).toContain('tag_prompt=1')
    expect(f.h.stub.calls.resumeCalls).toEqual([])
    expect(f.row().session_id).toBe('replacement-1')
    expect(f.kills()).toBe(0)
    kept(f)
    f.change({ state: 'ended' })
    expect((await f.h.launch(f.p)).action).toBe('resumed')
    await settle(f)
    expect(f.h.stub.calls.resumeCalls).toEqual([{ instance_id: f.old.instance_id }])
    expect(f.fresh()).toBe(1)
    kept(f)
  })

  test.each(['waiting', 'pending', 'ask_user'])('%s: checked sequence replaces once and never types into the old row', async state => {
    const f = fleet(state)
    expect((await f.h.launch(f.p)).action).toBe('sequence-waiting')
    await settle(f)
    expect(f.kills()).toBeGreaterThanOrEqual(1)
    expect(f.replacements()).toHaveLength(1)
    expect(f.h.stub.calls.resumeCalls).toEqual([])
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect(f.row().labels.tag_prompt).toBe('1')
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('current')
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('current')
    expect(f.fresh()).toBe(1)
    kept(f)
  })

  test.each(['working', 'check_permission'])('%s survives observers and a cold restart until a fresh eligible state is read', async state => {
    const f = fleet(state)
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('deferred')
    expect(isTagUpgradePending(f.p)).toBe(true)
    _resetInFlightLaunches()
    expect(isTagUpgradePending(f.p)).toBe(false)
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('deferred')
    expect(isTagUpgradePending(f.p)).toBe(true)
    const reconnect = _buildReconnectSessionAdapter(key => f.h.config.personas.find(persona => persona.key === key))
    expect(await reconnect(f.p)).toBe('transient')
    expect(f.kills()).toBe(0)
    expect(f.fresh()).toBe(0)
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect((await f.h.launch(f.q)).action).toBe('spawned')
    f.change({ state: 'waiting' })
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('replacing')
    await settle(f)
    expect(f.fresh()).toBe(1)
    expect(f.h.stub.calls.sendKeysCalls.filter(call => call.instance_id === f.old.instance_id)).toEqual([])
    kept(f)
  })

  test('concurrent lifecycle observers share one checked replacement', async () => {
    const f = fleet('waiting')
    const reads = await Promise.all(Array.from({ length: 8 }, () => inspectPersonaUpgrade(f.p, f.persona)))
    expect(reads).toEqual(Array(8).fill('replacing'))
    await settle(f)
    expect(f.fresh()).toBe(1)
    expect(f.replacements()).toHaveLength(1)
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    kept(f)
  })

  test.each(['busy', 'already current'] as const)('a fresh read that turns %s before the checked kill preserves the row', async change => {
    const f = fleet('waiting')
    const get = f.h.stub.client.get
    let reads = 0
    f.h.stub.client.get = async params => {
      if (++reads === 2) f.change(change === 'busy' ? { state: 'working' } : { labels: { ...f.row().labels, tag_prompt: '1' } })
      return get(params)
    }
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('replacing')
    await settle(f)
    expect(f.kills()).toBe(0)
    expect(f.fresh()).toBe(0)
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    kept(f)
  })

  test('direct reconnect cannot type control keys into an old live conversation', async () => {
    const f = fleet('working')
    expect(await reconnectMcpWithCause(f.p, latchRowStateRead('waiting'))).toEqual({ outcome: 'transient' })
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect(f.kills()).toBe(0)
    kept(f)
  })

  test.each(['working', 'check_permission'])('%s: engine observes replacement after a server restart and delivers queued items', async state => {
    const f = fleet(state)
    const engine = await makeEngineHarness({ keys: [f.p], inspectUpgrade: async key => { await inspectPersonaUpgrade(key, f.persona) } }); engines.push(engine)
    const live = engine.p(f.p)
    f.change({ jsonl_path: live.path })
    Object.defineProperty(live, 'row', { get: f.row, configurable: true })
    const typedSessions: string[] = []
    live.keyHook = () => { typedSessions.push(f.row().session_id); return undefined }
    await engine.accept('queued before the upgrade', f.p)
    engine.engine.wake(f.p)
    await engine.advance(3000)
    expect(engine.keyCalls(f.p)).toEqual([])
    expect(engine.queue.items(f.p).filter(item => !item.delivered)).toHaveLength(1)
    expect(isTagUpgradePending(f.p)).toBe(true)
    await engine.restartServer()
    _resetInFlightLaunches()
    await engine.advance(1000)
    expect(isTagUpgradePending(f.p)).toBe(true)
    expect(f.fresh()).toBe(0)
    f.change({ state: 'waiting' })
    await engine.advance(1000)
    await settle(f)
    expect(f.fresh()).toBe(1)
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('current')
    expect(isTagUpgradePending(f.p)).toBe(false)
    live.path = join(engine.root, 'replacement-1.jsonl')
    writeTranscript(live.path, endedTurn())
    f.change({ jsonl_path: live.path })
    await engine.until(() => engine.queue.items(f.p).every(item => item.delivered))
    expect(engine.textCalls(f.p)).toHaveLength(1)
    expect(typedSessions).toEqual(['replacement-1', 'replacement-1'])
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    kept(f)
  })

  test('a refused checked kill leaves the old conversation and memory; a healthy neighbor still launches', async () => {
    const f = fleet('waiting')
    f.refuseKills()
    expect(await inspectPersonaUpgrade(f.p, f.persona)).toBe('replacing')
    await settle(f)
    expect(f.fresh()).toBe(0)
    expect(f.row().session_id).toBe('earlier-release-conversation')
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    expect((await f.h.launch(f.q)).action).toBe('spawned')
    await f.h.settle()
    kept(f)
  })
})
