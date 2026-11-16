import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertNativeSpoofResponse } from './real-agent/ai-classifier-stop.ts'
import { captureFailureEvidence, claudeFailureRecords, diagnosticValue, emitFailureEvidence, projectClaudeFailure, projectCodexFailure, projectFailureState, scenarioFailureRecords, retainFailureLine, scrubDiagnosticText } from './real-agent/ai-failure-diagnostics.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX, writtenFile } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const model = 'test/model'
const valid = (): any => ({ uuid: 'response', message: { role: 'assistant', model, content: [{ type: 'text', text: 'PRIVATE MESSAGE' }], stop_reason: 'end_turn' } })
// Frozen pre-change predicates: diagnostics must preserve their truth values,
// including truthiness versus strict true and the optional requestedModel.
function legacy(v: any) {
  const m = v.message
  return Array.isArray(m?.content) && typeof v.uuid === 'string' && v.isMeta !== true && !v.isApiErrorMessage && !v.error && !v.isSynthetic
    && m?.role === 'assistant' && m.model === model && (v.requestedModel === undefined || v.requestedModel === model)
    && m.content.every((b: any) => b && typeof b === 'object' && typeof b.type === 'string')
    && (m.stop_reason === null || m.stop_reason === 'tool_use' || m.stop_reason === 'end_turn')
}
const fields = ['uuid', 'isMeta', 'isApiErrorMessage', 'error', 'isSynthetic', 'requestedModel', 'message.role', 'message.model', 'message.stop_reason', 'message.content']
const values = [undefined, null, false, true, 0, 1, '', 'assistant', model, '<synthetic>', 'tool_use', 'end_turn', 'refusal', [], {}, [null], ['text'], [{ type: 1 }], [{ type: 'text', text: 'PRIVATE MESSAGE' }]]
for (const field of fields) test(`metadata split preserves every old outcome for ${field}`, () => {
  for (const value of values) {
    const v = valid(), [parent, child] = field.split('.')
    if (child) v[parent!][child] = value; else v[parent!] = value
    let accepted = true, error: unknown
    try { assertNativeSpoofResponse(v, model) } catch (e) { accepted = false; error = e }
    expect(accepted).toBe(Boolean(legacy(v)))
    if (!accepted) { expect(String(error)).toContain(field === 'message.content' ? 'message.content.' : field + '='); expect(String(error)).not.toContain('PRIVATE MESSAGE') }
  }
})

test('streaming/null and tool-use stop reasons keep their original metadata acceptance', () => {
  for (const stop_reason of [null, 'tool_use', 'end_turn']) {
    const v = valid(); v.message.stop_reason = stop_reason
    expect(() => assertNativeSpoofResponse(v, model)).not.toThrow()
  }
})

