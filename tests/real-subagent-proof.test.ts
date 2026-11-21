/** Synthetic test-101 subagent proof and test-32 off-script tool evidence; no native agent or credentials. */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDenialEligible, assertSubagentProvenGone, denyClickToken } from './integration/fixtures/real-case-assertions.ts'
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

// AD stores created_at in whole seconds; get-permission prints it as RFC 3339.
const open = (changes: Record<string, unknown> = {}) => permission({ requested_at: '2026-11-21T04:57:18Z', decision: null,
  decision_reason: null, decided_at: null, proven_gone_at: null, proven_gone_how: null, unproven_since: '2026-11-21T04:57:18Z', ...changes })
const REQUESTED_MS = Date.parse('2026-11-21T04:57:18Z')

test('regression: Deny waits until the request\'s recorded second has passed (AD turn_end cuts at the hook\'s whole second)', () => {
  expect(assertDenialEligible(TOKEN, open(), REQUESTED_MS + 1000))
    .toEqual({ requested_at: '2026-11-21T04:57:18Z', denied_after_ms: REQUESTED_MS + 1000 })
  expect(() => assertDenialEligible(TOKEN, open(), REQUESTED_MS + 2500)).not.toThrow()
  // Same second as the request: a SubagentStop starting now could not prove it.
  for (const now of [REQUESTED_MS, REQUESTED_MS + 1, REQUESTED_MS + 999])
    expect(() => assertDenialEligible(TOKEN, open(), now)).toThrow('denial pending')
  // A fractional requested_at still compares by its whole second.
  expect(() => assertDenialEligible(TOKEN, open({ requested_at: '2026-11-21T04:57:18.900Z' }), REQUESTED_MS + 999)).toThrow('denial pending')
  expect(() => assertDenialEligible(TOKEN, open({ requested_at: '2026-11-21T04:57:18.900Z' }), REQUESTED_MS + 1000)).not.toThrow()
})

