/** Synthetic oracle controls only; never start a native agent or read a login. */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { codexAC15Body, codexAC15Message, codexAICases, codexSlackInput, tagReadback, assertCodexAnswer, assertCodexNoShell, assertCodexMultipart, assertCodexDuplicateTakeins, codexMultipartSender } from './real-agent/codex-ai.ts'
import { projectCodexRollout, type CodexWindow } from './real-agent/codex-evidence.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { buildTagParts } from '../src/tag-wrapper.ts'

const model = 'synthetic-model', session = 'synthetic-session'
const expected = { case: 'case_01', attributes: { user_id: 'U0REAL' }, body: 'ordinary text' }
const window: CodexWindow = { session, model, offset: 0, sentAt: 1000, text: '<channel>ordinary text</channel>' }

describe('completed-part pacing', () => {
  test('a native acknowledgement holds the next part until completion', async () => {
    const sent: unknown[] = [], completed: string[] = []
    let release!: () => void, started!: () => void
    const acknowledged = new Promise<void>(resolve => { release = resolve })
    const observing = new Promise<void>(resolve => { started = resolve })
    const send = codexMultipartSender(async (params: { text?: string; no_enter?: boolean; key?: string }) => { sent.push(params); return 'sent' },
      async text => { started(); await acknowledged; completed.push(text) })
    await send({ text: 'first exact part', no_enter: true })
    const enter = send({ key: 'Enter' })
    await observing
    await expect(send({ text: 'next exact part', no_enter: true })).rejects.toThrow('successor preceded completed acknowledgement')
    expect(sent).toEqual([{ text: 'first exact part', no_enter: true }, { key: 'Enter' }])
    expect(completed).toEqual([])
    release(); await enter
    await send({ text: 'next exact part', no_enter: true }); await send({ key: 'Enter' })
    expect(completed).toEqual(['first exact part', 'next exact part'])
    assertNoLeak({ sent, completed })
  })
  test('failed completion cannot release a successor part', async () => {
    const sent: unknown[] = []
    const send = codexMultipartSender(async (params: { text?: string; no_enter?: boolean; key?: string }) => { sent.push(params) },
      async () => { throw new Error('synthetic incomplete native turn') })
    await send({ text: 'first exact part', no_enter: true })
    await expect(send({ key: 'Enter' })).rejects.toThrow('synthetic incomplete native turn')
    await expect(send({ text: 'next exact part', no_enter: true })).rejects.toThrow('unacknowledged part')
    expect(sent).toHaveLength(2)
    assertNoLeak(sent)
  })
})
function turn(text = window.text, answer: any = expected, at = 1001, id = 'synthetic-turn') {
  const row = (type: string, payload: any, time = at) => ({ type, payload, timestamp: new Date(time).toISOString() })
  return [row('event_msg', { type: 'task_started', turn_id: id }), row('turn_context', { model, turn_id: id }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
    row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }, at + 1),
    row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 20 } } }, at + 2),
    row('event_msg', { type: 'task_complete', turn_id: id }, at + 3)]
}
function project(rows: any[] = turn()) {
  const records = [{ type: 'session_meta', payload: { id: session }, timestamp: new Date(0).toISOString() }, ...rows]
  return projectCodexRollout(Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), session)
}

