/** Synthetic test-101 subagent proof and test-32 off-script tool evidence; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSubagentProvenGone, denyClickToken } from './integration/fixtures/real-case-assertions.ts'
import { runFixture } from './test-helpers/test33-receipt-boundary.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const INSTANCE = 'cscb_busy'
const TOKEN = '0d6f6c1e-8a2b-4c3d-9e4f-5a6b7c8d9e0f'
const click = (actionId = `perm_deny_${INSTANCE}_${TOKEN}`, actions?: unknown[]) => ({
  label: 'busy', interactive: { type: 'block_actions', user: { id: 'U0BUSY' }, channel: { id: 'D0BUSY' },
    message: { ts: '1.000001' }, actions: actions ?? [{ type: 'button', action_id: actionId, value: 'deny' }] } })
const permission = (changes: Record<string, unknown> = {}) => ({
  request_token: TOKEN, request_id: 7, tool_name: 'Bash', tool_input: '{"command":"printf subagent-deny-probe"}',
  requested_at: '2026-11-21T04:57:18.900Z', decision: 'deny', decision_reason: null, decided_at: '2026-11-21T04:57:19.400Z',
  delivery: 'delivered', proven_gone_at: '2026-11-21T04:57:22.230Z', proven_gone_how: 'turn_end', unproven_since: null, ...changes })
const row = (changes: Record<string, unknown> = {}) => ({
  instance_id: INSTANCE, state: 'waiting', permission_requests: [], unproven_requests: [], ...changes })

test('deny click token is the trailing request token of this instance\'s Deny action', () => {
  expect(denyClickToken(click(), INSTANCE)).toBe(TOKEN)
  // The instance itself may hold underscores; the prefix, not a split, finds the token.
  expect(denyClickToken(click(`perm_deny_cscb_two_part_${TOKEN}`), 'cscb_two_part')).toBe(TOKEN)
})

test.each([
  ['allow action', click(`perm_allow_${INSTANCE}_${TOKEN}`), 'not a Deny for this instance'],
  ['another instance', click(`perm_deny_cscb_other_${TOKEN}`), 'not a Deny for this instance'],
  ['prefix-sharing instance', click(`perm_deny_${INSTANCE}_x_${TOKEN}`), 'no request token'],
  ['no token', click(`perm_deny_${INSTANCE}_`), 'no request token'],
  ['two actions', click('', [{ action_id: `perm_deny_${INSTANCE}_${TOKEN}` }, { action_id: `perm_deny_${INSTANCE}_${TOKEN}` }]), 'no single action'],
  ['no actions', click('', []), 'no single action'],
  ['unreadable', undefined, 'no single action'],
] as const)('deny click token rejects %s', (_name, value, reason) => {
  expect(() => denyClickToken(value, INSTANCE)).toThrow(reason)
})

test('regression: AD >= 0.18 proves the denied Claude subagent request gone at turn end and the row holds no dialog', () => {
  expect(assertSubagentProvenGone(TOKEN, permission(), row(), INSTANCE))
    .toEqual({ proven_gone_at: '2026-11-21T04:57:22.230Z', decided_at: '2026-11-21T04:57:19.400Z' })
})

test.each([
  // AD 0.17 kept a denied subagent request unproven until the agent ended.
  ['AD 0.17 hold: never proven', permission({ proven_gone_at: null, proven_gone_how: null, unproven_since: '2026-11-21T04:57:19.500Z' }), row({ unproven_requests: [permission({ proven_gone_at: null, proven_gone_how: null })] }), 'not proven gone at turn end'],
  ['proven by agent end', permission({ proven_gone_how: 'agent_gone' }), row(), 'not proven gone at turn end'],
  ['proven without a time', permission({ proven_gone_at: null }), row(), 'not proven gone at turn end'],
  ['proven at an unreadable time', permission({ proven_gone_at: 'later' }), row(), 'not proven gone at turn end'],
  ['still unproven since', permission({ unproven_since: '2026-11-21T04:57:19.500Z' }), row(), 'not proven gone at turn end'],
  ['unproven_since missing', (({ unproven_since: _, ...rest }) => rest)(permission()), row(), 'not proven gone at turn end'],
  ['allowed request', permission({ decision: 'allow' }), row(), 'not recorded as denied'],
  ['undecided request', permission({ decision: null }), row(), 'not recorded as denied'],
  ['main-agent probe', permission({ tool_input: '{"command":"printf permission-probe"}' }), row(), 'not the subagent probe'],
  ['another token', permission({ request_token: 'other' }), row(), 'wrong token'],
  ['row still holds a request', permission(), row({ unproven_requests: [{ request_token: 'other' }] }), 'still holds an unproven request'],
  ['row without the unproven list', permission(), (({ unproven_requests: _, ...rest }) => rest)(row()), 'still holds an unproven request'],
  ['row at a prompt', permission(), row({ state: 'check_permission' }), 'not the waiting persona'],
  ['row working', permission(), row({ state: 'working' }), 'not the waiting persona'],
  ['another row', permission(), row({ instance_id: 'cscb_other' }), 'not the waiting persona'],
] as const)('subagent proof rejects %s', (_name, request, adRow, reason) => {
  expect(() => assertSubagentProvenGone(TOKEN, request, adRow, INSTANCE)).toThrow(reason)
})

function files(values: { click?: unknown; request?: unknown; row?: unknown }) {
  const root = mkdtempSync(join(tmpdir(), 'subagent-proof-')); roots.push(root)
  const path = (name: string, value: unknown) => {
    const file = join(root, name)
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  return { root, click: path('deny-click.json', values.click ?? click()),
    request: path('denied-request.json', values.request ?? permission()), row: path('denied-row.json', values.row ?? row()) }
}
const cli = (h: ReturnType<typeof files>, command: string, ...args: string[]) =>
  runFixture('fixtures/real-case-assertions.ts', [command, h.root, 'busy', join(h.root, 'shim.log'), h.root, ...args])

test('CLI deny-token prints only the token; subagent-proven-gone records the proof', async () => {
  const h = files({})
  const token = await cli(h, 'deny-token', h.click)
  expect({ code: token.code, out: token.out }).toEqual({ code: 0, out: [TOKEN] })
  const proof = await cli(h, 'subagent-proven-gone', h.click, h.request, h.row)
  expect(proof.code).toBe(0)
  expect(proof.out.join('\n')).toContain('recorded: denied subagent request proven gone at turn end {"proven_gone_at":"2026-11-21T04:57:22.230Z"')
})

test.each([
  ['malformed click', { click: '{' }, 'deny-token'],
  ['unproven request', { request: permission({ proven_gone_at: null, proven_gone_how: null }) }, 'subagent-proven-gone'],
  ['unreadable request', { request: 'not json' }, 'subagent-proven-gone'],
  ['unreadable row', { row: '' }, 'subagent-proven-gone'],
  ['allow click', { click: click(`perm_allow_${INSTANCE}_${TOKEN}`) }, 'subagent-proven-gone'],
] as const)('CLI fails on %s', async (_name, values, command) => {
  const h = files(values)
  const result = await cli(h, command, h.click, h.request, h.row)
  expect(result.code).toBe(1)
})

test('test-101 reads the denied request, then the row, before its next DM, and the next DM is delivered without a stuck notice', async () => {
  const text = await Bun.file(join(import.meta.dir, 'real-agent/test-101-fmk-real-busy.sh')).text()
  const settled = text.indexOf('busy_denial_settled\n', text.indexOf('wait_until 180 \'denied subagent did not settle'))
  const at = (needle: string) => { const i = text.indexOf(needle, settled); expect(i).toBeGreaterThan(settled); return i }
  const permissionRead = at('real_ad get-permission --request-token "${DENY_TOKEN}"')
  const rowRead = at('real_ad get --instance-id')
  const proof = at('case_assert subagent-proven-gone')
  const dm = at("real_dm \"${REAL_LABEL}\" 'message after denied subagent request'")
  const delivered = at('real_wait_delivery "${REAL_KEY}" 6')
  const noStuck = at('case_assert no-stuck')
  const kill = at('real_kill_and_reconcile')
  expect(at('real_wait_idle "${REAL_KEY}"')).toBeLessThan(permissionRead)
  expect([permissionRead, rowRead, proof, dm, delivered, noStuck, kill]).toEqual([permissionRead, rowRead, proof, dm, delivered, noStuck, kill].sort((a, b) => a - b))
  // The recovery leg keeps its relaunch and proves a delivery after it.
  const relaunch = at('real_wait_relaunch "${REAL_KEY}"')
  expect(text.indexOf('real_wait_delivery "${REAL_KEY}" 7', relaunch)).toBeGreaterThan(relaunch)
  expect(text).not.toContain('dialog-notice')
})

test('test-32 pre-allows only the harmless router acknowledgements; reply stays CSCB\'s launch pair', async () => {
  const text = await Bun.file(join(import.meta.dir, 'integration/test-32-fmk-real-order.sh')).text()
  const prepare = text.slice(text.indexOf('\nreal_prepare '), text.indexOf('\n', text.indexOf('edit_message', text.indexOf('\nreal_prepare '))))
  expect(prepare.match(/mcp__[\w-]+/g)).toEqual(['mcp__slack-channel-router__react', 'mcp__slack-channel-router__edit_message'])
  expect(text.match(/^real_prepare\b/gm)).toHaveLength(1)
  expect(text).toContain('include thread_ts only when present. Call no other tool.\'')
  expect(text).toContain('case_assert reply-permission-resume')
})
