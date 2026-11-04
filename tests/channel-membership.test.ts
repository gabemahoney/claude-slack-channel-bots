import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMembershipHarness, membershipPage, readSharedState, writeSharedState, SHARED_CHANNEL_IDS as C, type MembershipHarness, configBytes, channelPopulation } from './test-helpers/shared-channels.ts'
import { makeDeferredWebApiCall, makeDeferredConnect, makeChannelMessage, makeDm } from './test-helpers/slack-stub.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MIN_MS, MEMBERSHIP_RETRY_MAX_MS, MEMBERSHIP_PAGE_LIMIT } from '../src/channel-membership-retry.ts'
import { makeManagedRouting } from './test-helpers/persona-routing-managed.ts'
import { createPersonaEventRouter } from '../src/persona-event-router.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { _resetRegistry } from '../src/registry.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { parseSharedChannelState } from '../src/shared-channels.ts'
import { DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import type { MembershipEvidence } from '../src/channel-membership-evidence.ts'
import type { AcceptedRecord } from '../src/delivery-queue.ts'
import { membershipScanDiagnostic, MEMBERSHIP_INVENTORY_COMPLETE, MEMBERSHIP_INVENTORY_INCOMPLETE, type MembershipScanStatus } from '../src/channel-membership-scan.ts'

const runs: MembershipHarness[] = [], dirs: string[] = []
function fixture(opts: Parameters<typeof makeMembershipHarness>[1] = {}, dir = mkdtempSync(join(tmpdir(), 'membership-'))) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const f = makeMembershipHarness(dir, opts); runs.push(f); return f
}
const stub = (f: MembershipHarness, key = 'alpha') => f.h.stub(f.h.p(key))
const reading = (f: MembershipHarness, channel: string = C.primary, key = 'alpha') => f.membership.read(key, channel, f.authority.config().channel_mode)
const life = (f: MembershipHarness, key = 'alpha') => f.authority.snapshot().personas[key]!
const scanLines = (f: MembershipHarness) => f.lines.filter(line =>
  [MEMBERSHIP_INVENTORY_COMPLETE, MEMBERSHIP_INVENTORY_INCOMPLETE].some(label => line.startsWith(`[slack] ${label} `)))
afterEach(async () => {
  for (const f of runs.splice(0)) { await f.close(); expect(f.h.clock.pendingCount()).toBe(0); assertNoLeak(f.captured()) }
  _resetAckTracker()
  _resetRegistry()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test.each([false, true])('scan reporting mirrors logged statuses, deduplicates and preserves progress when observer throws=%p', async throws => {
  const reports: Array<{ key: string; status: MembershipScanStatus; ended: boolean; readEnded: boolean; logged: string | undefined }> = []
  const f = fixture({ onScanStatus(key, status, ended) {
    reports.push({ key, status: { ...status }, ended, readEnded: f.scanner.ended(key), logged: scanLines(f).at(-1) })
    if (throws) throw new Error('reporting observer failed')
  } })
  expect(f.scanner.ended('alpha')).toBe(false)
  const checkReports = () => {
    expect(reports.map(({ key, status }) => membershipScanDiagnostic(key, status))).toEqual(scanLines(f))
    for (const report of reports) {
      expect(report.key).toBe('alpha')
      expect(report.logged).toBe(membershipScanDiagnostic(report.key, report.status))
      expect(report.readEnded).toBe(report.ended)
    }
  }
  stub(f).script.inventory.push({ kind: 'platform', error: 'missing_scope' })
  await f.start()
  checkReports()
  expect(reports.length).toBeGreaterThan(0)
  expect(reports.every(report => !report.ended)).toBe(true)
  const scheduled = reports.length
  f.scanner.request('alpha'); f.scanner.request('alpha')
  expect(reports).toHaveLength(scheduled); checkReports()
  await f.scan()
  expect(reports.at(-1)).toMatchObject({ status: { state: 'incomplete', problem: 'access', slackError: 'missing_scope' }, ended: true, readEnded: true })
  checkReports()
  const retryAt = f.scanner.status('alpha').nextAttemptAt!
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advanceTo(retryAt)
  expect(reports.at(-1)).toMatchObject({ status: { state: 'complete', pages: 1, positives: 1 }, ended: true, readEnded: true })
  expect(reading(f).kind).toBe('eligible')
  checkReports()
})

test('durable unresolved history at startup publishes incomplete without an ended scan, then an ended failure', async () => {
  const first = fixture(); await first.start()
  const timestamp = (first.h.clock.now() / 1000).toFixed(3)
  await first.event(true, C.primary, { id: 'EvREPORTCONFLICT', timestamp })
  await first.event(false, C.primary, { id: 'EvREPORTCONFLICT', timestamp })
  expect(reading(first)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  await first.close()
  const reports: Array<{ key: string; status: MembershipScanStatus; ended: boolean; readEnded: boolean }> = []
  const reopened = fixture({ reopen: true, onScanStatus(key, status, ended) {
    reports.push({ key, status: { ...status }, ended, readEnded: reopened.scanner.ended(key) })
  } }, first.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary]))
  await reopened.start()
  expect(stub(reopened).calls.inventory).toEqual([])
  expect(reopened.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'history-unresolved' })
  expect(reports.at(-1)).toMatchObject({ ended: false, readEnded: false })
  const before = reports.length
  reopened.scanner.request('alpha'); reopened.scanner.request('alpha')
  expect(reports).toHaveLength(before)
  await reopened.scan()
  expect(reports.at(-1)).toMatchObject({ status: { state: 'incomplete', problem: 'history-unresolved' }, ended: true, readEnded: true })
  expect(reports.map(({ key, status }) => membershipScanDiagnostic(key, status))).toEqual(scanLines(reopened))
  expect(reading(reopened)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
})

test.each(['open', 'strict'] as const)('authenticated %s join/leave is durable before actual socket ack; duplicate cannot overwrite a later explicit choice', async mode => {
  const f = fixture({ mode, channels: [{ id: C.primary, delivery: 'all' }, { id: C.secondary, delivery: 'off' }] })
  await f.start()
  const s = stub(f), initial = f.authority.revision
  const router = f.h.onEvent
  const atAck: ReturnType<typeof life>[] = []
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    atAck.push(readSharedState(f.stateDir)!.personas.alpha!)
    await payload.ack()
  } }, provenance)
  const joinEvent = { id: 'EvJOIN', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  await f.event(true, C.primary, joinEvent)
  expect(s.socket.acks).toHaveLength(1)
  expect(atAck).toHaveLength(1)
  expect(atAck[0]!.membershipEvidence!.EvJOIN).toMatchObject({ state: 'applied', member: true })
  expect(atAck[0]!.membershipEvents.EvJOIN).toEqual(life(f).membershipEvents.EvJOIN)
  expect(f.authority.revision).toBe(initial + 1)
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'current-membership-missing' })
  expect(s.calls.inventory).toHaveLength(0)
  const joined = life(f).membershipEvents.EvJOIN
  const inventory = makeDeferredWebApiCall()
  s.script.inventory.push(inventory.outcome)
  await f.scan()
  expect(s.calls.inventory).toHaveLength(1)
  expect(reading(f).kind).toBe('unresolved')
  inventory.settle(membershipPage([C.primary])); await f.h.clock.flush()
  expect(reading(f).kind).toBe('eligible')
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(life(f).membershipEvents.EvJOIN).toEqual(joined)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  await f.event(true, C.primary, joinEvent)
  expect(life(f).membershipEvents.EvJOIN).toEqual(joined)
  expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  await f.event(false, C.primary, { id: 'EvLEAVE', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(s.socket.acks).toHaveLength(3)
  expect(atAck).toHaveLength(3)
  expect(atAck[2]!.membershipEvidence!.EvLEAVE).toMatchObject({ state: 'applied', member: false })
  expect(atAck[2]!.membershipEvents.EvLEAVE).toEqual(life(f).membershipEvents.EvLEAVE)
  expect(atAck[2]!.assignments[C.primary]).toBeUndefined()
  expect(atAck[2]!.leaves[C.primary]).toEqual(life(f).leaves[C.primary])
  expect(life(f).assignments[C.primary]).toBeUndefined()
  expect(life(f).assignments[C.secondary]?.delivery).toBe('off')
  const boundary = f.membership.lifetime('alpha', C.primary)!
  expect(boundary.leaveBoundary).toBeGreaterThan(0)
  expect(f.assign(C.primary, 'thread_hybrid').kind).toBe('applied')
  await f.event(false, C.primary, { id: 'EvLEAVE', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(life(f).assignments[C.primary]?.delivery).toBe('thread_hybrid')
  expect(f.membership.lifetime('alpha', C.primary)).toEqual(boundary)
})

test.each(['foreign-team', 'foreign-app', 'other-user', 'no-authorization', 'bad-id', 'bad-channel'] as const)('%s event is ignored without an effect or a recovery obligation', async kind => {
  const f = fixture(); await f.start(); const before = f.authority.snapshot()
  await f.event(true, C.primary, {
    ...(kind === 'bad-id' ? { id: 'not an event ID' } : {}),
    event: kind === 'other-user' ? { user: 'U0OTHER' } : kind === 'bad-channel' ? { channel: 'invalid' } : {},
    envelope: kind === 'foreign-team' ? { team_id: 'T0OTHER' } : kind === 'foreign-app' ? { api_app_id: 'A0OTHER' } : kind === 'no-authorization' ? { authorizations: [] } : {},
  })
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(f.authority.snapshot()).toEqual(before)
  expect(f.membership.unresolvedChannels('alpha')).toEqual([])
})

test.each([
  ['join', true, 'effects'], ['join', true, 'both'], ['leave', false, 'effects'], ['leave', false, 'both'],
] as const)('%s with %s membership and %s persistence failure: ack requires durable recovery; duplicate undurable observations remain unacked', async (_direction, member, failure) => {
  const f = fixture(); await f.start()
  const event = { id: 'EvFAIL', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  const router = f.h.onEvent, atAck: ReturnType<typeof life>[] = []
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    atAck.push(readSharedState(f.stateDir)!.personas.alpha!)
    await payload.ack()
  } }, provenance)
  f.failWrites(state => failure === 'both' || state.personas.alpha?.membershipEvidence?.EvFAIL?.state === 'applied')
  await f.event(member, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(failure === 'effects' ? 1 : 0)
  expect(reading(f).kind).toBe('unresolved')
  await f.event(member, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(failure === 'effects' ? 2 : 0)
  expect(atAck).toHaveLength(failure === 'effects' ? 2 : 0)
  for (const disk of atAck) {
    expect(disk.membershipEvidence!.EvFAIL).toMatchObject({ event: event.id, channel: C.primary, member, timestamp: event.timestamp, state: 'pending' })
    expect(disk.membershipEvents.EvFAIL).toBeUndefined()
  }
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.scan()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(reading(f).kind).toBe('unresolved')
  expect(stub(f).socket.acks).toHaveLength(failure === 'effects' ? 2 : 0)
  f.failWrites(() => false)
  await f.event(member, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(failure === 'effects' ? 3 : 1)
  expect(atAck.at(-1)!.membershipEvidence!.EvFAIL).toMatchObject({ state: 'applied', member })
  expect(atAck.at(-1)!.membershipEvents.EvFAIL).toEqual(life(f).membershipEvents.EvFAIL)
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  const recovered = life(f).membershipEvents.EvFAIL
  expect(Object.values(life(f).membershipEvents).filter(e => e.channel === C.primary)).toHaveLength(1)
  const next = f.scanner.status('alpha').nextAttemptAt!
  expect(next - f.h.clock.now()).toBe(MEMBERSHIP_RETRY_MIN_MS)
  await f.h.clock.advanceTo(next - 1)
  expect(stub(f).calls.inventory).toHaveLength(1)
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advance(1)
  expect(stub(f).calls.inventory).toHaveLength(2)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f).kind).toBe('eligible')
  expect(life(f).membershipEvents.EvFAIL).toEqual(recovered)
})

test('a later recovery write durably protects its unsaved predecessor; idle scan resolves the chain', async () => {
  const f = fixture(); await f.start()
  f.failWrites(() => true)
  await f.event(true, C.primary, { id: 'EvFIRST' })
  expect(stub(f).socket.acks).toHaveLength(0)
  f.failWrites(() => false)
  await f.event(false, C.primary, { id: 'EvSECOND', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(Object.keys(life(f).membershipEvidence!)).toEqual(['EvFIRST', 'EvSECOND'])
  stub(f).script.inventory.push(membershipPage([]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS + 1)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
  expect(life(f).assignments[C.primary]).toBeUndefined()
})

test('crash after durable handling before socket ack replays one order and honors a precrash leave before startup rejoin', async () => {
  const f = fixture(); await f.start(); await f.event(true)
  f.assign(C.primary, 'off')
  f.failWrites(state => state.personas.alpha?.membershipEvidence?.EvCRASH?.state === 'applied')
  const router = f.h.onEvent
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => { throw new Error('disconnected before ack') } }, provenance)
  await f.event(false, C.primary, { id: 'EvCRASH', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(life(f).membershipEvidence?.EvCRASH?.state).toBe('pending')
  await f.close()
  const reopened = fixture({ reopen: true }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary]))
  await reopened.start()
  expect(life(reopened).assignments[C.primary]).toBeUndefined()
  expect(reading(reopened).kind).toBe('unresolved')
  const leave = life(reopened).membershipEvents.EvCRASH
  expect(leave?.member).toBe(false)
  await reopened.scan()
  expect(reading(reopened).kind).toBe('eligible')
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('mentions')
  await reopened.event(false, C.primary, { id: 'EvCRASH', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(life(reopened).membershipEvents.EvCRASH).toEqual(leave)
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('mentions')
})

test.each(['unique-overlap', 'contradictory-id'] as const)('%s history: responsive idle inventory resolves provable conflict and holds unprovable history', async kind => {
  const f = fixture(); await f.start()
  const timestamp = (f.h.clock.now() / 1000).toFixed(3)
  await f.event(true, C.primary, { id: 'EvORIGINAL', timestamp })
  f.assign(C.primary, 'off')
  await f.event(false, C.primary, { id: kind === 'contradictory-id' ? 'EvORIGINAL' : 'EvCONFLICT', timestamp })
  expect(reading(f).kind).toBe('unresolved')
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  if (kind === 'unique-overlap') {
    expect(f.scanner.status('alpha').state).toBe('complete')
    expect(reading(f).kind).toBe('eligible')
    expect(life(f).leaves[C.primary]?.boundary).toBeGreaterThan(0)
    expect(life(f).assignments[C.primary]?.delivery).toBe('mentions')
  } else {
    expect(f.scanner.status('alpha').problem).toBe('history-unresolved')
    expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
    expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  }
})

test('pagination includes empty nonterminal pages and public/private membership without is_member; positives release before the final page', async () => {
  const f = fixture({ channels: [{ id: C.secondary, delivery: 'off' }] })
  const last = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.primary], 'next'), membershipPage([], 'last'), last.outcome)
  await f.start(); await f.scan()
  expect(stub(f).calls.inventory).toEqual([undefined, 'next', 'last'].map(cursor => ({
    types: 'public_channel,private_channel', limit: MEMBERSHIP_PAGE_LIMIT, team_id: stub(f).identity.teamId, ...(cursor ? { cursor } : {}),
  })))
  expect(reading(f).kind).toBe('eligible')
  expect(reading(f, C.secondary).kind).toBe('unresolved')
  expect(f.scanner.status('alpha').state).toBe('scanning')
  last.settle(membershipPage([C.private])); await f.h.clock.flush()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'complete', pages: 3, positives: 2 })
  expect(reading(f, C.private).kind).toBe('eligible')
  expect(life(f).assignments[C.secondary]?.delivery).toBe('off')
})

test.each(['malformed', 'access', 'deadline', 'repeated-cursor'] as const)('%s partial inventory cannot establish absence of historical membership', async kind => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  const inventory = life(f).membershipInventory
  f.assign(C.primary, 'all')
  f.scanner.connectionChanged('alpha')
  stub(f).script.inventory.push(kind === 'malformed' ? { kind: 'ok', result: { channels: undefined } } :
    kind === 'access' ? { kind: 'platform', error: 'missing_scope' } : kind === 'deadline' ? { kind: 'never' } : membershipPage([], 'again'))
  if (kind === 'repeated-cursor') stub(f).script.inventory.push(membershipPage([], 'again'))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  if (kind === 'deadline') await f.h.clock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS)
  expect(f.scanner.status('alpha').state).toBe('incomplete')
  expect(life(f).assignments[C.primary]?.delivery).toBe('all')
  expect(life(f).membership[C.primary]?.member).toBe(true)
  expect(life(f).membershipInventory).toEqual(inventory)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipInventory).toEqual(inventory)
  expect(reading(f).kind).toBe('unresolved')
})

