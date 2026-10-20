/** E3's adapter for the frozen E1 trace map (b.omv SR-1.2/15.6).
 * This translates observations only; all choices and head selection are the
 * production exports. No model decision implementation lives in the tests. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decideEngine, decideGate, selectDeliveryTarget, LAUNCH_SETTLE_MS, ENTER_DELAY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS, NOT_NOW_RETRY_MS, type DeliveryPolicyKnowledge, type DeliveryReading, type DeliveryPair } from '../../src/delivery-engine.ts'
import { parseDeliveryTranscriptRecord, receiptTextMatches } from '../../src/delivery-receipt.ts'
import { TAG_MAX_BYTES } from '../../src/tag-wrapper.ts'
import { createFakeClock } from './fake-clock.ts'
import { promptEntry, queuedCommandEntry, queueOperationEntry, pastedText } from './working-row-panes.ts'

export const traceTimerConstants = { LAUNCH_SETTLE_MS, ENTER_DELAY_MS, RECEIPT_WAIT_MS, RETYPE_BACKOFF_MS: [...RETYPE_BACKOFF_MS], NOT_NOW_RETRY_MS: [...NOT_NOW_RETRY_MS], TAG_MAX_BYTES }
export function decodeDeliveryFixture(path: string, hash: string): any {
  const bytes = readFileSync(path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `changed frozen fixture ${path}`)
  const stored = JSON.parse(bytes.toString('utf8'))
  if (!stored.fixtureContainer) return stored
  const container = stored.fixtureContainer
  assert.equal(container.codec, 'gzip-base64-json')
  const plain = Bun.gunzipSync(Buffer.from(container.data, 'base64'))
  assert.equal(plain.byteLength, container.bytes)
  assert.equal(createHash('sha256').update(plain).digest('hex'), container.sha256)
  const envelopes = JSON.parse(Buffer.from(plain).toString('utf8'))
  assert.equal(envelopes.length, 1)
  return envelopes[0]
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function textFor(constants: any, pair: DeliveryPair): string {
  const actual = constants.IdenticalTexts && pair[0] === 2 && pair[1] === 1 ? [1, 1] : pair
  return `<channel source="slack-channel-router" user="sender" ts="${actual[0]}.000000" part="${actual[1]}">body\n${actual.join(':')}</channel>`
}
function reading(raw: any, constants: any): DeliveryReading {
  // AD observations are the readiness contract. Never render or parse a pane,
  // and never derive idle/busy from transcript contents.
  assert(!('screen' in raw) && !('box' in raw), 'native UI leaked into AD observations')
  const records = raw.records.map((record: any, n: number) => {
    const text = textFor(constants, record.text)
    let entry
    if (record.kind === 'take-in') {
      entry = n % 2 ? queuedCommandEntry(pastedText(text)) : promptEntry(text)
    } else {
      const [, operation, reason] = record.kind.split(':')
      entry = queueOperationEntry(operation, text, reason)
    }
    // Parse serialized concrete JSONL records, as the receipt reader does.
    const parsed = parseDeliveryTranscriptRecord('claude', JSON.parse(JSON.stringify(entry)))
    assert.equal(parsed.kind, record.kind === 'take-in' ? 'take-in' : 'other')
    if (parsed.kind === 'take-in') assert(receiptTextMatches(parsed.text ?? '', text), 'concrete transcript failed exact text matching')
    return { kind: parsed.kind, text }
  })
  // A queue-is-receipt control deliberately advertises an enqueue here. Keep
  // that frozen observation: the production policy must reject its kind.
  for (const n of raw.receipts) assert(Number.isInteger(n) && records[n - 1], 'receipt index outside the concrete transcript')
  return { ...structuredClone(raw), records }
}
function duration(name: string, constants: any, engine: any): number {
  const item = engine.target[0]
  const n = item ? engine.retypes[item - 1] ?? 0 : 0
  return ({ settle: LAUNCH_SETTLE_MS, receipt: RECEIPT_WAIT_MS,
    backoff: RETYPE_BACKOFF_MS[Math.min(n, RETYPE_BACKOFF_MS.length - 1)],
    enterDelay: ENTER_DELAY_MS,
    notNow: NOT_NOW_RETRY_MS[0], reconnect: NOT_NOW_RETRY_MS[0] } as Record<string, number>)[name]!
}
export function renderDeliveryKnowledge(raw: any, constants: any): DeliveryPolicyKnowledge {
  const copy = structuredClone(raw)
  const e = { ...copy.e, retypes: Object.fromEntries(copy.e.retypes.map((n: number, i: number) => [i + 1, n])),
    timers: Object.fromEntries(Object.entries(copy.e.timers).map(([name, value]) => [name, value ? duration(name, constants, copy.e) : 0])),
    keyReading: reading(copy.e.keyReading, constants) }
  return freeze({ ...copy, ...constants, e, r: reading(copy.r, constants),
    g: { ...copy.g, ...(copy.g.reading ? { reading: reading(copy.g.reading, constants) } : {}) },
    textFor: (pair: DeliveryPair) => textFor(constants, pair) }) as DeliveryPolicyKnowledge
}
export async function replayDeliveryFixture(envelope: any, choices = { decideEngine, decideGate, selectDeliveryTarget }) {
  const metadata = envelope.behaviorMetadata, rows = envelope[metadata.replayField].behavior
  const clock = createFakeClock({ flushTurns: 0 })
  let divergentReadings = 0, savedReadings = 0, expiredSteps = 0, mcpIndependentRecoveries = 0, recoveryEnters = 0
  const outputs: unknown[][] = []
  for (const [index, record] of rows.entries()) {
    const where = `${envelope.cfg}:${index + 1}`
    assert.deepEqual(record.timerConstants, traceTimerConstants, `${where}: timing constants differ`)
    const k = renderDeliveryKnowledge(record.knowledge, record.constants)
    const gate = renderDeliveryKnowledge(record.gateKnowledge, record.constants)
    const before = JSON.stringify([k, gate]), at = clock.now()
    // Abstract positive timers become concrete remaining durations. Time moves
    // only for the explicitly executed timer-expiry edge, never for I/O,
    // observations, choices, faults or unrelated environmental transitions.
    if (record.executedAction === 'expireTimers') {
      const expired = record.expiredTimers.map((name: string) => duration(name, record.constants, record.knowledge.e))
      if (expired.length) { await clock.advance(Math.max(...expired)); expiredSteps++ }
    } else assert.equal(clock.now(), at)
    const actual = [choices.decideEngine(k), choices.decideGate(gate), choices.selectDeliveryTarget(k)]
    const control = record.control.class !== 'correct'
    const expected = control ? [record.correctEngineChoice, record.correctGateChoice, record.correctSelectedTarget]
      : [record.EngineChoice, record.GateChoice, record.selectedTarget]
    assert.deepEqual(actual, expected, `${where}: production choice/target mismatch`)
    if (actual[0] === 'recordRecoveryEnter') {
      // Separate from the unchanged frozen-state replay above: contrast one
      // input to prove a durable recovery intent does not depend on MCP.
      const disconnected = structuredClone(record.knowledge)
      disconnected.r.mcp = false
      assert.equal(choices.decideEngine(renderDeliveryKnowledge(disconnected, record.constants)), 'recordRecoveryEnter', `${where}: recovery Enter depends on MCP`)
      mcpIndependentRecoveries++
    }
    if (actual[0] === 'pressEnter' && k.e.phase === 'recovery-enter') recoveryEnters++
    assert.equal(JSON.stringify([k, gate]), before, `${where}: production mutated frozen knowledge`)
    outputs.push(actual)
    if (JSON.stringify(record.knowledge.r) !== JSON.stringify(record.gateKnowledge.r)) divergentReadings++
    if (JSON.stringify(record.knowledge.e.keyReading) !== JSON.stringify(record.knowledge.r)) savedReadings++
  }
  // Finite choice controls must expose the actually executed divergent edge;
  // temporal omissions/fairness/scheduling use their separately validated
  // complete cycle evidence, never an invented pure-choice requirement.
  for (const position of metadata.bugSteps) {
    const before = rows[position - 1], actual = outputs[position - 1]
    assert.notDeepEqual(actual, [before.EngineChoice, before.GateChoice, before.selectedTarget], `${envelope.cfg}:${position}: ineffective choice control`)
  }
  return { states: rows.length, divergentReadings, savedReadings, expiredSteps, mcpIndependentRecoveries, recoveryEnters, elapsed: clock.now() }
}