test('each safe field failure is emitted once across separate poll processes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-dedupe-'))
  try {
    const helper = resolve('tests/real-agent/ai-failure-diagnostics.ts'), file = join(root, 'seen.json')
    const script = `import { reportFailureOnce } from ${JSON.stringify(helper)}; reportFailureOnce(process.argv[1], process.argv[2], console.log)`
    const results = ['isApiErrorMessage=true', 'isApiErrorMessage=true', 'message.stop_reason="refusal"', 'message.stop_reason="refusal"'].map(message =>
      spawnSync(process.execPath, ['-e', script, file, message], { env: hostSafeChildEnv(root), encoding: 'utf8' }))
    expect(results.map(r => r.status)).toEqual([0, 0, 0, 0])
    expect(results.map(r => r.stdout.trim())).toEqual(['isApiErrorMessage=true', '', 'message.stop_reason="refusal"', ''])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('metadata diagnostics withhold message-shaped values and scrub tokens', () => {
  const result = { object: diagnosticValue({ text: 'PRIVATE MESSAGE' }), text: diagnosticValue('PRIVATE MESSAGE'),
    token: diagnosticValue(fakeToken('sk-')),
    scrubbed: scrubDiagnosticText('answer secret-value Bearer abc123 access_token="unlisted-value"', { API_KEY: 'secret-value' }) }
  assertNoLeak(result)
  expect(result).toEqual({ object: '<object>', text: '<string withheld>', token: '[REDACTED]',
    scrubbed: 'answer [REDACTED] Bearer [REDACTED] access_token="[REDACTED]"' })
})

function entry(offset: number, value: any, path = '/private/session.jsonl'): TranscriptEntry {
  return { offset, path, value, at: offset, kind: 'other' }
}

test.each(['user string', 'user blocks', 'queued string', 'queued blocks'])('%s notification retention keeps linkage only and scrubs IDs', async shape => {
  const root = mkdtempSync(join(tmpdir(), 'notification-evidence-'))
  try {
    const transcripts = join(root, 'transcripts'); mkdirSync(transcripts)
    const secret = fakeToken('sk-'), text = `<task-notification><task-id>child</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>PRIVATE SUMMARY</summary><result>PRIVATE ${secret}</result></task-notification>`
    const content = shape.endsWith('blocks') ? [{ type: 'text', text }, { type: 'image', source: secret }] : text
    const value = shape.startsWith('queued')
      ? { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', taskId: 'child', agentId: 'owner', source_uuid: 'notification', prompt: content } }
      : { type: 'user', message: { content } }
    writeFileSync(join(transcripts, 'session.jsonl'), JSON.stringify(value) + '\n' + JSON.stringify(value).replaceAll('child', secret) + '\n')
    const records = await scenarioFailureRecords(transcripts, 'claude')
    for (const record of records) retainFailureLine(root, 'real-agent-failure-evidence: ' + JSON.stringify({ event: 'transcript', record }), v => v)
    const output = readFileSync(join(root, 'real-agent-failures.jsonl'), 'utf8')
    const retained = output.trim().split('\n').map(line => JSON.parse(line).record)
    expect(retained[0].notification).toEqual({ 'task-id': 'child', 'tool-use-id': 'agent-call', status: 'completed' })
    expect(retained[1].notification['task-id']).toBe('[REDACTED]')
    if (shape.startsWith('queued')) expect(retained[0].attachment).toEqual({ type: 'queued_command', commandMode: 'task-notification', taskId: 'child', agentId: 'owner', source_uuid: 'notification' })
    expect(output).not.toContain('PRIVATE'); expect(output).not.toContain(secret)
    assertNoLeak({ records, retained, output, file: writtenFile(join(root, 'real-agent-failures.jsonl')) })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each(['rate_limit_exceeded', 'server_overloaded', 'internal_server_error', 'unauthorized',
  { http_connection_failed: { http_status_code: 503 } },
  { response_stream_connection_failed: { http_status_code: 429 } },
  { response_stream_disconnected: { http_status_code: null } },
  { response_too_many_failed_attempts: { http_status_code: 502 } },
  { active_turn_not_steerable: { turn_kind: 'compact' } },
])('Codex retains native error classification %j on error events and failed completion', codex_error_info => {
  const error = { message: 'PRIVATE', codex_error_info }
  const direct = projectCodexFailure(entry(10, { type: 'event_msg', payload: { type: 'error', ...error } }))
  const terminal = projectCodexFailure(entry(20, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', error } }))
  expect(direct.payload).toMatchObject({ type: 'error', message: '<text withheld>', codex_error_info })
  expect(terminal.payload).toMatchObject({ type: 'task_complete', turn_id: 'turn', error: { message: '<text withheld>', codex_error_info } })
  expect(JSON.stringify([direct, terminal])).not.toContain('PRIVATE')
})

test.each(['claude', 'codex'] as const)('%s preserves structured error facts through capture and retention without free text or tokens', async agent => {
  const root = mkdtempSync(join(tmpdir(), 'native-error-')), transcripts = join(root, 'transcripts')
  try {
    mkdirSync(transcripts)
    const secret = fakeToken('sk-'), error = { type: 'rate_limit_error', code: 'rate_limit_exceeded', status: 429,
      http_status: 429, status_code: 429, retryable: true, retry_after_ms: 3000, attempt: 0,
      cause: { name: 'APIError', code: secret, errno: 'ECONNRESET', retryable: false,
        response: { statusCode: 503, headers: { authorization: secret }, body: 'PRIVATE BODY' } },
      error: { type: 'overloaded_error', message: 'PRIVATE MESSAGE' },
      codex_error_info: { response_stream_disconnected: { http_status_code: null } },
      message: 'PRIVATE', details: { request: secret }, additional_details: 'PRIVATE DETAIL', stack: 'PRIVATE STACK',
      access_token: secret, request: { body: 'PRIVATE PROMPT' }, unknown: 'PRIVATE UNKNOWN' }
    const expected = { type: 'rate_limit_error', code: 'rate_limit_exceeded', status: 429, http_status: 429,
      status_code: 429, retryable: true, retry_after_ms: 3000, attempt: 0,
      cause: { name: 'APIError', code: '[REDACTED]', errno: 'ECONNRESET', retryable: false, response: { statusCode: 503 } },
      error: { type: 'overloaded_error', message: '<text withheld>' },
      codex_error_info: { response_stream_disconnected: { http_status_code: null } },
      message: '<text withheld>', details: '<text withheld>', additional_details: '<text withheld>', stack: '<text withheld>' }
    const value = agent === 'claude'
      ? { type: 'assistant', isApiErrorMessage: true, error, message: { role: 'assistant', error, content: 'PRIVATE TEXT' } }
      : { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', error } }
    writeFileSync(join(transcripts, 'session.jsonl'), JSON.stringify(value) + '\n')
    const records = await scenarioFailureRecords(transcripts, agent)
    for (const record of records) retainFailureLine(root, 'real-agent-failure-evidence: ' + JSON.stringify({ event: 'transcript', record }), v => v)
    const text = readFileSync(join(root, 'real-agent-failures.jsonl'), 'utf8'), retained = JSON.parse(text).record
    if (agent === 'claude') { expect(retained.error).toEqual(expected); expect(retained.message.error).toEqual(expected) }
    else expect(retained.payload.error).toEqual(expected)
    expect(text).not.toContain('PRIVATE'); expect(text).not.toContain(secret)
    assertNoLeak({ records, retained, text, file: writtenFile(join(root, 'real-agent-failures.jsonl')) })
    expect(statSync(join(root, 'real-agent-failures.jsonl')).mode & 0o777).toBe(0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('error projection keeps null/false and fails closed for malformed, deep or text-shaped metadata', () => {
  for (const error of [null, false, 'refusal']) expect(projectClaudeFailure(entry(0, { error }))).toMatchObject({ error })
  const cyclic: any = { code: 'bounded' }; cyclic.cause = cyclic
  const result = projectCodexFailure(entry(0, { payload: { error: cyclic, codex_error_info: ['PRIVATE'],
    code: 'PRIVATE CODE', status: { message: 'PRIVATE' }, retryable: false } }))
  const text = JSON.stringify(result)
  expect(text).toContain('<error depth limit>'); expect(text).not.toContain('PRIVATE')
  expect(result.payload).toMatchObject({ code: '<string withheld>', status: '<object>', retryable: false, codex_error_info: '<array>' })
})

test('case projection retains scrubbed assistant/tool text and excludes prompts and foreign sessions', () => {
  const v = valid(); Object.assign(v, { type: 'assistant', parentUuid: 'take', isApiErrorMessage: true, error: 'refusal', isSynthetic: true, isMeta: false })
  v.message.stop_reason = 'refusal'; v.message.model = '<synthetic>'
  v.message.content = [{ type: 'text', text: `refused ${fakeToken('sk-')}` }, { type: 'tool_use', name: 'Write', input: { content: `write ${fakeToken('sk-')}` } },
    { type: 'tool_use', name: 'mcp__slack-channel-router__reply', input: { text: `reply ${fakeToken(BOT_TOKEN_PREFIX)}` } }]
  const records = claudeFailureRecords([{ kind: 'sent', seq: 3, transcript_path: '/private/session.jsonl', transcript_size: 20 }],
    [entry(10, v), entry(20, { type: 'user', message: { content: 'PRIVATE PROMPT' } }), entry(30, v), entry(31, v, '/foreign/session.jsonl')], 3)
  expect(records).toHaveLength(2)
  expect(records[1]).toMatchObject({ type: 'assistant', isApiErrorMessage: true, isSynthetic: true, error: 'refusal', message: { stop_reason: 'refusal', model: '<synthetic>' } })
  assertNoLeak(records)
  const text = JSON.stringify(records)
  for (const absent of ['PRIVATE PROMPT', 'fakeCredential123']) expect(text).not.toContain(absent)
  expect(text).toContain('Write'); expect(text).toContain('refused [REDACTED]'); expect(text).toContain('reply [REDACTED]')
  expect(text).toContain('write [REDACTED]')
})

test('failure JSONL keeps scrubbed reply/edit destinations and assistant text through both redaction stages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-evidence-')), transcripts = join(root, 'transcripts')
  try {
    mkdirSync(transcripts)
    const secret = fakeToken('sk-'), coordinatorSecret = 'coordinator-only-private-value'
    const text = `JSON read-back <@U0BOT> ${secret} ${coordinatorSecret}`
    const content = [
      ...['reply', 'edit_message'].map(name => ({ type: 'tool_use', name: `mcp__slack-channel-router__${name}`,
        input: { chat_id: 'C0TESTCHAN1', message_id: '1792000000.000300', text, files: ['PRIVATE FILE'] } })),
      { type: 'text', text: `Sent. ${secret}` },
      { type: 'thinking', thinking: 'PRIVATE THINKING', text: 'PRIVATE THINKING' },
      { type: 'tool_use', name: 'Write', input: { text: 'file data', content: 'file data' } },
      { type: 'tool_result', tool_use_id: 'post', content: 'PRIVATE RESULT' },
    ]
    writeFileSync(join(transcripts, 'session.jsonl'), [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'PRIVATE PROMPT' }] } },
      { type: 'assistant', message: { role: 'assistant', content } },
    ].map(v => JSON.stringify(v)).join('\n') + '\n')
    const lines: string[] = []
    await captureFailureEvidence('claude', transcripts, { scenario: 'ac11-retention' }, join(root, 'absent-states'), line => lines.push(line))
    const emitted = lines.join('\n')
    expect(emitted).not.toContain(secret)
    assertNoLeak({ lines, emitted })
    for (const line of lines) retainFailureLine(root, line, value => value.replaceAll(coordinatorSecret, '[COORDINATOR REDACTED]'))
    const retained = readFileSync(join(root, 'real-agent-failures.jsonl'), 'utf8')
    const blocks = retained.trim().split('\n').map(line => JSON.parse(line))
      .find(value => value.record?.type === 'assistant').record.message.content
    for (const block of blocks.slice(0, 2)) expect(block.input).toEqual({ chat_id: 'C0TESTCHAN1',
      message_id: '1792000000.000300', text: 'JSON read-back <@U0BOT> [REDACTED] [COORDINATOR REDACTED]' })
    expect(blocks[2].text).toBe('Sent. [REDACTED]')
    expect(blocks[4].input).toEqual({ text: 'file data', content: 'file data' })
    expect(retained).not.toContain('PRIVATE'); expect(retained).not.toContain(secret); expect(retained).not.toContain(coordinatorSecret)
    expect(statSync(join(root, 'real-agent-failures.jsonl')).mode & 0o777).toBe(0o600)
    assertNoLeak({ lines, emitted, retained, blocks, file: writtenFile(join(root, 'real-agent-failures.jsonl')) })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each(['recognizable', 'environment-known'] as const)(
  'retained %s text is scrubbed before the 4096-character bound and malformed reply fields stay withheld', kind => {
    const secret = fakeToken(kind === 'recognizable' ? 'sk-' : '', 'boundary')
    const prior = process.env.CSCB_DIAGNOSTIC_TEST_SECRET
    try {
      if (kind === 'environment-known') process.env.CSCB_DIAGNOSTIC_TEST_SECRET = secret
      const suffix = '[truncated]', prefixLimit = 4096 - suffix.length
      // Keep all but five credential characters inside the actual retained
      // prefix, including its leak sentinel. Truncate-first loses the full
      // opaque spelling needed by the environment-based scrubber.
      const prefix = 'a'.repeat(prefixLimit - secret.length + 4) + ' ', tail = ' ' + 'z'.repeat(5000)
      expect(prefix.length).toBeLessThan(prefixLimit)
      expect(prefix.length + secret.length).toBeGreaterThan(prefixLimit)
      const text = prefix + secret + tail
      const projected = projectClaudeFailure(entry(0, { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text },
        { type: 'tool_use', name: 'mcp__slack-channel-router__reply', input: { text, chat_id: text, message_id: text } },
        { type: 'tool_use', name: 'mcp__slack-channel-router__edit_message', input: { text: { private: secret }, chat_id: [secret], message_id: 3 } },
      ] } }))
      const blocks = projected.message.content as any[]
      assertNoLeak({ projected, blocks })
      expect(typeof blocks[0].text).toBe('string')
      expect(blocks[1].input).toBeDefined()
      const expected = (prefix + '[REDACTED]' + tail).slice(0, prefixLimit) + suffix
      for (const retained of [blocks[0].text, ...Object.values(blocks[1].input)]) {
        expect(typeof retained).toBe('string')
        expect((retained as string).length).toBe(4096)
        expect(retained).toBe(expected)
      }
      expect(blocks[2].input).toEqual({ text: '<object>', chat_id: '<array>', message_id: 3 })
    } finally {
      if (prior === undefined) delete process.env.CSCB_DIAGNOSTIC_TEST_SECRET
      else process.env.CSCB_DIAGNOSTIC_TEST_SECRET = prior
    }
  })

for (const kind of ['recognizable', 'environment-known'] as const) test.each(['short', 'boundary'])(
  `non-reply tool input retains a scrubbed ${kind} %s Bash command through failure JSONL`, async shape => {
    const root = mkdtempSync(join(tmpdir(), 'tool-input-evidence-')), transcripts = join(root, 'transcripts')
    const secret = fakeToken(kind === 'recognizable' ? 'sk-' : '', 'tool-input')
    const prior = process.env.CSCB_TOOL_INPUT_TEST_SECRET
    try {
      if (kind === 'environment-known') process.env.CSCB_TOOL_INPUT_TEST_SECRET = secret
      const suffix = '[truncated]', prefixLimit = 4096 - suffix.length
      const prefix = shape === 'boundary' ? 'a'.repeat(prefixLimit - secret.length + 4) + ' ' : 'printf %s '
      const tail = shape === 'boundary' ? ' ' + 'z'.repeat(5000) : ''
      if (shape === 'boundary') {
        expect(prefix.length).toBeLessThan(prefixLimit)
        expect(prefix.length + secret.length).toBeGreaterThan(prefixLimit)
      }
      const scrubbed = prefix + '[REDACTED]' + tail
      const expected = scrubbed.length > 4096 ? scrubbed.slice(0, prefixLimit) + suffix : scrubbed
      const value = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash',
        input: { command: prefix + secret + tail, description: `inspect ${secret}` } }] } }
      const projected = projectClaudeFailure(entry(0, value))
      assertNoLeak(projected)
      expect((projected.message.content as any[])[0].input?.command).toBe(expected)
      expect((projected.message.content as any[])[0].input.description).toBe('inspect [REDACTED]')
      mkdirSync(transcripts)
      writeFileSync(join(transcripts, 'session.jsonl'), JSON.stringify(value) + '\n')
      const lines: string[] = []
      await captureFailureEvidence('claude', transcripts, { scenario: 'tool-input' }, join(root, 'absent-states'), line => lines.push(line))
      assertNoLeak({ projected, lines })
      for (const line of lines) retainFailureLine(root, line, text => text)
      const path = join(root, 'real-agent-failures.jsonl'), retained = readFileSync(path, 'utf8')
      const record = retained.trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'transcript').record
      assertNoLeak({ projected, lines, record, retained, file: writtenFile(path) })
      expect(record.message.content[0].input.command).toBe(expected)
      expect(JSON.stringify(record.message.content[0].input).length).toBeLessThanOrEqual(16384)
    } finally {
      if (prior === undefined) delete process.env.CSCB_TOOL_INPUT_TEST_SECRET
      else process.env.CSCB_TOOL_INPUT_TEST_SECRET = prior
      rmSync(root, { recursive: true, force: true })
    }
  })