test.each(['off', 'mentions', 'all', 'thread_hybrid'] as const)('complete absence removes historical %s once; fresh future assignment survives repeated absence and restart', async delivery => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  f.assign(C.primary, delivery)
  f.scanner.connectionChanged('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(life(f).assignments[C.primary]).toBeUndefined()
  const leave = life(f).leaves[C.primary]
  f.assign(C.primary, delivery)
  f.scanner.request('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(life(f).assignments[C.primary]?.delivery).toBe(delivery)
  expect(life(f).leaves[C.primary]).toEqual(leave)
  await f.close()
  const reopened = fixture({ reopen: true }, f.stateDir); await reopened.start(); await reopened.scan()
  expect(life(reopened).assignments[C.primary]?.delivery).toBe(delivery)
  expect(life(reopened).leaves[C.primary]).toEqual(leave)
})

test.each(['missing_scope', 'access_denied', 'invalid_auth', 'token_revoked'] as const)('real watched manager repairs membership-origin %s while idle using applied credentials only', async error => {
  const f = fixture({ realBringUp: true }); stub(f).script.inventory.push({ kind: 'platform', error }); await f.start(); await f.scan()
  expect(f.scanner.status('alpha').state).toBe('incomplete')
  if (error === 'invalid_auth' || error === 'token_revoked') expect(f.h.manager.status('alpha')?.state).toBe('broken')
  expect(reading(f).kind).toBe('unresolved')
  const starts = stub(f).calls.inventory.length, validations = stub(f).calls.authTest.length
  expect(f.bringUps.state('alpha')?.outcome).toBe(error === 'invalid_auth' || error === 'token_revoked' ? 'broken' : 'up')
  const digest = f.bringUps.credentialsDigest('alpha')
  const { writeCredentialsFile, fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX } = await import('./test-helpers/credentials.ts')
  writeCredentialsFile(f.stateDir, 'personas/alpha/credentials.json', { bot_token: fakeToken(BOT_TOKEN_PREFIX, 'pending-unconfirmed'), app_token: fakeToken(APP_TOKEN_PREFIX, 'pending-unconfirmed') })
  const next = f.scanner.status('alpha').nextAttemptAt!
  expect(next - f.h.clock.now()).toBeGreaterThanOrEqual(MEMBERSHIP_RETRY_MIN_MS)
  await f.h.clock.advanceTo(next - 1)
  expect(stub(f).calls.inventory).toHaveLength(starts)
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advance(1)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(stub(f).calls.authTest.length).toBeGreaterThan(validations)
  expect(f.h.manager.status('alpha')?.state).toBe('up')
  expect(f.bringUps.state('alpha')?.outcome).toBe('up')
  expect(f.bringUps.credentialsDigest('alpha')).toEqual(digest)
  expect(reading(f).kind).toBe('eligible')
  expect(f.h.slack.builds.every(build => build.hasToken(build.kind === 'socket' ? f.h.tokens(f.h.p('alpha')).appToken : f.h.tokens(f.h.p('alpha')).botToken))).toBe(true)
})

test.each(['revoked', 'admission', 'identity'] as const)('%s blocks manager-owned credential repair without granting membership', async cause => {
  const f = fixture(); stub(f).script.inventory.push({ kind: 'platform', error: 'invalid_auth' }); await f.start(); await f.scan()
  if (cause === 'revoked') stub(f).script.authTest.push({ kind: 'platform', error: 'token_revoked' })
  if (cause === 'admission') f.allowAdmission(false)
  if (cause === 'identity') stub(f).script.botsInfo.push({ kind: 'ok', result: { bot: { id: stub(f).identity.botId, user_id: stub(f).identity.botUserId, app_id: 'A0OTHER' } } })
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(f.scanner.status('alpha').state).toBe('incomplete')
  expect(reading(f).kind).toBe('unresolved')
  expect(stub(f).calls.inventory).toHaveLength(1)
  expect(f.h.manager.status('alpha')?.state).toBe('broken')
})

test.each(['first', 'later'] as const)('%s-page hang expires at the request deadline, ignores late response, retries on the exact minimum', async page => {
  const f = fixture(), held = makeDeferredWebApiCall()
  if (page === 'later') stub(f).script.inventory.push(membershipPage([C.secondary], 'next'))
  stub(f).script.inventory.push(held.outcome)
  await f.start(); await f.scan()
  const started = f.h.clock.now(), count = stub(f).calls.inventory.length
  await f.h.clock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS - 1)
  expect(f.scanner.status('alpha').state).toBe('scanning')
  await f.h.clock.advance(1)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'deadline', nextAttemptAt: started + MEMBERSHIP_REQUEST_TIMEOUT_MS + MEMBERSHIP_RETRY_MIN_MS })
  expect(reading(f).kind).toBe('unresolved')
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS - 1)
  expect(stub(f).calls.inventory).toHaveLength(count)
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advance(1)
  expect(stub(f).calls.inventory).toHaveLength(count + 1)
  expect(reading(f).kind).toBe('eligible')
  const recovered = f.authority.snapshot(), status = f.scanner.status('alpha')
  expect(status.state).toBe('complete')
  // An abandoned empty page arriving after recovery cannot revoke the newer
  // positive or publish stale absence/completeness.
  held.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.authority.snapshot()).toEqual(recovered)
  expect(f.scanner.status('alpha')).toEqual(status)
  expect(reading(f).kind).toBe('eligible')
})

test('longer Retry-After governs actual start; discovery client disables internal retries and carries cancellation', async () => {
  const f = fixture(), retryAfter = MEMBERSHIP_RETRY_MAX_MS / 1000 + 7
  stub(f).script.inventory.push({ kind: 'rate-limited', retryAfter })
  await f.start(); await f.scan()
  expect(f.scanner.status('alpha').retryAfterSeconds).toBe(retryAfter)
  const next = f.scanner.status('alpha').nextAttemptAt!
  expect(next - f.h.clock.now()).toBe(retryAfter * 1000)
  const options = stub(f).options.web.at(-1)!.options!
  expect(options.retryConfig).toEqual({ retries: 0 })
  expect(options.rejectRateLimitedCalls).toBe(true)
  const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
  await f.event(true, C.primary, { id: 'EvRATEJOIN', timestamp })
  await f.event(false, C.primary, { id: 'EvRATELEAVE', timestamp })
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'event-order-conflict', nextAttemptAt: next, retryAfterSeconds: retryAfter })
  const before = f.authority.snapshot()
  await f.h.clock.advanceTo(next - 1); expect(stub(f).calls.inventory).toHaveLength(1)
  expect(f.authority.snapshot()).toEqual(before)
  expect(reading(f).kind).toBe('unresolved')
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advance(1); expect(stub(f).calls.inventory).toHaveLength(2)
  expect(reading(f).kind).toBe('eligible')
  expect(f.scanner.status('alpha').state).toBe('complete')
})

test('responsive pagination still expires at the end-to-end attempt deadline and never proves absence', async () => {
  const f = fixture({ channels: [{ id: C.primary, delivery: 'off' }] })
  const pages = Array.from({ length: Math.ceil(MEMBERSHIP_ATTEMPT_TIMEOUT_MS / (MEMBERSHIP_REQUEST_TIMEOUT_MS - 1)) + 1 }, () => makeDeferredWebApiCall())
  stub(f).script.inventory.push(...pages.map(page => page.outcome))
  await f.start(); await f.scan()
  const deadline = f.scanner.status('alpha').deadline!
  let index = 0
  while (f.h.clock.now() + MEMBERSHIP_REQUEST_TIMEOUT_MS < deadline) {
    await f.h.clock.advance(MEMBERSHIP_REQUEST_TIMEOUT_MS - 1)
    pages[index]!.settle(membershipPage([], `page-${++index}`)); await f.h.clock.flush()
    expect(stub(f).calls.inventory).toHaveLength(index + 1)
  }
  await f.h.clock.advanceTo(deadline - 1)
  expect(f.scanner.status('alpha').state).toBe('scanning')
  await f.h.clock.advance(1)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'deadline', pages: index, nextAttemptAt: deadline + MEMBERSHIP_RETRY_MIN_MS })
  pages[index]!.settle(membershipPage([])); await f.h.clock.flush()
  expect(reading(f).kind).toBe('unresolved')
  expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  expect(stub(f).calls.inventory).toHaveLength(index + 1)
})

test.each(['working-directory', 'claude-config-directory'] as const)('real bring-up %s admission is checked again before membership credential repair', async missing => {
  const f = fixture({ realBringUp: true })
  stub(f).script.inventory.push({ kind: 'platform', error: 'invalid_auth' })
  await f.start(); await f.scan()
  const path = missing === 'working-directory' ? f.h.p('alpha').working_directory : join(f.stateDir, '.claude')
  rmSync(path, { recursive: true, force: true })
  if (missing === 'claude-config-directory') symlinkSync(join(f.stateDir, 'missing-config-target'), path)
  const calls = stub(f).calls.authTest.length
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(stub(f).calls.authTest).toHaveLength(calls)
  expect(stub(f).calls.inventory).toHaveLength(1)
  expect(f.h.manager.status('alpha')?.state).toBe('broken')
  expect(reading(f).kind).toBe('unresolved')
  rmSync(path, { recursive: true, force: true }); mkdirSync(path, { recursive: true })
  stub(f).script.inventory.push(membershipPage([C.primary]))
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(f.bringUps.state('alpha')?.outcome).toBe('up')
  expect(reading(f).kind).toBe('eligible')
})

test('shutdown during membership revalidation rejects late successful authentication without opening a replacement socket', async () => {
  const f = fixture({ realBringUp: true }), held = makeDeferredWebApiCall()
  stub(f).script.inventory.push({ kind: 'platform', error: 'invalid_auth' })
  await f.start(); await f.scan()
  stub(f).script.authTest.push(held.outcome)
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  const sockets = stub(f).sockets.length
  await f.close()
  const before = f.authority.snapshot()
  held.settle(); await f.h.clock.flush()
  expect(stub(f).sockets).toHaveLength(sockets)
  expect(f.h.manager.status('alpha')).toBeUndefined()
  expect(f.authority.snapshot()).toEqual(before)
  expect(f.h.clock.pendingCount()).toBe(0)
})

test.each(['gap', 'leave', 'reset', 'shutdown'] as const)('%s cancels late inventory authority and obsolete retry work', async boundary => {
  const f = fixture(), held = makeDeferredWebApiCall(); stub(f).script.inventory.push(held.outcome)
  await f.start(); await f.scan()
  if (boundary === 'gap') f.scanner.connectionChanged('alpha')
  if (boundary === 'leave') await f.event(false)
  if (boundary === 'reset') {
    // A reviewed identity boundary uses the production config writer below.
    const { makePersona, makePersonaConfigInput } = await import('./test-helpers/persona-config.ts')
    expect(f.authority.applyReviewed(configBytes(makePersonaConfigInput({ channel_mode: 'open', personas: [makePersona({ name: 'alpha', working_directory: join(f.stateDir, 'replacement'), channels: [], dm: { enabled: true, contact: 'U0OPERATOR' }, permission_prompts: 'dm' }, f.stateDir)] }, f.stateDir)), f.authority.revision).kind).toBe('applied')
  }
  if (boundary === 'shutdown') await f.close()
  const before = f.authority.snapshot()
  held.settle(membershipPage([C.primary])); await f.h.clock.flush()
  expect(f.authority.snapshot()).toEqual(before)
  expect(life(f).membershipInventory).toBeUndefined()
  expect(reading(f).kind).not.toBe('eligible')
  if (boundary === 'reset' || boundary === 'shutdown') { await f.h.clock.advance(MEMBERSHIP_RETRY_MAX_MS); expect(stub(f).calls.inventory).toHaveLength(1) }
})

test('dry start/restart preserves choices and pending intent with no clients, inventory, timers or fresh tool authority', async () => {
  const f = fixture({ dryRun: true, channels: [{ id: C.primary, delivery: 'all' }] })
  f.authority.transact(f.authority.revision, state => { state.pendingIntent = { reviewed: 'keep' } })
  const before = f.authority.snapshot()
  await f.start(); f.scanner.request('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MAX_MS)
  expect(f.h.slack.builds).toEqual([]); expect(f.h.clock.pendingCount()).toBe(0)
  expect(reading(f).kind).toBe('unresolved'); expect(f.scanner.status('alpha').state).toBe('unverified')
  expect(f.authority.snapshot()).toEqual(before)
  await f.close()
  const reopened = fixture({ dryRun: true, reopen: true }, f.stateDir); await reopened.start()
  expect(reopened.authority.snapshot()).toEqual(before); expect(reopened.h.slack.builds).toEqual([])
})

test('retained recipient gets original queued feedback while another membership hold suppresses aggregate ack; replay retains once and a callback retry uses the original emoji', async () => {
  _resetAckTracker()
  const f = fixture({ names: ['alpha', 'beta'], queuedAckReaction: 'hourglass', mode: 'strict', channels: [{ id: C.primary, delivery: 'all' }] })
  const held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.primary])); stub(f, 'beta').script.inventory.push(held.outcome)
  await f.start(); await f.scan()
  const { createQueuedAckCallback, createDeliveryAckCallback } = await import('../src/ack-tracker.ts')
  const { makeEngineHarness } = await import('./test-helpers/delivery-engine.ts')
  let received!: ReturnType<typeof createQueuedAckCallback>
  const pending: Promise<void>[] = []
  const managed = makeManagedRouting(f.h, f.stateDir, { membership: f.membership, getChannelDelivery: () => createChannelDeliveryStore(f.authority), onReceived: (key, item) => { pending.push(received(key, item)) } })
  let clientAvailable = true
  const clientFor = (key: string) => clientAvailable ? f.h.clientFor(key) : undefined
  received = createQueuedAckCallback({ queue: managed.queue, clientFor, getReaction: () => 'hourglass' })
  const delivered = createDeliveryAckCallback({ queue: managed.queue, clientFor, getReaction: () => 'eyes' })
  const e = await makeEngineHarness({ stateDir: f.stateDir, queue: managed.queue, keys: ['alpha', 'beta'], onEvent: event => {
    if (event.type === 'item-delivered') pending.push(delivered(event.key, managed.queue.items(event.key).find(item => item.accepted.seq === event.seq)!))
  } })
  const realNow = Date.now
  try {
    await managed.ready
    Date.now = f.h.clock.now
    f.h.config!.queued_ack_reaction = 'hourglass'
    const text = '  <@U0MEMBER0> quoted > and repeated <@U0MEMBER0> 😀\r\n\r\nlast  '
    const ts = '1700000000.000001', user = 'U0SENDER1', keys = ['alpha', 'beta']
    const files = [{ name: 'kept.txt', mimetype: 'text/plain', size: 7 }]
    const event = makeChannelMessage({ channel: C.primary, ts, user, text, files: [{ id: 'F0ATTACH', ...files[0] }] })
    const alpha: AcceptedRecord = { v: 1, kind: 'accepted', seq: 1, source: 'slack', key: { chat_id: C.primary, ts },
      channel: C.primary, channel_type: 'channel', ts, user, text, files, via: 'mention',
      received_at: f.h.clock.now(), queued_ack_reaction: 'hourglass' }
    const atAck: Array<Array<{ persona: string; records: ReturnType<typeof e.records> }>> = []
    let acks = 0
    const durableAccepted = () => keys.map(persona => ({ persona, records: e.records(persona).filter(record => record.kind === 'accepted') }))
    const ack = () => { atAck.push(durableAccepted()); acks++ }
    await managed.routing.receive(event, ack, keys, false)
    await Promise.all(pending)
    expect(acks).toBe(0); expect(atAck).toEqual([]); expect(managed.queued('beta')).toEqual([])
    expect(managed.queued('alpha').map(item => item.accepted)).toEqual([alpha])
    expect(e.records('alpha').filter(record => record.kind === 'accepted')).toEqual([alpha])
    expect(stub(f).calls.reactionsAdd).toEqual([{ channel: C.primary, timestamp: ts, name: 'hourglass' }])
    expect(stub(f, 'beta').calls.reactionsAdd).toEqual([])
    held.settle(membershipPage([C.primary])); await f.h.clock.flush()
    await f.h.clock.advance(1)
    const beta: AcceptedRecord = { ...alpha, via: 'receive_all_shared', received_at: f.h.clock.now() }
    const expected = [{ persona: 'alpha', records: [alpha] }, { persona: 'beta', records: [beta] }]
    await managed.routing.receive(event, ack, keys, false); await Promise.all(pending)
    expect(acks).toBe(1); expect(atAck).toEqual([expected])
    expect(keys.map(persona => ({ persona, records: managed.queued(persona).map(item => item.accepted) }))).toEqual(expected)
    expect(durableAccepted()).toEqual(expected)
    for (const key of keys) expect(stub(f, key).calls.reactionsAdd).toEqual([{ channel: C.primary, timestamp: ts, name: 'hourglass' }])
    // A retained duplicate still owes a durable unresolved membership boundary.
    f.failWrites(() => true); await f.event(false, C.primary)
    await managed.routing.receive(event, ack, keys, false)
    expect(acks).toBe(1); expect(atAck).toEqual([expected])
    expect(keys.map(persona => ({ persona, records: managed.queued(persona).map(item => item.accepted) }))).toEqual(expected)
    expect(durableAccepted()).toEqual(expected)
    f.failWrites(() => false)
    // Accepted work remains deliverable while new membership is held, solely under AD waiting.
    clientAvailable = false
    for (const key of ['alpha', 'beta']) { e.p(key).row.state = 'waiting'; await e.tick(key) }
    await e.until(() => managed.queue.openCount('alpha') === 0 && managed.queue.openCount('beta') === 0)
    await Promise.all(pending)
    for (const key of keys) {
      expect(stub(f, key).calls.reactionsRemove).toEqual([])
      expect(stub(f, key).calls.reactionsAdd).toEqual([{ channel: C.primary, timestamp: ts, name: 'hourglass' }])
    }
    clientAvailable = true; f.h.config!.queued_ack_reaction = 'changed'
    for (const key of ['alpha', 'beta']) await delivered(key, managed.queued(key)[0]!)
    for (const key of ['alpha', 'beta']) {
      expect(stub(f, key).calls.reactionsRemove).toEqual([{ channel: C.primary, timestamp: ts, name: 'hourglass' }])
      expect(stub(f, key).calls.reactionsAdd).toEqual(['hourglass', 'eyes'].map(name => ({ channel: C.primary, timestamp: ts, name })))
      expect(stub(f, key).callLog.filter(call => call.method.startsWith('reactions.')).map(call => call.method)).toEqual(['reactions.add', 'reactions.remove', 'reactions.add'])
    }
    expect(durableAccepted()).toEqual(expected)
    assertNoLeak({ logs: managed.logs, errors: e.errors, events: e.events, journal: writtenFile(join(f.stateDir, 'queue')) })
  } finally { Date.now = realNow; await Promise.allSettled(pending); await e.cleanup(); await managed.close(); _resetAckTracker() }
})

