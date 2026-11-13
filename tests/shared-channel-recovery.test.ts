import { reviewLedger } from '../src/reload-review.ts'
/** Startup, confirmed application and reopen use the same durable shared authority. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as nodeFs from 'node:fs'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PERSONA_CONFIG_FS, type DeliveryMode, type PersonaConfigFs } from '../src/config.ts'
import { isDeepStrictEqual } from 'node:util'
import {
  createSharedChannelAuthority, parseSharedChannelState, sameChannelStamp, serializeSharedChannelState, sharedChannelLifetime,
  type ChannelStamp, type SharedChannelAuthority, type SharedChannelStampState, type SharedChannelState, type SharedThreadView, type ThreadMemoryMarkerResult,
} from '../src/shared-channels.ts'
import { reloadSharedAuthorityApplyFailedLine } from '../src/reload.ts'
import { errnoSuffix } from '../src/persona-credentials.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { activationRecord, applicationState, botAttemptRecord, channelPopulation, configBytes, expectCurrent, expectSuperseded, holdsLifetime, makeSharedAuthority, makeMembershipHarness, SHARED_CHANNEL_IDS as C, withPreRuleScanRepeats } from './test-helpers/shared-channels.ts'
import { durableWriteFileSync, DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import { makeDm } from './test-helpers/slack-stub.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { slackInput, sentRecord, deliveredRecord } from './test-helpers/delivery-queue.ts'
import { cannedGetResult, stubCallCount } from './test-helpers/agent-director-stub.ts'
import { createReplyReminders, REPLY_TOOL_PREALLOWED_LABEL, type ReplyReminders } from '../src/reply-reminder.ts'
let h: ReloadHarness
let runs: ReloadRun[]
let engines: EngineHarness[]
let repairBodies: Set<string>
let reminders: ReplyReminders[]
beforeEach(() => { h = makeReloadHarness(); runs = []; engines = []; repairBodies = new Set(); reminders = [] })
afterEach(async () => { for (const reminder of reminders) await reminder.stop(); for (const e of engines) { assertNoLeak({ errors: e.errors, events: e.events }); await e.cleanup() }; for (const run of runs) { expect(run.slackPosts()).toEqual([]); assertNoLeak(run.captured()); await run.stop() }; await h.cleanup() })
async function start(opts: ReloadRunOptions = {}) { const run = await h.startDetecting({ dryRun: true, ...opts }); runs.push(run); expect(run.outcome.kind).toBe('applied'); return run }
function disk() { return parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)! }
const THREAD = 'C0THREAD1'
/** `h.persona(name)` with a `thread_hybrid` entry beside its default channel. */
function threaded(name: string) {
  const persona = h.persona(name)
  return { ...persona, channels: [...persona.channels!, { id: THREAD, delivery: 'thread_hybrid' as const }] }
}
function sinceOf(state: SharedChannelState, key = 'alpha', channel = THREAD) { return state.personas[key]?.assignments[channel]?.threadHybridSince }
function assignmentsOf(state: SharedChannelState) {
  return Object.fromEntries(Object.entries(state.personas).map(([key, life]) => [key, life.assignments]))
}
function lastAppliedWrites(run: ReloadRun) { return run.writes.filter(write => write.path === h.paths.lastApplied).length }

/** Readability is the oracle, including a channel outside the inventory to
 * distinguish a persona-wide hold from a finite list of changed projections. */
function expectScopeMatches(authority: SharedChannelAuthority, states: SharedChannelState[]) {
  const keys = [...new Set(states.flatMap(state => Object.keys(state.personas)))]
  for (const key of keys) {
    const channels = [...new Set(states.flatMap(state => {
      const life = state.personas[key]
      const raw = (state.applied.personas as Array<{ name: string; permission_prompts: string }>).find(p => h.key(p.name) === key)
      return [...Object.keys(life?.assignments ?? {}), ...Object.keys(life?.membership ?? {}),
        ...Object.keys(life?.leaves ?? {}), ...Object.keys(life?.membershipAbsenceConflicts ?? {}),
        ...(raw?.permission_prompts && raw.permission_prompts !== 'dm' ? [raw.permission_prompts] : [])]
    }))].sort()
    const scope = { channels: channels.filter(channel => !authority.readableFor(key, channel)),
      dm: !authority.readableFor(key, String(makeDm().channel)),
      all: !authority.readableFor(key, channelPopulation(1, 8000)[0]!.id) }
    expect(authority.unresolvedScope(key)).toEqual(scope.all || scope.dm || scope.channels.length ? scope : undefined)
  }
}

test.each(['operator-channel', 'operator-dm', 'operator-mode', 'bot'] as const)('reporting hooks match readable projections after an unsynced %s application and I/O retry', async action => {
  const alpha = h.persona('alpha', { channels: [C.primary, C.secondary].map(id => ({ id, delivery: 'all' })), permission_prompts: C.primary,
    dm: { enabled: true, contact: 'U0OPERATOR' } })
  const beta = h.persona('beta'); h.materialize(alpha, beta)
  h.writeConfig({ channel_mode: 'open', personas: [alpha, beta] })
  let armed = false
  const run = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK, beforeWrite(path, bytes) {
    if (!armed || path !== h.paths.lastApplied || !(action === 'bot' ? botAttemptRecord(bytes, path, 'applied') : activationRecord(bytes, path))) return
    armed = false; h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
  } })
  const authority = run.controller.sharedChannels()!
  run.stub('alpha').script.inventory.push(membershipPage([C.primary, C.secondary]))
  run.stub('beta').script.inventory.push(membershipPage([beta.permission_prompts]))
  await run.membershipClock.runNext()
  const before = authority.snapshot()
  expect(authority.unreadableCause).toBeUndefined(); expectScopeMatches(authority, [before])
  if (action === 'bot') {
    run.registerSession('alpha'); armed = true
    expect((await run.callTool('alpha', 'set_channel_delivery', deliveryAttempt('report-unsynced', C.primary, 'off'))).isError).toBe(true)
  } else {
    const next = action === 'operator-channel' ? { ...alpha, channels: [{ id: C.primary, delivery: 'off' }, { id: C.secondary, delivery: 'all' }] } :
      action === 'operator-dm' ? { ...alpha, dm: { ...alpha.dm, contact: 'U0CHANGED' } } : alpha
    h.writeConfig({ channel_mode: action === 'operator-mode' ? 'strict' : 'open', personas: [next, beta] })
    await run.ticks.tick(); h.confirm(); armed = true; await run.ticks.tick()
  }
  expect(armed).toBe(false)
  h.clearWriteFailure()
  const uncertainBytes = h.readRecord()!, uncertain = disk()
  expect(authority.readable).toBe(false); expect(authority.unreadableCause).toBe('unsynced')
  expectScopeMatches(authority, [before, uncertain])
  expect(authority.unresolvedScope('alpha')).toBeDefined()
  if (action !== 'operator-mode') expect(authority.unresolvedScope('beta')).toBeUndefined()
  h.failWrites({ step: 'writeSync', call: 1, code: 'EIO' })
  expect(authority.recoverDurability()).toEqual({ kind: 'unresolved', revision: authority.revision })
  expect(authority.failure).toBe(errnoSuffix({ code: 'EIO' }))
  expect(authority.unreadableCause).toBe('unsynced'); expectScopeMatches(authority, [before, uncertain])
  expect(h.readRecord()).toEqual(uncertainBytes)
  h.clearWriteFailure()
  expect(authority.recoverDurability()).toEqual({ kind: 'applied', revision: uncertain.revision })
  expect(authority.unreadableCause).toBeUndefined(); expectScopeMatches(authority, [before, uncertain])
  expect(authority.snapshot()).toEqual(uncertain); expect(h.readRecord()).toEqual(uncertainBytes)
})

test('reporting hooks match an unsynced authenticated membership write without granting an acknowledgement', async () => {
  const f = makeMembershipHarness(h.stateDir, { names: ['alpha', 'beta'], channels: [{ id: C.secondary, delivery: 'all' }] })
  try {
    await f.start()
    const before = f.authority.snapshot()
    f.unsyncWrites(() => true)
    await f.event(true, C.primary)
    const uncertain = f.writes.at(-1)!
    expect(f.h.stub(f.h.p('alpha')).socket.acks).toEqual([])
    expect(f.authority.unreadableCause).toBe('unsynced')
    expectScopeMatches(f.authority, [before, uncertain])
    expect(f.authority.unresolvedScope('alpha')!.channels).toContain(C.primary)
    expect(f.authority.unresolvedScope('beta')).toBeUndefined()
    f.unsyncWrites(() => false); f.failWrites(() => true)
    expect(f.authority.recoverDurability().kind).toBe('unresolved')
    expect(f.authority.unreadableCause).toBe('unsynced'); expectScopeMatches(f.authority, [before, uncertain])
    f.failWrites(() => false)
    expect(f.authority.recoverDurability().kind).toBe('applied')
    expect(f.authority.unreadableCause).toBeUndefined(); expectScopeMatches(f.authority, [before, uncertain])
    assertNoLeak(f.captured())
  } finally { await f.close() }
})

test.each(['recover', 'stage'] as const)('changed uncertain bytes keep the existing failure and clear only on successful %s', action => {
  const input = { personas: [h.persona('alpha', { channels: [{ id: C.primary, delivery: 'all' }], permission_prompts: C.primary })] }
  let unsynced = true, writes = 0
  const authority = makeSharedAuthority(h.dir, input, { write(path, bytes) {
    writes++; durableWriteFileSync(path, bytes)
    if (unsynced) throw new DurableWriteUnsyncedError(path, { code: 'EIO' })
  } })
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('unresolved')
  const exact = h.readRecord()!, before = authority.snapshot(), uncertain = disk()
  const damaged = h.writeRecordBytes('changed uncertain authority evidence')
  unsynced = false
  const priorWrites = writes
  for (let i = 0; i < 2; i++) {
    expect(authority.recoverDurability()).toEqual({ kind: 'unresolved', revision: before.revision })
    expect(authority.failure).toBe(errnoSuffix(new Error('Uncertain authority evidence changed; preserve it for reviewed recovery.')))
    expect(authority.unreadableCause).toBe('evidence-changed')
    expectScopeMatches(authority, [before, uncertain])
    expect(writes).toBe(priorWrites); expect(h.readRecord()).toEqual(damaged)
  }
  if (action === 'recover') {
    h.writeRecordBytes(exact)
    expect(authority.unreadableCause).toBe('evidence-changed')
    expect(authority.recoverDurability()).toEqual({ kind: 'applied', revision: uncertain.revision })
    expect(authority.unreadableCause).toBeUndefined(); expect(authority.unresolvedScope('alpha')).toBeUndefined()
    expect(authority.failure).toBe(''); expect(authority.snapshot()).toEqual(uncertain)
    expect(h.readRecord()).toEqual(exact)
  } else {
    // t3.yiv.sf.ws.ih, review-r2 R1: the caller's request keeps structuredClone;
    // the fast copier copies only committed or parsed state.
    const request = sharedRecoveryRequest('report-stage', damaged), serialising = spyOn(globalThis, 'structuredClone')
    try {
      expect(authority.stageRestoration(request, damaged, configBytes(input)).kind).toBe('unresolved')
      expect(serialising.mock.calls.filter(([value]) => value === request)).toHaveLength(1)
    } finally { serialising.mockRestore() }
    expect(authority.unreadableCause).toBe('restoration-staged')
    expect(authority.recoverDurability().kind).toBe('unresolved')
    expect(authority.unreadableCause).toBe('restoration-staged')
    expectScopeMatches(authority, [before, disk()])
  }
  expect(writes).toBe(priorWrites + 1)
})

test('readable authority reports every projection held by interrupted reviewed retirement, until recovery', async () => {
  const alpha = h.persona('alpha'), beta = h.persona('beta'); h.materialize(alpha, beta)
  h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  const run = await start({ beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) h.failWrites({ code: 'EIO' })
  } })
  const authority = run.controller.sharedChannels()!
  h.writeConfig({ personas: [beta] }); await run.ticks.tick(); h.confirm(); armed = true; await run.ticks.tick()
  expect(authority.readable).toBe(true); expect(authority.unreadableCause).toBeUndefined()
  expect(authority.reviewHeld('alpha')).toBe(true)
  expect(authority.unresolvedScope('alpha')).toMatchObject({ all: true, dm: true })
  expectScopeMatches(authority, [authority.snapshot()])
  expect(authority.unresolvedScope('beta')).toBeUndefined()
  armed = false; h.clearWriteFailure(); await run.ticks.tick()
  expect(authority.reviewHeld('alpha')).toBe(false); expect(authority.unresolvedScope('alpha')).toBeUndefined()
})

test('watch reports every mutation outcome after publication, isolates exceptions and unsubscribes', () => {
  const input = { personas: [h.persona('alpha')] }
  let failure: 'none' | 'definite' | 'unsynced' = 'none', writes = 0
  const authority = makeSharedAuthority(h.dir, input, { write(path, bytes) {
    writes++
    if (failure === 'definite') throw Object.assign(new Error('fixture write failure'), { code: 'EIO' })
    durableWriteFileSync(path, bytes)
    if (failure === 'unsynced') throw new DurableWriteUnsyncedError(path, { code: 'EIO' })
  } })
  const order: string[] = []
  authority.subscribe(() => order.push('subscribe'))
  const unthrow = authority.watch(() => { order.push('throw'); throw new Error('observer failure') })
  const unwatch = authority.watch(() => order.push('watch'))
  const check = (kind: string, action: () => { kind: string }, publishes = false) => {
    order.length = 0
    expect(action().kind).toBe(kind)
    expect(order).toEqual([...(publishes ? ['subscribe'] : []), 'throw', 'watch'])
  }
  const assign = () => authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision)
  check('applied', assign, true)
  const appliedWrites = writes
  check('stale', () => authority.transact(authority.revision - 1, () => { throw new Error('stale callback must not run') }))
  check('failed', () => authority.transact(authority.revision, () => { throw new Error('change refused') }))
  expect(writes).toBe(appliedWrites)
  failure = 'definite'; check('failed', assign)
  failure = 'unsynced'; check('unresolved', assign)
  const exact = h.readRecord()!
  check('unresolved', () => authority.transact(authority.revision, () => {}))
  failure = 'definite'; check('unresolved', () => authority.recoverDurability())
  failure = 'none'
  const damage = h.writeRecordBytes('changed evidence for watcher')
  check('unresolved', () => authority.recoverDurability())
  h.writeRecordBytes(exact)
  check('applied', () => authority.recoverDurability(), true)
  check('applied', () => authority.recoverDurability())
  const request = sharedRecoveryRequest('watch-stage', damage)
  check('stale', () => authority.stageRestoration(request, damage, configBytes(input)))
  h.writeRecordBytes(damage)
  failure = 'definite'; check('failed', () => authority.stageRestoration(request, damage, configBytes(input)))
  failure = 'none'; check('unresolved', () => authority.stageRestoration(request, damage, configBytes(input)))
  check('stale', () => authority.stageRestoration(request, damage, configBytes(input)))
  check('unresolved', () => authority.recoverDurability())
  unthrow(); unwatch(); order.length = 0
  expect(authority.recoverDurability().kind).toBe('unresolved')
  expect(order).toEqual([])
})

