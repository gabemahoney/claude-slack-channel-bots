import { membershipPage } from './test-helpers/shared-channels.ts'
/** Tool guards and writes share the recovered authority; no separate delivery file exists. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import { parseSharedChannelState } from '../src/shared-channels.ts'
import { channelDeliveryDeclarativeRefusal, channelDeliveryValueRefusal } from '../src/registry.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'
let h: ReloadHarness
let run: ReloadRun
let lines: string[]
let outputs: unknown[]
let consoleSpy: ReturnType<typeof spyOn>
beforeEach(() => { h = makeReloadHarness(); lines = []; outputs = []; consoleSpy = spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')) }) })
afterEach(async () => {
  try { for (const r of h.runs) { assertNoLeak(r.captured({ lines, outputs })); expect(r.slackPosts()).toEqual([]) } }
  finally { await h.cleanup(); consoleSpy.mockRestore() }
})
async function start(channel_mode: 'strict' | 'open' = 'open', discover = true) {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
  h.writeConfig({ channel_mode, personas: [alpha, beta] })
  run = await h.startDetecting({ realLifecycle: true })
  expect(run.outcome!.kind).toBe('applied')
  if (discover) {
    for (const p of [alpha, beta]) run.stub(p.name).script.inventory.push(membershipPage(p.channels!.map(c => c.id)))
    await run.membershipClock.runNext()
    for (const p of [alpha, beta]) expect(run.membershipScanner.status(h.key(p.name)).state).toBe('complete')
  }
  run.registerSession('alpha'); run.registerSession('beta')
  return { alpha, beta, authority: run.controller.sharedChannels()! }
}
async function call(args: Record<string, unknown>, name = 'alpha', session?: Parameters<ReloadRun['callTool']>[3]) {
  const result = await run.callTool(name, SET_CHANNEL_DELIVERY_TOOL, args, session)
  outputs.push(result); return result
}
 test.each(['strict', 'open'] as const)('%s exposes the tool on each persona session', async mode => {
  await start(mode)
  for (const name of ['alpha', 'beta']) {
    const persona = run.serverConfig()!.personas.find(p => p.name === name)!
    const result = await call({ channel: persona.channels[0]!.id, delivery: 'mentions' }, name)
    expect(result.isError).toBe(mode === 'strict')
    expect(result.text).not.toContain('Unknown tool')
  }
 })
 test('strict mode refuses before value/channel parsing and changes no durable state', async () => {
  const { alpha, authority } = await start('strict', false)
  const before = readFileSync(h.paths.lastApplied)
  const result = await call({ delivery: LEAK_SENTINEL, channel: LEAK_SENTINEL })
  expect(result).toEqual({ isError: true, text: channelDeliveryDeclarativeRefusal(alpha.name, h.key(alpha.name)) })
  expect(readFileSync(h.paths.lastApplied)).toEqual(before)
  expect(authority.revision).toBe(1)
 })
 test.each(['off', 'mentions', 'all', 'thread_hybrid'] as const)('an open-mode %s assignment is one durable revision and leaves the neighbor unchanged', async delivery => {
  const { alpha, authority } = await start()
  const channel = alpha.channels![0]!.id
  const before = authority.snapshot(); const checkpoint = run.checkpoint()
  const result = await call({ channel, delivery })
  expect(result.isError).toBe(false)
  expect(result.text).toContain(delivery)
  expect(authority.revision).toBe(before.revision + 1)
  expect(authority.choice(h.key('alpha'), channel)).toBe(delivery)
  expect(authority.snapshot().personas[h.key('beta')]).toEqual(before.personas[h.key('beta')])
  expect(run.since(checkpoint).writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
  expect(existsSync(join(h.stateDir, 'channel-delivery.json'))).toBe(false)
  expect(parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)!.personas[h.key('alpha')]!.assignments[channel]!.delivery).toBe(delivery)
 })
 test.each([undefined, null, 'everything', LEAK_SENTINEL, fakeToken(BOT_TOKEN_PREFIX, 'delivery')])('bad delivery %p is refused without storing or echoing secrets', async delivery => {
  const { alpha, authority } = await start()
  const before = authority.snapshot()
  expect(await call({ channel: alpha.channels![0]!.id, delivery })).toEqual({ isError: true, text: channelDeliveryValueRefusal(alpha.name, h.key(alpha.name), delivery) })
  expect(authority.snapshot()).toEqual(before)
 })
 test.each([undefined, null, 'D0DIRECT1', 'G0UNKNOWN', 'C0UNKNOWN', { nested: LEAK_SENTINEL }, fakeToken(BOT_TOKEN_PREFIX, 'channel')])('unknown/invalid channel %p is refused without changing the authority', async channel => {
  const { authority } = await start(); const before = authority.snapshot()
  expect((await call({ channel, delivery: 'all' })).isError).toBe(true)
  expect(authority.snapshot()).toEqual(before)
 })
 test('a retiring persona is refused while the other persona keeps its own writable life', async () => {
  const { alpha, beta, authority } = await start()
  run.channelDelivery.beginRetiring([h.key('alpha')])
  expect((await call({ channel: alpha.channels![0]!.id, delivery: 'all' })).isError).toBe(true)
  expect((await call({ channel: beta.channels![0]!.id, delivery: 'off' }, 'beta')).isError).toBe(false)
  expect(authority.choice(h.key('beta'), beta.channels![0]!.id)).toBe('off')
 })
 test('capacity failure returns an error, keeps source, applied state and confirmation authority unchanged', async () => {
  const { alpha, authority } = await start(); const before = authority.snapshot(); const bytes = readFileSync(h.paths.lastApplied)
  h.failWrites({ step: 'writeSync', code: 'ENOSPC' })
  expect((await call({ channel: alpha.channels![0]!.id, delivery: 'off' })).isError).toBe(true)
  expect(authority.snapshot()).toEqual(before)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
 })
 test('a prior session cannot write after the applied persona was removed', async () => {
  const { alpha, beta, authority } = await start()
  const session = run.session('alpha')
  h.writeConfig({ channel_mode: 'open', personas: [beta] })
  await (await run.confirmPending()).applying
  const revision = authority.revision
  expect((await call({ channel: alpha.channels![0]!.id, delivery: 'all' }, 'alpha', session)).isError).toBe(true)
  expect(authority.revision).toBe(revision)
  expect(authority.incarnation(h.key('alpha'))).toBeUndefined()
 })

test('real MCP and routed traffic refuse unverified/absent membership; authenticated discovery alone enables a fresh assignment', async () => {
  const { alpha, authority } = await start('open', false)
  const channel = alpha.channels![0]!.id
  const before = authority.snapshot()
  expect((await call({ channel, delivery: 'off' })).isError).toBe(true)
  const { makeChannelMessage } = await import('./test-helpers/slack-stub.ts')
  await run.deliver('alpha', makeChannelMessage({ channel }))
  expect(run.stub('alpha').socket.acks).toHaveLength(0)
  expect(run.queued('alpha')).toEqual([])
  expect(run.stub('alpha').calls.inventory).toHaveLength(0)
  expect(authority.snapshot()).toEqual(before)
  await run.membershipClock.runNext() // The stub's valid empty inventory establishes absence.
  expect(run.membership.read('alpha', channel, 'open')).toEqual({ kind: 'ineligible', reason: 'absent' })
  const absent = authority.snapshot()
  expect((await call({ channel, delivery: 'off' })).isError).toBe(true)
  expect(authority.snapshot()).toEqual(absent)
  run.stub('alpha').script.inventory.push(membershipPage([channel]))
  run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
  expect((await call({ channel, delivery: 'off' })).isError).toBe(false)
  expect(authority.choice('alpha', channel)).toBe('off')
})

test('dry restart composes the real MCP guard with persisted membership, queue and pending input but constructs no Slack work', async () => {
  const { alpha, beta } = await start()
  const channel = alpha.channels![0]!.id
  const { slackInput } = await import('./test-helpers/delivery-queue.ts')
  await run.queue.accept('alpha', slackInput({ text: '  retained\r\n\r\nbody  ', queued_ack_reaction: 'hourglass' }))
  const accepted = structuredClone(run.queued('alpha')[0]!.accepted)
  h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }, beta] })
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  const input = readFileSync(h.paths.config), pending = readFileSync(h.paths.pending)
  const before = run.controller.sharedChannels()!.snapshot()
  await run.stop()
  for (let restart = 0; restart < 2; restart++) {
    run = await h.start({ dryRun: true, realLifecycle: true })
    run.registerSession('alpha')
    expect((await call({ channel, delivery: 'all' })).isError).toBe(true)
    await run.clock.advance(60_000); await run.membershipClock.advance(60_000)
    expect(run.membershipClock.pendingCount()).toBe(0)
    expect(run.slack.builds).toEqual([])
    expect(run.clock.pendingCount()).toBe(0)
    expect(run.membershipScanner.status('alpha').state).toBe('unverified')
    expect(run.membership.read('alpha', channel, 'open').kind).toBe('unresolved')
    expect(run.controller.sharedChannels()!.snapshot()).toEqual(before)
    expect(run.queued('alpha')[0]!.accepted).toEqual({ ...accepted, attempt_high_watermark: 0 })
    expect(readFileSync(h.paths.config)).toEqual(input)
    expect(readFileSync(h.paths.pending)).toEqual(pending)
    await run.stop()
  }
  run = await h.start({ realLifecycle: true })
  run.stub('alpha').script.inventory.push(membershipPage([channel])); await run.membershipClock.runNext()
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
})
