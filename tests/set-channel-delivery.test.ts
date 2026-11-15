import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { responseWithoutId, addRawResponseEvidence, RAW_RESPONSE_SURFACES, deliveryAttempt, retryAttempt, botApplications, botAttemptRecord, SHARED_CHANNEL_IDS as C, membershipPage, CHANNEL_DELIVERY_TIMES as TIMES, channelDeliveryEventTimestamp, membershipEventTimestamp, CHANNEL_DELIVERY_EVENT_IDS as EVENTS, channelDeliveryOriginals } from './test-helpers/shared-channels.ts'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import { absenceReplacementBinding, parseSharedChannelState, sameChannelStamp, type ChannelStamp, type SharedChannelAuthority, type SharedChannelStampState, type SharedChannelState, type SharedThreadView } from '../src/shared-channels.ts'
import { botAttemptBinding, botAttemptKey, type ChannelDeliveryAttemptRequest } from '../src/channel-delivery-attempt.ts'
import type { BotAttemptResult, ChannelDeliveryCurrentFacts } from '../src/channel-delivery.ts'
import type { DeliveryMode } from '../src/config.ts'
import { channelDeliveryAttemptResultText, channelDeliveryDeclarativeRefusal, channelDeliveryValueRefusal, channelDeliveryChannelRefusal, channelDeliveryAttemptInputRefusal, channelDeliveryDryRunRefusal, personaNotAppliedRefusal } from '../src/registry.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { stubCallCount } from './test-helpers/agent-director-stub.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions, type ReloadRunActivity } from './test-helpers/reload-harness.ts'
import { SET_CHANNEL_DELIVERY_INPUT_SCHEMA, SET_CHANNEL_DELIVERY_DESCRIPTION, MCP_INSTRUCTIONS } from '../src/registry.ts'
import { channelDeliverySetCause, formatPersonaDiagnostic, PERSONA_CHANNEL_DELIVERY_SET } from '../src/persona-diagnostics.ts'
import { THREAD_ROOTS } from './test-helpers/thread-memory.ts'
import { makeDeferredWebApiCall, makeChannelMessage, mentionText } from './test-helpers/slack-stub.ts'
import { buildOperatorAssignment } from '../src/reload-request.ts'
import { sharedReviewDependency } from '../src/reload-review.ts'
import { REVIEW_ABSENCE_REPLACEMENT } from '../src/reload-preview-clauses.ts'
import { reviewedReplacementIncarnation } from '../src/shared-channels.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
import { contradictoryBotHistory } from './test-helpers/shared-channels.ts'
import { durableWriteFileSync } from '../src/atomic-write.ts'
import { serializeSharedChannelState } from '../src/shared-channels.ts'
import { makeToolCallGate, ATTEMPT_BODY_SENTINEL } from './test-helpers/shared-channels.ts'
function expectSameResponse(a: Parameters<typeof responseWithoutId>[0], b: Parameters<typeof responseWithoutId>[0]) {
  expect(responseWithoutId(a)).toEqual(responseWithoutId(b))
}
/** Tool guards and writes share the recovered authority; no separate delivery file exists. */
function expectNoSlack(activity: Pick<ReloadRunActivity, 'slackCalls' | 'slackBuilds'>) {
  expect(activity.slackCalls).toEqual([])
  expect(activity.slackBuilds).toBe(0)
}

describe('channel delivery contracts', () => {
let h: ReloadHarness
let run: ReloadRun
let lines: string[]
let outputs: unknown[]
let operatorFiles: string[]
let consoleSpy: ReturnType<typeof spyOn>
beforeEach(() => { h = makeReloadHarness(); lines = []; outputs = []; operatorFiles = []; consoleSpy = spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.map(String).join(' ')) }) })
afterEach(async () => {
  try {
    observe()
    for (const r of h.runs) {
      assertNoLeak(r.captured({ lines, outputs }))
      expect(r.slackPosts()).toEqual([])
      for (const activity of r.toolActivities()) expectNoSlack(activity)
    }
  }
  finally { await h.cleanup(); consoleSpy.mockRestore() }
})
// Every observable version is checked before a tick, confirmation, response or
// reopen can replace it. Only operator-authored config/credentials are excluded
// from the root sweep; server records, previews, queues and failure files remain.
function materialize(...personas: Parameters<ReloadHarness['materialize']>) {
  operatorFiles.push(...personas.map(p => p.credentials_file))
  h.materialize(...personas)
}
function observe(extra: Record<string, unknown> = {}) {
  const tree = h.serverSideFiles(h.paths.config, ...operatorFiles)
  assertNoLeak({ ...(h.runs.includes(run) ? run.captured({ lines, outputs, ...extra }) : { lines, outputs, ...extra }), tree })
}
function retainedPreview() {
  const preview = h.readPending()
  outputs.push(preview)
  observe({ preview })
  return preview
}
async function tick() { observe(); await run.ticks.tick(); observe() }
async function confirm() { observe(); h.confirm(); await tick() }
async function confirmPending() { await tick(); expect(h.pendingExists()).toBe(true); await confirm() }
async function stop() { observe(); await run.stop(); observe() }
async function startRun(opts: ReloadRunOptions, detecting = true) {
  observe()
  run = await (detecting ? h.startDetecting(opts) : h.start(opts))
  observe()
  return run
}
async function loseResponse(...args: Parameters<ReloadRun['loseToolResponse']>) {
  observe()
  await run.loseToolResponse(...args)
  observe()
  for (const activity of run.toolActivities()) expectNoSlack(activity)
}
async function start(channel_mode: 'strict' | 'open' = 'open', discover = true, opts: ReloadRunOptions = {}, alphaDelivery?: DeliveryMode, alphaExtra: string[] = []) {
  const declared = h.persona('alpha')
  const first = { id: declared.channels![0]!.id, delivery: alphaDelivery ?? declared.channels![0]!.delivery }
  const alpha = alphaDelivery || alphaExtra.length ? { ...declared, channels: [first, ...alphaExtra.map(id => ({ id, delivery: 'all' as const }))] } : declared
  const beta = h.persona('beta'); materialize(alpha, beta)
  h.writeConfig({ channel_mode, personas: [alpha, beta] })
  run = await startRun({ realLifecycle: true, ...opts })
  expect(run.outcome!.kind).toBe('applied')
  if (discover) {
    for (const p of [alpha, beta]) run.stub(p.name).script.inventory.push(membershipPage(p.channels!.map(c => c.id)))
    await run.membershipClock.runNext()
    for (const p of [alpha, beta]) expect(run.membershipScanner.status(h.key(p.name)).state).toBe('complete')
  }
  run.registerSession('alpha'); run.registerSession('beta')
  return { alpha, beta, authority: run.controller.sharedChannels()! }
}
/** Expected kinds, rejection reasons and current facts are supplied by each case. */
function attemptResult(channel: string, outcome: BotAttemptResult, current?: ChannelDeliveryCurrentFacts, key = 'alpha') {
  return { isError: outcome.kind !== 'applied', text: channelDeliveryAttemptResultText(key, key, channel, outcome, current) }
}
/** Only the authority-assigned position comes from retained evidence; the
 * expected kind, original facts and current facts come from the case. */
function appliedResult(request: ChannelDeliveryAttemptRequest, historical = false, current: ChannelDeliveryCurrentFacts = available(request.delivery), key = 'alpha') {
  const authority = run.controller.sharedChannels()!
  const record = authority.snapshot().outcomes.botAttempts?.[botAttemptKey(botAttemptBinding(key, authority.incarnation(key)!, request))]
  expect(record).toMatchObject({ status: 'applied', channel: request.channel, delivery: request.delivery,
    facts: { saved: request.delivery, effective: request.delivery } })
  if (record?.status !== 'applied') throw new Error('Expected durable applied attempt')
  return attemptResult(request.channel, { kind: 'applied', historical,
    outcome: { ...record, facts: { saved: request.delivery, effective: request.delivery } } }, current, key)
}
function available(saved: DeliveryMode, mode: 'strict' | 'open' = 'open'): ChannelDeliveryCurrentFacts {
  return { kind: 'available', mode, facts: { saved, effective: saved } }
}
function unavailable(reason: Extract<ChannelDeliveryCurrentFacts, { kind: 'unavailable' }>['reason'], saved?: DeliveryMode): ChannelDeliveryCurrentFacts {
  return { kind: 'unavailable', reason, ...(saved === undefined ? {} : { saved }) }
}
function inactiveResult(key = 'alpha') {
  return { isError: true, text: personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, key) }
}
function durableState() { return parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)! }
function stampOf(state: SharedChannelState, key: string, channel: string): SharedChannelStampState | undefined {
  const life = state.personas[key]
  if (!life) return undefined
  const since = life.assignments[channel]?.threadHybridSince
  return { kind: 'decided', incarnation: life.incarnation, ...(since === undefined ? {} : { threadHybridSince: since }) }
}
/** An expected decided stamp; `since` may be an asymmetric matcher. */
function decided(incarnation: string | undefined, since?: unknown): SharedChannelStampState {
  return { kind: 'decided', incarnation: incarnation!, ...(since === undefined ? {} : { threadHybridSince: since as string }) }
}
/** The live read, a captured view and the durable file report one Channel Stamp. */
function expectStamp(authority: SharedChannelAuthority, key: string, channel: string) {
  const stamp = stampOf(durableState(), key, channel)
  expect(stampOf(authority.snapshot(), key, channel)).toEqual(stamp)
  expect(authority.channelStamp(key, channel)).toEqual(stamp)
  expect(authority.threadView().stamp(key, channel)).toEqual(stamp)
  return stamp
}
type ViewEvent = { kind: 'view'; view: SharedThreadView; durable: SharedChannelState; published: number }
/** A config subscriber registered first still runs after the thread view. */
function watchViews(authority: SharedChannelAuthority) {
  const events: Array<{ kind: 'config' } | ViewEvent> = []
  authority.subscribe(() => { events.push({ kind: 'config' }) })
  authority.subscribeThreadView(view => { events.push({ kind: 'view', view, durable: durableState(), published: run.appliedConfigs.length }) })
  return events
}
/** One publication: its view follows the durable write it reports and a reviewed
 * apply's runtime publication, and precedes every config subscriber, reload's
 * runtime update for a bot or membership write included. */