test('message routed from real socket cannot supply missing membership or wait for a lookup', async () => {
  const f = fixture({ mode: 'strict', channels: [{ id: C.primary, delivery: 'all' }] })
  stub(f).script.inventory.push({ kind: 'never' }); await f.start(); await f.scan()
  const managed = makeManagedRouting(f.h, f.stateDir, { membership: f.membership, getChannelDelivery: () => createChannelDeliveryStore(f.authority) })
  f.h.onEvent = createPersonaEventRouter({ membership: f.membership, routing: managed.routing, clientFor: f.h.clientFor, getPersona: f.h.getPersona, log: line => managed.logs.push(line) })
  try {
    await stub(f).socket.deliver(makeChannelMessage({ channel: C.primary }))
    expect(stub(f).socket.acks).toHaveLength(0); expect(managed.queued('alpha')).toEqual([])
    expect(stub(f).calls.inventory).toHaveLength(1)
    expect(stub(f).calls.conversationsInfo).toHaveLength(0)
    expect(reading(f).kind).toBe('unresolved')
    assertNoLeak(managed.logs)
  } finally { await managed.close() }
})

test('same-installation replacement preserves preference but requires new discovery and rejects stale issuing provenance', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan(); f.assign(C.primary, 'off')
  const { PersonaSlackTokens } = await import('../src/persona-credentials.ts')
  const { fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX, LEAK_SENTINEL } = await import('./test-helpers/credentials.ts')
  const tokens = new PersonaSlackTokens(fakeToken(BOT_TOKEN_PREFIX, 'replacement'), fakeToken(APP_TOKEN_PREFIX, 'replacement'))
  const fresh = f.h.slack.addCredentials('alpha', 'replacement', tokens, { ...stub(f).identity, appId: 'A0MEMBER0', leakMarker: LEAK_SENTINEL })
  const old = f.h.manager.provenance('alpha')!, oldSocket = stub(f).socket
  const router = f.h.onEvent
  let captured: Parameters<typeof router>[2] | undefined
  f.h.onEvent = (_key, _name, payload) => { captured = payload }
  // Capture a valid authenticated envelope and its real socket ack, delayed
  // in flight until after the replacement becomes current.
  await f.event(false, C.primary, { id: 'EvDELAYED', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) })
  expect(stub(f).socket.acks).toHaveLength(0)
  f.h.onEvent = router
  await f.h.manager.reconnectCredentials('alpha', tokens)
  expect(old.isCurrent()).toBe(false); expect(reading(f).kind).toBe('unresolved')
  expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  const revision = f.authority.revision
  let ackAttempts = 0
  await router('alpha', 'channel_left', { ...captured!, ack: async () => { ackAttempts++; await captured!.ack() } }, old)
  expect(ackAttempts).toBe(1)
  expect(oldSocket.acks).toHaveLength(0) // The retired socket cannot transmit the attempted ack.
  expect(f.authority.revision).toBe(revision)
  fresh.script.inventory.push(membershipPage([C.primary])); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(reading(f).kind).toBe('eligible'); expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  // The same valid shape on the current binding really removes the choice.
  await fresh.socket.deliver({ type: 'channel_left', channel: C.primary, event_ts: ((f.h.clock.now() + 1) / 1000).toFixed(3) }, { event_id: 'EvCURRENT' })
  expect(fresh.socket.acks).toHaveLength(1)
  expect(life(f).assignments[C.primary]).toBeUndefined()
  expect(life(f).membershipEvents.EvCURRENT?.member).toBe(false)
})

test('metadata validation hang stays inside the manager deadline; late completion cannot publish a socket or membership', async () => {
  const f = fixture(), metadata = makeDeferredWebApiCall()
  stub(f).script.botsInfo.push(metadata.outcome)
  const start = f.start(); await f.h.clock.flush()
  const { SLACK_AUTH_TEST_TIMEOUT_MS } = await import('../src/persona-slack-validation.ts')
  await f.h.clock.advance(SLACK_AUTH_TEST_TIMEOUT_MS)
  await start
  expect(f.h.manager.status('alpha')?.state).not.toBe('up')
  expect(stub(f).sockets).toHaveLength(0)
  metadata.settle({ kind: 'ok', result: { bot: { id: stub(f).identity.botId, user_id: stub(f).identity.botUserId, app_id: 'A0MEMBER0' } } })
  await f.h.clock.flush()
  expect(stub(f).sockets).toHaveLength(0); expect(reading(f).kind).toBe('unresolved')
})

test.each(['same', 'foreign'] as const)('%s installation candidate socket cannot mutate assignments before credential swap', async installation => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan(); f.assign(C.primary, 'off')
  const { PersonaSlackTokens } = await import('../src/persona-credentials.ts')
  const { fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX, LEAK_SENTINEL } = await import('./test-helpers/credentials.ts')
  const tokens = new PersonaSlackTokens(fakeToken(BOT_TOKEN_PREFIX, 'candidate'), fakeToken(APP_TOKEN_PREFIX, 'candidate'))
  const fresh = f.h.slack.addCredentials('alpha', 'candidate', tokens, { ...stub(f).identity,
    appId: installation === 'same' ? 'A0MEMBER0' : 'A0OTHER', leakMarker: LEAK_SENTINEL })
  let delivery: Promise<void> | undefined
  let insideChoice: string | undefined
  await f.h.manager.reconnectCredentials('alpha', tokens, undefined, () => {
    delivery = fresh.socket.deliver({ type: 'channel_left', channel: C.primary, event_ts: ((f.h.clock.now() + 1) / 1000).toFixed(3) }, { event_id: 'EvCANDIDATE' })
    insideChoice = life(f).assignments[C.primary]?.delivery
  })
  await delivery
  expect(insideChoice).toBe('off'); expect(fresh.socket.acks).toHaveLength(1)
  expect(life(f).membershipEvidence?.EvCANDIDATE?.state).toBe(installation === 'same' ? 'conflict' : undefined)
  expect(reading(f).kind).toBe('unresolved')
})

test('unevidenced downtime leave/rejoin does not invent a reset; current inventory revalidates the retained preference', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan(); f.assign(C.primary, 'thread_hybrid')
  const boundary = f.membership.lifetime('alpha', C.primary)
  await f.close()
  const reopened = fixture({ reopen: true }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(reading(reopened).kind).toBe('eligible')
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('thread_hybrid')
  expect(reopened.membership.lifetime('alpha', C.primary)).toEqual(boundary)
})

test('external memberships are retained but ineligible in open mode; missing metadata never authorizes a fresh assignment', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([
    { id: C.primary, is_channel: true, is_im: false, is_mpim: false, is_ext_shared: true }, { id: C.secondary },
  ])); await f.start(); await f.scan()
  expect(life(f).membership[C.primary]?.member).toBe(true)
  expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'external-sharing' })
  expect(reading(f, C.secondary)).toEqual({ kind: 'unresolved', reason: 'eligibility-missing' })
  expect(f.scanner.status('alpha').problem).toBe('eligibility-missing')
})

test.each([
  ['join-leave / present', 'join-leave', true], ['join-leave / absent', 'join-leave', false],
  ['leave-join / present', 'leave-join', true], ['leave-join / absent', 'leave-join', false],
] as const)('source regression: coarse overlap %s is durable before ack and reconciles without inventing history', async (_name, direction, present) => {
  const f = fixture(); await f.start()
  const seconds = Math.floor(f.h.clock.now() / 1000)
  const preciseJoin = () => f.event(true, C.primary, { id: 'EvPRECISE', timestamp: `${seconds}.500` })
  const coarseLeave = () => f.event(false, C.primary, { id: 'EvCOARSE', event: { event_ts: undefined }, envelope: { event_time: seconds } })
  const first = direction === 'join-leave' ? preciseJoin : coarseLeave
  const second = direction === 'join-leave' ? coarseLeave : preciseJoin
  const secondId = direction === 'join-leave' ? 'EvCOARSE' : 'EvPRECISE'
  const durableAtAck: Array<ReturnType<typeof readSharedState>> = []
  const router = f.h.onEvent
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async (...args) => {
    durableAtAck.push(readSharedState(f.stateDir))
    await payload.ack(...args)
  } }, provenance)
  await first()
  f.assign(C.primary, 'off')
  const initialLeave = life(f).leaves[C.primary]
  await second()
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(durableAtAck).toHaveLength(2)
  expect(durableAtAck[1]!.personas.alpha!.membershipEvidence?.[secondId]?.state).toBe('conflict')
  expect(life(f).membershipEvidence?.[secondId]?.state).toBe('conflict')
  expect(reading(f).kind).toBe('unresolved')
  expect(stub(f).calls.inventory).toHaveLength(0)
  // A scan beginning inside the coarse second cannot order the history yet.
  stub(f).script.inventory.push(membershipPage(present ? [C.primary] : []))
  await f.scan()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'event-order-conflict' })
  const next = f.scanner.status('alpha').nextAttemptAt!
  expect(next - f.h.clock.now()).toBe(MEMBERSHIP_RETRY_MIN_MS)
  await f.h.clock.advanceTo(next - 1)
  expect(reading(f).kind).toBe('unresolved')
  expect(stub(f).calls.inventory).toHaveLength(1)
  stub(f).script.inventory.push(membershipPage(present ? [C.primary] : []))
  await f.h.clock.advance(1)
  expect(stub(f).calls.inventory).toHaveLength(2)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f).kind).toBe(present ? 'eligible' : 'ineligible')
  if (!present) expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
  if (direction === 'leave-join') {
    expect(life(f).leaves[C.primary]).toEqual(initialLeave)
    expect(life(f).membershipEvidence?.EvPRECISE?.state).toBe('superseded')
    expect(life(f).assignments[C.primary]?.delivery).toBe('off')
  } else {
    expect(life(f).leaves[C.primary]?.boundary).toBeGreaterThan(0)
    if (present) expect(life(f).assignments[C.primary]?.delivery).toBe('mentions')
    else expect(life(f).assignments[C.primary]).toBeUndefined()
  }
  const beforeReplay = f.authority.snapshot()
  await second(); await first()
  expect(stub(f).socket.acks).toHaveLength(4)
  expect(f.authority.snapshot()).toEqual(beforeReplay)
})

test.each([
  ['startup join', 'startup', true], ['startup leave', 'startup', false],
  ['same-socket-gap join', 'same-socket-gap', true], ['same-socket-gap leave', 'same-socket-gap', false],
] as const)('source regression: historical %s requires reconciliation before eligibility', async (_name, boundary, member) => {
  const f = fixture(); await f.start()
  const socket = stub(f).socket, connection = f.h.manager.provenance('alpha')!.connectionId
  let timestamp = ((f.h.clock.now() - 1000) / 1000).toFixed(3)
  if (boundary === 'same-socket-gap') {
    stub(f).script.inventory.push(membershipPage([C.secondary])); await f.scan()
    expect(reading(f, C.secondary).kind).toBe('eligible')
    // This history happened AFTER the completed inventory and BEFORE the gap.
    await f.h.clock.advance(1)
    timestamp = (f.h.clock.now() / 1000).toFixed(3)
    await f.h.clock.advance(1)
    f.scanner.connectionChanged('alpha')
  }
  const calls = stub(f).calls.inventory.length
  await f.event(member, C.primary, { id: 'EvHISTORICAL', timestamp })
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(stub(f).calls.inventory).toHaveLength(calls)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvents.EvHISTORICAL?.member).toBe(member)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'current-membership-missing' })
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'current-membership-missing' })
  const held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(held.outcome); await f.scan()
  expect(reading(f).kind).toBe('unresolved')
  // Current Slack truth contradicts the historical event in both directions.
  held.settle(membershipPage(member ? [] : [C.primary])); await f.h.clock.flush()
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f).kind).toBe(member ? 'ineligible' : 'eligible')
  expect(life(f).membership[C.primary]?.member).toBe(!member)
  expect(stub(f).socket).toBe(socket)
  expect(f.h.manager.provenance('alpha')!.connectionId).toBe(connection)
  const beforeReplay = f.authority.snapshot()
  await f.event(member, C.primary, { id: 'EvHISTORICAL', timestamp })
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(f.authority.snapshot()).toEqual(beforeReplay)
})

