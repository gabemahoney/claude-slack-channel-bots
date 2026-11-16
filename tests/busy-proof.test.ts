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

function nextTurnSnapshot(): BusyProofSnapshot {
  const value = snapshot(true)
  value.own[2]!.offset = 70
  value.own[2]!.at = 700
  value.own.push(record(60, 600, { type: 'assistant', message: { id: 'retry', stop_reason: 'end_turn', content: [{ type: 'text', text: 'visible answer' }] } }))
  return value
}

test.each([undefined, true])('thinking-only terminal and native meta nudge are one turn (turnCompanion=%s)', companion => {
  const value = nextTurnSnapshot()
  value.own[3]!.value.message.content = [{ type: 'thinking' }]
  // The retained failure projection omits turnCompanion and withholds user text.
  value.own.push(record(50, 550, { type: 'user', isMeta: true, ...(companion === undefined ? {} : { turnCompanion: companion }), message: { content: '<text withheld>' } }))
  expect(prove(value)).toMatchObject({ turn: 'next', taken_in_at: 700 })
})

test('two real native turns before the take-in still fail', () => {
  expect(() => prove(nextTurnSnapshot())).toThrow('later than the next turn')
})

test('a late take-in after a retried turn and another real turn still fails', () => {
  const value = nextTurnSnapshot()
  value.own[3]!.value.message.content = [{ type: 'thinking' }]
  value.own.push(record(50, 550, { type: 'user', isMeta: true, message: { content: '<text withheld>' } }),
    record(65, 650, { type: 'assistant', message: { id: 'another-turn', stop_reason: 'end_turn', content: [{ type: 'text', text: 'another answer' }] } }))
  expect(() => prove(value)).toThrow('later than the next turn')
})

test.each([
  { name: 'exhausted retry followed by unmarked enforcement', companions: [true, undefined] },
  { name: 'chained explicit companions', companions: [true, true, true] },
  { name: 'chained old-projection companions', companions: [undefined, undefined, undefined] },
])('does not merge $name into one native turn', ({ companions }) => {
  const value = snapshot(false)
  value.own[2]!.offset = 1000
  value.own[2]!.at = 1000
  for (let i = 0; i <= companions.length; i++) {
    value.own.push(record(40 + i * 20, 500 + i * 100, { type: 'assistant', message: {
      id: `terminal-${i}`, stop_reason: 'end_turn',
      content: [i === companions.length ? { type: 'text', text: 'visible answer' } : { type: 'thinking' }],
    } }))
    if (i < companions.length) value.own.push(record(50 + i * 20, 550 + i * 100, {
      type: 'user', isMeta: true, ...(companions[i] === undefined ? {} : { turnCompanion: companions[i] }),
      message: { content: '<text withheld>' },
    }))
  }
  // The first retry may be grouped once. Its exhausted response cannot start another merge,
  // including when a later stop_hook_blocking enforcement emits no stop_hook_summary.
  expect(() => prove(value)).toThrow('later than the next turn')
})

test('requires a companion marker when the transcript retains companion metadata', () => {
  const value = nextTurnSnapshot()
  value.own[3]!.value.message.content = [{ type: 'thinking' }]
  value.own.push(record(25, 425, { type: 'user', isMeta: true, turnCompanion: true }),
    record(50, 550, { type: 'user', isMeta: true, message: { content: '<text withheld>' } }))
  expect(() => prove(value)).toThrow('later than the next turn')
})

test('an exhausted thinking-only retry alone still counts as one native turn', () => {
  const value = nextTurnSnapshot()
  for (const entry of value.own.filter(e => e.value?.type === 'assistant' && e.offset > 20)) {
    entry.value.message.content = [{ type: 'thinking' }]
  }
  value.own.push(record(50, 550, { type: 'user', isMeta: true, turnCompanion: true, message: { content: '<text withheld>' } }))
  expect(prove(value)).toMatchObject({ turn: 'next' })
})

test.each(['no nudge', 'ordinary user', 'human origin', 'not a companion', 'tool result', 'api error',
  'visible streaming copy', 'stop hook boundary', 'turn duration boundary', 'foreign nudge'])('does not merge two turns with %s', mutation => {
  const value = nextTurnSnapshot(), first = value.own[3]!
  first.value.message.content = [{ type: 'thinking' }]
  const nudge = record(50, 550, { type: 'user', isMeta: true, message: { content: '<text withheld>' } })
  value.own.push(nudge)
  if (mutation === 'no nudge') value.own.pop()
  if (mutation === 'ordinary user') nudge.value.isMeta = false
  if (mutation === 'human origin') nudge.value.origin = { kind: 'human' }
  if (mutation === 'not a companion') nudge.value.turnCompanion = false
  if (mutation === 'tool result') nudge.value.message.content = [{ type: 'tool_result', tool_use_id: 'other-tool' }]
  if (mutation === 'api error') first.value.isApiErrorMessage = true
  if (mutation === 'visible streaming copy') value.own.push(record(45, 510, { type: 'assistant',
    message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'visible completion' }] } }))
  if (mutation === 'stop hook boundary' || mutation === 'turn duration boundary') value.own.push(record(45, 510,
    { type: 'system', subtype: mutation === 'stop hook boundary' ? 'stop_hook_summary' : 'turn_duration' }))
  if (mutation === 'foreign nudge') nudge.path = '/foreign/session.jsonl'
  expect(() => prove(value)).toThrow('later than the next turn')
})

test('a malformed-tool-use retry adds no terminal boundary', () => {
  const value = nextTurnSnapshot()
  value.own[3]!.value.message.stop_reason = 'tool_use'
  value.own.push(record(50, 550, { type: 'user', isMeta: true, turnCompanion: true, message: { content: '<text withheld>' } }))
  expect(prove(value)).toMatchObject({ turn: 'next' })
})

test('retry grouping preserves the first terminal offset and all terminal timestamps', () => {
  const value = nextTurnSnapshot()
  value.own[3]!.value.message.content = [{ type: 'thinking' }]
  value.own.push(record(50, 550, { type: 'user', isMeta: true, message: { content: '<text withheld>' } }))
  // A take-in between the nudge and retry still follows the first terminal.
  value.own[2]!.offset = 55
  value.own[2]!.at = 575
  expect(prove(value)).toMatchObject({ turn: 'next' })
  value.own[2]!.offset = 70
  // Even when grouped, a retry recorded before the take-in cannot be timestamped after it.
  expect(() => prove(value)).toThrow('later than the next turn')
})

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
