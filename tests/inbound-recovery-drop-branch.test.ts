

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { recordFailure } from '../src/backoff.ts'
import {
  latchRowStateRead
} from '../src/conflict-latch.ts'
import { LIVE_ROW_LAUNCH_REASON_RETIRED_KEY, LIVE_ROW_LAUNCH_REUSE, LIVE_ROW_OUTCOME_LAUNCHED, liveRowSequenceStartLine } from '../src/live-row-sequence.ts'
import {
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING
} from '../src/liveness-reading.ts'
import {
  getOutageFlags,
  type OutageClass
} from '../src/outage-state.ts'
import { PENDING_ROW_REASON_CWD_MISMATCH, PENDING_ROW_REASON_RETIRED_OLD_LIFE, type PendingRowNotCoveredReason } from '../src/pending-row.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import {
  HUMAN_TRIGGER_DELAY_CEILING,
  initRestart,
  isRestartPendingOrActive,
  restartOldLifeHeldLine,
  runRestartRetry,
  scheduleRestart
} from '../src/restart.ts'
import { OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, RETIRED_KEY_CAUSE_REMOVED } from '../src/retired-keys.ts'
import { LIVENESS_STATUS_SITE } from '../src/server.ts'
import {
  OLD_LIFE_ROW_READ_STATE, SPAWN_ACTION_FRESH_RETIRED, isLaunchInFlight, killPersonaInstanceForTeardown,
  launchForLiveRowSequence,
  noteOldLifeRowRead,
  readPersonaOwnRow, readPersonaRowState, uncoveredPendingRowLine
} from '../src/session-manager.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_ROW_ABSENT, UNAVAILABLE_RETRY_RUN_NOW_RAN,
} from '../src/unavailable-retry.ts'
import {
  SAMPLE_LAUNCH_START_NONE,
  cannedErr,
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedOk,
  cannedStatusResult,
  errConfigMalformed,
  errInternal,
  errInvalidFlags,
  errSchemaMismatch,
  errSystemInstallDisappeared,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  holdFindMissing,
  provenanceNote,
  unavailableForms,
  type CannedGetResult,
  type FindMissingHold
} from './test-helpers/agent-director-stub.ts'
import { LAUNCH_START_ABSENT_PERSONA_KEY } from './test-helpers/conflict-cases.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { absentRow } from './test-helpers/old-life.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  resetRoutingState,
  waitFor,
  type RoutingHarness
} from './test-helpers/persona-routing-harness.ts'
import {
  expectLostMessageReports,
  expectPendingOnlyWatch,
  holdSequenceReuse,
  holdThroughReuse,
  installGoneRestartProbe,
  launchThroughSequence,
  makeRecoveryHarness,
  ownRowsLiveThenMissing,
  pastSampleGrace,
  personaCallCounts,
  personaOf,
  personaRow,
  retiredEntryClearedLine, retiredKeyLinesIn,
  retryNow,
  reuseSpawnOf,
  rowReadsUntilSpawn,
  scriptLiveRowElsewhere,
  startSequenceHeldAtRun,
  unavailableAt,
  type RecoveryHarness,
  type RecoveryHarnessOptions
} from './test-helpers/recovery-harness.ts'
import { readRetiredKeysRecord, retiredKeysRecordOf, type RetiredKeySeed } from './test-helpers/retired-keys.ts'
import {
  makeChannelMessage,
  type SlackEvent
} from './test-helpers/slack-stub.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01 // never fires during a test
const WAIT_MS = 50
const SHARED = 'C0SHARED1'

/** In every lost message's text; must never reach a Slack call. */
const MESSAGE_MARKER = 'lost-body-marker-7Kq2'

let dir: string
/** Every harness a case built (cleaned up and leak-checked in teardown). */
let harnesses: RoutingHarness[] = []
/** Server-log lines the modules wrote (restart.ts, the outage state), captured and leak-checked in teardown. */
let consoleLines: string[] = []
let consoleSpy: ReturnType<typeof spyOn> | undefined
/** Every recovery harness a case built (leak-checked, then cleaned up, in teardown). */
let recoveries: RecoveryHarness[] = []

/** A recovery harness (tests/test-helpers/recovery-harness.ts), cleaned up in teardown. */
function makeRecovery(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const h = makeRecoveryHarness(options)
  recoveries.push(h)
  return h
}

/** A human's message in `channel`, carrying the message marker. */
function messageIn(channel: string, text = `hello, anyone there? ${MESSAGE_MARKER}`): SlackEvent {
  return makeChannelMessage({ channel, text })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lost-message-drop-branch-'))
  harnesses = []
  recoveries = []
  consoleLines = []
  consoleSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '))
  })
  resetRoutingState()
})

afterEach(async () => {
  try {
    // A recovery harness is leak-checked, then cleaned up (it puts back the
    // console.error it replaced, and throws when a fake-clock timer is left).
    for (const r of recoveries.splice(0)) {
      try {
        assertNoLeak(r.captured())
      } finally {
        r.cleanup()
      }
    }
    for (const h of harnesses) h.hold.cancelAll()
    // Let a held launch settle while restart.ts still has its deps.
    let released = 0
    for (const h of harnesses) released += h.releaseLaunches()
    if (released > 0) await Bun.sleep(1)
    // Every log line, post and notice the module produced is free of token material.
    assertNoLeak([...harnesses.map((h) => h.captured()), consoleLines])
  } finally {
    consoleSpy?.mockRestore()
    consoleSpy = undefined
    resetRoutingState()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// b.jg5 SRJ-1011, SRJ-115 through the recovery harness (its lost-message
// driver, bound as main() binds it): the routing's row read is the one
// liveness adapter's `status` of P's own instance, made outside any launch or
// recovery attempt. Nothing in flight: one `status` call; a spawn held open
// (a launch in flight): none. An ENVIRONMENT or CONFIG answer raises its
// outage (and arms the retry timer, as from any verb), and the decision
// after the read reports not answering. An UNAVAILABLE or UNCLASSIFIED answer
// is a failed read: nothing raised or armed, no `tmux-unresponsive`
// condition, no unclassified-error episode. `ErrSystemInstallDisappeared`
// raises `ad-unreachable` and reads `dead`. None of them is state 6. Both
// settings are 0 unless a case says otherwise, so a failed read reports
// auto-restart disabled.
// ===========================================================================

/** Nothing raised or armed for `key`: no outage flag, no trigger, no armed timer, no condition, no episode, no fake-clock timer. */
function expectNothingRaisedOrArmed(h: RecoveryHarness, key: string): void {
  expect([...getOutageFlags(key)]).toEqual([])
  expect(h.triggers).toEqual([])
  expect(h.controller.armedKeys()).toEqual([])
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.unclassifiedErrorOpen(key)).toBe(false)
  expect(h.clock.pendingCount()).toBe(0)
}

function expectOnlyThePendingOnlyWatch(h: RecoveryHarness, key: string, pendingRowArms: number): void {
  expect([...getOutageFlags(key)]).toEqual([])
  expect(h.triggers).toEqual(Array.from({ length: pendingRowArms }, () => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW })))
  expectPendingOnlyWatch(h, key)
  expect(h.controller.view(key)?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_PENDING_ROW])
  expect(h.controller.armedKeys()).toEqual([key])
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.unclassifiedErrorOpen(key)).toBe(false)
  expect(h.clock.pendingCount()).toBe(1)
}