function expectPublication(events: ReturnType<typeof watchViews>, authority: SharedChannelAuthority, key: string, channel: string, reviewed = false, count = 1) {
  const step = events.splice(0)
  expect(step.map(e => e.kind)).toEqual(Array.from({ length: count }, () => ['view', 'config'] as const).flat())
  const views = step.filter((e): e is ViewEvent => e.kind === 'view')
  for (const { view, durable } of views) expect(view.stamp(key, channel)).toEqual(stampOf(durable, key, channel))
  const { view, published } = views.at(-1)!
  expect(published).toBe(run.appliedConfigs.length - (reviewed ? 0 : 1))
  expect(view.stamp(key, channel)).toEqual(expectStamp(authority, key, channel))
  return view
}
async function call(args: Record<string, unknown>, name = 'alpha', session?: Parameters<ReloadRun['callTool']>[3]) {
  observe()
  try {
    const result = await run.callTool(name, SET_CHANNEL_DELIVERY_TOOL, args, session)
    outputs.push(result)
    return result
  } finally {
    observe()
    for (const activity of run.toolActivities()) expectNoSlack(activity)
  }
}
 test.each(['strict', 'open'] as const)('%s exposes the tool on each persona session', async mode => {
  await start(mode)
  for (const name of ['alpha', 'beta']) {
    const persona = run.serverConfig()!.personas.find(p => p.name === name)!
    const result = await call(deliveryAttempt(`mode-${name}`, persona.channels[0]!.id, 'mentions'), name)
    expect(result).toEqual(mode === 'strict'
      ? { isError: true, text: channelDeliveryDeclarativeRefusal(name, name) }
      : appliedResult(deliveryAttempt(`mode-${name}`, persona.channels[0]!.id, 'mentions'), false, available('mentions'), name))
    expect(result.text).not.toContain('Unknown tool')
  }
 })
 test.each(['off', 'mentions', 'all', 'thread_hybrid'] as const)('strict mode refuses a fresh %s attempt without binding or changing durable state', async delivery => {
  const { alpha, authority } = await start('strict')
  const channel = alpha.channels![0]!.id
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
  const snapshot = authority.snapshot(), revision = authority.revision, cp = run.checkpoint(), published = run.appliedConfigs.length
  const before = readFileSync(h.paths.lastApplied)
  const result = await call(deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, delivery))
  expect(result).toEqual({ isError: true, text: channelDeliveryDeclarativeRefusal(alpha.name, h.key(alpha.name)) })
  expect(readFileSync(h.paths.lastApplied)).toEqual(before)
  expect(authority.revision).toBe(revision)
  expect(authority.snapshot()).toEqual(snapshot)
  expect(authority.snapshot().outcomes.botAttempts).toEqual(snapshot.outcomes.botAttempts)
  expect(run.since(cp).writes).toEqual([])
  expectNoApplication(cp, published)
 })
 test('strict refusal also precedes unverified membership without retaining an attempt', async () => {
  const { alpha, authority } = await start('strict', false)
  const channel = alpha.channels![0]!.id
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('unresolved')
  const snapshot = authority.snapshot(), bytes = readFileSync(h.paths.lastApplied)
  const cp = run.checkpoint(), published = run.appliedConfigs.length
  expect(await call(deliveryAttempt('strict-before-discovery', channel, 'all'))).toEqual({
    isError: true, text: channelDeliveryDeclarativeRefusal('alpha', 'alpha'),
  })
  expect(authority.snapshot()).toEqual(snapshot)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(run.since(cp).writes).toEqual([])
  expectNoApplication(cp, published)
 })
 test.each(['off', 'mentions', 'all', 'thread_hybrid'] as const)('an open-mode %s assignment is one durable application after binding metadata and leaves the neighbor unchanged', async delivery => {
  const { alpha, authority } = await start()
  const channel = alpha.channels![0]!.id
  const before = authority.snapshot(); const checkpoint = run.checkpoint(); const published = run.appliedConfigs.length
  const events = watchViews(authority)
  const result = await call(deliveryAttempt(`all-values-${delivery}`, channel, delivery))
  expect(result.isError).toBe(false)
  const outcome = botApplications(authority.snapshot())[0]!
  expect(outcome.facts).toEqual({ saved: delivery, effective: delivery })
  expect(result.text).toBe(channelDeliveryAttemptResultText(alpha.name, 'alpha', channel,
    { kind: 'applied', historical: false, outcome },
    { kind: 'available', mode: 'open', facts: { saved: delivery, effective: delivery } }))
  // Mint over another value, in the application's own durable write; the binding write delivers no view.
  const view = expectPublication(events, authority, 'alpha', channel)
  const first = view.stamp('alpha', channel)
  expect(first).toEqual(decided(before.personas.alpha!.incarnation, delivery === 'thread_hybrid' ? expect.any(String) : undefined))
  const since = authority.snapshot().personas.alpha!.assignments[channel]!.threadHybridSince
  for (const fact of [since, before.personas.alpha!.incarnation]) if (fact) expect(result.text).not.toContain(fact)
  expect(authority.revision).toBe(before.revision + 2)
  expect(authority.choice(h.key('alpha'), channel)).toBe(delivery)
  expect(authority.snapshot().personas[h.key('beta')]).toEqual(before.personas[h.key('beta')])
  expect(run.since(checkpoint).writes).toEqual(Array.from({ length: 2 }, () => ({ path: h.paths.lastApplied, ok: true })))
  expectNoSlack(run.since(checkpoint))
  expect(botApplications(authority.snapshot())).toHaveLength(1)
  expect(run.toolActivities()).toHaveLength(1)
  expect(run.appliedConfigs).toHaveLength(published + 1)
  expect(existsSync(join(h.stateDir, 'channel-delivery.json'))).toBe(false)
  expect(parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)!.personas[h.key('alpha')]!.assignments[channel]!.delivery).toBe(delivery)
  const plain = makeChannelMessage({ channel, text: 'next ordinary event', ts: TIMES.ordinary })
  const mention = makeChannelMessage({ channel, text: `${mentionText(run.stub('alpha').identity.botUserId)} next mention`, ts: TIMES.mention })
  await run.deliver('alpha', plain)
  await run.deliver('alpha', mention)
  expect(run.queued('alpha').map(({ accepted: { channel, ts, text, via } }) => ({ channel, ts, text, via }))).toEqual([
    ...(delivery === 'all' ? [{ channel, ts: plain.ts as string, text: plain.text as string, via: 'receive_all' }] : []),
    ...(delivery === 'off' ? [] : [{ channel, ts: mention.ts as string, text: mention.text as string, via: 'mention' }]),
  ])
  expect(run.queued('beta')).toEqual([])
  // A fresh thread_hybrid attempt keeps a thread_hybrid entry's value and mints over any other.
  expect(await call(deliveryAttempt(`then-thread-hybrid-${delivery}`, channel, 'thread_hybrid'))).toEqual(appliedResult(deliveryAttempt(`then-thread-hybrid-${delivery}`, channel, 'thread_hybrid')))
  const hybrid = expectPublication(events, authority, 'alpha', channel).stamp('alpha', channel)
  expect(hybrid).toEqual(delivery === 'thread_hybrid' ? first : decided(before.personas.alpha!.incarnation, expect.any(String)))
  expect(view.stamp('alpha', channel)).toEqual(first)
  expect(authority.channelStamp('beta', channel)).toEqual(stampOf(before, 'beta', channel))
  expect(authority.channelStamp('unknown', channel)).toBeUndefined()
 })
 test.each([undefined, null, 'everything', LEAK_SENTINEL, fakeToken(BOT_TOKEN_PREFIX, 'delivery')])('bad delivery %p is refused without storing or echoing secrets', async delivery => {
  const { alpha, authority } = await start()
  const before = authority.snapshot()
  expect(await call({ ...deliveryAttempt('bad-value', alpha.channels![0]!.id, 'all'), delivery })).toEqual({ isError: true, text: channelDeliveryValueRefusal(alpha.name, h.key(alpha.name), delivery) })
  expect(authority.snapshot()).toEqual(before)
 })
 test.each([undefined, null, 'D0DIRECT1', 'G0UNKNOWN', 'C0UNKNOWN', { nested: LEAK_SENTINEL }, fakeToken(BOT_TOKEN_PREFIX, 'channel')])('unknown/invalid channel %p is refused without changing the authority', async channel => {
  const { authority } = await start(); const before = authority.snapshot()
  expect(await call({ ...deliveryAttempt('bad-channel', C.primary, 'all'), channel })).toEqual(channel === 'G0UNKNOWN' || channel === 'C0UNKNOWN'
    ? attemptResult(channel, { kind: 'not-applied', reason: 'membership' }, unavailable('channel-removed'))
    : { isError: true, text: channelDeliveryChannelRefusal('alpha', 'alpha', channel) })
  expect(botApplications(authority.snapshot())).toEqual([])
  expect(authority.snapshot().personas).toEqual(before.personas)
 })
 test('a retiring persona is refused while the other persona keeps its own writable life', async () => {
  const { alpha, beta, authority } = await start()
  run.channelDelivery.beginRetiring([h.key('alpha')])
  expect(await call(deliveryAttempt('retiring', alpha.channels![0]!.id, 'all'))).toEqual(inactiveResult())
  expect(await call(deliveryAttempt('healthy', beta.channels![0]!.id, 'off'), 'beta')).toEqual(appliedResult(deliveryAttempt('healthy', beta.channels![0]!.id, 'off'), false, available('off'), 'beta'))
  expect(authority.choice(h.key('beta'), beta.channels![0]!.id)).toBe('off')
 })
 test('capacity failure returns an error, keeps source, applied state and confirmation authority unchanged', async () => {
  const { alpha, authority } = await start(); const before = authority.snapshot(); const bytes = readFileSync(h.paths.lastApplied)
  h.failWrites({ step: 'writeSync', code: 'ENOSPC' })
  expect(await call(deliveryAttempt('capacity', alpha.channels![0]!.id, 'off'))).toEqual(attemptResult(alpha.channels![0]!.id, { kind: 'unresolved' }, available('all')))
  expect(authority.snapshot()).toEqual(before)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
 })
 test('a prior session cannot write after the applied persona was removed', async () => {
  const { alpha, beta, authority } = await start()
  const session = run.session('alpha')
  h.writeConfig({ channel_mode: 'open', personas: [beta] })
  await confirmPending()
  const revision = authority.revision
  expect(await call(deliveryAttempt('removed', alpha.channels![0]!.id, 'all'), 'alpha', session)).toEqual(inactiveResult())
  expect(authority.revision).toBe(revision)
  expect(authority.incarnation(h.key('alpha'))).toBeUndefined()
 })

test('real MCP and routed traffic refuse unverified/absent membership; authenticated discovery alone enables a fresh assignment', async () => {
  const { alpha, authority } = await start('open', false)
  const channel = alpha.channels![0]!.id
  const before = authority.snapshot()
  expect(await call(deliveryAttempt('unverified', channel, 'off'))).toEqual(attemptResult(channel, { kind: 'not-applied', reason: 'membership' }, unavailable('current-membership-missing', 'all')))
  const { makeChannelMessage } = await import('./test-helpers/slack-stub.ts')
  await run.deliver('alpha', makeChannelMessage({ channel }))
  expect(run.stub('alpha').socket.acks).toHaveLength(0)
  expect(run.queued('alpha')).toEqual([])
  expect(run.stub('alpha').calls.inventory).toHaveLength(0)
  expect(authority.snapshot().personas).toEqual(before.personas)
  expect(botApplications(authority.snapshot())).toEqual([])
  expect(run.appliedConfigs).toEqual([])
  await run.membershipClock.runNext() // The stub's valid empty inventory establishes absence.
  expect(run.membership.read('alpha', channel, 'open')).toEqual({ kind: 'ineligible', reason: 'absent' })
  const absent = authority.snapshot()
  expect(await call(deliveryAttempt('absent', channel, 'off'))).toEqual(attemptResult(channel, { kind: 'not-applied', reason: 'membership' }, unavailable('absent', 'all')))
  expect(authority.snapshot().personas).toEqual(absent.personas)
  expect(botApplications(authority.snapshot())).toEqual([])
  run.stub('alpha').script.inventory.push(membershipPage([channel]))
  run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
  expect(await call(deliveryAttempt('discovered', channel, 'off'))).toEqual(appliedResult(deliveryAttempt('discovered', channel, 'off')))
  expect(authority.choice('alpha', channel)).toBe('off')
})

test('dry restart composes the real MCP guard with persisted membership, queue and pending input but constructs no Slack work', async () => {
  const { alpha, beta } = await start()
  const channel = alpha.channels![0]!.id
  const { slackInput } = await import('./test-helpers/delivery-queue.ts')
  await run.queue.accept('alpha', slackInput({ text: '  retained\r\n\r\nbody  ', queued_ack_reaction: 'hourglass' }))
  const accepted = structuredClone(run.queued('alpha')[0]!.accepted)
  h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }, beta] })
  await tick()
  expect(h.pendingExists()).toBe(true)
  const input = readFileSync(h.paths.config), pending = readFileSync(h.paths.pending)
  const before = run.controller.sharedChannels()!.snapshot()
  await stop()
  for (let restart = 0; restart < 2; restart++) {
    run = await startRun({ dryRun: true, realLifecycle: true }, false)
    run.registerSession('alpha')
    expect(await call({ ...deliveryAttempt('bad-channel', C.primary, 'all'), channel })).toEqual({ isError: true, text: channelDeliveryDryRunRefusal('alpha', 'alpha') })
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
    await stop()
  }
  run = await startRun({ realLifecycle: true }, false)
  run.stub('alpha').script.inventory.push(membershipPage([channel])); await run.membershipClock.runNext()
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
})


function applications() { return botApplications(run.controller.sharedChannels()!.snapshot()) }
function assignmentLogs() { return run.logs.filter(line => line.includes(PERSONA_CHANNEL_DELIVERY_SET)) }
function expectNoApplication(cp: ReturnType<ReloadRun['checkpoint']>, published: number) {
  expect(run.since(cp).lifecycle).toEqual([])
  expectNoSlack(run.since(cp))
  expect(run.since(cp).logs.filter(line => line.includes(PERSONA_CHANNEL_DELIVERY_SET))).toEqual([])
  expect(run.appliedConfigs).toHaveLength(published)
}

