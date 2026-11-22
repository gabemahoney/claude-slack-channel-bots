import { expect, test } from 'bun:test'
import { sharedAttemptMap, withSharedAttempt, sharedAttemptEncoding, sharedAttemptBytes } from '../src/shared-attempt-map.ts'
import type { SharedBotAttempt } from '../src/channel-delivery-attempt.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

function pending(i: number): Extract<SharedBotAttempt, { status: 'pending' }> {
  return Object.freeze({ key: 'alpha', incarnation: 'life', identifierHash: i.toString(16).padStart(64, '0'),
    channel: 'C123', delivery: 'mentions', startedOrder: i + 2, status: 'pending' })
}

test('retained dictionary revisions export every record and reuse exact JSON across insertions and replacements', () => {
  let records = sharedAttemptMap({})
  const expected: Record<string, SharedBotAttempt> = {}
  // Alternating ends and then descending inserts exercise compressed-prefix splits and branching.
  for (const i of [...Array.from({ length: 100 }, (_, i) => i * 2), ...Array.from({ length: 100 }, (_, i) => 199 - i * 2)]) {
    const record = pending(i), id = record.identifierHash
    expected[id] = record
    records = withSharedAttempt(records, id, record)
  }
  const before = records, bytes = sharedAttemptEncoding(before, 2)
  const old = pending(50), resolved: SharedBotAttempt = Object.freeze({ ...old, status: 'not-applied', resolvedOrder: 1000, reason: 'membership' })
  records = withSharedAttempt(records, old.identifierHash, resolved)
  expected[old.identifierHash] = resolved
  expect(records[old.identifierHash]).toEqual(resolved)
  expect(before[old.identifierHash]).toEqual(old)
  expect(sharedAttemptEncoding(before, 2)).toBe(bytes)
  expect(JSON.parse(JSON.stringify(records))).toEqual(expected)
  expect(Object.keys(records)).toHaveLength(200)
  for (const view of [before, records]) {
    expect(sharedAttemptEncoding(view, 2)).toBe(JSON.stringify(view, null, 2).replaceAll('\n', '\n    '))
    expect(sharedAttemptBytes(view, 2)).toEqual(Buffer.from(sharedAttemptEncoding(view, 2)!))
    expect(sharedAttemptBytes(view, 2)).toBe(sharedAttemptBytes(view, 2))
    const envelope = `{"outcomes":{"botAttempts":${sharedAttemptEncoding(view, 2)}}}`
    expect(JSON.parse(envelope).outcomes.botAttempts).toEqual(JSON.parse(JSON.stringify(view)))
    assertNoLeak({ view, bytes: sharedAttemptBytes(view, 2)?.toString('utf8') })
  }
})

test('the facade refuses mutation and preserves ordinary object read behavior', () => {
  const record = pending(1), records = sharedAttemptMap({ [record.identifierHash]: record })
  expect(() => { records[record.identifierHash] = pending(2) }).toThrow(TypeError)
  expect(() => { delete records[record.identifierHash] }).toThrow(TypeError)
  expect(() => Object.defineProperty(records, 'extra', { value: record })).toThrow(TypeError)
  expect(() => Object.setPrototypeOf(records, null)).toThrow(TypeError)
  expect(Object.hasOwn(records, record.identifierHash)).toBe(true)
  expect(Object.hasOwn(records, 'toString')).toBe(false)
  expect(typeof records.toString).toBe('function')
  expect(sharedAttemptEncoding(sharedAttemptMap({}), 2)).toBe('{}')
  expect(sharedAttemptEncoding({}, 2)).toBeUndefined()
  assertNoLeak({ records, bytes: sharedAttemptBytes(records, 2)?.toString('utf8') })
})

test('cached UTF-8 revisions preserve exact bytes across inserts and replacements at every dictionary position', () => {
  let records = sharedAttemptMap({})
  const ids = [4, 1, 15, 0, 2, 16, 255, 254, 4095, 17, 3, 5]
  for (const i of ids.concat([...ids].reverse())) {
    const before = sharedAttemptBytes(records, 2)!, retained = before.toString('utf8')
    const original = { ...pending(i), incarnation: 'life-😀' }
    const record: SharedBotAttempt = records[original.identifierHash]
      ? Object.freeze({ ...original, status: 'not-applied', resolvedOrder: 10000, reason: 'membership' }) : Object.freeze(original)
    records = withSharedAttempt(records, record.identifierHash, record)
    const bytes = sharedAttemptBytes(records, 2)!
    expect(bytes.toString('utf8')).toBe(JSON.stringify(records, null, 2).replaceAll('\n', '\n    '))
    expect(before.toString('utf8')).toBe(retained)
    assertNoLeak({ bytes: bytes.toString('utf8') })
  }
})