function toolBlockEvidence(blocks: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'tool-input-repair-'))
  try {
    const projected = projectClaudeFailure(entry(0, { type: 'assistant', message: { role: 'assistant', content: blocks } }))
    const lines: string[] = []
    emitFailureEvidence({ scenario: 'tool-input-repair' }, [projected], line => lines.push(line))
    for (const line of lines) retainFailureLine(root, line, text => text)
    const path = join(root, 'real-agent-failures.jsonl'), retained = readFileSync(path, 'utf8')
    const emitted = JSON.parse(lines[1]!.slice(lines[1]!.indexOf('{'))).record
    const record = retained.trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'transcript').record
    assertNoLeak({ projected, lines, emitted, record, retained, file: writtenFile(path) })
    return { projected, emitted, record }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const credentialStringMarker = '[REDACTED: credential-bearing string]'
test.each(['client', 'export', 'boundary', 'nested', 'description', 'key'])(
  'tool input string repair withholds %s quoted credentials through all evidence stages', shape => {
    const secret = fakeToken('', 'quoted-input')
    const command = shape === 'export' ? "export PASSWORD='prefix " + secret + "'"
      : shape === 'boundary' ? "client --password='prefix " + 'p '.repeat(2200) + secret + "'"
      : "client --password='prefix " + secret + "'"
    if (shape === 'boundary') {
      expect(command.indexOf('password')).toBeLessThan(4096)
      expect(command.indexOf(secret)).toBeGreaterThan(4096)
    }
    const input = shape === 'nested' ? { nested: [{ description: command }] }
      : shape === 'description' ? { description: command }
      : shape === 'key' ? { [command]: 'ignored' } : { command }
    const expected = shape === 'nested' ? { nested: [{ description: credentialStringMarker }] }
      : shape === 'description' ? { description: credentialStringMarker }
      : shape === 'key' ? { [credentialStringMarker]: '[REDACTED]' } : { command: credentialStringMarker }
    for (const record of Object.values(toolBlockEvidence([{ type: 'tool_use', name: 'Bash', input }]))) {
      expect(record.message.content[0].input).toEqual(expected)
    }
  })