test.each(['fresh assignment', 'retained history'] as const)('connected current but not-up session refuses %s while its healthy neighbor applies', async kind => {
  const { alpha, beta, authority } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all')
  if (kind === 'retained history') expect(await call(request)).toEqual(appliedResult(request))
  const session = run.session('alpha')!, life = authority.incarnation('alpha')
  run.bringUps.cancel('alpha')
  expect(run.isUp('alpha')).toBe(false)
  expect(run.session('alpha')).toBe(session)
  expect(session.connected).toBe(true)
  expect(authority.incarnation('alpha')).toBe(life)
  expect(run.membership.read('alpha', request.channel, 'open').kind).toBe('eligible')
  expect(run.isUp('beta')).toBe(true)
  const before = authority.snapshot(), bytes = readFileSync(h.paths.lastApplied), source = h.readConfig()
  const cp = run.checkpoint(), published = run.appliedConfigs.length, ad = stubCallCount(run.composition!.agentDirector)
  const result = await call(kind === 'retained history' ? retryAttempt(request) : request, 'alpha', session)
  expect(result).toEqual(inactiveResult())
  expect(result.text).not.toContain('previously applied')
  expect(result.text).not.toContain('original saved')
  expect(result.text).not.toContain('Current saved')
  expect(authority.snapshot()).toEqual(before)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(h.readConfig()).toEqual(source)
  expect(run.since(cp).writes).toEqual([])
  expect(run.since(cp).removes).toEqual([])
  expect(run.since(cp).logs).toEqual([])
  expect(stubCallCount(run.composition!.agentDirector)).toBe(ad)
  expectNoApplication(cp, published)
  expect(await call(deliveryAttempt('healthy-beside-not-up', beta.channels![0]!.id, 'off'), 'beta')).toEqual(appliedResult(deliveryAttempt('healthy-beside-not-up', beta.channels![0]!.id, 'off'), false, available('off'), 'beta'))
  expect(authority.choice('beta', beta.channels![0]!.id)).toBe('off')
  expect(authority.snapshot().personas.alpha).toEqual(before.personas.alpha)
  expect(applications()).toHaveLength(kind === 'retained history' ? 2 : 1)
  expect(run.appliedConfigs).toHaveLength(published + 1)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(stubCallCount(run.composition!.agentDirector)).toBe(ad)
  expect(run.session('alpha')).toBe(session)
  expect(session.connected).toBe(true)
})

test.each(['strict', 'open'] as const)('%s negotiates the exact four-field schema and retained-ID instructions through actual MCP', async mode => {
  await start(mode)
  for (const name of ['alpha', 'beta']) {
    const listing = await run.listTools(name)
    const tools = listing.tools.filter(t => t.name === SET_CHANNEL_DELIVERY_TOOL)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.inputSchema).toEqual(SET_CHANNEL_DELIVERY_INPUT_SCHEMA)
    expect(tools[0]!.description).toBe(SET_CHANNEL_DELIVERY_DESCRIPTION)
    expect(tools[0]!.inputSchema.required).toEqual(['channel', 'delivery', 'attempt_id', 'intent'])
    expect(tools[0]!.inputSchema.additionalProperties).toBe(false)
  }
  expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048)
  expect(MCP_INSTRUCTIONS).toContain('Retain attempt_id before submission')
})

test.each([
  ['attempt_id', undefined], ['attempt_id', null], ['attempt_id', ''], ['attempt_id', ' \t\r\n'], ['attempt_id', 42], ['attempt_id', {}],
  ['intent', undefined], ['intent', null], ['intent', ''], ['intent', 'new'], ['intent', 42], ['intent', LEAK_SENTINEL],
  ['extra', LEAK_SENTINEL],
] as const)('actual direct call rejects invalid %s field without binding, application or disclosure', async (field, value) => {
  const { alpha, authority } = await start()
  const args: Record<string, unknown> = { ...deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all'), [field]: value }
  if (value === undefined) delete args[field]
  const bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint(), published = run.appliedConfigs.length
  expect(await call(args)).toEqual({ isError: true, text: channelDeliveryAttemptInputRefusal('alpha', 'alpha') })
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(authority.snapshot().outcomes.botAttempts).toBeUndefined()
  expectNoApplication(cp, published)
})

test.each([C.primary, C.private])('authenticated %s discovery authorizes before traffic and before the final inventory page', async channel => {
  await start('open', false)
  const held = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(membershipPage([channel], 'final'), held.outcome)
  await run.membershipClock.runNext(); await run.membershipClock.flush()
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('eligible')
  expect(run.queued('alpha')).toEqual([])
  expect(await call(deliveryAttempt('discovered-before-traffic', channel, 'thread_hybrid'))).toEqual(appliedResult(deliveryAttempt('discovered-before-traffic', channel, 'thread_hybrid')))
  expect(applications()).toHaveLength(1)
  held.settle(membershipPage([])); await run.membershipClock.flush()
})

test.each([true, undefined, null, 'false', 0, false] as const)('fresh assignment requires explicit false external sharing (%p)', async external => {
  const { beta } = await start('open', false)
  run.stub('alpha').script.inventory.push(membershipPage([{ id: C.primary, is_channel: true, is_im: false, is_mpim: false, is_ext_shared: external, is_org_shared: true }]))
  run.stub('beta').script.inventory.push(membershipPage(beta.channels!.map(c => c.id)))
  await run.membershipClock.runNext()
  const cp = run.checkpoint(), published = run.appliedConfigs.length
  const sharing = deliveryAttempt('sharing', C.primary, 'all')
  expect(await call(sharing)).toEqual(external === false ? appliedResult(sharing) :
    attemptResult(C.primary, { kind: 'not-applied', reason: 'membership' }, external === true ? unavailable('external-sharing', 'mentions') : unavailable('channel-removed')))
  expect(applications()).toHaveLength(external === false ? 1 : 0)
  if (external !== false) expectNoApplication(cp, published)
  expect(await call(deliveryAttempt('neighbor', beta.channels![0]!.id, 'off'), 'beta')).toEqual(appliedResult(deliveryAttempt('neighbor', beta.channels![0]!.id, 'off'), false, available('off'), 'beta'))
})

test('concurrent copies and a reconnect occupy one position; fresh same-value ID occupies a second', async () => {
  const { alpha, authority } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all')
  const published = run.appliedConfigs.length
  const results = await Promise.all([call(request), call(request), call(retryAttempt(request))])
  expect(results.map(r => r.text).sort()).toEqual([appliedResult(request).text, appliedResult(request, true).text, appliedResult(request, true).text].sort())
  for (const result of results) expect(result.isError).toBe(false)
  expect(results.filter(r => r.text.includes('newly applied'))).toHaveLength(1)
  const original = applications()[0]!
  expect(applications()).toHaveLength(1)
  expect(assignmentLogs()).toHaveLength(1)
  expect(run.appliedConfigs).toHaveLength(published + 1)
  const old = run.session('alpha')!, bytes = readFileSync(h.paths.lastApplied)
  run.registerSession('alpha')
  expect(await call(retryAttempt(request))).toEqual(appliedResult(request, true))
  expect(await call(retryAttempt(request), 'alpha', old)).toEqual(inactiveResult())
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(await call(deliveryAttempt('fresh-equal-value', request.channel, request.delivery))).toEqual(appliedResult(deliveryAttempt('fresh-equal-value', request.channel, request.delivery)))
  expect(applications().map(r => r.resolvedOrder)).toEqual([original.resolvedOrder, original.resolvedOrder + 2])
  expect(assignmentLogs()).toHaveLength(2)
  expect(authority.choice('alpha', request.channel)).toBe('all')
})

test.each(['channel', 'delivery'] as const)('reusing a retained ID with changed %s reveals no original binding or facts', async field => {
  const { alpha } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all')
  expect(await call(request)).toEqual(appliedResult(request))
  const bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint(), published = run.appliedConfigs.length
  const result = await call({ ...request, [field]: field === 'channel' ? C.private : 'off' })
  expect(result).toEqual(attemptResult(field === 'channel' ? C.private : request.channel, { kind: 'binding-conflict' }))
  expect(result.text).toContain('original inputs are not disclosed')
  expect(result.text).not.toContain(request.channel)
  expect(result.text).not.toContain('Current saved')
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expectNoApplication(cp, published)
})

test.each(['same', 'channel', 'delivery'] as const)('another current persona cannot distinguish a retained ID from unknown with %s inputs', async field => {
  const { alpha, beta, authority } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all')
  expect(await call(request)).toEqual(appliedResult(request))
  expect(run.isUp('beta')).toBe(true)
  expect(run.session('beta')!.connected).toBe(true)
  expect(run.membership.read('beta', beta.channels![0]!.id, 'open').kind).toBe('eligible')
  const probe = { ...retryAttempt(request),
    ...(field === 'channel' ? { channel: beta.channels![0]!.id } : {}),
    ...(field === 'delivery' ? { delivery: 'off' as const } : {}),
  }
  const before = authority.snapshot(), bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint()
  const published = run.appliedConfigs.length, ad = stubCallCount(run.composition!.agentDirector)
  const foreign = await call(probe, 'beta')
  const foreignPayload = run.toolResponses().at(-1)!.message
  const unknown = await call({ ...probe, attempt_id: 'unknown-to-both-personas' }, 'beta')
  expect(foreign).toEqual(unknown)
  expectSameResponse(foreignPayload, run.toolResponses().at(-1)!.message)
  expect(foreign).toEqual(attemptResult(probe.channel, { kind: 'unresolved' }, field === 'channel' ? available('all') : unavailable('channel-removed'), 'beta'))
  expect(foreign.text).toContain('outcome is unresolved')
  expect(foreign.text).not.toContain('original saved')
  expect(foreign.text).not.toContain('previously applied')
  expect(foreign.text).not.toContain('original inputs')
  expect(foreign.text).not.toContain('alpha')
  expect(authority.snapshot()).toEqual(before)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(run.since(cp).writes).toEqual([])
  expect(run.since(cp).removes).toEqual([])
  expectNoApplication(cp, published)
  expect(stubCallCount(run.composition!.agentDirector)).toBe(ad)
  // The same opaque ID may bind independently to beta's own eligible channel.
  expect(await call(deliveryAttempt(request.attempt_id, beta.channels![0]!.id, 'off'), 'beta')).toEqual(appliedResult(deliveryAttempt(request.attempt_id, beta.channels![0]!.id, 'off'), false, available('off'), 'beta'))
  expect(authority.snapshot().personas.alpha).toEqual(before.personas.alpha)
  expect(applications()).toHaveLength(2)
  const ownHistory = await call(retryAttempt(request))
  expect(ownHistory).toEqual(appliedResult(request, true))
  expect(ownHistory.text).toContain('previously applied')
  expect(ownHistory.text).toContain('original saved all')
})

test('total response loss then process reopen recovers once without overwriting a newer operator choice', async () => {
  const { alpha, authority } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all') // Retained before the first submission.
  await loseResponse('alpha', SET_CHANNEL_DELIVERY_TOOL, request)
  expect(run.toolActivities()).toHaveLength(1)
  const original = applications()[0]!
  expect(assignmentLogs()).toHaveLength(1)
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, authority.incarnation('alpha')!, request.channel, 'off')])
  await tick(); await confirm()
  expect(authority.choice('alpha', request.channel)).toBe('off')
  const position = authority.snapshot().personas.alpha!.assignments[request.channel]!.order
  await stop()
  run = await startRun({ realLifecycle: true }); run.registerSession('alpha')
  const bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint(), published = run.appliedConfigs.length
  const result = await call(retryAttempt(request))
  expect(result.isError).toBe(false)
  expect(result).toEqual(attemptResult(request.channel, { kind: 'applied', historical: true, outcome: original }, unavailable('current-membership-missing', 'off')))
  expect(result.text).toContain(`previously applied at position ${original.resolvedOrder}`)
  expect(result.text).toContain('original saved all')
  expect(result.text).toContain('Current saved off; effective delivery is unavailable')
  expect(run.controller.sharedChannels()!.snapshot().personas.alpha!.assignments[request.channel]!.order).toBe(position)
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expectNoApplication(cp, published)
})

