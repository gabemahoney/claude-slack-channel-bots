import { expect, test } from 'bun:test'
import { denialSettled, MAIN_AGENT_PROBE_EXIT } from './real-agent/test-101-denial-settled.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'
import { createHash } from 'node:crypto'
import sourceAudit from './fixtures/native-denial-completion/notification-shapes-source.json'
import nullStops from './fixtures/test-101-denial-null-stops.json'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const shapes = ['user string', 'user blocks', 'queued string', 'queued blocks'] as const
function shapeNotification(e: ReturnType<typeof evidence>, shape: typeof shapes[number]) {
  const v = e.own[3]!.value
  if (v.type !== 'user') return // Negative queue bookkeeping must stay unconsumed.
  let content = v.message.content
  if (shape.endsWith('blocks')) content = [{ type: 'text', text: content }]
  if (shape.startsWith('queued')) {
    delete v.message
    v.type = 'attachment'; v.attachment = { type: 'queued_command', commandMode: 'task-notification', prompt: content }
  } else v.message.content = content
}

// case 8: a main Stop while an async Agent runs is not readiness.
function evidence() {
  const path = '/scenario/projects/work/session.jsonl'
  const entry = (offset: number, value: any, side = false): TranscriptEntry => ({ path: side ? '/scenario/projects/work/session/subagents/agent-agent1.jsonl' : path,
    offset, at: offset, kind: 'other', value: { sessionId: 'session', ...(side ? { isSidechain: true, agentId: 'agent1' } : {}), ...value } })
  const action = { label: 'busy', interactive: { channel: { id: 'D1' }, message: { ts: '1' }, actions: [{ action_id: 'perm_deny_cscb_busy_request1' }] } }
  const slack = [{ event: 'api', method: 'chat.postMessage', label: 'busy', channel: 'D1', response_ts: '1', ts: new Date(1).toISOString(), blocks: [
    { text: { text: '`printf subagent-deny-probe`' } }, { elements: [{ action_id: action.interactive.actions[0]!.action_id }] }] },
    { event: 'push', event_type: 'block_actions', label: 'busy', ts: new Date(2).toISOString() }]
  const decision = { event: 'api', method: 'chat.update', label: 'busy', channel: 'D1', response_ts: '1', text: '*Permission* — Denied by operator', answer: 'ok', status: 200, ts: new Date(4).toISOString() }
  slack.push(decision as any)
  const own = [entry(1, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'launch1', input: { prompt: 'Run printf subagent-deny-probe' } }] } }),
    entry(2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch1' }] }, toolUseResult: { agentId: 'agent1', isAsync: true, status: 'async_launched' } }),
    entry(5, { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }),
    entry(9, { type: 'user', message: { content: '<task-notification><task-id>agent1</task-id><tool-use-id>launch1</tool-use-id><status>completed</status></task-notification>' } }),
    entry(10, { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } })]
  const side = [entry(3, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash1', input: { command: 'printf subagent-deny-probe' } }] } }, true),
    entry(4, { type: 'user', toolDenialKind: 'permission-rule', message: { content: [{ type: 'tool_result', tool_use_id: 'bash1', is_error: true }] } }, true),
    entry(8, { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }, true)]
  return { action, slack, decision, own, side }
}
function observe(e: ReturnType<typeof evidence>) { return denialSettled('busy', e.action, e.slack, e.own, [...e.own, ...e.side]) }

test('b.tw6 cause A: kept failure settles with null sidechain stop reasons', () => {
  // Same reconstruction as define-bug's replay.ts: retained notifications hold
  // only headers, and Slack records are synthesized around the native denial.
  const all: TranscriptEntry[] = structuredClone(nullStops).map(record => {
    const { stream, offset, at, notification, ...value } = record as any
    if (notification) value.message.content = '<task-notification>'
      + Object.entries(notification).map(([key, v]) => `<${key}>${v}</${key}>`).join('') + '</task-notification>'
    return { path: `/scenario/home/.claude/projects/${stream}`, offset, at, kind: 'other', value }
  })
  const e = evidence(), denied = all.find(entry => entry.value.toolDenialKind === 'permission-rule')!
  e.slack.forEach((row, i) => { row.ts = new Date(denied.at - [800, 300, 50][i]!).toISOString() })
  const finals = all.filter(entry => entry.value.isSidechain && entry.value.type === 'assistant' && entry.at > denied.at)
  expect(finals.map(entry => entry.value.message.stop_reason)).toEqual([null, null])
  assertNoLeak(all)
  const result = denialSettled('busy', e.action, e.slack, all.filter(entry => !entry.value.isSidechain), all)
  expect(result).toMatchObject({ agent_id: 'a91d4f68f262c488c', session_id: '7ae56508-cbfe-479d-ab1d-d107584ee5ec',
    subagent_completed_at: 1794846628162, main_completed_at: 1794846636274 })
  assertNoLeak(result)
})