describe('b.jg5 SRJ-1011 through the recovery harness: the read is the liveness adapter\'s one `status`, outside any attempt', () => {

  // The launch leaves its pending-only watch (b.jg5 SRJ-301, SRJ-409); the
  // cap stop over a row still `pending` arms it once more, the teardown stop
  // and a stop on a live row never do (b.jg5 SRJ-404).

  test('with `session_restart_delay` above 0, a routing read that fails reports starting now; the restart path\'s own read then finds the row `pending` and spawns nothing', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    const id = personaInstanceId(key)
    h.script({ statusQueue: [cannedErr(errInternal()), cannedOk(cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }))] })

    const lost = await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })

    expect(lost.restartPending).toBe(true)
    await waitFor(() => !isRestartPendingOrActive(key), 1000)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.statusCalls).toEqual([{ instance_id: id }, { instance_id: id }])
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.killCalls).toEqual([])
    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, () => Error, OutageClass, string]>([
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'status'), 'tmux-unavailable', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed(), 'ad-config-malformed', UNAVAILABLE_RETRY_CAUSE_CONFIG],
  ])('AC 68: a read answering %s raises %s, which this message reports as not answering; no restart is asked for, and the retry timer is armed as from any verb', async (_label, make, flag, cause) => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key, other] = h.keys as [string, string]
    h.script({ statusError: make() })

    await expectLostMessageReports(h, key, 'not-answering', { calls: { statusCalls: 1 } })

    expect([...getOutageFlags(key)]).toEqual([flag])
    expect(h.triggers).toEqual([{ key, kind: cause }])
    expect(h.controller.armedKeys()).toEqual([key])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect([...getOutageFlags(other)]).toEqual([])
    // The teardown's stop leaves no timer on the fake clock.
    h.teardown(key)
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each([
    ...unavailableForms('ErrTmuxUnresponsive', 'ErrCallTimeout', 'a wrapped UnknownError', 'a plain Error'),
    ...unavailableForms(['ErrUnknownErrorName', 'an unknown error name']),
  ])('SRJ-1011: a read answering %s (UNAVAILABLE) raises nothing, arms no retry timer, starts no tmux-unresponsive condition and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make('status') })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, () => Error]>([
    ['ErrInternal with no recognised phrase', () => errInternal()],
    ['ErrSchemaMismatch', () => errSchemaMismatch()],
  ])('SRJ-1011, hatch A2: a read answering %s (UNCLASSIFIED) arms no retry timer, opens no unclassified-error episode and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make() })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test('SRJ-1011, SRJ-115, hatch A2: a read answering ErrSystemInstallDisappeared raises ad-unreachable and reads dead, not pending: state 6 is left out, nothing is armed and no episode opens', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: errSystemInstallDisappeared('status') })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expect([...getOutageFlags(key)]).toEqual(['ad-unreachable'])
    expect(h.triggers).toEqual([])
    expect(h.controller.armedKeys()).toEqual([])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// ===========================================================================
// b.jg5 SRJ-807 at the lost-message read (SRJ-115, SRJ-1011): the routing's
// one row read is the liveness adapter's `status`, whose own-row step clears
// a retired key's entry, so an item accepted for P whose key is recorded with
// its mark set, its row read live other than `pending`, clears P's entry
// (durably, with the store's one line naming the adapter's read) and reports
// what it reports today; a `pending` row reports session starting and clears
// nothing. On the recovery harness, its one retired-key store installed as
// main() installs it, the record seeded with P and Q both marked, so Q's
// entry shows the read clears no other key's.
// ===========================================================================

describe('b.jg5 SRJ-807: the lost-message read clears a retired key\'s entry on its row read live other than pending with its mark set, and reports as before', () => {
  const SEED: RetiredKeySeed = { cause: RETIRED_KEY_CAUSE_REMOVED, mark: true }
  /** A recovery harness whose record holds every persona's key with its mark set. */
  const makeMarkedRecovery = () => makeRecovery({ retiredKeys: (keys) => Object.fromEntries(keys.map((key) => [key, SEED])) })

  test('P\'s row read waiting: the message reports auto-restart disabled from its one status read, as before; P\'s entry leaves the file with one write and one line naming the liveness adapter\'s read; Q\'s entry stays', async () => {
    const h = makeMarkedRecovery()
    const [key, other] = h.keys as [string, string]
    const path = h.retiredKeys.path
    h.script({ statusResult: cannedStatusResult({ state: 'waiting' }) })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expect(readRetiredKeysRecord(h.stateDir)).toEqual(retiredKeysRecordOf({ [other]: SEED }))
    expect([h.retiredKeys.isRecorded(key), h.retiredKeys.isMarked(other)]).toEqual([false, true])
    expect(h.retiredKeyWrites).toEqual([{ path, ok: true }])
    expect(retiredKeyLinesIn(h.errors)).toEqual([retiredEntryClearedLine(path, key, 'waiting', LIVENESS_STATUS_SITE)])
    expect(isRestartPendingOrActive(key)).toBe(false)
    expectNothingRaisedOrArmed(h, key)
  })

  test('P\'s row read pending (a launch start recorded): the message reports session starting from its one status read, as before; nothing is cleared: the file byte-identical, no write, no line', async () => {
    const h = makeMarkedRecovery()
    const [key] = h.keys as [string]
    const before = readFileSync(h.retiredKeys.path)
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }) })

    await expectLostMessageReports(h, key, 'session-starting')

    expect(readFileSync(h.retiredKeys.path).equals(before)).toBe(true)
    expect(h.retiredKeyWrites).toEqual([])
    expect(retiredKeyLinesIn(h.errors)).toEqual([])
    expect(h.retiredKeys.isMarked(key)).toBe(true)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expectNothingRaisedOrArmed(h, key)
  })
})