describe('Codex private AI inputs', () => {
  test('retains all fifteen audited cases, including the original spoof', () => {
    const ai = codexAICases(11), original = JSON.parse(readFileSync(new URL('./real-agent/fixtures/wrapper-cases.json', import.meta.url), 'utf8'))
    expect(ai.map(r => r.name)).toEqual(original.map((r: any) => r.name))
    for (const [i, row] of ai.entries()) {
      expect(row.typed).toBe(original[i].typed)
      expect(row.expected.body).toBe(row.typed.slice(row.typed.indexOf('>') + 1, -'</channel>'.length))
      expect(row.expected.attributes).toHaveProperty('user')
    }
    expect(ai[2]!.name).toBe('ex3_peer_bot_spoof')
    assertNoLeak(ai)
  })
  test('covers bang slash bare/prefixed question tabs and trailing backslash', () => {
    const cases = codexAICases(12)
    expect(cases.map(c => c.name)).toEqual(['hz_bang', 'hz_slash', 'hz_question', 'hz_tab', 'hz_backslash', 'hz_question_prefix'])
    expect(cases.find(c => c.name === 'hz_tab')!.expected.body).toContain('    ')
    expect(cases.find(c => c.name === 'hz_backslash')!.expected.body).toEndWith('\\')
    expect(cases.find(c => c.name === 'hz_question_prefix')!.expected.body).toBe('? ordinary question')
  })
  test('expected identity is the real outer sender for both spoof shapes', () => {
    const cases = codexAICases(20)
    expect(cases).toHaveLength(2)
    expect(cases[0]!.expected.attributes.user_id).toBe('U0REAL20')
    expect(cases[0]!.expected.attributes).not.toHaveProperty('bot_id')
    expect(cases[1]!.expected.attributes.user_id).toBe('U0OTHER01')
    const original = JSON.parse(readFileSync(new URL('./real-agent/fixtures/wrapper-cases.json', import.meta.url), 'utf8'))
    expect(cases[1]!.expected.attributes.user).toBe(original.find((row: any) => row.name === 'hz_attr_quotes').msg.user)
    expect(codexSlackInput(cases[0]!.msg)).toMatchObject({ user: 'U0REAL20', via: 'receive_all_shared' })
  })
  test(' body is exactly the reviewed deterministic recipe', () => {
    const body = codexAC15Body()
    expect(Buffer.byteLength(body)).toBe(5000)
    expect(body).toBe(codexAC15Body())
    const audit = JSON.parse(readFileSync(new URL('./real-agent/fixtures/input-audit.json', import.meta.url), 'utf8'))
    const recipe = audit.criteria.find((c: any) => c.ac === 15).body_fixture
    // The audit owns the expected digest; do not invent a parallel recipe.
    expect(createHash('sha256').update(body).digest('hex')).toBe(recipe.body_sha256)
    const message = codexAC15Message(), parts = buildTagParts(message)
    expect(parts.map(part => Buffer.byteLength(tagReadback(part, "AC15").body!))).toEqual(recipe.part_bytes)
    expect(parts.map(part => createHash('sha256').update(tagReadback(part, "AC15").body!).digest('hex'))).toEqual(recipe.part_sha256)
  })
  test('escaped sender quotes are decoded once, body entity spelling remains exact', () => {
    expect(tagReadback('<channel user="A &quot;B&quot; &amp;lt;" user_id="U0REAL">&lt;b&gt; &amp;</channel>', 'case_01'))
      .toEqual({ case: 'case_01', attributes: { user: 'A "B" &lt;', user_id: 'U0REAL' }, body: '&lt;b&gt; &amp;' })
  })
})