test.each(['strict', 'gap', 'replaced-session', 'disconnected-session', 'retiring', 'verified-leave', 'identity-replacement'] as const)('an admitted request rechecks %s at the application turn', async boundary => {
  const gate = makeToolCallGate()
  const { alpha, beta, authority } = await start('open', true, { beforeToolCall: gate.wait })
  const request = deliveryAttempt(`held-${boundary}`, alpha.channels![0]!.id, 'all')
  const pending = call(request)
  await gate.entered
  if (boundary === 'strict') { h.writeConfig({ channel_mode: 'strict', personas: [alpha, beta] }); await confirmPending() }
  if (boundary === 'gap') run.membershipScanner.connectionChanged('alpha')
  if (boundary === 'replaced-session') run.registerSession('alpha')
  if (boundary === 'disconnected-session') run.session('alpha')!.connected = false
  if (boundary === 'retiring') run.channelDelivery.beginRetiring(['alpha'])
  if (boundary === 'verified-leave') await run.stub('alpha').socket.deliver({ type: 'channel_left', channel: request.channel, event_ts: membershipEventTimestamp(run.membershipClock.now()) }, { event_id: EVENTS.heldLeave })
  if (boundary === 'identity-replacement') {
    const replacement = { ...alpha, working_directory: join(h.root, 'replacement-working') }; materialize(replacement)
    h.writeConfig({ channel_mode: 'open', personas: [replacement, beta] }); await confirmPending()
  }
  const before = authority.snapshot().personas, cp = run.checkpoint(), published = run.appliedConfigs.length
  gate.release()
  expect(await pending).toEqual(boundary === 'strict'
    ? { isError: true, text: channelDeliveryDeclarativeRefusal('alpha', 'alpha') }
    : boundary === 'gap' || boundary === 'verified-leave'
      ? attemptResult(request.channel, { kind: 'not-applied', reason: 'membership' }, boundary === 'gap' ? unavailable('current-membership-missing', 'all') : unavailable('channel-removed'))
      : inactiveResult())
  expect(authority.snapshot().personas).toEqual(before)
  expect(applications()).toEqual([])
  expectNoApplication(cp, published)
})

test('same-location credential rotation preserves history and session but cannot lend old membership to an admitted fresh request', async () => {
  const gate = makeToolCallGate()
  let hold = false
  const { alpha, beta, authority } = await start('open', true, { beforeToolCall: async () => { if (hold) await gate.wait() } })
  const original = deliveryAttempt('before-rotation', alpha.channels![0]!.id, 'all')
  expect(await call(original)).toEqual(appliedResult(original))
  const session = run.session('alpha'), life = authority.incarnation('alpha')
  const admitted = deliveryAttempt('admitted-before-rotation', original.channel, 'off')
  hold = true
  const pending = call(admitted); await gate.entered
  h.rotateCredentials(alpha, { slack: { appId: 'A0ROTATED', botUserId: 'U0ROTATED', botId: 'B0ROTATED' } })
  await confirmPending()
  expect(run.session('alpha')).toBe(session)
  expect(authority.incarnation('alpha')).toBe(life)
  expect(run.membership.read('alpha', original.channel, 'open').kind).toBe('unresolved')
  const cp = run.checkpoint(), published = run.appliedConfigs.length
  gate.release(); hold = false
  expect(await pending).toEqual(attemptResult(admitted.channel, { kind: 'not-applied', reason: 'membership' }, unavailable('current-membership-missing', 'all')))
  expect(authority.choice('alpha', original.channel)).toBe('all')
  expectNoApplication(cp, published)
  const history = await call(retryAttempt(original))
  expect(history).toEqual(appliedResult(original, true, unavailable('current-membership-missing', 'all')))
  expect(history.text).toContain('previously applied')
  expect(history.text).toContain('Current saved all; effective delivery is unavailable: current membership is unverified.')
  expect(await call(deliveryAttempt('unaffected-rotation-neighbor', beta.channels![0]!.id, 'off'), 'beta')).toEqual(appliedResult(deliveryAttempt('unaffected-rotation-neighbor', beta.channels![0]!.id, 'off'), false, available('off'), 'beta'))
  run.currentStub('alpha')!.script.inventory.push(membershipPage([original.channel])); await run.membershipClock.runNext()
  expect(await call(retryAttempt(admitted))).toEqual(attemptResult(admitted.channel, { kind: 'not-applied', reason: 'membership' }, available('all')))
  expect(await call(deliveryAttempt('authenticated-after-rotation', original.channel, 'off'))).toEqual(appliedResult(deliveryAttempt('authenticated-after-rotation', original.channel, 'off')))
  expect(applications().filter(r => r.key === 'alpha')).toHaveLength(2)
})

test('shutdown after durable binding denies application before the handler can commit', async () => {
  let armed = false, shutdown: Promise<void> | undefined
  const { alpha, authority } = await start('open', true, { beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && botAttemptRecord(bytes, path, 'pending')) {
      armed = false; shutdown = run.stop()
    }
  } })
  const before = authority.snapshot().personas, published = run.appliedConfigs.length
  armed = true
  const outcome = await call(deliveryAttempt('shutdown-binding', alpha.channels![0]!.id, 'off')).then(result => { expect(result).toEqual(inactiveResult()); return 'refused' }, () => 'closed')
  await shutdown
  expect(['refused', 'closed']).toContain(outcome)
  expect(authority.snapshot().personas).toEqual(before)
  expect(applications()).toEqual([])
  expect(assignmentLogs()).toEqual([])
  expect(run.appliedConfigs).toHaveLength(published)
})

test('session authority is rechecked after pending binding and before assignment; duplicate observes pending only', async () => {
  let armed = false, pendingResult: unknown
  const { alpha, authority } = await start('open', true, { beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && botAttemptRecord(bytes, path, 'pending')) {
      armed = false
      pendingResult = run.channelDelivery.lookupAttempt('alpha', authority.incarnation('alpha')!, request)
      run.registerSession('alpha')
    }
  } })
  const request = deliveryAttempt('binding-turn', alpha.channels![0]!.id, 'all')
  const cp = run.checkpoint(), published = run.appliedConfigs.length
  armed = true
  expect(await call(request)).toEqual(inactiveResult())
  expect(pendingResult).toEqual({ kind: 'pending' })
  expect(applications()).toEqual([])
  expect(Object.values(authority.snapshot().outcomes.botAttempts!)[0]).toMatchObject({ status: 'not-applied', reason: 'inactive' })
  expectNoApplication(cp, published)
  expect(await call(retryAttempt(request))).toEqual(attemptResult(request.channel, { kind: 'not-applied', reason: 'inactive' }, available('all')))
})

test.each(['no-binding', 'rejected', 'lost-rejection', 'unsynced-binding', 'unsynced-application'] as const)(
  '%s retains distinct production durability evidence through response loss, repair and reopen', async fault => {
    let armed = false
    const { alpha, beta, authority } = await start('open', true, { beforeWrite(path, bytes) {
      if (!armed || path !== h.paths.lastApplied) return
      const atBinding = fault === 'no-binding' || fault === 'unsynced-binding'
      if (!botAttemptRecord(bytes, path, atBinding ? 'pending' : 'applied')) return
      armed = false
      h.failWrites(fault.startsWith('unsynced') ? { path, step: 'fsyncSync', code: 'EIO', call: 2 } :
        { path, step: 'writeSync', code: 'ENOSPC', ...(fault === 'lost-rejection' ? {} : { call: 1 }) })
    } })
    const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'thread_hybrid')
    h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }, beta] })
    await tick()
    const config = h.readConfig(), pending = retainedPreview(), before = authority.snapshot().personas
    const published = run.appliedConfigs.length, cp = run.checkpoint()
    armed = true
    await loseResponse('alpha', SET_CHANNEL_DELIVERY_TOOL, request)
    expect(assignmentLogs()).toHaveLength(0)
    expectNoApplication(cp, published)
    const installed = parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)!
    const records = Object.values(installed.outcomes.botAttempts ?? {})
    expect(records.map(r => r.status)).toEqual(fault === 'no-binding' ? [] :
      [fault === 'rejected' ? 'not-applied' : fault === 'unsynced-application' ? 'applied' : 'pending'])
    if (fault !== 'unsynced-application') expect(installed.personas).toEqual(before)
    else expect(installed.personas.alpha!.assignments[request.channel]).toEqual({ delivery: 'thread_hybrid', order: expect.any(Number), threadHybridSince: expect.any(String) })
    // Repeated failure cannot restore an old baseline or publish an uncertain application.
    if (fault.startsWith('unsynced')) {
      h.failWrites({ path: h.paths.lastApplied, step: 'writeSync', code: 'EIO' })
      const retained = readFileSync(h.paths.lastApplied)
      observe({ retained, config, pending })
      expect(authority.recoverDurability().kind).toBe('unresolved')
      expect(readFileSync(h.paths.lastApplied)).toEqual(retained)
      expectNoApplication(cp, published)
    }
    h.clearWriteFailure()
    await stop()
    run = await startRun({ realLifecycle: true }); run.registerSession('alpha')
    // AC-W10: the reopened value and its Thread Hybrid Since agree with one side of the interrupted write.
    expect(run.controller.sharedChannels()!.snapshot().personas.alpha!.assignments[request.channel])
      .toEqual(fault === 'unsynced-application' ? installed.personas.alpha!.assignments[request.channel] : before.alpha!.assignments[request.channel])
    const bytes = readFileSync(h.paths.lastApplied), after = run.checkpoint(), count = run.appliedConfigs.length
    const result = await call(retryAttempt(request))
    expect(result).toEqual(fault === 'unsynced-application'
      ? appliedResult(request, true, unavailable('current-membership-missing', 'thread_hybrid'))
      : attemptResult(request.channel, fault === 'no-binding' ? { kind: 'unresolved' } : fault === 'rejected'
        ? { kind: 'not-applied', reason: 'write-failed' } : { kind: 'pending' }, unavailable('current-membership-missing', 'all')))
    expect(result.text).toContain(fault === 'no-binding' ? 'outcome is unresolved' : fault === 'rejected' ? 'this attempt did not apply' :
      fault === 'unsynced-application' ? 'previously applied' : 'retained attempt is pending')
    expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
    expect(h.readConfig()).toEqual(config); expect(retainedPreview()).toEqual(pending)
    expectNoApplication(after, count)
    // Restored membership/storage never promotes an old unknown/pending/rejected ID into a write.
    for (const p of [alpha, beta]) run.stub(p.name).script.inventory.push(membershipPage(p.channels!.map(c => c.id)))
    await run.membershipClock.runNext()
    const position = run.controller.sharedChannels()!.snapshot().personas.alpha!.assignments[request.channel]!.order
    expect(await call(retryAttempt(request))).toEqual(fault === 'unsynced-application' ? appliedResult(request, true) :
      attemptResult(request.channel, fault === 'no-binding' ? { kind: 'unresolved' } : fault === 'rejected'
        ? { kind: 'not-applied', reason: 'write-failed' } : { kind: 'pending' }, available('all')))
    expect(run.controller.sharedChannels()!.snapshot().personas.alpha!.assignments[request.channel]!.order).toBe(position)
    expect(assignmentLogs()).toEqual([])
  },
)