// ===========================================================================
// b.jg5 SRJ-805 at the lost-message trigger: an item accepted for P whose key
// is recorded as retired, with no mark, asks for P's human-triggered restart
// as for any persona; that restart never resumes P and never types into its
// old life. With P's row `ended`, its launch is one reuse of P's own id; with
// the row live, the restart path's reconnect adapter starts the live-row
// sequence (with the retired-key flag) and types nothing, and an item accepted
// while that sequence runs reports restarting with no read and no second
// restart. On the recovery harness, at a short `session_restart_delay` so
// the asked-for restart runs.
// ===========================================================================

describe('b.jg5 SRJ-805: an item accepted for a retired key asks for a restart that never resumes it or types into its old life', () => {
  test('P\'s row ended with a session id: the message reports starting now and asks for P\'s restart, whose launch is one reuse of cscb_<key>, no resume or keystroke; fresh-retired, with P\'s mark set', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S, resumeEnabled: true })
    const [key] = h.keys as [string]
    h.retireKey(key)
    h.script({
      statusResult: cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED }),
      getResult: personaRow(h, key, { state: LIVENESS_DEAD_ROW_ENDED, session_id: 'a-session-id' }),
    })

    await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })
    await waitFor(() => !isRestartPendingOrActive(key), 1000)
    await h.settle()

    expect(h.stub.calls.spawnCalls).toEqual([reuseSpawnOf(h, key)])
    expect([h.stub.calls.resumeCalls, h.stub.calls.sendKeysCalls]).toEqual([[], []])
    expect(h.retiredEntry(key)).toMatchObject({ recorded: true, marked: true })

  })

  test('P\'s row live (waiting): the asked-for restart types nothing into the old life and launches nothing itself, and starts the sequence; a second message while it runs reports restarting with no read and asks for no restart; the sequence ends in the reuse for the retired key', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    h.retireKey(key)
    ownRowsLiveThenMissing(h)
    h.script({ statusResult: cannedStatusResult({ state: 'waiting' }) })
    const hold = holdFindMissing(h.stub.client)

    await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })
    await waitFor(() => !isRestartPendingOrActive(key), 1000)
    await h.driveSequence(hold.entered(1))

    expect([h.stub.calls.sendKeysCalls, h.stub.calls.spawnCalls, h.sequenceRunning(key)]).toEqual([[], [], true])
    await expectLostMessageReports(h, key, 'restarting', { calls: {} })

    hold.release(cannedFindMissing({ rows: { [personaInstanceId(key)]: 'ids' } }))
    expect(await h.driveSequence(h.sequenceSettled(key))).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      reason: LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
      result: { key, action: SPAWN_ACTION_FRESH_RETIRED },
    })
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, h.stub.calls.sendKeysCalls]).toEqual([[reuseSpawnOf(h, key)], [], []])

  })
})

// ===========================================================================
// b.jg5 SRJ-409, SRJ-411 at the lost-message trigger (hatch note E22): a
// message lost for P asks for P's restart, whose own liveness read finds P's
// row `pending` and hands it to the deferral, bound as main() binds it over
// the harness's applied persona; the deferral reads the row once (`get`). A
// covered row (P's own directory and labels, a launch start) arms P's retry
// timer in pending-only mode, with no kill, launch or keystroke. A row that
// is not covered (another working directory, or a retired key's old life
// with no mark) is sent through the live-row sequence, the conversation not
// kept, with nothing typed into the row; the sequence, held at its first
// bypassing run, then ends in one reuse of P's id. The routing's own read
// fails (UNCLASSIFIED), so the message reports starting now and asks for
// the restart; on the recovery harness, at a short `session_restart_delay`
// so the asked-for restart runs.
// ===========================================================================