test.each([false, true])('b.tw6 cause B: main probe fails distinctly, later main end=%p', mainEnd => {
  // Minimal run2 trial 2 equivalent: completed subagent notification, then
  // the parent retries the denied Bash call and waits for its own permission.
  const e = evidence(), probe = structuredClone(e.own[0]!)
  probe.offset = 10; probe.at = 10
  probe.value.message = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', id: 'parent-bash', input: { command: 'printf subagent-deny-probe' } }] }
  e.own[4] = probe
  if (mainEnd) e.own.push({ ...probe, offset: 11, at: 11, value: { ...probe.value, message: { stop_reason: 'end_turn', content: [] } } })
  expect(() => observe(e)).toThrow('main agent ran the denied probe itself')
})

test.each([...shapes])('%s matching denial, sidechain completion and consumed main completion permit the idle check', shape => {
  const e = evidence(); shapeNotification(e, shape)
  e.side[2]!.value.message.stop_reason = null
  const result = observe(e)
  expect(result).toMatchObject({ request_token: 'request1', agent_id: 'agent1', session_id: 'session', subagent_completed_at: 9, main_completed_at: 10 })
  assertNoLeak(result)
})

test('synchronous completed Agent results still require sidechain completion', () => {
  const e = evidence()
  e.own[1]!.value.toolUseResult = { agentId: 'agent1', status: 'completed' }
  e.own.splice(3, 1)
  expect(observe(e)).toMatchObject({ subagent_completed_at: 8, main_completed_at: 10 })
  e.side.pop()
  expect(() => observe(e)).toThrow()
})

test.each(['foreign stream', 'foreign session', 'sidechain', 'other command'])('parent-probe guard excludes %s', variant => {
  const e = evidence(), probe = structuredClone(e.own[0]!)
  probe.offset = 11; probe.at = 11
  probe.value.message = { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'printf subagent-deny-probe' } }] }
  if (variant === 'foreign stream') probe.path = '/other/session.jsonl'
  if (variant === 'foreign session') probe.value.sessionId = 'other'
  if (variant === 'sidechain') probe.value.isSidechain = true
  if (variant === 'other command') probe.value.message.content[0].input.command = 'printf permission-probe'
  e.own.push(probe)
  expect(observe(e).main_completed_at).toBe(10)
})

