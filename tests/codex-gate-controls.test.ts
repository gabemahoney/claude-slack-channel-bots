/** Synthetic gate controls. These records are never written into a real queue
 * or a native session and never constitute native acceptance evidence. */
import { describe, expect, test } from 'bun:test'
import { auditCodexDelivery, assertCodexRecovery, assertCodexObservationInventory } from './real-agent/codex-gate.ts'
import { projectCodexRollout } from './real-agent/codex-evidence.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
        session_id: session, transcript_path: path, transcript_size: rollout.records[0]!.end, launch_id: 'synthetic-launch' },
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

describe('Codex gate native observation inventory', () => {
  const panes = () => ['idle-empty', 'slash-popup', 'at-popup', 'dollar-popup', 'shortcuts-overlay', 'idle-one-line-draft',
    'idle-multiline-draft', 'busy-one-line-draft', 'busy-multiline-draft'].map(label => ({ label, agent: 'codex', version: '0.159.2',
      state: label.startsWith('busy-') ? 'working' : 'waiting', screen: { kind: label === 'idle-empty' ? 'empty' : /popup|overlay/.test(label) ? 'menu' : 'input' } }))
  test('all popup draft idle busy and no-turn observations pass independently of AI completion', () => {
    expect(() => assertCodexObservationInventory(panes(), true)).not.toThrow()
  })
  test.each(['missing-popup', 'missing-draft', 'duplicate', 'wrong-agent', 'wrong-version', 'wrong-screen', 'wrong-state', 'no-no-turn'])('%s cannot pass the observation inventory', kind => {
    const p = panes()
    if (kind === 'missing-popup') p.splice(2, 1)
    if (kind === 'missing-draft') p.pop()
    if (kind === 'duplicate') p.push(p[0]!)
    if (kind === 'wrong-agent') p[0]!.agent = 'claude'
    if (kind === 'wrong-version') p[0]!.version = 'other-version'
    if (kind === 'wrong-screen') p[2]!.screen.kind = 'input'
    if (kind === 'wrong-state') p[7]!.state = 'waiting'
    expect(() => assertCodexObservationInventory(p, kind !== 'no-no-turn')).toThrow()
  })
})

describe('native pane rendering uses bounded observable polling', () => {
  const source = readFileSync(join(import.meta.dir, 'real-agent/codex-delivery.ts'), 'utf8')
  const extract = (name: string) => source.match(new RegExp(`^async function ${name}[\\s\\S]*?^\\}`, 'm'))![0]
  function probe(label: string, frames: { state: string; screen: { kind: string; text?: string }; after?: number }[]) {
    let at = 0, calls = 0
    const captures: number[] = []
    const wait = new Function('Date', 'Bun', 'pane', new Bun.Transpiler({ loader: 'ts' }).transformSync(
      extract('poll') + '\n' + extract('observationPane') + '\nreturn observationPane',
    ))({ now: () => at }, { sleep: async (ms: number) => { at += ms } }, async () => {
      captures.push(at)
      const frame = frames[Math.min(calls++, frames.length - 1)]!
      at += frame.after ?? 0
      return frame
    }) as (label: string, text: string) => Promise<unknown>
    return { run: () => wait(label, 'first line\nsecond line'), captures, calls: () => calls, at: () => at }
  }
  test.each(['slash-popup', 'at-popup', 'dollar-popup', 'shortcuts-overlay', 'idle-multiline-draft', 'busy-multiline-draft'])('%s waits for delayed screen rendering and matching activity', async label => {
    const expected = { state: label.startsWith('busy-') ? 'working' : 'waiting', screen: { kind: label.includes('draft') ? 'input' : 'menu', text: 'first line\nsecond line' } }
    const p = probe(label, [{ state: 'waiting', screen: { kind: 'empty' } }, { ...expected, state: expected.state === 'working' ? 'waiting' : 'working' }, expected])
    expect(await p.run()).toEqual(expected)
    expect(p.captures).toEqual([0, 250, 500])
  })
  test('a partially rendered multiline draft cannot satisfy the expected draft', async () => {
    const expected = { state: 'waiting', screen: { kind: 'input', text: 'first line\nsecond line' } }
    const p = probe('idle-multiline-draft', [{ ...expected, screen: { kind: 'input', text: 'first line' } }, expected])
    expect(await p.run()).toEqual(expected); expect(p.calls()).toBe(2)
  })
  test.each([
    ['slash-popup', 'waiting', 'input'], ['idle-one-line-draft', 'waiting', 'empty'],
    ['busy-one-line-draft', 'waiting', 'input'], ['idle-one-line-draft', 'working', 'input'],
  ])('%s cannot capture kind=%s/%s through its 120s bound', async (label, state, kind) => {
    const p = probe(label!, [{ state: state!, screen: { kind: kind!, text: 'first line\nsecond line' } }])
    await expect(p.run()).rejects.toThrow('observation incomplete within bound')
    expect(p.at()).toBe(120000); expect(p.calls()).toBe(480)
  })
  test('a read that returns the expected screen after the deadline is refused', async () => {
    const p = probe('at-popup', [{ state: 'waiting', screen: { kind: 'menu' }, after: 120001 }])
    await expect(p.run()).rejects.toThrow('observation incomplete within bound')
    expect(p.calls()).toBe(1)
  })
  test('every popup and draft observation calls the polled capture without fixed render sleeps', () => {
    const observe = extract('observe')
    expect(observe.match(/await observationPane\(label!, text!\)/g)).toHaveLength(2)
    expect(observe).not.toMatch(/Bun\.sleep\((100|300)\)/)
  })
})

describe('Codex fault recovery evidence', () => {
  test('Enter-only recovery requires actual Enter after a durable retry and exactly one text', () => {
    const f = sample(), retry = { ...(f.journal[2] as any), send_kind: 'enter', at: 1050, attempt: 2 }
    f.journal.splice(3, 0, retry)
    f.shim += call(1051, undefined, 'Enter')
    expect(() => assertCodexRecovery(f.journal, 1, 'enter', f.shim, instance)).not.toThrow()
    expect(() => assertCodexRecovery(f.journal, 1, 'enter', f.shim + call(1060, texts[0]), instance)).toThrow()
    expect(() => assertCodexRecovery(f.journal, 1, 'enter', call(1001, texts[0]), instance)).toThrow()
    expect(() => assertCodexRecovery(f.journal, 1, 'enter', call(1001, texts[0]) + call(2001, undefined, 'Enter'), instance)).toThrow()
  })
  test('lost text needs both durable retype and a second actual text call', () => {
    const f = sample(), retry = { ...(f.journal[2] as any), send_kind: 'retype', at: 1050, attempt: 2 }
    f.journal.splice(3, 0, retry)
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', f.shim, instance)).toThrow()
    f.shim += call(1051, texts[0])
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', f.shim, instance)).not.toThrow()
    expect(() => assertCodexRecovery(f.journal, 1, 'retype', call(1001, texts[0]) + call(1049, texts[0]), instance)).toThrow()
  })
  test('trailing popup characters are confirmed without a retype', () => {
    const f = sample()
    for (const seq of [1, 2]) expect(() => assertCodexRecovery(f.journal, seq, 'no-retype', f.shim, instance)).not.toThrow()
    f.shim += call(1051, texts[0])
    expect(() => assertCodexRecovery(f.journal, 1, 'no-retype', f.shim, instance)).toThrow()
  })
})