test.each(['join-leave', 'leave-join'] as const)('source regression: %s overlap survives crashes before ack and between history recovery and inventory persistence', async direction => {
  const f = fixture(); await f.start()
  const seconds = Math.floor(f.h.clock.now() / 1000)
  const joinEvent = { id: 'EvCRASHJOIN', timestamp: `${seconds}.500` }
  const leaveEvent = { id: 'EvCRASHLEAVE', event: { event_ts: undefined }, envelope: { event_time: seconds } }
  const firstMember = direction === 'join-leave'
  await f.event(firstMember, C.primary, firstMember ? joinEvent : leaveEvent)
  f.assign(C.primary, 'off')
  const secondId = firstMember ? leaveEvent.id : joinEvent.id
  const secondEvent = firstMember ? leaveEvent : joinEvent
  f.failWrites(() => true)
  await f.event(!firstMember, C.primary, secondEvent)
  await f.event(!firstMember, C.primary, secondEvent)
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence?.[secondId]).toBeUndefined()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.scan()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(reading(f).kind).toBe('unresolved')
  f.failWrites(() => false)
  const router = f.h.onEvent
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => { throw new Error('fixture crash before ack') } }, provenance)
  await f.event(!firstMember, C.primary, secondEvent)
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence?.[secondId]?.state).toBe('conflict')
  await f.close()

  const recovered = fixture({ reopen: true, startTime: f.h.clock.now() + MEMBERSHIP_RETRY_MIN_MS }, f.stateDir)
  await recovered.start()
  await recovered.event(!firstMember, C.primary, secondEvent)
  expect(stub(recovered).socket.acks).toHaveLength(1)
  expect(reading(recovered).kind).toBe('unresolved')
  // The recovery commits its leave/supersession, but the following positive
  // scan cannot commit. Reopening must not repeat that history boundary.
  recovered.failWrites(state => Object.keys(state.personas.alpha!.membershipEvents).some(id => id.startsWith('scan:')))
  stub(recovered).script.inventory.push(membershipPage([C.primary])); await recovered.scan()
  expect(recovered.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(reading(recovered).kind).toBe('unresolved')
  expect(life(recovered).membershipEvidence?.[secondId]?.state).toBe(firstMember ? 'applied' : 'superseded')
  const leave = life(recovered).leaves[C.primary]
  expect(leave?.boundary).toBeGreaterThan(0)
  const event = life(recovered).membershipEvents[secondId]
  await recovered.close()

  const reopened = fixture({ reopen: true, startTime: recovered.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(reopened.scanner.status('alpha').state).toBe('complete')
  expect(reading(reopened).kind).toBe('eligible')
  expect(life(reopened).leaves[C.primary]).toEqual(leave)
  expect(life(reopened).assignments[C.primary]?.delivery).toBe(firstMember ? 'mentions' : 'off')
  expect(life(reopened).membershipEvents[secondId]).toEqual(event)
  reopened.assign(C.primary, 'thread_hybrid')
  const beforeReplay = reopened.authority.snapshot()
  await reopened.event(!firstMember, C.primary, secondEvent)
  expect(stub(reopened).socket.acks).toHaveLength(1)
  expect(reopened.authority.snapshot()).toEqual(beforeReplay)
})

test('source regression: repeated absence persists its watermark across restart and rejects a late join without erasing future intent', async () => {
  const f = fixture(); await f.start()
  await f.event(false, C.primary, { id: 'EvABSENT' })
  const leave = life(f).leaves[C.primary]
  f.assign(C.primary, 'thread_hybrid')
  await f.scan()
  expect(f.scanner.status('alpha').state).toBe('complete')
  const oldThrough = life(f).membership[C.primary]!.observedThrough!
  const delayedJoin = { id: 'EvLATEJOIN', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  f.scanner.request('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(Number(life(f).membership[C.primary]!.observedThrough)).toBeGreaterThan(Number(delayedJoin.timestamp))
  expect(Number(delayedJoin.timestamp)).toBeGreaterThan(Number(oldThrough))
  expect(life(f).leaves[C.primary]).toEqual(leave)
  expect(life(f).assignments[C.primary]?.delivery).toBe('thread_hybrid')
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  await reopened.start()
  const before = reopened.authority.snapshot()
  await reopened.event(true, C.primary, delayedJoin)
  expect(stub(reopened).socket.acks).toHaveLength(1)
  expect(reopened.authority.snapshot()).toEqual(before)
  expect(stub(reopened).calls.inventory).toHaveLength(0)
  expect(reading(reopened).kind).toBe('unresolved')
  await reopened.scan()
  expect(reading(reopened)).toEqual({ kind: 'ineligible', reason: 'absent' })
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('thread_hybrid')
  // A genuinely later event and current positive can rejoin, retaining the
  // deliberate post-leave assignment rather than restoring an old default.
  await reopened.event(true, C.primary, { id: 'EvFUTUREJOIN' })
  expect(reading(reopened).kind).toBe('unresolved')
  stub(reopened).script.inventory.push(membershipPage([C.primary]))
  await reopened.h.clock.advanceTo(reopened.scanner.status('alpha').nextAttemptAt!)
  expect(reading(reopened).kind).toBe('eligible')
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('thread_hybrid')
  expect(life(reopened).leaves[C.primary]).toEqual(leave)
})

test.each([['running', true], ['restarted', true], ['running', false], ['restarted', false]] as const)('durable empty inventory: %s protects an unseen future choice from historical member=%s', async (lifecycle, member) => {
  const f = fixture(); await f.start()
  stub(f).script.inventory.push(membershipPage([])); await f.scan()
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(life(f).membership[C.primary]).toBeUndefined()
  expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
  const historical = { id: 'EvBEFOREFUTURE', timestamp: ((f.h.clock.now() - 1000) / 1000).toFixed(3) }
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const future = life(f).assignments[C.primary]
  const cutoff = life(f).membershipInventory!
  expect(cutoff).toBeDefined()
  let current = f
  if (lifecycle === 'restarted') {
    await f.close()
    current = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
    await current.start()
    expect(life(current).membership[C.primary]).toBeUndefined()
    expect(life(current).assignments[C.primary]).toEqual(future)
  }
  const calls = stub(current).calls.inventory.length
  const beforeReplay = current.authority.snapshot()
  await current.event(member, C.primary, historical)
  expect(current.authority.snapshot()).toEqual(beforeReplay)
  expect(life(current).membershipInventory).toEqual(cutoff)
  expect(stub(current).socket.acks).toHaveLength(1)
  expect(stub(current).calls.inventory).toHaveLength(calls)
  expect(life(current).assignments[C.primary]).toEqual(future)
  expect(reading(current).kind).not.toBe('eligible')
  stub(current).script.inventory.push(membershipPage([])); await current.scan()
  expect(current.scanner.status('alpha').state).toBe('complete')
  expect(reading(current)).toEqual({ kind: 'ineligible', reason: 'absent' })
  expect(life(current).membership).toEqual({})
  expect(life(current).leaves).toEqual({})
  expect(life(current).membershipEvents).toEqual({})
  // Historical events must not turn a future choice into a removable old one.
  expect(life(current).assignments[C.primary]).toEqual(future)
  expect(readSharedState(current.stateDir)!.personas.alpha!.assignments[C.primary]).toEqual(future)
})

test('source regression: a conflict synchronously revokes published completeness and reports its actual scheduled retry', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary, C.secondary])); await f.start(); await f.scan()
  const held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(held.outcome)
  f.scanner.request('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha').state).toBe('scanning')
  const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
  await f.event(true, C.primary, { id: 'EvCONFLICTJOIN', timestamp })
  await f.event(false, C.primary, { id: 'EvCONFLICTLEAVE', timestamp })
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(reading(f).kind).toBe('unresolved')
  const status = f.scanner.status('alpha')
  expect(status.state).toBe('incomplete')
  expect(status.problem).toBe('event-order-conflict')
  expect(status.nextAttemptAt).toBe(f.h.clock.pending()[0]!.dueAt)
  expect(status.nextAttemptAt).toBe(f.h.clock.now() + MEMBERSHIP_RETRY_MIN_MS)
  expect(status.deadline).toBeUndefined()
  expect(reading(f, C.secondary).kind).toBe('eligible')
  const before = f.authority.snapshot()
  held.settle(membershipPage([C.primary])); await f.h.clock.flush()
  expect(f.authority.snapshot()).toEqual(before)
  expect(f.scanner.status('alpha')).toEqual(status)
  await f.h.clock.advanceTo(status.nextAttemptAt! - 1)
  expect(stub(f).calls.inventory).toHaveLength(2)
  stub(f).script.inventory.push(membershipPage([C.secondary]))
  await f.h.clock.advance(1)
  expect(stub(f).calls.inventory).toHaveLength(3)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
  expect(reading(f, C.secondary).kind).toBe('eligible')
})

test.each(['open', 'strict'] as const)('%s missing-channel defaults come from durable authenticated activation', async mode => {
  const f = fixture({ mode }); await f.start()
  const before = f.authority.sourceBytes()
  await f.event(true, C.primary)
  expect(life(f).assignments[C.primary]?.delivery).toBe(mode === 'open' ? 'mentions' : 'off')
  expect(reading(f).kind).toBe('unresolved')
  stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.scan()
  for (const channel of [C.primary, C.private]) {
    expect(reading(f, channel).kind).toBe('eligible')
    expect(life(f).assignments[channel]?.delivery).toBe(mode === 'open' ? 'mentions' : 'off')
  }
  expect(f.authority.sourceBytes()).toEqual(before)
})

test.each([['open', false], ['strict', false], ['open', true], ['strict', true]] as const)('rejoin from %s overlapping mode confirmation uses activation mode (explicit=%s)', async (mode, explicit) => {
  const f = fixture({ mode }); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  await f.event(false, C.primary, { id: 'EvMODELEAVE' })
  const boundary = life(f).leaves[C.primary]
  // The event effect fails, but its durable recovery obligation permits ack.
  f.failWrites(state => state.personas.alpha!.membershipEvidence?.EvMODEJOIN?.state === 'applied')
  await f.event(true, C.primary, { id: 'EvMODEJOIN', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(life(f).membershipEvidence?.EvMODEJOIN?.state).toBe('pending')
  expect(life(f).assignments[C.primary]).toBeUndefined()
  const nextMode = mode === 'open' ? 'strict' : 'open'
  const source = { ...f.authority.snapshot().source, channel_mode: nextMode }
  expect(f.authority.applyReviewed(configBytes(source), f.authority.revision).kind).toBe('applied')
  if (explicit) expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const choice = life(f).assignments[C.primary]
  f.failWrites(() => false)
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(reading(f).kind).toBe('eligible')
  expect(life(f).membershipEvidence?.EvMODEJOIN?.state).toBe('applied')
  expect(life(f).leaves[C.primary]).toEqual(boundary)
  if (explicit) expect(life(f).assignments[C.primary]).toEqual(choice)
  else expect(life(f).assignments[C.primary]?.delivery).toBe(nextMode === 'open' ? 'mentions' : 'off')
})

test('inventory commit failure cannot publish completeness or a cutoff; reopen recovers then genuine later events still act', async () => {
  const f = fixture(); await f.start()
  f.failWrites(state => state.personas.alpha!.membershipInventory !== undefined)
  await f.scan()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(reading(f).kind).toBe('unresolved')
  expect(life(f).membershipInventory).toBeUndefined()
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipInventory).toBeUndefined()
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  await reopened.start()
  expect(reading(reopened).kind).toBe('unresolved')
  await reopened.scan()
  expect(reopened.scanner.status('alpha').state).toBe('complete')
  expect(readSharedState(reopened.stateDir)!.personas.alpha!.membershipInventory).toEqual(life(reopened).membershipInventory)
  reopened.assign(C.primary, 'off')
  const future = life(reopened).assignments[C.primary]
  await reopened.event(true, C.primary, { id: 'EvAFTERCUTOFF' })
  expect(life(reopened).membershipEvents.EvAFTERCUTOFF?.member).toBe(true)
  expect(life(reopened).assignments[C.primary]).toEqual(future)
  expect(reading(reopened).kind).toBe('unresolved')
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.scan()
  expect(reading(reopened).kind).toBe('eligible')
  const leave = { id: 'EvAFTERCUTOFFLEAVE', timestamp: ((reopened.h.clock.now() + 1) / 1000).toFixed(3) }
  await reopened.event(false, C.primary, leave)
  expect(life(reopened).assignments[C.primary]).toBeUndefined()
  reopened.assign(C.primary, 'off')
  const afterLeave = reopened.authority.snapshot()
  await reopened.event(false, C.primary, leave)
  expect(reopened.authority.snapshot()).toEqual(afterLeave)
})

test('only complete validated pagination commits inventory proof; independent positives survive a later malformed page', async () => {
  const f = fixture(), last = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.secondary], 'last'), last.outcome)
  await f.start(); await f.scan()
  expect(reading(f, C.secondary).kind).toBe('eligible')
  expect(life(f).membershipInventory).toBeUndefined()
  last.settle(membershipPage([{ id: C.primary }])) // Missing eligibility metadata.
  await f.h.clock.flush()
  expect(f.scanner.status('alpha').state).toBe('incomplete')
  expect(life(f).membershipInventory).toBeUndefined()
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipInventory).toBeUndefined()
  expect(reading(f).kind).toBe('unresolved')
})

test('durable inventory schema round-trips production evidence and rejects malformed authority without accepting a forged cutoff', async () => {
  const f = fixture(); await f.start(); await f.scan()
  const state = readSharedState(f.stateDir)!, proof = state.personas.alpha!.membershipInventory!
  expect(proof.incarnation).toBe(life(f).incarnation)
  expect(proof.recordedOrder).toBe(state.revision)
  expect(proof.observedRevision).toBeGreaterThanOrEqual(1)
  expect(proof.observedRevision).toBeLessThan(proof.recordedOrder)
  expect(proof.observedThrough).toBe((f.h.clock.now() / 1000).toFixed(3))
  expect(parseSharedChannelState(configBytes(state), f.authority.path)).toEqual(state)
  // Each mutation breaks a separate schema invariant; the fixture itself was
  // written by the production scanner, never a handwritten valid envelope.
  const mutations = [null, [], {}, { ...proof, incarnation: 'foreign-life' },
    { ...proof, identity: '["T0","A0","U0","B0",1]' }, { ...proof, identity: 'unbound' },
    ...[0, state.revision + 1, 1.5].map(recordedOrder => ({ ...proof, recordedOrder })),
    ...[123, null, '-1.000', '1e9', 'NaN'].map(observedThrough => ({ ...proof, observedThrough })),
    ...[undefined, null, -1, 0, 1.5, '1', proof.recordedOrder, proof.recordedOrder + 1, Number.MAX_SAFE_INTEGER + 1].map(observedRevision => ({ ...proof, observedRevision })),
    { ...proof, channels: [] }]
  for (const mutation of mutations) {
    const invalid = structuredClone(state)
    Object.assign(invalid.personas.alpha!, { membershipInventory: mutation })
    expect(() => parseSharedChannelState(configBytes(invalid), f.authority.path)).toThrow()
  }
  const without = structuredClone(state); delete without.personas.alpha!.membershipInventory
  expect(parseSharedChannelState(configBytes(without), f.authority.path)).toEqual(without)
})

test('a replacement installation and a reviewed incarnation reset cannot borrow durable inventory proof', async () => {
  const f = fixture(); await f.start(); await f.scan()
  const proof = life(f).membershipInventory!
  const { PersonaSlackTokens } = await import('../src/persona-credentials.ts')
  const { fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX, LEAK_SENTINEL } = await import('./test-helpers/credentials.ts')
  const tokens = new PersonaSlackTokens(fakeToken(BOT_TOKEN_PREFIX, 'different-app'), fakeToken(APP_TOKEN_PREFIX, 'different-app'))
  const fresh = f.h.slack.addCredentials('alpha', 'different-app', tokens, { ...stub(f).identity, appId: 'A0DIFFERENT', leakMarker: LEAK_SENTINEL })
  await f.h.manager.reconnectCredentials('alpha', tokens)
  expect(reading(f).kind).toBe('unresolved')
  // Older than the other installation's cutoff; valid for this installation.
  await fresh.socket.deliver({ type: 'member_joined_channel', channel: C.primary, user: fresh.identity.botUserId,
    event_ts: ((f.h.clock.now() - 1000) / 1000).toFixed(3) }, { event_id: 'EvNEWAPP' })
  expect(fresh.socket.acks).toHaveLength(1)
  expect(life(f).membershipEvents.EvNEWAPP?.member).toBe(true)
  expect(life(f).membershipEvents.EvNEWAPP?.identity).not.toBe(proof.identity)
  fresh.script.inventory.push(membershipPage([C.primary])); await f.scan()
  expect(life(f).membershipInventory?.identity).not.toBe(proof.identity)
  const source = structuredClone(f.authority.snapshot().source)
  ;(source.personas as Array<Record<string, unknown>>)[0]!.working_directory = join(f.stateDir, 'new-incarnation')
  expect(f.authority.applyReviewed(configBytes(source), f.authority.revision).kind).toBe('applied')
  expect(life(f).incarnation).not.toBe(proof.incarnation)
  expect(life(f).membershipInventory).toBeUndefined()
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipInventory).toBeUndefined()
  expect(reading(f).kind).toBe('unresolved')
})