describe('b.jg5 SRJ-409, SRJ-411: an item accepted for P whose restart reads P\'s row pending', () => {
  /** A harness whose routing read of P fails and whose restart read finds P's row `pending`; P's `get`s answer `row`, then `missing`. */
  function build(row: (h: RecoveryHarness, key: string) => CannedGetResult, retired = false): { h: RecoveryHarness; key: string; ref: string } {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    if (retired) h.retireKey(key)
    let gets = 0
    h.script({
      statusQueue: [cannedErr(errInternal()), cannedOk(cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }))],
      getFn: () => (gets++ === 0 ? row(h, key) : personaRow(h, key, { state: LIVENESS_DEAD_ROW_MISSING })),
    })
    return { h, key, ref: renderPersonaRef(personaOf(h, key).name, key) }
  }

  const PENDING_ROW = (h: RecoveryHarness, key: string) => personaRow(h, key, { state: AGENT_DIRECTOR_PENDING_STATE })

  test('a covered row: the message reports starting now; its restart reads the row once and arms P pending-only, with no kill, launch or keystroke; nothing raised', async () => {
    const { h, key } = build(PENDING_ROW)

    await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })
    await waitFor(() => !isRestartPendingOrActive(key), 1000)

    expect(h.stub.calls.statusCalls).toHaveLength(2)
    expect(h.stub.calls.getCalls).toHaveLength(1)
    expect([h.stub.calls.killCalls, h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, h.stub.calls.sendKeysCalls]).toEqual([[], [], [], []])
    expect(h.sequenceRunning(key)).toBe(false)
    expectOnlyThePendingOnlyWatch(h, key, 1)
  })

  test.each<[string, PendingRowNotCoveredReason, (h: RecoveryHarness, key: string) => CannedGetResult, boolean]>([
    ['in another working directory', PENDING_ROW_REASON_CWD_MISMATCH, (h, key) => personaRow(h, key, { state: AGENT_DIRECTOR_PENDING_STATE, cwd: h.home }), false],
    ['a retired key\'s old life (recorded with no mark)', PENDING_ROW_REASON_RETIRED_OLD_LIFE, PENDING_ROW, true],
  ])('a row not covered, %s: its restart sends it through the live-row sequence with the reason\'s line, types nothing into it and launches nothing itself; the sequence ends in one reuse of P\'s id', async (_label, reason, row, retired) => {
    const { h, key, ref } = build(row, retired)
    const hold = holdFindMissing(h.stub.client)

    await expectLostMessageReports(h, key, 'starting-now', { restartRequested: true })
    await waitFor(() => !isRestartPendingOrActive(key), 1000)
    await h.driveSequence(hold.entered(1))

    expect(h.errors).toContain(uncoveredPendingRowLine(ref, reason))
    expect(h.lines).toContain(liveRowSequenceStartLine(ref, h.sequenceRequest(key, { lastReadState: AGENT_DIRECTOR_PENDING_STATE, retiredKey: retired })))
    expect(h.sequenceRunning(key)).toBe(true)
    expect([h.stub.calls.sendKeysCalls, h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], [], []])
    expect(h.triggers).toEqual([])

    hold.release(cannedFindMissing({ rows: { [personaInstanceId(key)]: 'ids' } }))
    expect(await h.driveSequence(h.sequenceSettled(key))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, result: { key } })
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, h.stub.calls.sendKeysCalls]).toEqual([[reuseSpawnOf(h, key)], [], []])

  })
})

// ===========================================================================
// b.jg5 SRJ-1011 state 4, SRJ-704 (E20 T3): an item accepted while P's
// kill-failure episode is open reports `kill-failed`
//
// Through the recovery harness's lost-message driver, whose `isKillFailed` is
// bound to the harness's kill-failure alerts' episode as main() binds it. The
// restart path's kill is one try (its `dead` seed), so an `ErrTmuxKillFailed`
// there stands at once; that kill follows only an `ErrSystemInstallDisappeared`
// reading (b.jg5 SRJ-110, SRJ-314; `installGoneRestartProbe`). The multi-try
// legs run at the step-1 kill of the
// live-row sequence P's launch starts at a collision ladder replacement site
// over a row read live (`scriptLiveRowElsewhere`, `launchThroughSequence`, on
// the sequence clock; the ladder makes no kill, b.jg5 SRJ-707). States
// and wordings come from src/lost-message.ts (`expectLostMessageReports`).
// ===========================================================================

/** A recovery harness (`makeRecovery`) whose restart run's kill answers `ErrTmuxKillFailed` once, after `installGoneRestartProbe`'s reading; P's row reads `ended` until its spawn. Answers P's key and `readRow`. */
async function afterRestartKillFailed(options: RecoveryHarnessOptions = {}): Promise<{ h: RecoveryHarness; key: string; readRow(): void }> {
  const probe = installGoneRestartProbe(() => h.config)
  const h: RecoveryHarness = makeRecovery({ ...options, restartDeps: { isSessionAlive: probe.isSessionAlive } })
  const [key] = h.keys as [string]
  rowReadsUntilSpawn(h, 'ended')
  h.script({ killError: errTmuxKillFailed() })
  await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)
  return { h, key, readRow: probe.readRow }
}

describe('b.jg5 SRJ-1011 state 4: an item accepted after the kill-failure alert reports kill failed, through the real routing', () => {
  /** P's launch meeting its row read `waiting` in another directory, the step-1 kill of the sequence it starts answering `kills` in order; the sequence is driven to its end. */
  async function sequenceKill(h: RecoveryHarness, key: string, ...kills: Error[]): Promise<void> {
    scriptLiveRowElsewhere(h, key, { killQueue: kills.map((err) => cannedErr(err)) })
    await launchThroughSequence(h, key)
  }

  test('ErrTmuxKillFailed that stands at the restart path\'s kill: after the ordinary alert, a queued Slack item reports kill failed with its wording; no human-triggered restart fires, with the delay above 0', async () => {
    const { h, key } = await afterRestartKillFailed({ sessionRestartDelay: FAST_DELAY_S })
    expect(h.episodeNotices).toHaveLength(1)

    await expectLostMessageReports(h, key, 'kill-failed')

    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toEqual([])
  })

  test('a survivor-naming failure, then ErrTmuxUnresponsive twice, at the live-row sequence\'s kill of a row read live, started at a replacement site: the ordinary alert, then a queued Slack item reports kill failed', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'), errTmuxUnresponsive('kill'), errTmuxUnresponsive('kill'))

    expect(h.killFailureOpen(key)).toBe(true)
    await expectLostMessageReports(h, key, 'kill-failed')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('a survivor-naming failure, then a read of ended, at the live-row sequence\'s kill of a row read live, started at a replacement site: the survivor version opens no episode, and an item accepted afterwards reports the state the launch left, never kill failed', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusQueue: [cannedOk(cannedStatusResult({ state: 'ended' }))] })

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'))

    expect(h.episodeNotices).toHaveLength(1)
    expect(h.killFailureOpen(key)).toBe(false)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
  })

  test('a survivor-naming failure, then CONFLICT, at the live-row sequence\'s kill of a row read live, started at a replacement site: P latched and its kill-failure episode open, a queued Slack item reports held for a human, not kill failed', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]

    await sequenceKill(h, key, errTmuxKillFailed(undefined, 'pane-process-survived'), errTmuxSessionConflict('kill', 'not-this-launch'))

    expect(h.latch.isLatched(key)).toBe(true)
    expect(h.killFailureOpen(key)).toBe(true)
    await expectLostMessageReports(h, key, 'held-for-human')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('after the episode ends (a later restart run\'s liveness read of ended, which launches P with no kill), a queued Slack item no longer reports kill failed', async () => {
    const { h, key, readRow } = await afterRestartKillFailed()
    expect(h.killFailureOpen(key)).toBe(true)

    // The retry's liveness read is the real adapter's: P's row reads `ended`,
    // which ends the episode, and no kill is sent for it (b.jg5 SRJ-110, SRJ-314).
    readRow()
    await retryNow(h, key)

    expect(h.killFailureOpen(key)).toBe(false)
    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect(h.episodeNotices).toHaveLength(1)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
  })
})

