/** b.omv SR-7.6: one fresh conversation through the real collision/checked lifecycle paths. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GetResult, SpawnParams } from 'agent-director'
import { inspectPersonaUpgrade, isTagUpgradePending, reconnectMcpWithCause, sendPendingRowLapEnter, setDeliveryPersonaLookup, _resetInFlightLaunches } from '../src/session-manager.ts'
import { _buildReconnectSessionAdapter } from '../src/server.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import { makeRecoveryHarness, personaOf, personaRow, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
import { cannedFindMissing, cannedKillResult, cannedResumeResult, cannedSpawnResult, cannedStatusResult, errInstanceIdCollision, errTmuxKillFailed } from './test-helpers/agent-director-stub.ts'
import { writeTranscript, endedTurn } from './test-helpers/working-row-panes.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
useImmediateTypingLifecycle()
const cleanups: RecoveryHarness[] = []
const engines: EngineHarness[] = []
afterEach(async () => { for (const engine of engines.splice(0)) { try { assertNoLeak({ calls: engine.calls, events: engine.events, errors: engine.errors }) } finally { await engine.cleanup() } } })
afterEach(() => { setDeliveryPersonaLookup(() => undefined); for (const h of cleanups.splice(0)) { try { assertNoLeak(h.captured()) } finally { h.cleanup() } } })

function fleet(state: string, marked = false) {
  const h = makeRecoveryHarness({ harnessNow: true })
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
  return { h, p, q, persona, old, memory, memoryBefore, row: () => row,
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

describe('earlier-release replacement', () => {
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

  test('a supported startup prompt is never answered on an earlier-release row', async () => {
    const f = fleet('pending')
    f.h.script({ getResult: f.row() })
    await sendPendingRowLapEnter(f.p)
    expect(f.h.stub.calls.sendKeysCalls).toEqual([])
    kept(f)
  })

  test('a fresh read that turns busy before the checked kill preserves the row', async () => {
    const f = fleet('waiting')
    const get = f.h.stub.client.get
    let reads = 0
    f.h.stub.client.get = async params => {
      if (++reads === 2) f.change({ state: 'working' })
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
