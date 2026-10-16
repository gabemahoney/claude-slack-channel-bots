/** b.omv SR-6.1–6.4/11: exact, offset-bounded, uncredited transcript evidence. */
import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryReceiptReader, DELIVERY_DROP_REASONS, deliveryTranscriptPath, parseDeliveryTranscriptRecord, receiptTextMatches } from '../src/delivery-receipt.ts'
import type { DeliveryAgent } from '../src/delivery-screen.ts'
import type { DeliveryQueue, QueueItem, SentRecord } from '../src/delivery-queue.ts'
import { injectedInput, makeQueue } from './test-helpers/delivery-queue.ts'
import { appendTranscript, codexPromptEntry, codexTurnEntry, endedTurn, pastedText, promptEntry, queuedCommandEntry, queueOperationEntry, replyEntry, toolResultEntry, transcriptJsonl, writeTranscript, type TranscriptEntry } from './test-helpers/working-row-panes.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(agent: DeliveryAgent = 'claude', text = 'one\ntwo') {
  const root = fs.mkdtempSync(join(tmpdir(), 'delivery-receipt-')), path = join(root, 'current.jsonl')
  const queue = await makeQueue(root)
  cleanups.push(async () => { await queue.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.writeFileSync(path, '')
  const reader = createDeliveryReceiptReader()
  let seq = 0
  async function accept() {
    const result = await queue.accept('alpha', injectedInput({ text }))
    if (result.status === 'failed') throw new Error('fixture acceptance failed')
    seq = result.seq
    await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [text] })
    return seq
  }
  await accept()
  const item = (): QueueItem => queue.items('alpha').find(i => i.accepted.seq === seq)!
  const row = { jsonl_path: path, transcript_status: 'present', session_id: 'current', cwd: root }
  async function send(offset = fs.statSync(path).size, sendPath = path) {
    const record: SentRecord = { v: 1, kind: 'sent', seq, part: 1, attempt: item().nextAttempt, send_kind: 'text', at: 1000, launch_id: 'launch', session_id: 'current', transcript_path: sendPath, transcript_size: offset }
    await queue.append('alpha', record)
    return record
  }
  const read = () => reader.read(agent, row, item(), 1, queue.items('alpha'))
  return { root, path, queue, row, reader, item, accept, send, read, text, append: (...entries: TranscriptEntry[]) => appendTranscript(path, entries) }
}