// ===========================================================================
// b.jg5 SRJ-1011 state 3, SRJ-207: an item accepted while P is held
// on ErrInvalidFlags reports `cannot-launch`
//
// Through the recovery harness's lost-message driver, whose held-on-invalid-
// flags input is bound to the harness's one hold as main() binds it. P is
// held through a real reuse spawn of its id answering ErrInvalidFlags, its
// version re-check on the harness clock passing; the restart delay is above
// 0, so a restart the message wrongly asked for would launch. `cannot-launch`
// comes after `held-for-human` and before `kill-failed`; once the binary's
// version changes the hold ends and the message is decided as before. States
// and wordings come from src/lost-message.ts (`expectLostMessageReports`).
// ===========================================================================

describe('b.jg5 SRJ-1011 state 3, SRJ-207: an item accepted while P is held on ErrInvalidFlags reports cannot launch, through the real routing', () => {
  test('P held through a reuse: a queued Slack item reports cannot launch with its wording; no restart is asked for, scheduled or launched, and no stub call is made for P', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    h.versionRecheck()
    await holdThroughReuse(h, key)
    const before = personaCallCounts(h, key)

    await expectLostMessageReports(h, key, 'cannot-launch')

    await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
    await h.settle()
    expect(personaCallCounts(h, key)).toEqual(before)
    expect(h.invalidFlagsHold.isHeld(key)).toBe(true)
  })

  test('P held with its kill-failure episode open: cannot launch is reported, not kill failed', async () => {
    const { h, key } = await afterRestartKillFailed({ sessionRestartDelay: FAST_DELAY_S })
    expect(h.killFailureOpen(key)).toBe(true)
    // The sequence-launch entry's reuse (no row read first, which would end the episode) holds P.
    h.script({ killError: undefined, spawnError: errInvalidFlags('spawn') })
    expect(await launchForLiveRowSequence(personaOf(h, key), h.config, { kind: LIVE_ROW_LAUNCH_REUSE, lastRead: latchRowStateRead(LIVENESS_DEAD_ROW_ENDED) })).toEqual({ key, action: 'held' })
    expect([h.invalidFlagsHold.isHeld(key), h.killFailureOpen(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'cannot-launch')

    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('P latched and held: held for a human is reported, not cannot launch', async () => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [key] = h.keys as [string]
    await holdThroughReuse(h, key)
    // A provenance_conflict note on P's own row, read by the session manager's shared own-row read, latches P.
    h.script({ getResult: personaRow(h, key, { liveness_note: provenanceNote }) })
    expect(await readPersonaOwnRow(key, { site: 'inbound-recovery-drop-branch.test', what: 'own-row get' })).toMatchObject({ latched: true })
    expect([h.latch.isLatched(key), h.invalidFlagsHold.isHeld(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'held-for-human')

    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('after the binary\'s version changes and the hold ends (P retried at once, its launch refused), a queued Slack item no longer reports cannot launch', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    const rc = h.versionRecheck()
    await holdThroughReuse(h, key)
    await expectLostMessageReports(h, key, 'cannot-launch')

    // The retry at once meets an UNAVAILABLE answer at its first spawn: refused, P's timer armed, P not up.
    rc.answer({ version: PHASE1_FLOOR_VERSION })
    h.script({ spawnQueue: [], spawnError: unavailableAt('spawn'), statusResult: cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED }) })
    await h.advance(rc.nextDueAt()! - h.clock.now())
    await h.settle()
    expect(h.invalidFlagsHold.isHeld(key)).toBe(false)
    expect(h.retriesAtOnce.map((retry) => retry.key)).toEqual([key])

    // P's retry timer runs on the UNAVAILABLE refusal: not answering.
    await expectLostMessageReports(h, key, 'not-answering')
    h.teardown(key)
  })
})

// ===========================================================================
// b.jg5 SRJ-706, SRJ-1011 (E21 T2): an item accepted while P's live-row
// sequence runs reports `restarting`
//
// Through the recovery harness's lost-message driver, whose sequence/wait
// input is the session manager's running query and whose read gate's "in
// flight for P" counts the sequence, both as main() binds them, with P's
// sequence started through the registry and its first run held (the stub's
// `holdFindMissing`). Restarting is decided with no `status` read and no
// human-triggered restart, even while P's row reads `pending` and during the
// sequence's own step-6 launch; a latch beats it; once the sequence has
// ended the message is decided as before, with the one read.
// ===========================================================================

describe('b.jg5 SRJ-706, SRJ-1011: an item accepted while P\'s live-row sequence runs reports restarting, with no status read and no restart, through the real routing', () => {
  /** Release P's held run with its row placed in `ids` and drive the sequence to its end (its next `get` reads the row missing). */
  async function endHeldSequence(h: RecoveryHarness, key: string, hold: FindMissingHold, outcome: Promise<unknown>): Promise<void> {
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(key)]: 'ids' } }))
    await h.driveSequence(outcome)
    expect(h.sequenceRunning(key)).toBe(false)
  }

  test('restarting with no read while P\'s first run is held; Q\'s message beside it is decided as before; once P\'s sequence has ended, P\'s next message makes its one read again', async () => {
    const h = makeRecovery()
    const [key, other] = h.keys as [string, string]
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, key, hold)

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })
    await expectLostMessageReports(h, other, 'auto-restart-disabled')

    await endHeldSequence(h, key, hold, run.outcome)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
    expect(isRestartPendingOrActive(key)).toBe(false)
  })

  test('the row the sequence last read `pending`, and the stub\'s `status` answering `pending`: restarting, never session starting, with no read', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    await pastSampleGrace(h)
    const persona = personaOf(h, key)
    h.script({
      statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }),
      getQueue: [
        cannedOk(cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE }, persona, h.home)),
        cannedOk(cannedGetResult({ state: LIVENESS_DEAD_ROW_MISSING }, persona, h.home)),
      ],
    })
    const hold = holdFindMissing(h.stub.client)
    const run = await startSequenceHeldAtRun(h, key, hold, { lastReadState: AGENT_DIRECTOR_PENDING_STATE })

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })

    await endHeldSequence(h, key, hold, run.outcome)
  })

  test('during the sequence\'s own step-6 launch (a launch in flight for P): restarting, never session starting, with no read', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, key), h.home) })
    const reuse = holdSequenceReuse(h, key)
    const run = h.startSequence(key, { lastReadState: cannedStatusResult().state })
    await h.driveSequence(reuse.entered)
    expect(isLaunchInFlight(key)).toBe(true)

    await expectLostMessageReports(h, key, 'restarting', { calls: {} })

    reuse.release()
    await h.driveSequence(run.outcome)
  })

  test('P latched while its stopped sequence\'s run is still held: held for a human beats restarting', async () => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, key, hold)
    // Another path's own-row read latches P (SRJ-513); the sequence still runs until its run returns.
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    await readPersonaRowState(key)
    expect([h.latch.isLatched(key), h.sequenceRunning(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'held-for-human')

    await endHeldSequence(h, key, hold, run.outcome)
  })
})

