import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import type { ChannelMode } from '../src/config.ts'
import { MEMBERSHIP_REQUEST_TIMEOUT_MS } from '../src/channel-membership-retry.ts'
import { membershipScanDiagnostic } from '../src/channel-membership-scan.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { errnoSuffix } from '../src/persona-credentials.ts'
import { reloadSharedAuthorityApplyFailedLine } from '../src/reload.ts'
import {
  SHARED_STATE_DIAGNOSTIC_CLASSES, SHARED_STATE_UNRESOLVED, MEMBERSHIP_EVIDENCE_UNRESOLVED,
  SHARED_STATE_RECOVERED, PERSONA_DESTINATION_FAILED,
  buildSharedStateUnresolvedLine, buildMembershipEvidenceUnresolvedLine, buildSharedStateRecoveredLine,
  type SharedStateReportScope, type SharedStateCause, type MembershipReportEvidence, type SharedStateClosing,
} from '../src/persona-diagnostics.ts'
import { buildSharedStateUnresolvedNotice, buildMembershipEvidenceUnresolvedNotice, buildSharedStateRecoveredNotice, buildReloadApplyFailedNotice } from '../src/shared-state-reports.ts'
import { parseSharedChannelState } from '../src/shared-channels.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import {
  SHARED_CHANNEL_IDS as C, ATTEMPT_BODY_SENTINEL, activationRecord, botAttemptRecord,
  configBytes, deliveryAttempt, membershipPage, sharedRecoveryRequest,
  initialSharedState, writeSharedState,
} from './test-helpers/shared-channels.ts'
import { makeDeferredWebApiCall, makeMembershipEvent, makeChannelMessage, mentionText, broadcastText, type WebApiOutcome } from './test-helpers/slack-stub.ts'