test.each(['transact', 'recover'] as const)('watch can start a new mutation after %s releases the lock', operation => {
  let unsynced = operation === 'recover'
  const authority = makeSharedAuthority(h.dir, { personas: [h.persona('alpha')] }, { write(path, bytes) {
    durableWriteFileSync(path, bytes)
    if (unsynced) throw new DurableWriteUnsyncedError(path, { code: 'EIO' })
  } })
  const assign = (channel: string) => authority.assign('alpha', authority.incarnation('alpha')!, channel, 'off', authority.revision)
  if (operation === 'recover') expect(assign(C.primary).kind).toBe('unresolved')
  unsynced = false
  const order: string[] = [], nested: string[] = []
  authority.subscribe(() => order.push('subscribe'))
  let enter = true
  const stop = authority.watch(() => {
    order.push('watch')
    if (enter) { enter = false; nested.push(assign(C.secondary).kind) }
  })
  expect((operation === 'recover' ? authority.recoverDurability() : assign(C.primary)).kind).toBe('applied')
  expect(nested).toEqual(['applied'])
  expect(order).toEqual(['subscribe', 'watch', 'subscribe', 'watch'])
  expect(authority.choice('alpha', C.secondary)).toBe('off')
  stop()
})

test.each(['restore', 'replace'] as const)('repairActivated belongs only to the run that activates reviewed %s', async action => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] })
  let run = await start()
  expect(run.controller.repairActivated()).toBe(false)
  const authority = run.controller.sharedChannels()!
  const damage = h.writeRecordBytes('damaged repair flag evidence')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('repair-flag', damage, action === 'replace' ? input : undefined)))
  if (action === 'restore') {
    await run.ticks.tick()
    expect(authority.unreadableCause).toBe('restoration-staged')
    // Identical projections remain usable although a reviewed repair is staged.
    expectScopeMatches(authority, [authority.snapshot(), disk()])
    expect(authority.unresolvedScope('alpha')).toBeUndefined()
    expect(run.controller.repairActivated()).toBe(false)
  }
  await run.stop()
  run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expect(run.controller.repairActivated()).toBe(false)
  await run.stop(); h.confirm()
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  expect(run.controller.repairActivated()).toBe(true)
  await run.stop()
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  expect(run.controller.repairActivated()).toBe(false)
})

test('shared transaction order reservations reject invalid spans before callbacks or writes and preserve ordinary one-order commits', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let writes = 0, callbacks = 0
  const run = await start({ beforeWrite: path => { if (path === h.paths.lastApplied) writes++ } })
  const authority = run.controller.sharedChannels()!, before = authority.snapshot(), initialWrites = writes
  for (const span of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(authority.transact(authority.revision, () => { callbacks++ }, span).kind).toBe('failed')
    expect(callbacks).toBe(0)
    expect(writes).toBe(initialWrites)
    expect(applicationState(authority.snapshot())).toEqual(applicationState(before))
    expect(applicationState(disk())).toEqual(applicationState(before))
  }
  const orders: number[] = []
  const record = (next: ReturnType<typeof authority.snapshot>, order: number) => {
    orders.push(order); next.pendingIntent = { reservedOrder: order }
  }
  expect(authority.transact(authority.revision, record).kind).toBe('applied')
  expect(authority.revision).toBe(before.revision + 1)
  expect(authority.transact(authority.revision, record, 3).kind).toBe('applied')
  expect(orders).toEqual([before.revision + 1, before.revision + 4])
  expect(writes).toBe(initialWrites + 2)
  expect(applicationState(disk())).toEqual(applicationState(authority.snapshot()))
  expect(disk().pendingIntent).toEqual({ reservedOrder: before.revision + 4 })
})

test.each(['removal', 'replacement'] as const)('%s write failure after retirement preparation keeps the real delivery worker and its FIFO alive', async change => {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
  h.writeConfig({ personas: [alpha, beta] })
  let engine: EngineHarness | undefined
  const stopped: string[] = []
  let fail = false, preparedRetirement = false
  const run = await start({
    stopDelivery: key => { stopped.push(key); return engine!.engine.forget(key) },
    beforeWrite: (path, next) => {
      if (fail && path === h.paths.lastApplied && activationRecord(next, path)) {
        preparedRetirement = run.retiredKeys.isRecorded(h.key('alpha'))
        h.failWrites({ step: 'writeSync', code: 'ENOSPC' })
        fail = false
      }
    },
  })
  engine = await makeEngineHarness({ stateDir: h.stateDir, queue: run.queue, keys: ['alpha', 'beta'] }); engines.push(engine)
  for (const key of ['alpha', 'beta']) {
    engine.p(key).row.state = 'working'
    for (const seq of [1, 2]) {
      const ts = `1700000000.00000${seq}`
      const input = slackInput({ text: `  <@U0TEST001> ${key} ${seq} 😀\r\n`, key: { chat_id: 'C0TEST001', ts }, ts, thread_ts: '1700000000.000000', files: [{ name: 'retained.txt' }], queued_ack_reaction: 'hourglass' })
      const accepted = await run.queue.accept(key, input)
      expect(accepted.status).toBe('accepted')
      if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
      await run.queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts: [input.text] })
    }
    await engine.tick(key)
    expect(engine.engine.running(key)).toBe(true)
    expect(engine.textCalls(key)).toEqual([])
  }
  const accepted = ['alpha', 'beta'].map(key => run.queue.items(key).map(item => structuredClone(item.accepted)))
  const previous = disk()
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory, permission_prompts: 'dm', dm: { enabled: true, contact: 'U0TEST001' } }
  h.materialize(replacement)
  const bytes = h.writeConfig({ channel_mode: 'open', personas: change === 'removal' ? [beta] : [replacement, beta] })
  await run.ticks.tick(); h.confirm(); const confirmation = h.readApply()
  const cp = run.checkpoint(); fail = true
  await run.ticks.tick()
  expect(preparedRetirement).toBe(true)
  expect(stopped).toEqual([])
  expect(run.retiredKeys.keys()).toEqual([])
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.appliedConfigs).toEqual([])
  expect(applicationState(disk())).toEqual(applicationState(previous))
  expect(h.readConfig()).toEqual(bytes)
  expect(h.readApply()).toEqual(confirmation)
  assertNoLeak(run.captured())
  h.clearWriteFailure()
  for (const key of ['alpha', 'beta']) engine.p(key).row.state = 'waiting'
  // No wake/restart: workers that existed before the failed apply must continue.
  await engine.until(() => run.queue.openCount('alpha') === 0 && run.queue.openCount('beta') === 0)
  for (const [i, key] of ['alpha', 'beta'].entries()) {
    expect(run.queue.items(key).map(item => item.accepted)).toEqual(accepted[i]!)
    expect(engine.textCalls(key).map(call => call.params.text)).toEqual(accepted[i]!.map(item => item.text))
    expect(engine.events.flatMap(event => event.type === 'item-delivered' && event.key === key ? [event.seq] : [])).toEqual([1, 2])
  }
  expect(engine.errors).toEqual([])
  await engine.cleanup(); engines = []
  await run.stop()
  const reopened = await start()
  expect(applicationState(reopened.controller.sharedChannels()!.snapshot())).toEqual(applicationState(previous))
  expect(h.readConfig()).toEqual(bytes)
  expect(h.readApply()).toEqual(confirmation)
  expect(reopened.queue.openCount('alpha')).toBe(0)
  for (const item of accepted[0]!) expect((await reopened.queue.accept('alpha', item)).status).toBe('duplicate')
})

test.each(['retirement', 'publication'] as const)('shutdown during %s preserves the correct authority, prepared input and Thread Hybrid Since on reopen', async phase => {
  const alpha = h.persona('alpha'); const beta = threaded('beta'); h.materialize(alpha, beta)
  h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  const stopped: string[] = []
  const run = await start({ stopDelivery: key => stopped.push(key), beforeWrite: path => {
    if (armed && phase === 'retirement' && path === h.retiredKeysFile) run.controller.stopDetection()
  } })
  const authority = run.controller.sharedChannels()!
  expect(authority.transact(authority.revision, next => { next.pendingIntent = { prepared: 'retained' } }).kind).toBe('applied')
  const notificationsBefore = run.appliedConfigs.length
  const before = authority.snapshot()
  const views: SharedThreadView[] = []
  authority.subscribeThreadView(view => views.push(view))
  // A Channel Mode switch keeps the untouched persona's Thread Hybrid Since.
  const kept: SharedChannelStampState = { kind: 'decided', incarnation: before.personas.beta!.incarnation, threadHybridSince: sinceOf(before, 'beta') }
  expect(sinceOf(before, 'beta')).toEqual(expect.any(String))
  const bytes = h.writeConfig({ channel_mode: 'open', personas: [beta] })
  await run.ticks.tick(); h.confirm(); const confirmation = h.readApply()
  authority.subscribe(() => { if (armed && phase === 'publication') run.controller.stopDetection() })
  const cp = run.checkpoint(); armed = true
  await run.ticks.tick()
  expect(stopped).toEqual(phase === 'publication' ? ['alpha'] : [])
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.appliedConfigs.slice(notificationsBefore)).toEqual(phase === 'publication' ? [authority.config()] : [])
  expect(authority.config().channel_mode).toBe(phase === 'retirement' ? 'strict' : 'open')
  expect(run.controller.applied()!.config).toEqual(authority.config())
  expect(run.retiredKeys.keys()).toEqual(phase === 'retirement' ? [] : [h.key('alpha')])
  expect(authority.snapshot().pendingIntent).toEqual(before.pendingIntent)
  expect(h.readConfig()).toEqual(bytes)
  if (phase === 'retirement') {
    expect(applicationState(authority.snapshot())).toEqual(applicationState(before))
    expect(h.readApply()).toEqual(confirmation)
  }
  // The retirement journal holds only the retiring persona's stamps and is
  // delivered as such; its rejection or the removal then delivers again.
  const released: SharedChannelStampState | undefined = phase === 'retirement' ? { kind: 'decided', incarnation: before.personas.alpha!.incarnation } : undefined
  expect(views).toHaveLength(2)
  expect(views[0]!.stamp('alpha', alpha.permission_prompts)).toEqual({ kind: 'undecided' })
  expect(views[1]!.stamp('alpha', alpha.permission_prompts)).toEqual(released)
  expect(authority.channelStamp('alpha', alpha.permission_prompts)).toEqual(released)
  for (const view of views) expect(view.stamp('beta', THREAD)).toEqual(kept)
  expect(authority.channelStamp('beta', THREAD)).toEqual(kept)
  assertNoLeak(run.captured())
  await run.stop()
  const reopened = await start()
  const reopenedAuthority = reopened.controller.sharedChannels()!
  expect(reopened.controller.applied()!.config.channel_mode).toBe(phase === 'retirement' ? 'strict' : 'open')
  expect(applicationState(reopenedAuthority.snapshot())).toEqual(applicationState(authority.snapshot()))
  expect(reopenedAuthority.channelStamp('beta', THREAD)).toEqual(kept)
  expect(reopenedAuthority.channelStamp('alpha', alpha.permission_prompts)).toEqual(released)
  expect(h.readConfig()).toEqual(bytes)
})

test('a reporting exception cannot undo durable application or repeat a consumed confirmation', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start({ onApplied: () => { throw new Error(sentinelInMessage('observer')) } })
  const bytes = h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, stop_hook_bootstrap: false }] })
  await run.ticks.tick(); h.confirm(); await run.ticks.tick()
  expect(run.controller.sharedChannels()!.sourceBytes()).toEqual(bytes)
  expect(run.controller.applied()!.config.channel_mode).toBe('open')
  expect(run.controller.applied()!.config.personas[0]!.stop_hook_bootstrap).toBe(false)
  expect(h.readApply()).toBeUndefined()
  expect(h.readPending()).toBeUndefined()
  const revision = disk().revision
  await run.ticks.tick()
  expect(disk().revision).toBe(revision)
  assertNoLeak(run.captured())
})

test('shutdown in the first in-place operation prevents later fanout and bring-up, retaining the whole durable configuration', async () => {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); const gamma = h.persona('gamma')
  h.materialize(alpha, beta, gamma); h.writeConfig({ personas: [alpha, beta] })
  const run = await start({ realLifecycle: true })
  const update = run.composition!.lifecycle.updateInPlace
  const stop = spyOn(run.composition!.lifecycle, 'updateInPlace').mockImplementation(change => {
    run.controller.stopDetection()
    return update(change)
  })
  try {
    const bytes = h.writeConfig({ personas: [{ ...alpha, stop_hook_bootstrap: false }, { ...beta, stop_hook_bootstrap: false }, gamma] })
    await run.ticks.tick(); h.confirm(); const confirmation = h.readApply(); const cp = run.checkpoint(); await run.ticks.tick()
    expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: h.key('alpha'), via: 'apply', settings: ['stop_hook_bootstrap'] }])
    expect(run.controller.sharedChannels()!.sourceBytes()).toEqual(bytes)
    expect(run.controller.applied()!.config.personas.map(p => [p.name, p.stop_hook_bootstrap])).toEqual([['alpha', false], ['beta', false], ['gamma', true]])
    expect(h.readApply()).toEqual(confirmation)
    await run.stop()
    const reopened = await start()
    expect(reopened.controller.sharedChannels()!.sourceBytes()).toEqual(bytes)
    expect(reopened.controller.applied()!.config.personas).toEqual(run.controller.applied()!.config.personas)
  } finally { stop.mockRestore() }
})

