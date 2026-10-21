/** Synthetic gate controls. These records are never written into a real queue
 * or a native session and never constitute native acceptance evidence. */
import { describe, expect, test } from 'bun:test'
import { auditCodexDelivery, assertCodexRecovery } from './real-agent/codex-gate.ts'
import { projectCodexRollout } from './real-agent/codex-evidence.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const instance = 'cscb_synthetic', path = '/private/synthetic.jsonl', session = 'synthetic-session'
const texts = ['<channel>first @</channel>', '<channel>second $</channel>']
function call(at: number, text?: string, key?: string) {
  const quote = (s: string) => s.replace(/[^A-Za-z0-9_/-]/g, '\\$&')
  return ['call', at / 1000, 20, 10, 'bun', `send-keys --instance-id ${instance} ${text === undefined ? `--key ${key}` : `--text ${quote(text)} --no-enter`}`].join('\t') + '\n'
}
function sample(duplicate = false) {
  const native = (text: string, at: number) => ({ type: 'response_item', timestamp: new Date(at).toISOString(),
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const raw = [{ type: 'session_meta', timestamp: new Date(0).toISOString(), payload: { id: session } }, native(texts[0]!, 1100),
    ...(duplicate ? [native(texts[0]!, 1150)] : []), native(texts[1]!, 2100)]
  const rollout = projectCodexRollout(Buffer.from(raw.map(r => JSON.stringify(r) + '\n').join('')), session)
  const takes = rollout.records.filter(r => r.role === 'user')
  const journal = [0, 1].flatMap(i => {
    const receipt = i ? takes.at(-1)! : takes[0]!, seq = i + 1
    return [{ v: 1, kind: 'accepted', seq, source: 'interject', sender: 'synthetic', ts: `1.00000${seq}`, text: `body-${i}`, received_at: 900 + i * 1000 },
      { v: 1, kind: 'fixed', seq, parts: [texts[i]] },
      { v: 1, kind: 'sent', seq, part: 1, send_kind: 'text', attempt: 1, at: 1000 + i * 1000,
        session_id: session, transcript_path: path, transcript_size: rollout.records[0]!.end },
      { v: 1, kind: 'delivered', seq, part: 1, at: 1200 + i * 1000, receipt: { path, offset: receipt.offset } }]
  })
  const events = [1, 2].map(seq => ({ instance, type: 'item-delivered', seq, at: 201 + seq * 1000 }))
  const log = events.map(e => `[${new Date(e.at + 1).toISOString()}] [slack] message-delivered: persona="synthetic" (key=synthetic) source=interject sender="synthetic" ts="1.00000${e.seq}" sender_id="synthetic" at=${e.at} wait_ms=301`).join('\n')
  return { journal, rollout, path, instance, shim: call(1001, texts[0]) + call(2001, texts[1]), events, key: 'synthetic', log }
}

describe('Codex delivery gate receipt audit', () => {
  test('delivery gate passes on exact receipt evidence without any assistant answer or completion', () => {
    const fixture = sample(), result = auditCodexDelivery(fixture)
    expect(result).toMatchObject({ items: 2, duplicates: 0 })
    expect(result.firstReceipts).toHaveLength(2)
    expect(fixture.rollout.records.some(r => r.role === 'assistant' || r.kind === 'task_complete')).toBe(false)
    assertNoLeak(result)
  })
  test('a nonzero duplicate count is reported without alone failing delivery', () => {
    expect(auditCodexDelivery(sample(true))).toMatchObject({ items: 2, duplicates: 1 })
  })
  test('crash-startup compaction retains the complete audit through the actual completed prefix', () => {
    const f = sample(), completedPrefix = f.journal.slice(0, 4)
    const compacted = [{ kind: 'accepted', seq: 1, compact: 'key' }, { kind: 'accepted', seq: 1, compact: 'allocation' }, ...f.journal.slice(4)]
    expect(auditCodexDelivery({ ...f, journal: compacted })).toMatchObject({ items: 1 })
    const audit = auditCodexDelivery({ ...f, journal: compacted, completedPrefix })
    expect(audit).toEqual({ items: 2, duplicates: 0, firstReceipts: f.rollout.records.filter(r => r.role === 'user').map(r => r.offset) })
    // A restart which retains the prefix must not count it twice either.
    expect(auditCodexDelivery({ ...f, completedPrefix })).toEqual(audit)
    assertNoLeak(audit)
  })
  test.each(['prefix-unconfirmed', 'prefix-missing-send', 'suffix-send-before-confirmation', 'suffix-call-before-confirmation'])('%s remains rejected across crash compaction', kind => {
    const f = sample(), completedPrefix = f.journal.slice(0, 4)
    f.journal = [{ kind: 'accepted', seq: 1, compact: 'key' } as any, ...f.journal.slice(4)]
    if (kind === 'prefix-unconfirmed') completedPrefix.pop()
    if (kind === 'prefix-missing-send') completedPrefix.splice(2, 1)
    if (kind === 'suffix-send-before-confirmation') (f.journal[3] as any).at = 1199
    if (kind === 'suffix-call-before-confirmation') f.shim = call(1001, texts[0]) + call(1199, texts[1])
    expect(() => auditCodexDelivery({ ...f, completedPrefix })).toThrow()
  })
  test.each(['wrong-path', 'foreign-session', 'wrong-text', 'assistant-copy', 'stale-receipt', 'stale-send-offset', 'unconfirmed', 'missing-call',
    'missing-delivered-event', 'missing-official-log', 'foreign-official-log', 'duplicate-official-log', 'send-before-message-delivered', 'call-before-message-delivered', 'out-of-order-first-receipts', 'partial'])('%s rejects apparent delivery', kind => {
    const f = sample(), firstSend = f.journal[2] as any, secondSend = f.journal[6] as any, firstReceipt = f.rollout.records[1]!
    if (kind === 'wrong-path') (f.journal[3] as any).receipt.path = '/private/foreign.jsonl'
    if (kind === 'foreign-session') firstSend.session_id = 'foreign-session'
    if (kind === 'wrong-text') firstReceipt.text += 'changed'
    if (kind === 'assistant-copy') firstReceipt.role = 'assistant'
    if (kind === 'stale-receipt') firstReceipt.at = 500
    if (kind === 'stale-send-offset') firstSend.transcript_size = firstReceipt.end
    if (kind === 'unconfirmed') f.journal.splice(7, 1)
    if (kind === 'missing-call') f.shim = call(2001, texts[1])
    if (kind === 'missing-delivered-event') f.events.shift()
    if (kind === 'missing-official-log') f.log = ''
    if (kind === 'foreign-official-log') f.log = f.log.replaceAll('(key=synthetic)', '(key=foreign)')
    if (kind === 'duplicate-official-log') f.log += '\n' + f.log.split('\n')[0]
    if (kind === 'send-before-message-delivered') { secondSend.at = 1199; f.journal.splice(3, 0, f.journal.splice(6, 1)[0]!) }
    if (kind === 'call-before-message-delivered') f.shim = call(1001, texts[0]) + call(1199, texts[1])
    if (kind === 'out-of-order-first-receipts') {
      firstReceipt.offset = 50000
      const delivered = f.journal[3] as any
      delivered.receipt.offset = firstReceipt.offset
    }
    if (kind === 'partial') f.rollout.incomplete = true
    expect(() => auditCodexDelivery(f)).toThrow()
  })
})

describe('Codex fault recovery evidence', () => {
  test('lost text needs both durable retype and a second actual text call', () => {
    const f = sample(), retry = { ...(f.journal[2] as any), send_kind: 'retype', at: 1050, attempt: 2 }
    f.journal.splice(3, 0, retry)
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', f.shim, instance)).toThrow()
    f.shim += call(1051, texts[0])
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', f.shim, instance)).not.toThrow()
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', call(1001, texts[0]) + call(1049, texts[0]), instance)).toThrow()
  })
  test('exact trailing characters are confirmed without a retype', () => {
    const f = sample()
    for (const seq of [1, 2]) expect(() => assertCodexRecovery(f.journal, seq, 'no-retype', f.shim, instance)).not.toThrow()
    f.shim += call(1051, texts[0])
    expect(() => assertCodexRecovery(f.journal, 1, 'no-retype', f.shim, instance)).toThrow()
  })
})
