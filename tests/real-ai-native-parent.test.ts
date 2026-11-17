import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseDeliveryTranscriptRecord, receiptTextMatches } from '../src/delivery-receipt.ts'
import { completedAIReadback } from './real-agent/ai-readback.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'

function capturedReadback(normal = false) {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/native-inverted-head/trial2.json', import.meta.url), 'utf8'))
  const own: TranscriptEntry[] = rows.map(({ offset, at, ...value }: any) => ({
    path: `/scenario/${value.sessionId}.jsonl`, offset, at,
    value: { ...value, timestamp: new Date(at).toISOString() }, ...parseDeliveryTranscriptRecord('claude', value),
  }))
  const head = own[0]!, receipt = own.find(e => e.kind === 'take-in')!
  const completion = own.at(-1)!
  const expected = JSON.parse(completion.value.message.content[0].text)
  if (normal) for (const entry of own) {
    if (entry.offset < 7372) entry.offset += 35407 - 7372
    else if (entry.offset < 35407) entry.offset -= 7372 - 271
  }
  const journal = [
    { kind: 'accepted', seq: 1, received_at: receipt.at - 5 },
    { kind: 'fixed', seq: 1, parts: [receipt.text] },
    { kind: 'sent', seq: 1, part: 1, at: receipt.at - 1, session_id: receipt.value.sessionId,
      transcript_path: receipt.path, transcript_size: 0 },
    { kind: 'delivered', seq: 1, part: 1, at: receipt.at + 1, receipt: { path: receipt.path, uuid: receipt.uuid } },
  ]
  return { seq: 1, expected, journal, own, model: completion.value.message.model,
    adapters: { parseDeliveryTranscriptRecord, receiptTextMatches }, head, receipt }
}

test.each([['inverted', false], ['normal', true]] as const)('captured AC11 %s attachment layout passes', (_layout, normal) => {
  const e = capturedReadback(normal)
  expect(completedAIReadback(e)).toEqual({ seq: 1, part: 1, receipt_uuid: e.receipt.uuid,
    session_id: e.receipt.value.sessionId, actual_model: e.model })
})

test.each([
  ['head stamped 1 ms before receipt', (e: ReturnType<typeof capturedReadback>) => { e.head.at = e.receipt.at - 1 }],
  ['untimed head', (e: ReturnType<typeof capturedReadback>) => { e.head.at = NaN }],
  ['forward-linked assistant', (e: ReturnType<typeof capturedReadback>) => { e.head.value.type = 'assistant' }],
  ['forward-linked user', (e: ReturnType<typeof capturedReadback>) => { e.head.value.type = 'user' }],
  ['forward-linked tool result', (e: ReturnType<typeof capturedReadback>) => {
    e.head.value.type = 'user'; e.head.value.message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool' }] }
  }],
  ['forward-linked system', (e: ReturnType<typeof capturedReadback>) => { e.head.value.type = 'system' }],
  ['queued take-in head', (e: ReturnType<typeof capturedReadback>) => {
    e.head.value.attachment = { type: 'queued_command', prompt: 'other input' }
    Object.assign(e.head, parseDeliveryTranscriptRecord('claude', e.head.value))
    expect(e.head.kind).toBe('take-in')
  }],
  ['same-offset parent', (e: ReturnType<typeof capturedReadback>) => {
    e.head.offset = e.own.find(row => row.value.uuid === e.head.value.parentUuid)!.offset
  }],
  ['attachment cycle', (e: ReturnType<typeof capturedReadback>) => { e.head.value.parentUuid = e.own[1]!.value.uuid }],
  ['another take-in on the answer chain', (e: ReturnType<typeof capturedReadback>) => {
    const value = { type: 'user', uuid: 'intervening', parentUuid: e.head.value.parentUuid,
      sessionId: e.receipt.value.sessionId, message: { role: 'user', content: 'other input' } }
    e.own.push({ path: e.receipt.path, offset: e.receipt.offset - 1, at: e.receipt.at,
      value, ...parseDeliveryTranscriptRecord('claude', value) })
    e.head.value.parentUuid = value.uuid
  }],
] as const)('captured inverted chain rejects %s', (_name, mutate) => {
  const e = capturedReadback(); mutate(e)
  expect(() => completedAIReadback(e)).toThrow('AI readback has invalid native assistant response')
})