test('exact installed-byte recovery publishes and diagnoses once at the original position without rollback', async () => {
  let armed = false
  const { alpha, authority } = await start('open', true, { beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && botAttemptRecord(bytes, path, 'applied')) {
      armed = false; h.failWrites({ path, step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } })
  const request = deliveryAttempt('uncertain-application', alpha.channels![0]!.id, 'off')
  const published = run.appliedConfigs.length
  armed = true
  expect(await call(request)).toEqual(attemptResult(request.channel, { kind: 'unresolved' }, unavailable('shared-state-unreadable')))
  const bytes = readFileSync(h.paths.lastApplied), installed = parseSharedChannelState(bytes, h.paths.lastApplied)!
  expect(assignmentLogs()).toEqual([])
  h.clearWriteFailure()
  // A semantically equal file is still not the exact installed write whose
  // durability is uncertain. Recovery must preserve it without publication.
  const altered = Buffer.concat([bytes, Buffer.from(' \n')])
  observe({ bytes, altered })
  durableWriteFileSync(h.paths.lastApplied, altered)
  expect(authority.recoverDurability().kind).toBe('unresolved')
  expect(readFileSync(h.paths.lastApplied)).toEqual(altered)
  expect(await call(retryAttempt(request))).toEqual(attemptResult(request.channel, { kind: 'unresolved' }, unavailable('shared-state-unreadable')))
  expect(run.appliedConfigs).toHaveLength(published)
  expect(assignmentLogs()).toEqual([])
  observe({ bytes, altered })
  durableWriteFileSync(h.paths.lastApplied, bytes)
  expect(authority.recoverDurability().kind).toBe('applied')
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(authority.revision).toBe(installed.revision)
  expect(run.appliedConfigs).toHaveLength(published + 1)
  expect(assignmentLogs()).toHaveLength(1)
  expect(await call(retryAttempt(request))).toEqual(appliedResult(request, true, available('off')))
  expect(authority.recoverDurability().kind).toBe('applied')
  expect(run.appliedConfigs).toHaveLength(published + 1)
  expect(assignmentLogs()).toHaveLength(1)
})

test.each(['all', 'thread_hybrid'] as const)('%s in another persona destination reports equal facts and selects the next event', async delivery => {
  const { alpha, beta, authority } = await start('open', true, { threadMemory: {} })
  const channel = beta.channels![0]!.id
  run.stub('alpha').script.inventory.push(membershipPage([alpha.channels![0]!.id, channel]))
  run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  expect(authority.choice('alpha', channel)).toBe('mentions')
  const request = deliveryAttempt(`destination-${delivery}`, channel, delivery)
  const result = await call(request), outcome = applications()[0]!
  expect(outcome.facts).toEqual({ saved: delivery, effective: delivery })
  expect(botApplications(durableState())[0]!.facts).toEqual(outcome.facts)
  expect(result).toEqual({ isError: false, text: channelDeliveryAttemptResultText(alpha.name, 'alpha', channel,
    { kind: 'applied', historical: false, outcome },
    { kind: 'available', mode: 'open', facts: { saved: delivery, effective: delivery } }) })
  expect(assignmentLogs()).toEqual([formatPersonaDiagnostic({ class: PERSONA_CHANNEL_DELIVERY_SET,
    name: alpha.name, key: 'alpha', index: 0, cause: channelDeliverySetCause(channel, 'mentions', delivery, delivery) })])
  expect([result.text, ...assignmentLogs()].join('\n')).not.toMatch(/loop.?guard|restrict|destination/i)
  if (delivery === 'thread_hybrid') await run.joinThread('alpha', channel, THREAD_ROOTS.primary)
  const joined = makeChannelMessage({ channel, thread_ts: THREAD_ROOTS.primary,
    ts: TIMES.ordinary, text: 'a reply in the joined thread' })
  const unrelated = makeChannelMessage({ channel, thread_ts: THREAD_ROOTS.secondary,
    ts: TIMES.mention, text: 'a reply in a different thread' })
  const expected = [{ channel, ts: joined.ts as string, text: joined.text as string, via: delivery === 'all' ? 'receive_all_shared' : 'thread' }]
  await run.deliver('alpha', joined)
  expect(run.queued('alpha').map(({ accepted: { channel, ts, text, via } }) => ({ channel, ts, text, via }))).toEqual(expected)
  expect(run.queued('beta')).toEqual([])
  await run.deliver('alpha', unrelated)
  if (delivery === 'all') expected.push({ channel, ts: unrelated.ts as string, text: unrelated.text as string, via: 'receive_all_shared' })
  expect(run.queued('alpha').map(({ accepted: { channel, ts, text, via } }) => ({ channel, ts, text, via }))).toEqual(expected)
  expect(run.queued('beta')).toEqual([])
})

test.each(['strict', 'open'] as const)('%s discovery keeps its default and an explicit off through both mode switches and a new destination', async initialMode => {
  const { alpha, beta, authority } = await start(initialMode)
  const channel = C.private
  const discover = async () => {
    run.stub('alpha').script.inventory.push(membershipPage([alpha.channels![0]!.id, channel]))
    run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  }
  await discover()
  expect(authority.choice('alpha', channel)).toBe(initialMode === 'open' ? 'mentions' : 'off')
  if (initialMode === 'strict') {
    h.writeConfig({ channel_mode: 'open', personas: [alpha, beta] }); await confirmPending()
  }
  expect(await call(deliveryAttempt('keep-off', channel, 'off'))).toEqual(appliedResult(deliveryAttempt('keep-off', channel, 'off')))
  const stamp = authority.channelStamp('alpha', channel)
  const destinationBeta = { ...beta, permission_prompts: channel }
  let sequence = 0
  for (const mode of ['strict', 'open'] as const) {
    h.writeConfig({ channel_mode: mode, personas: [alpha, destinationBeta] }); await confirmPending()
    await discover(); await discover()
    expect(authority.choice('alpha', channel)).toBe('off')
    expect(authority.channelStamp('alpha', channel)).toEqual(stamp)
    await run.deliver('alpha', makeChannelMessage({ channel, text: `${mentionText(run.stub('alpha').identity.botUserId)} still off`,
      ts: channelDeliveryEventTimestamp(++sequence) }))
    expect(run.queued('alpha')).toEqual([])
    expect(run.queued('beta')).toEqual([])
  }
})

test('historical unrestricted facts and current strict operator choice remain separate across reopen; dry history is read only', async () => {
  const { alpha, beta, authority } = await start()
  const channel = beta.channels![0]!.id
  run.stub('alpha').script.inventory.push(membershipPage([alpha.channels![0]!.id, channel]))
  run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  const request = deliveryAttempt(LEAK_SENTINEL, channel, 'all')
  const first = await call(request)
  const original = applications()[0]!
  expect(original.facts).toEqual({ saved: 'all', effective: 'all' })
  expect(first).toEqual(attemptResult(channel, { kind: 'applied', historical: false, outcome: original }, available('all')))
  h.writeConfig({ channel_mode: 'strict', personas: [alpha, { ...beta, permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }] })
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, authority.incarnation('alpha')!, channel, 'off')])
  await tick(); await confirm()
  for (const dryRun of [false, true]) {
    await stop(); run = await startRun({ realLifecycle: true, dryRun }); run.registerSession('alpha')
    if (!dryRun) {
      run.stub('alpha').script.inventory.push(membershipPage([channel])); await run.membershipClock.runNext()
    }
    const bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint(), count = run.appliedConfigs.length
    const result = await call(retryAttempt(request))
    expect(result.isError).toBe(false)
    expect(result.text).toBe(channelDeliveryAttemptResultText(alpha.name, 'alpha', channel,
      { kind: 'applied', historical: true, outcome: original }, dryRun
        ? { kind: 'unavailable', saved: 'off', reason: 'current-membership-missing' }
        : { kind: 'available', mode: 'strict', facts: { saved: 'off', effective: 'off' } }))
    expect(await call(deliveryAttempt('fresh-in-strict', channel, 'all'))).toEqual({ isError: true, text: channelDeliveryDeclarativeRefusal('alpha', 'alpha') })
    expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
    expectNoApplication(cp, count)
    if (dryRun) { expect(run.slack.builds).toEqual([]); expect(run.membershipClock.pendingCount()).toBe(0) }
  }
})


test.each(['bot-first', 'operator-first'] as const)('%s shares application order while preserving exact pending input and unrelated life', async order => {
  const { alpha, beta, authority } = await start()
  const channel = alpha.channels![0]!.id, life = authority.incarnation('alpha')!, session = run.session('alpha')
  const source = authority.sourceBytes(), betaBefore = authority.snapshot().personas.beta
  const prepared = h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }, beta] })
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, life, channel, 'off')])
  await tick()
  const review = retainedPreview()!, intent = authority.operatorIntent(), request = deliveryAttempt('ordered-bot', channel, 'all')
  if (order === 'operator-first') { await confirm() }
  const operatorPosition = authority.snapshot().personas.alpha!.assignments[channel]!.order
  const cp = run.checkpoint(), count = run.appliedConfigs.length
  expect(await call(request)).toEqual(appliedResult(request))
  expect(run.appliedConfigs).toHaveLength(count + 1)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(h.readConfig()).toEqual(prepared)
  expect(authority.snapshot().personas.beta).toEqual(betaBefore)
  expect(run.session('alpha')).toBe(session)
  if (order === 'bot-first') {
    expect(authority.sourceBytes()).toEqual(source)
    expect(authority.operatorIntent()).toEqual(intent)
    expect(retainedPreview()).toEqual(review)
    h.writeApplyBytes(review); await tick()
    expect(authority.choice('alpha', channel)).toBe('all') // stale preview cannot apply
    run.request('refresh'); await tick(); await confirm()
    expect(authority.choice('alpha', channel)).toBe('off')
    expect(authority.snapshot().personas.alpha!.assignments[channel]!.order).toBeGreaterThan(applications()[0]!.resolvedOrder)
  } else {
    expect(authority.choice('alpha', channel)).toBe('all')
    expect(applications()[0]!.resolvedOrder).toBeGreaterThan(operatorPosition)
  }
  const final = authority.snapshot(), finalPublished = run.appliedConfigs.length
  h.writeApplyBytes(review); await tick()
  expect(authority.snapshot().personas).toEqual(final.personas)
  expect(authority.snapshot().outcomes.botAttempts).toEqual(final.outcomes.botAttempts)
  expect(run.appliedConfigs).toHaveLength(finalPublished)
  expect(assignmentLogs()).toHaveLength(1)
  expect(run.serverConfig()!.personas[0]!.stop_hook_bootstrap).toBe(false)
  expect(run.session('alpha')).toBe(session)
})

test('same-value application stales review; rejection/history metadata preserves refreshed preview and cancel survives restart', async () => {
  const { alpha, beta, authority } = await start()
  const channel = alpha.channels![0]!.id, life = authority.incarnation('alpha')!
  const replacement = { ...beta, working_directory: h.persona('replacement').working_directory }
  materialize(replacement)
  const prepared = h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }, replacement] })
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, life, channel, 'off')]); await tick()
  const old = retainedPreview()!, intent = authority.operatorIntent(), target = reviewedReplacementIncarnation(authority.snapshot(), authority.path, replacement)
  const same = deliveryAttempt('same-value', channel, authority.choice('alpha', channel)!)
  expect(await call(same)).toEqual(appliedResult(same))
  expect(authority.operatorIntent()).toEqual(intent)
  expect(reviewedReplacementIncarnation(authority.snapshot(), authority.path, replacement)).toBe(target)
  h.writeApplyBytes(old); await tick()
  expect(authority.choice('alpha', channel)).toBe(same.delivery)
  run.request('refresh'); await tick()
  const refreshed = retainedPreview()!, fingerprint = h.pendingFingerprint(), dependency = sharedReviewDependency(authority.snapshot())
  const count = run.appliedConfigs.length, cp = run.checkpoint()
  expect(await call(retryAttempt(same))).toEqual(appliedResult(same, true))
  expect(await call(deliveryAttempt('rejected-metadata', C.private, 'all'))).toEqual(attemptResult(C.private, { kind: 'not-applied', reason: 'membership' }, unavailable('channel-removed')))
  expect(await call(retryAttempt(deliveryAttempt('missing-evidence', channel, 'off')))).toEqual(attemptResult(channel, { kind: 'unresolved' }, available(same.delivery)))
  expect(sharedReviewDependency(authority.snapshot())).toBe(dependency)
  await tick()
  expect(retainedPreview()).toEqual(refreshed); expect(h.pendingFingerprint()).toBe(fingerprint)
  expectNoApplication(cp, count)
  run.request('cancel'); await tick()
  const cancelled = authority.operatorIntent()
  expect(cancelled.requested).toBe(false)
  await stop(); run = await startRun({ realLifecycle: true }); run.registerSession('alpha')
  const reopened = run.controller.sharedChannels()!
  expect(reopened.operatorIntent()).toEqual(cancelled)
  expect(reviewedReplacementIncarnation(reopened.snapshot(), reopened.path, replacement)).toBe(target)
  expect(h.readConfig()).toEqual(prepared)
  // A cancelled declaration cannot return by replaying its old confirmation.
  h.writeApplyBytes(refreshed); await tick()
  expect(reopened.choice('alpha', channel)).toBe(same.delivery)
  const session = run.session('alpha')
  await confirm()
  expect(reopened.choice('alpha', channel)).toBe(same.delivery)
  expect(reopened.incarnation('beta')).toBe(target)
  expect(run.serverConfig()!.personas[0]!.stop_hook_bootstrap).toBe(false)
  expect(run.session('alpha')).toBe(session)
})

test('an initial thread_hybrid configuration mints Thread Hybrid Since in the first durable state', async () => {
  const { alpha, authority } = await start('open', false, {}, 'thread_hybrid')
  const channel = alpha.channels![0]!.id
  expect(expectStamp(authority, 'alpha', channel)).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  expect(authority.snapshot().personas.beta!.assignments).toEqual({ [h.persona('beta').channels![0]!.id]: { delivery: 'all', order: 1 } })
  expect(authority.threadView().threadHybridChannels('alpha')).toEqual([channel])
})

