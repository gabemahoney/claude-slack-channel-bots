import { KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import { livenessReadingForStatus } from '../src/liveness-reading.ts'
import type { Persona } from '../src/config.ts'
import type { LostMessageState } from '../src/lost-message.ts'
import { LIVENESS_READING_LIVE, LIVENESS_READING_PENDING, LIVENESS_READING_UNKNOWN } from '../src/liveness-reading.ts'
import { isAtCap } from '../src/backoff.ts'
import { LIVENESS_READING_DEAD } from '../src/liveness-reading.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'
import { HOLD_LATCH_CASES, LATCH_CASE_LEFTOVER, LATCH_ROW_STATE_UNREADABLE, REFUSED_OPERATION_NONE, REFUSED_OPERATION_PLAIN_SPAWN, LATCH_ROW_STATE_NO_ROW } from '../src/conflict-latch.ts'
import { PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR, TMUX_UNRESPONSIVE_END_TICK } from '../src/persona-episodes.ts'
import { OUTAGE_CLASS_ORDER, clearOutageFlag, raiseAdConfigMalformed, raiseTmuxUnavailable, setOutageFlag } from '../src/outage-state.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
import { makeAppMention, makeDm, mentionText, stubOpenedDmId, type StubSlackOptions } from './test-helpers/slack-stub.ts'
import { CONFLICT_CASE_ROWS, conflictForPersona } from './test-helpers/conflict-cases.ts'
import { putAtRestartCap, LOST_MESSAGE_STATES, LOST_STATE_SETUPS, NEVER_FIRE_RESTART_DELAY_S, ROW_READ_REJECTS, ROW_READ_REJECTION_REDACTED, type RoutingHarnessOptions, type RowReadAnswer } from './test-helpers/persona-routing-harness.ts'


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

const FAST_DELAY_S = 0.01 // the restart launch runs within the bounded poll
const WAIT_MS = 50
const SLOW_DELAY_S = NEVER_FIRE_RESTART_DELAY_S
const ALPHA_HOME = 'C0ALPHA01'
const ALPHA_SECOND = 'C0ALPHA02'
const BETA_MENTIONS = 'C0BETA001'
const UNCLAIMED = 'C0NOBODY1'
const CONTACT = 'U0CONTACT1'
const STUB_USER_NAME = 'stub-user'
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
// through the recovery harness (its lost-message
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

describe('through the recovery harness: the read is the liveness adapter\'s one `status`, outside any attempt', () => {

  // The launch leaves its pending-only watch; the
  // cap stop over a row still `pending` arms it once more, the teardown stop
  // and a stop on a live row never do.

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
  ])('a read answering %s raises %s, which this message reports as not answering; no restart is asked for, and the retry timer is armed as from any verb', async (_label, make, flag, cause) => {
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
  ])('a read answering %s (UNAVAILABLE) raises nothing, arms no retry timer, starts no tmux-unresponsive condition and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make('status') })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test.each<[string, () => Error]>([
    ['ErrInternal with no recognised phrase', () => errInternal()],
    ['ErrSchemaMismatch', () => errSchemaMismatch()],
  ])(', hatch A2: a read answering %s (UNCLASSIFIED) arms no retry timer, opens no unclassified-error episode and leaves state 6 out', async (_label, make) => {
    const h = makeRecovery()
    const [key] = h.keys as [string]
    h.script({ statusError: make() })

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expectNothingRaisedOrArmed(h, key)
  })

  test(', hatch A2: a read answering ErrSystemInstallDisappeared raises ad-unreachable and reads unknown: state 6 is left out, nothing is armed and no episode opens', async () => {
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
// at the lost-message read: the routing's
// one row read is the liveness adapter's `status`, whose own-row step clears
// a retired key's entry, so an item accepted for P whose key is recorded with
// its mark set, its row read live other than `pending`, clears P's entry
// (durably, with the store's one line naming the adapter's read) and reports
// what it reports today; a `pending` row reports session starting and clears
// nothing. On the recovery harness, its one retired-key store installed as
// main() installs it, the record seeded with P and Q both marked, so Q's
// entry shows the read clears no other key's.
// ===========================================================================

describe('the lost-message read clears a retired key\'s entry on its row read live other than pending with its mark set, and reports as before', () => {
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
// at the lost-message trigger: an item accepted for P whose key
// is recorded as retired, with no mark, asks for P's human-triggered restart
// as for any persona; that restart never resumes P and never types into its
// old life. With P's row `ended`, its launch is one reuse of P's own id; with
// the row live, the restart path's reconnect adapter starts the live-row
// sequence (with the retired-key flag) and types nothing, and an item accepted
// while that sequence runs reports restarting with no read and no second
// restart. On the recovery harness, at a short `session_restart_delay` so
// the asked-for restart runs.
// ===========================================================================

describe('an item accepted for a retired key asks for a restart that never resumes it or types into its old life', () => {
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
// at the lost-message trigger (design note ): a
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

describe('an item accepted for P whose restart reads P\'s row pending', () => {
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


/** A live-row replacement whose sequence's checked kill fails opens the alert episode. */
async function afterSequenceKillFailed(options: RecoveryHarnessOptions = {}): Promise<{ h: RecoveryHarness; key: string; readRow(): void }> {
  const h = makeRecovery(options)
  const [key] = h.keys as [string]
  scriptLiveRowElsewhere(h, key, { killError: errTmuxKillFailed() })
  await launchThroughSequence(h, key)
  return { h, key, readRow: () => { rowReadsUntilSpawn(h, 'ended'); h.script({ killError: undefined }) } }
}

describe('state 4: an item accepted after the kill-failure alert reports kill failed, through the real routing', () => {
  /** P's launch meeting its row read `waiting` in another directory, the step-1 kill of the sequence it starts answering `kills` in order; the sequence is driven to its end. */
  async function sequenceKill(h: RecoveryHarness, key: string, ...kills: Error[]): Promise<void> {
    scriptLiveRowElsewhere(h, key, { killQueue: kills.map((err) => cannedErr(err)) })
    await launchThroughSequence(h, key)
  }

  test('ErrTmuxKillFailed that stands at a live-row replacement sequence\'s kill: after the ordinary alert, a queued Slack item reports kill failed with its wording; no human-triggered restart fires, with the delay above 0', async () => {
    const { h, key } = await afterSequenceKillFailed({ sessionRestartDelay: FAST_DELAY_S })
    expect(h.episodeNotices).toHaveLength(1)

    await expectLostMessageReports(h, key, 'kill-failed')

    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
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
    const { h, key, readRow } = await afterSequenceKillFailed()
    expect(h.killFailureOpen(key)).toBe(true)

    // The retry's liveness read is the real adapter's: P's row reads `ended`,
    // which ends the episode, and no kill is sent for it.
    readRow()
    await retryNow(h, key)

    expect(h.killFailureOpen(key)).toBe(false)
    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expect(h.episodeNotices).toHaveLength(1)
    await expectLostMessageReports(h, key, 'auto-restart-disabled')
  })
})

// ===========================================================================
// state 3, an item accepted while P is held
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

describe('state 3, an item accepted while P is held on ErrInvalidFlags reports cannot launch, through the real routing', () => {
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
    const { h, key } = await afterSequenceKillFailed({ sessionRestartDelay: FAST_DELAY_S })
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
// an item accepted while P's live-row
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

describe('an item accepted while P\'s live-row sequence runs reports restarting, with no status read and no restart, through the real routing', () => {
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
    // Another path's own-row read latches P; the sequence still runs until its run returns.
    h.script({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    await readPersonaRowState(key)
    expect([h.latch.isLatched(key), h.sequenceRunning(key)]).toEqual([true, true])

    await expectLostMessageReports(h, key, 'held-for-human')

    await endHeldSequence(h, key, hold, run.outcome)
  })
})

// ===========================================================================
// Not up (regression guard for) — a message can
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
  test.each(['no session'] as const)(
    'REGRESSION: %s, alpha not up while its connection still delivers: three messages stay queued with no notice, no restart is asked for, scheduled or launched and nothing is delivered; once alpha is up, the next lost message starts now',
    async (branch) => {
      const h = makeHarness({ branch, notUp: ['alpha'] })
      // The relaunch gate over the same bring-up state: before the fix every
      // message asked it for a restart, and it refused with a line.
      const gateLines: string[] = []
      const deps = makeRestartDeps({ restartDelayS: FAST_DELAY_S })
      deps.canRestart = createPersonaRelaunchGate({ status: () => SERVING }, (line) => { gateLines.push(line) }, h.upOutcomes)
      initRestart(deps)

      for (let i = 0; i < 3; i++) await h.deliver(messageIn(SHARED, `message ${i} ${MESSAGE_MARKER}`), h.alpha.key)


      expect(h.postsTo(SHARED)).toEqual([])
      expect(h.upAsks).toEqual(Array(6).fill(h.alpha.key))
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      expect(gateLines).toEqual([])
      expect(h.p('alpha').notifications).toEqual([])
      expectBetaUntouched(h)
      await Bun.sleep(WAIT_MS) // a restart scheduled anyway would have launched by now
      expect(deps.launches).toEqual([])

      // Control: the same persona, up again, is restarted by its next lost message.
      h.notUp.delete(h.alpha.key)
      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      await waitFor(() => deps.launches.length > 0)
      expect(deps.launches).toEqual([{ key: h.alpha.key, cwd: expectedLaunchCwd(h, branch) }])
      expect(gateLines).toEqual([])
    },
  )

  test('one accepted message on both connections, beta up and alpha not up: only beta restarts and each persona retains exactly one queued item', async () => {
    const h = makeHarness({ notUp: ['alpha'] })
    // Beta is `mentions` in the shared channel, so it gets the message by mention.
    const event = messageIn(SHARED, `${mentionText(h.p('beta').stub.identity.botUserId)} ${MESSAGE_MARKER}`)

    await h.deliver(event, [h.beta.key, h.alpha.key])


    expect(h.postsTo(SHARED)).toEqual([])
    expect([...h.upAsks].sort()).toEqual([h.alpha.key, h.alpha.key, h.beta.key, h.beta.key].sort())
    expect(h.queued('alpha')).toHaveLength(1)
    expect(h.queued('beta')).toHaveLength(1)
    expect(h.p('alpha').notifications).toEqual([])
    expect(h.p('beta').notifications).toEqual([])
    expect(h.allPosts()).toEqual([])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(true)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.beta.key, cwd: h.beta.working_directory }])
  })

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
  // two-persona case above; the state table (no up check at all) fails
  // if an absent check counted as not up. This one row shows an up persona
  // still falls through to a later restart-guard state.
  test('alpha up through the real up check and at the restart-failure cap: the item stays queued and nothing launches', async () => {
    const h = makeHarness({ ...LOST_STATE_SETUPS['restart-limit-reached'].opts, upCheck: true })
    await arrangeState(h, 'restart-limit-reached')

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'restart-limit-reached' })
    expect(h.upAsks).toEqual([h.alpha.key, h.alpha.key])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
  })
})

// ===========================================================================
// Required behavior 1 — a qualifying message with no live session recovers P
// ===========================================================================

describe('(1) a qualifying message for a sessionless persona triggers recovery', () => {
  // REGRESSION GUARD: before, the drop branch never called
  // scheduleRestart for a sessionless recipient, so no launch was ever
  // scheduled and nothing recovered from a human typing to the persona.
  test('REGRESSION: a message in the persona\'s SECOND channel schedules a launch keyed to the persona, not the source channel, in its working directory, and it fires; the notice goes to the destination', async () => {
    const h = makeHarness()

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    // Real side effect: a restart is now pending for the persona …
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    // … not under the source channel …
    expect(isRestartPendingOrActive(ALPHA_SECOND)).toBe(false)
    // … and for no other persona.
    expectBetaUntouched(h)


    // And the timer really fires and launches in the persona's working directory.
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })

  test('a registered but disconnected session counts as no session: recovery in the persona\'s working directory', async () => {
    const h = makeHarness()
    h.registerFor('alpha', { disconnected: true })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    await Bun.sleep(WAIT_MS)
    expect(h.launches.map((c) => c.cwd)).toEqual([h.alpha.working_directory])
  })

  test.each([ALPHA_SECOND, SHARED])(
    'a pending restart on the persona suppresses a launch triggered from %s',
    async (channel) => {
      // SLOW delay keeps the persona's restart pending across the message.
      const h = makeHarness({ restartDelayS: SLOW_DELAY_S })
      scheduleRestart(h.alpha.key, h.alpha.working_directory, undefined, { humanTrigger: true })

      await h.deliver(messageIn(channel), h.alpha.key)

      // The guard read the persona's pending state: "restarting", not "starting now".
      // Keyed on the source channel, it would have found nothing pending.

      expectBetaUntouched(h)
    },
  )

  test.each([ALPHA_SECOND, SHARED])(
    'a cap on the persona suppresses recovery triggered from %s',
    async (channel) => {
      const h = makeHarness()
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(h.alpha.key)
      // The source channel is NOT at cap — keying on it would wrongly launch.
      expect(isAtCap(channel, RESTART_FAILURE_CAP)).toBe(false)

      await h.deliver(messageIn(channel), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      expect(isRestartPendingOrActive(channel)).toBe(false)

      expectBetaUntouched(h)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toHaveLength(0)
    },
  )
})

// ===========================================================================
// Required behavior 2 — a message that does not qualify for P triggers nothing
// ===========================================================================

describe('(2) a message the persona does not get triggers nothing and raises no notice, with no session anywhere', () => {
  test.each<[string, 'two' | 'none', (h: Harness) => SlackEvent, 'alpha' | 'beta' | 'none']>([
    ['a channel no persona lists', 'two', () => messageIn(UNCLAIMED), 'alpha'],
    ['an unmentioned message in a `mentions` channel', 'two', () => messageIn(BETA_MENTIONS), 'beta'],
    ['a channel the persona is not configured into (another persona\'s)', 'two', () => messageIn(BETA_MENTIONS), 'alpha'],
    ['the persona\'s own message in its `all` channel', 'two', (h) => makeChannelMessage({ channel: SHARED, user: h.p('alpha').stub.identity.botUserId }), 'alpha'],
    ['an intake call with no applied personas (zero-persona config)', 'none', () => messageIn(SHARED), 'none'],
    ['a key that is not an applied persona (zero-persona config)', 'none', () => messageIn(SHARED), 'alpha'],
  ])('%s', async (_label, personas, build, receiver) => {
    const h = makeHarness()
    if (personas === 'none') h.config = { ...h.config!, personas: [] }
    const keys = receiver === 'none' ? [] : [receiver === 'alpha' ? h.alpha.key : h.beta.key]
    const event = build(h)

    await h.deliver(event, keys)

    for (const key of [h.alpha.key, h.beta.key, event.channel as string]) {
      expect(isRestartPendingOrActive(key)).toBe(false)
    }
    expect(h.notices).toEqual([])
    expect(h.allPosts()).toEqual([])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 3 — a second message while restarting does not stack.
// While the first message's restart timer is pending, the second reports
// "restarting"; once its launch is in flight (held open), the persona's row
// reads `pending`, so the second reports "starting" (state 6),
// never "starting now", and stacks no launch.
// ===========================================================================

describe('(3) second message while restart pending/active does not stack a launch', () => {
  test('two messages in quick succession: a "starting now" notice, then, while the restart timer is pending, a "restarting" notice', async () => {
    // SLOW delay keeps the first restart pending across the second message.
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)

    // Only the first message asked for a restart.
    expect(h.restartAsks).toEqual([h.alpha.key])
    expectBetaUntouched(h)
  })

  test('while the first message\'s launch is actively in flight, a new message reports session starting and does not stack another launch', async () => {
    // Hold launchSession open so the persona is in activeLaunches (not just a
    // pending timer) when the second message arrives.
    const h = makeHarness({ restartDelayS: FAST_DELAY_S, holdLaunches: true })

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await waitFor(() => h.launches.length > 0) // timer fired; launchSession is now awaiting
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.isLaunchInFlight(h.alpha.key)).toBe(true)
    expect(h.launches).toHaveLength(1)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)
    await Bun.sleep(WAIT_MS) // a stacked timer would have fired by now

    // Still exactly one launch despite the second message, which asked for no restart.
    expect(h.launches).toHaveLength(1)
    expect(h.restartAsks.slice(asksBefore)).toEqual([])

    expectBetaUntouched(h)
  })
})

// ===========================================================================
// a duplicate of a queued Slack item triggers nothing more.
// A channel mention reaches the persona as a `message` and an `app_mention`
// with the same (channel, ts), and Slack may redeliver either. The persona's
// dedupe store sits before the lost-message branch, so the pair and any later
// redelivery give one notice and one recovery.
// ===========================================================================

describe('x a duplicated mention for a sessionless persona recovers once', () => {
  test('a `message` then `app_mention` of the same mention: one queued item and one launch; a redelivery after the launch adds nothing', async () => {
    const h = makeHarness()
    const text = `${mentionText(h.p('alpha').stub.identity.botUserId)} are you there? ${MESSAGE_MARKER}`
    const message = makeChannelMessage({ channel: SHARED, text })
    const mention = makeAppMention({ channel: SHARED, text, ts: message.ts })
    expect(mention.ts).toBe(message.ts)

    await h.deliver(message, h.alpha.key)
    await h.deliver(mention, h.alpha.key)

    // Without dedupe the app_mention would find the restart pending and raise
    // a second, "restarting" notice.
    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
    // The launch has finished, so no restart guard would stop a second recovery.
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)

    // Slack redelivers both events: a duplicate does nothing and logs nothing.
    const logsBefore = [...h.logs]
    await h.deliver(message, h.alpha.key)
    await h.deliver(mention, h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(h.allPosts()).toEqual([])
    expect(h.allPosts()).toEqual([])
    expect(h.launches).toHaveLength(1)
    expect(h.logs).toEqual(logsBefore)
    expectBetaUntouched(h)
  })
})

// ===========================================================================
// Required behavior 5 — auto-restart disabled (session_restart_delay 0)
// ===========================================================================

describe('(5) auto-restart disabled (delay 0) path', () => {
  test('the disabled branch schedules no launch, even with restart.ts itself able to launch', async () => {
    // The restart deps report a nonzero delay, so had the branch called
    // scheduleRestart anyway, the launch would really fire.
    const h = makeHarness({ sessionRestartDelay: 0, restartDelayS: FAST_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)

    expectBetaUntouched(h)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })

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
// a key outside the applied set is never restarted. The drop
// branch reaches the guard through `scheduleRestart`, whose `canRestart` is
// the real relaunch gate; the gate's applied check (`isApplied`) refuses a
// removed key even while its connection serves and its bring-up outcome is
// `up`. RestartDeps is unchanged. The notice is and not asserted here.
// ===========================================================================

describe('a message dropped for a key outside the applied set arms no restart timer', () => {
  test('alpha removed from the applied set (still up and serving): a queued Slack item schedules nothing and launches nothing; once applied again, a queued Slack item arms the timer and launches', async () => {
    const h = makeHarness()
    const UP: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0APPLIED', botId: 'B0APPLIED' } }
    const applied = new Set([h.beta.key])
    const gateLines: string[] = []
    const gate = createPersonaRelaunchGate(
      { status: () => UP },
      (line) => { gateLines.push(line) },
      { isUp: () => true, isApplied: (key) => applied.has(key) },
    )
    const deps = makeRestartDeps({ restartDelayS: FAST_DELAY_S })
    deps.canRestart = gate
    initRestart(deps)

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(gateLines).toEqual([`[slack] persona=${h.alpha.key}: not relaunched — it is no longer in the applied configuration`])
    await Bun.sleep(WAIT_MS)
    expect(deps.launches).toEqual([])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(false)

    // Control: the same branch arms the timer once the key is applied.
    applied.add(h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    await Bun.sleep(WAIT_MS)
    expect(deps.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
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

describe('(6) humanTrigger delay clamp (DOWN only)', () => {
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

  test('a queued Slack item is a human trigger: in the 900s regime, the restart it starts waits only HUMAN_TRIGGER_DELAY_CEILING', async () => {
    const h = makeHarness({ restartDelayS: 60 })
    // Four failures (one below the cap): the plain backoff would be 900s.
    for (let i = 0; i < 4; i++) recordFailure(h.alpha.key)

    await h.deliver(messageIn(SHARED), h.alpha.key)


    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
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

describe('(7) server.ts holds no copy of the lost-message branch', () => {
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

  test('server recovery has no standalone stream probe', () => {
    expect(SERVER_CODE).not.toMatch(/\bhasSessionStream\b/)
  })
})

// ===========================================================================
// state 4 (design note ): a message
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
// case. States and wordings come from src/lost-message.ts
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

describe('an item accepted while Q waits on an old-life hold, before any kill of the old key failed: today\'s states, and restarting while a wait step runs', () => {
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

describe('state 4: once the old key\'s kill failed, an item accepted for a persona waiting on the hold reports kill failed, until the hold ends', () => {
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
// restart clause: a restart a lost
// message triggers while Q waits on an old-life hold brings Q up only once
// the hold ends, at once
//
// Through the recovery harness's lost-message driver, at a short
// `session_restart_delay` so the asked-for restart runs. Q's row is absent,
// no wait step runs and no kill of the old key failed, so the message reports
// starting now (design A3: the notice is kept) and asks for Q's
// restart; the restart work's old-life hook holds Q: no launch, the wait
// started (its first run held) and Q's timer armed. Once the run lists the
// old row in its ids the hold ends and the end-retry observer runs Q's retry
// at once, which brings Q up. Only the state's notice is posted, at Q's
// destination; B's stub sees nothing.
// ===========================================================================

describe('a restart a queued Slack item triggers while Q waits on a hold launches nothing, and Q comes up only once the hold ends, at once', () => {
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

/** Alpha's permission-prompt destination: its home channel, or `dm` with its contact. */
type Destination = 'channel' | 'dm'

/** The drop branch: no session at all, or a connected session without its GET stream. */
type Branch = 'no session' | 'streamless'

type Harness = RoutingHarness & {
  /** The receiving persona in every lost-message case: personas[1]. */
  alpha: Persona
  /** The other persona: personas[0]. */
  beta: Persona
  /** Deliver `event` to the receiving persona key(s), as the socket handler does. */
  deliver(event: unknown, keys: string | readonly string[]): Promise<void>
}

interface HarnessOptions {
  destination?: Destination
  branch?: Branch
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
  /** Hold every restart launch open until teardown (the harness's `holdLaunches`), keeping the persona in flight. */
  holdLaunches?: boolean
  alphaStub?: StubSlackOptions
  resolveUserName?: RoutingHarnessOptions['resolveUserName']
  notify?: RoutingHarnessOptions['notify']
  /**
   * Give the routing the harness's up check (the real up predicate, not up
   * for the keys in `h.notUp`, asks recorded in `h.upAsks`). Without it (and
   * without `notUp`) the routing has no up check.
   */
  upCheck?: boolean
  /**
   * Names whose bring-up outcome is not `up` although their connection still
   * delivers a message (a persona that stopped being up while the message
   * was in flight, or the old half of a destructive modify); implies `upCheck`.
   */
  notUp?: readonly string[]
  /** Install the real outage state with a recording sink (the harness's `outageState`). */
  outageState?: boolean
  /**
   * Bind the routing's one lost-message row read, scripted per persona name
   * (the harness's `rowRead`). Without it no read is bound and none is made.
   */
  rowRead?: RoutingHarnessOptions['rowRead']
  /** Bind the routing's missing-retry-timer arm (the harness's `armRetryTimer`: each ask recorded, P's timer armed). */
  armRetryTimer?: boolean
  /** Names whose retry timer is armed first (the harness's `retryArmed`); default every persona. */
  retryArmed?: readonly string[]
}

/** A connection that serves, so only the bring-up outcome decides whether a persona is up. */
const SERVING: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0SERVING', botId: 'B0SERVING' } }

function makeHarness(opts: HarnessOptions = {}): Harness {
  const streamless = opts.branch === 'streamless'
  const h = makeRoutingHarness(
    [
      { name: 'beta', channels: [{ id: BETA_MENTIONS, delivery: 'mentions' }, { id: SHARED, delivery: 'mentions' }] },
      {
        name: 'alpha',
        channels: [
          { id: ALPHA_HOME, delivery: 'all' },
          { id: ALPHA_SECOND, delivery: 'all' },
          { id: SHARED, delivery: 'all' },
        ],
        // DMs on (so a DM to alpha qualifies) whatever the destination is.
        dm: { enabled: true, contact: CONTACT },
        permission_prompts: (opts.destination ?? 'channel') === 'dm' ? 'dm' : ALPHA_HOME,
      },
    ],
    dir,
    {
      sessions: streamless ? ['alpha'] : [],
      streamless: streamless ? ['alpha'] : undefined,
      overrides: { session_restart_delay: opts.sessionRestartDelay ?? 60 },
      restartDelayS: opts.restartDelayS ?? FAST_DELAY_S,
      launchSession: opts.launchSession,
      holdLaunches: opts.holdLaunches,
      stubOptions: opts.alphaStub ? { alpha: opts.alphaStub } : undefined,
      resolveUserName: opts.resolveUserName,
      notify: opts.notify,
      upCheck: opts.upCheck,
      notUp: opts.notUp,
      outageState: opts.outageState,
      rowRead: opts.rowRead ?? { alpha: livenessReadingForStatus(cannedStatusResult({ state: 'waiting' })), beta: livenessReadingForStatus(cannedStatusResult({ state: 'waiting' })) },
      armRetryTimer: opts.armRetryTimer,
      retryArmed: opts.retryArmed,
    },
  )
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  const harness = Object.assign(h, {
    alpha,
    beta,
    deliver: (event: unknown, keys: string | readonly string[]) =>
      h.receiveKeys(event, typeof keys === 'string' ? [keys] : keys),
  })
  harnesses.push(harness)
  return harness
}

/** The conversation alpha's notices go to for `destination`. */
function destinationId(destination: Destination): string {
  return destination === 'dm' ? stubOpenedDmId(CONTACT) : ALPHA_HOME
}

/** Where alpha's session (if any) runs: the restart of a streamless session uses its cwd. */
function expectedLaunchCwd(h: Harness, branch: Branch): string {
  return branch === 'streamless' ? h.p('alpha').sessionCwd! : h.alpha.working_directory
}


/** A DM to alpha in `channel` from `user`, carrying the message marker. */
function dmFrom(user: string, channel: string): SlackEvent {
  return makeDm({ channel, user, text: `a direct question ${MESSAGE_MARKER}` })
}

/** Every captured post as (persona whose stub posted, conversation, recovery state). */
/** The first persona (beta) got no restart and made no Slack call of any kind. */
function expectBetaUntouched(h: Harness): void {
  expect(isRestartPendingOrActive(h.beta.key)).toBe(false)
  expect(h.p('beta').stub.callLog).toEqual([])
}

/**
 * The properties every lost-message notice has: it names alpha, says a message was lost, names `sender` with no mention, identifies
 * `state` and no other, and no Slack call anywhere carries the message text.
 */
/**
 * the lost message made exactly one Slack post, alpha's notice, at its
 * destination (for `dm`, the conversation `conversations.open` returned for
 * the contact), through alpha's own client with no username or icon override,
 * and nothing in `source`. Beta made no Slack call.
 */
function expectStoredWithoutNotice(h: Harness, want: { destination: Destination; source: string; sender: string; state: LostMessageState }): void {
 expect(h.allPosts()).toEqual([])
 expect(h.notices).toEqual([])
 expect(h.queue.openCount(h.alpha.key)).toBeGreaterThan(0)
 expect(h.queued('beta')).toEqual([])
}

/** `persona-destination-failed` start lines, and its `cleared:` lines. */
const failedLines = (h: Harness) => h.logs.filter((l) => l.includes('persona-destination-failed:') && !l.includes('cleared:'))
const clearedLines = (h: Harness) => h.logs.filter((l) => l.includes('persona-destination-failed:') && l.includes('cleared:'))


interface StateInput {
  /** Harness options the input needs. */
  opts?: HarnessOptions
  /** Put persona `key` under the input. */
  set(h: Harness, key: string): void
  /** Take persona `key` out of it again (absent where no case needs it). */
  clear?(h: Harness, key: string): void
}

/** Persona `key`'s working directory. */
function cwdOf(h: Harness, key: string): string {
  return h.config!.personas.find((p) => p.key === key)!.working_directory
}

const INPUTS = {
  'not up': {
    opts: { upCheck: true },
    set: (h, key) => { h.notUp.add(key) },
    clear: (h, key) => { h.notUp.delete(key) },
  },
  // set entry with a real CONFLICT error; `forget` is its silent drop.
  'latched on a CONFLICT': {
    set: (h, key) => {
      expect(h.latch.setFromConflict(key, conflictForPersona(key), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW })).toBeDefined()
      expect(h.latch.isLatched(key)).toBe(true)
    },
    clear: (h, key) => { expect(h.latch.forget(key)).toBe(true) },
  },
  // The hold's set, as a reuse spawn's ErrInvalidFlags sets it; `forget` is its silent end.
  'held on ErrInvalidFlags': {
    set: (h, key) => {
      expect(h.invalidFlagsHold.set(key)).toBe(true)
      expect(h.invalidFlagsHold.isHeld(key)).toBe(true)
    },
    clear: (h, key) => { expect(h.invalidFlagsHold.forget(key)).toBe(true) },
  },
  'kill failed': {
    set: (h, key) => { h.killFailed.add(key) },
    clear: (h, key) => { h.killFailed.delete(key) },
  },
  // entry: a refusal from a tmux-touching verb starts the condition; a
  // health tick that reads the row live ends it.
  'tmux-unresponsive holds': {
    set: (h, key) => {
      expect(h.tmuxUnresponsive.start(key, 'resume', errTmuxUnresponsive('resume'))).toBe('started')
    },
    clear: (h, key) => { expect(h.tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_TICK)).not.toBe('not-holding') },
  },
  // one raise entry and the real clear.
  'tmux-unavailable raised': {
    opts: { outageState: true },
    set: (_h, key) => {
      raiseTmuxUnavailable(key, errTmuxNotAvailable())
      expect(getOutageFlags(key).has('tmux-unavailable')).toBe(true)
    },
    clear: (_h, key) => {
      clearOutageFlag(key, 'tmux-unavailable')
      expect(getOutageFlags(key).size).toBe(0)
    },
  },
  // one raise entry and the real clear.
  'ad-config-malformed raised': {
    opts: { outageState: true },
    set: (_h, key) => {
      raiseAdConfigMalformed(key, errConfigMalformed())
      expect(getOutageFlags(key).has('ad-config-malformed')).toBe(true)
    },
    clear: (_h, key) => {
      clearOutageFlag(key, 'ad-config-malformed')
      expect(getOutageFlags(key).size).toBe(0)
    },
  },
  'a live-row sequence running': {
    set: (h, key) => { h.sequenceOrWaitRunning.add(key) },
    clear: (h, key) => { h.sequenceOrWaitRunning.delete(key) },
  },
  // A restart whose timer has not fired: armed at a delay that never fires,
  // then the restart module is able to launch again (fast delay).
  'a pending restart': {
    set: (h, key) => {
      const delay = h.restartDelayS
      h.restartDelayS = SLOW_DELAY_S
      scheduleRestart(key, cwdOf(h, key), undefined, { humanTrigger: true })
      h.restartDelayS = delay
      expect(isRestartPendingOrActive(key)).toBe(true)
    },
  },
  'auto-restart disabled': {
    opts: { sessionRestartDelay: 0 },
    set: () => {},
  },
} satisfies Record<string, StateInput>

type InputName = keyof typeof INPUTS

/** State 5's three sources. */
const STATE_5_SOURCES = ['tmux-unresponsive holds', 'tmux-unavailable raised', 'ad-config-malformed raised'] as const satisfies readonly InputName[]

/** The harness options of every named input together. */
function inputOpts(...names: InputName[]): HarnessOptions {
  return Object.assign({}, ...names.map((n) => (INPUTS[n] as StateInput).opts ?? {}))
}


/**
 * Arrange alpha in `state` for the next lost message on the no-session
 * branch, as the shared table (`LOST_STATE_SETUPS`) arranges it, its launches
 * in its working directory.
 */
function arrangeState(h: Harness, state: LostMessageState): Promise<void> | void {
  return LOST_STATE_SETUPS[state].arrange(h, h.alpha.key, h.alpha.working_directory)
}

describe('recovery selects the recovery state', () => {
  const table: [LostMessageState, Destination][] = LOST_MESSAGE_STATES.flatMap((s) => (['channel', 'dm'] as const).map((d): [LostMessageState, Destination] => [s, d]))

  test.each(table)(
    'state %s, a %s destination: stores one item without a source or destination notice; a restart is asked for only when starting now',
    async (state, destination) => {
      const setup = LOST_STATE_SETUPS[state]
      const h = makeHarness({ destination, ...setup.opts })
      await arrangeState(h, state)
      const asksBefore = h.restartAsks.length

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination, source: SHARED, sender: STUB_USER_NAME, state })
      // Only "starting now" asks the relaunch gate (it schedules the restart).
      expect(h.restartAsks.slice(asksBefore)).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(setup.pending)
      await Bun.sleep(WAIT_MS) // a launch the message scheduled would have fired by now
      expect(h.launches).toHaveLength(setup.launches)
      for (const launch of h.launches) expect(launch).toEqual({ key: h.alpha.key, cwd: h.alpha.working_directory })
    },
  )
})

// ===========================================================================
// state 5 (design notes ) — an item accepted while P is
// not answering, from each of its three sources: its `tmux-unresponsive`
// condition holding , its `tmux-unavailable` outage raised or
// its `ad-config-malformed` outage raised. No restart is asked for,
// scheduled or launched, and the source's own notice (the outage onset) goes
// to the outage state's sink, not to Slack. After the source's real end or
// clear, the next lost message starts a restart. An open unclassified-error
// episode, or another outage class, is not a source.
// ===========================================================================

describe('state 5: an item accepted while the persona is not answering starts no restart', () => {
  const SOURCES: [typeof STATE_5_SOURCES[number]][] = STATE_5_SOURCES.map((source) => [source])

  test.each(SOURCES)(
    '%s: the notice says not answering and no restart is asked for or launched; after its real end the next lost message starts now with one launch',
    async (source) => {
      const h = makeHarness(inputOpts(source))
      INPUTS[source].set(h, h.alpha.key)
      const asksBefore = h.restartAsks.length

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'not-answering' })
      expect(h.restartAsks.slice(asksBefore)).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([])

      INPUTS[source].clear(h, h.alpha.key)
      await h.deliver(messageIn(SHARED), h.alpha.key)


      expect(h.postsTo(SHARED)).toEqual([])
      await waitFor(() => h.launches.length > 0)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
      expectBetaUntouched(h)
    },
  )

  test.each<[string, LostMessageState, InputName | undefined, number]>([
    ['alone', 'starting-now', undefined, 1],
    ['with auto-restart disabled', 'auto-restart-disabled', 'auto-restart disabled', 0],
  ])(
    'hatch A2: an open unclassified-error episode %s never reports not answering; the message reports %s',
    async (_label, state, other, launches) => {
      const h = makeHarness(other === undefined ? {} : inputOpts(other))
      expect(h.episodes.begin(h.alpha.key, PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR)).toBe('begun')
      if (other !== undefined) INPUTS[other].set(h, h.alpha.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expect(h.episodes.isOpen(h.alpha.key, PERSONA_EPISODE_KIND_UNCLASSIFIED_ERROR)).toBe(true)
      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toHaveLength(launches)
    },
  )

  test.each(OUTAGE_CLASS_ORDER.filter((cls) => cls !== 'tmux-unavailable' && cls !== 'ad-config-malformed'))(
    'the %s outage raised for the persona is not a not-answering source: the message starts now',
    async (cls) => {
      const h = makeHarness({ outageState: true })
      setOutageFlag(h.alpha.key, cls, 'detail')
      expect(getOutageFlags(h.alpha.key).has(cls)).toBe(true)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
      // The outage's onset went to the outage state's sink, never to Slack.
      expect(h.outageNotices.map((n) => n.key)).toEqual([h.alpha.key])
    },
  )
})

// ===========================================================================
// (orchestrator ruling): "A persona whose retry
// timer is stopped at the restart cap reports restart-limit-reached, never
// state 5's 'CSCB is retrying', whatever condition or flag is raised. In
// order, state 5 applies only while P's retry timer is armed."
// Through the real routing, with the restart delay above 0 (so auto-restart
// disabled does not come first) and the row read bound (answering live, a
// restart's input): alpha at the restart cap (the real backoff
// state) with each state-5 source, its retry timer still armed (the window
// the cap closes: that timer stops at its next retry) or none, reports
// restart limit reached; no restart is asked for, scheduled or launched,
// and the missing-retry-timer arm is never asked. Below the cap, state 5
// needs the timer: armed, not answering; `tmux-unavailable` raised with
// none armed, the arm is asked before the decision and its timer makes the
// message not answering, with no read; the condition or `ad-config-malformed`
// alone with none armed is not state 5, so the message falls through to the
// next state that applies (here starting now, with its read and restart).
// ===========================================================================

describe('as amended: state 5 applies only while the retry timer is armed, and never at the restart cap', () => {
  /** Alpha under `source`, its retry timer armed first or not, the arm member bound and the row read answering live. */
  function gateHarness(source: typeof STATE_5_SOURCES[number], armed: boolean): Harness {
    const h = makeHarness({
      ...inputOpts(source),
      armRetryTimer: true,
      retryArmed: armed ? ['alpha'] : [],
      rowRead: { alpha: LIVENESS_READING_LIVE },
    })
    INPUTS[source].set(h, h.alpha.key)
    return h
  }

  const CAPPED = STATE_5_SOURCES.flatMap((source) => ([true, false] as const).map(
    (armed): [typeof STATE_5_SOURCES[number], string, boolean] => [source, armed ? 'still armed' : 'none armed', armed],
  ))

  test.each(CAPPED)(
    'alpha at the restart cap with %s, its retry timer %s: the notice says restart limit reached, never not answering; no restart is asked for, scheduled or launched, and no retry timer is asked for or armed',
    async (source, _timer, armed) => {
      const h = gateHarness(source, armed)
      putAtRestartCap(h.alpha.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'restart-limit-reached' })
      // States 1 to 5 did not apply, so the one read was made.
      expect(h.rowReads).toEqual([h.alpha.key])
      expect(h.retryTimerArms).toEqual([])
      expect(h.retryArmed.has(h.alpha.key)).toBe(armed)
      expect(h.restartAsks).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
      expect(h.launches).toEqual([])
      expectNoFakeTimerLeft(h)
    },
  )

  test.each<[typeof STATE_5_SOURCES[number], string, LostMessageState, boolean, readonly string[]]>([
    ['tmux-unresponsive holds', 'armed', 'not-answering', true, []],
    ['tmux-unavailable raised', 'armed', 'not-answering', true, ['alpha']],
    ['ad-config-malformed raised', 'armed', 'not-answering', true, []],
    ['tmux-unavailable raised', 'none armed (the arm, asked before the decision, arms it)', 'not-answering', false, ['alpha']],
    ['tmux-unresponsive holds', 'none armed', 'starting-now', false, []],
    ['ad-config-malformed raised', 'none armed', 'starting-now', false, []],
  ])(
    'below the cap, %s, the retry timer %s: the notice says %s; only starting now asks for a restart',
    async (source, _timer, state, armed, armAsks) => {
      const h = gateHarness(source, armed)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
      expect(h.retryTimerArms).toEqual(h.keys(armAsks))
      expect(h.retryArmed.has(h.alpha.key)).toBe(state === 'not-answering')
      // Not answering is decided at the read gate's check, with no read; a
      // fall-through makes the one read (live) and then starts now.
      expect(h.rowReads).toEqual(state === 'not-answering' ? [] : [h.alpha.key])
      expect(h.restartAsks).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(state === 'starting-now')
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual(state === 'starting-now' ? [{ key: h.alpha.key, cwd: h.alpha.working_directory }] : [])
    },
  )
})

// ===========================================================================
// state 2 (design note ) — an item accepted while P
// is latched reads latch instance: a CONFLICT and two declared
// hold cases each give `held-for-human`, and no restart. After the latch's
// silent forget, the next lost message starts a restart.
// ===========================================================================

describe('state 2: an item accepted while the persona is latched starts no restart', () => {
  const conflictRow = CONFLICT_CASE_ROWS.find((row) => row.latchCase === LATCH_CASE_LEFTOVER)!
  const LATCHES: [string, (h: Harness) => void][] = [
    [
      `a CONFLICT (${conflictRow.name})`,
      (h) => { h.latch.setFromConflict(h.alpha.key, conflictRow.build(), { refusedOperation: conflictRow.refusedOperation, rowState: conflictRow.rowState }) },
    ],
    ...HOLD_LATCH_CASES.map((latchCase): [string, (h: Harness) => void] => [
      `the hold case ${latchCase}`,
      (h) => { h.latch.set(h.alpha.key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE }) },
    ]),
  ]

  test.each(LATCHES)(
    'latched on %s: the notice says held for a human, no restart is asked for or launched and the latch posts nothing; after the latch is forgotten the next lost message starts now',
    async (_label, latch) => {
      const h = makeHarness()
      latch(h)
      expect(h.latch.isLatched(h.alpha.key)).toBe(true)

      await h.deliver(messageIn(SHARED), h.alpha.key)

      expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'held-for-human' })
      expect(h.restartAsks).toEqual([])
      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toEqual([])

      expect(h.latch.forget(h.alpha.key)).toBe(true)
      await h.deliver(messageIn(SHARED), h.alpha.key)


      await waitFor(() => h.launches.length > 0)
      expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
      expectBetaUntouched(h)
    },
  )

  test('one message lost on both connections, alpha latched and beta not: beta reports starting now and is restarted, alpha reports held for a human and is not, each at its own destination', async () => {
    const h = makeHarness()
    INPUTS['latched on a CONFLICT'].set(h, h.alpha.key)
    // Beta is `mentions` in the shared channel, so it gets the message by mention.
    const event = messageIn(SHARED, `${mentionText(h.p('beta').stub.identity.botUserId)} ${MESSAGE_MARKER}`)

    await h.deliver(event, [h.beta.key, h.alpha.key])


    expect(h.postsTo(SHARED)).toEqual([])
    expect(h.restartAsks).toEqual([h.beta.key])
    expect(isRestartPendingOrActive(h.beta.key)).toBe(true)
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.beta.key, cwd: h.beta.working_directory }])
  })
})

// ===========================================================================
// order, through the real routing, as adjacent pairs: with
// both inputs set, the earlier state is reported; with the earlier input
// cleared, the later one. The live-row sequence or old-life wait input
// answers `restarting` before a launch running (section ruling). No
// message asks for, schedules or launches a restart.
// ===========================================================================

describe('the first state that applies is reported', () => {
  test.each<[InputName, InputName, LostMessageState, LostMessageState]>([
    ['not up', 'latched on a CONFLICT', 'not-up', 'held-for-human'],
    ['latched on a CONFLICT', 'held on ErrInvalidFlags', 'held-for-human', 'cannot-launch'],
    ['held on ErrInvalidFlags', 'kill failed', 'cannot-launch', 'kill-failed'],
    ['kill failed', 'tmux-unresponsive holds', 'kill-failed', 'not-answering'],
    ['tmux-unresponsive holds', 'auto-restart disabled', 'not-answering', 'auto-restart-disabled'],
  ])('%s over %s: %s, then, once the first is cleared, %s', async (first, second, firstState, secondState) => {
    const h = makeHarness(inputOpts(first, second))
    INPUTS[second].set(h, h.alpha.key)
    INPUTS[first].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length
    const pendingBefore = isRestartPendingOrActive(h.alpha.key)

    await h.deliver(messageIn(SHARED), h.alpha.key)
    ;(INPUTS[first] as StateInput).clear!(h, h.alpha.key)
    await h.deliver(messageIn(SHARED), h.alpha.key)


    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(pendingBefore)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
    expectBetaUntouched(h)
  })

  // Every keyed input (auto-restart disabled is server-wide).
  const KEYED = (Object.keys(INPUTS) as InputName[]).filter((n) => n !== 'auto-restart disabled')

  test.each(KEYED.map((n): [InputName] => [n]))(
    'another persona\'s input is not the persona\'s: with beta under "%s", alpha\'s lost message starts now and alpha is restarted',
    async (input) => {
      const h = makeHarness(inputOpts(input))
      INPUTS[input].set(h, h.beta.key)

      await h.deliver(messageIn(SHARED), h.alpha.key)


      expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
      await waitFor(() => h.launches.some((l) => l.key === h.alpha.key))
      expect(h.launches.filter((l) => l.key === h.alpha.key)).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
    },
  )
})

// ===========================================================================
// state 6 by the read — with states 1 to 5 clear and
// nothing in flight for P, the routing makes one row read of P (the
// harness's scripted `readRowLiveness`). A `pending` answer is state 6, which
// comes before every restart guard: no restart is asked for, scheduled or
// launched (state 6 from the read). A `live` reading or no
// row (`dead`) is not `pending`: the state is the next that applies, here
// starting now control. A launch running is state 6 with no read
// (the describe); a dialog approver running, likewise (the order pairs
// above, and the read gate in tests/persona-routing.test.ts).
// ===========================================================================

/** No fake-clock timer is left: the destination hold's and the episodes'. */
function expectNoFakeTimerLeft(h: Harness): void {
  expect(h.holdClock.pendingCount()).toBe(0)
  expect(h.episodesClock.pendingCount()).toBe(0)
}

/** States 2 to 6 of the contract, where no human-triggered restart fires. */
const NO_RESTART_STATES = LOST_MESSAGE_STATES.slice(
  LOST_MESSAGE_STATES.indexOf('held-for-human'),
  LOST_MESSAGE_STATES.indexOf('session-starting') + 1,
)

describe('state 6 by the read: a row reading `pending` reports session starting and starts no restart', () => {
  test.each<[string, InputName | undefined, boolean]>([
    ['nothing else applies', undefined, false],
    ['a restart timer is pending (state 6 comes before restarting)', 'a pending restart', true],
    ['auto-restart is disabled (state 6 comes before auto-restart disabled)', 'auto-restart disabled', false],
  ])('%s: one read of alpha, then the session-starting notice; no restart is asked for, scheduled or launched', async (_label, input, pending) => {
    const h = makeHarness({ ...(input === undefined ? {} : inputOpts(input)), rowRead: { alpha: LIVENESS_READING_PENDING } })
    if (input !== undefined) INPUTS[input].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'session-starting' })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`])
    expect(h.restartAsks.slice(asksBefore)).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(pending)
    await Bun.sleep(WAIT_MS) // a restart the message scheduled would have launched by now
    expect(h.launches).toEqual([])
    expectNoFakeTimerLeft(h)
  })

  test.each<[string, RowReadAnswer]>([
    ['a live reading', LIVENESS_READING_LIVE],
    ['no row (the dead reading)', LIVENESS_READING_DEAD],
  ])('control: %s is not `pending`: one read, then starting now, which asks the relaunch gate once and launches once', async (_label, answer) => {
    const h = makeHarness({ rowRead: { alpha: answer } })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state: 'starting-now' })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`])
    expect(h.restartAsks).toEqual([h.alpha.key])
    await waitFor(() => h.launches.length > 0)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })
})

// ===========================================================================
// a failed read (an `unknown` reading, or a read that
// rejects) is never taken for `pending`: state 6 is left out and the state
// is the next that applies. A rejection is caught and logged once, naming the
// persona, its message redacted (the teardown leak check covers the rest).
// ===========================================================================

describe('a failed row read leaves state 6 out', () => {
  const FAILED: [string, RowReadAnswer][] = [
    ['an unknown reading', LIVENESS_READING_UNKNOWN],
    ['a read that rejects', ROW_READ_REJECTS],
  ]
  const NEXT: [string, InputName | undefined, LostMessageState][] = [
    ['nothing else', undefined, 'starting-now'],
    ['a restart timer pending', 'a pending restart', 'restarting'],
    ['auto-restart disabled (delay 0)', 'auto-restart disabled', 'auto-restart-disabled'],
  ]
  const table = FAILED.flatMap(([label, answer]) =>
    NEXT.map(([nextLabel, input, state]): [string, string, LostMessageState, RowReadAnswer, InputName | undefined] => [label, nextLabel, state, answer, input]),
  )

  test.each(table)('%s, with %s: recovery selects %s; only starting now asks for a restart, which launches once', async (_label, _nextLabel, state, answer, input) => {
    const h = makeHarness({ ...(input === undefined ? {} : inputOpts(input)), rowRead: { alpha: answer } })
    if (input !== undefined) INPUTS[input].set(h, h.alpha.key)
    const asksBefore = h.restartAsks.length

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
    expect(h.rowReads).toEqual([h.alpha.key])
    expect(h.restartAsks.slice(asksBefore)).toEqual(state === 'starting-now' ? [h.alpha.key] : [])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(state !== 'auto-restart-disabled')
    const failedLines = h.logs.filter((l) => l.includes(ROW_READ_REJECTION_REDACTED))
    if (answer === ROW_READ_REJECTS) {
      expect(failedLines).toHaveLength(1)
      expect(failedLines[0]).toContain(renderPersonaRef(h.alpha.name, h.alpha.key))
      // The thrown value's type, then its redacted message.
      expect(failedLines[0]).toContain(`Error message="${ROW_READ_REJECTION_REDACTED}"`)
    } else {
      expect(failedLines).toEqual([])
    }
    expect(h.logs.filter((l) => l.includes('error handling event'))).toEqual([])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual(state === 'starting-now' ? [{ key: h.alpha.key, cwd: h.alpha.working_directory }] : [])
    expectNoFakeTimerLeft(h)
  })
})

// ===========================================================================
// (section ruling: decide again after the read) — states 1 to 5
// are decided again over fresh answers once the read settles, so a latch or
// an outage that begins while the read runs gives state 2 or 5, whatever
// the read answers. (A live-row sequence or old-life wait step running for
// P answers `restarting` with no read, the read gate in
// tests/persona-routing.test.ts.) Two messages lost together,
// both reads in flight at once, schedule one restart: nothing is awaited
// between the final decision and `scheduleRestart`.
// ===========================================================================

describe('the state is decided again after the read', () => {
  const DURING: [string, InputName, LostMessageState][] = [
    ['alpha is latched', 'latched on a CONFLICT', 'held-for-human'],
    ['alpha\'s tmux-unavailable outage is raised', 'tmux-unavailable raised', 'not-answering'],
    ['alpha\'s ad-config-malformed outage is raised', 'ad-config-malformed raised', 'not-answering'],
  ]
  const table = DURING.flatMap(([label, input, state]) =>
    ([['live', LIVENESS_READING_LIVE], ['pending', LIVENESS_READING_PENDING]] as const).map(
      ([name, answer]): [string, string, InputName, LostMessageState, RowReadAnswer] => [label, name, input, state, answer],
    ),
  )

  test.each(table)('%s while the read runs, which then answers %s: recovery selects the earlier state, and no restart is asked for, scheduled or launched', async (_label, _answerName, input, state, answer) => {
    const h = makeHarness({
      ...inputOpts(input),
      rowRead: { alpha: { answer, during: (hh, key) => INPUTS[input].set(hh as Harness, key) } },
    })

    await h.deliver(messageIn(SHARED), h.alpha.key)

    expectStoredWithoutNotice(h, { destination: 'channel', source: SHARED, sender: STUB_USER_NAME, state })
    expect(h.readOrder).toEqual([`read:${h.alpha.key}`])
    expect(h.restartAsks).toEqual([])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([])
    expectNoFakeTimerLeft(h)
  })

  test('two messages lost together for alpha, both reads in flight at once and answering live: exactly one restart is scheduled; both items stay queued and only the first schedules recovery', async () => {
    // Each read waits until both have started, so both decisions follow both reads.
    let started = 0
    let bothStarted!: () => void
    const both = new Promise<void>((resolve) => { bothStarted = resolve })
    const during = async (): Promise<void> => {
      started += 1
      if (started === 2) bothStarted()
      await both
    }
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S, rowRead: { alpha: { answer: LIVENESS_READING_LIVE, during } } })

    await Promise.all([
      h.deliver(messageIn(SHARED, `first ${MESSAGE_MARKER}`), h.alpha.key),
      h.deliver(messageIn(ALPHA_SECOND, `second ${MESSAGE_MARKER}`), h.alpha.key),
    ])

    expect(h.readOrder.slice(0, 2)).toEqual([`read:${h.alpha.key}`, `read:${h.alpha.key}`])
    expect(h.rowReads).toEqual([h.alpha.key, h.alpha.key])
    // One scheduleRestart reached the relaunch gate (a second would have asked it again).
    expect(h.restartAsks).toEqual([h.alpha.key])
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)


    expectBetaUntouched(h)
  })
})
