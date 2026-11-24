import { expect, test } from 'bun:test'
import { auditSubmissions, formatSubmissionIssues, fixtureEvidenceRow, pairReceipt, textHash, type HookRecord, type QueueRow } from './integration/fixtures/stub-submission-audit.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX } from './test-helpers/credentials.ts'

const queue = (n: number): QueueRow[] => Array.from({ length: n }, (_, i) => i + 1).flatMap(seq => [
  { kind: 'accepted', seq, channel: 'CROOM', ts: `${seq}.001` },
  { kind: 'fixed', seq, parts: [`item-${seq}`] },
  { kind: 'sent', seq, attempt: 1, send_kind: 'text', at: seq },
])
const submitted = (n: number, at = `${n}.5`): HookRecord => ({ command: 'submitted', text_hash: textHash(`item-${n}`), at })
const receipt = (n: number): HookRecord => ({ ...submitted(n), command: 'receipt' })

test('c1d282: 33 submissions for 32 accepted cannot shift the 32 releases', () => {
  const hooks = [submitted(1), receipt(1), submitted(1, '1.9'), receipt(1),
    ...Array.from({ length: 30 }, (_, i) => [submitted(i + 2), receipt(i + 2)]).flat(), submitted(32)]
  expect(hooks.filter(r => r.command === 'submitted')).toHaveLength(33)
  expect(hooks.filter(r => r.command === 'receipt')).toHaveLength(32)
  const issues = auditSubmissions(queue(32), hooks)
  expect(issues.map(r => [r.reason, r.identity, r.at, r.matches.map(m => m.seq)])).toEqual([
    ['duplicate', textHash('item-1'), '1.5', [1]], ['duplicate', textHash('item-1'), '1.9', [1]],
  ])
  expect(() => pairReceipt(queue(32), hooks)).toThrow()
})
test('duplicate submission reports both times and the matching sent attempts', () => {
  const issues = auditSubmissions(queue(1), [submitted(1), submitted(1, '9.5')])
  expect(issues.map(r => r.at)).toEqual(['1.5', '9.5'])
  expect(issues[1]?.matches).toEqual([{ seq: 1, part: 1, sent: [{ kind: 'sent', seq: 1, attempt: 1, send_kind: 'text', at: 1 }] }])
})
test('different text hashes cannot submit the same accepted item part twice', () => {
  const rows = [...queue(1), { kind: 'fixed', seq: 1, parts: ['item-2'] }]
  expect(auditSubmissions(rows, [submitted(1), submitted(2)]).map(r => [r.reason, r.matches[0]?.seq])).toEqual([
    ['duplicate', 1], ['duplicate', 1],
  ])
  expect(() => pairReceipt(rows, [submitted(1), receipt(1), submitted(2)])).toThrow(/duplicate/)
})
test('unknown submission identifies its hash and time', () => {
  expect(auditSubmissions(queue(1), [submitted(99)])).toEqual([
    { reason: 'unmatched', identity: textHash('item-99'), at: '99.5', matches: [] },
  ])
})
test('release for item X cannot release a different held accepted item', () => {
  expect(() => pairReceipt(queue(2), [submitted(2)], { channel: 'CROOM', ts: '1.001' })).toThrow(/not-yet-released/)
})
test('identity pair succeeds for its item and waits if nothing has been submitted', () => {
  expect(pairReceipt(queue(2), [submitted(1)], { channel: 'CROOM', ts: '1.001' })).toEqual(submitted(1))
  expect(pairReceipt(queue(2), [])).toBeUndefined()
  expect(auditSubmissions(queue(2), [submitted(1), receipt(1), submitted(2)])).toEqual([])
})
test('accepted reply-reminder interjects participate in pairing and auditing', () => {
  const rows = queue(1)
  Object.assign(rows[0]!, { source: 'interject', sender: 'reply-reminder', reminder_for: 99 })
  expect(auditSubmissions(rows, [submitted(1)])).toEqual([])
  expect(pairReceipt(rows, [submitted(1)])).toEqual(submitted(1))
})
test('a fresh manual worker pairs its FIFO head past durably completed history', () => {
  const rows = [...queue(2), { kind: 'delivered', seq: 1, part: 1 }]
  expect(pairReceipt(rows, [submitted(2)])).toEqual(submitted(2))
  expect(() => pairReceipt(rows, [submitted(1)])).toThrow(/not-yet-released/)
})
test('default selection refuses a later held item behind an unfinished predecessor without fixed text', () => {
  const rows = queue(2).filter(r => !(r.seq === 1 && r.kind !== 'accepted'))
  expect(() => pairReceipt(rows, [submitted(2)])).toThrow(/not-yet-released/)
})
test.each(['withdrawn', 'abandoned', 'hold-withdrawn', 'memory', 'parked-memory'])(
  'default selection preserves the legitimate predecessor exclusion: %s', kind => {
    const rows: QueueRow[] = queue(2).filter(r => !(r.seq === 1 && r.kind !== 'accepted'))
    if (kind === 'memory' || kind === 'parked-memory') {
      Object.assign(rows[0]!, { hold: { on: kind === 'memory' ? 'memory' : 'post', root_unknown: true } })
      if (kind === 'parked-memory') rows.push({ kind: 'parked', seq: 1 })
    } else rows.push({ kind, seq: 1 })
    expect(pairReceipt(rows, [submitted(2)])).toEqual(submitted(2))
  })