test('operator writes mint, keep across same value and a Channel Mode switch, and clear Thread Hybrid Since; the marker and previews stay apart', async () => {
  const { alpha, beta, authority } = await start()
  const channel = alpha.channels![0]!.id
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  const events = watchViews(authority), previews: unknown[] = []
  const hybrid = { ...alpha, channels: [{ id: channel, delivery: 'thread_hybrid' as const }] }
  const operator = async (delivery: DeliveryMode) => {
    run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, authority.incarnation('alpha')!, channel, delivery)])
    await tick(); previews.push(retainedPreview()); await confirm()
    return expectPublication(events, authority, 'alpha', channel, true).stamp('alpha', channel)
  }
  h.writeConfig({ channel_mode: 'open', personas: [hybrid, beta] }); await tick(); previews.push(retainedPreview()); await confirm()
  const minted = expectPublication(events, authority, 'alpha', channel, true).stamp('alpha', channel)
  expect(minted).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  const order = authority.snapshot().personas.alpha!.assignments[channel]!.order
  expect(await operator('thread_hybrid')).toEqual(minted)
  expect(authority.snapshot().personas.alpha!.assignments[channel]!.order).toBeGreaterThan(order)
  h.writeConfig({ channel_mode: 'strict', personas: [hybrid, beta] }); await confirmPending()
  expect(expectPublication(events, authority, 'alpha', channel, true).stamp('alpha', channel)).toEqual(minted)
  expect(await operator('off')).toEqual(decided(authority.incarnation('alpha')))
  expect(Object.keys(authority.snapshot().personas.alpha!.assignments[channel]!)).toEqual(['delivery', 'order'])
  const reminted = await operator('thread_hybrid')
  expect(reminted).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  expect(reminted).not.toEqual(minted)
  expect(authority.threadMemoryCreated('alpha')).toBe(true)
  expect(durableState().threadMemoryCreated).toEqual({ alpha: true })
  for (const since of [minted, reminted].map(s => (s as { threadHybridSince: string }).threadHybridSince)) {
    expect(JSON.stringify(previews)).not.toContain(since)
  }
})

test('a marker write between preview and confirmation moves no order, stales nothing and publishes nothing; the confirmation still activates', async () => {
  const { alpha, authority } = await start()
  const channel = alpha.channels![0]!.id
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, authority.incarnation('alpha')!, channel, 'thread_hybrid')]); await tick()
  const preview = retainedPreview(), fingerprint = h.pendingFingerprint(), before = authority.snapshot()
  const dependency = sharedReviewDependency(before), events = watchViews(authority), cp = run.checkpoint(), published = run.appliedConfigs.length
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  expect(run.since(cp).writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
  expect(durableState()).toEqual({ ...before, threadMemoryCreated: { alpha: true } })
  expect(sharedReviewDependency(authority.snapshot())).toBe(dependency)
  expect(authority.revision).toBe(before.revision)
  expect(events.map(e => e.kind)).toEqual([])
  await tick()
  expect(retainedPreview()).toEqual(preview); expect(h.pendingFingerprint()).toBe(fingerprint)
  expect(run.appliedConfigs).toHaveLength(published)
  await confirm()
  expect(authority.choice('alpha', channel)).toBe('thread_hybrid')
  expect(expectPublication(events, authority, 'alpha', channel, true).stamp('alpha', channel)).toEqual(decided(before.personas.alpha!.incarnation, expect.any(String)))
  expect(authority.threadMemoryCreated('alpha')).toBe(true)
})

test('an explicit absence replacement of thread_hybrid with thread_hybrid is a leave and re-add: a new Thread Hybrid Since in the same apply, same incarnation, the channel moved last', async () => {
  const { alpha, authority } = await start('open', true, {}, undefined, ['C0EXTRA01'])
  const [channel, other] = alpha.channels!.map(c => c.id) as [string, string]
  const baseline = authority.snapshot(), generation = run.membership.generation('alpha')!
  // A bot choice made while the inventory was collecting races the scan's absence.
  expect(await call(deliveryAttempt('before-absence', channel, 'thread_hybrid'))).toEqual(appliedResult(deliveryAttempt('before-absence', channel, 'thread_hybrid')))
  const captured = expectStamp(authority, 'alpha', channel)
  expect(captured).toEqual(decided(baseline.personas.alpha!.incarnation, expect.any(String)))
  const before = captured as ChannelStamp
  expect(run.membership.commitInventory(generation, { scanId: 'thread-hybrid-absence-race',
    observedThrough: membershipEventTimestamp(run.membershipClock.now()), observedRevision: baseline.revision,
    absent: new Map([[channel, baseline.personas.alpha!.membership[channel]!.boundary]]),
  }).kind).toBe('unresolved')
  const held = authority.snapshot(), conflict = held.personas.alpha!.membershipAbsenceConflicts![channel]!
  expect(stampOf(held, 'alpha', channel)).toEqual(captured)
  expect(Object.keys(held.personas.alpha!.assignments)).toEqual([channel, other])
  const binding = absenceReplacementBinding(held, 'alpha', channel)!
  run.request('request', [buildOperatorAssignment({ ...alpha, key: 'alpha' }, before.incarnation, channel, 'thread_hybrid', binding)]); await tick()
  expect(h.pendingBody()).toContain(REVIEW_ABSENCE_REPLACEMENT)
  const preview = retainedPreview(), events = watchViews(authority)
  await confirm()
  // One publication reports the removal and the new choice from one durable write.
  const replaced = expectPublication(events, authority, 'alpha', channel, true).stamp('alpha', channel)
  expect(replaced).toEqual(decided(before.incarnation, expect.any(String)))
  expect(replaced).not.toMatchObject({ threadHybridSince: before.threadHybridSince })
  expect(sameChannelStamp(before, authority.channelStamp('alpha', channel))).toBe(false)
  expect(sameChannelStamp(replaced as ChannelStamp, authority.channelStamp('alpha', channel))).toBe(true)
  expect(JSON.stringify(preview)).not.toContain(before.threadHybridSince!)
  const life = authority.snapshot().personas.alpha!
  expect(life.incarnation).toBe(before.incarnation)
  expect(life.membershipAbsenceConflicts?.[channel]).toBeUndefined()
  expect(life.replacedAbsences![binding]).toMatchObject({ channel, incarnation: before.incarnation, conflict, removedOrder: life.leaves[channel]!.boundary })
  expect(life.membership[channel]).toMatchObject({ member: false, boundary: life.leaves[channel]!.boundary })
  expect(life.assignments[channel]).toEqual({ delivery: 'thread_hybrid', order: life.leaves[channel]!.boundary + 1, threadHybridSince: (replaced as ChannelStamp).threadHybridSince })
  expect(life.assignments[other]).toEqual(held.personas.alpha!.assignments[other])
  // The removal ends the old entry, so the re-added channel takes the last position.
  expect(Object.keys(life.assignments)).toEqual([other, channel])
  expect(authority.config().personas.find(p => p.key === 'alpha')!.channels.map(c => c.id)).toEqual([other, channel])
  const appliedChannels = (state: SharedChannelState) => ((state.applied['personas'] as Array<{ name: string; channels: Array<{ id: string }> }>)
    .find(p => p.name === 'alpha')!.channels.map(c => c.id))
  expect(appliedChannels(durableState())).toEqual([other, channel])
  await stop()
  run = await startRun({ realLifecycle: true })
  const reopened = run.controller.sharedChannels()!
  expect(reopened.snapshot().personas.alpha!.assignments[channel]).toEqual(life.assignments[channel])
  expect(durableState().personas.alpha!.assignments[channel]).toEqual(life.assignments[channel])
  expect(reopened.channelStamp('alpha', channel)).toEqual(replaced)
  expect(reopened.config().personas.find(p => p.key === 'alpha')!.channels.map(c => c.id)).toEqual([other, channel])
})

test.each(['set', 'clear'] as const)('marker %s is refused with no write while a retirement review holds the persona; an unheld persona still writes', async action => {
  let armed = false
  const { alpha, beta, authority } = await start('open', true, { afterWrite: path => {
    // The retirement is recorded, then the application and the restore both fail.
    if (armed && path === h.retiredKeysFile) { armed = false; h.failWrites({ step: 'writeSync', code: 'ENOSPC' }) }
  } })
  const channel = alpha.channels![0]!.id
  if (action === 'clear') expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  h.writeConfig({ channel_mode: 'open', personas: [beta] }); await tick(); retainedPreview()
  armed = true; await confirm(); h.clearWriteFailure()
  expect(armed).toBe(false)
  expect(authority.incarnation('alpha')).toBeDefined()
  expect(authority.readable).toBe(true)
  expect(authority.reviewHeld('alpha')).toBe(true); expect(authority.reviewHeld('beta')).toBe(false)
  expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'undecided' })
  const bytes = readFileSync(h.paths.lastApplied), cp = run.checkpoint(), revision = authority.revision
  const write = () => action === 'set' ? authority.setThreadMemoryCreated('alpha') : authority.clearThreadMemoryCreated('alpha')
  expect(write()).toEqual({ kind: 'failed' })
  expect(run.since(cp).writes).toEqual([])
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(authority.threadMemoryCreated('alpha')).toBe(action === 'clear')
  expect(authority.revision).toBe(revision)
  expect(authority.setThreadMemoryCreated('beta')).toEqual({ kind: 'saved' })
  expect(run.since(cp).writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
  expect(durableState().threadMemoryCreated).toEqual(action === 'clear' ? { alpha: true, beta: true } : { beta: true })
})

test('a successful marker write keeps the last failed delivery mutation\'s failure reason', async () => {
  const { alpha, authority } = await start()
  expect(authority.failure).toBe('')
  h.failWrites({ path: h.paths.lastApplied, step: 'writeSync', code: 'ENOSPC' })
  expect(await call(deliveryAttempt('failed-before-marker', alpha.channels![0]!.id, 'thread_hybrid'))).toEqual(attemptResult(alpha.channels![0]!.id, { kind: 'unresolved' }, available('all')))
  h.clearWriteFailure()
  const reason = authority.failure
  expect(reason).toContain('ENOSPC')
  expect(authority.readable).toBe(true)
  for (const write of [() => authority.setThreadMemoryCreated('alpha'), () => authority.clearThreadMemoryCreated('alpha')]) {
    const cp = run.checkpoint()
    expect(write()).toEqual({ kind: 'saved' })
    expect(run.since(cp).writes).toEqual([{ path: h.paths.lastApplied, ok: true }])
    expect(authority.failure).toBe(reason)
  }
})

test.each(['removal', 'rename', 'credentials', 'directory', 'rotation'] as const)('%s Identity Reset gives thread_hybrid a new incarnation and Thread Hybrid Since unless the life is kept; the marker stays', async boundary => {
  const { alpha, beta, authority } = await start()
  const channel = alpha.channels![0]!.id
  expect(await call(deliveryAttempt(`stamp-${boundary}`, channel, 'thread_hybrid'))).toEqual(appliedResult(deliveryAttempt(`stamp-${boundary}`, channel, 'thread_hybrid')))
  const before = expectStamp(authority, 'alpha', channel)
  expect(before).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  const { incarnation, threadHybridSince } = before as ChannelStamp
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  const events = watchViews(authority)
  const hybrid = { ...alpha, channels: [{ id: channel, delivery: 'thread_hybrid' as const }] }
  let key = 'alpha'
  if (boundary === 'rotation') {
    h.rotateCredentials(alpha, { slack: { appId: 'A0ROTATED', botUserId: 'U0ROTATED', botId: 'B0ROTATED' } }); await confirmPending()
    expect(expectStamp(authority, key, channel)).toEqual(before)
  } else {
    const replacement = { ...hybrid,
      ...(boundary === 'rename' ? { name: 'renamed' } : {}),
      ...(boundary === 'credentials' ? { credentials_file: h.persona('replacement').credentials_file } : {}),
      ...(boundary === 'directory' ? { working_directory: h.persona('replacement').working_directory } : {}),
    }
    materialize(replacement)
    h.writeConfig({ channel_mode: 'open', personas: boundary === 'removal' ? [beta] : [replacement, beta] }); await confirmPending()
    // The retiring life is held by the review first, so its stamp is undecided before the reset applies.
    const held = events.shift() as ViewEvent
    expect(held.kind).toBe('view')
    expect(held.view.stamp('alpha', channel)).toEqual({ kind: 'undecided' })
    if (boundary === 'removal') {
      expect(held.view.personaKeys()).toEqual(['alpha', 'beta'])
      // The removal's view reports the persona set and revision of the write it follows.
      const removed = events[0] as ViewEvent
      expect(removed.view.personaKeys()).toEqual(['beta'])
      expect(removed.view.revision).toBe(removed.durable.revision)
      expect(removed.view.revision).toBeGreaterThan(held.view.revision)
    }
    let view = expectPublication(events, authority, 'alpha', channel, true)
    if (boundary === 'removal' || boundary === 'rename') expect(view.stamp('alpha', channel)).toBeUndefined()
    if (boundary === 'removal') { h.writeConfig({ channel_mode: 'open', personas: [hybrid, beta] }); await confirmPending(); view = expectPublication(events, authority, 'alpha', channel, true) }
    if (boundary === 'rename') key = h.key('renamed')
    const after = view.stamp(key, channel)
    expect(after).toEqual(expectStamp(authority, key, channel))
    expect(after).toEqual(decided(authority.incarnation(key), expect.any(String)))
    expect(after).not.toMatchObject({ incarnation })
    expect(after).not.toMatchObject({ threadHybridSince })
  }
  expect(authority.threadMemoryCreated('alpha')).toBe(true)
  expect(durableState().threadMemoryCreated).toEqual({ alpha: true })
})

