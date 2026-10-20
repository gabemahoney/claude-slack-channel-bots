/** Local TLC runtime decision replay after the cardinal-rule model migration.
 * Local evidence keeps its own provenance; it is never a scheduler certificate. */
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_ACTIONS } from '../src/delivery-engine.ts'
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
  expect(JSON.parse(result.stdout)).toEqual({ traces: c.summary.traces, states: c.summary.states, controls: 38, actions: ENGINE_ACTIONS.length, faults: 26, flaps: 4 })
  expect(c.certification).toBe(false)
  expect(c.evidenceKind).toBe('local-tlc-replay')
  expect(c.report.inputsUnchanged).toBe(true)
  expect(c.report.rows).toHaveLength(76)
  expect(c.report.auxiliaryRows).toHaveLength(8)
  expect(Object.keys(c.auxiliaryEvidence)).toHaveLength(8)
  expect(Object.keys(c.supplementalEvidence)).toEqual(['supplemental_pullback-001.json'])
  expect(c.report.rows.some((row: any) => row.cfg === 'supplemental_pullback')).toBe(false)
  const checked = new Set(c.report.rows.filter((row: any) => row.mode === 'check' && row.expect === 'pass').flatMap((row: any) => row.checks))
  for (const invariant of ['NoDrop', 'InOrder', 'TranscriptFIFO', 'OneInFlight', 'DurableAccept', 'ReceiptBacked', 'NoDuplicateKey']) expect(checked.has(invariant)).toBe(true)
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
})

test('every frozen state replays AD/receipt decisions; recovery intents also tolerate disconnected MCP', async () => {
  const c = coverage()
  let states = 0, divergentReadings = 0, savedReadings = 0, expiredSteps = 0, mcpIndependentRecoveries = 0, recoveryEnters = 0
  // Decode one envelope at a time to bound replay memory.
  for (const [name, hash] of Object.entries(c.fixtures)) {
    const envelope = decodeDeliveryFixture(join(fixtures, name), hash as string)
    const result = await replayDeliveryFixture(envelope)
    states += result.states; divergentReadings += result.divergentReadings; savedReadings += result.savedReadings; expiredSteps += result.expiredSteps
    mcpIndependentRecoveries += result.mcpIndependentRecoveries; recoveryEnters += result.recoveryEnters
  }
  expect(states).toBe(c.summary.states)
  expect(divergentReadings).toBeGreaterThan(0)
  expect(savedReadings).toBeGreaterThan(0)
  expect(expiredSteps).toBeGreaterThan(0)
  expect(mcpIndependentRecoveries).toBeGreaterThan(0)
  expect(recoveryEnters).toBeGreaterThan(0)
}, 180000)

test('an isolated mutation of production FIFO selection is detected by the same local TLC replay', async () => {
  const root = temporary(), path = join(root, 'mutant-policy.ts')
  const original = readFileSync(join(repo, 'src/delivery-policy.ts'), 'utf8')
  const expression = '.sort((a, b) => a - b)'
  expect(original.includes(expression)).toBe(true)
  writeFileSync(path, original.replace(expression, '.sort((a, b) => b - a)'))
  const mutant = await import(path)
  const name = 'control_next_item-001.json', c = coverage()
  const envelope = decodeDeliveryFixture(join(fixtures, name), c.fixtures[name])
  await expect(replayDeliveryFixture(envelope, mutant)).rejects.toThrow('production choice/target mismatch')
})
