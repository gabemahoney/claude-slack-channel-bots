import { afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { ChannelMode } from '../src/config.ts'
import type { ReloadApplyFailure } from '../src/reload.ts'
import type { ChannelMembership, MembershipGeneration, MembershipReading } from '../src/channel-membership.ts'
import type { MembershipScanStatus } from '../src/channel-membership-scan.ts'
import { sharedPersonaChannels, type SharedChannelAuthority, type SharedUnresolvedScope } from '../src/shared-channels.ts'
import { createPersonaEpisodes, type PersonaEpisodes, type PersonaEpisodeView } from '../src/persona-episodes.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { MEMBERSHIP_EVIDENCE_UNRESOLVED, SHARED_STATE_UNRESOLVED } from '../src/persona-diagnostics.ts'
import {
  createSharedStateReporting, buildSharedStateUnresolvedNotice, buildSharedStateUnresolvedLine,
  buildMembershipEvidenceUnresolvedNotice, buildMembershipEvidenceUnresolvedLine,
  buildSharedStateRecoveredNotice, buildSharedStateRecoveredLine, buildReloadApplyFailedNotice,
  type SharedStateReportingDeps, type SharedStateReportScope, type SharedStateCause,
  type SharedStateClosing, type MembershipReportEvidence,
} from '../src/shared-state-reports.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
import { initialSharedState, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'

const A = SHARED_CHANNEL_IDS.primary
const B = SHARED_CHANNEL_IDS.secondary
const MESSAGE_BODY = 'reporter-private-message-body'
const stateScope = (channels: string[] = [A], all = false, dm = false): SharedStateReportScope => ({ channels, all, dm })
const evidenceScope = (channels: string[] = [A], all = false): SharedStateReportScope => ({ channels, all })
interface ScriptedRow {
  generation: MembershipGeneration
  scope: SharedUnresolvedScope | undefined
  scan: MembershipScanStatus
  ended: boolean
  unresolved: string[]
  readings: Map<string, MembershipReading>
}
const cleanup: (() => Promise<void>)[] = []

function harness(mode: ChannelMode = 'open') {
  const clock = createFakeClock()
  const posts: { key: string; text: string }[] = [], lines: string[] = [], episodeLines: string[] = []
  const atPost: { state?: PersonaEpisodeView; evidence?: PersonaEpisodeView }[] = []
  const calls: string[] = [], forbidden: string[] = []
  const throwAt = new Set<string>()
  const touch = (name: string) => { calls.push(name); if (throwAt.has(name)) throw new Error('scripted dependency refusal') }
  const state = initialSharedState(tmpdir(), makePersonaConfigInput({ channel_mode: mode,
    personas: ['alpha', 'beta'].map(name => makePersona({ name, channels: [{ id: A, delivery: 'all' }, { id: B, delivery: 'mentions' }],
      permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }, tmpdir())) }, tmpdir()))
  // A body in otherwise unused state must never be copied into reporting.
  state.source.unused_message_body = MESSAGE_BODY
  const identity = { teamId: 'T0REPORT', appId: 'A0REPORT', botUserId: 'U0REPORT', botId: 'B0REPORT' }
  const rows = new Map<string, ScriptedRow>(['alpha', 'beta'].map(key => {
    const incarnation = state.personas[key]!.incarnation
    const generation: MembershipGeneration = { key, incarnation, generation: key, identity, identityKey: key,
      provenance: { key, incarnation, connectionId: key, identity, applied: true, candidate: false, isCurrent: () => true },
      positives: new Map(), absent: new Set(), holds: new Map(), complete: true, observations: 0 }
    return [key, { generation, scope: undefined as SharedUnresolvedScope | undefined,
      scan: { state: 'complete', pages: 1, positives: 2 } as MembershipScanStatus, ended: true,
      unresolved: [] as string[], readings: new Map<string, MembershipReading>() }]
  }))
  const row = (key = 'alpha') => rows.get(key)!
  const control = { readable: true, cause: undefined as SharedChannelAuthority['unreadableCause'],
    muted: false, sink: 'ok' as 'ok' | 'throw' | 'reject', path: '/fixture/shared-state', failure: fakeToken(BOT_TOKEN_PREFIX) }
  // The reporter swallows throws; record unexpected access separately so it cannot hide a write.
  function readOnly<T extends object>(name: string, target: T): T {
    return new Proxy(target, {
      get(object, property, receiver) {
        if (!(property in object)) { forbidden.push(`${name}.${String(property)}`); throw new Error('unexpected authority/membership access') }
        return Reflect.get(object, property, receiver)
      },
      set(_object, property) { forbidden.push(`${name}.${String(property)}=`); throw new Error('unexpected mutation') },
    })
  }
  const authority: SharedStateReportingDeps['authority'] = readOnly('authority', {
    get readable() { touch('readable'); return control.readable },
    get unreadableCause() { touch('unreadableCause'); return control.cause },
    get path() { touch('path'); return control.path },
    get failure() { touch('failure'); return control.failure },
    unresolvedScope(key: string) { touch('unresolvedScope'); return row(key).scope },
    reportingChannels(key) { touch('reportingChannels'); return sharedPersonaChannels(state, key) },
    inspectMembershipHistory(key, read) { touch('inspectMembershipHistory'); return read(state.personas[key]) },
  } satisfies SharedStateReportingDeps['authority'])
  const membership: SharedStateReportingDeps['membership'] = readOnly('membership', {
    generation(key) { touch('generation'); return row(key).generation },
    read(key, channel, seenMode) { touch('read'); calls.push(`read:${key}:${channel}:${seenMode}`); return row(key).readings.get(channel) ?? { kind: 'ineligible', reason: 'absent' } },
    unresolvedChannels(key) { touch('unresolvedChannels'); return row(key).unresolved },
  } satisfies Pick<ChannelMembership, 'generation' | 'read' | 'unresolvedChannels'>)
  const episodes: PersonaEpisodes = createPersonaEpisodes({ clock, log: line => episodeLines.push(line),
    teardownWindow: () => control.muted ? 'submitted' : 'none',
    sink(key, text) {
      posts.push({ key, text })
      atPost.push({ state: episodes.view(key, SHARED_STATE_UNRESOLVED), evidence: episodes.view(key, MEMBERSHIP_EVIDENCE_UNRESOLVED) })
      if (control.sink === 'throw') throw new Error('notice sink refused')
      if (control.sink === 'reject') return Promise.reject(new Error('notice sink refused'))
    } })
  const reporter = createSharedStateReporting({ episodes, authority, membership,
    log(line) { touch('log'); lines.push(line) },
    persona(key) { touch('persona'); return { key, name: key } },
    mode() { touch('mode'); return mode },
    scanStatus(key) { touch('scanStatus'); return row(key).scan },
    scanEnded(key) { touch('scanEnded'); return row(key).ended },
  })
  const check = (key = 'alpha') => reporter.check(key)
  function unsaved(channels: string[] = [A], key = 'alpha') { for (const channel of channels) row(key).generation.holds.set(channel, 'event-not-durable') }
  function clear(key = 'alpha') { row(key).scope = undefined; row(key).generation.holds.clear(); control.cause = undefined; control.readable = true }
  function scan(problem: MembershipScanStatus['problem'], key = 'alpha') {
    row(key).scan = { state: 'incomplete', pages: 1, positives: 0, problem, slackError: fakeToken(BOT_TOKEN_PREFIX), nextAttemptAt: clock.now() + 100 }
    row(key).unresolved = [A]
  }
  function stateReport(cause: SharedStateCause, scope = stateScope(), key = 'alpha') {
    return { post: { key, text: buildSharedStateUnresolvedNotice(renderPersonaRef(key, key), scope, cause, control.path, control.failure) },
      line: buildSharedStateUnresolvedLine(key, scope, cause, control.path, control.failure) }
  }
  function evidenceReport(evidence: MembershipReportEvidence, scope = evidenceScope(), key = 'alpha') {
    return { post: { key, text: buildMembershipEvidenceUnresolvedNotice(renderPersonaRef(key, key), scope, evidence) },
      line: buildMembershipEvidenceUnresolvedLine(key, scope, evidence, control.path, control.failure) }
  }
  function recovered(closing: SharedStateClosing, scope = stateScope(), key = 'alpha') {
    return { post: { key, text: buildSharedStateRecoveredNotice(renderPersonaRef(key, key), scope, closing) },
      line: buildSharedStateRecoveredLine(key, scope, closing, control.path, control.failure) }
  }
  cleanup.push(async () => {
    await clock.flush()
    assertNoLeak({ posts, lines, episodeLines })
    expect(JSON.stringify([posts, lines, episodeLines])).not.toContain(MESSAGE_BODY)
    expect(forbidden).toEqual([])
    reporter.stop()
    episodes.close()
  })
  return { clock, posts, atPost, lines, episodeLines, calls, forbidden, throwAt, state, row, control, episodes, reporter,
    check, unsaved, clear, scan, stateReport, evidenceReport, recovered }
}
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})
function expectReports(h: ReturnType<typeof harness>, reports: { post: { key: string; text: string }; line: string }[]) {
  expect(h.posts).toEqual(reports.map(r => r.post))
  expect(h.lines).toEqual(reports.map(r => r.line))
}

