import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureDifference, readbackMismatch } from './real-agent/ai-mismatch-diagnostics.ts'
import { AI_FAILURE_PREFIX, retainFailureLine, scrubDiagnosticText } from './real-agent/ai-failure-diagnostics.ts'
import { fakeToken } from './test-helpers/credentials.ts'

const expected = { case: 'AC15', messages: 1, body: 'amber birch cedar' }
const digest = (s: string) => createHash('sha256').update(s).digest('hex')

test.each([
  ['amber birch cedar', 'equal', null],
  ['amber  birch cedar', 'whitespace-only', 6],
  ['amber birch', 'truncation', 11],
  ['amber cedar birch cedar', 'insertion', 6],
  ['amber cedar', 'deletion', 6],
  ['amber cedar cedar', 'substitution', 6],
] as const)('classifies %s without changing text', (actual, difference, offset) => {
  const record = readbackMismatch(expected, JSON.stringify({ ...expected, body: actual }))
  expect(record).toMatchObject({ parsedJSON: true, keys: ['body', 'case', 'messages'], replyKind: 'readback',
    expectedLength: 17, actualLength: actual.length, firstDifferenceOffset: offset, difference,
    expectedSha256: digest(expected.body), actualSha256: digest(actual) })
  expect(record.expectedExcerpt.length).toBeLessThanOrEqual(80)
  expect(record.actualExcerpt.length).toBeLessThanOrEqual(80)
})

test('distinguishes acknowledgement-only, malformed JSON and no response', () => {
  expect(readbackMismatch(expected, '{"status":"received"}')).toMatchObject({ parsedJSON: true,
    keys: ['status'], bodyPresent: false, replyKind: 'missing-body', actualLength: 0, mismatchedKeys: ['case', 'messages', 'body'] })
  expect(readbackMismatch(expected, 'amber {')).toMatchObject({ parsedJSON: false, replyKind: 'invalid-json', responseLength: 7 })
  expect(readbackMismatch(expected, undefined)).toMatchObject({ parsedJSON: false, replyKind: 'missing-response', responsePresent: false })
  expect(readbackMismatch(expected, 'null')).toMatchObject({ parsedJSON: true, keys: [], replyKind: 'non-object-json' })
})

test('reports field mismatches even when the decoded body is exact', () => {
  expect(readbackMismatch(expected, JSON.stringify({ ...expected, messages: 3 }))).toMatchObject({
    difference: 'equal', mismatchedKeys: ['messages'], firstDifferenceOffset: null,
  })
})

test('diagnostic parsing agrees on key order, outer newline, fences and JSON escaping', () => {
  const response = '\n```json\n{"messages":1,"body":"amber birch ced\\u0061r","case":"AC15"}\n```\n'
  expect(readbackMismatch(expected, response)).toMatchObject({ parsedJSON: true, difference: 'equal', mismatchedKeys: [] })
})

test('only fixture-derived whole tokens survive an excerpt boundary', () => {
  const body = 'amber birch cedar '.repeat(20), actual = body.slice(0, 150) + 'PRIVATEamber' + body.slice(150)
  const record = fixtureDifference(body, actual)
  expect(record.firstDifferenceOffset).toBe(150)
  expect(record.excerptStart).toBe(110)
  expect(record.actualExcerpt.length).toBe(80)
  expect(record.actualExcerpt).not.toContain('PRIVATE')
  expect(record.actualExcerpt).toContain('•'.repeat(12))
  expect(record.expectedSha256).toBe(digest(body))
})

test('scrubs known and recognizable secrets before excerpt slicing and again at retention', () => {
  const token = fakeToken('sk-'), secret = 'amber birch', fixture = 'amber birch cedar '.repeat(20)
  const record = fixtureDifference(fixture, fixture.slice(0, 100) + token + fixture.slice(100), { API_KEY: secret })
  expect(record.expectedExcerpt).toBe('<secret-bearing text withheld>')
  expect(record.actualExcerpt).toBe('<secret-bearing text withheld>')
  const unknownKey = fakeToken('xoxb-')
  const mismatch = readbackMismatch(expected, JSON.stringify({ ...expected, [unknownKey]: token, body: 'amber PRIVATE cedar' }))
  const root = mkdtempSync(join(tmpdir(), 'ai-mismatch-'))
  try {
    retainFailureLine(root, AI_FAILURE_PREFIX + JSON.stringify({ event: 'readback-mismatch', record: mismatch }),
      text => scrubDiagnosticText(text, { SECRET: 'cedar' }))
    const path = join(root, 'real-agent-failures.jsonl'), text = readFileSync(path, 'utf8')
    for (const forbidden of [unknownKey, token, 'PRIVATE', 'cedar']) expect(text).not.toContain(forbidden)
    expect(text).toContain('[REDACTED]')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