test('post-read stat failure safely refuses startup and a later reload without losing the reviewed state', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let failing = true
  const reads = new Set<number>(), opened = new Set<number>()
  const configFs: Partial<PersonaConfigFs> = {
    openFile(path) { const fd = DEFAULT_PERSONA_CONFIG_FS.openFile(path); opened.add(fd); return fd },
    readFileFd(fd, max) { reads.add(fd); return DEFAULT_PERSONA_CONFIG_FS.readFileFd(fd, max) },
    fstatFile(fd) {
      if (failing && reads.has(fd)) throw Object.assign(new Error(sentinelInMessage('post-stat')), { code: 'EIO' })
      return DEFAULT_PERSONA_CONFIG_FS.fstatFile(fd)
    },
    closeFile(fd) { reads.delete(fd); opened.delete(fd); DEFAULT_PERSONA_CONFIG_FS.closeFile(fd) },
  }
  const refused = await h.start({ dryRun: true, configFs }); runs.push(refused)
  expect(refused.outcome.kind).toBe('refused')
  expect(refused.controller.applied()).toBeUndefined()
  expect(refused.lifecycle.records).toEqual([])
  expect(opened.size).toBe(0)
  await refused.stop(); failing = false
  const run = await start({ configFs }); const before = disk()
  const bytes = h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  failing = true
  await run.ticks.tick()
  expect(h.readPendingText()).toContain('INVALID')
  expect(h.readPendingText()).toContain('EIO')
  expect(applicationState(disk())).toEqual(applicationState(before))
  expect(h.readConfig()).toEqual(bytes)
  expect(run.appliedConfigs).toEqual([])
  expect(opened.size).toBe(0)
  assertNoLeak(run.captured())
})

 test('unconfirmed mode, list and destination stay pending across reopen', async () => {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
  const original = { channel_mode: 'strict', personas: [alpha, beta] }
  h.writeConfig(original)
  const first = await start()
  const before = readFileSync(h.paths.lastApplied)
  h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, channels: [{ id: 'C0NEW0001', delivery: 'thread_hybrid' }], permission_prompts: 'C0NEW0001' }, beta] })
  await first.ticks.tick()
  expect(h.readPending()).toBeDefined()
  expect(first.controller.applied()!.config.channel_mode).toBe('strict')
  assertNoLeak(first.captured())
  await first.stop()
  const reopened = await start()
  expect(reopened.controller.applied()!.config.channel_mode).toBe('strict')
  expect(reopened.controller.applied()!.config.personas[0]!.permission_prompts).toBe(alpha.permission_prompts)
  expect(applicationState(readFileSync(h.paths.lastApplied))).toEqual(applicationState(before))
  await reopened.ticks.tick()
  expect(h.readPending()).toBeDefined()
  assertNoLeak(reopened.captured())
 })

 test('1000-channel state retains exact input and oversized confirmation on capacity failure, then grows to 1100 and reopens', async () => {
  const alpha = h.persona('alpha', { channels: channelPopulation(1000), permission_prompts: channelPopulation(1)[0]!.id })
  h.materialize(alpha)
  h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  expect(statSync(h.paths.config).size).toBeGreaterThan(65_536)
  const run = await start()
  const authority = run.controller.sharedChannels()!
  expect(authority.config().personas[0]!.channels).toHaveLength(1000)
  const grown = [...alpha.channels!, ...channelPopulation(100, 1000)]
  const detection = run.checkpoint()
  const prepared = h.writeConfig({ channel_mode: 'strict', personas: [{ ...alpha, channels: grown }] })
  await run.ticks.tick()
  expect(run.since(detection).lifecycle).toEqual([])
  expect(h.readPending()).toBeDefined()
  // Confirmation is compared in full; a large whitespace suffix cannot be truncated into a different gesture.
  const preview = h.readPending()!
  h.writeApplyBytes(Buffer.concat([preview, Buffer.alloc(80_000, 32)]))
  const confirmation = h.readApply()!
  const before = readFileSync(h.paths.lastApplied)
  const choices = authority.snapshot()
  const cp = run.checkpoint()
  h.failWrites({ step: 'writeSync', code: 'ENOSPC' })
  assertNoLeak(run.captured())
  await run.ticks.tick()
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.appliedConfigs).toEqual([])
  expect(applicationState(authority.snapshot())).toEqual(applicationState(choices))
  expect(authority.config().personas[0]!.channels).toEqual(channelPopulation(1000))
  expect(applicationState(readFileSync(h.paths.lastApplied))).toEqual(applicationState(before))
  expect(h.readConfig()).toEqual(prepared)
  expect(h.readApply()).toEqual(confirmation)
  expect(run.logsOf('reload-record-write-failed')).toEqual([
    reloadSharedAuthorityApplyFailedLine(h.paths.lastApplied, 'failed', errnoSuffix({ code: 'ENOSPC' })),
  ])
  assertNoLeak(run.captured())
  h.clearWriteFailure()
  const retry = run.checkpoint()
  await run.ticks.tick()
  expect(run.since(retry).writes).toEqual([])
  expect(run.since(retry).lifecycle).toEqual([])
  expect(applicationState(authority.snapshot())).toEqual(applicationState(choices))
  expect(h.readConfig()).toEqual(prepared)
  expect(h.readApply()).toEqual(confirmation)
  assertNoLeak(run.captured())
  await run.stop()
  const recovery = await start()
  expect(applicationState(recovery.controller.sharedChannels()!.snapshot())).toEqual(applicationState(choices))
  expect(h.readApply()).toEqual(confirmation)
  expect(h.readConfig()).toEqual(prepared)
  // Startup retains evidence, then its first tick supersedes the old review.
  await recovery.ticks.tick()
  expect(h.readPending()).toBeDefined()
  assertNoLeak(recovery.captured())
  h.confirm()
  await recovery.ticks.tick()
  const recoveredAuthority = recovery.controller.sharedChannels()!
  expect(recoveredAuthority.sourceBytes()).toEqual(prepared)
  expect(recoveredAuthority.config().channel_mode).toBe('strict')
  expect(recoveredAuthority.config().personas[0]!.channels).toEqual(grown)
  expect(statSync(h.paths.lastApplied).size).toBeGreaterThan(65_536)
  await recovery.stop()
  const reopened = await start()
  expect(reopened.controller.sharedChannels()!.sourceBytes()).toEqual(prepared)
  expect(reopened.controller.applied()!.config.personas[0]!.channels).toEqual(grown)
  expect(reopened.controller.applied()!.config.channel_mode).toBe('strict')
  expect(h.readApply()).toBeUndefined()
  expect(h.readPending()).toBeUndefined()
 })

 test.each(['before', 'after'] as const)('interruption %s durable activation retains trustworthy state, prepared input and each value with its Thread Hybrid Since', async when => {
  const alpha = threaded('alpha'), beta = threaded('beta'); h.materialize(alpha, beta)
  h.writeConfig({ personas: [alpha, beta] })
  let armed = false
  let attempted: SharedChannelState | undefined
  const run = await start({ beforeWrite: (path, bytes) => {
    if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) {
      armed = false
      attempted = parseSharedChannelState(bytes, path)
      h.failWrites(when === 'before' ? { step: 'writeSync', code: 'ENOSPC', call: 1 } : { step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } })
  const authority = run.controller.sharedChannels()!
  const incarnation = authority.incarnation(h.key('alpha'))!
  expect(authority.transact(authority.revision, next => { next.pendingIntent = { prepared: 'review' }; next.outcomes = { prior: 'retained' } }).kind).toBe('applied')
  const before = disk()
  // One confirmation changes mode, list and identity: alpha keeps THREAD, turns
  // its default channel thread_hybrid and adds another; beta's new life resets
  // its copied THREAD entry and declares C0THREAD3.
  const movedBeta = { ...beta, working_directory: h.persona('beta_moved').working_directory,
    channels: [...beta.channels, { id: 'C0THREAD3', delivery: 'thread_hybrid' as const }] }
  h.materialize(movedBeta)
  h.writeConfig({ channel_mode: 'open', personas: [{ ...alpha, channels: [
    { id: alpha.permission_prompts, delivery: 'thread_hybrid' }, { id: THREAD, delivery: 'thread_hybrid' }, { id: 'C0THREAD2', delivery: 'thread_hybrid' },
  ] }, movedBeta] })
  await run.ticks.tick()
  h.confirm()
  const confirmation = h.readApply()!
  armed = true
  await run.ticks.tick()
  expect(authority.config().channel_mode).toBe('strict')
  expect(applicationState(authority.snapshot())).toEqual(applicationState(before))
  expect(h.readApply()).toEqual(confirmation)
  expect(h.readConfig()).toBeDefined()
  expect(h.readPending() ?? h.readApply()).toBeDefined()
  assertNoLeak(run.captured())
  h.clearWriteFailure()
  await run.stop()
  const reopened = await start()
  expect(reopened.controller.sharedChannels()!.incarnation(h.key('alpha'))).toBe(incarnation)
  expect(reopened.controller.applied()!.config.channel_mode).toBe(when === 'before' ? 'strict' : 'open')
  expect(disk().pendingIntent).toEqual(before.pendingIntent)
  expect(disk().outcomes.prior).toEqual(before.outcomes.prior)
  expect(Object.values(reviewLedger(disk())!.outcomes).some(outcome => outcome.status === (when === 'before' ? 'rejected' : 'consumed'))).toBe(true)
  // Each reopened value carries exactly the Thread Hybrid Since of the one
  // durable write that installed it: the old state's, or the activation's.
  const reopenedState = reopened.controller.sharedChannels()!.snapshot()
  expect(assignmentsOf(reopenedState)).toEqual(assignmentsOf(when === 'before' ? before : attempted!))
  if (when === 'after') {
    const previous = [sinceOf(before, 'alpha'), sinceOf(before, 'beta')]
    expect(sinceOf(reopenedState, 'alpha')).toBe(previous[0])
    const minted = [sinceOf(reopenedState, 'alpha', alpha.permission_prompts), sinceOf(reopenedState, 'alpha', 'C0THREAD2'), sinceOf(reopenedState, 'beta', 'C0THREAD3')]
    for (const id of minted) { expect(id).toEqual(expect.any(String)); expect(previous).not.toContain(id) }
    expect(new Set(minted).size).toBe(3)
    expect(reopenedState.personas.beta!.assignments[THREAD]).toBeUndefined()
    expect(reopenedState.personas.beta!.incarnation).not.toBe(before.personas.beta!.incarnation)
  }
 })

test.each(['before-rename', 'installed-unsynced'] as const)('operator thread_hybrid assignment interrupted %s keeps value and Thread Hybrid Since together; only its channel reads undecided until recovered', async fault => {
  const alpha = threaded('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  const channel = alpha.permission_prompts, life = authority.incarnation('alpha')!
  const kept: SharedChannelStampState = { kind: 'decided', incarnation: life, threadHybridSince: sinceOf(authority.snapshot()) }
  const keptSince = sinceOf(authority.snapshot())
  expect(authority.channelStamp('alpha', THREAD)).toEqual(kept)
  expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'decided', incarnation: life })
  const views: SharedThreadView[] = []
  authority.subscribeThreadView(view => views.push(view))
  const before = disk()
  h.failWrites(fault === 'before-rename' ? { step: 'writeSync', code: 'ENOSPC' } : { step: 'fsyncSync', call: 2, code: 'EIO' })
  const result = authority.assign('alpha', life, channel, 'thread_hybrid', authority.revision)
  h.clearWriteFailure()
  let installed = before.personas.alpha!.assignments[channel]
  if (fault === 'before-rename') {
    // A definite failure changes nothing and delivers no view.
    expect(result.kind).toBe('failed')
    expect(disk()).toEqual(before)
    expect(views).toEqual([])
    expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'decided', incarnation: life })
  } else {
    expect(result.kind).toBe('unresolved')
    installed = disk().personas.alpha!.assignments[channel]
    expect(installed).toEqual({ delivery: 'thread_hybrid', order: before.revision + 1, threadHybridSince: expect.any(String) })
    expect(installed!.threadHybridSince).not.toBe(keptSince)
    expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'undecided' })
    expect(authority.channelStamp('alpha', THREAD)).toEqual(kept)
    // An undecided or absent stamp never counts as current, even for the installed value.
    const joined: ChannelStamp = { incarnation: life, threadHybridSince: installed!.threadHybridSince! }
    expect(sameChannelStamp(joined, authority.channelStamp('alpha', channel))).toBe(false)
    expect(sameChannelStamp(kept as ChannelStamp, undefined)).toBe(false)
    expect(views).toHaveLength(1)
    expect(views[0]!.stamp('alpha', channel)).toEqual({ kind: 'undecided' })
    expect(views[0]!.stamp('alpha', THREAD)).toEqual(kept)
    expect(views[0]!.threadHybridChannels('alpha')).toEqual([THREAD])
    expect(authority.recoverDurability().kind).toBe('applied')
    const recovered: SharedChannelStampState = { kind: 'decided', incarnation: life, threadHybridSince: installed!.threadHybridSince }
    expect(authority.channelStamp('alpha', channel)).toEqual(recovered)
    expect(sameChannelStamp(joined, authority.channelStamp('alpha', channel))).toBe(true)
    expect(views).toHaveLength(2)
    expect(views[1]!.stamp('alpha', channel)).toEqual(recovered)
    expect(views[1]!.threadHybridChannels('alpha')).toEqual([channel, THREAD].sort())
    expect(views[0]!.stamp('alpha', channel)).toEqual({ kind: 'undecided' })
  }
  await run.stop()
  const reopened = (await start()).controller.sharedChannels()!
  expect(reopened.snapshot().personas.alpha!.assignments[channel]).toEqual(installed)
  expect(reopened.channelStamp('alpha', THREAD)).toEqual(kept)
  // A same-value write takes a new order but keeps its Thread Hybrid Since.
  const revision = reopened.revision
  expect(reopened.assign('alpha', life, THREAD, 'thread_hybrid', revision).kind).toBe('applied')
  expect(disk().personas.alpha!.assignments[THREAD]).toEqual({ delivery: 'thread_hybrid', order: revision + 1, threadHybridSince: keptSince })
  expect(reopened.channelStamp('alpha', THREAD)).toEqual(kept)
})

