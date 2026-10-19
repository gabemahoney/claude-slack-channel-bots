import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBusyProof, BUSY_PROOF_WAIT_MS, emitBusyProofFailure, pollBusyProof, type BusyProofSnapshot } from './integration/fixtures/busy-proof.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'
import { retainFailureLine } from './real-agent/ai-failure-diagnostics.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'

const path = '/isolated/session.jsonl'
const record = (offset: number, at: number, value: any): TranscriptEntry => ({ path, offset, at, value, kind: 'other' })
function snapshot(complete: boolean, body = 'private body'): BusyProofSnapshot {
  const own = [
    record(10, 100, { type: 'assistant', uuid: 'tool-use', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'sleep-id', input: { command: 'sleep 20' } }] } }),
    record(20, 400, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sleep-id', content: body }] } }),
    { ...record(30, 450, { type: 'attachment', attachment: { type: 'queued_command', prompt: body } }), kind: 'take-in', text: body },
  ]
  if (complete) own.push(record(40, 500, { type: 'assistant', uuid: 'completion', message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: body }] } }))
  return { selected: { path, offset: 10, uuid: 'tool-use', id: 'sleep-id', command: 'sleep 20', at: 100, observed_at: 150 },
    journal: [{ kind: 'accepted', seq: 2, source: 'slack', received_at: 200 }, { kind: 'fixed', seq: 2, parts: [body] }], own }
}
const prove = (value: BusyProofSnapshot) => assertBusyProof(value, 2, () => ({ duplicates: 0 }), (actual, expected) => actual === expected)
function fakeClock() {
  let elapsed = 0
  return { now: () => elapsed, wallNow: () => 1_000_000 + elapsed,
    sleep: async (ms: number) => { elapsed += ms }, advance: (ms: number) => { elapsed += ms } }
}

test('busy proof waits for the actual late terminal record without weakening the predicate', async () => {
  const clock = fakeClock(), observations: number[] = [], failures: unknown[] = []
  expect(() => prove(snapshot(false))).toThrow('completed tool turn evidence missing')
  const result = await pollBusyProof(async () => {
    observations.push(clock.now())
    return snapshot(clock.now() >= 500)
  }, prove, (...args) => { failures.push(args) }, clock)
  expect(result).toMatchObject({ tool_use_id: 'sleep-id', turn: 'same', tool_result_at: 400, taken_in_at: 450 })
  expect(observations).toEqual([0, 100, 200, 300, 400, 500])
  expect(failures).toEqual([])
})

test('a terminal record that never arrives fails at 180 s and retains the exact final assertion snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'busy-proof-evidence-'))
  try {
    const clock = fakeClock(), secret = fakeToken('sk-'), output: string[] = []
    let reads = 0, finalSnapshot: BusyProofSnapshot | undefined
    await expect(pollBusyProof(async () => { reads++; return snapshot(false, 'PRIVATE ' + secret) }, prove,
      (value, timing, error) => {
        finalSnapshot = value
        emitBusyProofFailure(value, 2, timing, error, line => {
          output.push(line)
          retainFailureLine(directory, line, value => value)
        })
      }, clock)).rejects.toThrow('completed tool turn evidence missing')
    expect(clock.now()).toBe(BUSY_PROOF_WAIT_MS)
    expect(BUSY_PROOF_WAIT_MS).toBe(180_000)
    expect(reads).toBe(1801)
    // A later record must not retroactively appear in the assertion snapshot.
    finalSnapshot!.own.push(snapshot(true).own.at(-1)!)
    const retained = readFileSync(join(directory, 'real-agent-failures.jsonl'), 'utf8')
    const records = retained.trim().split('\n').map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({ phase: 'busy-proof-assertion', records: 3, attempts: 1801,
      startedAt: 1_000_000, observedAt: 1_180_000, boundMs: 180_000, snapshotAvailable: true,
      selected: { id: 'sleep-id', at: 100, observed_at: 150 }, acceptedAt: 200 })
    expect(records.slice(1).map(row => row.record.offset)).toEqual([10, 20, 30])
    expect(retained).not.toContain('completion')
    expect(retained).not.toContain('PRIVATE')
    expect(retained).not.toContain(secret)
    assertNoLeak({ records, retained, output })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test.each([0, 1])('completion at the deadline plus %s ms obeys the existing bound', async extra => {
  const clock = fakeClock(), failures: unknown[] = []
  const result = pollBusyProof(async () => {
    if (clock.now() === BUSY_PROOF_WAIT_MS) clock.advance(extra)
    return snapshot(clock.now() >= BUSY_PROOF_WAIT_MS)
  }, prove, (...args) => { failures.push(args) }, clock)
  if (extra === 0) {
    expect(await result).toMatchObject({ turn: 'same' })
    expect(failures).toEqual([])
  } else {
    await expect(result).rejects.toThrow('after the 180 s bound')
    expect(failures).toHaveLength(1)
  }
})

test('polling does not accept an earlier terminal record or an unrelated tool result', async () => {
  for (const mutation of ['earlier', 'unrelated']) {
    const clock = fakeClock()
    await expect(pollBusyProof(async () => {
      const value = snapshot(true)
      if (mutation === 'earlier') value.own.at(-1)!.at = 300
      else value.own[1]!.value.message.content[0].tool_use_id = 'other-tool'
      return value
    }, prove, () => {}, clock)).rejects.toThrow(mutation === 'earlier' ? 'completed tool turn evidence missing' : 'no unique matching result')
    expect(clock.now()).toBe(BUSY_PROOF_WAIT_MS)
  }
})