describe('exact matching and agent schema', () => {
  test.each([
    ['raw', 'a\nb', 'a\nb', true], ['meaningful LF', 'a\nb', 'ab', false],
    ['whole paste', pastedText('a\nb'), 'a\nb', true],
    ['mixed paste', `a\n\n${pastedText('b')}\n\nc`, 'abc', true],
    ['junction LF kept', `a\n\n${pastedText('b')}\n\nc`, 'a\nb\nc', true],
    ['two paste blocks', `a${pastedText('b', '1111')}c${pastedText('d', '2222')}`, 'abcd', true],
    ['spaces significant', ' a ', 'a', false], ['different id', '<pasted_content id="a">\nx\n</pasted_content id="b">', 'x', false],
    ['three optional LFs forbidden', `a\n\n\n${pastedText('b')}`, 'ab', false],
  ] as const)('%s', (_label, record, expected, matches) => expect(receiptTextMatches(record, expected)).toBe(matches))

  test.each([
    ['user string', promptEntry('x'), 'take-in', 'x'],
    ['user text blocks', { ...promptEntry(), message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_result', content: 'ignored' }, { type: 'text', text: 'b' }] } }, 'take-in', 'ab'],
    ['human origin', { ...promptEntry('x'), origin: { kind: 'human' } }, 'take-in', 'x'],
    ['queued command', queuedCommandEntry('x'), 'take-in', 'x'],
    ['queued human', queuedCommandEntry('x', { attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'human' } } }), 'take-in', 'x'],
    ['sidechain', { ...promptEntry('x'), isSidechain: true }, 'other', undefined],
    ['agent origin', { ...promptEntry('x'), origin: { kind: 'agent' } }, 'other', undefined],
    ['queued nonhuman', queuedCommandEntry('x', { attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'agent' } } }), 'other', undefined],
    ['queued sidechain', queuedCommandEntry('x', { isSidechain: true }), 'other', undefined],
    ['meta', { ...promptEntry('x'), isMeta: true }, 'other', undefined],
    ['tool result', toolResultEntry(), 'take-in', undefined],
    ['enqueue never receipt', queueOperationEntry('enqueue', 'x'), 'queue-operation:enqueue', 'x'],
    ['background delivery never receipt', queueOperationEntry('remove', 'x', 'delivered_to_agent'), 'queue-operation:remove:delivered_to_agent', 'x'],
  ] as const)('Claude %s', (_name, entry, kind, text) => {
    const actual = parseDeliveryTranscriptRecord('claude', entry)
    expect([actual.kind, actual.text]).toEqual([kind, text])
  })
  test('Codex accepts user input_text blocks only', () => {
    expect(parseDeliveryTranscriptRecord('codex', codexPromptEntry('x'))).toMatchObject({ kind: 'take-in', text: 'x' })
    expect(parseDeliveryTranscriptRecord('codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'ignored' }, { type: 'input_text', text: 'b' }] } })).toMatchObject({ kind: 'take-in', text: 'ab' })
    for (const entry of [promptEntry('x'), queueOperationEntry('enqueue', 'x'), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x' } }]) {
      expect(parseDeliveryTranscriptRecord('codex', entry).kind).toBe('other')
    }
  })
})

describe('receipt reader', () => {
  test.each(['claude', 'codex'] as const)('%s needs a post-send record; identical items need distinct identities', async agent => {
    const h = await fixture(agent), entry = agent === 'claude' ? promptEntry : codexPromptEntry
    h.append(entry(h.text))
    await h.send()
    expect(h.read().receipt).toBeUndefined()
    const receipt = entry(h.text)
    h.append(receipt)
    const first = h.read().receipt!
    expect(first).toBeDefined()
    await h.queue.append('alpha', { v: 1, kind: 'delivered', seq: h.item().accepted.seq, part: 1, at: 2000, receipt: { path: first.path, uuid: first.uuid, offset: first.offset } })
    await h.accept()
    await h.send(0)
    // Credit both earlier records to isolate the identity check from the window.
    const old = h.read().records[0]!
    await h.queue.append('alpha', { v: 1, kind: 'delivered', seq: 1, part: 1, at: 2000, receipt: { path: old.path, uuid: old.uuid, offset: old.offset } })
    expect(h.read().receipt).toBeUndefined()
    h.append(entry(h.text))
    expect(h.read().receipt?.offset).toBeGreaterThan(first.offset)
  })
  test('refused attempts cannot open the matching window', async () => {
    const h = await fixture()
    const refused = await h.send(0)
    await h.queue.append('alpha', { v: 1, kind: 'refused', seq: 1, attempt: refused.attempt, at: 1500 })
    h.append(promptEntry(h.text))
    expect(h.read().receipt).toBeUndefined()
    await h.send()
    expect(h.read().receipt).toBeUndefined()
    h.append(queuedCommandEntry(h.text))
    expect(h.read().receipt).toBeDefined()
  })
  test.each([...DELIVERY_DROP_REASONS.map(reason => ['remove', reason] as const), ['popOne', undefined], ['popAll', undefined]] as const)('%s %s is negative evidence, never a receipt', async (operation, reason) => {
    const h = await fixture()
    await h.send()
    h.append(queueOperationEntry(operation, h.text, reason))
    expect(h.read()).toMatchObject({ notTakenIn: true, receipt: undefined })
  })
  test('drop evidence must be after latest send and exact; a queue enqueue blocks idle evidence until discharged', async () => {
    const h = await fixture()
    h.append(queueOperationEntry('popOne', h.text))
    await h.send()
    h.append(queueOperationEntry('enqueue', 'other'), replyEntry())
    expect(h.read()).toMatchObject({ notTakenIn: false, idleEvidence: false })
    h.append(queueOperationEntry('dequeue', 'other'), replyEntry())
    expect(h.read()).toMatchObject({ notTakenIn: false, idleEvidence: true })
    h.append(queueOperationEntry('remove', h.text, 'delivered_to_agent'))
    expect(h.read()).toMatchObject({ notTakenIn: false, receipt: undefined })
  })
  test.each(['task_started', 'task_complete'] as const)('Codex idle evidence after %s', async type => {
    const h = await fixture('codex')
    await h.send()
    expect(h.read().idleEvidence).toBe(true)
    h.append(codexTurnEntry(type))
    expect(h.read().idleEvidence).toBe(type === 'task_complete')
  })
  test('rotated, prior and sent paths remain searchable; new transcript matches at any offset', async () => {
    const h = await fixture(), old = join(h.root, 'prior.jsonl')
    fs.writeFileSync(old, '')
    await h.send(0, old)
    writeTranscript(old, [promptEntry(h.text)])
    h.row.transcript_status = 'rotated'
    h.row.jsonl_path = join(h.root, 'not-written.jsonl')
    expect(h.read().receipt?.path).toBe(old)
    const priorOnly = h.reader.read('claude', { ...h.row, prior_sessions: [{ jsonl_path: old }] }, h.item(), 1)
    expect(priorOnly.receipt?.path).toBe(old)
  })
  test.each(['take-in', 'popOne'] as const)('pre-send %s in a previously observed prior session cannot confirm or reject the new attempt', async kind => {
    const h = await fixture(), prior = join(h.root, 'prior.jsonl')
    const entry = () => kind === 'take-in' ? promptEntry(h.text) : queueOperationEntry('popOne', h.text)
    writeTranscript(prior, [entry()])
    const row = { ...h.row, prior_sessions: [{ jsonl_path: prior }] }
    const read = () => h.reader.read('claude', row, h.item(), 1, h.queue.items('alpha'))
    read() // This file's old EOF is known before the durable send.
    await h.send()
    expect(read()).toMatchObject({ receipt: undefined, notTakenIn: false })
    appendTranscript(prior, [entry()])
    const observed = read()
    expect(!!observed.receipt).toBe(kind === 'take-in')
    expect(observed.notTakenIn).toBe(kind === 'popOne')
    if (kind === 'take-in') expect(observed.receipt?.offset).toBeGreaterThan(0)
  })
  test.each(['take-in', 'popOne'] as const)('a prior file first discovered after the send accepts %s at offset zero', async kind => {
    const h = await fixture(), prior = join(h.root, 'newly-discovered.jsonl')
    h.read()
    await h.send()
    writeTranscript(prior, [{ ...(kind === 'take-in' ? promptEntry(h.text) : queueOperationEntry('popOne', h.text)), timestamp: '1970-01-01T00:00:00.000Z' }])
    const observed = h.reader.read('claude', { ...h.row, prior_sessions: [{ jsonl_path: prior }] }, h.item(), 1)
    expect(!!observed.receipt).toBe(kind === 'take-in')
    expect(observed.notTakenIn).toBe(kind === 'popOne')
    if (kind === 'take-in') expect(observed.receipt?.offset).toBe(0)
  })
  test('a retype retires old pull-back evidence while retaining a positive receipt from the first send window', async () => {
    const h = await fixture()
    await h.send()
    h.append(promptEntry(h.text), queueOperationEntry('popOne', h.text))
    const first = h.read()
    expect(first).toMatchObject({ notTakenIn: true })
    expect(first.receipt).toBeDefined()
    await h.send()
    expect(h.read()).toMatchObject({ receipt: first.receipt, notTakenIn: false })
    h.append(queueOperationEntry('popOne', h.text))
    expect(h.read()).toMatchObject({ receipt: first.receipt, notTakenIn: true })
  })
  test.each(['never_written', 'no_session', 'rotated', 'present'])('missing current path with transcript_status=%s', async transcript_status => {
    const h = await fixture()
    fs.unlinkSync(h.path)
    h.row.transcript_status = transcript_status
    expect(h.read().availability).toBe(transcript_status === 'present' ? 'unreadable' : 'not-yet-written')
    fs.writeFileSync(h.path, '')
    expect(h.read().availability).toBe('not-yet-written')
  })
  test('stat-first incremental reads handle partial JSON, replacement and truncation', async () => {
    const h = await fixture()
    await h.send()
    const calls: string[] = [], positions: number[] = []
    const reader = createDeliveryReceiptReader({ fs: { ...fs,
      statSync: ((...args: any[]) => { calls.push('stat'); return (fs.statSync as any)(...args) }) as typeof fs.statSync,
      openSync: ((...args: any[]) => { calls.push('open'); return (fs.openSync as any)(...args) }) as typeof fs.openSync,
      fstatSync: ((...args: any[]) => { calls.push('fstat'); return (fs.fstatSync as any)(...args) }) as typeof fs.fstatSync,
      readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => { calls.push('read'); positions.push(position); return fs.readSync(fd, buffer, offset, length, position) }) as typeof fs.readSync,
    } })
    const read = () => reader.read('claude', h.row, h.item(), 1)
    const json = transcriptJsonl([promptEntry(h.text)])
    fs.appendFileSync(h.path, json.slice(0, -2))
    expect(read().receipt).toBeUndefined()
    const size = fs.statSync(h.path).size
    calls.length = 0
    fs.appendFileSync(h.path, json.slice(-2))
    expect(read().receipt).toBeDefined()
    expect(calls.slice(0, 4)).toEqual(['stat', 'open', 'fstat', 'read'])
    expect(positions).toEqual([0, size])
    calls.length = 0
    read()
    expect(calls).toEqual(['stat', 'open', 'fstat'])
    fs.renameSync(h.path, join(h.root, 'rotated.jsonl'))
    fs.writeFileSync(h.path, 'broken JSON\n')
    expect(read().receipt).toBeUndefined()
    fs.truncateSync(h.path, 0)
    expect(read().records).toEqual([])
    writeTranscript(h.path, [promptEntry(h.text)])
    expect(read().receipt).toBeDefined()
    fs.truncateSync(h.path, 0)
    expect(read()).toMatchObject({ availability: 'not-yet-written', records: [], receipt: undefined })
  })
  test('unreadable cached records cannot newly confirm, and recovery rechecks them', async () => {
    const h = await fixture()
    await h.send()
    h.append(promptEntry(h.text))
    let refused = false
    const reader = createDeliveryReceiptReader({ fs: { ...fs, openSync: ((...args: any[]) => { if (refused) throw Object.assign(new Error('refused'), { code: 'EACCES' }); return (fs.openSync as any)(...args) }) as typeof fs.openSync } })
    const read = () => reader.read('claude', h.row, h.item(), 1)
    expect(read().receipt).toBeDefined()
    refused = true
    expect(read()).toMatchObject({ availability: 'unreadable', receipt: undefined })
    refused = false
    expect(read().receipt).toBeDefined()
  })
  test('Claude discovery uses configured scratch home; Codex does not synthesize a path', async () => {
    const h = await fixture()
    expect(deliveryTranscriptPath('claude', { cwd: h.root, session_id: 'session' }, h.root)).toContain(h.root)
    expect(deliveryTranscriptPath('codex', { cwd: h.root, session_id: 'session' }, h.root)).toBeUndefined()
  })
})
