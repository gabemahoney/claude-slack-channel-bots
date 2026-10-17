import { expect, test } from 'bun:test'
import { denialSettled } from './real-agent/test-101-denial-settled.ts'
import type { TranscriptEntry } from './integration/fixtures/transcript-receipts.ts'

// b.omv SR-14.2 case 8: a main Stop while an async Agent runs is not readiness.
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

test('matching actual denial, sidechain completion and consumed main completion permit the subsequent idle check', () => {
  expect(observe(evidence())).toMatchObject({ request_token: 'request1', agent_id: 'agent1', session_id: 'session', subagent_completed_at: 8, main_completed_at: 10 })
})

test.each([
  ['denial call incomplete', (e: any) => { e.decision.method = 'chat.postMessage' }],
  ['denial failed', (e: any) => { e.decision.answer = 'error' }],
  ['denial not delivered', (e: any) => { e.decision.status = 500 }],
  ['wrong decision', (e: any) => { e.decision.text = '*Permission* — Allowed' }],
  ['wrong request', (e: any) => { e.decision.response_ts = 'other' }],
  ['wrong persona', (e: any) => { e.decision.label = 'other' }],
  ['wrong Slack prompt', (e: any) => { e.slack[0].response_ts = 'other' }],
  ['different probe', (e: any) => { e.slack[0].blocks[0].text.text = 'another command' }],
  ['no pushed action', (e: any) => { e.slack.splice(1, 1) }],
  ['unfinished subagent despite main Stop', (e: any) => { e.side.pop() }],
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
] as const)('refuses %s', (_name, change) => {
  const e = evidence(); change(e)
  expect(() => observe(e)).toThrow()
})