test('coarse leave overlapping complete inventory cannot erase a later future preference, including reopen and replay', async () => {
  const f = fixture({ startTime: 1_700_000_000_500 }); await f.start(); await f.scan(); f.assign(C.primary, 'off')
  const choice = life(f).assignments[C.primary]
  const event = { id: 'EvCUTOFFOVERLAP', event: { event_ts: undefined }, envelope: { event_time: Math.floor(f.h.clock.now() / 1000) } }
  const router = f.h.onEvent
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence?.EvCUTOFFOVERLAP?.state).toBe('conflict')
    await payload.ack()
  } }, provenance)
  await f.event(false, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(1)
  await f.scan()
  expect(f.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(life(f).assignments[C.primary]).toEqual(choice)
  expect(life(f).leaves[C.primary]).toBeUndefined()
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + MEMBERSHIP_RETRY_MIN_MS }, f.stateDir)
  await reopened.start(); await reopened.event(false, C.primary, event); await reopened.scan()
  expect(stub(reopened).socket.acks).toHaveLength(1)
  expect(reopened.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(reading(reopened).kind).toBe('unresolved')
  expect(life(reopened).assignments[C.primary]).toEqual(choice)
  expect(life(reopened).leaves[C.primary]).toBeUndefined()
})

test('actual socket gap recovers missed leave/join while idle and restores queued then delivered reactions through status/reporting callbacks', async () => {
  _resetAckTracker()
  const f = fixture({ realBringUp: true, names: ['alpha', 'beta'], mode: 'strict', queuedAckReaction: 'hourglass', channels: [{ id: C.primary, delivery: 'all' }] })
  for (const key of ['alpha', 'beta']) stub(f, key).script.inventory.push(membershipPage([C.primary]))
  await f.start(); await f.scan()
  const { createDeliveryReporting } = await import('../src/delivery-notices.ts')
  const { createPersonaEpisodes } = await import('../src/persona-episodes.ts')
  const { createQueuedAckCallback, createDeliveryAckCallback } = await import('../src/ack-tracker.ts')
  const { composePersonaStatusListeners } = await import('../src/persona-start.ts')
  const { makeEngineHarness } = await import('./test-helpers/delivery-engine.ts')
  const pending: Promise<void>[] = []
  const episodes = createPersonaEpisodes({ clock: f.h.clock, log: line => f.lines.push(line), sink: () => {} })
  const managed = makeManagedRouting(f.h, f.stateDir, { membership: f.membership, getChannelDelivery: () => createChannelDeliveryStore(f.authority), onReceived: (key, item) => reporting.received(key, item) })
  const queued = createQueuedAckCallback({ queue: managed.queue, clientFor: f.h.clientFor, getReaction: () => f.h.config!.queued_ack_reaction })
  const delivered = createDeliveryAckCallback({ queue: managed.queue, clientFor: f.h.clientFor, getReaction: () => 'eyes' })
  const reporting = createDeliveryReporting({ queue: managed.queue, episodes, persona: f.h.getPersona,
    state: key => ({ up: f.bringUps.isUp(key) }), log: line => f.lines.push(line), notify: () => {},
    queued: (key, item) => { const result = queued(key, item); pending.push(result); return result },
    delivered: (key, item) => { const result = delivered(key, item); pending.push(result); return result },
  })
  const membershipStatus = f.h.onStatus!
  f.h.onStatus = composePersonaStatusListeners(membershipStatus, (key, status) => { if (status.state === 'up') reporting.reconcileQueued(key) })
  f.h.onEvent = createPersonaEventRouter({ membership: f.membership, routing: managed.routing, clientFor: f.h.clientFor, getPersona: f.h.getPersona, log: line => f.lines.push(line) })
  const e = await makeEngineHarness({ stateDir: f.stateDir, queue: managed.queue, keys: ['alpha', 'beta'], onEvent: event => reporting.engineEvent(event) })
  try {
    e.p('alpha').row.state = 'working'; e.p('beta').row.state = 'waiting'
    stub(f).script.reactionsAdd.push({ kind: 'platform', error: 'ratelimited' })
    const text = '  original <@U0MEMBER0>\r\n\r\ntext  '
    await stub(f).socket.deliver(makeChannelMessage({ channel: C.primary, text }))
    await Promise.all(pending)
    expect(stub(f).socket.acks).toHaveLength(1)
    expect(managed.queue.openCount('alpha')).toBe(1)
    const original = structuredClone(managed.queued('alpha')[0]!.accepted)
    expect(original.text).toBe(text); expect(original.queued_ack_reaction).toBe('hourglass')
    const connection = f.h.manager.provenance('alpha')!.connectionId
    const oldSocket = stub(f).socket, reconnect = makeDeferredConnect()
    stub(f).script.connect.push(reconnect.outcome)
    oldSocket.drop(); await f.h.clock.flush()
    expect(f.h.manager.status('alpha')?.state).toBe('lost')
    expect(reading(f).kind).toBe('unresolved')
    expect(f.scanner.status('alpha').state).not.toBe('complete')
    expect(reading(f, C.primary, 'beta').kind).toBe('eligible')
    const calls = stub(f).calls.inventory.length
    const beta = stub(f, 'beta')
    const betaTs = '1700000002.000001', betaText = 'independent'
    const betaMessage = makeChannelMessage({ channel: C.primary, ts: betaTs, text: betaText })
    expect(beta.socket.acks).toEqual([])
    await beta.socket.deliver(betaMessage)
    await Promise.all(pending)
    expect(beta.socket.acks).toHaveLength(1)
    expect(managed.queue.openCount('beta')).toBe(1)
    const betaAccepted = managed.queued('beta').map(item => item.accepted)
    expect(betaAccepted).toHaveLength(1)
    expect(betaAccepted[0]).toMatchObject({ source: 'slack', channel: C.primary, ts: betaMessage.ts,
      key: { chat_id: C.primary, ts: betaMessage.ts }, text: betaMessage.text, user: betaMessage.user,
      via: 'receive_all', queued_ack_reaction: 'hourglass' })
    expect(e.records('beta').filter(record => record.kind === 'accepted')).toEqual(betaAccepted)
    expect(e.records('beta').filter(record => record.kind === 'delivered')).toEqual([])
    expect(beta.calls.reactionsAdd).toEqual([{ channel: C.primary, timestamp: betaTs, name: 'hourglass' }])
    expect(beta.calls.reactionsRemove).toEqual([])
    await e.tick('beta')
    await e.until(() => managed.queue.openCount('beta') === 0)
    await Promise.all(pending)
    const receipts = e.records('beta').filter(record => record.kind === 'delivered')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ seq: betaAccepted[0]!.seq, part: 1, receipt: { path: e.p('beta').path } })
    const receipt = receipts[0]!.receipt
    const transcript = readFileSync(receipt.path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(transcript.find(record => record.uuid === receipt.uuid)?.message.content).toBe(e.textCalls('beta')[0]!.params.text)
    expect(e.textCalls('beta')).toHaveLength(1)
    expect(e.textCalls('beta')[0]!.params.text).toContain(betaText)
    expect(e.events.filter(event => event.type === 'delivered' && event.key === 'beta')).toEqual([{ type: 'delivered', key: 'beta', seq: betaAccepted[0]!.seq, part: 1 }])
    expect(beta.calls.reactionsRemove).toEqual([{ channel: C.primary, timestamp: betaTs, name: 'hourglass' }])
    expect(beta.calls.reactionsAdd).toEqual(['hourglass', 'eyes'].map(name => ({ channel: C.primary, timestamp: betaTs, name })))
    expect(beta.callLog.filter(call => call.method.startsWith('reactions.')).map(call => call.method)).toEqual(['reactions.add', 'reactions.remove', 'reactions.add'])
    expect(stub(f).calls.reactionsAdd.map(call => call.name)).toEqual(['hourglass'])
    expect(stub(f).calls.reactionsRemove).toEqual([])
    expect(e.textCalls('alpha')).toEqual([])
    expect(f.h.manager.status('alpha')?.state).toBe('lost')
    expect(managed.queue.openCount('alpha')).toBe(1)
    expect(stub(f).calls.inventory).toHaveLength(calls)
    // Slack changed while alpha's socket was down; no membership event or
    // incoming message will trigger its recovery.
    stub(f).script.inventory.push(membershipPage([C.secondary]))
    f.h.config!.queued_ack_reaction = 'changed-after-acceptance'
    reconnect.settle({ kind: 'ok' }); await f.h.clock.flush()
    for (let turn = 0; turn < 8 && f.scanner.status('alpha').state !== 'complete'; turn++) await f.h.clock.runNext()
    await Promise.all(pending)
    expect(f.h.manager.provenance('alpha')!.connectionId).not.toBe(connection)
    expect(stub(f).socket).not.toBe(oldSocket)
    expect(f.scanner.status('alpha').state).toBe('complete')
    expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
    expect(life(f).assignments[C.primary]).toBeUndefined()
    expect(reading(f, C.secondary).kind).toBe('eligible')
    expect(life(f).assignments[C.secondary]?.delivery).toBe('off')
    expect(life(f, 'beta').assignments[C.primary]?.delivery).toBe('all')
    expect(managed.queued('alpha')[0]!.accepted).toEqual(original)
    // Second add came from onStatus -> reconcileQueued, without a manual
    // callback, new intake, restart or a new config decision.
    expect(stub(f).calls.reactionsAdd.map(c => c.name)).toEqual(['hourglass', 'hourglass'])
    expect(stub(f).calls.reactionsRemove).toEqual([])
    e.p('alpha').row.state = 'waiting'
    await e.tick('alpha')
    await e.until(() => managed.queue.openCount('alpha') === 0)
    await Promise.all(pending)
    expect(stub(f).calls.reactionsRemove.map(c => c.name)).toEqual(['hourglass'])
    expect(stub(f).calls.reactionsAdd.map(c => c.name)).toEqual(['hourglass', 'hourglass', 'eyes'])
    expect(stub(f).callLog.filter(c => c.method.startsWith('reactions.')).map(c => c.method)).toEqual(['reactions.add', 'reactions.add', 'reactions.remove', 'reactions.add'])
    expect(f.h.lines.filter(line => line.includes('status listener'))).toEqual([])
    assertNoLeak({ logs: managed.logs, errors: e.errors, events: e.events, journal: writtenFile(join(f.stateDir, 'queue')) })
  } finally { await Promise.allSettled(pending); episodes.close(); await e.cleanup(); await managed.close(); _resetAckTracker() }
})

test.each(['running', 'restarted'] as const)('source review 3: %s future choice written during an open inventory is protected from coarse history crossing scan start', async restart => {
  const f = fixture({ startTime: 1_700_000_000_500 }), held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(held.outcome); await f.start(); await f.scan()
  const start = f.h.clock.now(), scanRevision = f.authority.revision
  await f.h.clock.advance(1000)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const choice = life(f).assignments[C.primary]
  held.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(life(f).membershipInventory!.observedRevision).toBe(scanRevision)
  expect(life(f).membershipInventory!.recordedOrder).toBeGreaterThan(choice!.order)
  let current = f
  if (restart === 'restarted') {
    await f.close(); current = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir); await current.start()
  }
  await current.event(false, C.primary, { id: 'EvSCANSTART', event: { event_ts: undefined }, envelope: { event_time: Math.floor(start / 1000) } })
  expect(stub(current).socket.acks).toHaveLength(1)
  await current.scan()
  expect(life(current).assignments[C.primary]).toEqual(choice)
  expect(life(current).leaves[C.primary]).toBeUndefined()
  expect(current.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(reading(current).kind).toBe('unresolved')
})

test('source review 3: eligibility-incomplete inventory preserves absent historical choices and only releases independently verified positives', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan(); f.assign(C.primary, 'off')
  const before = life(f)
  f.scanner.connectionChanged('alpha')
  stub(f).script.inventory.push(membershipPage([C.secondary, { id: C.private }]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'eligibility-missing' })
  expect(reading(f, C.secondary).kind).toBe('eligible')
  expect(life(f).assignments[C.primary]).toEqual(before.assignments[C.primary])
  expect(life(f).membership[C.primary]).toEqual(before.membership[C.primary])
  expect(life(f).leaves[C.primary]).toBeUndefined()
  expect(life(f).membershipInventory).toEqual(before.membershipInventory)
  expect(reading(f).kind).toBe('unresolved')
  // A later fully validated inventory really can establish the missed leave.
  stub(f).script.inventory.push(membershipPage([C.secondary, C.private]))
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f)).toEqual({ kind: 'ineligible', reason: 'absent' })
  expect(life(f).assignments[C.primary]).toBeUndefined()
})

test('held pages and failed final commit never partially publish absence; reopen retains both prior choices until a successful complete scan', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  f.assign(C.primary, 'off'); f.assign(C.private, 'thread_hybrid')
  const prior = life(f), final = makeDeferredWebApiCall()
  f.scanner.connectionChanged('alpha')
  stub(f).script.inventory.push(membershipPage([C.secondary], 'final'), final.outcome)
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(reading(f, C.secondary).kind).toBe('eligible')
  for (const channel of [C.primary, C.private]) {
    expect(reading(f, channel).kind).toBe('unresolved')
    expect(life(f).assignments[channel]).toEqual(prior.assignments[channel])
    expect(life(f).membership[channel]).toEqual(prior.membership[channel])
  }
  // All negative effects and the cutoff share this one final durable write.
  f.failWrites(state => state.personas.alpha!.membershipInventory?.recordedOrder !== prior.membershipInventory?.recordedOrder)
  final.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  const persisted = readSharedState(f.stateDir)!.personas.alpha!
  for (const channel of [C.primary, C.private]) {
    expect(persisted.assignments[channel]).toEqual(prior.assignments[channel])
    expect(persisted.membership[channel]).toEqual(prior.membership[channel])
    expect(persisted.leaves[channel]).toBeUndefined()
    expect(reading(f, channel).kind).toBe('unresolved')
  }
  expect(persisted.membershipInventory).toEqual(prior.membershipInventory)
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  await reopened.start()
  for (const channel of [C.primary, C.private]) {
    expect(life(reopened).assignments[channel]).toEqual(prior.assignments[channel])
    expect(reading(reopened, channel).kind).toBe('unresolved')
  }
  stub(reopened).script.inventory.push(membershipPage([C.secondary])); await reopened.scan()
  expect(reopened.scanner.status('alpha').state).toBe('complete')
  for (const channel of [C.primary, C.private]) {
    expect(life(reopened).assignments[channel]).toBeUndefined()
    expect(reading(reopened, channel)).toEqual({ kind: 'ineligible', reason: 'absent' })
    expect(life(reopened).leaves[channel]?.boundary).toBeGreaterThan(0)
  }
  expect(life(reopened).leaves[C.primary]!.boundary).not.toBe(life(reopened).leaves[C.private]!.boundary)
})

test.each(['held-history', 'malformed-page'] as const)('%s prevents unrelated historical absences while a valid independent positive progresses', async problem => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  f.assign(C.primary, 'off'); f.assign(C.private, 'thread_hybrid')
  if (problem === 'held-history') {
    await f.event(true, 'C0HELD', { id: 'EvCOLLISION' })
    await f.event(false, 'C0HELD', { id: 'EvCOLLISION', timestamp: ((f.h.clock.now() + 2) / 1000).toFixed(3) })
  }
  const before = life(f)
  f.scanner.connectionChanged('alpha')
  stub(f).script.inventory.push(membershipPage([C.secondary], problem === 'malformed-page' ? 'last' : undefined))
  if (problem === 'malformed-page') stub(f).script.inventory.push(membershipPage([{ id: 'invalid' }]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: problem === 'held-history' ? 'history-unresolved' : 'malformed-page' })
  expect(reading(f, C.secondary).kind).toBe('eligible')
  const persisted = readSharedState(f.stateDir)!.personas.alpha!
  for (const channel of [C.primary, C.private]) {
    expect(life(f).assignments[channel]).toEqual(before.assignments[channel])
    expect(persisted.assignments[channel]).toEqual(before.assignments[channel])
    expect(persisted.membership[channel]).toEqual(before.membership[channel])
    expect(persisted.leaves[channel]).toBeUndefined()
    expect(reading(f, channel).kind).toBe('unresolved')
  }
  expect(persisted.membershipInventory).toEqual(before.membershipInventory)
})