// ===========================================================================
// Not up (b.av2 SR-6.4; regression guard for bug b.g57) — a message can
// still reach a persona whose bring-up outcome is not up: one that stopped
// being up while the message was being handled, or the old half of a
// destructive modify after its bring-up was cancelled and before its
// connection is stopped. Such a message used to report "starting now" and ask
// for a restart the relaunch gate refused. Now the notice says "not up" and
// nothing is scheduled: the persona's own recovery launches it. The up check
// is the real `createPersonaUpPredicate` over a serving connection, with the
// bring-up outcome injected as not up; the production wiring (the routing
// gets the server's one `isPersonaUp`) is pinned in
// tests/server-startup-wiring.test.ts.
// ===========================================================================

describe('not up: a queued Slack item for a persona that is not up starts no restart', () => {

  test('the up check is asked with the persona\'s key, not its name', async () => {
    const asked: string[] = []
    const h = makeRoutingHarness([{ name: 'Not Up Persona', channels: [{ id: SHARED, delivery: 'all' }] }], dir, {
      sessions: [],
      restartDelayS: FAST_DELAY_S,
      isPersonaUp: (key) => {
        asked.push(key)
        return false
      },
    })
    harnesses.push(h)
    const notUp = h.config!.personas[0]!
    expect(notUp.key).not.toBe(notUp.name)

    await h.receiveKeys(messageIn(SHARED), [notUp.key])

    expect(asked).toEqual([notUp.key])

    expect(isRestartPendingOrActive(notUp.key)).toBe(false)
  })

  // An up persona passing the check to "starting now" is the beta side of the
  // two-persona case above; the AC 26 state table (no up check at all) fails
  // if an absent check counted as not up. This one row shows an up persona
  // still falls through to a later restart-guard state.

})

// ===========================================================================
// Required behavior 5 — auto-restart disabled (session_restart_delay 0)
// ===========================================================================

