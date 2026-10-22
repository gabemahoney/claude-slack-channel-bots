/** Startup, confirmed application and reopen use the same durable shared authority. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as nodeFs from 'node:fs'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PERSONA_CONFIG_FS, type PersonaConfigFs } from '../src/config.ts'
import { parseSharedChannelState, serializeSharedChannelState } from '../src/shared-channels.ts'
import { reloadSharedAuthorityApplyFailedLine } from '../src/reload.ts'
import { errnoSuffix } from '../src/persona-credentials.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { channelPopulation, configBytes } from './test-helpers/shared-channels.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
let h: ReloadHarness
let runs: ReloadRun[]
let engines: EngineHarness[]
beforeEach(() => { h = makeReloadHarness(); runs = []; engines = [] })
afterEach(async () => { for (const e of engines) { assertNoLeak({ errors: e.errors, events: e.events }); await e.cleanup() }; for (const run of runs) { expect(run.slackPosts()).toEqual([]); assertNoLeak(run.captured()); await run.stop() }; await h.cleanup() })
async function start(opts: ReloadRunOptions = {}) { const run = await h.startDetecting({ dryRun: true, ...opts }); runs.push(run); expect(run.outcome.kind).toBe('applied'); return run }
function disk() { return parseSharedChannelState(readFileSync(h.paths.lastApplied), h.paths.lastApplied)! }

test('shared transaction order reservations reject invalid spans before callbacks or writes and preserve ordinary one-order commits', async () => {
  const alpha = h.persona('alpha'); h.materialize(alpha); h.writeConfig({ personas: [alpha] })
  let writes = 0, callbacks = 0
  const run = await start({ beforeWrite: path => { if (path === h.paths.lastApplied) writes++ } })
  const authority = run.controller.sharedChannels()!, before = authority.snapshot(), initialWrites = writes
  for (const span of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(authority.transact(authority.revision, () => { callbacks++ }, span).kind).toBe('failed')
    expect(callbacks).toBe(0)
    expect(writes).toBe(initialWrites)
    expect(authority.snapshot()).toEqual(before)
    expect(disk()).toEqual(before)
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
  expect(disk()).toEqual(authority.snapshot())
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
    beforeWrite: path => {
      if (fail && path === h.paths.lastApplied) {
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
  expect(disk()).toEqual(previous)
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
  expect(reopened.controller.sharedChannels()!.snapshot()).toEqual(previous)
  expect(h.readConfig()).toEqual(bytes)
  expect(h.readApply()).toEqual(confirmation)
  expect(reopened.queue.openCount('alpha')).toBe(0)
  for (const item of accepted[0]!) expect((await reopened.queue.accept('alpha', item)).status).toBe('duplicate')
})

test.each(['retirement', 'publication'] as const)('shutdown during %s preserves the correct authority and prepared input on reopen', async phase => {
  const alpha = h.persona('alpha'); const beta = h.persona('beta'); h.materialize(alpha, beta)
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
  const bytes = h.writeConfig({ channel_mode: 'open', personas: [beta] })
  await run.ticks.tick(); h.confirm(); const confirmation = h.readApply()
  authority.subscribe(() => { if (armed && phase === 'publication') run.controller.stopDetection() })
  const cp = run.checkpoint(); armed = true
  await run.ticks.tick()
  expect(stopped).toEqual([])
  expect(run.since(cp).lifecycle).toEqual([])
  expect(run.appliedConfigs.slice(notificationsBefore)).toEqual([])
  expect(authority.config().channel_mode).toBe(phase === 'retirement' ? 'strict' : 'open')
  expect(run.controller.applied()!.config).toEqual(authority.config())
  expect(run.retiredKeys.keys()).toEqual(phase === 'retirement' ? [] : [h.key('alpha')])
  expect(authority.snapshot().pendingIntent).toEqual(before.pendingIntent)
  expect(h.readConfig()).toEqual(bytes)
  if (phase === 'retirement') {
    expect(authority.snapshot()).toEqual(before)
    expect(h.readApply()).toEqual(confirmation)
  }
  assertNoLeak(run.captured())
  await run.stop()
  const reopened = await start()
  expect(reopened.controller.applied()!.config.channel_mode).toBe(phase === 'retirement' ? 'strict' : 'open')
  expect(reopened.controller.sharedChannels()!.snapshot()).toEqual(authority.snapshot())
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
  expect(disk()).toEqual(before)
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
  expect(readFileSync(h.paths.lastApplied)).toEqual(before)
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
  expect(authority.snapshot()).toEqual(choices)
  expect(authority.config().personas[0]!.channels).toEqual(channelPopulation(1000))
  expect(readFileSync(h.paths.lastApplied)).toEqual(before)
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
  expect(authority.snapshot()).toEqual(choices)
  expect(h.readConfig()).toEqual(prepared)
  expect(h.readApply()).toEqual(confirmation)
  assertNoLeak(run.captured())
  await run.stop()
  const recovery = await start()
  expect(recovery.controller.sharedChannels()!.snapshot()).toEqual(choices)
  expect(h.readApply()).toEqual(confirmation)
  expect(h.readConfig()).toEqual(prepared)
  // Startup retains the failed prepared gesture and previous authority; make the fresh confirming rename before the next detection tick.
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

 test.each(['before', 'after'] as const)('interruption %s durable activation retains trustworthy state and prepared input', async when => {
  const alpha = h.persona('alpha'); h.materialize(alpha)
  h.writeConfig({ personas: [alpha] })
  const run = await start()
  const authority = run.controller.sharedChannels()!
  const incarnation = authority.incarnation(h.key('alpha'))!
  expect(authority.transact(authority.revision, next => { next.pendingIntent = { prepared: 'review' }; next.outcomes = { prior: 'retained' } }).kind).toBe('applied')
  const before = disk()
  h.writeConfig({ channel_mode: 'open', personas: [alpha] })
  await run.ticks.tick()
  h.confirm()
  const confirmation = h.readApply()!
  if (when === 'before') h.failWrites({ step: 'writeSync', code: 'ENOSPC' })
  else h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
  await run.ticks.tick()
  expect(authority.config().channel_mode).toBe('strict')
  expect(authority.snapshot()).toEqual(before)
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
  expect(disk().outcomes).toEqual(before.outcomes)
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
  expect(authority.revision).toBe(revision + 1)
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
    expect(run.logsOf('reload-invalid').at(-1)).toBe(`[slack] reload-invalid: the confirmed configuration is invalid, so nothing is applied: ${error}`)
    expect(run.controller.applied()).toBe(applied)
    expect(authority.snapshot()).toEqual(choices)
    expect(readFileSync(h.paths.lastApplied)).toEqual(before)
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