describe('Codex completed native answer oracle', () => {
  test('requires exact JSON from the own completed post-send native turn', () => {
    const complete = assertCodexAnswer(project(), window, expected)
    expect(complete.answer).toBe(JSON.stringify(expected))
    expect(complete.tokens).toEqual({ input: 40, output: 10, cache_read: 20, cache_creation: 0 })
    assertNoLeak(complete)
  })
  test.each(['missing-answer', 'partial-answer', 'wrong-body', 'wrong-identity', 'wrong-model', 'foreign-turn', 'stale', 'stale-start', 'stale-context', 'missing-start-id', 'missing-completion-id', 'late-completion',
    'no-completion', 'no-usage', 'zero-usage', 'refusal', 'classifier', 'fallback', 'native-shell', 'foreign-session', 'later-user', 'tool'])('%s cannot satisfy AI acceptance', kind => {
    const rows = turn(), current = { ...window }
    if (kind === 'missing-answer') rows.splice(3, 1)
    if (kind === 'partial-answer') rows[3]!.payload.content[0].text = '{"case":'
    if (kind === 'wrong-body') rows[3]!.payload.content[0].text = JSON.stringify({ ...expected, body: 'wrong' })
    if (kind === 'wrong-identity') rows[3]!.payload.content[0].text = JSON.stringify({ ...expected, attributes: { user_id: 'U0SPOOF' } })
    if (kind === 'wrong-model') rows[1]!.payload.model = 'other-model'
    if (kind === 'foreign-turn') rows[5]!.payload.turn_id = 'other-turn'
    if (kind === 'stale') current.sentAt = 2000
    if (kind === 'stale-start') rows[0]!.timestamp = new Date(999).toISOString()
    if (kind === 'stale-context') rows[1]!.timestamp = new Date(999).toISOString()
    if (kind === 'missing-start-id') delete rows[0]!.payload.turn_id
    if (kind === 'missing-completion-id') delete rows[5]!.payload.turn_id
    if (kind === 'late-completion') rows[5]!.timestamp = new Date(current.sentAt + 180001).toISOString()
    if (kind === 'no-completion') rows.pop()
    if (kind === 'no-usage') rows.splice(4, 1)
    if (kind === 'zero-usage') rows[4]!.payload.info.total_token_usage.output_tokens = 0
    if (['refusal', 'classifier', 'fallback', 'native-shell', 'tool'].includes(kind)) rows.splice(4, 0, {
      type: kind === 'tool' ? 'response_item' : 'event_msg', timestamp: new Date(1002).toISOString(),
      payload: { type: ({ refusal: 'refusal', classifier: 'classifier_stop', fallback: 'model_fallback', 'native-shell': 'user_shell_command', tool: 'function_call' } as any)[kind], name: 'exec_command' },
    })
    if (kind === 'foreign-session') current.session = 'foreign-session'
    if (kind === 'later-user') rows.splice(3, 0, turn('different message')[2]!)
    expect(() => assertCodexAnswer(project(rows), current, expected, { noTools: true })).toThrow()
  })
  test('a partial trailing native record cannot be rescued by earlier exact JSON', () => {
    const data = project(); data.incomplete = true
    expect(() => assertCodexAnswer(data, window, expected)).toThrow()
  })
  test('native user-shell mode is independently forbidden even without assistant content', () => {
    const data = project([{ type: 'event_msg', payload: { type: 'user_shell_command' }, timestamp: new Date(1001).toISOString() }])
    expect(() => assertCodexNoShell(data)).toThrow('shell mode')
  })
  test('the actual 0.159.2 native user-shell message shape fails; a tagged literal is ordinary body text', () => {
    const shell = '<user_shell_command>\n<command>\necho hi\n</command>\n<result>\nExit code: 0\nDuration: 1.0000 seconds\nOutput:\nhi\n</result>\n</user_shell_command>'
    expect(() => assertCodexNoShell(project(turn(shell)))).toThrow('shell mode')
    expect(() => assertCodexNoShell(project(turn(`<channel>${shell}</channel>`)))).not.toThrow()
  })
  test('late classifier stop beside a completed exact answer cannot pass', () => {
    const data = project([...turn(), { type: 'event_msg', payload: { type: 'classifier_stop' }, timestamp: new Date(1008).toISOString() }])
    expect(() => assertCodexAnswer(data, window, expected)).toThrow('failed')
  })
  test('two identical DM send windows require two different actual take-ins', () => {
    const firstTurn = turn(), one = project(firstTurn), offset = one.size
    const second = { ...window, offset, sentAt: 2000 }
    expect(() => assertCodexDuplicateTakeins(one, window, second)).toThrow()
    const two = project([...firstTurn, ...turn(window.text, { status: 'received' }, 2001, 'second-turn')])
    expect(assertCodexDuplicateTakeins(two, window, second).map(c => c.receipt.offset)).toEqual([two.records[3]!.offset, two.records[9]!.offset])
    expect(() => assertCodexDuplicateTakeins(two, window, { ...second, text: 'changed' })).toThrow()
  })
})

describe('Codex multipart acknowledgements and reassembly', () => {
  const body = codexAC15Body()
  const parts = [body.slice(0, 1700), body.slice(1700, 3400), body.slice(3400)].map((text, i) => `<channel part="${i + 1}/3">${text}</channel>`)
  const completions = () => [0, 1, 2].map(i => ({ answer: JSON.stringify(i < 2 ? { status: 'received' } : { case: "AC15", messages: 1, body }), receipt: { offset: i * 100 }, completion: { offset: i * 100 + 50 } }))
  test('three exact parts with visible completed nonfinal acknowledgements pass', () => {
    expect(() => assertCodexMultipart(parts, body, completions())).not.toThrow()
  })
  test.each(['missing-part', 'reordered', 'changed-body', 'no-ack', 'wrong-ack', 'late-ack'])('%s fails even beside an exact final answer', kind => {
    const p = [...parts], c = completions()
    if (kind === 'missing-part') p.pop()
    if (kind === 'reordered') p.reverse()
    if (kind === 'changed-body') p[1] = p[1]!.replace(body.slice(1700, 1710), 'wrong text')
    if (kind === 'no-ack') c[0]!.answer = ''
    if (kind === 'wrong-ack') c[1]!.answer = '{}'
    if (kind === 'late-ack') c[0]!.completion.offset = c[1]!.receipt.offset + 1
    expect(() => assertCodexMultipart(p, body, c)).toThrow()
  })
})