describe('b.kvq (5) auto-restart disabled (delay 0) path', () => {

  test('scheduleRestart with humanTrigger still early-returns when base delay is 0', async () => {
    // Pin the restart.ts gate directly: humanTrigger does not bypass it.
    const deps = makeRestartDeps({ restartDelayS: 0 })
    initRestart(deps)

    scheduleRestart('kvq_disabled', join(dir, 'kvq-session'), undefined, { humanTrigger: true })
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('kvq_disabled')).toBe(false)
    expect(deps.launches).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 6 — humanTrigger clamps delay DOWN only
//
// These tests capture the delay argument passed to global setTimeout by
// scheduleRestart, so they read the ACTUAL scheduled delay rather than waiting
// out multi-second timers. restart.ts uses the global setTimeout, so wrapping
// it here is a legitimate observation seam.
// ===========================================================================

describe('b.kvq (6) humanTrigger delay clamp (DOWN only)', () => {
  const realSetTimeout = globalThis.setTimeout
  let capturedDelays: number[] = []

  beforeEach(() => {
    capturedDelays = []
    // Capture the delay, but do NOT actually arm a real timer (return a stub
    // handle) so the launch never fires during these timing-only tests.
    globalThis.setTimeout = ((_fn: (...a: unknown[]) => void, ms?: number) => {
      capturedDelays.push(ms ?? 0)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
  })

  test('a 900s-cap-regime backoff is clamped down to HUMAN_TRIGGER_DELAY_CEILING', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    // Drive failure count high enough that nextBackoffDelay saturates at 900s:
    // 60 * 2^4 = 960 → clamped to 900 by backoff.ts.
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session', undefined, { humanTrigger: true })

    // Computed backoff was 900s; humanTrigger clamps it to the 5s ceiling.
    expect(capturedDelays).toContain(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })

  test('a NON-human trigger in the same 900s regime is NOT clamped', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session') // no opts → not human

    expect(capturedDelays).toContain(900 * 1000)
  })

  test('a delay already below the ceiling is NOT raised by humanTrigger', () => {
    // base 1s, zero failures → nextBackoffDelay = 1s, which is below the 5s
    // ceiling. Math.min must leave it at 1s (clamp DOWN only).
    initRestart(makeRestartDeps({ restartDelayS: 1 }))

    scheduleRestart('kvq_small', '/tmp/kvq-session', undefined, { humanTrigger: true })

    expect(capturedDelays).toContain(1 * 1000)
    expect(capturedDelays[0]).toBeLessThan(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })
})

// ===========================================================================
// Required behavior 7 — one tested copy: server.ts takes the branch from the
// routing module and holds no copy of its own
//
// main() cannot run in a test, so this audits the comment-stripped source
// (see tests/start-sweep-wiring.test.ts) for wiring only. If the drop branch
// were re-inlined in server.ts, the behavioural tests above would keep passing
// against the module while production ran an untested copy. The routing's
// `notify` wiring is pinned in tests/server-startup-wiring.test.ts.
// ===========================================================================

describe('b.kvq (7) server.ts holds no copy of the lost-message branch', () => {
  const SERVER_SRC = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8')
  const SERVER_CODE = stripComments(SERVER_SRC)

  test('server.ts code builds no lost-message notice, decides no recovery state and has no human-triggered scheduleRestart call site', () => {
    expect(indicesOf(/\b(?:buildLostMessageNotice|decideLostMessageState)\b/g, SERVER_CODE)).toEqual([])
    expect(indicesOf(/not delivered/gi, SERVER_CODE)).toEqual([])
    expect(indicesOf(/\bhumanTrigger\b/g, SERVER_CODE)).toEqual([])
  })

  test('server.ts builds one persona-routing instance and gives it to the persona event router', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bcreatePersonaRouting\b[^}]*\}\s*from\s*['"]\.\/persona-routing\.ts['"]/,
    )
    const routing = [...SERVER_CODE.matchAll(/\bconst\s+(\w+)\s*=\s*createPersonaRouting\s*\(/g)]
    expect(routing).toHaveLength(1)
    expect(indicesOf(/\bcreatePersonaRouting\s*\(/g, SERVER_CODE)).toHaveLength(1)
    const router = SERVER_CODE.match(/\bcreatePersonaEventRouter\s*\(\s*\{[^}]*\}/)
    expect(router).not.toBeNull()
    expect(router![0]).toMatch(new RegExp(`\\brouting\\s*:\\s*${routing[0]![1]}\\b`))
  })

  test('server.ts never calls receive itself: inbound events reach the routing only through the event router', () => {
    // What the router hands `receive` (the receiving connection's key as the
    // only receiver) is driven end to end in
    // tests/persona-connection-wiring.test.ts.
    expect(indicesOf(/\.receive\s*\(/g, SERVER_CODE)).toEqual([])
  })

  test('server recovery has no standalone stream probe (b.omv SR-9)', () => {
    expect(SERVER_CODE).not.toMatch(/\bhasSessionStream\b/)
  })
})

// ===========================================================================
// b.jg5 SRJ-812, SRJ-1011 state 4 (E27 T2; AC 54; hatch note E15): a message
// lost while Q waits on an old-life hold
//
// Through the recovery harness's lost-message driver, whose kill-failed input
// is the kill-failure episode or Q waiting on a hold marked kill-failed, and
// whose sequence/wait input and read gate count a wait step running for a
// hold Q waits on, all as main() binds them. Q is the harness's first
// persona; the old row is held at Q's working directory, so Q waits on it.
// Before any kill of the old key failed the message reports today's states;
// while a wait step runs (its run held), `restarting` with no read and no
// restart; once the old key's kill failed (the ordinary version: the wait's,
// a teardown's or the start sweep's), `kill-failed` until the hold ends;
// never after a survivor version, a CONFLICT or a `kill_sent: false` success.
// The restart clause ("brings the persona up only once the hold ends") is
// T3's case. States and wordings come from src/lost-message.ts
// (`expectLostMessageReports`); every message raises one notice for Q and
// the wait posts nothing.
// ===========================================================================

/** A hold Q waits on, begun one way; answers the held instance id. */
type QHold = (h: RecoveryHarness, q: string, b: string) => Promise<string>

const Q_HOLDS: ReadonlyArray<readonly [string, QHold]> = [
  ['begun at apply step 1 (B removed, its own cscb_<B> held at Q\'s directory)', async (h, q, b) => {
    h.remove(b)
    h.beginOldLifeHold({ instanceId: personaInstanceId(b), oldKey: b, directory: personaOf(h, q).working_directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    return personaInstanceId(b)
  }],
  // Q is the harness's first persona, whose directory `absentRow` puts the row in.
  ['begun from the start sweep\'s list (an absent persona\'s live row in Q\'s directory, its sweep kill succeeding)', async (h) => {
    const row = absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY)
    h.script({ listResult: { spawns: [row] } })
    await h.startSweep()
    return row.instance_id
  }],
]

/** Every lost-message notice went to Q, one per message; the wait posted nothing. */
function expectOnlyQQueued(h: RecoveryHarness, q: string, messages: number): void {
  expect(h.lostMessageNotices).toEqual([])
  expect(h.queued(q)).toHaveLength(messages)
  expect(h.notices).toEqual([])
}

describe('b.jg5 SRJ-812, SRJ-1011 (AC 54): an item accepted while Q waits on an old-life hold, before any kill of the old key failed: today\'s states, and restarting while a wait step runs', () => {
  test.each(Q_HOLDS)('the hold %s: no wait step, today\'s state with Q\'s one read; a wait step running (its run held), restarting with no read, Q\'s own row read pending or not; once the run lists the row in ids and the hold ends, today\'s state again', async (_label, begin) => {
    const h = makeRecovery()
    const [q, b] = h.keys as [string, string]
    const id = await begin(h, q, b)
    h.script({ getResult: cannedGetResult({ instance_id: id, cwd: personaOf(h, q).working_directory }) })

    await expectLostMessageReports(h, q, 'auto-restart-disabled')

    const hold = holdFindMissing(h.stub.client)
    const outcome = h.startOldLifeWait(id)
    await h.driveSequence(hold.entered(1))
    await expectLostMessageReports(h, q, 'restarting', { calls: {} })
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }) })
    await expectLostMessageReports(h, q, 'restarting', { calls: {} })

    h.script({ statusResult: cannedStatusResult() })
    hold.release(cannedFindMissing({ rows: { [id]: 'ids' } }))
    await h.driveSequence(outcome)
    expect(h.oldLifeHolds.holdOf(id)).toBeUndefined()
    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expectOnlyQQueued(h, q, 4)
  })
})

describe('b.jg5 SRJ-812, SRJ-1011 state 4 (AC 54): once the old key\'s kill failed, an item accepted for a persona waiting on the hold reports kill failed, until the hold ends', () => {
  test.each<[string, (h: RecoveryHarness, q: string, b: string) => Promise<string>]>([
    ['the wait\'s own kill (ErrTmuxKillFailed after its tries)', async (h, q, b) => {
      const id = await Q_HOLDS[0]![1](h, q, b)
      h.script({ killError: errTmuxKillFailed() })
      await h.runOldLifeWait(id)
      return id
    }],
    ['B\'s teardown kill (ErrTmuxKillFailed after its tries)', async (h, q, b) => {
      const id = await Q_HOLDS[0]![1](h, q, b)
      h.script({ killError: errTmuxKillFailed() })
      await h.drive(killPersonaInstanceForTeardown(b, { clock: h.killRetryClock }))
      return id
    }],
    ['the start sweep\'s kill of an absent persona\'s row (ErrTmuxKillFailed after its tries)', async (h, q, b) => {
      h.script({ killError: errTmuxKillFailed() })
      return Q_HOLDS[1]![1](h, q, b)
    }],
  ])('%s: the hold is marked; a queued Slack item reports kill failed with its wording and no read; another call\'s read of the old row ended ends the hold, and the next message reports today\'s state', async (_label, fail) => {
    const h = makeRecovery()
    const [q, b] = h.keys as [string, string]
    const id = await fail(h, q, b)
    h.script({ killError: undefined })
    expect(h.oldLifeHolds.holdOf(id)?.killFailed).toBe(true)
    expect(h.killFailureOpen(q)).toBe(false)

    await expectLostMessageReports(h, q, 'kill-failed')
    await expectLostMessageReports(h, q, 'kill-failed')

    noteOldLifeRowRead(id, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call')
    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.notices).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness, row: CannedGetResult) => void]>([
    ['a survivor-naming ErrTmuxKillFailed, then a success (the survivor version)', (h, row) => h.script({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), cannedOk(cannedKillResult(true))], getResult: row })],
    ['a CONFLICT', (h, row) => h.script({ killError: errTmuxSessionConflict('kill', 'not-this-launch'), getResult: row })],
    ['a success with kill_sent false', (h, row) => h.script({ killResult: cannedKillResult(false), getResult: row })],
  ])('the wait\'s kill answering %s, its round then stopped by a run that did not judge the pending old row: the hold goes on unmarked, and a queued Slack item reports today\'s state, never kill failed', async (_label, arrange) => {
    const h = makeRecovery()
    const [q, b] = h.keys as [string, string]
    await pastSampleGrace(h)
    const id = await Q_HOLDS[0]![1](h, q, b)
    arrange(h, cannedGetResult({ instance_id: id, cwd: personaOf(h, q).working_directory, state: AGENT_DIRECTOR_PENDING_STATE }))

    await h.runOldLifeWait(id)

    expect(h.oldLifeHolds.holdOf(id)?.killFailed).toBe(false)
    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.lostMessageNotices).toEqual([])
    expect(h.queued(q)).toHaveLength(1)
  })
})

