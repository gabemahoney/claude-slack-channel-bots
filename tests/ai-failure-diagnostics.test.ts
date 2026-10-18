import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertNativeSpoofResponse } from './real-agent/ai-classifier-stop.ts'
import { claudeFailureRecords, diagnosticValue, retainFailureLine, scrubDiagnosticText } from './real-agent/ai-failure-diagnostics.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
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
  expect(diagnosticValue({ text: 'PRIVATE MESSAGE' })).toBe('<object>')
  expect(diagnosticValue('PRIVATE MESSAGE')).toBe('<string withheld>')
  expect(diagnosticValue(fakeToken('sk-'))).toBe('[REDACTED]')
  expect(scrubDiagnosticText('answer secret-value Bearer abc123 access_token="unlisted-value"', { API_KEY: 'secret-value' }))
    .toBe('answer [REDACTED] Bearer [REDACTED] access_token="[REDACTED]"')
})

function entry(offset: number, value: any, path = '/private/session.jsonl'): TranscriptEntry {
  return { offset, path, value, at: offset, kind: 'other' }
}
test('case projection retains synthetic/error metadata and replies, excludes prompts, tool arguments and foreign sessions', () => {
  const v = valid(); Object.assign(v, { type: 'assistant', parentUuid: 'take', isApiErrorMessage: true, error: 'refusal', isSynthetic: true, isMeta: false })
  v.message.stop_reason = 'refusal'; v.message.model = '<synthetic>'
  v.message.content = [{ type: 'text', text: `refused ${fakeToken('sk-')}` }, { type: 'tool_use', name: 'Write', input: { content: 'SECRET ARGUMENT' } },
    { type: 'tool_use', name: 'mcp__slack-channel-router__reply', input: { text: `reply ${fakeToken(BOT_TOKEN_PREFIX)}` } }]
  const records = claudeFailureRecords([{ kind: 'sent', seq: 3, transcript_path: '/private/session.jsonl', transcript_size: 20 }],
    [entry(10, v), entry(20, { type: 'user', message: { content: 'PRIVATE PROMPT' } }), entry(30, v), entry(31, v, '/foreign/session.jsonl')], 3)
  expect(records).toHaveLength(2)
  expect(records[1]).toMatchObject({ type: 'assistant', isApiErrorMessage: true, isSynthetic: true, error: 'refusal', message: { stop_reason: 'refusal', model: '<synthetic>' } })
  assertNoLeak(records)
  const text = JSON.stringify(records)
  for (const absent of ['PRIVATE PROMPT', 'SECRET ARGUMENT', 'fakeCredential123']) expect(text).not.toContain(absent)
  expect(text).toContain('Write'); expect(text).toContain('refused [REDACTED]'); expect(text).toContain('reply [REDACTED]')
})

test.each([0, 1])('actual cleanup hook retains failure evidence before deleting the scenario, exit=%s', status => {
  const root = mkdtempSync(join(tmpdir(), 'ai-cleanup-')), scenario = join(root, 'scenario')
  try {
    const harness = readFileSync(resolve('tests/integration/lib/scenario.sh'), 'utf8')
    const cleanup = harness.slice(harness.indexOf('_scenario_cleanup() {'), harness.indexOf('\n# ---------------------------------------------------------------------------\n# Polling', harness.indexOf('_scenario_cleanup() {')))
    const ai = readFileSync(resolve('tests/real-agent/ai-scenario.sh'), 'utf8')
    const hook = ai.slice(ai.indexOf('ai_failure_evidence() {'), ai.indexOf('\non_exit ai_failure_evidence'))
    const helper = join(root, 'capture.ts')
    writeFileSync(helper, `import { existsSync } from 'node:fs'; import { emitFailureEvidence, projectClaudeFailure } from ${JSON.stringify(resolve('tests/real-agent/ai-failure-diagnostics.ts'))};
if (!existsSync(process.env.SCENARIO_ROOT!)) throw new Error('capture ran after cleanup');
emitFailureEvidence({agent:'claude', criterion:'11', trial:'1', seq:3}, [projectClaudeFailure(${JSON.stringify(entry(30, { ...valid(), type: 'assistant' }))})]);`)
    const script = join(root, 'cleanup.sh')
    writeFileSync(script, `set -eu\nmkdir -p "$SCENARIO_ROOT"\nSCENARIO_FMK=0\n_SCENARIO_STATE_DIRS=()\n_SCENARIO_SERVER_PIDS=()\n_SCENARIO_TRACKED_PIDS=()\n_SCENARIO_EXIT_HOOKS=(ai_failure_evidence)\n${hook}\n${cleanup}\ntrap _scenario_cleanup EXIT\nexit ${status}\n`)
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: hostSafeChildEnv(root, { tools: ['bash', 'bun', 'mkdir', 'rm'], extras: {
      SCENARIO_ROOT: scenario, AI_FAILURE_HELPER: helper, SLACK_STATE_DIR: scenario, REAL_KEY: 'aiac11', AI_CRITERION: '11', REAL_AGENT_TRIAL: '1',
    } }) })
    expect(result.status).toBe(status); expect(result.stderr).toBe(''); expect(existsSync(scenario)).toBe(false)
    for (const line of result.stdout.split('\n')) retainFailureLine(root, line, v => v)
    expect(existsSync(join(root, 'ai-failures.jsonl'))).toBe(status !== 0)
    if (status) expect(readFileSync(join(root, 'ai-failures.jsonl'), 'utf8')).toContain('PRIVATE MESSAGE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