test.each(['complete', 'pending then complete', 'parent probe'])('actual settle shell polling handles %s', outcome => {
  const shell = readFileSync(join(import.meta.dir, 'real-agent/test-101-fmk-real-busy.sh'), 'utf8')
  const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
  const settle = shell.match(/^busy_denial_settled\(\) \{[\s\S]*?^\}/m)?.[0]
  const call = shell.match(/^wait_until 180 'denied subagent did not settle[^\n]*\\\n[^\n]*/m)?.[0]
  expect(settle).toBeDefined(); expect(call).toBeDefined()
  const functions = ['fail', '_scenario_poll_until', '_scenario_check_timeout', 'wait_until'].map(name => {
    const body = scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0]
    expect(body).toBeDefined()
    return body
  }).join('\n')
  const root = mkdtempSync(join(tmpdir(), 'test101-poll-'))
  try {
    const script = `set -euo pipefail
TEST_NAME=test-101-fmk-real-busy
BUSY_SETTLED=observer SLACK_STATE_DIR="$HOME/state" REAL_KEY=busy SCENARIO_SLACK_RECORD=slack SCENARIO_ROOT="$HOME"
SCENARIO_POLL_S=0
calls=0
bun() { calls=$((calls + 1)); ${outcome === 'parent probe' ? `return ${MAIN_AGENT_PROBE_EXIT}` : outcome === 'pending then complete' ? '[[ "$calls" -gt 1 ]]' : 'return 0'}; }
_scenario_now_ms() { echo 0; }
sleep() { [[ "$calls" -eq 1 ]] || exit 97; }
${functions}
${settle}
${call}
echo "settled after $calls observations"
`
    const result = spawnSync('bash', ['-c', script], {
      env: hostSafeChildEnv(root, { tools: ['bash'] }), cwd: root, encoding: 'utf8', timeout: 2000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(outcome === 'parent probe' ? 1 : 0)
    if (outcome === 'parent probe') {
      expect(result.stderr).toBe('FAIL: test-101-fmk-real-busy: main agent ran the denied probe itself\n')
      expect(result.stdout).toBe('')
    } else expect(result.stdout).toBe(`settled after ${outcome === 'complete' ? 1 : 2} observations\n`)
    assertNoLeak(result)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const negatives = [
  ['denial call incomplete', (e: any) => { e.decision.method = 'chat.postMessage' }],
  ['denial failed', (e: any) => { e.decision.answer = 'error' }],
  ['denial not delivered', (e: any) => { e.decision.status = 500 }],
  ['wrong decision', (e: any) => { e.decision.text = '*Permission* — Allowed' }],
  ['wrong request', (e: any) => { e.decision.response_ts = 'other' }],
  ['wrong persona', (e: any) => { e.decision.label = 'other' }],
  ['wrong Slack prompt', (e: any) => { e.slack[0].response_ts = 'other' }],
  ['different probe', (e: any) => { e.slack[0].blocks[0].text.text = 'another command' }],
  ['no pushed action', (e: any) => { e.slack.splice(1, 1) }],
  ['unfinished subagent despite main Stop', (e: any) => { e.side.pop(); e.own.splice(3, 1) }],
  ['terminal sidechain without completed notification', (e: any) => { e.own.splice(3, 1) }],
  ['denial result absent', (e: any) => { e.side.splice(1, 1) }],
  ['successful Bash result', (e: any) => { e.side[1].value.message.content[0].is_error = false }],
  ['wrong denied Bash identity', (e: any) => { e.side[1].value.message.content[0].tool_use_id = 'other' }],
  ['wrong sidechain session', (e: any) => { e.side.forEach((s: any) => { s.value.sessionId = 'other' }) }],
  ['wrong sidechain agent', (e: any) => { e.side.forEach((s: any) => { s.value.agentId = 'other' }) }],
  ['wrong sidechain path', (e: any) => { e.side.forEach((s: any) => { s.path = s.path.replace('agent-agent1', 'agent-other') }) }],
  ['completion only enqueued', (e: any) => { e.own[3].value.type = 'queue-operation' }],
  ['notification for different agent', (e: any) => { e.own[3].value.message.content = e.own[3].value.message.content.replace('agent1', 'other') }],
  ['notification for different Agent call', (e: any) => { e.own[3].value.message.content = e.own[3].value.message.content.replace('launch1', 'other') }],
  ['main still running after completion', (e: any) => { e.own.pop() }],
  ['notification before Agent launch result', (e: any) => { e.own[3].offset = 1 }],
  ['notification before denied tool record', (e: any) => { e.own[3].at = 3 }],
  ['main completion timestamp before notification', (e: any) => { e.own[4].at = 8 }],
  ['untimed notification', (e: any) => { e.own[3].at = NaN }],
  ['foreign notification session', (e: any) => { e.own[3].value.sessionId = 'other' }],
  ['foreign notification stream', (e: any) => { e.own[3].path = '/other/session.jsonl' }],
  ['sidechain notification in main stream', (e: any) => { e.own[3].value.isSidechain = true }],
  ['unlinked notification', (e: any) => { e.own[3].value.message.content = '<task-notification><status>completed</status></task-notification>' }],
  ['failed notification', (e: any) => { e.own[3].value.message.content = e.own[3].value.message.content.replace('completed', 'failed') }],
  ['IDs only in result prose', (e: any) => { e.own[3].value.message.content = '<task-notification><result>' + e.own[3].value.message.content + '</result></task-notification>' }],
  ['ambiguous notifications', (e: any) => { e.own[3].value.message.content += e.own[3].value.message.content }],
  ['conflicting duplicated identity', (e: any) => { e.own[3].value.message.content = e.own[3].value.message.content.replace('<status>', '<task-id>other</task-id><status>') }],
] as const
test.each(shapes.flatMap(shape => negatives.map(([name, change]) => [shape, name, change] as const)))('%s refuses %s', (shape, _name, change) => {
  const e = evidence(); change(e); shapeNotification(e, shape)
  expect(() => observe(e)).toThrow()
})

for (const audit of sourceAudit) test.each([...shapes])(`${audit.version} audited serializer supports %s with either native linkage ID`, shape => {
  for (const fragment of audit.fragments) {
    expect(Buffer.byteLength(fragment.source)).toBe(fragment.bytes)
    expect(createHash('sha256').update(fragment.source).digest('hex')).toBe(fragment.sha256)
  }
  const serializer = audit.fragments.find(f => f.name === 'notification-serialization')!.source
  const tags = audit.fragments.filter(f => f.name.startsWith('tag-')).map(f => f.source).join(',')
  // Execute only the captured pure serializer with fixture IDs, never a client.
  const serialize = new Function(`const ${tags}; return (${serializer});`)() as (fields: Record<string, string>) => string
  for (const ids of [{ taskId: 'agent1', toolUseId: 'launch1' }, { taskId: 'agent1' }, { toolUseId: 'launch1' }]) {
    const e = evidence()
    e.own[3]!.value.message.content = serialize({ ...ids, status: 'completed' } as Record<string, string>)
    shapeNotification(e, shape)
    const result = observe(e)
    expect(result.agent_id).toBe('agent1')
    assertNoLeak(result)
  }
})