test.each(['present', 'absent'] as const)('missing eligibility creates no historical effect and a valid %s inventory clears its local hold', async result => {
  const f = fixture(); f.assign(C.primary, 'off')
  const before = life(f)
  stub(f).script.inventory.push(membershipPage([{ id: C.primary }]))
  await f.start(); await f.scan()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'eligibility-missing' })
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'eligibility-missing' })
  expect(life(f)).toEqual(before)
  expect(readSharedState(f.stateDir)!.personas.alpha).toEqual(before)
  stub(f).script.inventory.push(membershipPage(result === 'present' ? [C.primary] : []))
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(reading(f).kind).toBe(result === 'present' ? 'eligible' : 'ineligible')
  expect(f.membership.hasUnresolved('alpha', C.primary)).toBe(false)
  expect(life(f).assignments[C.primary]).toEqual(before.assignments[C.primary])
  expect(life(f).leaves[C.primary]).toBeUndefined()
  if (result === 'absent') expect(life(f).membership[C.primary]).toBeUndefined()
})

test.each(['before-rename', 'after-rename'] as const)('%s final failure keeps negative conflict recovery, both absences and cutoff in one batch across reopen', async failure => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  f.assign(C.primary, 'off'); f.assign(C.private, 'thread_hybrid')
  const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
  await f.event(true, C.primary, { id: 'EvBATCHJOIN', timestamp })
  await f.event(false, C.primary, { id: 'EvBATCHLEAVE', timestamp })
  expect(life(f).membershipEvidence!.EvBATCHLEAVE!.state).toBe('conflict')
  f.scanner.connectionChanged('alpha')
  const before = f.authority.snapshot(), writes = f.writes.length
  f.failWrites(state => {
    if (state.personas.alpha!.membershipInventory?.recordedOrder === before.personas.alpha!.membershipInventory?.recordedOrder) return false
    if (failure === 'before-rename') return true
    // The existing writer seam models a successful rename followed by failed
    // directory sync. Reopen must use the whole real serialized batch on disk.
    writeSharedState(f.stateDir, state)
    throw new DurableWriteUnsyncedError(f.authority.path, Object.assign(new Error('fixture directory sync failed'), { code: 'EIO' }))
  })
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(f.writes).toHaveLength(writes + 1)
  expect(f.authority.snapshot()).toEqual(before)
  expect(f.authority.readable).toBe(failure === 'before-rename')
  const attempt = f.writes.at(-1)!, batch = attempt.personas.alpha!
  expect(batch.membershipEvidence!.EvBATCHLEAVE!.state).toBe('applied')
  const originalEvidence = before.personas.alpha!.membershipEvidence!.EvBATCHLEAVE!
  expect(batch.membershipEvidence!.EvBATCHLEAVE).toMatchObject({
    observedRevision: originalEvidence.observedRevision, boundary: originalEvidence.boundary,
    timestamp: originalEvidence.timestamp, connectionId: originalEvidence.connectionId,
  })
  expect(batch.membershipInventory!.recordedOrder).toBe(attempt.revision)
  for (const channel of [C.primary, C.private]) {
    expect(reading(f, channel).kind).toBe('unresolved')
    expect(batch.assignments[channel]).toBeUndefined()
    expect(batch.membership[channel]!.member).toBe(false)
    expect(batch.leaves[channel]!.boundary).toBeLessThan(attempt.revision)
  }
  expect(batch.leaves[C.primary]!.boundary).not.toBe(batch.leaves[C.private]!.boundary)
  expect(readSharedState(f.stateDir)).toEqual(failure === 'before-rename' ? before : attempt)
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  await reopened.start()
  for (const channel of [C.primary, C.private]) expect(reading(reopened, channel).kind).toBe('unresolved')
  await reopened.scan()
  expect(reopened.scanner.status('alpha').state).toBe('complete')
  expect(life(reopened).membershipEvidence!.EvBATCHLEAVE).toMatchObject({
    observedRevision: originalEvidence.observedRevision, boundary: originalEvidence.boundary,
    timestamp: originalEvidence.timestamp, connectionId: originalEvidence.connectionId,
  })
  for (const channel of [C.primary, C.private]) {
    expect(life(reopened).assignments[channel]).toBeUndefined()
    expect(reading(reopened, channel)).toEqual({ kind: 'ineligible', reason: 'absent' })
  }
  const boundary = life(reopened).leaves[C.primary]
  reopened.assign(C.primary, 'off')
  await reopened.event(false, C.primary, { id: 'EvBATCHLEAVE', timestamp })
  expect(life(reopened).assignments[C.primary]?.delivery).toBe('off')
  expect(life(reopened).leaves[C.primary]).toEqual(boundary)
})

test('a stale later completion boundary rolls back the already staged first absence and a valid scan can still complete', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  f.assign(C.primary, 'off'); f.assign(C.private, 'thread_hybrid')
  const before = f.authority.snapshot(), writes = f.writes.length
  const result = f.membership.commitInventory(f.membership.generation('alpha')!, {
    scanId: 'stale-later-boundary', observedThrough: ((f.h.clock.now() + 1) / 1000).toFixed(3), observedRevision: f.authority.revision,
    absent: new Map([[C.primary, life(f).membership[C.primary]!.boundary], [C.private, 0]]),
  })
  expect(result.kind).toBe('failed')
  expect(f.authority.snapshot()).toEqual(before)
  expect(readSharedState(f.stateDir)).toEqual(before)
  expect(f.writes).toHaveLength(writes)
  for (const channel of [C.primary, C.private]) expect(reading(f, channel).kind).toBe('eligible')
  f.scanner.connectionChanged('alpha'); await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.scanner.status('alpha').state).toBe('complete')
  for (const channel of [C.primary, C.private]) {
    expect(reading(f, channel)).toEqual({ kind: 'ineligible', reason: 'absent' })
    expect(life(f).assignments[channel]).toBeUndefined()
  }
})

test.each([
  ['first', 'all'], ['first', 'off'], ['final', 'all'], ['final', 'off'],
] as const)('source review 5: held %s page cannot erase a newer explicit %s choice at completion, retry or restart', async (page, delivery) => {
  const f = fixture(), held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  expect(f.assign(C.primary, 'all').kind).toBe('applied')
  const prior = life(f)
  const startRevision = f.authority.revision
  f.scanner.connectionChanged('alpha')
  stub(f).script.inventory.push(...(page === 'first' ? [held.outcome] : [membershipPage([C.secondary], 'final'), held.outcome]))
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(stub(f).calls.inventory).toHaveLength(page === 'first' ? 2 : 3)
  expect(f.scanner.status('alpha').state).not.toBe('complete')
  expect(f.assign(C.primary, delivery).kind).toBe('applied')
  const choice = life(f).assignments[C.primary]!
  expect(choice.order).toBeGreaterThan(startRevision)
  held.settle(membershipPage(page === 'first' ? [C.secondary] : [])); await f.h.clock.flush()
  // Retain all stages before asserting, so a pre-repair failure records
  // deletion across retry/reopen too, rather than stopping at completion.
  const observed: Array<{ stage: string; memory: typeof choice | undefined; disk: typeof choice | undefined }> = []
  const conflict = readSharedState(f.stateDir)!.personas.alpha!.membershipAbsenceConflicts![C.primary]!
  expect(Object.keys(conflict).sort()).toEqual(['identity', 'boundary', 'observedThrough', 'observedRevision', 'assignmentOrder', 'recordedOrder'].sort())
  expect(conflict).toMatchObject({ identity: prior.membership[C.primary]!.identity, boundary: prior.membership[C.primary]!.boundary,
    observedRevision: startRevision, assignmentOrder: choice.order })
  expect(conflict.recordedOrder).toBeGreaterThan(choice.order)
  const capture = (current: MembershipHarness, stage: string) => {
    const memory = life(current), disk = readSharedState(current.stateDir)!.personas.alpha!
    observed.push({ stage, memory: memory.assignments[C.primary], disk: disk.assignments[C.primary] })
    expect(reading(current, C.secondary).kind).toBe('eligible')
    expect(reading(current)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
    expect(reading(current, C.private).kind).toBe('unresolved')
    expect(current.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'history-unresolved' })
    for (const state of [memory, disk]) {
      expect(state.membershipAbsenceConflicts![C.primary]).toEqual(conflict)
      expect(state.assignments[C.private]).toEqual(prior.assignments[C.private])
      for (const channel of [C.primary, C.private]) expect(state.membership[channel]).toEqual(prior.membership[channel])
      expect(state.leaves).toEqual(prior.leaves)
      expect(state.membershipInventory).toEqual(prior.membershipInventory)
    }
  }
  capture(f, 'completion')
  // A fresh later scan must not silently reinterpret the same missed leave
  // as permission to erase the preserved future choice.
  stub(f).script.inventory.push(membershipPage([C.secondary]))
  f.scanner.request('alpha'); await f.scan()
  capture(f, 'retry')
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + MEMBERSHIP_RETRY_MIN_MS }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.secondary])); await reopened.start()
  expect(reading(reopened).kind).toBe('unresolved')
  await reopened.scan(); capture(reopened, 'restart')
  stub(reopened).script.inventory.push(membershipPage([C.secondary]))
  reopened.scanner.request('alpha'); await reopened.scan(); capture(reopened, 'restart retry')
  stub(reopened).script.inventory.push(membershipPage([C.primary, C.secondary]))
  reopened.scanner.request('alpha'); await reopened.scan(); capture(reopened, 'present retry')
  await reopened.event(false, C.primary, { id: 'EvAFTERABSENCE', timestamp: ((reopened.h.clock.now() + 1) / 1000).toFixed(3) })
  expect(reading(reopened).kind).toBe('unresolved')
  expect(life(reopened).assignments[C.primary]).toEqual(choice)
  expect(life(reopened).leaves).toEqual(prior.leaves)
  stub(reopened).script.inventory.push(membershipPage([C.primary, C.secondary]))
  await reopened.scan(); capture(reopened, 'live recovery')
  expect(observed).toEqual(['completion', 'retry', 'restart', 'restart retry', 'present retry', 'live recovery'].map(stage => ({ stage, memory: choice, disk: choice })))
})

test.each([true, false])('unsaved absence conflict and live member=%p persist together before socket ack and remain held after reopen', async member => {
  const f = fixture(), held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  f.scanner.connectionChanged('alpha'); stub(f).script.inventory.push(held.outcome)
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const before = readSharedState(f.stateDir)!, prior = before.personas.alpha!
  f.failWrites(() => true)
  held.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(readSharedState(f.stateDir)).toEqual(before)
  const absence = f.writes.at(-1)!.personas.alpha!.membershipAbsenceConflicts![C.primary]!
  const event = { id: 'EvJOINT', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  const router = f.h.onEvent, atAck: Array<ReturnType<typeof readSharedState>> = []
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    atAck.push(readSharedState(f.stateDir))
    await payload.ack()
  } }, provenance)
  // Deliver and retry while the absence is still unsaved: neither obligation
  // may be acknowledged merely because the other is retained in memory.
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.event(member, C.primary, event)
    expect(stub(f).socket.acks).toEqual([])
    expect(atAck).toEqual([])
    expect(readSharedState(f.stateDir)).toEqual(before)
    expect(life(f)).toEqual(prior)
    expect(reading(f).kind).toBe('unresolved')
  }
  const pending = f.writes.at(-1)!.personas.alpha!.membershipEvidence![event.id]!
  expect(pending).toMatchObject({ event: event.id, channel: C.primary, member, timestamp: event.timestamp,
    state: 'conflict', conflict: 'predecessor', boundary: prior.membership[C.primary]!.boundary, observedRevision: before.revision })
  f.failWrites(() => false)
  const writes = f.writes.length
  await f.event(member, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(1)
  expect(atAck).toHaveLength(1)
  expect(f.writes).toHaveLength(writes + 1)
  const committed = atAck[0]!, disk = committed.personas.alpha!
  expect(disk.membershipAbsenceConflicts).toEqual({ [C.primary]: { ...absence, recordedOrder: committed.revision } })
  expect(disk.membershipEvidence).toEqual({ [event.id]: { ...pending, recordedOrder: committed.revision } })
  expect(disk).toEqual({ ...prior, membershipAbsenceConflicts: disk.membershipAbsenceConflicts, membershipEvidence: disk.membershipEvidence })
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  await f.event(member, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(atAck).toEqual([committed, committed])
  expect(f.writes).toHaveLength(writes + 1)
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(reading(reopened)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  expect(reopened.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'history-unresolved' })
  expect(life(reopened)).toEqual(disk)
  expect(readSharedState(f.stateDir)).toEqual(committed)
  await reopened.event(member, C.primary, event)
  expect(stub(reopened).socket.acks).toHaveLength(1)
  expect(life(reopened)).toEqual(disk)
  expect(readSharedState(f.stateDir)).toEqual(committed)
  expect(reading(reopened).kind).toBe('unresolved')
})

test.each(['before-rename', 'after-rename'] as const)('%s two-conflict batch preserves choices, boundaries and cutoff; both durable holds survive reopen', async failure => {
  const f = fixture(), held = makeDeferredWebApiCall(), channels = [C.primary, C.private]
  stub(f).script.inventory.push(membershipPage(channels)); await f.start(); await f.scan()
  const observedRevision = f.authority.revision
  f.scanner.connectionChanged('alpha'); stub(f).script.inventory.push(held.outcome)
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  const observedThrough = (f.h.clock.now() / 1000).toFixed(3)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  expect(f.assign(C.private, 'thread_hybrid').kind).toBe('applied')
  const before = f.authority.snapshot(), prior = before.personas.alpha!, writes = f.writes.length
  f.failWrites(state => {
    if (!state.personas.alpha!.membershipAbsenceConflicts) return false
    if (failure === 'before-rename') return true
    writeSharedState(f.stateDir, state)
    throw new DurableWriteUnsyncedError(f.authority.path, Object.assign(new Error('fixture directory sync failed'), { code: 'EIO' }))
  })
  held.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(f.writes).toHaveLength(writes + 1)
  expect(f.authority.snapshot()).toEqual(before)
  expect(f.authority.readable).toBe(failure === 'before-rename')
  const batch = f.writes.at(-1)!, conflicts = batch.personas.alpha!.membershipAbsenceConflicts!
  expect(Object.keys(conflicts).sort()).toEqual([...channels].sort())
  for (const channel of channels) {
    expect(conflicts[channel]).toEqual({ identity: prior.membership[channel]!.identity, boundary: prior.membership[channel]!.boundary,
      observedRevision, observedThrough, assignmentOrder: prior.assignments[channel]!.order, recordedOrder: batch.revision })
    expect(reading(f, channel)).toEqual({ kind: 'unresolved', reason: failure === 'before-rename' ? 'event-not-durable' : 'shared-state-unreadable' })
  }
  // The sole transaction adds both conflicts, with no membership effects,
  // changed choices/leave boundaries or published complete-inventory cutoff.
  expect(batch).toEqual({ ...before, revision: batch.revision, personas: { ...before.personas,
    alpha: { ...prior, membershipAbsenceConflicts: conflicts } } })
  expect(readSharedState(f.stateDir)).toEqual(failure === 'before-rename' ? before : batch)
  if (failure === 'before-rename') {
    f.failWrites(() => false)
    await f.scan()
    expect(f.writes).toHaveLength(writes + 2)
    expect(f.writes.at(-1)).toEqual(batch)
    expect(readSharedState(f.stateDir)).toEqual(batch)
  }
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage(channels)); await reopened.start()
  for (const channel of channels) expect(reading(reopened, channel)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  await reopened.scan()
  expect(reopened.authority.readable).toBe(true)
  expect(reopened.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'history-unresolved' })
  for (const channel of channels) expect(reading(reopened, channel)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  expect(reopened.authority.snapshot()).toEqual(batch)
  expect(readSharedState(f.stateDir)).toEqual(batch)
})