test.each(['KeY', 'ToKeN', 'SeCrEt', 'PaSsWoRd', 'CrEdEnTiAl', 'AuThOrIzAtIoN', 'CoOkIe'])(
  'tool input string repair withholds the whole string containing %s anywhere', term => {
    const input = { nested: ['prefix-' + term + '-suffix ' + fakeToken('', 'unlisted-input')] }
    for (const record of Object.values(toolBlockEvidence([{ type: 'tool_use', name: 'Write', input }]))) {
      expect(record.message.content[0].input).toEqual({ nested: [credentialStringMarker] })
    }
  })

test.each(['echo LONG-OK > /tmp/omv-scratch/wa/long.txt', 'wc -c file'])(
  'tool input string repair preserves benign command %s exactly', command => {
    for (const record of Object.values(toolBlockEvidence([{ type: 'tool_use', name: 'Bash', input: { command } }]))) {
      expect(record.message.content[0].input).toEqual({ command })
    }
  })

test.each(['password-space', 'api-key-object', 'api-key-array', 'nested-sensitive-keys'])(
  'tool input repair structurally redacts %s through projection, emission and retained JSONL', shape => {
    const secret = fakeToken('', 'contextual-tool-input')
    const input = shape === 'password-space' ? { password: 'prefix ' + secret }
      : shape === 'api-key-object' ? { api_key: { value: secret } }
      : shape === 'api-key-array' ? { api_key: [secret] }
      : { nested: [{ PaSsWoRd: 'prefix ' + secret, API_KEY: { value: secret }, access_token: [secret],
        secret: { value: secret }, authorization: 'prefix ' + secret, cookie: [secret], credential: secret }] }
    for (const record of Object.values(toolBlockEvidence([{ type: 'tool_use', name: 'Write', input }]))) {
      const retained = record.message.content[0].input
      expect(retained).toEqual(shape === 'nested-sensitive-keys'
        ? { nested: [{ [credentialStringMarker]: '[REDACTED]' }] }
        : { [credentialStringMarker]: '[REDACTED]' })
    }
  })

