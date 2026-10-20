/** Synthetic controls for real-scenario accounting; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryQueue, type AcceptedInput, type QueueItem } from '../src/delivery-queue.ts'
import { parseDeliveryTranscriptRecord, receiptTextMatches } from '../src/delivery-receipt.ts'
import { REPLY_REMINDER_TEXT } from '../src/reply-reminder.ts'
import { injectedInput, slackInput } from './test-helpers/delivery-queue.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { promptEntry } from './test-helpers/working-row-panes.ts'
import { auditReceipts, deliveryFailureEvidence, jsonLines, readTranscripts, receiptJournal, workloadItem, workloadItems } from './integration/fixtures/transcript-receipts.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'reminder-receipts-'))
  let now = 1000
  const queue = createDeliveryQueue({ stateDir, now: () => now })
  cleanups.push(async () => { await queue.stop(); rmSync(stateDir, { recursive: true, force: true }) })
  await queue.start()
  const transcript = join(stateDir, 'session.jsonl'), shimLog = join(stateDir, 'shim.log'), journal = join(stateDir, 'queue/alpha.jsonl')
  const takes: object[] = [], calls: string[] = [], lines: string[] = []
  const adapters = { parseDeliveryTranscriptRecord, receiptTextMatches }
  const persona = makeMultiPersonaConfig([{ name: 'alpha' }], stateDir).personas[0]!
  async function complete(item: QueueItem) {
    const a = item.accepted, seq = a.seq, text = `<channel seq="${seq}">${a.text}</channel>`
    const diagnostic = (kind: string) => `[${new Date(now).toISOString()}] [slack] ${kind}: persona="alpha" (key=alpha) source=${a.source} ${a.source === 'slack' ? 'chat_id' : 'sender'}=${JSON.stringify(a.channel ?? a.sender)} ts=${JSON.stringify(a.ts)} sender_id=${JSON.stringify(a.user ?? a.sender)}`
    if (a.reminder_for === undefined) lines.push(diagnostic('message-received'))
    await queue.append('alpha', { v: 1, kind: 'fixed', seq, parts: [text] })
    now += 10
    await queue.append('alpha', { v: 1, kind: 'sent', seq, part: 1, attempt: 1, send_kind: 'text', at: now, launch_id: 'launch', session_id: 'session', transcript_path: transcript, transcript_size: 0 })
    calls.push(`call\t${now / 1000}\t1\t1\tbun\tsend-keys --instance-id cscb_alpha --text ${text.replace(/[^a-zA-Z0-9]/g, c => '\\' + c)} --no-enter`)
    now += 10
    takes.push({ ...promptEntry(text), uuid: `take-${seq}`, sessionId: 'session', timestamp: new Date(now).toISOString() })
    await queue.append('alpha', { v: 1, kind: 'delivered', seq, part: 1, at: now, receipt: { path: transcript, uuid: `take-${seq}` } })
    lines.push(diagnostic('message-delivered'))
    now += 10
  }
  async function send(input: AcceptedInput) {
    const result = await queue.accept('alpha', input)
    if (result.status !== 'accepted' || !result.item) throw new Error('fixture acceptance failed')
    await complete(result.item)
  }
  await send(slackInput())
  await queue.observeReplyReminders('alpha', cannedGetResult({ state: 'working', session_id: 'session' }, persona, stateDir), REPLY_REMINDER_TEXT, true, () => true)
  const [reminder] = await queue.observeReplyReminders('alpha', cannedGetResult({ state: 'waiting', session_id: 'session' }, persona, stateDir), REPLY_REMINDER_TEXT, true, () => true)
  if (!reminder) throw new Error('fixture reminder missing')
  await complete(reminder)
  await send(slackInput({ ts: '1700000000.000002', key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
  await send(injectedInput())
  await send(injectedInput({ source: 'cron' }))
  writeFileSync(transcript, takes.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(shimLog, calls.join('\n') + '\n')
  writeFileSync(join(stateDir, 'server.log'), lines.join('\n') + '\n')
  const options = { stateDir, key: 'alpha', shimLog, transcripts: [transcript], expectedCount: 4 }
  const entries = () => readTranscripts([transcript], adapters)
  return { queue, journal, transcript, shimLog, options, adapters, entries,
    audit: () => auditReceipts(options, entries(), adapters) }
}

test('original Slack and injected inputs retain exact counts and latency samples across reminder delivery and compaction', async () => {
  const h = await fixture()
  expect(h.audit()).toMatchObject({ items: 4, reminders: 1, duplicates: 0 })
  expect(h.audit().timings.map(t => t.seq)).toEqual([1, 3, 4, 5])
  const evidence = deliveryFailureEvidence(h.options, h.entries(), h.adapters)
  expect(evidence).toMatchObject({ accepted: 4, reminders: 1, expected: 4, open: 0 })
  await h.queue.compact()
  expect(h.audit()).toMatchObject({ items: 4, reminders: 1, duplicates: 0 })
})

test('workload ordinals retain original input identities across interleaved reminders and recovery', async () => {
  const h = await fixture()
  const assertSelection = () => {
    const journal = receiptJournal(h.options.stateDir, 'alpha')
    const inputs = workloadItems(journal)
    expect(inputs.map(r => [r.seq, r.source])).toEqual([[1, 'slack'], [3, 'slack'], [4, 'interject'], [5, 'cron']])
    expect(inputs.map((_, i) => workloadItem(journal, i + 1).seq)).toEqual([1, 3, 4, 5])
    expect(() => workloadItem(journal, 5)).toThrow('Workload item 5 has not been accepted')
    // Selecting a workload must leave reminder evidence in the full journal.
    expect(journal.some(r => r.kind === 'accepted' && r.reminder_for === 1)).toBe(true)
  }
  assertSelection()
  await h.queue.compact()
  expect(jsonLines(h.journal).some(r => r.kind === 'accepted' && r.compact)).toBe(true)
  await h.queue.stop()
  await h.queue.start()
  assertSelection()
})

test.each([0, -1, 1.5, NaN, Infinity])('workload selection rejects invalid ordinal %s', ordinal => {
  expect(() => workloadItem([], ordinal)).toThrow('Invalid workload ordinal')
})

test.each([
  ['missing original input', 'Accepted item count differs'],
  ['missing reminder receipt', 'still open'],
  ['missing reminder take-in', 'no exact transcript receipt'],
  ['missing reminder send', 'has no shim send'],
  ['recursive reminder', 'Invalid reply reminder provenance'],
  ['cron reminder', 'Invalid reply reminder provenance'],
  ['duplicate reminder', 'Invalid reply reminder provenance'],
  ['premature reminder', 'Invalid reply reminder provenance'],
  ['reminder sent before workload delivery log', 'Successor send preceded prior receipt/delivery log'],
  ['workload sent before reminder delivery log', 'Successor send preceded prior receipt/delivery log'],
  ['reminder retyped', 'Text fidelity case retyped'],
] as const)('receipt accounting rejects %s despite excluding reminders from the expected input count', async (mode, reason) => {
  const h = await fixture()
  expect(h.audit().items).toBe(4)
  let rows = jsonLines(h.journal)
  if (mode === 'missing original input') rows = rows.filter(r => r.seq !== 5)
  if (mode === 'missing reminder receipt') rows = rows.filter(r => !(r.seq === 2 && r.kind === 'delivered'))
  if (mode === 'recursive reminder' || mode === 'cron reminder' || mode === 'premature reminder') {
    rows = rows.map(r => r.seq === 2 && r.kind === 'accepted'
      ? { ...r, ...(mode === 'premature reminder' ? { received_at: 1000 } : { reminder_for: mode === 'recursive reminder' ? 2 : 5 }) } : r)
  }
  if (mode === 'duplicate reminder') rows.push({ ...rows.find(r => r.seq === 2 && r.kind === 'accepted'), seq: 6 })
  writeFileSync(h.journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  if (mode === 'missing reminder take-in') writeFileSync(h.transcript, jsonLines(h.transcript).filter(r => r.uuid !== 'take-2').map(r => JSON.stringify(r)).join('\n') + '\n')
  if (mode === 'missing reminder send') writeFileSync(h.shimLog, readFileSync(h.shimLog, 'utf8').split('\n').filter((_, i) => i !== 1).join('\n'))
  if (mode === 'reminder sent before workload delivery log' || mode === 'workload sent before reminder delivery log') {
    const previousSeq = mode === 'reminder sent before workload delivery log' ? 1 : 2
    const previous = rows.find(r => r.kind === 'accepted' && r.seq === previousSeq)
    const sent = rows.find(r => r.kind === 'sent' && r.seq === previousSeq + 1)
    const logPath = join(h.options.stateDir, 'server.log')
    const lines = readFileSync(logPath, 'utf8').split('\n').map(line =>
      line.includes('message-delivered:') && line.includes(`ts=${JSON.stringify(previous.ts)}`)
        ? line.replace(/^\[[^\]]+\]/, `[${new Date(sent.at + 1).toISOString()}]`) : line)
    writeFileSync(logPath, lines.join('\n'))
  }
  if (mode === 'reminder retyped') {
    const calls = readFileSync(h.shimLog, 'utf8').trimEnd().split('\n')
    calls.splice(2, 0, calls[1]!)
    writeFileSync(h.shimLog, calls.join('\n') + '\n')
  }
  expect(() => auditReceipts({ ...h.options, noRetype: mode === 'reminder retyped' }, h.entries(), h.adapters)).toThrow(reason)
})