test('absence-conflict write failure protects the choice until idle persistence; validated history survives reopen and resets only with its persona life', async () => {
  const f = fixture(), held = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage([C.primary, C.private])); await f.start(); await f.scan()
  const prior = life(f)
  f.scanner.connectionChanged('alpha'); stub(f).script.inventory.push(held.outcome)
  await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const choice = life(f).assignments[C.primary]!, before = readSharedState(f.stateDir)!
  f.failWrites(state => !!state.personas.alpha!.membershipAbsenceConflicts?.[C.primary])
  held.settle(membershipPage([])); await f.h.clock.flush()
  expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
  expect(readSharedState(f.stateDir)).toEqual(before)
  expect(life(f).assignments[C.primary]).toEqual(choice)
  expect(reading(f).kind).toBe('unresolved')
  const attempted = f.writes.at(-1)!.personas.alpha!.membershipAbsenceConflicts![C.primary]!
  f.failWrites(() => false)
  stub(f).script.inventory.push(membershipPage([C.primary, C.secondary]))
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  const state = readSharedState(f.stateDir)!, proof = state.personas.alpha!.membershipAbsenceConflicts![C.primary]!
  expect(proof).toMatchObject({ identity: attempted.identity, boundary: attempted.boundary, observedThrough: attempted.observedThrough,
    observedRevision: attempted.observedRevision, assignmentOrder: choice.order })
  expect(state.personas.alpha!.assignments[C.primary]).toEqual(choice)
  expect(state.personas.alpha!.assignments[C.private]).toEqual(prior.assignments[C.private])
  expect(state.personas.alpha!.leaves).toEqual(prior.leaves)
  expect(state.personas.alpha!.membershipInventory).toEqual(prior.membershipInventory)
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  expect(reading(f, C.secondary).kind).toBe('eligible')
  for (const change of [
    { assignmentOrder: undefined }, { assignmentOrder: proof.observedRevision }, { observedRevision: proof.assignmentOrder },
    { recordedOrder: proof.assignmentOrder }, { recordedOrder: state.revision + 1 }, { boundary: 0 },
    { identity: JSON.stringify(['T0OTHER', 'A0OTHER', 'U0OTHER', 'B0OTHER']) }, { observedThrough: 'invalid' }, { extra: true },
  ]) {
    const broken = structuredClone(state)
    Object.assign(broken.personas.alpha!.membershipAbsenceConflicts![C.primary]!, change)
    expect(() => parseSharedChannelState(configBytes(broken), f.authority.path)).toThrow()
  }
  const foundation = structuredClone(state)
  delete foundation.personas.alpha!.membershipAbsenceConflicts
  expect(parseSharedChannelState(configBytes(foundation), f.authority.path)).not.toBeNull()
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary, C.secondary])); await reopened.start(); await reopened.scan()
  expect(life(reopened).membershipAbsenceConflicts![C.primary]).toEqual(proof)
  expect(life(reopened).assignments[C.primary]).toEqual(choice)
  expect(life(reopened).leaves).toEqual(prior.leaves)
  expect(reading(reopened)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  const input = structuredClone(reopened.authority.snapshot().source)
  ;(input.personas as Array<Record<string, unknown>>)[0]!.working_directory = join(f.stateDir, 'new-persona-life')
  expect(reopened.authority.applyReviewed(configBytes(input), reopened.authority.revision).kind).toBe('applied')
  expect(life(reopened).incarnation).not.toBe(prior.incarnation)
  expect(life(reopened).membershipAbsenceConflicts).toBeUndefined()
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipAbsenceConflicts).toBeUndefined()
  expect(reading(reopened).kind).toBe('unresolved')
})

test('source review 4: immediate undurable leave retry preserves newer off before recovery and through ack/reopen', async () => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  const event = { id: 'EvIMMEDIATERETRY', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  const before = readSharedState(f.stateDir)!, observedRevision = f.authority.revision
  const boundary = life(f).membership[C.primary]!.boundary, writes = f.writes.length
  f.failWrites(() => true)
  await f.event(false, C.primary, event)
  expect(f.writes.slice(writes).map(state => state.personas.alpha!.membershipEvidence![event.id]!.state)).toEqual(['applied', 'pending'])
  expect(stub(f).socket.acks).toEqual([])
  expect(readSharedState(f.stateDir)).toEqual(before)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence?.[event.id]).toBeUndefined()
  f.failWrites(() => false)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const choice = life(f).assignments[C.primary]!
  expect(choice.delivery).toBe('off'); expect(choice.order).toBeGreaterThan(observedRevision)
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence?.[event.id]).toBeUndefined()
  const router = f.h.onEvent, atAck: ReturnType<typeof life>[] = []
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    atAck.push(readSharedState(f.stateDir)!.personas.alpha!)
    await payload.ack()
  } }, provenance)
  // Retry the still-undurable observation directly: no clock advance, scan
  // or recovery call may make it durable before this socket delivery.
  const retryAt = f.h.clock.now()
  await f.event(false, C.primary, event)
  expect(f.h.clock.now()).toBe(retryAt); expect(stub(f).calls.inventory).toHaveLength(1)
  expect(stub(f).socket.acks).toHaveLength(1); expect(atAck).toHaveLength(1)
  expect(atAck[0]!.assignments[C.primary]).toEqual(choice)
  expect(atAck[0]!.membership).toEqual(before.personas.alpha!.membership)
  expect(atAck[0]!.leaves).toEqual(before.personas.alpha!.leaves)
  expect(atAck[0]!.membershipEvents[event.id]).toBeUndefined()
  expect(atAck[0]!.membershipEvidence![event.id]).toMatchObject({ event: event.id, channel: C.primary,
    member: false, timestamp: event.timestamp, state: 'pending', observedRevision, boundary })
  expect(atAck[0]!.membershipEvidence![event.id]!.recordedOrder).toBeGreaterThan(choice.order)
  expect(life(f)).toEqual(atAck[0])
  expect(reading(f)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  await f.close()
  const reopened = fixture({ reopen: true, startTime: retryAt + 1 }, f.stateDir)
  expect(life(reopened)).toEqual(atAck[0])
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(life(reopened).assignments[C.primary]).toEqual(choice)
  expect(readSharedState(f.stateDir)!.personas.alpha!.assignments[C.primary]).toEqual(choice)
  expect(life(reopened).membershipEvidence![event.id]).toEqual(atAck[0]!.membershipEvidence![event.id])
  expect(life(reopened).leaves).toEqual(before.personas.alpha!.leaves)
  expect(reading(reopened)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
})