test.each(['oversized', 'credential-string'])('tool input repair %s retains markers, never a preview', shape => {
  const input = { command: shape === 'oversized' ? '\u0000'.repeat(4096) : 'password="opaque"',
    password: 'prefix ' + fakeToken('', 'fallback') }
  for (const record of Object.values(toolBlockEvidence([{ type: 'tool_use', name: 'Bash', input }]))) {
    expect(record.message.content[0].input).toEqual(shape === 'oversized' ? { truncated: true }
      : { command: credentialStringMarker, [credentialStringMarker]: '[REDACTED]' })
  }
})

test.each(['mixed-large', 'many-small', 'escaped-text'])(
  'tool input repair aggregate record cap covers %s blocks through emission and retained JSONL', shape => {
    const blocks = Array.from({ length: 1000 }, (_, i) => shape === 'many-small'
      ? { type: 'tool_use', name: 'Bash', input: { command: 'true' } }
      : i % 3 === 0 ? { type: 'text', text: shape === 'escaped-text' ? '\u0000'.repeat(4096) : 'a'.repeat(4096) }
      : i % 3 === 1 ? { type: 'tool_use', name: 'Bash', input: { command: 'b'.repeat(4096) } }
      : { type: 'tool_use', name: 'mcp__slack-channel-router__reply', input: { chat_id: 'C0TESTCHAN1', message_id: '1.2', text: 'c'.repeat(4096) } })
    for (const record of Object.values(toolBlockEvidence(blocks))) {
      expect(JSON.stringify(record).length).toBeLessThanOrEqual(32768)
      expect(record.message.content.length).toBeLessThanOrEqual(32)
      expect(record.truncated).toBe(true)
      expect(record.message.content.length).toBeGreaterThan(0)
    }
  })