test.each(['removal', 'rename', 'credentials', 'directory'] as const)('%s and return cannot lend a retired ID or accepted queue to a replacement life', async boundary => {
  const { alpha, beta, authority } = await start()
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'all'), old = run.session('alpha')!, life = authority.incarnation('alpha')!
  expect(await call(request)).toEqual(appliedResult(request))
  await run.queue.accept('alpha', slackInput({ text: '  retained\r\n\r\n😀  ', queued_ack_reaction: 'hourglass' }))
  const queued = structuredClone(run.queued('alpha').map(item => item.accepted))
  const replacement = { ...alpha,
    ...(boundary === 'rename' ? { name: 'renamed' } : {}),
    ...(boundary === 'credentials' ? { credentials_file: h.persona('replacement').credentials_file } : {}),
    ...(boundary === 'directory' ? { working_directory: h.persona('replacement').working_directory } : {}),
  }
  materialize(replacement)
  h.writeConfig({ channel_mode: 'open', personas: boundary === 'removal' ? [beta] : [replacement, beta] })
  await confirmPending()
  expect(await call(retryAttempt(request), 'alpha', old)).toEqual(inactiveResult())
  h.writeConfig({ channel_mode: 'open', personas: [alpha, beta] }); await confirmPending()
  run.registerSession('alpha')
  expect(authority.incarnation('alpha')).not.toBe(life)
  const cp = run.checkpoint(), count = run.appliedConfigs.length, bytes = readFileSync(h.paths.lastApplied)
  const result = await call(retryAttempt(request))
  expect(result).toEqual(attemptResult(request.channel, { kind: 'unresolved' }, unavailable('channel-removed')))
  expect(result.text).not.toContain('original saved')
  expect(readFileSync(h.paths.lastApplied)).toEqual(bytes)
  expect(run.queued('alpha').map(item => item.accepted)).toEqual(queued)
  expect(run.queued('alpha').every(item => !item.delivered && item.nextAttempt === 1)).toBe(true)
  expectNoApplication(cp, count)
})

test('verified leave/rejoin cannot resurrect an old choice via retry, and accepted text/emoji/FIFO remain unchanged', async () => {
  const { alpha, authority } = await start()
  const channel = alpha.channels![0]!.id, request = deliveryAttempt('before-leave', channel, 'thread_hybrid')
  expect(await call(request)).toEqual(appliedResult(request))
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  const joinedStamp = expectStamp(authority, 'alpha', channel)
  expect(joinedStamp).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  const events = watchViews(authority)
  for (const original of channelDeliveryOriginals(channel)) await run.queue.accept('alpha', slackInput(original))
  const queued = structuredClone(run.queued('alpha').map(item => item.accepted))
  await run.stub('alpha').socket.deliver({ type: 'channel_left', channel, event_ts: membershipEventTimestamp(run.membershipClock.now()) }, { event_id: EVENTS.botLeave })
  expect(authority.choice('alpha', channel)).toBeUndefined()
  // The leave clears Thread Hybrid Since in the removal's own application.
  expect(expectPublication(events, authority, 'alpha', channel).stamp('alpha', channel)).toEqual(decided(authority.incarnation('alpha')))
  const removed = await call(retryAttempt(request))
  expect(removed).toEqual(appliedResult(request, true, unavailable('channel-removed')))
  expect(removed.text).toContain('previously applied')
  expect(removed.text).toContain('there is no currently saved channel entry')
  expect(authority.choice('alpha', channel)).toBeUndefined()
  run.stub('alpha').script.inventory.push(membershipPage([channel])); run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  expect(authority.choice('alpha', channel)).toBe('mentions')
  const joined = authority.snapshot().personas.alpha!.assignments[channel]
  expect(Object.keys(joined!)).toEqual(['delivery', 'order'])
  expect(expectPublication(events, authority, 'alpha', channel, false, 2).stamp('alpha', channel)).toEqual(decided(authority.incarnation('alpha')))
  expect(await call(retryAttempt(request))).toEqual(appliedResult(request, true, available('mentions')))
  expect(authority.snapshot().personas.alpha!.assignments[channel]).toEqual(joined)
  expect(run.queued('alpha').map(item => item.accepted)).toEqual(queued)
  expect(run.queued('alpha').every(item => !item.delivered && item.nextAttempt === 1)).toBe(true)
  expect(assignmentLogs()).toHaveLength(1)
  expect(await call(deliveryAttempt('after-rejoin', channel, 'thread_hybrid'))).toEqual(appliedResult(deliveryAttempt('after-rejoin', channel, 'thread_hybrid')))
  const rejoined = expectPublication(events, authority, 'alpha', channel).stamp('alpha', channel)
  expect(rejoined).toEqual(decided(authority.incarnation('alpha'), expect.any(String)))
  expect(rejoined).not.toEqual(joinedStamp)
  expect(authority.threadMemoryCreated('alpha')).toBe(true)
  expect(durableState().threadMemoryCreated).toEqual({ alpha: true })
})


test.each(['rejection-at-assignment', 'colliding-attempts'] as const)('F1: reopened MCP refuses contradictory %s evidence without promising nonapplication', async shape => {
  const { alpha, authority } = await start()
  const request = deliveryAttempt('retained-before-corruption', alpha.channels![0]!.id, 'all')
  expect(await call(request)).toEqual(appliedResult(request))
  const malformed = serializeSharedChannelState(contradictoryBotHistory(authority.snapshot(), shape))
  await stop()
  durableWriteFileSync(h.paths.lastApplied, malformed)
  run = await startRun({ realLifecycle: true }, false); run.registerSession('alpha')
  const result = await call(retryAttempt(request))
  expect(result.text).not.toContain('this attempt did not apply and changed no choice')
  expect(result).toEqual(inactiveResult())
  expect(run.outcome!.kind).toBe('refused')
  expect(readFileSync(h.paths.lastApplied)).toEqual(Buffer.from(malformed))
  expect(assignmentLogs()).toEqual([])
  expect(run.appliedConfigs).toEqual([])
})

test('F1 control: an older durable rejection remains readable after a later genuine assignment and reopen', async () => {
  const { alpha } = await start('open', false)
  const rejected = deliveryAttempt('older-rejection', alpha.channels![0]!.id, 'all')
  expect(await call(rejected)).toEqual(attemptResult(rejected.channel, { kind: 'not-applied', reason: 'membership' }, unavailable('current-membership-missing', 'all')))
  run.stub('alpha').script.inventory.push(membershipPage([rejected.channel])); await run.membershipClock.runNext()
  expect(await call(deliveryAttempt('later-assignment', rejected.channel, 'all'))).toEqual(appliedResult(deliveryAttempt('later-assignment', rejected.channel, 'all')))
  const before = run.controller.sharedChannels()!.snapshot()
  await stop(); run = await startRun({ realLifecycle: true }, false); run.registerSession('alpha')
  expect(run.outcome!.kind).toBe('applied')
  const result = await call(retryAttempt(rejected))
  expect(result).toEqual(attemptResult(rejected.channel, { kind: 'not-applied', reason: 'membership' }, unavailable('current-membership-missing', 'all')))
  expect(result.text).toContain('Current saved all')
  expect(run.controller.sharedChannels()!.snapshot()).toEqual(before)
  expect(assignmentLogs()).toEqual([])
})

test.each([false, true])('two held bot attempts use release order rather than call-start order (reverse=%s)', async reverse => {
  const turns = [makeToolCallGate(), makeToolCallGate()]
  let index = 0
  const { alpha, authority } = await start('open', true, { beforeToolCall: async () => { await turns[index++]?.wait() } })
  const requests = [deliveryAttempt('first-started', alpha.channels![0]!.id, 'all'), deliveryAttempt('second-started', alpha.channels![0]!.id, 'off')]
  const first = call(requests[0]!); await turns[0]!.entered
  const second = call(requests[1]!); await turns[1]!.entered
  const order = reverse ? [1, 0] : [0, 1], pending = [first, second]
  for (const turn of order) {
    turns[turn]!.release()
    expect(await pending[turn]).toEqual(appliedResult(requests[turn]!))
  }
  expect(applications().map(r => r.delivery)).toEqual(order.map(i => requests[i]!.delivery))
  expect(authority.choice('alpha', requests[0]!.channel)).toBe(requests[order[1]!]!.delivery)
  expect(assignmentLogs()).toHaveLength(2)
})

test('failed verified leave holds a previously admitted assignment until real reconciliation; old rejection never retries as a write', async () => {
  const gate = makeToolCallGate()
  const { alpha, beta, authority } = await start('open', true, { beforeToolCall: gate.wait })
  const request = deliveryAttempt('before-failed-leave', alpha.channels![0]!.id, 'all')
  const pending = call(request); await gate.entered
  h.failWrites({ path: h.paths.lastApplied, step: 'writeSync', code: 'ENOSPC' })
  await run.stub('alpha').socket.deliver({ type: 'channel_left', channel: request.channel, event_ts: membershipEventTimestamp(run.membershipClock.now()) }, { event_id: EVENTS.failedLeave })
  expect(run.stub('alpha').socket.acks).toHaveLength(0)
  expect(run.membership.read('alpha', request.channel, 'open').kind).toBe('unresolved')
  h.clearWriteFailure(); gate.release()
  expect(await pending).toEqual(attemptResult(request.channel, { kind: 'not-applied', reason: 'membership' }, unavailable('event-not-durable', 'all')))
  expect(applications()).toEqual([])
  expect(await call(deliveryAttempt('healthy-after-leave-failure', beta.channels![0]!.id, 'all'), 'beta')).toEqual(appliedResult(deliveryAttempt('healthy-after-leave-failure', beta.channels![0]!.id, 'all'), false, available('all'), 'beta'))
  run.stub('alpha').script.inventory.push(membershipPage([request.channel])); run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
  expect(await call(retryAttempt(request))).toEqual(attemptResult(request.channel, { kind: 'not-applied', reason: 'membership' }, available('mentions')))
  expect(applications().filter(r => r.key === 'alpha')).toEqual([])
  expect(authority.choice('beta', beta.channels![0]!.id)).toBe('all')
})

test('body secrecy and accepted queue facts survive fresh assignment, duplicate and unresolved lookup without callback or receipt activity', async () => {
  let replyCalls = 0, consumed = 0
  const { alpha, authority } = await start('open', true, { onReplyCall: () => { replyCalls++ }, consumeAck: async () => { consumed++ } })
  const accepted = await run.queue.accept('alpha', slackInput({ text: ATTEMPT_BODY_SENTINEL, queued_ack_reaction: 'hourglass' }))
  expect(accepted.status).toBe('accepted')
  await run.prepareQueued()
  const before = structuredClone(run.queued('alpha'))
  const request = deliveryAttempt(LEAK_SENTINEL, alpha.channels![0]!.id, 'off')
  expect(await call(request)).toEqual(appliedResult(request))
  const cp = run.checkpoint(), published = run.appliedConfigs.length
  for (const args of [request, retryAttempt(request)]) expect(await call(args)).toEqual(appliedResult(request, true))
  expect(await call(retryAttempt(deliveryAttempt('unknown-recovery', request.channel, 'all')))).toEqual(attemptResult(request.channel, { kind: 'unresolved' }, available('off')))
  expectNoApplication(cp, published)
  expect(run.queued('alpha')).toEqual(before)
  expect(replyCalls).toBe(0); expect(consumed).toBe(0)
  expect(run.queued('alpha').every(item => !item.delivered && item.nextAttempt === 1)).toBe(true)
  const tree = h.serverSideFiles(h.paths.config, ...operatorFiles)
  expect(Object.keys(tree)).toContain(relative(h.root, h.paths.lastApplied))
  // Accepted queue files deliberately retain the independent body marker. All
  // server files are still token-checked; public outputs/authority must omit it.
  assertNoLeak({ tree, outputs, logs: run.logs })
  const publicEvidence = JSON.stringify({ responses: run.toolResponses(), outputs, logs: run.logs, authority: authority.snapshot(), file: readFileSync(h.paths.lastApplied, 'utf8') })
  expect(publicEvidence).not.toContain(ATTEMPT_BODY_SENTINEL)
  assertNoLeak(publicEvidence)
})

})