let h: ReloadHarness
beforeEach(() => { h = makeReloadHarness() })
afterEach(async () => {
  try {
    for (const run of h.runs) {
      assertNoLeak(run.captured())
      // Routing's existing RAW event trace intentionally contains the input;
      // the report surfaces must never carry it.
      expect(JSON.stringify({ logs: reportLines(run), posts: run.slackPosts() })).not.toContain(ATTEMPT_BODY_SENTINEL)
    }
  } finally { await h.cleanup() }
})
const MODES: ChannelMode[] = ['strict', 'open']
const ref = renderPersonaRef('alpha', 'alpha')
const formatted = (text: string) => formatPersonaNotice({ name: 'alpha', key: 'alpha' }, text)
function seed(mode: ChannelMode, channels: string[] = [C.primary, C.secondary]) {
  const alpha = h.persona('alpha', { channels: channels.map(id => ({ id, delivery: 'all' })), permission_prompts: C.primary })
  const beta = h.persona('beta', { channels: [{ id: C.private, delivery: 'all' }], permission_prompts: C.private })
  h.materialize(alpha, beta)
  const input = { channel_mode: mode, personas: [alpha, beta] }
  h.writeConfig(input)
  return { alpha, beta, input }
}
async function start(options: ReloadRunOptions = {}, detecting = true) {
  const run = await h.start({ sharedStateReports: true, ...options })
  if (detecting && run.outcome.kind === 'applied') expect(run.startDetection()).toBe(true)
  await flush(run)
  return run
}
async function flush(run: ReloadRun) {
  await run.membershipClock.flush()
  await run.noticeClock.flush()
}
async function scan(run: ReloadRun, channels: string[] = [C.primary, C.secondary]) {
  run.stub('alpha').script.inventory.push(membershipPage(channels))
  run.stub('beta').script.inventory.push(membershipPage([C.private]))
  await run.membershipClock.runNext()
  await flush(run)
}
function posts(run: ReloadRun, name = 'alpha') {
  return run.stub(name).callLog.filter(c => c.method === 'chat.postMessage').map(c => ({ ...c, args: c.args as { text: string; channel: string } }))
}
function reportLines(run: ReloadRun, kind?: string) {
  return run.logs.filter(line => (kind ? [kind] : SHARED_STATE_DIAGNOSTIC_CLASSES).some(label => line.startsWith(`[slack] ${label}: `)))
}
function quietQ(run: ReloadRun) {
  expect(posts(run, 'beta')).toEqual([])
  expect(reportLines(run).filter(line => line.includes('persona=beta'))).toEqual([])
}
function stateReport(run: ReloadRun, cause: SharedStateCause, scope: SharedStateReportScope, failure = run.controller.sharedChannels()!.failure, silentQ = true) {
  const authority = run.controller.sharedChannels()!
  const text = formatted(buildSharedStateUnresolvedNotice(ref, scope, cause, authority.path, failure))
  expect(posts(run).filter(p => p.args.text === text)).toHaveLength(1)
  expect(posts(run).find(p => p.args.text === text)?.args.channel).toBe(C.primary)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED).filter(line => line === buildSharedStateUnresolvedLine('alpha', scope, cause, authority.path, failure))).toHaveLength(1)
  if (silentQ) quietQ(run)
  return text
}
function inventoryReport(run: ReloadRun, channels: string[]) {
  stateReport(run, 'not-saved', { channels, all: true, dm: false }, errnoSuffix({ code: 'ENOSPC' }))
  const notice = posts(run)[0]!.args.text
  const lines = reportLines(run, SHARED_STATE_UNRESOLVED)
  expect(lines).toHaveLength(1)
  // PM14-1: builder equality alone also passed when the builder falsely
  // described usable channels as held. Check the claims independently.
  expect(notice).toContain(`membership inventory incomplete; known channels: ${channels.join(', ')}`)
  expect(notice).toContain('could not save a complete membership inventory')
  expect(notice).not.toContain('could not save membership evidence for these channels')
  expect(notice).not.toContain('Messages there stay held')
  expect(notice).not.toContain('all its channels')
  expect(lines[0]).toContain(`scope=inventory known_channels=${JSON.stringify(channels)}`)
  expect(lines[0]).not.toContain('scope=all')
  expect(lines[0]).toContain('complete membership inventory not saved')
  for (const text of [notice.toLowerCase(), lines[0]!]) {
    expect(text).toContain('verified usable channels keep working')
    expect(text).toContain('only intake depending on missing membership evidence stays held and unacknowledged')
    expect(text).toContain('recovery requires a complete membership inventory')
  }
}
function evidenceReport(run: ReloadRun, scope: SharedStateReportScope, evidence: MembershipReportEvidence) {
  const authority = run.controller.sharedChannels()!
  const text = formatted(buildMembershipEvidenceUnresolvedNotice(ref, scope, evidence))
  expect(posts(run).filter(p => p.args.text === text)).toHaveLength(1)
  expect(posts(run).find(p => p.args.text === text)?.args.channel).toBe(C.primary)
  expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED).filter(line => line === buildMembershipEvidenceUnresolvedLine('alpha', scope, evidence, authority.path, authority.failure))).toHaveLength(1)
  quietQ(run)
}
function recovered(run: ReloadRun, scope: SharedStateReportScope, closing: SharedStateClosing, silentQ = true) {
  const authority = run.controller.sharedChannels()!
  expect(posts(run).filter(p => p.args.text === formatted(buildSharedStateRecoveredNotice(ref, scope, closing)))).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED).filter(line => line.includes('persona=alpha '))).toEqual([buildSharedStateRecoveredLine('alpha', scope, closing, authority.path, authority.failure)])
  if (silentQ) quietQ(run)
}
async function intake(run: ReloadRun, name = 'alpha', channel: string = C.primary, expectedVia?: 'receive_all') {
  const stub = run.stub(name), before = stub.socket.acks.length
  const targets = ['alpha', 'beta'].map(key => ({ key,
    queued: run.queued(key).length, deliveries: run.deliveries(key).length }))
  await run.deliver(name, makeChannelMessage({ channel, text: ATTEMPT_BODY_SENTINEL }))
  // An ack also follows a deliberate drop. Prove exact accepted targets
  // independently, including no sibling acceptance and no durable held item.
  for (const target of targets) {
    const expected = target.key === name && expectedVia !== undefined
      ? [{ chat_id: channel, via: expectedVia }] : []
    expect(run.queued(target.key).slice(target.queued).map(item => ({
      chat_id: item.accepted.channel, via: item.accepted.via, hold: item.hold,
    }))).toEqual(expected.map(item => ({ ...item, hold: undefined })))
    expect(run.deliveries(target.key).slice(target.deliveries).map(({ chat_id, via }) => ({ chat_id, via }))).toEqual(expected)
  }
  return stub.socket.acks.length - before
}
async function retry(run: ReloadRun, outcome: WebApiOutcome) {
  const next = run.membershipScanner.status('alpha').nextAttemptAt
  expect(next).toBeDefined()
  run.stub('alpha').script.inventory.push(outcome)
  await run.membershipClock.advanceTo(next!)
  await flush(run)
}

test.each(MODES)('%s: definite apply failure reports at the affected destination once per fingerprint and success closes silently', async mode => {
  const { alpha, beta } = seed(mode)
  const run = await start(); await scan(run)
  h.writeConfig({ channel_mode: mode, personas: [{ ...alpha, channels: [{ id: C.primary, delivery: 'off' }, { id: C.secondary, delivery: 'all' }] }, beta] })
  await run.ticks.tick()
  const fingerprint = h.pendingFingerprint()
  h.confirm(); h.failWrites({ path: h.paths.lastApplied })
  await run.ticks.tick(); await flush(run)
  expect(h.pendingFingerprint()).toBe(fingerprint)
  const text = formatted(buildReloadApplyFailedNotice(ref, { record: 'authority', path: h.paths.lastApplied, failure: errnoSuffix({ code: 'EIO' }) }))
  expect(posts(run).map(p => p.args)).toEqual([expect.objectContaining({ channel: C.primary, text })])
  expect(run.logs).toContain(reloadSharedAuthorityApplyFailedLine(h.paths.lastApplied, 'failed', errnoSuffix({ code: 'EIO' })))
  expect(run.controller.applied()!.config.personas.find(p => p.key === 'alpha')!.channels.find(c => c.id === C.primary)!.delivery).toBe('all')
  quietQ(run)
  h.confirm(); await run.ticks.tick(); await flush(run)
  expect(h.pendingFingerprint()).toBe(fingerprint)
  expect(posts(run)).toHaveLength(1)
  h.clearWriteFailure()
  await run.ticks.tick(); h.confirm(); await run.ticks.tick(); await flush(run)
  expect(run.controller.applied()!.config.personas.find(p => p.key === 'alpha')!.channels.find(c => c.id === C.primary)!.delivery).toBe('off')
  expect(h.pendingExists()).toBe(false)
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  quietQ(run)
})