test('Thread Memory marker set and clear are durable whole-file writes, readable at start and kept for a removed persona', async () => {
  const alpha = threaded('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta); h.writeConfig({ personas: [alpha, beta] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  const writes = lastAppliedWrites(run)
  expect(authority.setThreadMemoryCreated('beta')).toEqual({ kind: 'saved' })
  expect(lastAppliedWrites(run)).toBe(writes + 1)
  expect(authority.setThreadMemoryCreated('beta')).toEqual({ kind: 'saved' })
  expect(lastAppliedWrites(run)).toBe(writes + 1)
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  expect(disk().threadMemoryCreated).toEqual({ alpha: true, beta: true })
  h.writeConfig({ personas: [alpha] }); await run.ticks.tick()
  h.confirm(); await run.ticks.tick()
  expect(authority.config().personas.map(persona => persona.key)).toEqual(['alpha'])
  expect(authority.threadMemoryCreatedKeys()).toEqual(['alpha', 'beta'])
  await run.stop()
  // The start read answers before any persona starts.
  const reopened = h.build({ dryRun: true }); runs.push(reopened)
  expect(reopened.resolveStart().kind).toBe('applied')
  expect(reopened.lifecycle.records).toEqual([]); expect(reopened.lifecycle.startPasses).toEqual([])
  const read = reopened.controller.sharedChannels()!
  expect(read.threadMemoryCreated('beta')).toBe(true)
  expect(read.threadMemoryCreatedKeys()).toEqual(['alpha', 'beta'])
  expect(read.clearThreadMemoryCreated('beta')).toEqual({ kind: 'saved' })
  const cleared = lastAppliedWrites(reopened)
  expect(read.clearThreadMemoryCreated('beta')).toEqual({ kind: 'saved' })
  expect(lastAppliedWrites(reopened)).toBe(cleared)
  expect(read.threadMemoryCreated('beta')).toBe(false)
  expect(read.clearThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  expect(Object.hasOwn(disk(), 'threadMemoryCreated')).toBe(false)
})

test.each([
  ['failed', { step: 'writeSync', code: 'ENOSPC' }],
  ['written-but-unsynced', { step: 'fsyncSync', call: 2, code: 'EIO' }],
] as const)('a %s marker write reports failed, keeps the in-memory marker and readability, and a retry writes again', async (kind, failure) => {
  const alpha = threaded('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  const life = authority.incarnation('alpha')!, revision = authority.revision
  const views: SharedThreadView[] = []
  authority.subscribeThreadView(view => views.push(view))
  const stamp = authority.channelStamp('alpha', THREAD)
  for (const created of [true, false]) {
    const write = () => created ? authority.setThreadMemoryCreated('alpha') : authority.clearThreadMemoryCreated('alpha')
    h.failWrites(failure)
    expect(write()).toEqual({ kind: 'failed' })
    h.clearWriteFailure()
    expect(authority.threadMemoryCreated('alpha')).toBe(!created)
    expect(authority.readable).toBe(true); expect(authority.readableFor('alpha', THREAD)).toBe(true)
    expect(authority.channelStamp('alpha', THREAD)).toEqual(stamp)
    expect(Object.hasOwn(disk(), 'threadMemoryCreated')).toBe(kind === 'failed' ? !created : created)
    const writes = lastAppliedWrites(run)
    expect(write()).toEqual({ kind: 'saved' })
    expect(lastAppliedWrites(run)).toBe(writes + 1)
    expect(authority.threadMemoryCreated('alpha')).toBe(created)
    expect(Object.hasOwn(disk(), 'threadMemoryCreated')).toBe(created)
  }
  expect(views).toEqual([])
  // A revision captured before the marker writes is still current.
  expect(authority.revision).toBe(revision)
  expect(authority.assign('alpha', life, alpha.permission_prompts, 'mentions', revision).kind).toBe('applied')
})

test('marker writes refuse with no write for a key that is not a current persona, inside a publication, while unreadable and while a restoration is staged', async () => {
  const alpha = threaded('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  const life = authority.incarnation('alpha')!, channel = alpha.permission_prompts
  let writes = lastAppliedWrites(run)
  expect(authority.setThreadMemoryCreated('ghost')).toEqual({ kind: 'failed' })
  expect(lastAppliedWrites(run)).toBe(writes)
  const inside: ThreadMemoryMarkerResult[] = []
  const stopView = authority.subscribeThreadView(() => { inside.push(authority.setThreadMemoryCreated('alpha')) })
  const stopConfig = authority.subscribe(() => { inside.push(authority.setThreadMemoryCreated('alpha')) })
  expect(authority.assign('alpha', life, channel, 'mentions', authority.revision).kind).toBe('applied')
  stopView(); stopConfig()
  expect(inside).toEqual([{ kind: 'failed' }, { kind: 'failed' }])
  expect(lastAppliedWrites(run)).toBe(writes + 1)
  expect(authority.threadMemoryCreated('alpha')).toBe(false)
  h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
  expect(authority.assign('alpha', life, channel, 'all', authority.revision).kind).toBe('unresolved')
  h.clearWriteFailure(); writes = lastAppliedWrites(run)
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'failed' })
  expect(lastAppliedWrites(run)).toBe(writes)
  expect(authority.recoverDurability().kind).toBe('applied')
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  // A staged restoration decides no stamp, live or delivered, and takes no marker write.
  const views: SharedThreadView[] = []
  authority.subscribeThreadView(view => views.push(view))
  const damage = h.writeRecordBytes('damaged while the owner holds its validated state')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('marker-staged', damage)))
  await run.ticks.tick()
  expect(authority.readable).toBe(false); expect(authority.readableFor('alpha', THREAD)).toBe(true)
  expect(authority.channelStamp('alpha', THREAD)).toEqual({ kind: 'undecided' })
  expect(views).toHaveLength(1)
  expect(views[0]!.stamp('alpha', THREAD)).toEqual({ kind: 'undecided' })
  expect(views[0]!.threadHybridChannels('alpha')).toEqual([])
  writes = lastAppliedWrites(run)
  expect(authority.clearThreadMemoryCreated('alpha')).toEqual({ kind: 'failed' })
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'failed' })
  expect(lastAppliedWrites(run)).toBe(writes)
  expect(authority.threadMemoryCreated('alpha')).toBe(true)
  expect(disk().threadMemoryCreated).toEqual({ alpha: true })
})

 test('a same-value assignment invalidates an older confirmation and never replays a copied source preference', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  await run.ticks.tick(); h.confirm()
  const life = authority.incarnation(h.key('alpha'))!
  expect(authority.assign(h.key('alpha'), life, alpha.channels![0]!.id, 'all', authority.revision).kind).toBe('applied')
  await run.ticks.tick()
  expect(authority.config().channel_mode).toBe('strict')
  expect(h.readPending()).toBeDefined()
  assertNoLeak(run.captured())
  await (await run.confirmPending()).applying
  expect(authority.config().channel_mode).toBe('open')
  expect(authority.choice(h.key('alpha'), alpha.channels![0]!.id)).toBe('all')
 })

 test('a generated preview above 64 KiB remains complete through confirmation and durable reopen', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  const run = await start()
  const additions = Array.from({ length: 420 }, (_, i) => h.persona(`extra_${String(i).padStart(5, '0')}_${'long_persona_name_'.repeat(4)}`))
  h.materialize(...additions)
  h.writeConfig({ personas: [alpha, ...additions] })
  await run.ticks.tick()
  const preview = h.readPending()!
  expect(preview.byteLength).toBeGreaterThan(65_536)
  expect(preview.toString()).toContain(additions.at(-1)!.name)
  assertNoLeak(run.captured())
  await (await run.confirmPending()).applying
  expect(run.controller.applied()!.config.personas.map(p => p.name)).toEqual([alpha, ...additions].map(p => p.name))
  await run.stop()
  const reopened = await start()
  expect(reopened.controller.applied()!.config.personas).toHaveLength(421)
 })

 test.each(['strict', 'open'] as const)('%s: only-channel removal with DMs disabled survives reopen and unrelated confirmation', async channel_mode => {
  const alpha = h.persona('alpha', { dm: { enabled: false } }); h.materialize(alpha); h.writeConfig({ channel_mode, personas: [alpha] })
  const run = await start(); const authority = run.controller.sharedChannels()!
  const key = h.key(alpha.name); const life = authority.incarnation(key)!
  expect((await run.queue.accept(key, slackInput({ text: '  <@U0TEST001> kept\r\n', channel: alpha.permission_prompts, key: { chat_id: alpha.permission_prompts, ts: '1700000000.000001' } }))).status).toBe('accepted')
  const accepted = structuredClone(run.queued(alpha.name).map(item => item.accepted))
  expect(authority.observeMembership(key, life, { event: 'verified-leave', identity: 'authenticated-app', channel: alpha.permission_prompts, member: false, boundary: 0 }, authority.revision).kind).toBe('applied')
  await run.stop()
  const reopened = await start(); const current = reopened.controller.sharedChannels()!
  expect(current.config().personas[0]!.channels).toEqual([])
  expect(current.config().personas[0]!.permission_prompts).toBe(alpha.permission_prompts)
  expect(current.validatesRemovedDestination(current.config().personas[0]!)).toBe(true)
  const prepared = h.writeConfig({ channel_mode, personas: [{ ...alpha, channels: [], stop_hook_bootstrap: false }] })
  await reopened.ticks.tick()
  assertNoLeak(reopened.captured())
  await (await reopened.confirmPending()).applying
  expect(current.sourceBytes()).toEqual(prepared)
  expect(current.config().personas[0]!.channels).toEqual([])
  expect(current.config().personas[0]!.permission_prompts).toBe(alpha.permission_prompts)
  expect(current.config().personas[0]!.stop_hook_bootstrap).toBe(false)
  expect(current.incarnation(key)).toBe(life)
  expect(reopened.queued(alpha.name).map(item => item.accepted)).toEqual(accepted.map(item => ({ ...item, attempt_high_watermark: 0 })))
  const replacement = { ...alpha, working_directory: h.persona('replacement').working_directory, channels: [] }
  h.writeConfig({ personas: [replacement] })
  await reopened.ticks.tick()
  expect(h.readPendingText()).toContain('INVALID')
  expect(current.incarnation(key)).toBe(life)
  expect(current.config().personas[0]!.working_directory).toBe(alpha.working_directory)
 })

 test.each(['whitespace', 'explicit strict default'] as const)('a %s confirmation preserves newer assignments and exact reviewed bytes through reopen', async edit => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const source = h.writeConfig({ personas: [alpha] })
  const run = await start()
  const authority = run.controller.sharedChannels()!
  const key = h.key(alpha.name)
  const channel = alpha.channels![0]!.id
  expect(authority.assign(key, authority.incarnation(key)!, channel, 'mentions', authority.revision).kind).toBe('applied')
  const assignment = authority.snapshot().personas[key]!.assignments[channel]!
  const revision = authority.revision
  const bytes = edit === 'whitespace' ? Buffer.concat([source, Buffer.from(' \n')]) : Buffer.from(JSON.stringify({ channel_mode: 'strict', personas: [alpha] }, null, 2) + '\n')
  h.writeConfigBytes(bytes)
  const cp = run.checkpoint()
  await run.ticks.tick()
  expect(h.pendingExists()).toBe(true)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(authority.choice(key, channel)).toBe('mentions')
  assertNoLeak(run.captured())
  await (await run.confirmPending()).applying
  expect(authority.revision).toBe(revision + 4)
  expect(authority.snapshot().personas[key]!.assignments[channel]).toEqual(assignment)
  expect(authority.sourceBytes()).toEqual(bytes)
  expect(Buffer.from(disk().sourceBytesBase64, 'base64')).toEqual(bytes)
  expect(h.readPending()).toBeUndefined()
  await run.stop()
  const reopened = await start()
  const recovered = reopened.controller.sharedChannels()!
  expect(recovered.sourceBytes()).toEqual(bytes)
  expect(recovered.snapshot().personas[key]!.assignments[channel]).toEqual(assignment)
  await reopened.ticks.tick()
  expect(h.readPending()).toBeUndefined()
  expect(reopened.slackPosts()).toEqual([])
 })

const removedSettings = [
  { key: 'allow_invited_channels', replacement: 'channel_mode', persona: false },
  { key: 'invited', replacement: 'permission_prompts', persona: true },
] as const
function withRemovedSetting(input: Record<string, unknown>, setting: (typeof removedSettings)[number]) {
  const malformed = structuredClone(input)
  const target = setting.persona ? (malformed.personas as Record<string, unknown>[])[0]! : malformed
  target[setting.key] = { ignored: 'must still be rejected' }
  return malformed
}
function removalDetail(setting: (typeof removedSettings)[number]) {
  return `${setting.key} has been removed; use ${setting.replacement}.`
}
function removalError(path: string, setting: (typeof removedSettings)[number]) {
  return `loadPersonaConfig: invalid persona config in ${JSON.stringify(path)}: Persona config validation error: ` +
    (setting.persona ? 'personas[0] "alpha" (key=alpha): ' : '') + removalDetail(setting)
}

test.each(removedSettings.flatMap(setting => (['strict', 'open'] as const).flatMap(mode =>
  (['config', 'raw-record', 'source', 'applied'] as const).map(location => ({ setting, mode, location })),
)))('startup refuses $setting.key in coherent $location / $mode without partial activation', async ({ setting, mode, location }) => {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
  const valid = { channel_mode: mode, personas: [alpha, beta] }
  const prepared = h.writeConfig(valid)
  let envelope: Buffer | undefined
  if (location === 'config') h.writeConfig(withRemovedSetting(valid, setting))
  else if (location === 'raw-record') {
    envelope = configBytes(withRemovedSetting(valid, setting))
    h.writeRecordBytes(envelope)
  } else {
    const initial = await start()
    await initial.stop()
    const state = disk()
    state[location] = withRemovedSetting(state[location], setting)
    // Match the malformed reviewed source exactly, so schema rejection cannot be an evidence mismatch.
    if (location === 'source') state.sourceBytesBase64 = configBytes(state.source).toString('base64')
    envelope = Buffer.from(serializeSharedChannelState(state))
    h.writeRecordBytes(envelope)
    expect(() => parseSharedChannelState(envelope!, h.paths.lastApplied)).toThrow(removalError(h.paths.lastApplied, setting))
  }
  const config = h.readConfig()
  const refused = await h.start({ dryRun: true }); runs.push(refused)
  expect(refused.outcome.kind).toBe('refused')
  expect(refused.outcome.kind === 'refused' && refused.outcome.source).toBe(location === 'config' ? 'config' : 'record')
  const error = removalError(location === 'config' ? h.paths.config : h.paths.lastApplied, setting)
  expect(refused.outcome.kind === 'refused' && refused.outcome.line).toBe(
    location === 'config' ? `[slack] Fatal: configuration error — ${error}` :
      `[slack] Fatal: last-applied record error — ${error} Preserve the shared channel authority ${JSON.stringify(h.paths.lastApplied)} and prepared configuration ${JSON.stringify(h.paths.config)}; restore trustworthy authority evidence before starting again.`,
  )
  expect(refused.controller.applied()).toBeUndefined()
  expect(refused.controller.sharedChannels()).toBeUndefined()
  expect(refused.lifecycle.timeline).toEqual([])
  expect(refused.appliedConfigs).toEqual([])
  expect(h.readConfig()).toEqual(config)
  if (envelope) {
    expect(h.readRecord()).toEqual(envelope)
    expect(h.readConfig()).toEqual(prepared)
  } else expect(h.readRecord()).toBeUndefined()
  expect(refused.slackPosts()).toEqual([])
  assertNoLeak(refused.captured())
})

