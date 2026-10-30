/** Local TLC runtime decision replay after the cardinal-rule model migration.
 * Local evidence keeps its own provenance; it is never a scheduler certificate. */
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_ACTIONS, decideEngine, decideGate, selectDeliveryTarget, type DeliveryPolicyKnowledge } from '../src/delivery-engine.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { deliveryEvidencePython } from './test-helpers/delivery-model-evidence.ts'
import { decodeDeliveryFixture, replayDeliveryFixture } from './test-helpers/delivery-model-replay.ts'

const repo = join(import.meta.dir, '..'), fixtures = join(import.meta.dir, 'fixtures/delivery-traces')
const scratch: string[] = []
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporary() { const root = mkdtempSync(join(tmpdir(), 'delivery-conformance-')); scratch.push(root); return root }
function coverage() { return JSON.parse(readFileSync(join(fixtures, 'coverage.json'), 'utf8')) }

test('complete local TLC inputs retain full paths, cycles, executed controls and coverage without claiming scheduler certification', () => {
  const root = temporary(), home = join(root, 'home'); mkdirSync(home)
  const body = String.raw`
local = load(REPO / "tests/test-helpers/delivery-local-evidence.py", "conformance_local_evidence")
print(json.dumps(readonly(local.validate)))
`
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', `${deliveryEvidencePython}\n${body}`, repo, root], {
    cwd: repo, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: root, SLACK_STATE_DIR: join(home, 'state') } }),
    encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024,
  })
  expect({ status: result.status, signal: result.signal, error: result.error?.message, diagnostic: result.status === 0 ? '' : result.stderr + result.stdout }).toEqual({ status: 0, signal: null, error: undefined, diagnostic: '' })
  const c = coverage()
  expect(JSON.parse(result.stdout)).toEqual({ traces: c.summary.traces, states: c.summary.states, controls: 39, actions: ENGINE_ACTIONS.length, faults: 26, flaps: 4 })
  expect(c.certification).toBe(false)
  expect(c.evidenceKind).toBe('local-tlc-replay')
  expect(c.report.inputsUnchanged).toBe(true)
  expect(c.report.rows).toHaveLength(80)
  expect(c.report.auxiliaryRows).toHaveLength(8)
  expect(Object.keys(c.auxiliaryEvidence)).toHaveLength(8)
  expect(Object.keys(c.supplementalEvidence).sort()).toEqual(['supplemental_pullback-001.json', 'supplemental_reconnect-001.json'])
  expect(c.report.rows.some((row: any) => row.cfg.startsWith('supplemental_'))).toBe(false)
  const checked = new Set(c.report.rows.filter((row: any) => row.mode === 'check' && row.expect === 'pass').flatMap((row: any) => row.checks))
  for (const invariant of ['NoDrop', 'InOrder', 'TranscriptFIFO', 'OneInFlight', 'DurableAccept', 'ReceiptBacked', 'NoDuplicateKey', 'NoHeldDelivery']) expect(checked.has(invariant)).toBe(true)
}, 600000)

test('ENGINE_ACTIONS equals the current TLA source vocabulary and frozen fixture inventory', () => {
  const source = readFileSync(join(repo, 'spec/tla/PersonaDelivery.tla'), 'utf8')
  const set = /EngineActions\s*==\s*\{([^}]+)\}/.exec(source)![1]!
  const actions = [...set.matchAll(/"([^"]+)"/g)].map(m => m[1]!).sort()
  expect([...ENGINE_ACTIONS].sort() as string[]).toEqual(actions)
  const c = coverage()
  expect(c.engineActions).toEqual(actions)
  expect(Object.keys(c.fixtures).sort()).toEqual(readdirSync(fixtures).filter(name => name !== 'coverage.json').sort())
  expect(Object.keys(c.fixtures)).toHaveLength(c.summary.traces)
  expect(c.summary.traces).toBe(276)
  expect(c.summary.controls).toHaveLength(39)
  expect(Object.keys(c.fixtures).filter(name => name.includes('memory_hold')).sort()).toEqual([
    'control_memory_hold-001.json',
    ...Array.from({ length: 8 }, (_, i) => `trace_memory_holds-${String(i + 1).padStart(3, '0')}.json`),
  ])
})