test.each(['claude', 'codex'] as const)('tool input repair aggregate cap also covers %s metadata', agent => {
  const value = { type: 'assistant', permission_denials: Array.from({ length: 1000 }, () => ({ tool_name: 'a'.repeat(256) })),
    error: { cause: { code: 'b'.repeat(256) } }, payload: { content: Array.from({ length: 1000 }, () => ({ type: 'text' })) },
    message: { role: 'assistant', content: [] } }
  const record = (agent === 'claude' ? projectClaudeFailure : projectCodexFailure)(entry(0, value))
  assertNoLeak(record)
  expect(JSON.stringify(record).length).toBeLessThanOrEqual(32768)
  expect(record.truncated).toBe(true)
})

test.each(['Write', 'Edit', 'mcp__other__tool'])('non-reply tool input preserves %s paths and nested string fields', name => {
  const input = { file_path: '/tmp/fixture.txt', nested: { text: 'input data' }, enabled: true }
  const projected = projectClaudeFailure(entry(0, { type: 'assistant', message: { role: 'assistant',
    content: [{ type: 'tool_use', name, input }] } }))
  assertNoLeak(projected)
  expect((projected.message.content as any[])[0].input).toEqual(input)
})

test('non-reply tool input bounds depth, field count, nodes and total serialized size while scrubbing keys', () => {
  let deep: unknown = { hidden: 'WITHHELD_AT_DEPTH' }
  for (let i = 0; i < 8; i++) deep = { next: deep }
  const inputs = [deep, Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, `value${i}`])),
    Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`branch${i}`,
      Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`leaf${j}`, 'node-value']))])),
    { command: '\u0000'.repeat(4096) }, { [fakeToken('sk-')]: fakeToken(BOT_TOKEN_PREFIX) },
    { api_key: fakeToken('', 'unlisted') }, Array.from({ length: 32 }, (_, i) => i)]
  const projected = projectClaudeFailure(entry(0, { type: 'assistant', message: { role: 'assistant',
    content: inputs.map(input => ({ type: 'tool_use', name: 'Bash', input })) } }))
  assertNoLeak(projected)
  const retained = (projected.message.content as any[]).map(block => block.input)
  expect(retained.every(input => input !== undefined)).toBe(true)
  for (const input of retained) expect(JSON.stringify(input).length).toBeLessThanOrEqual(16384)
  expect(JSON.stringify(retained[0])).not.toContain('WITHHELD_AT_DEPTH')
  expect(JSON.stringify(retained[0])).toContain('[truncated]')
  expect(retained[1].field15).toBe('value15'); expect(retained[1].field16).toBeUndefined()
  expect((JSON.stringify(retained[2]).match(/node-value/g) ?? []).length).toBeLessThanOrEqual(64)
  expect(JSON.stringify(retained[2])).toContain('[truncated]')
  expect(retained[3]).toEqual({ truncated: true })
  expect(retained[4]).toEqual({ '[REDACTED]': '[REDACTED]' })
  expect(retained[5]).toEqual({ [credentialStringMarker]: '[REDACTED]' })
  expect(retained[6]).toHaveLength(17)
  expect(retained[6][15]).toBe(15); expect(retained[6][16]).toBe('[truncated]')
})

