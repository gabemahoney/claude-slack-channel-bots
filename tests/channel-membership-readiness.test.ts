import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMembershipReadiness, handleMembershipReadiness, MEMBERSHIP_READINESS_ROUTE, MEMBERSHIP_REQUIRED_SUBSCRIPTIONS } from '../src/channel-membership-readiness.ts'
import { makeMembershipHarness, membershipPage, SHARED_CHANNEL_IDS as C, type MembershipHarness } from './test-helpers/shared-channels.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_RETRY_MIN_MS } from '../src/channel-membership-retry.ts'

const runs: MembershipHarness[] = [], dirs: string[] = [], owners: ReturnType<typeof createMembershipReadiness>[] = []
async function fixture(options: Parameters<typeof makeMembershipHarness>[1] = {}, directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'membership-readiness-'))
  if (!dirs.includes(dir)) dirs.push(dir)
  const f = makeMembershipHarness(dir, options); runs.push(f)
  await f.start()
  const readiness = createMembershipReadiness({ authority: f.authority, provenance: f.h.manager.provenance, inventory: f.scanner.status,
    dryRun: options.dryRun ?? false, now: f.h.clock.now, log: line => f.lines.push(line) })
  owners.push(readiness)
  const captured: unknown[] = []
  async function http(body: unknown, remote = '127.0.0.1', method = 'POST') {
    const response = await handleMembershipReadiness(new Request(`http://localhost${MEMBERSHIP_READINESS_ROUTE}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), remote, { readiness, getPersonaConfig: () => f.h.config })
    const result = await response.json(); captured.push(result); assertNoLeak(captured)
    return { status: response.status, body: result as any }
  }
  return { f, readiness, http, captured }
}
function record(f: MembershipHarness, overrides: Record<string, unknown> = {}) {
  return { action: 'record', persona: 'alpha', installation: f.h.manager.identity('alpha'),
    subscriptions: { member_joined_channel: 'verified', channel_left: 'verified' }, reinstall: 'complete', ...overrides }
}
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.close()
  for (const f of runs.splice(0)) { await f.close(); expect(f.h.clock.pendingCount()).toBe(0); assertNoLeak(f.captured()) }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test.each(['unknown', 'verified', 'missing-subscriptions', 'incomplete-reinstall'] as const)('real HTTP %s evidence stays independent of current positive inventory and survives reopen', async state => {
  const { f, readiness, http } = await fixture()
  f.h.stub(f.h.p('alpha')).script.inventory.push(membershipPage([C.primary]))
  await f.scan()
  expect(readiness.read('alpha').setup.state).toBe('unknown')
  const before = f.authority.snapshot()
  if (state !== 'unknown') {
    const reply = await http(record(f, state === 'missing-subscriptions' ? { subscriptions: { member_joined_channel: 'missing', channel_left: 'verified' } } : state === 'incomplete-reinstall' ? { reinstall: 'incomplete' } : {}))
    expect(reply.status).toBe(200); expect(reply.body.kind).toBe('recorded')
  }
  const view = (await http({ action: 'read', persona: 'alpha' })).body.view
  expect(view.inventory.state).toBe('complete'); expect(view.setup.state).toBe(state)
  expect(f.membership.read('alpha', C.primary, 'open').kind).toBe('eligible')
  const after = f.authority.snapshot()
  expect(after.source).toEqual(before.source); expect(after.applied).toEqual(before.applied); expect(after.pendingIntent).toEqual(before.pendingIntent)
  expect(after.personas.alpha!.assignments).toEqual(before.personas.alpha!.assignments)
  await f.close()
  const reopened = await fixture({ reopen: true }, f.stateDir)
  const read = (await reopened.http({ action: 'read', persona: 'alpha' })).body.view
  expect(read.setup.state).toBe(state)
  expect(read.inventory.state).toBe('unverified')
  expect(reopened.f.membership.read('alpha', C.primary, 'open').kind).toBe('unresolved')
})

test('HTTP record refuses mismatched app, stale binding, dry run and remote forwarded-loopback requests', async () => {
  const { f, http } = await fixture()
  const before = f.authority.snapshot()
  expect((await http(record(f, { installation: { ...f.h.manager.identity('alpha'), appId: 'A0FOREIGN' } }))).status).toBe(409)
  expect((await http(record(f), '203.0.113.1')).status).toBe(403)
  expect((await http(record(f), '127.0.0.1', 'GET')).status).toBe(405)
  expect((await http(record(f, { persona: 'missing' }))).status).toBe(404)
  expect((await http(record(f, { subscriptions: { member_joined_channel: 'verified' } }))).status).toBe(400)
  const stale = record(f)
  await f.h.manager.stop('alpha')
  expect((await http(stale)).status).toBe(409)
  expect(f.authority.snapshot()).toEqual(before)
  const dry = await fixture({ dryRun: true })
  expect((await dry.http(record(dry.f, { installation: { teamId: 'T0MEMBER', appId: 'A0MEMBER0', botUserId: 'U0MEMBER0', botId: 'B0MEMBER0' } }))).status).toBe(409)
  expect(dry.f.h.slack.builds).toEqual([])
})

test('HTTP persistence refusal keeps prior evidence and exact pending input; successful readback projects no extras', async () => {
  const { f, http } = await fixture()
  f.authority.transact(f.authority.revision, state => { state.pendingIntent = { prepared: 'keep exact pending input' } })
  const before = f.authority.snapshot()
  f.failWrites(() => true)
  expect((await http(record(f))).status).toBe(503)
  expect(f.authority.snapshot()).toEqual(before)
  f.failWrites(() => false)
  const reply = await http(record(f, { discarded: sentinelInMessage('manual-extra') }))
  expect(reply.status).toBe(200)
  expect(reply.body.view.setup.state).toBe('verified')
  expect(f.authority.snapshot().pendingIntent).toEqual(before.pendingIntent)
  assertNoLeak(f.captured())
})

test('deadline/progress/retry and classified setup deficiency read back independently; episodes are bounded', async () => {
  const { f, readiness, http } = await fixture()
  f.h.stub(f.h.p('alpha')).script.inventory.push(membershipPage([C.primary], 'later'), { kind: 'never' })
  await http(record(f, { subscriptions: { member_joined_channel: 'missing', channel_left: 'unknown' }, reinstall: 'incomplete' }))
  await f.scan()
  const start = f.h.clock.now()
  await f.h.clock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS)
  const view = (await http({ action: 'read', persona: 'alpha' })).body.view
  expect(view.inventory).toMatchObject({ state: 'incomplete', pages: 1, positives: 1, problem: 'deadline', nextAttemptAt: start + MEMBERSHIP_REQUEST_TIMEOUT_MS + MEMBERSHIP_RETRY_MIN_MS })
  expect(view.setup).toMatchObject({ state: 'missing-subscriptions', missingSubscriptions: ['member_joined_channel'], unknownSubscriptions: ['channel_left'], reinstall: 'incomplete' })
  const count = f.lines.length
  readiness.report('alpha'); readiness.report('alpha')
  expect(f.lines).toHaveLength(count)
  expect(f.membership.read('alpha', C.primary, 'open').kind).toBe('eligible')
})

test('HTTP readback immediately reports live-event reconciliation causes and scheduled retry without losing verified setup', async () => {
  const { f, http } = await fixture()
  const slack = f.h.stub(f.h.p('alpha'))
  slack.script.inventory.push(membershipPage([C.primary, C.secondary])); await f.scan()
  await http(record(f))
  expect((await http({ action: 'read', persona: 'alpha' })).body.view.inventory.state).toBe('complete')
  const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
  for (const member of [true, false]) {
    await f.event(member, C.primary, { id: member ? 'EvREADJOIN' : 'EvREADLEAVE', timestamp })
    const view = (await http({ action: 'read', persona: 'alpha' })).body.view
    expect(view.inventory).toMatchObject({ state: 'incomplete',
      problem: member ? 'current-membership-missing' : 'event-order-conflict',
      nextAttemptAt: f.h.clock.now() + MEMBERSHIP_RETRY_MIN_MS })
    expect(view.inventory.nextAttemptAt).toBe(f.h.clock.pending()[0]!.dueAt)
    expect(view.inventory.deadline).toBeUndefined()
    expect(view.setup.state).toBe('verified')
    expect(f.membership.read('alpha', C.primary, 'open').kind).toBe('unresolved')
    expect(f.membership.read('alpha', C.secondary, 'open').kind).toBe('eligible')
  }
  expect(slack.socket.acks).toHaveLength(2)
  expect(slack.calls.inventory).toHaveLength(1)
  slack.script.inventory.push(membershipPage([C.secondary]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  const view = (await http({ action: 'read', persona: 'alpha' })).body.view
  expect(view.inventory.state).toBe('complete')
  expect(view.inventory.problem).toBeUndefined()
  expect(view.inventory.nextAttemptAt).toBeUndefined()
  expect(view.setup.state).toBe('verified')
  expect(f.membership.read('alpha', C.primary, 'open')).toEqual({ kind: 'ineligible', reason: 'absent' })
})

test('manifest retains discovery scopes/current events and adds exactly the required membership subscriptions', () => {
  const manifest = readFileSync(join(import.meta.dir, '..', 'slack-app-manifest.yml'), 'utf8')
  for (const name of [...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS, 'message.channels', 'message.groups', 'message.im', 'app_mention']) expect(manifest.match(new RegExp(`^\\s+- ${name.replaceAll('.', '\\.')}\\s*$`, 'gm'))).toHaveLength(1)
  for (const scope of ['channels:read', 'groups:read', 'users:read']) expect(manifest).toContain(`- ${scope}`)
  expect(manifest).not.toContain('message.mpim')
})

test('production readiness handler serves actual loopback HTTP record/readback and enforces its body cap', async () => {
  const { f, readiness } = await fixture()
  const { INTERJECT_BODY_CAP_BYTES } = await import('../src/interject.ts')
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req, server) =>
    handleMembershipReadiness(req, server.requestIP(req)?.address, { readiness, getPersonaConfig: () => f.h.config }) })
  const url = `http://127.0.0.1:${server.port}${MEMBERSHIP_READINESS_ROUTE}`
  try {
    const saved = await fetch(url, { method: 'POST', body: JSON.stringify(record(f)) })
    expect(saved.status).toBe(200)
    const recorded = await saved.json(); assertNoLeak(recorded)
    const read = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'read', persona: 'alpha' }) })
    const result = await read.json() as any
    expect(result.view.setup.state).toBe('verified'); assertNoLeak(result)
    const large = await fetch(url, { method: 'POST', body: ' '.repeat(INTERJECT_BODY_CAP_BYTES + 1) })
    expect(large.status).toBe(413); assertNoLeak(await large.json())
  } finally { await server.stop(true) }
})
