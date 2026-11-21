/** Synthetic gate controls. These records are never written into a real queue
 * or a native session and never constitute native acceptance evidence. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditCodexDelivery, assertCodexRecovery, withCompactedRefusals } from './real-agent/codex-gate.ts'
import { makeQueue, readQueue, seedQueue } from './test-helpers/delivery-queue.ts'
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
  function lateReference(retypeOnly = false) {
    const f = sample(), original = f.journal[2] as any
    // The D1 driver records these production engine events directly. Keep
    // all identity fields together; a delivered row alone is not a binding.
    const reference = { instance, type: 'transcript-reference', key: f.key, instanceId: instance,
      sessionId: session, path, at: 1150 }
    const events: any[] = [{ ...reference, sessionId: '', path: '', at: 950 }, reference, ...f.events]
    if (retypeOnly) {
      f.journal.splice(3, 0, { ...original, transcript_path: '', transcript_size: 0, send_kind: 'retype', attempt: 2, at: 1050 })
      f.shim += call(1051, texts[0])
    } else { original.transcript_path = ''; original.transcript_size = 0 }
    return { ...f, events }
  }
  test.each([false, true])('late AD reference binds an empty send path, retype-only=%s', retypeOnly => {
    // A known initial send plus a pathless retype independently exercises
    // the every-send guard after the receipt's some(send) guard has passed.
    expect(auditCodexDelivery(lateReference(retypeOnly))).toMatchObject({ items: 2, duplicates: 0 })
  })
  test.each([false, true])('late Codex path rejects absent valid reference, retype-only=%s', retypeOnly => {
    const f = lateReference(retypeOnly); f.events.splice(1, 1)
    expect(() => auditCodexDelivery(f)).toThrow()
  })
  test.each([false, true])('late Codex path rejects mismatched session, retype-only=%s', retypeOnly => {
    const f = lateReference(retypeOnly); f.events[1].sessionId = 'foreign-session'
    expect(() => auditCodexDelivery(f)).toThrow()
  })
  test.each([
    ['foreign persona', (f: ReturnType<typeof lateReference>) => { f.events[1].key = 'foreign' }],
    ['foreign event instance', (f: ReturnType<typeof lateReference>) => { f.events[1].instance = 'cscb_foreign' }],
    ['foreign AD instance', (f: ReturnType<typeof lateReference>) => { f.events[1].instanceId = 'cscb_foreign' }],
    ['unrelated full path', (f: ReturnType<typeof lateReference>) => { f.events[1].path = '/foreign/synthetic.jsonl' }],
    ['mismatched send session', (f: ReturnType<typeof lateReference>) => { (f.journal[2] as any).session_id = 'foreign-session' }],
    ['receipt before send', (f: ReturnType<typeof lateReference>) => { f.rollout.records[1]!.at = 999 }],
    ['invalid EOF', (f: ReturnType<typeof lateReference>) => { (f.journal[2] as any).transcript_size = -1 }],
    ['unknown send outcome', (f: ReturnType<typeof lateReference>) => { (f.journal[2] as any).unknown_outcome = true }],
  ] as const)('late Codex path rejects %s', (_, change) => {
    const f = lateReference(); change(f)
    expect(() => auditCodexDelivery(f)).toThrow()
  })

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

  /** b.88t: AD refuses item 1's first text send (nothing typed); the not-now
   * retry (attempt 2) types it once. Production order: durable intent, the
   * shim's call, then the refusal record. */
  function refused(callAt = 1001) {
    const f = sample(), first = f.journal[2] as any
    const journal = [...f.journal.slice(0, 3), { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1003 },
      { ...first, attempt: 2, at: 1050 }, ...f.journal.slice(3)] as any[]
    return { ...f, journal, shim: call(callAt, texts[0]) + call(1051, texts[0]) + call(2001, texts[1]) }
  }
  const noRetype = (journal: any[], shim: string) => () => assertCodexRecovery(journal, 1, 'no-retype', shim, instance)
  test('no-retype excuses a send AD refused only inside its own attempt window', () => {
    const f = refused()
    expect(noRetype(f.journal, f.shim)).not.toThrow()
    const rejects = (journal: any[], shim = f.shim) => expect(noRetype(journal, shim)).toThrow('exact body was retyped')
    const rows = f.journal
    // No refusal, another item's or attempt's refusal.
    rejects(rows.filter(r => r.kind !== 'refused'))
    rejects(rows.map(r => r.kind === 'refused' ? { ...r, seq: 2 } : r))
    rejects(rows.map(r => r.kind === 'refused' ? { ...r, attempt: 3 } : r))
    // Outside the window: before the intent (one microsecond), or after the refusal's millisecond.
    rejects(rows, refused(999.999).shim)
    rejects(rows, refused(1004).shim)
    rejects(rows.map(r => r.kind === 'refused' ? { ...r, at: 1000 } : r))
    // An Enter-kind intent cannot excuse a text call.
    rejects(rows.map(r => r.kind === 'sent' && r.attempt === 1 ? { ...r, send_kind: 'enter' } : r))
    // One refusal excuses one call: a second call in the window, or an extra later call, stays typed.
    rejects(rows, call(1001, texts[0]) + call(1002, texts[0]) + call(1051, texts[0]))
    rejects(rows, f.shim + call(1100, texts[0]))
    // A repeated intent or refusal for that attempt is ambiguous and excuses nothing.
    rejects(rows.flatMap(r => r.kind === 'sent' && r.attempt === 1 ? [r, r] : [r]))
    rejects(rows.flatMap(r => r.kind === 'refused' ? [r, r] : [r]))
    // Recorded precision: within the refusal's millisecond and at the intent's exact time are inside.
    expect(noRetype(rows, refused(1003.8).shim)).not.toThrow()
    expect(noRetype(rows, refused(1000).shim)).not.toThrow()
    // Every call refused: no typed send is left.
    rejects(rows, call(1001, texts[0]))
  })
  test('Enter recovery after a refused text still needs exactly one typed text', () => {
    const f = refused()
    const journal = [...f.journal.slice(0, 5), { ...(f.journal[4] as any), send_kind: 'enter', attempt: 3, at: 1100 }, ...f.journal.slice(5)]
    const shim = f.shim + call(1101, undefined, 'Enter')
    expect(() => assertCodexRecovery(journal, 1, 'enter', shim, instance)).not.toThrow()
    expect(() => assertCodexRecovery(journal.filter(r => r.kind !== 'refused'), 1, 'enter', shim, instance)).toThrow('durable recovery Enter missing')
  })
  test('a refused send plus its retry is not a retype', () => {
    const f = refused(), journal = f.journal.map(r => r.kind === 'sent' && r.attempt === 2 ? { ...r, send_kind: 'retype' } : r)
    // Only the refused call precedes the retype intent: nothing was lost and retyped.
    expect(() => assertCodexRecovery(journal, 1, 'retype', f.shim, instance)).toThrow('lost text was not retyped')
    expect(() => assertCodexRecovery(journal.filter(r => r.kind !== 'refused'), 1, 'retype', f.shim, instance)).not.toThrow()
  })

  /** The D1 crash flow: the child's first text send is refused, its retry is
   * typed, then the harness dies before Enter. The real queue's start compacts
   * the open item, dropping the refused pair, before Enter recovery runs. */
  async function crashRestart(seeded: any[]) {
    const dir = mkdtempSync(join(tmpdir(), 'codex-gate-compact-'))
    try {
      seedQueue(dir, seeded)
      const queue = await makeQueue(dir)
      await queue.stop()
      const after = readQueue(dir) as any[]
      const retry = after.find(r => r.kind === 'sent' && r.attempt === 2)
      // Recovery evidence the restarted engine appends: a durable Enter intent and the delivery.
      const journal = [...after, { ...retry, send_kind: 'enter', attempt: 3, at: 1100 }, { v: 1, kind: 'delivered', seq: 1, part: 1, at: 1200, receipt: { path, offset: 0 } }]
      return { after, journal }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const recover = (journal: any[], shim: string) => () => assertCodexRecovery(journal, 1, 'enter', shim, instance)
  test('crash Enter recovery keeps refusals observed before the real queue restart', async () => {
    const f = refused(), before = f.journal.filter(r => r.seq === 1 && r.kind !== 'delivered')
    const { after, journal } = await crashRestart(before)
    // Premise: startup compaction removed attempt 1's sent/refused pair and recorded its watermark.
    expect(after.filter(r => r.kind === 'sent' || r.kind === 'refused').map(r => [r.kind, r.attempt])).toEqual([['sent', 2]])
    expect(after.find(r => r.kind === 'accepted' && r.seq === 1 && !r.compact)?.attempt_high_watermark).toBe(2)
    const shim = f.shim + call(1101, undefined, 'Enter')
    // The post-restart journal alone repeats the original false failure.
    expect(recover(journal, shim)).toThrow('durable recovery Enter missing')
    const audited = withCompactedRefusals(before, journal, 1)
    expect(recover(audited, shim)).not.toThrow()
    expect(audited.filter(r => r.kind === 'refused')).toEqual([before.find(r => r.kind === 'refused')])
    // An unrefused extra text call still fails, as does a missing actual Enter.
    expect(recover(audited, shim + call(1150, texts[0]))).toThrow('durable recovery Enter missing')
    expect(recover(audited, f.shim)).toThrow('durable recovery Enter missing')
  })
  test('crash Enter recovery restores nothing that compaction kept, duplicated or never observed', async () => {
    const f = refused(), before = f.journal.filter(r => r.seq === 1 && r.kind !== 'delivered')
    const shim = f.shim + call(1101, undefined, 'Enter')
    // An unrefused first send survives compaction; nothing is restored and the extra call fails.
    const unrefused = await crashRestart(before.filter(r => r.kind !== 'refused'))
    expect(unrefused.after.filter(r => r.kind === 'sent').map(r => r.attempt)).toEqual([1, 2])
    expect(withCompactedRefusals(before, unrefused.journal, 1)).toEqual(unrefused.journal)
    expect(recover(withCompactedRefusals(before, unrefused.journal, 1), shim)).toThrow('durable recovery Enter missing')
    const { journal } = await crashRestart(before)
    // A pair still in the journal is not added again (no duplicate attempt).
    const uncompacted = [...before, ...journal.slice(-2)]
    expect(withCompactedRefusals(before, uncompacted, 1)).toEqual(uncompacted)
    expect(recover(withCompactedRefusals(before, uncompacted, 1), shim)).not.toThrow()
    // Another item's refusal, or one above the compacted watermark, is not restored.
    expect(withCompactedRefusals(before.map(r => r.kind === 'refused' ? { ...r, seq: 2 } : r), journal, 1)).toEqual(journal)
    const high = before.map(r => (r.kind === 'refused' || (r.kind === 'sent' && r.attempt === 1)) ? { ...r, attempt: 5 } : r)
    expect(withCompactedRefusals(high, journal, 1)).toEqual(journal)
    // Without an observed refusal, nothing is inferred from the missing records.
    expect(withCompactedRefusals(before.filter(r => r.kind !== 'refused'), journal, 1)).toEqual(journal)
    // A repeated observed refusal stays ambiguous and excuses nothing.
    const repeated = before.flatMap(r => r.kind === 'refused' ? [r, r] : [r])
    expect(recover(withCompactedRefusals(repeated, journal, 1), shim)).toThrow('durable recovery Enter missing')
  })
})