test.each([
  ['another token', open({ request_token: 'other' }), 'wrong token'],
  ['main-agent probe', open({ tool_input: '{"command":"printf permission-probe"}' }), 'not the subagent probe'],
  ['already decided', open({ decision: 'deny' }), 'no longer open'],
  ['already proven', open({ proven_gone_at: '2026-11-21T04:57:19Z' }), 'no longer open'],
  ['requested_at missing', open({ requested_at: null }), 'no readable requested_at'],
  ['requested_at unreadable', open({ requested_at: 'soon' }), 'no readable requested_at'],
  ['unreadable read', undefined, 'wrong token'],
] as const)('denial eligibility rejects %s', (_name, request, reason) => {
  expect(() => assertDenialEligible(TOKEN, request, REQUESTED_MS + 5000)).toThrow(reason)
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

test('CLI denial-eligible passes once the recorded second has passed and fails while it has not', async () => {
  const past = files({ request: open() })
  const ok = await cli(past, 'denial-eligible', past.click, past.request)
  expect(ok.code).toBe(0)
  expect(ok.out.join('\n')).toContain('recorded: subagent denial eligible for turn-end proof {"requested_at":"2026-11-21T04:57:18Z"')
  const now = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const pending = files({ request: open({ requested_at: now }) })
  expect((await cli(pending, 'denial-eligible', pending.click, pending.request)).code).toBe(1)
  const decided = files({ request: open({ decision: 'deny' }) })
  expect((await cli(decided, 'denial-eligible', decided.click, decided.request)).code).toBe(1)
  const unreadable = files({ request: 'nope' })
  expect((await cli(unreadable, 'denial-eligible', unreadable.click, unreadable.request)).code).toBe(1)
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

test('test-101 sends its Deny only after the request\'s recorded second has passed', async () => {
  const text = await Bun.file(join(import.meta.dir, 'real-agent/test-101-fmk-real-busy.sh')).text()
  const opened = text.indexOf("case_assert subagent-permission")
  const at = (needle: string) => { const i = text.indexOf(needle, opened); expect(i).toBeGreaterThan(opened); return i }
  const recorded = at('> "${SCENARIO_ROOT}/deny-click.json"')
  const token = at('DENY_TOKEN="$(case_assert deny-token "${SCENARIO_ROOT}/deny-click.json")"')
  const eligible = at("wait_until 10 'subagent request never became eligible for its turn-end proof' denial_eligible")
  const push = at('"${SCENARIO_SLACK_STUB_URL}/_push" > "${SCENARIO_ROOT}/deny-action.json"')
  expect([recorded, token, eligible, push]).toEqual([recorded, token, eligible, push].sort((a, b) => a - b))
  const helper = text.slice(text.indexOf('denial_eligible() {'), eligible)
  expect(helper).toContain('real_ad get-permission --request-token "${DENY_TOKEN}"')
  expect(helper).toContain('case_assert denial-eligible "${SCENARIO_ROOT}/deny-click.json"')
  expect(text.match(/DENY_TOKEN=/g)).toHaveLength(1)
})

test('test-101 proves message eight still open after the kill with the server stopped, and requires recovery to deliver it', async () => {
  const text = await Bun.file(join(import.meta.dir, 'real-agent/test-101-fmk-real-busy.sh')).text()
  const six = text.indexOf('real_wait_delivery "${REAL_KEY}" 6')
  const at = (needle: string) => { const i = text.indexOf(needle, six); expect(i).toBeGreaterThan(six); return i }
  const sleep = "case_assert active-tool 'sleep 20 20 20' "
  const order = [
    at('case_assert no-stuck'),
    at("real_dm \"${REAL_LABEL}\" 'Run exactly sleep 20 20 20 with Bash now.'"),
    at(`wait_until 180 'recovery sleep never observed active' ${sleep}"\${SCENARIO_ROOT}/recovery-tool.json"`),
    at("real_dm \"${REAL_LABEL}\" 'message held across busy recovery'"),
    at('case_assert accepted 8'),
    // Setup snapshot just before the kill: the sleep has no result yet, and eight is open.
    at(`${sleep}"\${SCENARIO_ROOT}/recovery-tool-at-kill.json"`),
    at('case_assert open 8'),
    at('real_kill_and_reconcile "${REAL_KEY}"'),
    at('start_server --live'),
    at('real_wait_relaunch "${REAL_KEY}"'),
    at('real_wait_delivery "${REAL_KEY}" 8'),
  ]
  expect(order).toEqual([...order].sort((a, b) => a - b))
  // The pre-kill snapshot runs once, bare (not retried in a wait), right before the kill.
  expect(text[order[5]! - 1]).toBe('\n')
  const lines = (from: number, to: number) => text.slice(from, to).split('\n').filter(line => line && !line.startsWith('#'))
  expect(lines(order[5]!, order[7]!))
    .toEqual([`${sleep}"\${SCENARIO_ROOT}/recovery-tool-at-kill.json"`, 'case_assert open 8', "echo 'recorded: busy kill/recovery started'"])
  // The proof: between the kill (agent killed, server stopped) and the restart,
  // a bare open check must pass, so a completion before the kill fails the run.
  expect(lines(order[7]!, order[8]!)).toEqual([
    'real_kill_and_reconcile "${REAL_KEY}"',
    'case_assert open 8',
    "echo 'recorded: message eight open after kill, server stopped'",
  ])
  // real_kill_and_reconcile stops the server, so nothing can complete eight before the check.
  const recovery = await Bun.file(join(import.meta.dir, 'integration/lib/real-recovery.sh')).text()
  const helper = recovery.slice(recovery.indexOf('real_kill_and_reconcile() {'))
  expect(helper.indexOf('_real_checked_kill "${instance}" 1')).toBeGreaterThan(0)
  expect(helper.indexOf('stop_server')).toBeGreaterThan(helper.indexOf('_real_checked_kill "${instance}" 1'))
  expect(helper.slice(0, helper.indexOf('\n}\n'))).not.toContain('start_server')
  // The harness self-check proves open fails for an already completed head.
  const assertions = await Bun.file(join(import.meta.dir, 'integration/fixtures/real-case-assertions.ts')).text()
  expect(assertions).toContain("expectControl('open rejects a head completed before the check',()=>invokeCompact('open','5'),'expected head is already complete')")
  // Nothing new is sent after the eighth DM: recovery must deliver it itself.
  expect(text.slice(order[3]! + 1, order.at(-1)!)).not.toContain('real_dm')
  // The sleep is pre-allowed, so no prompt is left open for the resumed session.
  expect(text).toContain("real_prepare \"${REAL_AGENT_CLAUDE_VERSION:-2.1.296}\" 'Bash(sleep *)'")
  expect(text).not.toContain('permission-probe again')
  // Native Claude blocks a lone foreground `sleep N` with N >= 25: every
  // requested sleep is several arguments or a single one under 25 s.
  for (const [, args] of text.matchAll(/'Run exactly sleep ([\d ]+) with Bash now\.'/g)) {
    const seconds = args!.trim().split(/\s+/).map(Number)
    expect(seconds.length > 1 || seconds[0]! < 25).toBe(true)
  }
  expect([...text.matchAll(/'Run exactly sleep ([\d ]+) with Bash now\.'/g)].map(m => m[1])).toEqual(['20', '20 20 20'])
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
  // The recovery leg keeps its relaunch and proves the held delivery after it.
  const relaunch = at('real_wait_relaunch "${REAL_KEY}"')
  expect(text.indexOf('real_wait_delivery "${REAL_KEY}" 8', relaunch)).toBeGreaterThan(relaunch)
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