test('every frozen state replays AD/receipt decisions; recovery intents also tolerate disconnected MCP', async () => {
  const c = coverage()
  let states = 0, divergentReadings = 0, savedReadings = 0, expiredSteps = 0, mcpIndependentRecoveries = 0, recoveryEnters = 0
  let sameSessionResumes = 0, changedSessions = 0
  let heldStates = 0, withdrawnStates = 0, passedHolds = 0, releasedHolds = 0
  // Decode one envelope at a time to bound replay memory.
  for (const [name, hash] of Object.entries(c.fixtures)) {
    const envelope = decodeDeliveryFixture(join(fixtures, name), hash as string)
    const result = await replayDeliveryFixture(envelope)
    states += result.states; divergentReadings += result.divergentReadings; savedReadings += result.savedReadings; expiredSteps += result.expiredSteps
    mcpIndependentRecoveries += result.mcpIndependentRecoveries; recoveryEnters += result.recoveryEnters
    sameSessionResumes += result.sameSessionResumes; changedSessions += result.changedSessions
    heldStates += result.heldStates; withdrawnStates += result.withdrawnStates
    passedHolds += result.passedHolds; releasedHolds += result.releasedHolds
  }
  expect(states).toBe(c.summary.states)
  expect(divergentReadings).toBeGreaterThan(0)
  expect(savedReadings).toBeGreaterThan(0)
  expect(expiredSteps).toBeGreaterThan(0)
  expect(mcpIndependentRecoveries).toBeGreaterThan(0)
  expect(recoveryEnters).toBeGreaterThan(0)
  expect(sameSessionResumes).toBeGreaterThan(0)
  expect(changedSessions).toBeGreaterThan(0)
  expect(heldStates).toBeGreaterThan(0)
  expect(withdrawnStates).toBeGreaterThan(0)
  expect(passedHolds).toBeGreaterThan(0)
  expect(releasedHolds).toBeGreaterThan(0)
}, 180000)

test.each([
  ['FIFO', '.sort((a, b) => a - b)', '.sort((a, b) => b - a)', 'control_next_item-001.json'],
  ['Memory Hold', "k.holds?.some(hold => hold.item === item && hold.kind === 'memory')", 'false', 'trace_memory_holds-003.json'],
])('an isolated mutation of production %s selection is detected by the same local TLC replay', async (_, expression, replacement, name) => {
  const root = temporary(), path = join(root, 'mutant-policy.ts')
  const original = readFileSync(join(repo, 'src/delivery-policy.ts'), 'utf8')
  expect(original.split(expression)).toHaveLength(2)
  writeFileSync(path, original.replace(expression, replacement))
  const mutant = await import(path)
  const c = coverage()
  const envelope = decodeDeliveryFixture(join(fixtures, name), c.fixtures[name])
  await replayDeliveryFixture(envelope)
  await expect(replayDeliveryFixture(envelope, mutant)).rejects.toThrow('production choice/target mismatch')
  expect(readFileSync(join(repo, 'src/delivery-policy.ts'), 'utf8')).toBe(original)
})

test.each(['omitted holds', 'retained withdrawn items'] as const)('the same hold replay rejects production knowledge with %s', async fault => {
  const c = coverage(), name = 'trace_memory_holds-003.json'
  const envelope = decodeDeliveryFixture(join(fixtures, name), c.fixtures[name])
  await replayDeliveryFixture(envelope)
  // Corrupt only the input to real production functions. The frozen model
  // decisions and proof bytes stay untouched; no selection logic is copied.
  const knowledge = (k: DeliveryPolicyKnowledge): DeliveryPolicyKnowledge => {
    if (fault === 'omitted holds') {
      const { holds, ...withoutHolds } = k
      return withoutHolds
    }
    const withdrawn = (k.p as typeof k.p & { withdrawn: number[] }).withdrawn
    return { ...k, p: { ...k.p, accepted: [...new Set([...k.p.accepted, ...withdrawn])] } }
  }
  await expect(replayDeliveryFixture(envelope, {
    decideEngine: k => decideEngine(knowledge(k)),
    decideGate: k => decideGate(knowledge(k)),
    selectDeliveryTarget: k => selectDeliveryTarget(knowledge(k)),
  })).rejects.toThrow('production choice/target mismatch')
})