// Deliberate evidence corruption belongs in its own scope: the production
// contract cases above still require zero Slack effects and leak-free captures.
// These controls require the same assertions to reject injected activity/data.
describe('actual MCP evidence sensitivity', () => {
  let h: ReloadHarness
  let run: ReloadRun
  beforeEach(() => { h = makeReloadHarness() })
  afterEach(async () => { await h.cleanup() })
  async function startControl(opts: ReloadRunOptions = {}) {
    const alpha = h.persona('alpha'), beta = h.persona('beta')
    h.materialize(alpha, beta)
    h.writeConfig({ channel_mode: 'open', personas: [alpha, beta] })
    run = await h.startDetecting({ realLifecycle: true, ...opts })
    for (const p of [alpha, beta]) run.stub(p.name).script.inventory.push(membershipPage(p.channels!.map(c => c.id)))
    await run.membershipClock.runNext()
    run.registerSession('alpha'); run.registerSession('beta')
    assertNoLeak(run.captured())
    return { alpha, beta }
  }
  async function confirmControl() {
    await run.ticks.tick()
    assertNoLeak(run.captured()) // include the pending preview before consuming it
    h.confirm(); await run.ticks.tick()
    assertNoLeak(run.captured())
  }

  test.each(['current', 'retired-initial', 'retired-rotated', 'neighbor'] as const)(
    'real rotations retain zero-call sensitivity on the %s client and close each request window', async target => {
      let inject: (() => void) | undefined
      const { alpha, beta } = await startControl({ beforeToolResponse() { inject?.() } })
      const original = deliveryAttempt('before-client-rotations', alpha.channels![0]!.id, 'all')
      await run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL, original)
      const initial = run.currentStub('alpha')
      const initialClient = run.connections.clientFor('alpha')!
      h.rotateCredentials(alpha, { slack: { appId: 'A0ALPHAFIRST' } }); await confirmControl()
      const retired = run.currentStub('alpha')
      const retiredClient = run.connections.clientFor('alpha')!
      h.rotateCredentials(alpha, { slack: { appId: 'A0ALPHASECOND' } }); h.rotateCredentials(beta, { slack: { appId: 'A0BETAROTATED' } }); await confirmControl()
      const current = run.currentStub('alpha'), neighbor = run.currentStub('beta')
      expect(new Set([initial, retired, current, neighbor]).size).toBe(4)
      for (const p of [alpha, beta]) run.currentStub(p.name).script.inventory.push(membershipPage(p.channels!.map(c => c.id)))
      await run.membershipClock.runNext()
      expect(run.membership.read('alpha', original.channel, 'open').kind).toBe('eligible')
      expect(run.isUp('beta')).toBe(true)
      const before = run.toolActivities(), cp = run.checkpoint()
      const stub = { current, 'retired-initial': initial, 'retired-rotated': retired, neighbor }[target]
      const client = { current: run.connections.clientFor('alpha')!, 'retired-initial': initialClient,
        'retired-rotated': retiredClient, neighbor: run.connections.clientFor('beta')! }[target]
      inject = () => { void client.conversations.info({ channel: original.channel }) }
      const result = await run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL, deliveryAttempt('after-client-rotations', original.channel, 'off'))
      const outcome = botApplications(run.controller.sharedChannels()!.snapshot()).at(-1)!
      expect(outcome.facts).toEqual({ saved: 'off', effective: 'off' })
      expect(result).toEqual({ isError: false, text: channelDeliveryAttemptResultText('alpha', 'alpha', original.channel,
        { kind: 'applied', historical: false, outcome },
        { kind: 'available', mode: 'open', facts: { saved: 'off', effective: 'off' } }) })
      inject = undefined
      const extra = stub.callLog.at(-1)!
      expect(extra.method).toBe('conversations.info')
      expect(run.slackCalls()[target === 'neighbor' ? 'beta' : 'alpha']).toContainEqual(extra)
      expect(run.since(cp).slackCalls).toEqual([extra])
      const activity = run.toolActivities().at(-1)!
      expect(activity.slackCalls).toEqual([extra])
      expect(activity.slackBuilds).toBe(0)
      expect(() => expectNoSlack(activity)).toThrow()
      expect(run.toolActivities().slice(0, -1)).toEqual(before)
      // A later legitimate history/healthy-neighbor call cannot inherit the
      // earlier client's lookup; the already closed activity remains intact.
      await run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL, retryAttempt(original))
      await run.callTool('beta', SET_CHANNEL_DELIVERY_TOOL, deliveryAttempt('healthy-neighbor-after-rotations', beta.channels![0]!.id, 'off'))
      expectNoSlack(run.toolActivities().at(-1)!); expectNoSlack(run.toolActivities().at(-2)!)
      expect(run.toolActivities()[before.length]).toEqual(activity)
      assertNoLeak(run.captured())
    })

  test('checkpoints retain earlier and later calls as streams rotate, appear and retire', async () => {
    const { alpha, beta } = await startControl()
    const initial = run.stub('alpha'), oldBeta = run.stub('beta')
    const initialClient = run.connections.clientFor('alpha')!, betaClient = run.connections.clientFor('beta')!
    await initialClient.conversations.info({ channel: C.primary })
    await betaClient.conversations.info({ channel: C.secondary })
    const cp = run.checkpoint()
    h.rotateCredentials(alpha); await confirmControl()
    const rotated = run.currentStub('alpha')
    const rotatedClient = run.connections.clientFor('alpha')!
    await rotatedClient.conversations.info({ channel: C.private })
    const firstNew = rotated.callLog.at(-1)!
    const middle = run.checkpoint()
    const gamma = h.persona('gamma'); h.materialize(gamma)
    h.writeConfig({ channel_mode: 'open', personas: [alpha, gamma] }); await confirmControl()
    expect(run.serverConfig()!.personas.map(p => p.key)).toEqual(['alpha', 'gamma'])
    await initialClient.conversations.info({ channel: C.secondary })
    await betaClient.conversations.info({ channel: C.private })
    await rotatedClient.conversations.info({ channel: C.primary })
    await run.connections.clientFor('gamma')!.conversations.info({ channel: C.secondary })
    const later = [initial, oldBeta, rotated, run.stub('gamma')].map(stub => stub.callLog.at(-1)!)
    const info = (calls: ReloadRunActivity['slackCalls']) => calls.filter(c => c.method === 'conversations.info')
    expect(info(run.since(middle).slackCalls)).toEqual(later)
    expect(info(run.since(cp).slackCalls)).toEqual([later[0], later[1], firstNew, later[2], later[3]])
    expect(info(run.slackCalls().alpha!)).toHaveLength(4)
    expect(info(run.slackCalls().beta!)).toHaveLength(2)
    expect(info(run.slackCalls().gamma!)).toEqual([later[3]!])
    expect(run.since(run.checkpoint()).slackCalls).toEqual([])
    assertNoLeak(run.captured())
  })

  test.each([...RAW_RESPONSE_SURFACES])('foreign/unknown comparison rejects a %s disclosure with identical text and no token marker', async surface => {
    let reveal = false
    const { alpha } = await startControl({ beforeToolResponse(message) {
      // Both replies get the same schema-valid shape; only a non-text value
      // reveals existence. This must fail equality independently of redaction.
      addRawResponseEvidence(message, surface, reveal ? 'retained' : 'unknown')
    } })
    const request = deliveryAttempt('retained-by-alpha', alpha.channels![0]!.id, 'all')
    await run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL, request)
    reveal = true
    const foreign = await run.callTool('beta', SET_CHANNEL_DELIVERY_TOOL, retryAttempt(request))
    const foreignRaw = run.toolResponses().at(-1)!.message
    reveal = false
    const unknown = await run.callTool('beta', SET_CHANNEL_DELIVERY_TOOL, { ...retryAttempt(request), attempt_id: 'unknown-to-both' })
    expect(foreign).toEqual(unknown)
    expect(() => expectSameResponse(foreignRaw, run.toolResponses().at(-1)!.message)).toThrow()
    assertNoLeak(run.captured())
    for (const activity of run.toolActivities()) expectNoSlack(activity)
  })

  for (const path of ['success', 'failure', 'history', 'loss', 'protocol-error'] as const) {
    test.each([...RAW_RESPONSE_SURFACES])(`${path} retains %s through the real SDK and rejects a raw-only leak`, async surface => {
      let marker = 'safe-response-evidence'
      let attempted: ReturnType<typeof run.toolResponses>[number]['message'] | undefined
      const { alpha } = await startControl({ beforeToolResponse(message) {
        addRawResponseEvidence(message, surface, marker)
        attempted = structuredClone(message)
      } })
      const request = deliveryAttempt('payload-evidence', alpha.channels![0]!.id, 'all')
      // A clean control proves the added payload is SDK-valid, before the exact
      // same field carries the sentinel. No replacement handler is installed.
      let submission = 0
      const send = async () => {
        if (path === 'loss') return run.loseToolResponse('alpha', SET_CHANNEL_DELIVERY_TOOL, retryAttempt(request))
        if (path === 'protocol-error') return run.callTool('alpha', null as unknown as string, {})
        return run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL,
          path === 'failure' ? {} : path === 'history' ? retryAttempt(request) : { ...request, attempt_id: `payload-evidence-${++submission}` })
      }
      if (path === 'history' || path === 'loss') await run.callTool('alpha', SET_CHANNEL_DELIVERY_TOOL, request)
      let cleanProjection: Awaited<ReturnType<typeof send>> = undefined
      if (path === 'protocol-error') await expect(send()).rejects.toThrow()
      else cleanProjection = await send()
      assertNoLeak(run.captured())
      expect(run.toolResponses().at(-1)!.message).toEqual(attempted!)
      expect(run.toolResponses().at(-1)!.lost).toBe(path === 'loss')
      const clean = responseWithoutId(attempted!)
      const results = () => run.captured().toolResults as Array<{ key: string; result?: unknown; error?: unknown }>
      if (path === 'loss' || path === 'protocol-error') expect(results().at(-1)!.error).toBeInstanceOf(Error)
      else {
        if (!('result' in attempted!)) throw new Error('expected tool result')
        expect(results().at(-1)!.result).toEqual(CallToolResultSchema.parse(attempted!.result))
      }
      marker = LEAK_SENTINEL
      // Success stays a fresh application; history/loss retain the same ID.
      if (path === 'protocol-error') await expect(send()).rejects.toThrow()
      else {
        const projection = await send()
        if (path === 'failure' || path === 'history') expect(projection).toEqual(cleanProjection)
      }
      const raw = run.toolResponses().at(-1)!
      expect(raw.message).toEqual(attempted!)
      expect(raw.lost).toBe(path === 'loss')
      expect(JSON.stringify(raw.message).includes(LEAK_SENTINEL)).toBe(true)
      expect(() => assertNoLeak(run.captured())).toThrow(/contains LEAK_SENTINEL/)
      // Privacy comparison must reject even a harmless non-token field change.
      expect(responseWithoutId(raw.message)).not.toEqual(clean)
      if (path !== 'loss' && path !== 'protocol-error') {
        if (!('result' in raw.message)) throw new Error('expected tool result')
        const parsed = CallToolResultSchema.parse(raw.message.result)
        expect(results().at(-1)!.result).toEqual(parsed)
        const text = parsed.content.map(c => c.type === 'text' ? c.text : '').join('\n')
        expect(text).not.toContain(LEAK_SENTINEL)
        if (surface === 'annotations') assertNoLeak(results().at(-1)) // SDK strips the extension; wire capture must catch it.
        else expect(() => assertNoLeak(results().at(-1))).toThrow(/contains LEAK_SENTINEL/)
      } else if (path === 'protocol-error') {
        expect(() => assertNoLeak(results().at(-1))).toThrow(/contains LEAK_SENTINEL/)
      }
      for (const activity of run.toolActivities()) expectNoSlack(activity)
    })
  }
})