describe('shared-state reporter episodes', () => {
  test('reload failure fingerprints post once per persona, change independently and close silently on apply', () => {
    const h = harness()
    const failure: ReloadApplyFailure = { fingerprint: 'first-review', record: 'authority', failure: h.control.failure, personas: ['alpha', 'beta'] }
    const expected = (key: string) => ({ key, text: buildReloadApplyFailedNotice(renderPersonaRef(key, key), { ...failure, path: h.control.path }) })
    h.reporter.reloadApplyFailed(failure)
    h.reporter.reloadApplyFailed(failure)
    expect(h.posts).toEqual(['alpha', 'beta'].map(expected))
    h.reporter.reloadApplyFailed({ ...failure, fingerprint: 'next-review', personas: ['alpha'] })
    expect(h.posts).toEqual(['alpha', 'beta', 'alpha'].map(expected))
    expect(h.episodes.view('alpha', 'reload-apply-failed')?.caseLabel).toBe('next-review')
    expect(h.episodes.view('beta', 'reload-apply-failed')?.caseLabel).toBe('first-review')
    h.reporter.reloadApplied(); h.reporter.reloadApplied()
    expect(h.episodes.openKeys('reload-apply-failed')).toEqual([])
    expect(h.posts).toEqual(['alpha', 'beta', 'alpha'].map(expected))
    expect(h.lines).toEqual([])
    // Closure releases every persona's latch, including the unchanged fingerprint.
    h.reporter.reloadApplyFailed(failure)
    expect(h.posts).toEqual(['alpha', 'beta', 'alpha', 'alpha', 'beta'].map(expected))
    h.reporter.stop()
    h.reporter.reloadApplyFailed({ ...failure, fingerprint: 'after-stop' })
    h.reporter.reloadApplied()
    expect(h.posts).toHaveLength(5)
  })

  test.each(['persona', 'path', 'sink'] as const)('reload reporting isolates a throwing %s dependency', async dep => {
    const h = harness()
    if (dep === 'sink') h.control.sink = 'throw'
    else h.throwAt.add(dep)
    const failure: ReloadApplyFailure = { fingerprint: 'throwing-review', record: 'retired-keys', failure: h.control.failure, personas: ['alpha', 'beta'] }
    expect(() => h.reporter.reloadApplyFailed(failure)).not.toThrow()
    expect(() => h.reporter.reloadApplyFailed(failure)).not.toThrow()
    await h.clock.flush()
    expect(h.posts).toHaveLength(dep === 'sink' ? 2 : 0)
    expect(() => h.reporter.reloadApplied()).not.toThrow()
    expect(h.episodes.openKeys('reload-apply-failed')).toEqual([])
  })

  test('healthy checks read only the cheap scope, holds and scan status', () => {
    const h = harness()
    h.check()
    expect(h.calls.sort()).toEqual(['generation', 'readable', 'scanStatus', 'unresolvedScope'])
    expectReports(h, [])
  })

  test('one post per cause, severity only increases, and staging inside an episode logs without posting', () => {
    const h = harness()
    h.unsaved(); h.check(); h.check()
    const reports = [h.stateReport('not-saved')]
    expectReports(h, reports)
    h.row().scope = { channels: [A], all: true, dm: false }
    h.check(); reports.push(h.stateReport('retirement-unresolved', stateScope([A, B], true)))
    for (const cause of ['unsynced', 'evidence-changed'] as const) {
      h.control.readable = false; h.control.cause = cause; h.check(); h.check()
      reports.push(h.stateReport(cause, stateScope([A, B], true)))
    }
    h.control.readable = false; h.control.cause = 'unsynced'; h.check()
    expectReports(h, reports)
    h.control.cause = 'restoration-staged'; h.check(); h.check()
    expect(h.posts).toEqual(reports.map(r => r.post))
    expect(h.lines).toEqual([...reports.map(r => r.line), h.stateReport('restoration-staged', {
      ...stateScope([A, B], true), repairPending: { usable: [A, B], held: [] },
    }).line])
    expect(h.episodes.view('alpha', SHARED_STATE_UNRESOLVED)?.caseLabel).toBe('restoration-staged')
  })

  test('readable retirement scope wins over unsaved evidence and is not skipped', () => {
    const h = harness()
    h.row().scope = { channels: [], all: true, dm: true }
    h.check()
    expectReports(h, [h.stateReport('retirement-unresolved', stateScope([A, B], true, true))])
    h.unsaved(); h.check()
    expectReports(h, [h.stateReport('retirement-unresolved', stateScope([A, B], true, true))])
    h.control.readable = false; h.control.cause = 'unsynced'; h.check()
    expect(h.posts.at(-1)).toEqual(h.stateReport('unsynced', stateScope([A, B], true, true)).post)
  })

  test.each(['open', 'strict'] as const)('staged repair labels usable and held channels in %s', mode => {
    const h = harness(mode)
    h.control.readable = false; h.control.cause = 'restoration-staged'
    h.check()
    expectReports(h, [h.stateReport('restoration-staged', { ...stateScope([A, B], true), repairPending: { usable: [A, B], held: [] } })])
    expect(h.calls).toContain(`read:alpha:${A}:${mode}`)
    expect(h.calls).toContain(`read:alpha:${B}:${mode}`)
    // A new life with an actual hold must distinguish it from the usable channel.
    h.reporter.forget('alpha'); h.episodes.forget('alpha')
    h.row().readings.set(B, { kind: 'unresolved', reason: 'shared-state-unreadable' })
    h.check()
    expect(h.posts.at(-1)).toEqual(h.stateReport('restoration-staged', {
      ...stateScope([A, B], true), repairPending: { usable: [A], held: [B] },
    }).post)
  })

  test('history evidence selects absence-order per channel and event-history otherwise', () => {
    const h = harness()
    h.row().generation.holds.set(A, 'history-unresolved')
    h.row().generation.holds.set(B, 'history-unresolved')
    h.state.personas.alpha!.membershipAbsenceConflicts = { [A]: { identity: 'fixture', boundary: 1,
      observedThrough: '1.0', observedRevision: 1, assignmentOrder: 2, recordedOrder: 3 } }
    h.check(); h.check()
    expectReports(h, [h.evidenceReport({ history: [{ channel: A, evidence: 'absence-order' }, { channel: B, evidence: 'event-history' }] }, evidenceScope([A, B]))])
    expect(h.episodes.view('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)?.caseLabel).toBe('event-history')
  })

  test.each(['authentication', 'installation-unverified', 'malformed-page', 'current-membership-missing', 'eligibility-missing', 'event-order-conflict'] as const)(
    'ended %s is bounded across retries and waits for a complete scan', problem => {
      const h = harness(); h.scan(problem); h.check()
      const evidence = { history: [], problem, slackError: h.row().scan.slackError, nextAttemptAt: h.row().scan.nextAttemptAt }
      const onset = h.evidenceReport(evidence)
      h.row().scan.state = 'scanning'; h.check()
      h.scan(problem); h.check(); h.check()
      expectReports(h, [onset])
      expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(true)
      h.row().scan = { state: 'complete', pages: 1, positives: 1 }; h.row().unresolved = []
      h.row().readings.set(A, { kind: 'unresolved', reason: 'current-membership-missing' })
      h.check(); expectReports(h, [onset])
      h.row().readings.clear()
      h.check(); h.check()
      expectReports(h, [onset, h.recovered('evidence')])
    })

  test.each(['authentication', 'access'] as const)('escalation to %s posts once more', problem => {
    const h = harness(); h.scan('malformed-page'); h.check()
    h.scan(problem); h.check(); h.check()
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]).toEqual(h.evidenceReport({ history: [], problem,
      slackError: h.row().scan.slackError, nextAttemptAt: h.row().scan.nextAttemptAt }).post)
    h.scan('malformed-page'); h.check()
    expect(h.posts).toHaveLength(2)
  })

  test.each(['transport', 'superseded', 'history-unresolved'] as const)('%s scan does not post or close an existing evidence episode', problem => {
    const h = harness(); h.scan(problem); h.check(); expectReports(h, [])
    h.scan('malformed-page'); h.check()
    const before = h.episodes.view('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)
    h.scan(problem); h.check(); h.check()
    expect(h.posts).toHaveLength(1); expect(h.lines).toHaveLength(1)
    expect(h.episodes.view('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toEqual(before)
  })

  test('request-published incomplete status has no ended-run report', () => {
    const h = harness(); h.scan('authentication'); h.row().ended = false
    h.check(); h.check(); expectReports(h, [])
    expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(false)
    h.row().ended = true; h.check(); expect(h.posts).toHaveLength(1)
  })

  test.each([false, true])('ended storage reports not-saved; all-channel fallback=%s', all => {
    const h = harness(); h.scan('storage'); if (all) h.row().unresolved = []
    h.check(); h.check()
    expectReports(h, [h.stateReport('not-saved', stateScope(all ? [A, B] : [A], all))])
    expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(false)
  })

  test('storage after an unsaved hold adds no duplicate report', () => {
    const h = harness(); h.unsaved(); h.check(); h.scan('storage'); h.check()
    expectReports(h, [h.stateReport('not-saved')])
    expect(h.calls).not.toContain('reportingChannels')
    expect(h.calls).not.toContain('inspectMembershipHistory')
  })

  test.each(['open', 'strict'] as const)('remembered channels delay recovery in %s and the next episode posts afresh', mode => {
    const h = harness(mode); h.unsaved(); h.check()
    h.row().generation.holds.clear(); h.unsaved([B]); h.check()
    expectReports(h, [h.stateReport('not-saved')])
    h.clear(); h.row().readings.set(A, { kind: 'unresolved', reason: 'current-membership-missing' })
    h.check(); expect(h.posts).toHaveLength(1)
    expect(h.episodes.isOpen('alpha', SHARED_STATE_UNRESOLVED)).toBe(true)
    h.row().readings.delete(A); h.row().readings.set(B, { kind: 'unresolved', reason: 'eligibility-missing' })
    h.check(); expect(h.posts).toHaveLength(1)
    h.row().readings.clear(); h.check(); h.check()
    expectReports(h, [h.stateReport('not-saved'), h.recovered('state', stateScope([A, B]))])
    expect(h.calls).toContain(`read:alpha:${A}:${mode}`); expect(h.calls).toContain(`read:alpha:${B}:${mode}`)
    h.unsaved(); h.check(); expect(h.posts).toHaveLength(3)
  })

  test.each(['dm', 'all'] as const)('%s scope must clear, and all scope checks unresolved inventory too', claim => {
    const h = harness(); h.row().scope = { channels: [A], all: claim === 'all', dm: claim === 'dm' }
    h.check(); const count = h.posts.length
    h.row().scope!.channels = []; h.check(); expect(h.posts).toHaveLength(count)
    h.row().scope = undefined
    if (claim === 'all') { h.row().unresolved = [B]; h.check(); expect(h.posts).toHaveLength(count); h.row().unresolved = [] }
    h.check(); expect(h.posts).toHaveLength(count + 1)
    expect(h.episodes.isOpen('alpha', SHARED_STATE_UNRESOLVED)).toBe(false)
  })

  test.each([false, true])('overlapping episodes recover only once; simultaneous close=%s', simultaneous => {
    const h = harness(); h.unsaved(); h.scan('malformed-page'); h.check()
    expect(h.posts).toHaveLength(2)
    h.clear()
    if (!simultaneous) {
      h.check(); expect(h.posts).toHaveLength(2)
      expect(h.episodes.isOpen('alpha', SHARED_STATE_UNRESOLVED)).toBe(false)
      expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(true)
    }
    h.row().scan = { state: 'complete', pages: 1, positives: 1 }; h.row().unresolved = []
    h.check(); h.check()
    expect(h.posts).toHaveLength(3); expect(h.lines).toHaveLength(3)
    expect(h.posts.at(-1)).toEqual(h.recovered('evidence').post)
    expect(h.lines.at(-1)).toBe(h.recovered('evidence').line)
    expect(h.atPost.at(-1)?.evidence?.posted).toContain('recovered')
    expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(false)
  })

  test('without a reporter onset an externally opened episode produces no recovery', () => {
    const h = harness(); h.episodes.begin('alpha', SHARED_STATE_UNRESOLVED, 'not-saved')
    h.unsaved(); h.check(); expectReports(h, [])
    h.clear(); h.check(); expectReports(h, [])
    expect(h.episodes.isOpen('alpha', SHARED_STATE_UNRESOLVED)).toBe(false)
  })

  test('a repair activated without a failure has a silent onset and one completion', () => {
    const h = harness(); h.row().scan.state = 'scanning'
    h.reporter.repairActivated(['alpha']); h.check(); expectReports(h, [])
    h.row().scan.state = 'complete'; h.check(); h.check()
    expectReports(h, [h.recovered('repair', stateScope([A, B], true))])
  })

  test('a real failure during repair posts, then repair completion waits for scan and membership', () => {
    const h = harness(); h.row().scan.state = 'scanning'
    h.reporter.repairActivated(['alpha']); h.check(); expectReports(h, [])
    h.unsaved(); h.check(); expectReports(h, [h.stateReport('not-saved')])
    h.clear(); h.check(); expect(h.posts).toHaveLength(1)
    h.row().scan.state = 'complete'; h.row().unresolved = [B]; h.check(); expect(h.posts).toHaveLength(1)
    h.row().unresolved = []; h.check(); h.check()
    expectReports(h, [h.stateReport('not-saved'), h.recovered('repair', stateScope([A, B], true))])
  })

  test.each(['throw', 'reject', 'muted'] as const)('notice %s keeps the episode latched and logs its failure facts', async outcome => {
    const h = harness(); h.unsaved()
    if (outcome === 'muted') h.control.muted = true
    else h.control.sink = outcome
    h.check(); await h.clock.flush()
    const episode = h.episodes.view('alpha', SHARED_STATE_UNRESOLVED)
    h.check(); h.check(); await h.clock.flush()
    expect(h.posts).toHaveLength(outcome === 'muted' ? 0 : 1)
    expect(h.lines).toEqual([h.stateReport('not-saved').line])
    expect(h.episodes.view('alpha', SHARED_STATE_UNRESOLVED)).toEqual(episode)
    expect(h.episodes.isOpen('alpha', MEMBERSHIP_EVIDENCE_UNRESOLVED)).toBe(false)
  })

  test('forget discards prior channels when teardown also forgets its episodes; keys remain independent', () => {
    const h = harness(); h.unsaved([A]); h.unsaved([B], 'beta'); h.reporter.checkAll(['alpha', 'beta'])
    const beta = h.episodes.view('beta', SHARED_STATE_UNRESOLVED)
    h.reporter.forget('alpha'); h.episodes.forget('alpha'); h.clear()
    h.row().readings.set(A, { kind: 'unresolved', reason: 'current-membership-missing' })
    h.unsaved([B]); h.check(); h.clear(); h.check()
    expect(h.posts.at(-1)).toEqual(h.recovered('state', stateScope([B])).post)
    expect(h.episodes.view('beta', SHARED_STATE_UNRESOLVED)).toEqual(beta)
    expect(h.posts.filter(p => p.key === 'beta')).toHaveLength(1)
  })

  test.each(['unresolvedScope', 'generation', 'scanStatus', 'scanEnded', 'readable', 'unreadableCause', 'reportingChannels',
    'unresolvedChannels', 'read', 'path', 'failure', 'persona', 'mode', 'log'])('throwing %s is contained', dependency => {
    const h = harness(); h.unsaved(); h.row().scope = { channels: [A], all: true, dm: true }
    h.control.cause = 'restoration-staged'; h.scan('storage'); h.throwAt.add(dependency)
    expect(() => h.check()).not.toThrow()
    expect(h.calls).toContain(dependency)
  })

  test('throwing history inspection is contained', () => {
    const h = harness(); h.row().generation.holds.set(A, 'history-unresolved')
    h.throwAt.add('inspectMembershipHistory')
    expect(() => h.check()).not.toThrow()
    expect(h.calls).toContain('inspectMembershipHistory')
  })

  test('stop prevents every reporting entry point from logging, posting or reading dependencies', () => {
    const h = harness(); h.unsaved(); h.check(); h.reporter.stop()
    const before = { posts: [...h.posts], lines: [...h.lines], calls: [...h.calls] }
    h.clear(); h.check(); h.reporter.checkAll(['alpha', 'beta']); h.reporter.repairActivated(['beta'])
    h.reporter.reloadApplyFailed({ fingerprint: 'fixture', record: 'authority', failure: 'disk', personas: ['beta'] })
    h.reporter.reloadApplied(); h.reporter.forget('alpha')
    expect({ posts: h.posts, lines: h.lines, calls: h.calls }).toEqual(before)
  })
})