// ===========================================================================
// b.jg5 SRJ-812's restart clause, SRJ-810 (E27 T3; AC 54): a restart a lost
// message triggers while Q waits on an old-life hold brings Q up only once
// the hold ends, at once
//
// Through the recovery harness's lost-message driver, at a short
// `session_restart_delay` so the asked-for restart runs. Q's row is absent,
// no wait step runs and no kill of the old key failed, so the message reports
// starting now (SRJ-812, hatch A3: the notice is kept) and asks for Q's
// restart; the restart work's old-life hook holds Q: no launch, the wait
// started (its first run held) and Q's timer armed. Once the run lists the
// old row in its ids the hold ends and the end-retry observer runs Q's retry
// at once, which brings Q up. Only the state's notice is posted, at Q's
// destination; B's stub sees nothing.
// ===========================================================================

describe('b.jg5 SRJ-812, SRJ-810 (AC 54): a restart a queued Slack item triggers while Q waits on a hold launches nothing, and Q comes up only once the hold ends, at once', () => {
  test.each(Q_HOLDS)('the hold %s: the message reports starting now and asks for Q\'s restart, which launches nothing, starts the wait and arms Q\'s timer; the hold\'s end retries Q at once and Q comes up; no message-lost post', async (_label, begin) => {
    const h = makeRecovery({ sessionRestartDelay: FAST_DELAY_S })
    const [q, b] = h.keys as [string, string]
    const id = await begin(h, q, b)
    h.script({ getResult: cannedGetResult({ instance_id: id, cwd: personaOf(h, q).working_directory }) })
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const hold = holdFindMissing(h.stub.client)

    await expectLostMessageReports(h, q, 'starting-now', { restartRequested: true })
    await waitFor(() => !isRestartPendingOrActive(q), 1000)
    await h.driveSequence(hold.entered(1))

    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.errors.filter((line) => line === restartOldLifeHeldLine(q))).toHaveLength(1)
    expect([h.oldLifeWaitRunning(id), h.oldLifeHolds.holdOf(id)?.waiting, h.controller.isArmed(q)]).toEqual([true, [q], true])

    const endedAt = h.clock.now()
    hold.release(cannedFindMissing({ rows: { [id]: 'ids' } }))
    await h.driveSequence(h.oldLifeWaitSettled(id))
    await h.settle()

    expect(h.oldLifeHolds.holdOf(id)).toBeUndefined()
    expect(h.holdEndRetries).toEqual([{ key: q, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN }])
    expect(h.stub.calls.spawnCalls.map((params) => params.instance_id)).toEqual([personaInstanceId(q)])

    h.controller.stopAll('the case is over')
    expectOnlyQQueued(h, q, 1)
    expect(h.slack(q).callLog.filter((call) => call.method === 'chat.postMessage')).toHaveLength(0)
    expect(h.slack(b).callLog).toEqual([])
  })
})