test.each(['post', 'released-memory', 'compacted-release'] as const)(
  'default selection keeps an unfinished predecessor eligible: %s', kind => {
    const rows: QueueRow[] = queue(2).filter(r => !(r.seq === 1 && r.kind !== 'accepted'))
    Object.assign(rows[0]!, { hold: { on: kind === 'post' ? 'post' : 'memory' } })
    if (kind === 'released-memory') rows.push({ kind: 'released', seq: 1 })
    if (kind === 'compacted-release') rows.push({ kind: 'accepted', seq: 1, released_at: 10 })
    expect(() => pairReceipt(rows, [submitted(2)])).toThrow(/not-yet-released/)
  })
test('ambiguous rendered text never identifies two accepted items as one', () => {
  const rows = queue(2)
  rows.find(r => r.kind === 'fixed' && r.seq === 2)!.parts = ['item-1']
  expect(auditSubmissions(rows, [submitted(1)])[0]).toMatchObject({ reason: 'ambiguous' })
  expect(() => pairReceipt(rows, [submitted(1)])).toThrow(/no-unique-accepted/)
})
test('archive observations deduplicate item definitions and retain every send attempt', () => {
  const rows = [...queue(1), ...queue(1), { kind: 'sent', seq: 1, attempt: 2, send_kind: 'text', at: 9 }]
  const issues = auditSubmissions(rows, [submitted(1), submitted(1, '9.5')])
  expect(issues[0]?.matches[0]?.sent.map(r => r.attempt)).toEqual([1, 2])
})
test('diagnostics escape arbitrary record fields and contain no message contents', () => {
  const output = formatSubmissionIssues([{ reason: 'unmatched', identity: fakeToken(BOT_TOKEN_PREFIX, 'submission-diagnostic'), at: 'line\nbreak', matches: [] }]).join('\n')
  expect(output).toBe('stub-submission-audit: {"reason":"unmatched","identity":"invalid","at":"invalid","matches":[]}')
  assertNoLeak(output)
})

test('complete evidence hashes fixture text, redacts nested credentials and escapes control bytes', async () => {
  const { redactSlackLogText } = await import('../src/slack-log-redaction.ts')
  const token = fakeToken(APP_TOKEN_PREFIX, 'kept-evidence')
  const value = fixtureEvidenceRow({ kind: 'fixed', seq: 7, text: 'fixture body', parts: ['fixture body'],
    receipt: { path: `path\n${token}\"tail` }, send_kind: token, raw_error: token }, redactSlackLogText)
  expect(value).toEqual({ kind: 'fixed', seq: 7, text: { text_hash: textHash('fixture body'), bytes: 12 },
    parts: [{ text_hash: textHash('fixture body'), bytes: 12 }],
    receipt: { path: `invalid:sha256:${textHash(`path\n${token}\"tail`)}:bytes:${Buffer.byteLength(`path\n${token}\"tail`)}` },
    send_kind: `invalid:sha256:${textHash(token)}:bytes:${Buffer.byteLength(token)}`,
    raw_error: `invalid:sha256:${textHash(token)}:bytes:${Buffer.byteLength(token)}` })
  const line = JSON.stringify(value)
  expect(line).not.toContain('\n')
  assertNoLeak(line)
})

test.each([BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX])('evidence enum fields redact short and embedded prefixes: %s', async prefix => {
  const { redactSlackLogText } = await import('../src/slack-log-redaction.ts')
  for (const text of [prefix + 'a', 'known-' + prefix + 'a']) {
    const fields = ['kind', 'command', 'event', 'send_kind']
    const output = fixtureEvidenceRow(Object.fromEntries(fields.map(field => [field, text])), redactSlackLogText)
    assertNoLeak(JSON.stringify(output))
    for (const field of fields) expect(output[field]).toBe(`invalid:sha256:${textHash(text)}:bytes:${Buffer.byteLength(text)}`)
  }
})