test.each(removedSettings.flatMap(setting => (['strict', 'open'] as const).map(mode => ({ setting, mode }))))(
  'confirmation of removed $setting.key / $mode names replacement and leaves authority and input intact', async ({ setting, mode }) => {
    const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
    h.writeConfig({ channel_mode: mode, personas: [alpha, beta] })
    const run = await start()
    const authority = run.controller.sharedChannels()!
    const before = readFileSync(h.paths.lastApplied)
    const applied = run.controller.applied()
    const choices = authority.snapshot()
    const prepared = h.writeConfig(withRemovedSetting({ channel_mode: mode === 'strict' ? 'open' : 'strict', personas: [alpha, beta] }, setting))
    const cp = run.checkpoint()
    await run.ticks.tick()
    const error = removalError(h.paths.config, setting)
    expect(h.pendingLines()).toEqual([`INVALID: ${error} Nothing will be applied.`])
    assertNoLeak(run.captured())
    h.confirm()
    await run.ticks.tick()
    expect(run.logsOf('reload-invalid')).toContain(`[slack] reload-invalid: the confirmed configuration is invalid, so nothing is applied: ${error}`)
    expect(run.controller.applied()).toBe(applied)
    expect(applicationState(authority.snapshot())).toEqual(applicationState(choices))
    expect(applicationState(readFileSync(h.paths.lastApplied))).toEqual(applicationState(before))
    expect(h.readConfig()).toEqual(prepared)
    expect(h.readPendingText()).toContain(removalDetail(setting))
    expect(run.since(cp).lifecycle).toEqual([])
    expect(run.appliedConfigs).toEqual([])
    expect(run.slackPosts()).toEqual([])
    assertNoLeak(run.captured())
  },
)

test('recording/refusing filesystem sees zero legacy access through startup, reload, reopen and restored legacy reference', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const source = { channel_mode: 'strict', personas: [alpha] }
  h.writeConfig(source)
  const legacy = join(h.stateDir, 'channel-delivery.json')
  const legacyBytes = Buffer.from('{"alpha":{"C0TEST001":"off"}}\n')
  writeFileSync(legacy, legacyBytes)
  const opened: string[] = []
  const legacyAccess: string[] = []
  const fs: Partial<PersonaConfigFs> = { openFile(path) {
    opened.push(path)
    if (path === legacy) { legacyAccess.push(path); throw new Error('legacy access forbidden') }
    return DEFAULT_PERSONA_CONFIG_FS.openFile(path)
  } }
  const monitoredStart = async () => {
    const run = await h.startDetecting({ dryRun: true, configFs: fs }); runs.push(run)
    expect(run.outcome.kind).toBe('applied')
    return run
  }
  // Observe the real filesystem boundary as well as the injected config reader.
  // A reintroduced legacy module doing its own filesystem calls is refused too.
  const observedIo: string[] = []
  const legacyIo: string[] = []
  const refusingIo = async <T>(operation: () => Promise<T>): Promise<T> => {
    const spies = (['openSync', 'readFileSync', 'writeFileSync', 'statSync', 'lstatSync', 'existsSync', 'renameSync', 'unlinkSync'] as const).map(name => {
      const original = nodeFs[name]
      return spyOn(nodeFs, name).mockImplementation((...args: unknown[]) => {
        observedIo.push(name)
        if (args.some(arg => typeof arg === 'string' && arg.includes('channel-delivery.json'))) {
          legacyIo.push(name)
          throw new Error('legacy filesystem access forbidden')
        }
        return Reflect.apply(original, nodeFs, args)
      })
    })
    try { return await operation() } finally { for (const spy of spies) spy.mockRestore() }
  }
  const first = await refusingIo(monitoredStart)
  const authority = first.controller.sharedChannels()!
  const key = h.key(alpha.name), channel = alpha.channels![0]!.id
  expect(authority.assign(key, authority.incarnation(key)!, channel, 'mentions', authority.revision).kind).toBe('applied')
  const assigned = authority.snapshot().personas[key]!.assignments[channel]
  h.writeConfig({ ...source, channel_mode: 'open' })
  await refusingIo(async () => {
    await first.ticks.tick()
    assertNoLeak(first.captured())
    await (await first.confirmPending()).applying
    expect(authority.choice(key, channel)).toBe('mentions')
    await first.stop()
  })
  // Restoring obsolete evidence after a newer durable choice cannot overwrite that choice.
  writeFileSync(legacy, legacyBytes)
  const reopened = await refusingIo(monitoredStart)
  expect(reopened.controller.sharedChannels()!.choice(key, channel)).toBe('mentions')
  expect(reopened.controller.sharedChannels()!.snapshot().personas[key]!.assignments[channel]).toEqual(assigned)
  await refusingIo(() => reopened.ticks.tick())
  expect(observedIo).toContain('openSync')
  expect(legacyIo).toEqual([])
  expect(opened).toContain(h.paths.config)
  expect(opened.filter(path => path === h.paths.lastApplied).length).toBeGreaterThanOrEqual(2)
  expect(legacyAccess).toEqual([])
  for (const run of [first, reopened]) {
    expect(run.writes.filter(write => write.path === legacy)).toEqual([])
    expect(run.removes.filter(remove => remove.path === legacy)).toEqual([])
    expect(run.slackPosts()).toEqual([])
    assertNoLeak(run.captured())
  }
  expect(readFileSync(legacy)).toEqual(legacyBytes)
})

// Reviewed damaged-start composition. The ordinary request/pending/apply owner
// is exercised through starts/ticks and real durable files, never a repair mock.
import { sharedRecoveryRequest, membershipPage, deliveryAttempt, retryAttempt } from './test-helpers/shared-channels.ts'
import { recoveryBytes, recoveryHash } from '../src/shared-recovery.ts'
import { renderSharedRecovery, sharedRecoveryLine } from '../src/reload-recovery.ts'
import { RECOVERY_CURRENT_MEMBERSHIP, RECOVERY_LOSS, RECOVERY_PRESERVATION, RECOVERY_RESTORE, RECOVERY_THREADS_FORGOTTEN } from '../src/reload-preview-clauses.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { buildReviewRequest, REVIEW_REQUEST_SUFFIX } from '../src/reload-request.ts'

const REPAIR_SLACK = { alpha: { appId: 'A0REPAIR', botUserId: 'U0REPAIR', botId: 'B0REPAIR', teamId: 'T0REPAIR' } }
async function recoveryStart(opts: ReloadRunOptions = {}) {
  const previousSession = runs.at(-1)?.session('alpha')
  const run = await h.start({ dryRun: true, ...opts }); runs.push(run)
  // Capture each preview before another start, confirmation or edit can remove it.
  expectRepairSecrecy(run)
  // Cold repair activates through startup, not live apply fan-out. A refused
  // preview/confirmation must not start any persona; an accepted one starts
  // only alpha, once. These checks also cover the preserved source regressions.
  expect(run.lifecycle.timeline).toEqual([])
  expect(run.appliedConfigs).toEqual([])
  expect(run.composition?.calls ?? []).toEqual([])
  if (run.composition) expect(stubCallCount(run.composition.agentDirector)).toBe(0)
  if (run.outcome.kind === 'refused') {
    expect(run.lifecycle.records).toEqual([])
    expect(run.lifecycle.startPasses).toEqual([])
    expect(run.slack.builds).toEqual([])
    expect(Object.values(run.slackCalls()).flat()).toEqual([])
    expect(run.session('alpha')).toBe(previousSession)
    expect(run.connections.clientFor('alpha')).toBeUndefined()
  } else {
    expect(run.appliedKeys()).toEqual([h.key('alpha')])
    expect(run.lifecycle.startPasses).toEqual([run.controller.applied()!.config])
    expect(run.lifecycle.records).toEqual([
      { op: 'bring-up', key: h.key('alpha'), via: 'start', result: expect.objectContaining({ outcome: 'up', failures: [] }) },
      { op: 'launch', key: h.key('alpha'), via: 'start' },
    ])
  }
  return run
}
/** The pending recovery preview's choice lines for alpha: only a
 * `thread_hybrid` line carries the forgotten-threads clause. */
function expectRecoveryChoiceLines(choice: 'restored' | 'new', entries: Array<[string, DeliveryMode]>) {
  const lines = h.pendingLines()!
  for (const [channel, delivery] of entries) {
    expect(lines).toContain(`persona=alpha; channel=${channel}; ${choice} choice=${delivery}` + (delivery === 'thread_hybrid' ? `; ${RECOVERY_THREADS_FORGOTTEN}` : '.'))
  }
  expect(lines.filter(line => line.includes(RECOVERY_THREADS_FORGOTTEN))).toHaveLength(entries.filter(([, delivery]) => delivery === 'thread_hybrid').length)
}
function acceptedContents(run: ReloadRun, key = 'alpha') {
  return run.queue.items(key).map(({ accepted: { attempt_high_watermark, ...content } }) => content)
}
function expectRepairSecrecy(run: ReloadRun, body?: string) {
  if (body !== undefined) repairBodies.add(body)
  const surfaces = { logs: run.logs, pending: h.readPendingText(), apply: h.readApply()?.toString(), slack: run.slackCalls() }
  // Only operator inputs are excluded. Private authority/evidence and queue files
  // remain in the credential sweep; original message bytes belong in the queue.
  assertNoLeak({ ...run.captured(), public: surfaces, server: h.serverSideFiles(
    h.paths.config, h.paths.config + REVIEW_REQUEST_SUFFIX, h.persona('alpha').credentials_file,
  ) })
  expect(run.slackPosts()).toEqual([])
  for (const original of repairBodies) expect(JSON.stringify(surfaces)).not.toContain(JSON.stringify(original).slice(1, -1))
}

test.each(['strict', 'open'] as const)('cold %s replacement retains exact evidence/input and original-key queues without granting historical attempts or membership', async channel_mode => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const prepared = h.writeConfig({ personas: [alpha], stop_hook_bootstrap: false })
  const replacement = configBytes({ personas: [alpha], channel_mode })
  const body = '  original <@U0SENDER>\r\n😀  '
  const damage = Buffer.concat([Buffer.from('{broken-authority:'), Buffer.from([0xff]), Buffer.from('}')])
  h.writeRecordBytes(damage)
  const request = sharedRecoveryRequest('cold-repair', damage, replacement)
  h.writeRequestBytes(configBytes(request))
  let run = await recoveryStart()
  expect(run.outcome.kind).toBe('refused'); expect(run.controller.sharedChannels()).toBeUndefined()
  expect(run.startDetection()).toBe(false); expect(run.appliedKeys()).toBeUndefined()
  const stage = disk()
  expect(stage.recovery?.phase).toBe('review')
  expect(recoveryBytes(stage.recovery!.evidenceBase64)).toEqual(damage)
  expect(recoveryBytes(stage.recovery!.preparedBase64)).toEqual(prepared)
  for (const text of [RECOVERY_LOSS, RECOVERY_CURRENT_MEMBERSHIP, RECOVERY_PRESERVATION]) expect(h.readPendingText()).toContain(text)
  expect(h.readConfig()).toEqual(prepared)
  await run.queue.start()
  const accepted = await run.queue.accept('alpha', slackInput({ text: body, queued_ack_reaction: 'hourglass' }))
  expect(accepted.status).toBe('accepted')
  const original = acceptedContents(run)
  expectRepairSecrecy(run, body)
  await run.stop(); h.confirm(); const confirmation = h.readApply()!
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  const authority = run.controller.sharedChannels()!, active = authority.snapshot()
  expect(active.recovery?.phase).toBe('active')
  expect(authority.sourceBytes()).toEqual(replacement); expect(h.readConfig()).toEqual(prepared)
  expect(acceptedContents(run)).toEqual(original)
  expect(run.membership.read('alpha', alpha.permission_prompts, channel_mode).kind).toBe('unresolved')
  const lost = retryAttempt(deliveryAttempt('lost-before-repair', alpha.permission_prompts, 'all'))
  const revision = authority.revision
  expect(authority.lookupBotAttempt('alpha', 'unproven-old-life', lost)?.kind).toBe('inactive')
  expect(authority.botAttempt('alpha', authority.incarnation('alpha')!, lost, () => { throw new Error('retry cannot authorize a write') }).kind).toBe('unresolved')
  expect(authority.revision).toBe(revision)
  const boundary = authority.lifetime('alpha', alpha.permission_prompts)!
  expectRepairSecrecy(run, body)
  await run.stop(); h.writeApplyBytes(confirmation)
  run = await recoveryStart()
  expect(run.outcome.kind).toBe('applied')
  expect(run.controller.sharedChannels()!.lifetime('alpha', alpha.permission_prompts)).toEqual(boundary)
  expect(Object.values(reviewLedger(disk())!.outcomes).filter(o => o.status === 'consumed')).toHaveLength(1)
  expect(acceptedContents(run)).toEqual(original)
  expect(recoveryBytes(disk().recovery!.evidenceBase64)).toEqual(damage)
  expect((await run.queue.accept('alpha', original[0]!)).status).toBe('duplicate')
})