test.each(MODES)('%s: unsynced apply reports once, preserves intake and write behavior, and closes on a successful detection tick', async mode => {
  const { alpha, beta } = seed(mode)
  let armed = false
  const options: ReloadRunOptions = { realLifecycle: true, beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) {
      armed = false; h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } }
  const run = await start(options); await scan(run)
  h.writeConfig({ channel_mode: mode, personas: [{ ...alpha, channels: [{ id: C.primary, delivery: 'off' }, { id: C.secondary, delivery: 'all' }] }, beta] })
  await run.ticks.tick(); h.confirm(); armed = true; await run.ticks.tick(); await flush(run)
  const authority = run.controller.sharedChannels()!
  const scope = { channels: [C.primary], all: false, dm: false }
  expect(authority.unreadableCause).toBe('unsynced')
  stateReport(run, 'unsynced', scope)
  expect(run.logs).toContain(reloadSharedAuthorityApplyFailedLine(authority.path, 'unresolved', authority.failure))
  const bytes = h.readRecord(), writes = run.writes.length
  expect(await intake(run)).toBe(0)
  expect(await intake(run, 'alpha', C.secondary, 'receive_all')).toBe(1)
  expect(await intake(run, 'beta', C.private, 'receive_all')).toBe(1)
  expect(run.writes).toHaveLength(writes); expect(h.readRecord()).toEqual(bytes)
  h.failWrites({ step: 'writeSync', code: 'EIO' })
  await run.ticks.tick(); await run.ticks.tick(); await flush(run)
  expect(await intake(run)).toBe(0)
  expect(posts(run)).toHaveLength(1); expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  h.clearWriteFailure(); await run.ticks.tick(); await flush(run)
  expect(run.membership.read('alpha', C.primary, mode).kind).not.toBe('unresolved')
  recovered(run, scope, 'state')
  // Recovery commits the requested off choice: acknowledged, with no item.
  expect(await intake(run)).toBe(1)
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(2)
})

test('open: an unsynced set_channel_delivery attempt reaches the same bounded reporter through the real MCP session', async () => {
  seed('open'); let armed = false
  const run = await start({ beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && botAttemptRecord(bytes, path, 'applied')) {
      armed = false; h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } }); await scan(run)
  run.registerSession('alpha'); armed = true
  expect((await run.callTool('alpha', 'set_channel_delivery', deliveryAttempt('unsynced-report', C.primary, 'off'))).isError).toBe(true)
  await flush(run)
  stateReport(run, 'unsynced', { channels: [C.primary], all: false, dm: false })
  expect(await intake(run)).toBe(0)
  h.clearWriteFailure(); await run.ticks.tick(); await flush(run)
  recovered(run, { channels: [C.primary], all: false, dm: false }, 'state')
})