test.each([[0, false], [1, false], [0, true]] as const)('shared cleanup retains every native case, initial status=%s, late failure=%s', (status, late) => {
  const root = mkdtempSync(join(tmpdir(), 'real-cleanup-')), scenario = join(root, 'scenario'), home = join(scenario, 'home')
  try {
    const transcripts = join(home, '.claude/projects/project'), side = join(transcripts, 'session/subagents')
    mkdirSync(side, { recursive: true })
    writeFileSync(join(transcripts, 'session.jsonl'), JSON.stringify({ ...valid(), type: 'assistant' }) + '\n')
    writeFileSync(join(side, 'agent-child.jsonl'), JSON.stringify({ type: 'user', agentId: 'child', sessionId: 'session', isSidechain: true,
      toolDenialKind: 'permission-rule', toolDenialEndsTurn: true, message: { content: [{ type: 'tool_result', tool_use_id: 'probe', is_error: true, content: 'PRIVATE RESULT' }] } }) + '\n')
    const harness = readFileSync(resolve('tests/integration/lib/scenario.sh'), 'utf8')
    const cleanup = harness.slice(harness.indexOf('_scenario_cleanup() {'), harness.indexOf('\n# ---------------------------------------------------------------------------\n# Polling', harness.indexOf('_scenario_cleanup() {')))
    const helper = join(root, 'capture.ts')
    // Exercise the actual shared shell hooks and exported capture; only the
    // production container-marker guard is replaced by this isolated adapter.
    writeFileSync(helper, `import { existsSync, readFileSync } from 'node:fs'; import { captureFailureEvidence, projectFailureState } from ${JSON.stringify(resolve('tests/real-agent/ai-failure-diagnostics.ts'))};
if (!existsSync(process.env.SCENARIO_ROOT!)) throw new Error('capture ran after cleanup');
const [command, agent, root, scenario, trial, panes] = process.argv.slice(2);
if (command === 'state') console.log(JSON.stringify(projectFailureState(JSON.parse(readFileSync(root, 'utf8')))));
else await captureFailureEvidence(agent, root, {scenario, trial}, panes);`)
    const personas = join(scenario, 'personas.jsonl')
    writeFileSync(personas, JSON.stringify({ name: 'native' }) + '\n')
    const script = join(root, 'cleanup.sh')
    writeFileSync(script, `set -eu
SCENARIO_FMK=0
_SCENARIO_STATE_DIRS=()
_SCENARIO_SERVER_PIDS=()
_SCENARIO_TRACKED_PIDS=()
_SCENARIO_EXIT_HOOKS=(${late ? 'late_failure' : ''})
_SCENARIO_BEFORE_CLEANUP_HOOKS=()
_SCENARIO_FAILURE_HOOKS=()
on_before_cleanup() { _SCENARIO_BEFORE_CLEANUP_HOOKS+=("$1"); }
on_failure() { _SCENARIO_FAILURE_HOOKS+=("$1"); }
late_failure() { return 1; }
persona_key() { printf '%s' "$1"; }
real_instance() { printf own-row; }
real_ad() { printf '%s' '{"state":"working","family_state":"working","pane":"PRIVATE PANE"}'; }
source ${JSON.stringify(resolve('tests/integration/lib/real-failure.sh'))}
REAL_FAILURE_HELPER=${JSON.stringify(helper)}
${cleanup}
trap _scenario_cleanup EXIT
exit ${status}
`)
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: hostSafeChildEnv(home, { tools: ['bash', 'bun', 'jq', 'rm'], extras: {
      SCENARIO_ROOT: scenario, SLACK_STATE_DIR: scenario, TEST_NAME: 'test-101-native', REAL_PERSONAS: personas, REAL_AGENT_TRIAL: '1',
    } }) })
    const failed = status !== 0 || late
    expect(result.status).toBe(failed ? 1 : 0)
    expect(result.stderr).toBe(late ? 'FAIL: test-101-native: exit hook late_failure failed (exit 1)\n' : '')
    expect(existsSync(scenario)).toBe(false)
    for (const line of result.stdout.split('\n')) retainFailureLine(root, line, v => v)
    const file = join(root, 'real-agent-failures.jsonl')
    expect(existsSync(file)).toBe(failed)
    if (failed) {
      const text = readFileSync(file, 'utf8'), records = text.trim().split('\n').map(line => JSON.parse(line))
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(records.filter(r => r.event === 'transcript')).toHaveLength(2)
      expect(text).toContain('permission-rule'); expect(text).toContain('child'); expect(text).toContain('end_turn')
      expect(records.find(r => r.event === 'ad-state').state).toEqual({ state: 'working', family_state: 'working' })
      expect(text).toContain('PRIVATE MESSAGE') // assistant text is retained
      expect(text).not.toContain('PRIVATE RESULT')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.each(['claude', 'codex'] as const)('recursive %s retention includes subagents, partial records, and no messages or symlink targets', async agent => {
  const root = mkdtempSync(join(tmpdir(), 'real-records-'))
  try {
    const transcripts = join(root, 'transcripts'), side = join(transcripts, 'session/subagents')
    mkdirSync(side, { recursive: true })
    const record = { type: 'user', subtype: 'denial', agentId: 'child', toolDenialKind: 'permission-rule',
      toolUseResult: { agentId: 'child', status: 'async_launched', isAsync: true },
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'PRIVATE COMMAND' } },
      message: { model, stop_reason: 'end_turn', content: '<task-notification><task-id>child</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><result>PRIVATE RESULT</result></task-notification>' },
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call', arguments: 'PRIVATE ARGS', content: [{ type: 'output_text', text: 'PRIVATE TEXT' }] } }
    writeFileSync(join(transcripts, 'session.jsonl'), JSON.stringify(record) + '\n')
    writeFileSync(join(side, 'agent-child.jsonl'), JSON.stringify(record) + '\n{unfinished')
    const foreign = join(root, 'foreign.jsonl')
    writeFileSync(foreign, JSON.stringify({ type: 'FOREIGN' }))
    symlinkSync(foreign, join(transcripts, 'linked.jsonl'))
    const records = await scenarioFailureRecords(transcripts, agent), text = JSON.stringify(records)
    expect(records).toHaveLength(3)
    expect(records.some(r => r !== null && typeof r === 'object' && 'malformed' in r && r.malformed)).toBe(true)
    expect(text).toContain('subagents/agent-child.jsonl')
    expect(text).toContain(agent === 'claude' ? 'permission-rule' : 'exec_command')
    if (agent === 'claude') { expect(text).toContain('agent-call'); expect(text).toContain('can_use_tool'); expect(text).toContain('async_launched') }
    expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('FOREIGN')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('AD failure evidence retains only structured state and withholds arbitrary fields', () => {
  for (const state of ['waiting', 'ask_user', 'check_permission', 'missing']) {
    expect(projectFailureState({ state, family_state: 'working', transcript_status: 'present', pane: 'PRIVATE', message: 'PRIVATE' }) as Record<string, unknown>)
      .toEqual({ state, family_state: 'working', transcript_status: 'present' })
  }
  expect(projectFailureState({ state: 'PRIVATE STATE', family_state: { text: 'PRIVATE' } }) as Record<string, unknown>).toEqual({ state: 'unreadable', family_state: '<object>' })
  expect(projectFailureState(null)).toEqual({ unavailable: true })
})

test('retention reprojects AD snapshots so stale raw panes and unknown fields never escape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-state-retention-'))
  try {
    const transcripts = join(root, 'transcripts'); mkdirSync(transcripts)
    const states = join(root, 'states.jsonl')
    writeFileSync(states, JSON.stringify({ state: 'waiting', instance: 'own-row', pane: 'PRIVATE', request: 'PRIVATE' }) + '\n')
    const lines: string[] = []
    await captureFailureEvidence('claude', transcripts, { scenario: 'state-control' }, states, line => lines.push(line))
    const evidence = lines.map(line => JSON.parse(line.slice('real-agent-failure-evidence: '.length)))
    expect(evidence.find(value => value.event === 'ad-state').state).toEqual({ state: 'waiting', instance: 'own-row' })
    expect(lines.join('\n')).not.toContain('PRIVATE')
    assertNoLeak(lines)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