test.each(['request', 'prepared-input', 'credentials', 'working-directory'] as const)('recovery confirmation observes %s ABA and requires a newly reviewed gesture', async changed => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] }), damage = h.writeRecordBytes('unreadable authority')
  const request = configBytes(sharedRecoveryRequest('aba-repair', damage, input))
  h.writeRequestBytes(request)
  const opts = { dryRun: false, slack: REPAIR_SLACK }
  let run = await recoveryStart(opts); expect(run.outcome.kind).toBe('refused')
  await run.stop(); h.confirm(); const stale = h.readApply()!
  const credentials = readFileSync(alpha.credentials_file)
  const restoreCredentials = h.saveCredentials(alpha)
  const work = alpha.working_directory
  if (changed === 'request') h.writeRequestBytes(configBytes({ ...JSON.parse(request.toString()), request_id: 'changed-repair' }))
  if (changed === 'prepared-input') h.writeConfig({ personas: [alpha], stop_hook_bootstrap: false })
  if (changed === 'credentials') writeFileSync(alpha.credentials_file, Buffer.concat([credentials, Buffer.from('\n')]))
  if (changed === 'working-directory') { nodeFs.renameSync(work, work + '-held'); nodeFs.symlinkSync(work + '-held', work) }
  run = await recoveryStart(opts); expect(run.outcome.kind).toBe('refused'); expect(run.controller.sharedChannels()).toBeUndefined(); await run.stop()
  h.writeRequestBytes(request); h.writeConfigBytes(input); restoreCredentials()
  if (changed === 'working-directory') { nodeFs.unlinkSync(work); nodeFs.renameSync(work + '-held', work) }
  run = await recoveryStart(opts); expect(run.outcome.kind).toBe('refused')
  expect(h.readPending()).not.toEqual(stale); expect(disk().recovery?.phase).toBe('review')
  expect(recoveryBytes(disk().recovery!.preparedBase64)).toEqual(input)
  if (changed === 'request') {
    // A valid new request is now a durable revision, so returning to the old
    // reserved ID cannot revive it. Confirm only the retained current request.
    expect(disk().recovery!.request.request_id).toBe('changed-repair')
    expect(disk().recovery!.supersededRequestIds).toContain('aba-repair')
    await run.stop(); h.writeRequestBytes(configBytes(disk().recovery!.request))
    run = await recoveryStart(opts); expect(run.outcome.kind).toBe('refused')
    expect(h.readPending()).not.toEqual(stale)
  }
  await run.stop(); h.confirm()
  run = await recoveryStart(opts); expect(run.outcome.kind).toBe('applied')
  expect(Object.values(reviewLedger(disk())!.outcomes).filter(o => o.status === 'consumed')).toHaveLength(1)
})

test.each(['before-rename', 'installed-unsynced'] as const)('repair interruption %s recovers exactly one activation with one Thread Hybrid Since and preserves accepted work', async boundary => {
  const alpha = threaded('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] }), damage = h.writeRecordBytes('damaged input')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('interrupted-repair', damage, input)))
  let run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expectRecoveryChoiceLines('new', [[alpha.permission_prompts, 'all'], [THREAD, 'thread_hybrid']])
  // A stage in review decides no stamp, whatever Thread Hybrid Since it holds.
  const stageStamp = () => createSharedChannelAuthority(h.paths.lastApplied, disk(), { write: () => { throw new Error('read only') } }).channelStamp('alpha', THREAD)
  const staged = sinceOf(disk())
  expect(staged).toEqual(expect.any(String)); expect(stageStamp()).toEqual({ kind: 'undecided' })
  await run.queue.start()
  expect((await run.queue.accept('alpha', slackInput({ text: '  original\r\n😀 ', queued_ack_reaction: 'hourglass' }))).status).toBe('accepted')
  const original = acceptedContents(run)
  expectRepairSecrecy(run, original[0]!.text)
  await run.stop(); h.confirm(); const confirmation = h.readApply()!; let armed = true
  let attempted: string | undefined
  run = await recoveryStart({ beforeWrite: (path, bytes) => {
    const state = path === h.paths.lastApplied ? parseSharedChannelState(bytes, path) : undefined
    if (!armed || state?.recovery?.phase !== 'active') return
    armed = false
    attempted = sinceOf(state)
    h.failWrites(boundary === 'before-rename' ? { step: 'writeSync', call: 1, code: 'ENOSPC' } : { step: 'fsyncSync', call: 2, code: 'EIO' })
  } })
  expect(attempted).toEqual(expect.any(String)); expect(attempted).not.toBe(staged)
  expect(sinceOf(disk())).toBe(boundary === 'before-rename' ? staged : attempted)
  if (boundary === 'before-rename') expect(stageStamp()).toEqual({ kind: 'undecided' })
  expect(armed).toBe(false); expect(run.outcome.kind).toBe('refused')
  expect(run.controller.sharedChannels()).toBeUndefined(); expect(run.appliedConfigs).toEqual([])
  expect(h.readConfig()).toEqual(input)
  if (boundary === 'installed-unsynced') {
    expect(run.logs.filter(line => line.startsWith(sharedRecoveryLine('durability unresolved')))).toHaveLength(1)
    expect(run.logs.join('\n')).not.toContain('confirmation not activated')
    expect(run.outcome.kind === 'refused' && run.outcome.line).toContain('recover the retained outcome before any new review')
    expect(h.readApply()).toEqual(confirmation)
    expect(run.writes.filter(write => write.path === h.paths.pending)).toEqual([])
    expect(disk().recovery?.phase).toBe('active')
  } else {
    expect(run.logs.filter(line => line.startsWith(sharedRecoveryLine('confirmation not activated')))).toHaveLength(1)
    expect(disk().recovery?.phase).toBe('review')
  }
  await run.stop(); h.clearWriteFailure()
  run = await recoveryStart(); expect(run.outcome.kind).toBe(boundary === 'before-rename' ? 'refused' : 'applied')
  if (boundary === 'before-rename') {
    expect(sinceOf(disk())).toBe(staged); expect(stageStamp()).toEqual({ kind: 'undecided' })
  } else {
    expect(run.controller.sharedChannels()!.channelStamp('alpha', THREAD)).toEqual({ kind: 'decided', incarnation: disk().personas.alpha!.incarnation, threadHybridSince: attempted })
  }
  await run.queue.start(); expect(acceptedContents(run)).toEqual(original)
  await run.stop(); if (boundary === 'before-rename') h.confirm()
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  // The retained activation is not applied again, so its Thread Hybrid Since stays.
  const final = sinceOf(disk())
  if (boundary === 'installed-unsynced') expect(final).toBe(attempted)
  else { expect(final).toEqual(expect.any(String)); expect(final).not.toBe(staged) }
  expect(run.controller.sharedChannels()!.channelStamp('alpha', THREAD)).toEqual({ kind: 'decided', incarnation: disk().personas.alpha!.incarnation, threadHybridSince: final })
  const retained = run.logs.filter(line => line.startsWith(sharedRecoveryLine('retained repair activation')))
  expect(retained).toHaveLength(1)
  expect(retained[0]).toContain(`order=${disk().recovery!.activation!.order}; it is not applied again`)
  expect(retained[0]).toContain('Current authenticated membership is still required')
  expect(Object.values(reviewLedger(disk())!.outcomes).filter(o => o.status === 'consumed')).toHaveLength(1)
  expect(recoveryBytes(disk().recovery!.evidenceBase64)).toEqual(damage)
  expect(acceptedContents(run)).toEqual(original)
  const preparation = createDeliveryPreparation({ queue: run.queue, clientFor: () => undefined, resolveUserName: async (_key, user) => user })
  await preparation.recover(); await preparation.stop()
  const fixed = run.queue.items('alpha')[0]!.fixed!.parts
  const engine = await makeEngineHarness({ stateDir: h.stateDir, queue: run.queue, keys: ['alpha'] }); engines.push(engine)
  engine.p('alpha').row.state = 'waiting'; await engine.tick('alpha')
  await engine.until(() => run.queue.openCount('alpha') === 0)
  expect(engine.textCalls('alpha').map(c => c.params.text)).toEqual(fixed)
  expect(engine.events.filter(e => e.type === 'item-delivered')).toHaveLength(1)
  expect(run.membership.read('alpha', alpha.permission_prompts, 'strict').kind).toBe('unresolved')
})

test.each(['readable', 'invalid', 'absent', 'unparsable'] as const)('explicit replacement from unreadable evidence whose marker is %s keeps only a marker the evidence proves, through revision, minting Thread Hybrid Since at activation', async marker => {
  const alpha = threaded('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] })
  const first = await start(); const authority = first.controller.sharedChannels()!
  if (marker !== 'absent') expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  const prior = authority.snapshot()
  await first.stop()
  // Damage the envelope; the marker field stays as production wrote it, or is
  // made invalid, or the whole file stops being JSON.
  const raw = JSON.parse(readFileSync(h.paths.lastApplied, 'utf8'))
  raw.revision = 0
  if (marker === 'invalid') raw.threadMemoryCreated = { alpha: false }
  const damage = h.writeRecordBytes(marker === 'unparsable' ? 'plain-text damage over a marked shared state' : configBytes(raw))
  expect(() => parseSharedChannelState(damage, h.paths.lastApplied)).toThrow()
  const kept: Record<string, true> | undefined = marker === 'readable' ? { alpha: true } : undefined
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('marker-replacement', damage, input)))
  let run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expect(disk().threadMemoryCreated).toEqual(kept)
  await run.stop()
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('marker-revised', damage, configBytes({ personas: [alpha], channel_mode: 'open' }))))
  run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  const stage = disk()
  expect(stage.recovery!.request.request_id).toBe('marker-revised')
  expect(stage.threadMemoryCreated).toEqual(kept)
  expectRecoveryChoiceLines('new', [[alpha.permission_prompts, 'all'], [THREAD, 'thread_hybrid']])
  await run.stop(); h.confirm()
  let activation: SharedChannelState | undefined
  run = await recoveryStart({ beforeWrite: (path, bytes) => {
    const state = path === h.paths.lastApplied ? parseSharedChannelState(bytes, path) : undefined
    if (state?.recovery?.phase === 'active') activation ??= state
  } })
  expect(run.outcome.kind).toBe('applied')
  const active = run.controller.sharedChannels()!, state = active.snapshot()
  expect(active.threadMemoryCreated('alpha')).toBe(marker === 'readable')
  expect(state.threadMemoryCreated).toEqual(kept)
  expect(state.personas.alpha!.incarnation).not.toBe(prior.personas.alpha!.incarnation)
  const minted = sinceOf(state)
  expect(minted).toEqual(expect.any(String))
  expect([sinceOf(prior), sinceOf(stage)]).not.toContain(minted)
  expect(sinceOf(activation!)).toBe(minted)
  expect(active.channelStamp('alpha', THREAD)).toEqual({ kind: 'decided', incarnation: state.personas.alpha!.incarnation, threadHybridSince: minted })
})

test('owned restoration retains actual MCP history, separately pending intent and the marker, starting a new Thread Hybrid Since; known-not-applied retries stay nonwriting after repair', async () => {
  const alpha = threaded('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha], channel_mode: 'open' })
  let run = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK })
  const channel = alpha.permission_prompts
  run.stub('alpha').script.inventory.push(membershipPage([channel, THREAD])); await run.membershipClock.runNext()
  run.registerSession('alpha')
  const attempt = deliveryAttempt('retained-success', channel, 'all')
  expect((await run.callTool('alpha', 'set_channel_delivery', attempt)).isError).toBe(false)
  const failed = deliveryAttempt('retained-rejection', 'C0ABSENT', 'all')
  expect((await run.callTool('alpha', 'set_channel_delivery', failed)).isError).toBe(true)
  const session = run.session('alpha')!, client = run.connections.clientFor('alpha'), socket = run.stub('alpha').socket
  expect(session.connected).toBe(true); expect(socket.connected).toBe(true); expect(client).toBeDefined()
  const live = run
  const snapshot = () => ({
    cp: live.checkpoint(), timeline: live.lifecycle.timeline.length,
    calls: live.composition!.calls.length, adCalls: stubCallCount(live.composition!.agentDirector),
    applied: live.controller.applied(), config: structuredClone(live.serverConfig()),
    sockets: live.stub('alpha').sockets.map(s => ({ starts: s.startCalls, disconnects: s.disconnectCalls })),
  })
  const expectNoLiveEffects = (before: ReturnType<typeof snapshot>) => {
    expect(live.since(before.cp).lifecycle).toEqual([])
    expect(live.lifecycle.timeline.slice(before.timeline)).toEqual([])
    expect(live.composition!.calls.slice(before.calls)).toEqual([])
    expect(stubCallCount(live.composition!.agentDirector)).toBe(before.adCalls)
    expect(live.since(before.cp).slackBuilds).toBe(0); expect(live.since(before.cp).slackCalls).toEqual([])
    expect(live.controller.applied()).toBe(before.applied); expect(live.serverConfig()).toEqual(before.config)
    expect(live.session('alpha')).toBe(session); expect(session.connected).toBe(true)
    expect(live.connections.clientFor('alpha')).toBe(client); expect(live.stub('alpha').socket).toBe(socket)
    expect(socket.connected).toBe(true)
    expect(live.stub('alpha').sockets.map(s => ({ starts: s.startCalls, disconnects: s.disconnectCalls }))).toEqual(before.sockets)
  }
  const detection = snapshot()
  run.request('request', [], 'separate-pending-intent'); await run.ticks.tick()
  expectRepairSecrecy(run); expectNoLiveEffects(detection)
  const authority = run.controller.sharedChannels()!
  expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
  const prior = authority.snapshot(), input = h.readConfig()!, anchorSince = sinceOf(prior)
  expect(anchorSince).toEqual(expect.any(String))
  const damage = h.writeRecordBytes('damaged while owner retains its validated state')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('owned-restoration', damage)))
  const staging = snapshot()
  await run.ticks.tick()
  expectRepairSecrecy(run); expectNoLiveEffects(staging)
  expect(authority.readable).toBe(false); expect(authority.readableFor('alpha', channel)).toBe(true)
  expect(authority.snapshot()).toEqual(prior)
  expect(recoveryBytes(disk().recovery!.anchorBase64)).toEqual(Buffer.from(serializeSharedChannelState(prior)))
  await run.stop(); run = await recoveryStart({ dryRun: false, slack: REPAIR_SLACK }); expect(run.outcome.kind).toBe('refused')
  expect(h.readPendingText()).toContain(RECOVERY_RESTORE)
  expectRecoveryChoiceLines('restored', [[channel, 'all'], [THREAD, 'thread_hybrid']])
  expect(sinceOf(disk())).toBe(anchorSince)
  await run.stop(); h.confirm()
  let activation: SharedChannelState | undefined
  run = await recoveryStart({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK, beforeWrite: (path, bytes) => {
    const state = path === h.paths.lastApplied ? parseSharedChannelState(bytes, path) : undefined
    if (state?.recovery?.phase === 'active') activation ??= state
  } })
  expect(run.outcome.kind).toBe('applied')
  const restored = run.controller.sharedChannels()!
  // Only the thread_hybrid entry's Thread Hybrid Since differs from the
  // anchor, minted in the activation's own write; the marker is kept.
  const restoredSince = sinceOf(restored.snapshot())
  expect(restoredSince).toEqual(expect.any(String)); expect(restoredSince).not.toBe(anchorSince)
  expect(sinceOf(activation!)).toBe(restoredSince)
  const expected = structuredClone(prior.personas)
  expected.alpha!.assignments[THREAD]!.threadHybridSince = restoredSince
  expect(restored.snapshot().personas).toEqual(expected)
  expect(restored.snapshot().threadMemoryCreated).toEqual({ alpha: true })
  expect(restored.snapshot().outcomes.botAttempts).toEqual(prior.outcomes.botAttempts)
  expect(restored.operatorIntent()).toEqual(authority.operatorIntent()); expect(h.readConfig()).toEqual(input)
  expect(run.membership.read('alpha', channel, 'open').kind).toBe('unresolved')
  run.registerSession('alpha'); const revision = restored.revision
  expect((await run.callTool('alpha', 'set_channel_delivery', retryAttempt(attempt))).isError).toBe(false)
  expect((await run.callTool('alpha', 'set_channel_delivery', retryAttempt(failed))).isError).toBe(true)
  expect(restored.revision).toBe(revision)
  expect(restored.snapshot().outcomes.botAttempts).toEqual(prior.outcomes.botAttempts)
})

