/** Full certified runtime decision replay (b.omv SR-15.6). The E1 verdict
 * suite owns provenance boundary permutations; this composes its validator
 * and the frozen contract's complete graph and class sensitivity checks. */
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

test('certified inputs, all complete paths and temporal cycles retain class-specific sensitivity and executed coverage', () => {
  const root = temporary(), home = join(root, 'home'); mkdirSync(home)
  const body = String.raw`
record = readonly(lambda: portable_certificate(SOURCE))
rows = {row["cfg"]: row for row in runner.load_manifest(SOURCE, False)}
summary = {"traces": 0, "states": 0, "controls": set(), "actions": set(), "faults": set(), "flaps": set()}
inventory = record["trace_evidence"]["fixtures"]
for name, checksum in sorted(inventory.items()):
    cfg = name.rsplit("-", 1)[0]
    row = rows[cfg]
    stored = runner.read_json(SOURCE.parents[1] / "tests/fixtures/delivery-traces" / name)
    envelope = contract.rehydrate_fixture(stored)
    behavior, metadata = validate_committed_envelope(record, row, envelope)
    if runner.reduced_cfg(row):
        contract.validate_restart_mutation_behavior(row, behavior)
    bugs = contract.executed_bug_steps(row, behavior, companion=cfg in runner.RESTART_MUTATIONS)
    assert envelope["behaviorMetadata"] == {**metadata, "bugSteps": bugs}, cfg + ": altered replay/control metadata"
    if cfg in runner.ALL_CONTROLS:
        summary["controls"].add(cfg)
        if not row["properties"] and metadata["controlClass"] == "choice":
            assert bugs, cfg + ": no executed divergent transition"
    for before, after in zip(behavior, behavior[1:]):
        if before["state"] == after["state"]:
            continue
        if after["control"]["class"] == "correct" and after["executedAction"] in record["trace_evidence"]["engineActions"]:
            summary["actions"].add(after["executedAction"])
        if after["transition"] in record["trace_evidence"]["flappingActions"]:
            summary["flaps"].add(after["transition"])
        for fault in record["trace_evidence"]["boundedFaults"]:
            delta = after["state"]["faults"][fault] - before["state"]["faults"][fault]
            assert delta in (0, 1), cfg + ": invalid fault edge"
            if delta:
                summary["faults"].add(fault)
    summary["traces"] += 1
    summary["states"] += len(behavior)
for actual, expected in (("actions", "engineActions"), ("faults", "boundedFaults"), ("flaps", "flappingActions"), ("controls", "controls")):
    assert sorted(summary[actual]) == record["trace_evidence"][expected], "lost executed coverage: " + actual
    summary[actual] = len(summary[actual])
print(json.dumps(summary))
`
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', `${deliveryEvidencePython}\n${body}`, repo, root], {
    cwd: repo, env: hostSafeChildEnv(home, { tools: [], extras: { TMPDIR: root, SLACK_STATE_DIR: join(home, 'state') } }),
    encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024,
  })
  expect({ status: result.status, signal: result.signal, error: result.error?.message, diagnostic: result.status === 0 ? '' : result.stderr + result.stdout }).toEqual({ status: 0, signal: null, error: undefined, diagnostic: '' })
  expect(JSON.parse(result.stdout)).toEqual({ traces: 300, states: 54473, controls: 38, actions: 21, faults: 26, flaps: 4 })
}, 600000)

test('ENGINE_ACTIONS equals the frozen TLA source vocabulary and fixture inventory', () => {
  const source = readFileSync(join(repo, 'spec/tla/PersonaDelivery.tla'), 'utf8')
  const set = /EngineActions\s*==\s*\{([^}]+)\}/.exec(source)![1]!
  const actions = [...set.matchAll(/"([^"]+)"/g)].map(m => m[1]!).sort()
  expect([...ENGINE_ACTIONS].sort() as string[]).toEqual(actions)
  const c = coverage()
  expect(c.engineActions).toEqual(actions)
  expect(Object.keys(c.fixtures).sort()).toEqual(readdirSync(fixtures).filter(name => name !== 'coverage.json').sort())
  expect(Object.keys(c.fixtures)).toHaveLength(300)
})

test('every state of all 300 certified traces chooses through production screen/receipt adapters and separate frozen engine/gate readings', async () => {
  const c = coverage()
  let states = 0, divergentReadings = 0, savedScreens = 0, expiredSteps = 0
  // One envelope at a time: the complete expanded corpus is over 1 GiB.
  for (const [name, hash] of Object.entries(c.fixtures)) {
    const envelope = decodeDeliveryFixture(join(fixtures, name), hash as string)
    const result = await replayDeliveryFixture(envelope)
    states += result.states; divergentReadings += result.divergentReadings; savedScreens += result.savedScreens; expiredSteps += result.expiredSteps
  }
  expect(states).toBe(54473)
  expect(divergentReadings).toBeGreaterThan(0)
  expect(savedScreens).toBeGreaterThan(0)
  expect(expiredSteps).toBeGreaterThan(0)
}, 180000)

test('an isolated mutation of production FIFO selection is detected by the same certified replay', async () => {
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