test.each(MODES)('%s: partial discovery followed by unknown-channel storage failure cannot recover during a retry (CR-1)', async mode => {
  seed(mode, [C.primary]); let fail = true
  const run = await start({ beforeWrite(path, bytes) {
    if (path !== h.paths.lastApplied) return
    const state = parseSharedChannelState(bytes, path)
    if (fail && state?.personas.alpha?.membership[C.secondary]) h.failWrites({ code: 'ENOSPC' })
    else h.clearWriteFailure()
  } })
  await scan(run)
  expect(run.controller.sharedChannels()!.readable).toBe(true)
  expect(run.membershipScanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(run.membership.unresolvedChannels('alpha')).toEqual([])
  expect(run.membership.read('alpha', C.primary, mode).kind).toBe('eligible')
  expect(run.membership.read('alpha', C.secondary, mode)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  inventoryReport(run, [C.primary])
  expect(await intake(run, 'alpha', C.primary, 'receive_all')).toBe(1)
  const held = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(membershipPage([C.primary], 'next'), held.outcome)
  await run.membershipClock.advanceTo(run.membershipScanner.status('alpha').nextAttemptAt!)
  await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  expect(run.membership.generation('alpha')?.complete).toBe(false)
  expect(await intake(run, 'alpha', C.primary, 'receive_all')).toBe(1)
  // B was never durably observed; no accepted/held queue item and no ACK.
  expect(run.membership.read('alpha', C.secondary, mode)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  expect(await intake(run, 'alpha', C.secondary)).toBe(0)
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  held.settle(membershipPage([C.secondary])); await flush(run)
  expect(run.membershipScanner.status('alpha').problem).toBe('storage')
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  fail = false; h.clearWriteFailure()
  await retry(run, membershipPage([C.primary, C.secondary]))
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  recovered(run, { channels: [C.primary, C.secondary], all: true, dm: false }, 'state')
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(2)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toHaveLength(1)
})

test.each(MODES)('%s: first request and scanning history holds stay log-only until a scan ends, then resist retries (CR-2)', async mode => {
  seed(mode)
  const run = await start()
  const [joined, envelope] = makeMembershipEvent(run.stub('alpha').identity, 'join', C.primary, run.membershipClock.now() + 1)
  await run.deliver('alpha', joined, envelope)
  const authority = run.controller.sharedChannels()!
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('applied')
  const [left] = makeMembershipEvent(run.stub('alpha').identity, 'leave', C.primary, run.membershipClock.now() + 1)
  await run.deliver('alpha', left, envelope); await flush(run)
  expect(run.membership.generation('alpha')?.holds.get(C.primary)).toBe('history-unresolved')
  expect(run.membershipScanner.ended('alpha')).toBe(false)
  expect(posts(run)).toEqual([]); expect(reportLines(run)).toEqual([])
  const held = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(held.outcome)
  run.stub('beta').script.inventory.push(membershipPage([C.private]))
  await run.membershipClock.runNext(); await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  expect(posts(run)).toEqual([]); expect(reportLines(run)).toEqual([])
  held.settle(membershipPage([C.primary, C.secondary])); await flush(run)
  const status = run.membershipScanner.status('alpha')
  expect(run.membershipScanner.ended('alpha')).toBe(true)
  evidenceReport(run, { channels: [C.primary], all: false }, { history: [{ channel: C.primary, evidence: 'event-history' }], nextAttemptAt: status.nextAttemptAt })
  expect(await intake(run)).toBe(0)
  await retry(run, membershipPage([C.primary, C.secondary]))
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(1); expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  const slack = { alpha: run.stub('alpha').identity, beta: run.stub('beta').identity }
  await run.stop()
  const reopened = await start({ slack })
  expect(reopened.membership.generation('alpha')?.holds.get(C.primary)).toBe('history-unresolved')
  expect(reopened.membershipScanner.status('alpha').state).toBe('incomplete')
  expect(reopened.membershipScanner.ended('alpha')).toBe(false)
  expect(reportLines(reopened)).toEqual([]); expect(posts(reopened)).toEqual([])
  await scan(reopened)
  expect(reportLines(reopened, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(1)
})

test.each(MODES)('%s: a history conflict during retry cannot escalate an existing evidence episode before the scan ends (CR-2)', async mode => {
  seed(mode); const run = await start()
  const hanging = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(hanging.outcome)
  run.stub('beta').script.inventory.push(membershipPage([C.private]))
  await run.membershipClock.runNext()
  await run.membershipClock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS); await flush(run)
  expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(1)
  const held = makeDeferredWebApiCall()
  await retry(run, held.outcome)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  const at = run.membershipClock.now() + 1
  const [joined, envelope] = makeMembershipEvent(run.stub('alpha').identity, 'join', C.primary, at)
  await run.deliver('alpha', joined, envelope)
  const authority = run.controller.sharedChannels()!
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('applied')
  const [left] = makeMembershipEvent(run.stub('alpha').identity, 'leave', C.primary, at)
  await run.deliver('alpha', left, envelope); await flush(run)
  expect(run.membership.generation('alpha')?.holds.get(C.primary)).toBe('history-unresolved')
  expect(run.membershipScanner.ended('alpha')).toBe(false)
  expect(posts(run)).toHaveLength(1); expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(1)
  held.settle(membershipPage([C.primary, C.secondary])); await flush(run)
  if (!run.membershipScanner.ended('alpha')) await retry(run, membershipPage([C.primary, C.secondary]))
  expect(run.membershipScanner.ended('alpha')).toBe(true)
  expect(posts(run)).toHaveLength(2)
  expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(2)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  quietQ(run)
})

test.each(MODES)('%s: a definite inventory commit failure with readable authority is not saved until a complete retry', async mode => {
  seed(mode); let fail = true
  const run = await start({ beforeWrite(path, bytes) {
    if (path !== h.paths.lastApplied) return
    const state = parseSharedChannelState(bytes, path)
    if (fail && state?.personas.alpha?.membershipInventory) h.failWrites({ code: 'ENOSPC' })
    else h.clearWriteFailure()
  } })
  // A is verified; the failed inventory commit cannot establish B's absence.
  await scan(run, [C.primary])
  expect(run.controller.sharedChannels()!.readable).toBe(true)
  expect(run.membership.generation('alpha')?.holds.size).toBe(0)
  expect(run.membershipScanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(run.membership.read('alpha', C.primary, mode).kind).toBe('eligible')
  expect(run.membership.read('alpha', C.secondary, mode)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  inventoryReport(run, [C.primary, C.secondary])
  expect(await intake(run, 'alpha', C.primary, 'receive_all')).toBe(1)
  const held = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(membershipPage([C.primary], 'next'), held.outcome)
  await run.membershipClock.advanceTo(run.membershipScanner.status('alpha').nextAttemptAt!)
  await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  expect(await intake(run, 'alpha', C.secondary)).toBe(0)
  held.settle(membershipPage([C.secondary])); await flush(run)
  expect(run.membershipScanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  // Even with both positive observations saved, the inventory is incomplete.
  for (const channel of [C.primary, C.secondary]) {
    expect(run.membership.read('alpha', channel, mode).kind).toBe('eligible')
    expect(await intake(run, 'alpha', channel, 'receive_all')).toBe(1)
  }
  expect(run.membership.generation('alpha')?.complete).toBe(false)
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  fail = false; h.clearWriteFailure()
  const finalPage = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(membershipPage([C.primary, C.secondary], 'last'), finalPage.outcome)
  await run.membershipClock.advanceTo(run.membershipScanner.status('alpha').nextAttemptAt!)
  await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  finalPage.settle(membershipPage([])); await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  recovered(run, { channels: [C.primary, C.secondary], all: true, dm: false }, 'state')
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(2)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toHaveLength(1)
})

test.each(MODES)('%s: enabling reporting leaves uncertain bytes, write calls, holds, acks and existing membership lines unchanged', async mode => {
  const { input } = seed(mode)
  const authorityDir = dirname(h.paths.lastApplied)
  const initial = initialSharedState(authorityDir, input)
  const message = makeChannelMessage({ channel: C.primary, text: ATTEMPT_BODY_SENTINEL })
  const observations = []
  for (const sharedStateReports of [false, true]) {
    h.clearWriteFailure(); writeSharedState(authorityDir, initial)
    const run = await start({ sharedStateReports, realLifecycle: true })
    const authority = run.controller.sharedChannels()!
    const cp = run.checkpoint()
    h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
    expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('unresolved')
    const installed = h.readRecord()
    await run.deliver('alpha', message); await flush(run)
    const reads = [C.primary, C.secondary].map(channel => ({ channel,
      readable: authority.readableFor('alpha', channel), kind: run.membership.read('alpha', channel, mode).kind }))
    observations.push({ installed, after: h.readRecord(), writes: run.since(cp).writes,
      scope: authority.unresolvedScope('alpha'), reads, acks: run.stub('alpha').socket.acks,
      queued: run.queued('alpha'), lines: run.logs.filter(line => line.startsWith('[slack] channel-membership-')) })
    expect(posts(run)).toHaveLength(sharedStateReports ? 1 : 0)
    await run.stop()
  }
  expect(observations[1]).toEqual(observations[0])
})

test.each(MODES)('%s: persona teardown forgets old evidence scope before a fresh episode on re-add', async mode => {
  const { alpha, beta } = seed(mode)
  const run = await start()
  const authority = run.controller.sharedChannels()!
  const [joined, envelope] = makeMembershipEvent(run.stub('alpha').identity, 'join', C.secondary, 1)
  await run.deliver('alpha', joined, envelope)
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.secondary, 'off', authority.revision).kind).toBe('applied')
  const [left] = makeMembershipEvent(run.stub('alpha').identity, 'leave', C.secondary, 1)
  await run.deliver('alpha', left, envelope); await scan(run)
  expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(1)
  h.writeConfig({ channel_mode: mode, personas: [beta] }); await run.ticks.tick(); h.confirm(); await run.ticks.tick(); await flush(run)
  expect(run.appliedKeys()).toEqual(['beta'])
  h.writeConfig({ channel_mode: mode, personas: [{ ...alpha, channels: [{ id: C.primary, delivery: 'all' }] }, beta] })
  await run.ticks.tick(); h.confirm(); await run.ticks.tick(); await flush(run)
  expect(run.isUp('alpha')).toBe(true)
  await scan(run, [C.primary])
  const before = posts(run).length
  h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('unresolved')
  await flush(run)
  expect(posts(run)).toHaveLength(before + 1)
  h.clearWriteFailure(); await run.ticks.tick(); await flush(run)
  recovered(run, { channels: [C.primary], all: false, dm: false }, 'state')
  expect(posts(run)).toHaveLength(before + 2)
})

test.each(MODES.flatMap(mode => (['deadline', 'access', 'transport'] as const).map(problem => ({ mode, problem }))))(
  '$mode: ended $problem scan reports only permanent gaps and closes after a complete scan', async ({ mode, problem }) => {
  seed(mode); const run = await start()
  const held = makeDeferredWebApiCall()
  run.stub('alpha').script.inventory.push(problem === 'deadline' ? held.outcome : problem === 'access' ? { kind: 'platform', error: 'missing_scope' } : { kind: 'network' })
  run.stub('beta').script.inventory.push(membershipPage([C.private]))
  await run.membershipClock.runNext(); await flush(run)
  if (problem === 'deadline') {
    expect(posts(run)).toEqual([])
    await run.membershipClock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS); await flush(run)
  }
  const status = run.membershipScanner.status('alpha')
  expect(status).toMatchObject({ state: 'incomplete', problem })
  expect(run.logs).toContain(membershipScanDiagnostic('alpha', status))
  if (problem === 'transport') expect(reportLines(run)).toEqual([])
  else evidenceReport(run, { channels: [C.primary, C.secondary], all: true }, { history: [], problem, slackError: status.slackError, nextAttemptAt: status.nextAttemptAt })
  const again = makeDeferredWebApiCall()
  await retry(run, problem === 'deadline' ? again.outcome : problem === 'access' ? { kind: 'platform', error: 'missing_scope' } : { kind: 'network' })
  if (problem === 'deadline') { await run.membershipClock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS); await flush(run) }
  expect(run.membershipScanner.status('alpha').problem).toBe(problem)
  expect(posts(run)).toHaveLength(problem === 'transport' ? 0 : 1)
  expect(reportLines(run, MEMBERSHIP_EVIDENCE_UNRESOLVED)).toHaveLength(problem === 'transport' ? 0 : 1)
  await retry(run, membershipPage([C.primary, C.secondary]))
  if (problem === 'transport') expect(posts(run)).toEqual([])
  else recovered(run, { channels: [C.primary, C.secondary], all: true, dm: false }, 'evidence')
  quietQ(run)
})

test.each(MODES.flatMap(mode => (['restore', 'replace'] as const).map(action => ({ mode, action }))))(
  '$mode: changed uncertain evidence and reviewed $action close only after activation and complete membership', async ({ mode, action }) => {
  const { input } = seed(mode)
  let run = await start(); await scan(run)
  const authority = run.controller.sharedChannels()!
  h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
  expect(authority.assign('alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision).kind).toBe('unresolved')
  await flush(run)
  const scope = { channels: [C.primary], all: false, dm: false }
  stateReport(run, 'unsynced', scope)
  h.clearWriteFailure()
  const damage = h.writeRecordBytes(ATTEMPT_BODY_SENTINEL)
  await run.ticks.tick(); await flush(run)
  expect(authority.unreadableCause).toBe('evidence-changed')
  stateReport(run, 'evidence-changed', scope)
  expect(posts(run)).toHaveLength(2)
  expect(await intake(run)).toBe(0)
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('review-report-repair', damage, action === 'replace' ? configBytes(input) : undefined)))
  if (action === 'restore') {
    await run.ticks.tick(); await flush(run)
    expect(authority.unreadableCause).toBe('restoration-staged')
    const staged = { channels: [C.primary, C.secondary], all: true, dm: false,
      repairPending: { usable: [C.secondary], held: [C.primary] } }
    expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toContain(buildSharedStateUnresolvedLine('alpha', staged, 'restoration-staged', authority.path, authority.failure))
    expect(posts(run)).toHaveLength(2)
    expect(await intake(run)).toBe(0)
    expect(await intake(run, 'alpha', C.secondary, 'receive_all')).toBe(1)
    expect(await intake(run, 'beta', C.private, 'receive_all')).toBe(1)
  }
  await run.stop()
  run = await start({}, false)
  expect(run.outcome.kind).toBe('refused')
  expect(run.slackPosts()).toEqual([]); expect(reportLines(run)).toEqual([])
  await run.stop(); h.confirm()
  run = await start()
  expect(run.outcome.kind).toBe('applied'); expect(run.controller.repairActivated()).toBe(true)
  expect(posts(run)).toEqual([])
  const held = makeDeferredWebApiCall()
  // Every known channel is already positive, but an unfinished page can
  // still reveal another channel. Readable known channels cannot close repair.
  run.stub('alpha').script.inventory.push(membershipPage([C.primary, C.secondary], 'later'), held.outcome)
  run.stub('beta').script.inventory.push(membershipPage([C.private]))
  await run.membershipClock.runNext(); await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('scanning')
  expect(posts(run)).toEqual([])
  held.settle(membershipPage([])); await flush(run)
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  for (const channel of [C.primary, C.secondary]) expect(run.membership.read('alpha', channel, mode).kind).not.toBe('unresolved')
  recovered(run, { channels: [C.primary, C.secondary], all: true, dm: false }, 'repair', false)
  expect(posts(run)).toHaveLength(1)
  // The repair activates the whole authority, including beta's reviewed state.
  expect(posts(run, 'beta').map(p => p.args.text)).toEqual([formatPersonaNotice({ name: 'beta', key: 'beta' },
    buildSharedStateRecoveredNotice(renderPersonaRef('beta', 'beta'), { channels: [C.private], all: true }, 'repair'))])
  await run.ticks.tick(); await flush(run); expect(posts(run)).toHaveLength(1)
})

test.each(MODES)('%s: identical-projection restoration qualifies membership readiness while thread replies are held and independent intake continues', async mode => {
  const { alpha, beta } = seed(mode)
  h.writeConfig({ channel_mode: mode, personas: [{ ...alpha, channels: [
    { id: C.primary, delivery: 'thread_hybrid' }, { id: C.secondary, delivery: 'all' },
  ] }, beta] })
  const run = await start({ threadMemory: {} }); await scan(run)
  const authority = run.controller.sharedChannels()!
  const root = '1700000000.000001'
  await run.joinThread('alpha', C.primary, root)
  expect(run.threadMemory!.view('alpha', C.primary, root)).toBe('joined')
  const joins = run.threadMemory!.joins('alpha')
  // Observe production acceptance and ACKs separately: a dropped event can
  // still be ACKed. Include the sibling queue and reject durable held items.
  async function threadIntake(event: ReturnType<typeof makeChannelMessage>, via?: 'thread' | 'mention' | 'broadcast') {
    const ackBefore = run.stub('alpha').socket.acks.length
    const queuedBefore = ['alpha', 'beta'].map(key => ({ key, count: run.queued(key).length }))
    await run.deliver('alpha', event)
    for (const { key, count } of queuedBefore) {
      expect(run.queued(key).slice(count).map(({ accepted, hold }) => ({
        channel: accepted.channel, ts: accepted.ts, thread_ts: accepted.thread_ts,
        text: accepted.text, via: accepted.via, hold,
      }))).toEqual(key === 'alpha' && via !== undefined ? [{
        channel: event.channel as string, ts: event.ts as string, thread_ts: event.thread_ts as string,
        text: event.text as string, via, hold: undefined,
      }] : [])
    }
    return run.stub('alpha').socket.acks.length - ackBefore
  }
  expect(await threadIntake(makeChannelMessage({ channel: C.primary, thread_ts: root,
    text: ATTEMPT_BODY_SENTINEL }), 'thread')).toBe(1)
  const acceptedBefore = structuredClone(run.queued('alpha'))
  const before = authority.snapshot()
  const damage = h.writeRecordBytes(ATTEMPT_BODY_SENTINEL)
  h.writeRequestBytes(configBytes(sharedRecoveryRequest('identical-report-repair', damage)))
  await run.ticks.tick(); await flush(run)
  expect(authority.snapshot()).toEqual(before)
  expect(authority.unreadableCause).toBe('restoration-staged')
  expect(authority.unresolvedScope('alpha')).toBeUndefined()
  const scope = { channels: [C.primary, C.secondary], all: true, dm: false,
    repairPending: { usable: [C.primary, C.secondary], held: [] } }
  stateReport(run, 'restoration-staged', scope, authority.failure, false)
  for (const channel of [C.primary, C.secondary]) {
    expect(authority.readableFor('alpha', channel)).toBe(true)
    expect(run.membership.read('alpha', channel, mode).kind).toBe('eligible')
  }
  expect(authority.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
  expect(run.threadMemory!.joins('alpha')).toEqual(joins)
  expect(run.threadMemory!.view('alpha', C.primary, root)).toBe('not-joined')
  const dependent = makeChannelMessage({ channel: C.primary, thread_ts: root, text: ATTEMPT_BODY_SENTINEL })
  expect(await threadIntake(dependent)).toBe(0)
  expect(await threadIntake(dependent)).toBe(0)
  expect(run.queued('alpha')).toEqual(acceptedBefore)
  expect(await threadIntake(makeChannelMessage({ channel: C.primary, thread_ts: root,
    text: `${mentionText(run.stub('alpha').identity.botUserId)} ${ATTEMPT_BODY_SENTINEL}` }), 'mention')).toBe(1)
  expect(await threadIntake(makeChannelMessage({ channel: C.primary, thread_ts: root,
    text: `${broadcastText('channel')} ${ATTEMPT_BODY_SENTINEL}` }), 'broadcast')).toBe(1)
  expect(await intake(run, 'alpha', C.secondary, 'receive_all')).toBe(1)
  expect(await intake(run, 'beta', C.private, 'receive_all')).toBe(1)

  // PM14-SR-1: inspect the actual captured claims independently of the
  // builders, which previously agreed on false all-intake readiness wording.
  const notice = posts(run)[0]!.args.text
  const lines = reportLines(run, SHARED_STATE_UNRESOLVED).filter(line => line.includes('persona=alpha '))
  expect(lines).toHaveLength(1)
  expect(notice).toContain(`Membership decided: ${C.primary}, ${C.secondary}`)
  expect(notice).toContain('Membership unresolved (intake held): none')
  expect(notice).not.toContain('Still usable:')
  expect(notice).not.toContain('Held: none')
  expect(notice).not.toContain('Messages in the affected channels stay held')
  expect(lines[0]).toContain(`membership_decided=${JSON.stringify([C.primary, C.secondary])} membership_held=[]`)
  expect(lines[0]).not.toContain(' usable=')
  expect(lines[0]).not.toContain(' held=[]')
  for (const text of [notice.toLowerCase(), lines[0]!.toLowerCase()]) {
    expect(text).toContain('membership readiness only')
    expect(text).toContain('thread-dependent replies in thread_hybrid channels stay held and unacknowledged while channel stamps are undecided')
    expect(text).toContain('otherwise eligible @mentions, broadcasts and other intake independent of channel stamps continue')
    expect(text).toContain('only messages whose intake is held remain unacknowledged')
  }
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(1); expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  expect(reportLines(run, SHARED_STATE_UNRESOLVED).filter(line => line.includes('persona=alpha '))).toEqual(lines)
})

test.each(MODES)('%s: readable retirement hold is logged at start and queued until withheld persona connects', async mode => {
  const { beta } = seed(mode); let armed = false
  let run = await start({ beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) h.failWrites({ code: 'EIO' })
  } }); await scan(run)
  h.writeConfig({ channel_mode: mode, personas: [beta] })
  await run.ticks.tick(); h.confirm(); armed = true; await run.ticks.tick(); await flush(run)
  expect(run.controller.sharedChannels()!.readable).toBe(true)
  expect(run.controller.sharedChannels()!.reviewHeld('alpha')).toBe(true)
  const scope = { channels: [C.primary, C.secondary], all: true, dm: true }
  stateReport(run, 'retirement-unresolved', scope)
  await run.stop()
  run = await start()
  expect(run.outcome.kind).toBe('applied')
  expect(run.isUp('alpha')).toBe(false); expect(run.isUp('beta')).toBe(true)
  const authority = run.controller.sharedChannels()!
  expect(authority.readable).toBe(true); expect(authority.reviewHeld('alpha')).toBe(true)
  expect(posts(run)).toEqual([])
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toEqual([buildSharedStateUnresolvedLine('alpha', scope, 'retirement-unresolved', authority.path, authority.failure)])
  await run.ticks.tick(); await flush(run)
  expect(posts(run)).toEqual([])
  h.clearWriteFailure(); await run.ticks.tick(); await flush(run)
  expect(run.isUp('alpha')).toBe(true)
  expect(posts(run)).toHaveLength(1)
  expect(posts(run)[0]!.args.channel).toBe(C.primary)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  await scan(run)
  recovered(run, scope, 'state')
})

test.each(MODES)('%s: an unsaved authenticated membership event is held without ack, reports once, then reconciles', async mode => {
  seed(mode); const run = await start(); await scan(run)
  const authority = run.controller.sharedChannels()!
  h.failWrites({ code: 'ENOSPC' })
  const event = makeMembershipEvent(run.stub('alpha').identity, 'leave', C.primary, run.membershipClock.now() + 1)
  const before = run.stub('alpha').socket.acks.length
  await run.deliver('alpha', ...event); await flush(run)
  expect(authority.readable).toBe(true)
  expect(run.membership.generation('alpha')?.holds.get(C.primary)).toBe('event-not-durable')
  expect(run.stub('alpha').socket.acks).toHaveLength(before)
  stateReport(run, 'not-saved', { channels: [C.primary], all: false, dm: false })
  expect(await intake(run)).toBe(0)
  await run.deliver('alpha', ...event); await flush(run)
  expect(run.stub('alpha').socket.acks).toHaveLength(before)
  expect(run.membership.generation('alpha')?.holds.get(C.primary)).toBe('event-not-durable')
  expect(posts(run)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  h.clearWriteFailure(); await retry(run, membershipPage([C.secondary]))
  expect(run.membershipScanner.status('alpha').state).toBe('complete')
  expect(run.membership.generation('alpha')?.holds.has(C.primary)).toBe(false)
  expect(run.membership.read('alpha', C.primary, mode).kind).toBe('ineligible')
  recovered(run, { channels: [C.primary], all: false, dm: false }, 'state')
})

test.each(MODES)('%s: unreadable last-applied start preserves its refusal and emits no shared-state report', async mode => {
  seed(mode); const damage = h.writeRecordBytes(ATTEMPT_BODY_SENTINEL)
  const baseline = await start({ sharedStateReports: false }, false)
  expect(baseline.outcome.kind).toBe('refused')
  const lines = baseline.logs.slice(); await baseline.stop()
  const run = await start({}, false)
  expect(run.outcome.kind).toBe('refused')
  expect(run.logs).toEqual(lines)
  expect(run.slackPosts()).toEqual([]); expect(reportLines(run)).toEqual([])
  expect(h.readRecord()).toEqual(damage)
})

test.each(MODES.flatMap(mode => [false, true].map(all => ({ mode, all }))))(
  '$mode: affected notice destination (all=$all) retries one held notice without recursive reports', async ({ mode, all }) => {
  const { alpha, beta } = seed(mode); let armed = false
  const run = await start({ beforeWrite(path, bytes) {
    if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) {
      armed = false; h.failWrites({ step: 'fsyncSync', call: 2, code: 'EIO' })
    }
  } }); await scan(run)
  run.stub('alpha').script.post.push({ kind: 'platform', error: 'channel_not_found' }, { kind: 'platform', error: 'channel_not_found' })
  h.writeConfig({ channel_mode: mode, personas: [{ ...alpha, channels: [{ id: C.primary, delivery: 'off' }, { id: C.secondary, delivery: all ? 'off' : 'all' }] }, beta] })
  await run.ticks.tick(); h.confirm(); armed = true; await run.ticks.tick(); await flush(run)
  const scope = { channels: all ? [C.primary, C.secondary] : [C.primary], all: false, dm: false }
  stateReport(run, 'unsynced', scope)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(run.logs.filter(line => line.includes(`${PERSONA_DESTINATION_FAILED}:`))).toHaveLength(1)
  h.failWrites({ code: 'EIO' }); await run.ticks.tick(); await run.ticks.tick(); await flush(run)
  expect(posts(run)).toHaveLength(1)
  await run.noticeClock.runNext(); await flush(run)
  expect(posts(run)).toHaveLength(2)
  await run.noticeClock.runNext(); await flush(run)
  expect(posts(run)).toHaveLength(3)
  expect(run.noticeClock.pendingCount()).toBe(0)
  expect(new Set(posts(run).map(p => p.args.text)).size).toBe(1)
  expect(reportLines(run, SHARED_STATE_UNRESOLVED)).toHaveLength(1)
  expect(run.episodeNotices.filter(n => n.key === 'alpha')).toHaveLength(1)
  expect(reportLines(run, SHARED_STATE_RECOVERED)).toEqual([])
  quietQ(run)
  await run.stop()
  const stopped = { lines: reportLines(run), posts: run.slackPosts() }
  h.clearWriteFailure(); run.controller.sharedChannels()!.recoverDurability()
  await flush(run)
  expect({ lines: reportLines(run), posts: run.slackPosts() }).toEqual(stopped)
})