test('a cold restore request cannot import an absent owner anchor or reinterpret prepared config as authority', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] }), damage = h.writeRecordBytes('no trusted anchor')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('cold-restore', damage)))
  const run = await recoveryStart()
  expect(run.outcome.kind).toBe('refused'); expect(run.controller.sharedChannels()).toBeUndefined()
  expect(h.readRecord()).toEqual(damage); expect(h.readConfig()).toEqual(input); expect(h.readPending()).toBeUndefined()
  expect(run.logs.join('\n')).toContain(recoveryHash(damage))
  expect(run.logs.join('\n')).toContain(RECOVERY_PRESERVATION)
})

test('real staged recovery renders bounded facts and rejects derived malformed durable evidence without exposing damaged content', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const prepared = h.writeConfig({ personas: [alpha] })
  const damage = h.writeRecordBytes(sentinelInMessage('damaged recovery evidence'))
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('render-repair', damage, prepared)))
  const run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  const stage = disk(), rendered = renderSharedRecovery(stage)
  expect(rendered).toContain(RECOVERY_LOSS)
  expect(rendered).toContain(RECOVERY_CURRENT_MEMBERSHIP)
  expect(rendered).toContain(RECOVERY_PRESERVATION)
  expect(rendered).not.toContain(RECOVERY_RESTORE)
  expect(rendered).toContain(`channel=${alpha.permission_prompts}; new choice=all`)
  assertNoLeak({ rendered, logs: run.logs, pending: h.readPendingText() })
  expectRepairSecrecy(run, damage.toString())
  const changes: Array<(record: Record<string, any>) => void> = [
    record => { record.recovery.evidenceBase64 = Buffer.from('other evidence').toString('base64') },
    record => { record.recovery.preparedBase64 += '\n' },
    record => { record.recovery.anchorBase64 = prepared.toString('base64') },
    record => { record.recovery.boundary = '../unvalidated' },
    record => { record.recovery.activation = { fingerprint: '0'.repeat(64), order: record.revision } },
    record => { record.recovery.phase = 'active' },
    record => { record.recovery.snapshot = {} },
    record => { record.recovery.cancelled = true },
    record => { record.recovery.supersededRequestIds = [record.recovery.request.request_id] },
    record => { record.recovery.supersededRequestIds = ['reserved-id', 'reserved-id'] },
  ]
  for (const change of changes) {
    const invalid = structuredClone(stage); change(invalid)
    expect(() => parseSharedChannelState(configBytes(invalid), h.paths.lastApplied)).toThrow()
  }
  expect(disk()).toEqual(stage); expect(h.readConfig()).toEqual(prepared)
})

test.each((['strict', 'open'] as const).flatMap(mode => (['none', 'before-rename', 'installed-unsynced'] as const).map(fault => [mode, fault] as const)))(
  '%s durable later leave supersedes held obligations and clears Thread Hybrid Since through %s and rejects delayed old consumers after reopen/rejoin', async (mode, fault) => {
  const base = h.persona('alpha')
  const alpha = { ...base, channels: [{ id: base.permission_prompts, delivery: 'thread_hybrid' as const }] }
  h.materialize(alpha); h.writeConfig({ personas: [alpha], channel_mode: mode })
  const opts = { dryRun: false, realLifecycle: true, slack: REPAIR_SLACK }
  let run = await start(opts), authority = run.controller.sharedChannels()!
  const channel = alpha.permission_prompts, sibling = 'C0SIBLING'
  run.stub('alpha').script.inventory.push(membershipPage([channel, sibling])); await run.membershipClock.runNext()
  const origin = run.membershipClock.now()
  const send = (type: string, id: string, offset: number) => run.stub('alpha').socket.deliver({ type, channel,
    user: run.stub('alpha').identity.botUserId, event_ts: ((origin + offset) / 1000).toFixed(3) }, { event_id: id })
  const old = authority.lifetime('alpha', channel)!, unaffected = authority.lifetime('alpha', sibling)!
  expectCurrent(authority, old)
  // A delayed consumer uses the real durable token, and rechecks AFTER await.
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const delayed = (async () => { await wait; return holdsLifetime(authority, old) })()
  try {
    await send('member_joined_channel', 'EvCONTRADICTORY', 10)
    await send('channel_left', 'EvCONTRADICTORY', 10)
    const conflict = Object.values(authority.snapshot().personas.alpha!.membershipEvidence!).find(e => e.originalEvent)!
    expect(conflict.state).toBe('conflict')
    expect(run.membership.read('alpha', channel, mode).kind).toBe('unresolved')
    expect(run.membership.read('alpha', sibling, mode).kind).toBe('eligible')
    const entry = authority.snapshot().personas.alpha!.assignments[channel]!, incarnation = authority.incarnation('alpha')!
    expect(entry.threadHybridSince).toEqual(expect.any(String))
    if (fault !== 'none') h.failWrites(fault === 'before-rename' ? { step: 'writeSync', code: 'ENOSPC' } : { step: 'fsyncSync', call: 2, code: 'EIO' })
    const acks = run.stub('alpha').socket.acks.length
    await send('channel_left', 'EvPROVENLATER', 20)
    if (fault !== 'none') {
      expect(run.stub('alpha').socket.acks).toHaveLength(acks)
      expect(run.membership.read('alpha', channel, mode).kind).toBe('unresolved')
      expectCurrent(authority, unaffected)
      // An unsynced removal leaves the channel unreadable, so its old lifetime is not current.
      if (fault === 'installed-unsynced') expect(authority.readableFor('alpha', channel)).toBe(false)
      else expectCurrent(authority, old)
      // The removal's own write carries the cleared field: the disk keeps the
      // old entry with its Thread Hybrid Since, or has neither.
      const onDisk = disk().personas.alpha!.assignments
      expect(Object.hasOwn(onDisk, channel)).toBe(fault === 'before-rename')
      if (fault === 'before-rename') expect(onDisk[channel]).toEqual(entry)
      expect(authority.channelStamp('alpha', channel)).toEqual(fault === 'before-rename'
        ? { kind: 'decided', incarnation, threadHybridSince: entry.threadHybridSince } : { kind: 'undecided' })
      h.clearWriteFailure()
      if (fault === 'before-rename') await send('channel_left', 'EvPROVENLATER', 20)
      else { expect(authority.recoverDurability().kind).toBe('applied'); expect(run.membership.recover('alpha')).toBe(true) }
    }
    expect(authority.choice('alpha', channel)).toBeUndefined()
    expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'decided', incarnation })
    expect(disk().personas.alpha!.assignments[channel]).toBeUndefined()
    expectSuperseded(authority, old)
    expectCurrent(authority, unaffected)
    expect(authority.snapshot().personas.alpha!.membershipEvidence![conflict.event]!.state).toBe('superseded')
    const removed = authority.lifetime('alpha', channel)!
    await run.stop(); run = await start(opts); authority = run.controller.sharedChannels()!
    expectSuperseded(authority, old); expectCurrent(authority, removed)
    expect(run.membership.read('alpha', channel, mode).kind).toBe('unresolved')
    await send('channel_left', 'EvCONTRADICTORY', 10)
    expect(run.membership.hasUnresolved('alpha', channel)).toBe(false)
    await send('member_joined_channel', 'EvFRESHJOIN', 30)
    const fresh = authority.lifetime('alpha', channel)!
    expect(authority.choice('alpha', channel)).toBe(mode === 'open' ? 'mentions' : 'off')
    expect(disk().personas.alpha!.assignments[channel]).not.toHaveProperty('threadHybridSince')
    expectSuperseded(authority, removed)
    release(); expect(await delayed).toBe(false)
    expectCurrent(authority, fresh)
    for (const [id, offset] of [['EvCONTRADICTORY', 10], ['EvPROVENLATER', 20]] as const) await send('channel_left', id, offset)
    expect(authority.lifetime('alpha', channel)).toEqual(fresh)
    expect(authority.choice('alpha', channel)).toBe(mode === 'open' ? 'mentions' : 'off')
    expect(run.membership.read('alpha', channel, mode).kind).toBe('unresolved')
    run.stub('alpha').script.inventory.push(membershipPage([channel, sibling])); await run.membershipClock.runNext()
    expect(run.membership.read('alpha', channel, mode).kind).toBe('eligible')
  } finally { release(); await delayed }
})

test.each(['strict', 'open'] as const)('%s real last-channel leave retains disabled-DM destination through restart and unrelated review without ordinary-tool authority resurrection', async channel_mode => {
  const alpha = h.persona('alpha', { dm: { enabled: false } }); h.materialize(alpha); h.writeConfig({ personas: [alpha], channel_mode })
  const opts = { dryRun: false, realLifecycle: true, slack: REPAIR_SLACK }
  let run = await start(opts)
  const channel = alpha.permission_prompts
  run.stub('alpha').script.inventory.push(membershipPage([channel])); await run.membershipClock.runNext()
  const authority = run.controller.sharedChannels()!, incarnation = authority.incarnation('alpha')
  expect(run.membership.read('alpha', channel, channel_mode).kind).toBe('eligible')
  await run.stub('alpha').socket.deliver({ type: 'channel_left', channel,
    event_ts: ((run.membershipClock.now() + 1) / 1000).toFixed(3) }, { event_id: 'EvFINALDESTINATION' })
  expect(run.stub('alpha').socket.acks).toHaveLength(1)
  expect(authority.config().personas[0]!.channels).toEqual([])
  expect(authority.validatesRemovedDestination(authority.config().personas[0]!)).toBe(true)
  await run.stop(); run = await start(opts)
  expect(run.controller.sharedChannels()!.incarnation('alpha')).toBe(incarnation)
  const bytes = h.writeConfig({ channel_mode, personas: [{ ...alpha, channels: [], stop_hook_bootstrap: false }] })
  const session = run.registerSession('alpha'), socket = run.stub('alpha').socket, client = run.connections.clientFor('alpha')
  const reminderErrors: unknown[] = [], prepared: number[] = []
  const reminder = createReplyReminders({
    queue: run.queue, clock: run.clock, getRow: async () => undefined, ready: () => run.isUp('alpha'),
    enabled: key => run.serverConfig()!.personas.find(p => p.key === key)?.stop_hook_bootstrap === true,
    prepare: async (_key, item) => { prepared.push(item.accepted.seq) }, onError: (_key, error) => { reminderErrors.push(error) },
  })
  reminders.push(reminder)
  const row = cannedGetResult({ state: 'working', labels: Object.fromEntries([REPLY_TOOL_PREALLOWED_LABEL.split('=')]) }, run.serverConfig()!.personas[0]!, h.root)
  const accepted = await run.queue.accept('alpha', slackInput({ text: 'accepted before zero-entry opt-out' }))
  expect(accepted.status).toBe('accepted')
  if (accepted.status !== 'accepted') throw new Error('reminder fixture acceptance failed')
  await run.queue.append('alpha', { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['accepted before zero-entry opt-out'] })
  await run.queue.append('alpha', { ...sentRecord(accepted.seq), at: run.clock.now(), session_id: row.session_id })
  await run.queue.append('alpha', deliveredRecord(accepted.seq, run.clock.now()))
  await reminder.observe('alpha', row)
  expect(run.queue.replyReminderItems('alpha')).toEqual([expect.objectContaining({ seq: accepted.seq, state: 'observed', row_state: 'working' })])
  const cp = run.checkpoint(), timeline = run.lifecycle.timeline.length
  const composition = run.composition!, calls = composition.calls.length, adCalls = stubCallCount(composition.agentDirector)
  const sockets = () => run.stub('alpha').sockets.map(s => ({ starts: s.startCalls, disconnects: s.disconnectCalls }))
  const beforeSockets = sockets()
  const expectKeptConnections = () => {
    expect(composition.calls.slice(calls)).toEqual([])
    expect(stubCallCount(composition.agentDirector)).toBe(adCalls)
    expect(run.since(cp).slackBuilds).toBe(0); expect(run.since(cp).slackCalls).toEqual([])
    expect(run.session('alpha')).toBe(session); expect(session.connected).toBe(true)
    expect(run.connections.clientFor('alpha')).toBe(client); expect(run.stub('alpha').socket).toBe(socket)
    expect(sockets()).toEqual(beforeSockets)
  }
  await run.ticks.tick(); expectRepairSecrecy(run)
  expect(h.pendingExists()).toBe(true)
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.lifecycle.timeline.slice(timeline)).toEqual([])
  expectKeptConnections()
  h.confirm(); await run.ticks.tick(); expectRepairSecrecy(run)
  expect(run.since(cp).lifecycle).toEqual([{ op: 'update-in-place', key: h.key('alpha'), via: 'apply', settings: ['stop_hook_bootstrap'] }])
  expect(run.lifecycle.timeline.slice(timeline)).toEqual([
    { op: 'update-in-place', key: h.key('alpha'), phase: 'start' },
    { op: 'update-in-place', key: h.key('alpha'), phase: 'settled' },
  ])
  expectKeptConnections()
  const current = run.controller.sharedChannels()!, persona = current.config().personas[0]!
  expect(persona.channels).toEqual([]); expect(persona.dm.enabled).toBe(false)
  expect(persona.permission_prompts).toBe(channel); expect(persona.stop_hook_bootstrap).toBe(false)
  expect(current.incarnation('alpha')).toBe(incarnation); expect(h.readConfig()).toEqual(bytes)
  await reminder.observe('alpha', { ...row, state: 'waiting' })
  expect(run.queue.replyReminderItems('alpha')).toEqual([])
  expect(run.queue.items('alpha').filter(item => item.accepted.reminder_for !== undefined)).toEqual([])
  expect(prepared).toEqual([]); expect(reminderErrors).toEqual([])
  assertNoLeak(reminderErrors)
  expectKeptConnections()
  const result = await run.callTool('alpha', 'fetch_messages', { channel, limit: 1 })
  expect(result.isError).toBe(channel_mode === 'strict')
  expect(run.stub('alpha').calls.conversationsHistory).toHaveLength(channel_mode === 'strict' ? 0 : 1)
  expect(current.choice('alpha', channel)).toBeUndefined()
})