test.each(['both-writes', 'effect-only'] as const)('source review 4: leave retry after %s failure cannot erase an explicit choice written after the observation', async failure => {
  const f = fixture(); stub(f).script.inventory.push(membershipPage([C.primary])); await f.start(); await f.scan()
  const event = { id: 'EvRETRYLEAVE', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  const observedRevision = f.authority.revision, boundary = life(f).membership[C.primary]!.boundary
  f.failWrites(state => failure === 'both-writes' || state.personas.alpha!.membershipEvidence?.EvRETRYLEAVE?.state === 'applied')
  await f.event(false, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(failure === 'both-writes' ? 0 : 1)
  expect(reading(f).kind).toBe('unresolved')
  f.failWrites(() => false)
  expect(f.assign(C.primary, 'off').kind).toBe('applied')
  const choice = life(f).assignments[C.primary]
  // Idle recovery must retain the original anchors even before Slack retries.
  // No later inventory may reinterpret receipt time as application time.
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.scan()
  expect(f.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(life(f).assignments[C.primary]).toEqual(choice)
  expect(life(f).leaves[C.primary]).toBeUndefined()
  expect(readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence!.EvRETRYLEAVE).toMatchObject({ observedRevision, boundary })
  await f.event(false, C.primary, event)
  expect(stub(f).socket.acks).toHaveLength(failure === 'both-writes' ? 1 : 2)
  expect(life(f).assignments[C.primary]).toEqual(choice)
  expect(life(f).leaves[C.primary]).toBeUndefined()
  const evidence = readSharedState(f.stateDir)!.personas.alpha!.membershipEvidence!.EvRETRYLEAVE!
  expect(['pending', 'conflict']).toContain(evidence.state)
  expect(evidence.member).toBe(false)
  expect(evidence.observedRevision).toBeLessThan(choice!.order)
  expect(evidence).toMatchObject({ observedRevision, boundary })
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.scan()
  expect(f.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(life(f).assignments[C.primary]).toEqual(choice)
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(reading(reopened).kind).toBe('unresolved')
  expect(reopened.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(life(reopened).assignments[C.primary]).toEqual(choice)
  expect(life(reopened).leaves[C.primary]).toBeUndefined()
})

test.each([['join-then-leave', true], ['leave-then-join', false]] as const)('source review 4: undurable %s with the same ID retains both payloads before ack and remains held after reopen', async (_direction, firstMember) => {
  const f = fixture(); await f.start()
  const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
  f.failWrites(() => true)
  await f.event(firstMember, C.primary, { id: 'EvUNDURABLEID', timestamp })
  expect(stub(f).socket.acks).toHaveLength(0)
  expect(life(f).membershipEvidence?.EvUNDURABLEID).toBeUndefined()
  const router = f.h.onEvent
  const atAck: ReturnType<typeof life>[] = []
  f.h.onEvent = (key, name, payload, provenance) => router(key, name, { ...payload, ack: async () => {
    atAck.push(readSharedState(f.stateDir)!.personas.alpha!)
    await payload.ack()
  } }, provenance)
  const before = readSharedState(f.stateDir)
  await f.event(!firstMember, C.primary, { id: 'EvUNDURABLEID', timestamp })
  // The contradiction and retries of either payload fail their durable write.
  // Neither a cached duplicate nor the original may escape with an early ACK.
  for (const member of [firstMember, !firstMember]) {
    expect(stub(f).socket.acks).toEqual([])
    expect(atAck).toEqual([])
    expect(readSharedState(f.stateDir)).toEqual(before)
    await f.event(member, C.primary, { id: 'EvUNDURABLEID', timestamp })
  }
  expect(stub(f).socket.acks).toEqual([])
  expect(readSharedState(f.stateDir)).toEqual(before)
  f.failWrites(() => false)
  for (const member of [firstMember, !firstMember]) await f.event(member, C.primary, { id: 'EvUNDURABLEID', timestamp })
  expect(stub(f).socket.acks).toHaveLength(2)
  expect(atAck).toHaveLength(2)
  for (const disk of atAck) {
    const evidence = Object.values(disk.membershipEvidence ?? {})
    expect(evidence).toHaveLength(2)
    expect(evidence.find(record => record.event === 'EvUNDURABLEID')).toMatchObject({ member: firstMember, timestamp })
    expect(evidence.find(record => record.originalEvent === 'EvUNDURABLEID')).toMatchObject({ member: !firstMember, timestamp, state: 'conflict', conflict: 'contradictory-id' })
    expect(disk.membershipEvents.EvUNDURABLEID).toBeUndefined()
  }
  expect(atAck[1]).toEqual(atAck[0])
  expect(reading(f).kind).toBe('unresolved')
  stub(f).script.inventory.push(membershipPage([C.primary])); await f.scan()
  expect(f.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(reading(f).kind).toBe('unresolved')
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.start(); await reopened.scan()
  expect(reopened.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(reading(reopened).kind).toBe('unresolved')
  expect(Object.values(life(reopened).membershipEvidence ?? {}).filter(record => record.conflict === 'contradictory-id')).toHaveLength(1)
  expect(life(reopened).membershipEvidence).toEqual(atAck[0]!.membershipEvidence)
  for (const member of [firstMember, !firstMember]) await reopened.event(member, C.primary, { id: 'EvUNDURABLEID', timestamp })
  expect(stub(reopened).socket.acks).toHaveLength(2)
  expect(life(reopened).membershipEvidence).toEqual(atAck[0]!.membershipEvidence)
  expect(life(reopened).membershipEvents.EvUNDURABLEID).toBeUndefined()
})

test('linked contradictory IDs hold both channels after reopen; the parser rejects broken links and normalized conflicts', async () => {
  const f = fixture(); await f.start()
  const event = { id: 'EvCROSSCHANNEL', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  await f.event(true, C.primary, event)
  const original = life(f).membershipEvidence![event.id]!
  await f.event(true, C.secondary, event)
  expect(stub(f).socket.acks).toHaveLength(2)
  const state = readSharedState(f.stateDir)!, evidence = state.personas.alpha!.membershipEvidence!
  const contradiction = Object.values(evidence).find(record => record.originalEvent === event.id)!
  expect(contradiction).toMatchObject({ channel: C.secondary, member: true, state: 'conflict', conflict: 'contradictory-id' })
  expect(evidence[event.id]).toEqual(original)
  // These are mutations of a production-written record, never hand-shaped
  // valid fixtures. The optional link's two supported historical baselines
  // remain readable, but a present link must retain its actual obligation.
  for (const change of [
    { originalEvent: 'EvMISSING' }, { originalEvent: contradiction.event }, { originalEvent: 'invalid id' },
    { originalEvent: null }, { state: 'applied' }, { state: 'superseded' }, { conflict: 'same-time' },
  ]) {
    const broken = structuredClone(state)
    Object.assign(broken.personas.alpha!.membershipEvidence![contradiction.event]!, change)
    expect(() => parseSharedChannelState(configBytes(broken), f.authority.path)).toThrow()
  }
  const legacy = structuredClone(state)
  delete legacy.personas.alpha!.membershipEvidence![contradiction.event]!.originalEvent
  expect(parseSharedChannelState(configBytes(legacy), f.authority.path)).not.toBeNull()
  const effectLink = structuredClone(state)
  delete effectLink.personas.alpha!.membershipEvidence![event.id]
  expect(parseSharedChannelState(configBytes(effectLink), f.authority.path)).not.toBeNull()
  stub(f).script.inventory.push(membershipPage([C.primary, C.secondary, C.private])); await f.scan()
  for (const channel of [C.primary, C.secondary]) expect(reading(f, channel)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  expect(reading(f, C.private).kind).toBe('eligible')
  await f.close()
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  stub(reopened).script.inventory.push(membershipPage([C.primary, C.secondary, C.private])); await reopened.start(); await reopened.scan()
  for (const channel of [C.primary, C.secondary]) expect(reading(reopened, channel)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
  expect(reading(reopened, C.private).kind).toBe('eligible')
  expect(reopened.scanner.status('alpha').problem).toBe('history-unresolved')
  expect(life(reopened).membershipEvidence![event.id]).toEqual(original)
  expect(life(reopened).membershipEvidence![contradiction.event]).toEqual(contradiction)
})

test('shared duplicate entry requires the complete original payload; a foundation effect alone cannot prove an exact live retry', async () => {
  const f = fixture(); await f.start()
  const event = { id: 'EvFULLPAYLOAD', timestamp: ((f.h.clock.now() + 1) / 1000).toFixed(3) }
  await f.event(true, C.primary, event)
  const evidence = life(f).membershipEvidence![event.id]!, before = f.authority.snapshot(), writes = f.writes.length
  const observe = (change: Partial<MembershipEvidence>) => f.authority.observeMembership('alpha', life(f).incarnation, {
    event: evidence.event, channel: evidence.channel, member: evidence.member, identity: evidence.identity,
    boundary: evidence.boundary, evidence: { ...evidence, ...change },
  }, f.authority.revision)
  // A replacement socket/order is local receipt context, not Slack payload.
  expect(observe({ connectionId: 'replacement-connection', observedRevision: f.authority.revision }).kind).toBe('applied')
  for (const change of [
    { channel: C.secondary }, { member: false }, { identity: 'different-installation' },
    { timestamp: `${event.timestamp}0` }, { channelType: 'group' },
    { isExtSharedChannel: true }, { isExtSharedChannel: undefined },
    { event: 'EvDIFFERENT' }, { originalEvent: 'EvUNEXPECTED' },
  ] satisfies Partial<MembershipEvidence>[]) expect(observe(change).kind).toBe('failed')
  expect(f.authority.snapshot()).toEqual(before)
  expect(readSharedState(f.stateDir)).toEqual(before)
  expect(f.writes).toHaveLength(writes)
  await f.close()
  // The older valid schema retained an effect without the complete payload.
  // Reuse keeps that effect but is unresolved, never guessed to be equivalent.
  delete before.personas.alpha!.membershipEvidence
  writeSharedState(f.stateDir, before)
  const reopened = fixture({ reopen: true, startTime: f.h.clock.now() + 1 }, f.stateDir)
  await reopened.start(); await reopened.event(true, C.primary, event)
  expect(stub(reopened).socket.acks).toHaveLength(1)
  expect(life(reopened).membershipEvents[event.id]).toEqual(before.personas.alpha!.membershipEvents[event.id])
  expect(Object.values(life(reopened).membershipEvidence ?? {})).toEqual([
    expect.objectContaining({ originalEvent: event.id, state: 'conflict', conflict: 'contradictory-id' }),
  ])
  stub(reopened).script.inventory.push(membershipPage([C.primary])); await reopened.scan()
  expect(reading(reopened)).toEqual({ kind: 'unresolved', reason: 'history-unresolved' })
})

test.each(['cross-channel', 'same-time', 'newer-choice'] as const)('later leave cannot supersede %s contradictory evidence without durable proof', async guard => {
  const f = fixture({ channels: [{ id: C.primary, delivery: 'all' }, { id: C.secondary, delivery: 'all' }] })
  stub(f).script.inventory.push(membershipPage([C.primary, C.secondary])); await f.start(); await f.scan()
  const base = f.h.clock.now(), time = (offset: number) => ((base + offset) / 1000).toFixed(3)
  const channel = guard === 'cross-channel' ? C.secondary : C.primary
  await f.event(true, C.primary, { id: 'EvORIGINAL', timestamp: time(10) })
  await f.event(false, channel, { id: 'EvORIGINAL', timestamp: time(10) })
  const conflict = Object.values(life(f).membershipEvidence!).find(e => e.originalEvent)!
  if (guard === 'newer-choice') f.failWrites(s => !!s.personas.alpha!.membershipEvents.EvLATERLEAVE)
  await f.event(false, channel, { id: 'EvLATERLEAVE', timestamp: time(guard === 'same-time' ? 10 : 20) })
  if (guard === 'newer-choice') {
    f.failWrites(() => false); expect(f.assign(channel, 'mentions').kind).toBe('applied')
    expect(f.membership.recover('alpha')).toBe(false)
  }
  expect(f.authority.choice('alpha', channel)).toBe(guard === 'newer-choice' ? 'mentions' : 'all')
  expect(life(f).membershipEvidence![conflict.event]!.state).toBe('conflict')
  expect(reading(f, channel).kind).toBe('unresolved')
  expect(life(f).membershipEvents.EvLATERLEAVE).toBeUndefined()
  // Sensitivity: a state flag alone cannot manufacture the missing proof.
  const forged = structuredClone(life(f))
  forged.membershipEvidence![conflict.event]!.state = 'superseded'
  const state = { ...f.authority.snapshot(), personas: { alpha: forged } }
  expect(() => parseSharedChannelState(configBytes(state), f.authority.path)).toThrow()
})

test.each(['strict', 'open'] as const)('%s affected uncertain choice holds socket acknowledgement while independent channel, DM and persona progress', async mode => {
  const f = fixture({ mode, names: ['alpha', 'beta'], channels: [C.primary, C.secondary].map(id => ({ id, delivery: 'all' })) })
  for (const key of ['alpha', 'beta']) stub(f, key).script.inventory.push(membershipPage([C.primary, C.secondary]))
  await f.start(); await f.scan()
  const choices = createChannelDeliveryStore(f.authority)
  const managed = makeManagedRouting(f.h, f.stateDir, { membership: f.membership, getChannelDelivery: () => choices })
  f.h.onEvent = createPersonaEventRouter({ membership: f.membership, routing: managed.routing, clientFor: f.h.clientFor, getPersona: f.h.getPersona, log: line => managed.logs.push(line) })
  try {
    f.failWrites(state => {
      writeSharedState(f.stateDir, state)
      throw new DurableWriteUnsyncedError(f.authority.path, { code: 'EIO' })
    })
    expect(f.assign(C.primary, 'off').kind).toBe('unresolved')
    expect(choices.readableFor('alpha', C.primary)).toBe(false)
    const held = makeChannelMessage({ channel: C.primary, text: 'held before durable recovery', ts: '1700000003.000001' })
    for (let retry = 0; retry < 2; retry++) await stub(f).socket.deliver(held)
    expect(stub(f).socket.acks).toEqual([]); expect(managed.queued('alpha')).toEqual([])
    const independent = makeChannelMessage({ channel: C.secondary, text: 'resolved sibling channel', ts: '1700000003.000002' })
    const dm = makeDm({ text: 'independent direct', ts: '1700000003.000003' })
    await stub(f).socket.deliver(independent); await stub(f).socket.deliver(dm)
    await stub(f, 'beta').socket.deliver(held)
    expect(stub(f).socket.acks).toHaveLength(2); expect(stub(f, 'beta').socket.acks).toHaveLength(1)
    const expectRetainedQueues = () => {
      const accepted = (name: string) => managed.queued(name).map(({ accepted: { text, channel, via, key } }) => ({ text, channel, via, key }))
      expect(accepted('alpha')).toEqual([
        { text: String(independent.text), channel: C.secondary, via: 'receive_all_shared', key: { chat_id: C.secondary, ts: String(independent.ts) } },
        { text: String(dm.text), channel: String(dm.channel), via: 'dm', key: { chat_id: String(dm.channel), ts: String(dm.ts) } },
      ])
      expect(accepted('beta')).toEqual([
        { text: String(held.text), channel: C.primary, via: 'receive_all', key: { chat_id: C.primary, ts: String(held.ts) } },
      ])
    }
    expectRetainedQueues()
    expect(f.authority.readable).toBe(false)
    f.failWrites(() => false); expect(f.authority.recoverDurability().kind).toBe('applied')
    expectRetainedQueues()
    await stub(f).socket.deliver(held)
    expect(stub(f).socket.acks).toHaveLength(3)
    expectRetainedQueues()
    expect(f.authority.choice('alpha', C.primary)).toBe('off')
    assertNoLeak(managed.logs)
  } finally { await managed.close() }
})

// t2.yiv.sf.aa: a scan applies each page's positives in one durable write.
const inbound = (channel: string, n: number) => makeChannelMessage({ channel, text: `page work ${n}`, ts: `1700000004.00000${n}` })
const accepted = (managed: ReturnType<typeof makeManagedRouting>, key: string) => managed.queued(key).map(({ accepted: { text, channel } }) => ({ text, channel }))
function routed(f: MembershipHarness) {
  const choices = createChannelDeliveryStore(f.authority)
  const managed = makeManagedRouting(f.h, f.stateDir, { membership: f.membership, getChannelDelivery: () => choices })
  f.h.onEvent = createPersonaEventRouter({ membership: f.membership, routing: managed.routing, clientFor: f.h.clientFor, getPersona: f.h.getPersona, log: line => managed.logs.push(line) })
  return managed
}

test.each(['positives', 'mid-page recovery'] as const)('a page of %s is durably ordered exactly as one-channel pages, in one write per page', async kind => {
  // In the recovery case C.primary's unprovable overlap is reconciled between the other two positives.
  const ids = kind === 'positives' ? [C.primary, C.secondary, C.private] : [C.private, C.primary, C.secondary]
  async function scanned(pages: string[][]) {
    const f = fixture()
    stub(f).script.inventory.push(...pages.map((page, i) => membershipPage(page, i + 1 < pages.length ? `page-${i + 1}` : undefined)))
    await f.start()
    if (kind === 'mid-page recovery') {
      const timestamp = (f.h.clock.now() / 1000).toFixed(3)
      await f.event(true, C.primary, { id: 'EvOVERLAPJOIN', timestamp })
      f.assign(C.primary, 'off')
      await f.event(false, C.primary, { id: 'EvOVERLAPLEAVE', timestamp })
      expect(reading(f).kind).toBe('unresolved')
    }
    const before = f.writes.length
    await f.scan()
    expect(f.scanner.status('alpha')).toMatchObject({ state: 'complete', pages: pages.length, positives: ids.length })
    expect(ids.map(id => reading(f, id).kind)).toEqual(ids.map(() => 'eligible'))
    // Scan and connection IDs are random, and declarations name each fixture's
    // directory; every other record and order must match.
    const { declaration: _declaration, ...rest } = life(f)
    const scanId = Object.keys(rest.membershipEvents).find(id => id.startsWith('scan:'))!.split(':')[1]!
    const text = JSON.stringify(rest).replaceAll(scanId, 'scan').replaceAll(f.h.manager.provenance('alpha')!.connectionId, 'connection')
    return { writes: f.writes.length - before, revision: f.authority.revision, life: JSON.parse(text) as typeof rest }
  }
  const batched = await scanned([ids]), single = await scanned(ids.map(id => [id]))
  expect({ ...batched, writes: undefined }).toEqual({ ...single, writes: undefined })
  if (kind === 'positives') {
    // One write for the page, then the inventory commit.
    expect([batched.writes, single.writes]).toEqual([2, ids.length + 1])
    const events = ids.map(id => batched.life.membershipEvents[`scan:scan:${id}`]!)
    expect(events.map(e => e.order)).toEqual(events.map((_, i) => events[0]!.order + i))
    expect(ids.map(id => batched.life.membership[id]!.boundary)).toEqual(events.map(e => e.order))
  }
})

const PAGE_FAILURES = {
  // A refused batch writes nothing; the singles then stop at the refusal.
  refused: { writes: 3, durable: [C.primary], eligible: [C.primary], status: { state: 'incomplete', problem: 'storage' } },
  // A channel listed again with other metadata: the earlier positives apply, then its own is withdrawn.
  duplicate: { writes: 1, durable: [C.primary, C.secondary], eligible: [C.primary], status: { state: 'incomplete', problem: 'malformed-page' } },
  deadline: { writes: 0, durable: [], eligible: [], status: { state: 'incomplete', problem: 'deadline' } },
  cancelled: { writes: 0, durable: [], eligible: [], status: { state: 'unverified' } },
} as const
test.each(Object.keys(PAGE_FAILURES) as Array<keyof typeof PAGE_FAILURES>)('a %s page keeps only positives a write accepted; staged positives never apply and the retry completes', async failure => {
  const f = fixture(), ids = [C.primary, C.secondary, C.private], page = makeDeferredWebApiCall(), expected = PAGE_FAILURES[failure]
  stub(f).script.inventory.push(page.outcome)
  await f.start(); await f.scan()
  if (failure === 'refused') f.failWrites(state => state.personas.alpha?.membership[C.secondary] !== undefined)
  else if (failure !== 'duplicate') {
    // Nothing else can run inside one synchronous page. The scanner checks
    // currency once when the page arrives, then before each channel: the
    // fourth check, C.private's, sees the deadline or the gap.
    const interrupt = failure === 'cancelled' ? () => f.scanner.connectionChanged('alpha') : () => {
      const deadline = f.scanner.status('alpha').deadline!, now = f.h.clock.now
      f.h.clock.now = () => { f.h.clock.now = now; return deadline }
    }
    const isCurrent = f.membership.isCurrent
    let checks = 0
    f.membership.isCurrent = generation => {
      if (++checks === 4) interrupt()
      return isCurrent(generation)
    }
  }
  const before = f.writes.length
  page.settle(membershipPage(failure === 'duplicate' ? [C.primary, C.secondary,
    { id: C.secondary, is_channel: true, is_group: false, is_im: false, is_mpim: false, is_ext_shared: true }] : ids))
  await f.h.clock.flush()
  expect(f.writes.length - before).toBe(expected.writes)
  expect(ids.filter(id => life(f).membership[id] !== undefined)).toEqual([...expected.durable])
  expect(ids.filter(id => reading(f, id).kind === 'eligible')).toEqual([...expected.eligible])
  expect(f.authority.readable).toBe(true)
  expect(f.scanner.status('alpha')).toMatchObject(expected.status)
  f.failWrites(() => false)
  stub(f).script.inventory.push(membershipPage(ids))
  await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
  expect(f.scanner.status('alpha').state).toBe('complete')
  expect(ids.map(id => reading(f, id).kind)).toEqual(ids.map(() => 'eligible'))
})

test('an unsynced page write holds only that page for its persona; earlier pages, DMs, the sibling and accepted queues progress, and the next scan restores the page without a new choice', async () => {
  const first = [C.primary, C.secondary], later = channelPopulation(2).map(c => c.id), ids = [...first, ...later]
  const f = fixture({ names: ['alpha', 'beta'], channels: ids.map(id => ({ id, delivery: 'all' })) })
  const second = makeDeferredWebApiCall()
  stub(f).script.inventory.push(membershipPage(first, 'next'), second.outcome)
  stub(f, 'beta').script.inventory.push(membershipPage(ids))
  await f.start(); await f.scan()
  expect([f.scanner.status('alpha').state, f.scanner.status('beta').state]).toEqual(['scanning', 'complete'])
  const assignments = structuredClone(life(f).assignments), managed = routed(f)
  try {
    let unsynced = false
    f.unsyncWrites(state => !unsynced && state.personas.alpha?.membership[later[0]!] !== undefined && (unsynced = true))
    second.settle(membershipPage(later)); await f.h.clock.flush()
    expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'storage' })
    expect(f.authority.readable).toBe(false)
    const held = (key: string) => ids.filter(id => reading(f, id, key).kind !== 'eligible')
    expect([held('alpha'), held('beta')]).toEqual([later, []])
    expect(ids.filter(id => !f.authority.readableFor('alpha', id))).toEqual(later)
    const waiting = inbound(later[0]!, 1), sibling = inbound(C.primary, 2), other = inbound(later[0]!, 3)
    const dm = makeDm({ text: 'independent direct', ts: '1700000004.000004' })
    await stub(f).socket.deliver(waiting)
    expect(stub(f).socket.acks).toEqual([])
    await stub(f).socket.deliver(sibling); await stub(f).socket.deliver(dm); await stub(f, 'beta').socket.deliver(other)
    expect([stub(f).socket.acks.length, stub(f, 'beta').socket.acks.length]).toEqual([2, 1])
    expect(accepted(managed, 'alpha')).toEqual([{ text: String(sibling.text), channel: C.primary }, { text: String(dm.text), channel: String(dm.channel) }])
    expect(accepted(managed, 'beta')).toEqual([{ text: String(other.text), channel: later[0] }])
    f.unsyncWrites(() => false); expect(f.authority.recoverDurability().kind).toBe('applied')
    stub(f).script.inventory.push(membershipPage(ids))
    await f.h.clock.advanceTo(f.scanner.status('alpha').nextAttemptAt!)
    expect(f.scanner.status('alpha').state).toBe('complete')
    expect(held('alpha')).toEqual([])
    expect(life(f).assignments).toEqual(assignments)
    await stub(f).socket.deliver(waiting)
    expect(stub(f).socket.acks).toHaveLength(3)
    expect(accepted(managed, 'alpha').at(-1)).toEqual({ text: String(waiting.text), channel: later[0] })
    assertNoLeak(managed.logs)
  } finally { await managed.close() }
})

test('page-1 positives release held redeliveries while page 2 hangs and after it fails; the unscanned channel stays held', async () => {
  const first = [C.primary, C.secondary], ids = [...first, C.private]
  const f = fixture({ channels: ids.map(id => ({ id, delivery: 'all' })) })
  stub(f).script.inventory.push(membershipPage(ids))
  await f.start(); await f.scan()
  const managed = routed(f)
  try {
    const second = makeDeferredWebApiCall()
    stub(f).script.inventory.push(membershipPage(first, 'next'), second.outcome)
    f.scanner.connectionChanged('alpha')
    const during = inbound(C.primary, 1), after = inbound(C.secondary, 2), unscanned = inbound(C.private, 3)
    for (const message of [during, after, unscanned]) await stub(f).socket.deliver(message)
    expect(stub(f).socket.acks).toEqual([])
    await f.h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
    expect(f.scanner.status('alpha')).toMatchObject({ state: 'scanning', pages: 1, positives: first.length })
    for (const message of [during, unscanned]) await stub(f).socket.deliver(message)
    expect(accepted(managed, 'alpha')).toEqual([{ text: String(during.text), channel: C.primary }])
    second.settle({ kind: 'platform', error: 'internal_error' }); await f.h.clock.flush()
    expect(f.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'transport' })
    for (const message of [after, unscanned]) await stub(f).socket.deliver(message)
    expect(accepted(managed, 'alpha')).toEqual([during, after].map(m => ({ text: String(m.text), channel: String(m.channel) })))
    expect(stub(f).socket.acks).toHaveLength(2)
    expect(reading(f, C.private).kind).toBe('unresolved')
    assertNoLeak(managed.logs)
  } finally { await managed.close() }
})
