/** Synthetic oracle controls only; never start a native agent or read a login. */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { codexAC15Body, codexAC15Message, codexAICases, codexSlackInput, tagReadback, assertCodexAnswer, assertCodexNoShell, assertCodexMultipart, assertCodexDuplicateTakeins, codexMultipartSender } from './real-agent/codex-ai.ts'
import { projectCodexRollout, type CodexWindow } from './real-agent/codex-evidence.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { buildTagParts } from '../src/tag-wrapper.ts'
import * as oracle from './real-agent/codex-ai.ts'
import * as evidence from './real-agent/codex-evidence.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'

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

describe('Codex driver completion diagnostics (synthetic; no native process)', () => {
  // Execute the actual driver functions/poll body, without its guarded entrypoint.
  function driver(kind: 'answer' | 'duplicate', data: ReturnType<typeof project> | ReturnType<typeof project>[], first = window, expectation: unknown = expected, activeCase?: string, secondWindow?: CodexWindow) {
    const source = readFileSync(new URL('./real-agent/codex-delivery.ts', import.meta.url), 'utf8')
    const extract = (name: string) => {
      const declaration = source.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?^\\}`, 'm'))?.[0]
      if (!declaration) throw new Error(`missing driver declaration: ${name}`)
      return declaration.replaceAll("(await import('./codex-ai.ts'))", 'oracle').replaceAll("await import('./codex-ai.ts')", 'deps.oracle')
    }
    const duplicate = source.slice(source.indexOf("    await poll('second actual exact DM take-in and completion'"), source.indexOf('    const actual = [...receipts.shimSends'))
    expect(duplicate).toContain('assertCodexDuplicateTakeins')
    let at = secondWindow?.sentAt ?? 1000, reads = 0
    const started = at
    const records: { label: string; value: any }[] = []
    const program = `
      const { oracle, evidence, data, first, record, Date, Bun, rollout } = deps;
      const paths = { model: '${model}' }, AC106_CASE = 'AC106';
      let aiCase = '${activeCase ?? (kind === 'answer' ? 'AI-AC11-case_01' : 'AI-AC106')}', stage = 'ai_11_0-idle';
      let fatalOracle;
      const item = { fixed: { parts: [first.text] }, records: [{ kind: 'sent', part: 1,
        session_id: first.session, transcript_size: first.offset, at: first.sentAt }] };
      const queue = { item: () => item }, key = 'synthetic';
      const second = deps.second;
      ${['throwFatalOracle', 'latchFatalOracle'].filter(name => source.includes(`function ${name}(`)).map(extract).join('\n')}
      ${extract('poll')}
      ${extract('completedItem')}
      return { run: async () => { ${kind === 'answer' ? 'return await completedItem(1, 1, deps.expected, true)' : duplicate} }, stage: () => stage };
    `
    const actual = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(program))({
      oracle, evidence, data, first, expected: expectation,
      second: secondWindow ?? { session, model, offset: 0, sentAt: 1000, text: first.text },
      record: (label: string, value: any) => { assertNoLeak(value); records.push({ label, value }) },
      Date: { now: () => at }, Bun: { sleep: async (ms: number) => { at += ms } },
      rollout: async () => ({ data: Array.isArray(data) ? data[Math.min(reads++, data.length - 1)] : (reads++, data) }),
    }) as { run(): Promise<unknown>; stage(): string }
    return { ...actual, records, elapsed: () => at - started, reads: () => reads }
  }

  test.each(['wrong-field', 'non-json', 'refusal-text'] as const)('completed %s fails at once with safe reason and field names', async kind => {
    const rows = turn()
    rows[3]!.payload.content[0].text = kind === 'wrong-field'
      ? JSON.stringify({ ...expected, attributes: { user_id: 'PRIVATE WRONG VALUE' } })
      : kind === 'non-json' ? '{PRIVATE MALFORMED ANSWER' : 'I cannot return PRIVATE REFUSAL TEXT'
    const d = driver('answer', project(rows))
    await expect(d.run()).rejects.toThrow()
    expect(d.records).toEqual([{ label: 'oracle', value: { case: 'case_01',
      reason: kind === 'wrong-field' ? 'read-back-differs' : 'answer-not-json', fields: kind === 'wrong-field' ? ['attributes.user_id'] : ['answer'] } }])
    expect(d.elapsed()).toBe(0); expect(d.reads()).toBe(1)
    expect(d.stage()).toBe('AI-AC11-case_01-native completion and answer oracle')
    expect(JSON.stringify(d.records)).not.toContain('PRIVATE')
  })
  test.each(['answer', 'duplicate'] as const)('incomplete %s reaches the unchanged bound with the actual failing step', async kind => {
    const rows = turn(); rows.pop()
    const d = driver(kind, project(rows))
    const step = kind === 'answer' ? 'native completion and answer oracle' : 'second actual exact DM take-in and completion'
    await expect(d.run()).rejects.toThrow(`${step}: observation incomplete within bound`)
    expect(d.elapsed()).toBe(180000)
    expect(d.records).toEqual([{ label: 'bound', value: { step, milliseconds: 180000 } }])
    expect(d.stage()).toBe(`${kind === 'answer' ? 'AI-AC11-case_01' : 'AI-AC106'}-${step}`)
  })
  test('AC106 completed take-in oracle rejection fails at once with safe names', async () => {
    // The second window completes, but the first window cannot establish an
    // independent take-in. AC106 checks receipts here, and checks JSON on its query.
    const d = driver('duplicate', project(), { ...window, sentAt: 1001 })
    await expect(d.run()).rejects.toThrow()
    expect(d.records).toEqual([{ label: 'oracle', value: { case: 'AC106', reason: 'duplicate-takeins-differ', fields: ['takeins'] } }])
    expect(d.elapsed()).toBe(0); expect(d.reads()).toBe(1)
    expect(d.stage()).toBe('AI-AC106-second actual exact DM take-in and completion')
  })
  test('exact completed JSON still passes and records completion without a rejection', async () => {
    const d = driver('answer', project())
    await expect(d.run()).resolves.toHaveProperty('answer', JSON.stringify(expected))
    expect(d.records.map(r => r.label)).toEqual(['rollout-model', 'completed-turn'])
    expect(d.elapsed()).toBe(0)
  })
  test.each(['AC15', 'AC106'])('%s acknowledgement rejection retains its case without a case field in expected JSON', async label => {
    const d = driver('answer', project(turn(window.text, { status: 'PRIVATE WRONG ACK' })), window, { status: 'received' }, `AI-${label}`)
    await expect(d.run()).rejects.toThrow()
    expect(d.records).toEqual([{ label: 'oracle', value: { case: label, reason: 'read-back-differs', fields: ['status'] } }])
    expect(d.elapsed()).toBe(0)
  })
  test('AC106 completed wrong count answer fails immediately', async () => {
    const d = driver('answer', project(turn(window.text, { case: 'AC106', messages: 2 })), window, { case: 'AC106', messages: 1 }, 'AI-AC106')
    await expect(d.run()).rejects.toThrow()
    expect(d.records).toEqual([{ label: 'oracle', value: { case: 'AC106', reason: 'read-back-differs', fields: ['messages'] } }])
    expect(d.elapsed()).toBe(0); expect(d.reads()).toBe(1)
    expect(d.stage()).toBe('AI-AC106-native completion and answer oracle')
  })
  test('invented answer keys and values never become diagnostic field names', async () => {
    const answer = { ...expected, attributes: { ...expected.attributes, 'PRIVATE ATTRIBUTE KEY': 'PRIVATE ATTRIBUTE VALUE' }, 'PRIVATE ROOT KEY': 'PRIVATE ROOT VALUE' }
    const d = driver('answer', project(turn(window.text, answer)))
    await expect(d.run()).rejects.toThrow()
    expect(d.records).toEqual([{ label: 'oracle', value: { case: 'case_01', reason: 'read-back-differs', fields: ['attributes'] } }])
    expect(JSON.stringify(d.records)).not.toContain('PRIVATE')
  })
  test('Codex corpus prompt separates decoded attributes from byte-exact BODY', () => {
    const source = readFileSync(new URL('./real-agent/codex-delivery.ts', import.meta.url), 'utf8')
    const prompt = source.split('\n').find(line => line.includes('For each received tagged message return one JSON object'))!
    expect(prompt).toContain('Return attribute values XML-decoded exactly once: &quot; becomes ", &lt; becomes <, &gt; becomes >, and &amp; becomes &.')
    expect(prompt).toContain('Transcribe BODY byte-exact, preserving every character, whitespace and entity spelling')
  })
  for (const poll of ['answer', 'duplicate'] as const) {
    test.each(['finishes', 'persists'] as const)(`round 3 ${poll}: partial trailing record %s`, async kind => {
      const firstRows = turn(), firstData = project(firstRows)
      const second = { ...window, offset: firstData.size, sentAt: 2000 }
      const rows = poll === 'answer' ? firstRows : [...firstRows, ...turn(window.text, expected, 2001, 'second-turn')]
      const records = [{ type: 'session_meta', payload: { id: session }, timestamp: new Date(0).toISOString() }, ...rows]
      const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'bookkeeping' }, timestamp: new Date(2009).toISOString() })
      const bytes = Buffer.from(records.map(row => JSON.stringify(row) + '\n').join('') + tail)
      const partial = projectCodexRollout(bytes, session)
      const finished = projectCodexRollout(Buffer.concat([bytes, Buffer.from('\n')]), session)
      expect(partial.incomplete).toBe(true); expect(finished.incomplete).toBe(false)
      expect(() => evidence.completedCodexTurn(partial, poll === 'answer' ? window : second)).toThrow('invalid completion evidence window')
      const d = driver(poll, kind === 'finishes' ? [partial, finished] : partial, window, expected, undefined, poll === 'duplicate' ? second : undefined)
      if (kind === 'finishes') {
        const result = await d.run()
        if (poll === 'answer') expect((result as any).answer).toBe(JSON.stringify(expected))
        expect(d.elapsed()).toBe(250); expect(d.reads()).toBe(2)
        expect(d.records.map(r => r.label)).toEqual(poll === 'answer' ? ['rollout-model', 'completed-turn'] : [])
      } else {
        await expect(d.run()).rejects.toThrow('observation incomplete within bound')
        expect(d.elapsed()).toBe(180000); expect(d.reads()).toBe(720)
        expect(d.records).toEqual([{ label: 'bound', value: { step: poll === 'answer' ? 'native completion and answer oracle' : 'second actual exact DM take-in and completion', milliseconds: 180000 } }])
      }
    })
    test.each(['refusal', 'refusal-block', 'classifier_stop', 'model_fallback', 'error', 'turn_aborted', 'wrong-model', 'missing-output', 'missing-completion-id'])(`round 2 ${poll}: terminal %s fails at once`, async kind => {
      const rows = turn()
      if (kind === 'wrong-model') rows[1]!.payload.model = 'PRIVATE-WRONG-MODEL'
      else if (kind === 'missing-output') rows.splice(3, 1)
      else if (kind === 'missing-completion-id') delete rows.at(-1)!.payload.turn_id
      else if (kind === 'refusal-block') rows[3]!.payload.content = [{ type: 'refusal', refusal: 'PRIVATE NATIVE REFUSAL' }]
      else {
        if (kind === 'error' || kind === 'turn_aborted') rows.pop()
        rows.splice(3, 0, { type: 'event_msg', timestamp: new Date(1002).toISOString(), payload: { type: kind, turn_id: 'synthetic-turn', message: 'PRIVATE NATIVE FAILURE' } })
      }
      const d = driver(poll, project(rows))
      await expect(d.run()).rejects.toThrow()
      const invalid = kind === 'missing-output' || kind === 'missing-completion-id'
      const reason = kind === 'wrong-model' ? 'model-mismatch' : invalid ? 'native-turn-invalid' : 'native-turn-failed'
      expect(d.records).toEqual([{ label: 'oracle', value: { case: poll === 'answer' ? 'case_01' : 'AC106', reason,
        fields: [kind === 'wrong-model' ? 'model' : invalid ? 'completion' : 'turn'] } }])
      expect(d.elapsed()).toBe(0); expect(d.reads()).toBe(1)
      expect(d.stage()).toBe(poll === 'answer' ? 'AI-AC11-case_01-native completion and answer oracle' : 'AI-AC106-second actual exact DM take-in and completion')
      expect(JSON.stringify(d.records)).not.toContain('PRIVATE')
    })
    test.each(['no-takein', 'no-terminal', 'foreign-terminal', 'fallback-without-terminal'])(`round 2 ${poll}: pending %s keeps its bound`, async kind => {
      const rows = turn()
      if (kind === 'no-takein') rows[2]!.payload.content[0].text = 'different input'
      else if (kind === 'foreign-terminal') rows.at(-1)!.payload.turn_id = 'foreign-turn'
      else rows.pop()
      if (kind === 'fallback-without-terminal') rows.push({ type: 'event_msg', timestamp: new Date(1002).toISOString(), payload: { type: 'model_fallback', turn_id: 'synthetic-turn' } })
      const d = driver(poll, project(rows))
      await expect(d.run()).rejects.toThrow('observation incomplete within bound')
      expect(d.elapsed()).toBe(180000)
      expect(d.records.map(r => r.label)).toEqual(['bound'])
    })
  }
})

describe('round 2 Codex multipart through the real engine (synthetic; no native process)', () => {
  test.each(['wrong-ack', 'incomplete'] as const)('%s escapes engine handling with the original part/check stage', async kind => {
    const source = readFileSync(new URL('./real-agent/codex-delivery.ts', import.meta.url), 'utf8')
    const extract = (name: string) => source.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?^\\}`, 'm'))![0].replaceAll("await import('./codex-ai.ts')", 'deps.oracle')
    const callback = source.slice(source.indexOf('    multipartSend = oracle.codexMultipartSender'), source.indexOf('\n    try {\n      stage = `${aiCase}-accept`'))
    expect(callback).toContain('answers.push(await completedItem')
    const send = source.slice(source.indexOf('    sendKeys: async (params: any) => {') + '    sendKeys: '.length, source.indexOf('\n    },\n  }),') + '\n    }'.length)
    expect(send).toContain('multipartSend(params)')
    let h!: EngineHarness, d!: { delivered(seq: number): Promise<unknown>; engineSend(params: any): Promise<unknown>; stage(): string }
    const records: { label: string; value: any }[] = []
    h = await makeEngineHarness({ configuredAgent: 'codex', clientFor: async key => ({
      get: (params: any) => h.client(key).get(params), sendKeys: (params: any) => d.engineSend(params),
    }) as any })
    try {
      h.p().row.agent = 'codex'; h.p().row.session_id = session
      const item = await h.accept('multipart input', 'alpha', [window.text, 'second part', 'third part'])
      const program = `
        const { evidence, queue, engines, rollout, Date, Bun, record, client } = deps;
        const oracle = deps.oracle, paths = { model: '${model}' }, key = 'alpha', AC15_CASE = 'AC15';
        const answers = [], after = 0, body = 'multipart input';
        let fatalOracle, aiCase = 'AI-AC15', stage = 'initial', multipartSend, crashBarrier = false;
        ${['throwFatalOracle', 'latchFatalOracle'].filter(name => source.includes(`function ${name}(`)).map(extract).join('\n')}
        ${['poll', 'completedItem', 'delivered'].map(extract).join('\n')}
        ${callback}
        return { delivered, engineSend: ${send}, stage: () => stage };
      `
      d = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(program))({
        evidence, oracle, queue: h.queue, engines: h.engine, client: h.client(),
        Date: { now: h.clock.now }, Bun: { sleep: (ms: number) => h.clock.advance(ms) },
        record: (label: string, value: any) => { assertNoLeak(value); records.push({ label, value }) },
        rollout: async () => {
          const sent = h.queue.item('alpha', item.accepted.seq)!.records.find((r: any) => r.kind === 'sent') as any
          const rows = turn(window.text, { status: 'PRIVATE WRONG ACK' }, sent.at + 1)
          if (kind === 'incomplete') rows.pop()
          // Preserve the production engine's captured transcript-size window.
          const bytes = [{ type: 'session_meta', payload: { id: session, padding: ' '.repeat(sent.transcript_size) } }, ...rows]
          return { data: projectCodexRollout(Buffer.from(bytes.map(row => JSON.stringify(row) + '\n').join('')), session) }
        },
      })
      const started = h.clock.now()
      await expect(d.delivered(item.accepted.seq)).rejects.toThrow(kind === 'wrong-ack' ? 'native JSON read-back differs' : 'native completion and answer oracle: observation incomplete within bound')
      const elapsed = h.clock.now() - started
      expect(kind === 'wrong-ack' ? elapsed < 1000 : elapsed >= 180000 && elapsed < 181000).toBe(true)
      expect(d.stage()).toBe('AI-AC15-part-1-native completion and answer oracle')
      expect(records.filter(r => r.label === 'oracle')).toEqual(kind === 'wrong-ack'
        ? [{ label: 'oracle', value: { case: 'AC15', reason: 'read-back-differs', fields: ['status'] } }] : [])
      expect(records.filter(r => r.label === 'bound').map(r => r.value.step)).toEqual(kind === 'incomplete' ? ['native completion and answer oracle'] : [])
      const calls = h.keyCalls().length
      await expect(d.engineSend({ text: 'later harness send', no_enter: true })).rejects.toThrow()
      expect(h.keyCalls()).toHaveLength(calls)
      await h.advance(20000)
      expect(h.keyCalls()).toHaveLength(calls)
      expect(h.textCalls()).toHaveLength(1)
      expect(records.filter(r => r.label === 'oracle')).toHaveLength(kind === 'wrong-ack' ? 1 : 0)
      assertNoLeak(records)
    } finally { await h.cleanup() }
  })
})

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