// Source-review regressions: retain these expectations until Main coordinates
// the source repair. A staged repair must remain reviewable/cancellable.
test('a revised cold replacement replaces the inert review and permanently revokes the earlier confirmation', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] }), damage = h.writeRecordBytes('authority unavailable')
  const first = configBytes(sharedRecoveryRequest('initial-replacement', damage, input))
  h.writeRequestBytes(first)
  let run = await recoveryStart(); expect(run.outcome.kind).toBe('refused'); await run.stop()
  h.confirm(); const obsolete = h.readApply()!
  const replacement = configBytes({ personas: [alpha], channel_mode: 'open', stop_hook_bootstrap: false })
  const revised = sharedRecoveryRequest('revised-replacement', damage, replacement)
  h.writeRequestBytes(configBytes(revised))
  run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expect(disk().recovery!.request).toEqual(revised)
  expect(h.readPending()).not.toEqual(obsolete)
  expect(recoveryBytes(disk().recovery!.evidenceBase64)).toEqual(damage)
  expect(h.readConfig()).toEqual(input)
  await run.stop(); h.confirm()
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  expect(run.controller.sharedChannels()!.sourceBytes()).toEqual(replacement)
  await run.stop(); h.writeRequestBytes(first); h.writeApplyBytes(obsolete)
  run = await recoveryStart(); expect(run.outcome.kind).toBe('applied')
  expect(run.controller.sharedChannels()!.sourceBytes()).toEqual(replacement)
})

test('ordinary cancellation of a staged cold replacement survives restart and permanently invalidates its old confirmation', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha], stop_hook_bootstrap: false })
  const damage = h.writeRecordBytes(Buffer.concat([Buffer.from('damaged authority'), Buffer.from([0xff])]))
  const request = configBytes(sharedRecoveryRequest('cancelled-replacement', damage, input))
  h.writeRequestBytes(request)
  let run = await recoveryStart(); expect(run.outcome.kind).toBe('refused'); await run.stop()
  h.confirm(); const obsolete = h.readApply()!
  const cancel = buildReviewRequest('cancel-staged-replacement', 0, 'cancel')
  h.writeRequestBytes(configBytes(cancel))
  run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expect(run.controller.sharedChannels()).toBeUndefined()
  expect(disk().recovery?.phase).toBe('review')
  expect(recoveryBytes(disk().recovery!.evidenceBase64)).toEqual(damage)
  expect(recoveryBytes(disk().recovery!.preparedBase64)).toEqual(input)
  expect(h.readConfig()).toEqual(input)
  await run.stop()
  // A repeated original request and its exact old gesture cannot resurrect a
  // cancelled proposal, even in a new owner after a refused-start boundary.
  h.writeRequestBytes(request); h.writeApplyBytes(obsolete)
  run = await recoveryStart(); expect(run.outcome.kind).toBe('refused')
  expect(run.controller.sharedChannels()).toBeUndefined()
  expect(disk().recovery?.phase).toBe('review')
  expect(recoveryBytes(disk().recovery!.evidenceBase64)).toEqual(damage)
  expect(recoveryBytes(disk().recovery!.preparedBase64)).toEqual(input)
  expect(h.readConfig()).toEqual(input)
  const cancelled = disk()
  expect(cancelled.pendingIntent).toMatchObject({ operator: { generation: 1, requested: false, requests: {
    [cancel.request_id]: { request: cancel, generation: 1 },
  } } })
})

test('installed repair with failed directory sync reports uncertainty rather than definitely not activated before restart accepts it', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  const input = h.writeConfig({ personas: [alpha] }), damage = h.writeRecordBytes('authority unavailable')
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('uncertain-activation', damage, input)))
  let run = await recoveryStart(); expect(run.outcome.kind).toBe('refused'); await run.stop(); h.confirm()
  let armed = true
  run = await recoveryStart({ beforeWrite: (path, bytes) => {
    if (path === h.paths.lastApplied && armed && parseSharedChannelState(bytes, path)?.recovery?.phase === 'active') {
      armed = false; h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } })
  expect(armed).toBe(false); expect(run.outcome.kind).toBe('refused')
  expect(disk().recovery?.phase).toBe('active')
  const diagnostics = [...run.logs]
  await run.stop(); h.clearWriteFailure(); run = await recoveryStart()
  expect(run.outcome.kind).toBe('applied')
  expect(diagnostics.join('\n')).not.toContain('confirmation not activated')
  expect(diagnostics.join('\n')).toMatch(/durability unresolved|installed[^\n]*unresolved|activation[^\n]*uncertain/i)
})

// t2.yiv.sf.in (SR-8.9): scan record retention inside durable applications and at startup.
const RETAINED = [C.primary, C.secondary, C.private]
/** alpha in open mode with RETAINED listed, its Notice Destination C.primary. */
function retentionConfig() {
  const alpha = h.persona('alpha', { channels: RETAINED.map(id => ({ id, delivery: 'all' })), permission_prompts: C.primary, dm: { enabled: true, contact: 'U0OPERATOR' } })
  h.materialize(alpha); h.writeConfig({ channel_mode: 'open', personas: [alpha] })
}
/** A complete reconciliation of alpha listing `channels`, through the run's production scanner. */
async function reconcileAlpha(run: ReloadRun, channels: string[]) {
  run.stub('alpha').script.inventory.push(membershipPage(channels))
  run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
}
/** Each channel's newest membership-history record. */
function newestRecords(state: SharedChannelState, channels = RETAINED) {
  const events = Object.entries(state.personas.alpha!.membershipEvents)
  return channels.map(channel => events.filter(([, event]) => event.channel === channel).sort(([, a], [, b]) => b.order - a.order)[0]?.[0])
}
/** Each channel's scan records, oldest first. */
function scanRecordsOf(state: SharedChannelState, channel: string) {
  return Object.entries(state.personas.alpha!.membershipEvents).filter(([id, event]) => id.startsWith('scan:') && event.channel === channel)
    .sort(([, a], [, b]) => a.order - b.order).map(([id]) => id)
}

test.each([
  ['before the rename', { step: 'renameSync' }],
  ['after the rename', { step: 'openSync', call: 2 }],
  ['at the directory sync', { step: 'fsyncSync', call: 2 }],
] as const)('a page application dropping superseded repeats, interrupted %s, reopens readable with that side\'s newest records and reconciles again', async (_at, failure) => {
  retentionConfig()
  let armed = false, attempted: SharedChannelState | undefined
  const run = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK, beforeWrite(path, bytes) {
    if (!armed || path !== h.paths.lastApplied) return
    armed = false; attempted = parseSharedChannelState(bytes, path); h.failWrites(failure)
  } })
  for (let i = 0; i < 2; i++) { await reconcileAlpha(run, RETAINED); expect(run.membershipScanner.status('alpha').state).toBe('complete') }
  const saved = disk(), second = newestRecords(saved)
  armed = true
  await reconcileAlpha(run, RETAINED)
  h.clearWriteFailure()
  expect(run.membershipScanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  // The interrupted write is the page's: its repeats supersede the second
  // reconciliation's, which it drops in the same whole-state write.
  const third = newestRecords(attempted!)
  expect(third.map((id, i) => [id === second[i], id!.startsWith('scan:'), Object.hasOwn(attempted!.personas.alpha!.membershipEvents, second[i]!)]))
    .toEqual(RETAINED.map(() => [false, true, false]))
  const before = failure.step === 'renameSync'
  expect(run.controller.sharedChannels()!.readable).toBe(before)
  const side = before ? saved : attempted!
  expect(disk()).toEqual(side)
  await run.stop()
  const reopened = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK })
  const authority = reopened.controller.sharedChannels()!
  expect([authority.readable, authority.snapshot()]).toEqual([true, side])
  // Readability cannot show it (SR-3.5): each channel keeps that side's newest record.
  expect(newestRecords(authority.snapshot())).toEqual(before ? second : third)
  for (const channel of RETAINED) expect(scanRecordsOf(side, channel)).toHaveLength(2)
  await reconcileAlpha(reopened, RETAINED)
  expect(reopened.membershipScanner.status('alpha').state).toBe('complete')
  const next = authority.snapshot()
  for (const [i, channel] of RETAINED.entries()) {
    expect(scanRecordsOf(next, channel)).toEqual([scanRecordsOf(side, channel)[0], newestRecords(next)[i]])
    expect(reopened.membership.read('alpha', channel, 'open').kind).toBe('eligible')
  }
  expect(newestRecords(next).filter((id, i) => id === newestRecords(side)[i])).toEqual([])
})

test('a history saved before SR-3.5 reads with no report and a dry-run start keeps its bytes; the first reconciliation drops its superseded repeats and decides as on the saved history', async () => {
  retentionConfig()
  const first = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK })
  await reconcileAlpha(first, RETAINED)
  // A live leave of the Notice Destination, then the pre-rule reconciliations repeat its absence.
  const leave = { type: 'channel_left', channel: C.primary, channel_type: 'C', event_ts: ((first.membershipClock.now() + 1) / 1000).toFixed(3) }
  await first.deliver('alpha', leave, { event_id: 'EvPRERULELEAVE' })
  expect(first.stub('alpha').socket.acks).toHaveLength(1)
  await first.stop()
  // Start logs name the authority's revision, which the seeded reconciliations advance.
  const startLogs = (run: ReloadRun) => run.logs.map(line => line.replace(/ at revision \d+$/, ' at revision N'))
  const plain = await start(), plainLogs = startLogs(plain); await plain.stop()
  const seeded = withPreRuleScanRepeats(disk(), 'alpha', 3, h.paths.lastApplied), history = seeded.personas.alpha!
  const preRule = Object.keys(history.membershipEvents).filter(id => id.startsWith('scan:00000000-'))
  expect(preRule).toHaveLength(3 * RETAINED.length)
  const bytes = h.writeRecordBytes(serializeSharedChannelState(seeded))
  // A dry-run start reads it as saved, reports nothing a plain history did not and writes nothing.
  const dry = await start()
  expect([dry.writes, dry.controller.sharedChannels()!.readable, dry.controller.sharedChannels()!.snapshot()]).toEqual([[], true, seeded])
  expect(startLogs(dry)).toEqual(plainLogs)
  await dry.stop()
  expect(h.readRecord()).toEqual(bytes)
  const written: SharedChannelState[] = []
  const run = await start({ dryRun: false, realLifecycle: true, slack: REPAIR_SLACK, beforeWrite(path, bytes) {
    if (path === h.paths.lastApplied) written.push(parseSharedChannelState(bytes, path)!)
  } })
  const authority = run.controller.sharedChannels()!
  expect([written, authority.snapshot(), h.readRecord()]).toEqual([[], seeded, bytes])
  await reconcileAlpha(run, [C.secondary, C.private])
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  // The persona's first membership application, the page, drops every
  // superseded repeat; only C.primary's newest absence, which it did not supersede, stays.
  const page = written[0]!.personas.alpha!
  expect(preRule.filter(id => Object.hasOwn(page.membershipEvents, id))).toEqual([newestRecords(seeded, [C.primary])[0]])
  expect(Object.keys(history.membershipEvents).filter(id => !preRule.includes(id) && !isDeepStrictEqual(page.membershipEvents[id], history.membershipEvents[id]))).toEqual([])
  // Decisions agree with the seeded history: membership, choices, the leave
  // and destination proof, lifetimes and readings.
  const after = authority.snapshot().personas.alpha!
  for (const channel of RETAINED) {
    expect([after.membership[channel]?.member, after.membership[channel]?.boundary, after.membership[channel]?.identity])
      .toEqual([history.membership[channel]?.member, history.membership[channel]?.boundary, history.membership[channel]?.identity])
    expect(authority.lifetime('alpha', channel)).toEqual(sharedChannelLifetime(seeded, 'alpha', channel))
  }
  expect([after.assignments, after.leaves, after.removedDestinations]).toEqual([history.assignments, history.leaves, history.removedDestinations])
  expect(RETAINED.map(channel => run.membership.read('alpha', channel, 'open').kind)).toEqual(['ineligible', 'eligible', 'eligible'])
  expect(preRule.filter(id => Object.hasOwn(after.membershipEvents, id))).toEqual([])
  // Replaying the leave still finds its own record: acknowledged, with no write.
  const writes = written.length, state = authority.snapshot()
  await run.deliver('alpha', leave, { event_id: 'EvPRERULELEAVE' })
  expect([run.stub('alpha').socket.acks.length, written.length, authority.snapshot()]).toEqual([1, writes, state])
})
