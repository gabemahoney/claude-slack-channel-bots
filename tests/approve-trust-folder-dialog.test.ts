/**
 * approve-trust-folder-dialog.test.ts — Direct unit tests of the startup-dialog
 * approver's lap (`approvePreSessionDialogs`, b.jg5 SRJ-402) over the
 * agent-director stub.
 *
 * A launch, fresh or resumed, reads `pending` until its session reports in
 * (HO C5), so every lap works on the `pending` row through agent-director
 * only: one own-row `status` read; on `pending` with a launch start one
 * `read-pane` (40 lines, `allow_pending`) and, when a needle of either
 * startup dialog shows, one `send-keys` (empty text, `allow_pending`, the
 * persona's instance id and nothing else). A live state ends it; `ended` or
 * `missing` stops it at that lap with no pane read and, for a start-pass
 * launch, `dev-channels-approve-spawn-died` written at once; an absent row
 * stops it with no entry; a `pending` row with no launch start is never read
 * or typed into (E16's own-row step latches P when the latch and the
 * configured-persona query are installed). Every case checks the typed stop
 * reason the approver resolves with.
 *
 * The registry (b.jg5 SRJ-401, SRJ-404; hatch A2) is driven through its
 * entries (`startDialogApprover`, `stopDialogApprover`,
 * `stopAllDialogApprovers`, `isDialogApproverRunning`,
 * `dialogApproverLaunchStart`) and its await seam
 * (`_whenDialogApproverStopped`): at most one approver per persona, a stop
 * that completes after the call in progress returns and types nothing after
 * it, the launch start a running approver keeps, stop-all, and calls made
 * outside every launch attempt. Its cases hold a chosen call of a chosen
 * persona open with a gate and record every call's start in one ordered
 * event list.
 *
 * Time: every case runs on `createFakeClock` through the approver's clock
 * seam (`_setApproverClock`); laps are driven with `runNext`, never a real
 * sleep, and `afterEach` asserts no timer is left pending. The pace is not
 * pinned here (SRJ-403 has its own cases), so this file sets no poll-interval
 * seam.
 *
 * tmux: a recording tmux runner (`_setTmuxCommandRunner`) is installed for
 * every case and `afterEach` asserts it recorded no call: the server starts no
 * tmux process for the approver.
 *
 * Every captured log line, every stub call and the state directory the
 * startup-errors log is written to pass through `assertNoLeak`. No
 * mock.module().
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadPaneParams, SendKeysParams, StatusParams } from 'agent-director'
import {
  approvePreSessionDialogs,
  approverAbsentMessage,
  approverCapMessage,
  approverFinishedMessage,
  approverLaunchStartChangedMessage,
  approverLogLine,
  approverNoLaunchStartMessage,
  approverNotStartedMessage,
  approverPaneCallFailedMessage,
  approverStatusRefusedMessage,
  approverStopRequestedMessage,
  approverUnknownStateMessage,
  APPROVER_LOG_PREFIX,
  APPROVER_LOG_SITE,
  APPROVER_STATUS_READ_WHAT,
  APPROVER_STOP_ABSENT,
  APPROVER_STOP_CAP,
  APPROVER_STOP_FINISHED,
  APPROVER_STOP_LATCHED,
  APPROVER_STOP_LIVE,
  APPROVER_STOP_NO_LAUNCH_START,
  APPROVER_STOP_SHUTDOWN,
  APPROVER_STOP_SUPERSEDED,
  APPROVER_STOP_TEARDOWN,
  DEV_CHANNELS_DIALOG_NEEDLE,
  dialogApproverLaunchStart,
  isDialogApproverRunning,
  startDialogApprover,
  STARTUP_ERROR_APPROVE_NOT_READY,
  STARTUP_ERROR_APPROVE_SPAWN_DIED,
  stopAllDialogApprovers,
  stopDialogApprover,
  TRUST_DIALOG_NEEDLE,
  _resetApproverClock,
  _resetConfiguredPersonaQuery,
  _resetDialogApprovers,
  _resetDialogReadyTimeoutMs,
  _resetTmuxCommandRunner,
  _setApproverClock,
  _setDialogReadyTimeoutMs,
  _setTmuxCommandRunner,
  _whenDialogApproverStopped,
  setConfiguredPersonaQuery,
  setConflictLatch,
  type ApproverOutcome,
  type ApproverStopReason,
} from '../src/session-manager.ts'
import { parseLaunchStart } from '../src/pending-row.ts'
import { isInsideAttempt, runInAttempt } from '../src/unavailable-retry.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
} from '../src/liveness-reading.ts'
import {
  createConflictLatch,
  describeLatchRowState,
  latchRowStateRead,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
} from '../src/conflict-latch.ts'
import { describeAgentDirectorFailure } from '../src/ad-error-class.ts'
import type { Phase1StatusResult } from '../src/ad-phase1-types.ts'
import { getClient, resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { _resetOutageState, initOutageState } from '../src/outage-state.ts'
import {
  cannedErr,
  cannedStatusResult,
  errGeneric,
  errSpawnNotFound,
  makeStubCallLog,
  makeStubClient,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_WHOLE,
  unavailableForms,
  type StubCallLog,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  launchStartRecord,
  NO_LAUNCH_START_FORM_NAMES,
  NO_LAUNCH_START_FORMS,
} from './test-helpers/conflict-cases.ts'
import { assertNoLeak, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { stripComments } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One persona the approver works for: its key, reference and instance id. */
interface ApproverPersona {
  readonly label: string
  readonly key: string
  readonly ref: string
  readonly id: string
}

function persona(label: string, name: string): ApproverPersona {
  const key = personaKey(name)
  return { label, key, ref: renderPersonaRef(name, key), id: personaInstanceId(key) }
}

/** A plain key (the name is the key) and a key that differs from the persona's name. */
const PLAIN = persona('plain key', 'dev')
const NAMED = persona('key differs from the name', 'Ops Bot')
const PERSONAS: readonly ApproverPersona[] = [PLAIN, NAMED]

/** Both startup-dialog needles, by dialog. */
const NEEDLES: ReadonlyArray<readonly [string, string]> = [
  ['folder-trust', TRUST_DIALOG_NEEDLE],
  ['dev-channels', DEV_CHANNELS_DIALOG_NEEDLE],
]

/** A pane showing a startup dialog whose pre-selected option is `needle`. */
function dialogPane(needle: string): { pane: string } {
  return { pane: ['  ┌──────────────────────────────────────┐', `  │ > 1. ${needle}`, '  │   2. No, exit', '  └──────────────────────────────────────┘'].join('\n') }
}

/** A pane with no startup dialog on it. */
const CLEAR_PANE = { pane: 'Listening for channel messages from: server:slack-channel-router' }

/** A `pending` row with a launch start (the stub's default sample). */
const PENDING_ROW = cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE })

/** A live state other than `pending`, for the cases that only need the approver to end. */
const LIVE_STATES_BUT_PENDING = [...AGENT_DIRECTOR_LIVE_STATES].filter((s) => s !== AGENT_DIRECTOR_PENDING_STATE)
const LIVE_ROW = cannedStatusResult({ state: LIVE_STATES_BUT_PENDING[0]! })

/** The expected `read-pane` of persona `id`: 40 lines, `allow_pending` (b.jg5 SRJ-402). */
function expectedReadPane(id: string): ReadPaneParams {
  return { claude_instance_id: id, n_lines: 40, allow_pending: true }
}

/** The expected `send-keys` of persona `id`: Enter (empty text), `allow_pending`, nothing else (no pane target). */
function expectedEnter(id: string): SendKeysParams {
  return { claude_instance_id: id, text: '', allow_pending: true }
}

/**
 * An agent-director error for `verb` whose message carries the leak marker
 * only inside a fake token and a `?ticket=` URL, and whose `data` carries it
 * bare (a field CSCB must never read).
 */
function leakyAdError(verb: string): Error {
  return Object.assign(errGeneric(verb, 'ErrBroken', `${verb} refused (${sentinelInMessage(verb)})`), {
    data: { marker: LEAK_SENTINEL },
  })
}

// ---------------------------------------------------------------------------
// Per-case state: the fake clock, the stub, the log lines, the tmux runner
// ---------------------------------------------------------------------------

let clock: FakeClock
let calls: StubCallLog
/** The virtual time of each `status` call: one per lap. */
let statusAt: number[]
let errLines: string[]
let savedConsoleError: typeof console.error
let tmuxCalls: string[][]
let stateDir: string
let savedStateDir: string | undefined

beforeEach(() => {
  clock = createFakeClock()
  _setApproverClock(clock)
  _resetDialogReadyTimeoutMs()
  initOutageState({ notify: () => {}, getClient })
  tmuxCalls = []
  _setTmuxCommandRunner(async (args) => {
    tmuxCalls.push([...args])
    return { code: 1, stdout: '' }
  })
  calls = makeStubCallLog()
  statusAt = []
  savedStateDir = process.env['SLACK_STATE_DIR']
  stateDir = mkdtempSync(join(tmpdir(), 'cscb-approver-'))
  process.env['SLACK_STATE_DIR'] = stateDir
  errLines = []
  savedConsoleError = console.error
  console.error = (...args: unknown[]) => {
    errLines.push(args.map(String).join(' '))
  }
})

afterEach(() => {
  console.error = savedConsoleError
  const pendingTimers = clock.pending()
  const leakCheck = { errLines, calls, tmuxCalls, stateDir: writtenFile(stateDir) }
  try {
    expect(pendingTimers).toEqual([])
    expect(tmuxCalls).toEqual([])
    assertNoLeak(leakCheck)
  } finally {
    _resetApproverClock()
    _resetDialogReadyTimeoutMs()
    _resetTmuxCommandRunner()
    resetClientForTests()
    _resetOutageState()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = savedStateDir
    rmSync(stateDir, { recursive: true, force: true })
  }
})

/**
 * Install the stub. `status` answers `statusAnswers` in order, one per lap,
 * the last sticking; each call's virtual time goes to `statusAt`. Every call
 * is recorded in `calls`.
 */
function installStub(
  statusAnswers: ReadonlyArray<Phase1StatusResult | Error>,
  knobs: Omit<StubClientOptions, keyof StubCallLog | 'statusFn'> = {},
): void {
  let next = 0
  const stub = makeStubClient({
    ...calls,
    ...knobs,
    statusFn: (_params: StatusParams) => {
      statusAt.push(clock.now())
      const answer = statusAnswers[Math.min(next, statusAnswers.length - 1)]!
      next++
      return answer
    },
  })
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
}

/** A running approver: its stop reason once it has resolved. */
interface ApproverRun {
  stop(): ApproverStopReason | undefined
}

function startApprover(who: ApproverPersona, isStartup: boolean): ApproverRun {
  let stop: ApproverStopReason | undefined
  void approvePreSessionDialogs(who.key, isStartup, who.ref).then((reason) => {
    stop = reason
  })
  return { stop: () => stop }
}

/**
 * Let the running lap finish, then fire timers one at a time (each sleep
 * starts the next lap) until the approver resolves; at most `maxTimers`.
 */
async function runToStop(run: ApproverRun, maxTimers = 20): Promise<ApproverStopReason> {
  for (let fired = 0; ; fired++) {
    await clock.flush()
    const stop = run.stop()
    if (stop !== undefined) return stop
    if (fired >= maxTimers) throw new Error(`the approver did not stop within ${maxTimers} timers`)
    await clock.runNext()
  }
}

async function approve(who: ApproverPersona, isStartup: boolean): Promise<ApproverStopReason> {
  return runToStop(startApprover(who, isStartup))
}

/** The approver's own log lines (its prefix; the shared `status` read's lines included). */
function approverLines(): string[] {
  return errLines.filter((line) => line.startsWith(APPROVER_LOG_PREFIX))
}

/** The startup-errors entries written, as class label and message (no timestamp). */
function startupEntries(): Array<{ label: string; message: string }> {
  const path = join(stateDir, 'startup-errors.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const m = /^\[[^\]]*\] \[([^\]]+)\] (.*)$/.exec(line)
      if (m === null) throw new Error('unparseable startup-errors line')
      return { label: m[1]!, message: m[2]! }
    })
}

// ---------------------------------------------------------------------------
// The lap on a `pending` row with a launch start
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: the lap on a pending row with a launch start (b.jg5 SRJ-402)', () => {
  const ROWS = PERSONAS.flatMap((who) => NEEDLES.map(([dialog, needle]) => [dialog, who.label, who, needle] as const))

  test.each(ROWS)(
    '%s needle, %s: one status, one read-pane (40 lines, allow_pending), exactly one send-keys (instance id, empty text, allow_pending); a live row then ends it',
    async (_dialog, _label, who, needle) => {
      installStub([PENDING_ROW, LIVE_ROW], { readPaneResults: [dialogPane(needle)] })
      const run = startApprover(who, true)

      await clock.flush()
      // The first lap, before any timer fires.
      expect(run.stop()).toBeUndefined()
      expect(calls.statusCalls).toEqual([{ claude_instance_id: who.id }])
      expect(calls.readPaneCalls).toEqual([expectedReadPane(who.id)])
      expect(calls.sendKeysCalls).toEqual([expectedEnter(who.id)])

      expect(await runToStop(run)).toBe(APPROVER_STOP_LIVE)
      // The second lap read a live row: nothing more was read or typed.
      expect(calls.statusCalls).toEqual([{ claude_instance_id: who.id }, { claude_instance_id: who.id }])
      expect(calls.readPaneCalls).toHaveLength(1)
      expect(calls.sendKeysCalls).toHaveLength(1)
      expect(approverLines()).toEqual([])
      expect(startupEntries()).toEqual([])
    },
  )

  test('no needle: no send-keys; the next lap reads the pane again', async () => {
    installStub([PENDING_ROW, PENDING_ROW, LIVE_ROW], { readPaneResults: [CLEAR_PANE] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toHaveLength(3)
    expect(calls.readPaneCalls).toEqual([expectedReadPane(PLAIN.id), expectedReadPane(PLAIN.id)])
    expect(calls.sendKeysCalls).toEqual([])
  })

  test('sticky needle: Enter is pressed again at each lap while the row stays pending', async () => {
    installStub([PENDING_ROW, PENDING_ROW, PENDING_ROW, LIVE_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(calls.readPaneCalls).toHaveLength(3)
    expect(calls.sendKeysCalls).toEqual([expectedEnter(PLAIN.id), expectedEnter(PLAIN.id), expectedEnter(PLAIN.id)])
  })

  test('resumed row reading pending (HO C5): both dialogs are cleared through readPane and sendKeys alone, and no tmux call is made', async () => {
    // A resumed launch reads `pending` with this launch's start until it
    // reports in; a `status` result shows no `started_at`, so the lap is the
    // same as after a fresh spawn. Folder-trust then dev-channels.
    const resumedRow = cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE })
    installStub([resumedRow, resumedRow, LIVE_ROW], {
      readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE), dialogPane(DEV_CHANNELS_DIALOG_NEEDLE)],
    })

    expect(await approve(NAMED, false)).toBe(APPROVER_STOP_LIVE)

    expect(calls.readPaneCalls).toEqual([expectedReadPane(NAMED.id), expectedReadPane(NAMED.id)])
    expect(calls.sendKeysCalls).toEqual([expectedEnter(NAMED.id), expectedEnter(NAMED.id)])
    expect(tmuxCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Live, finished and absent rows
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: the stops on a row state (b.jg5 SRJ-402)', () => {
  /** [when, the status answers before the stopping one]. */
  const WHEN: ReadonlyArray<readonly [string, readonly Phase1StatusResult[]]> = [
    ['at the first lap', []],
    ['after a pending lap', [PENDING_ROW]],
  ]

  const LIVE_ROWS = LIVE_STATES_BUT_PENDING.flatMap((state) => WHEN.map(([when, before]) => [state, when, before] as const))

  test.each(LIVE_ROWS)('live state %s read %s: the approver ends (live) with no read-pane at that lap', async (state, _when, before) => {
    installStub([...before, cannedStatusResult({ state })], { readPaneResults: [CLEAR_PANE] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toHaveLength(before.length + 1)
    // Only the earlier pending lap, if any, read the pane.
    expect(calls.readPaneCalls).toHaveLength(before.length)
    expect(calls.sendKeysCalls).toEqual([])
    expect(approverLines()).toEqual([])
    expect(startupEntries()).toEqual([])
  })

  const FINISHED_ROWS = [...AGENT_DIRECTOR_DEAD_STATES].flatMap((state) =>
    WHEN.flatMap(([when, before]) => [true, false].map((isStartup) => [state, when, isStartup, before] as const)),
  )

  test.each(FINISHED_ROWS)(
    '%s read %s (isStartup %s): stops at that lap (finished), no read-pane, send-keys or tmux call there, one log line, the spawn-died entry only for a start-pass launch, written at once',
    async (state, _when, isStartup, before) => {
      installStub([...before, cannedStatusResult({ state }), PENDING_ROW], { readPaneResults: [CLEAR_PANE] })

      expect(await approve(NAMED, isStartup)).toBe(APPROVER_STOP_FINISHED)

      // Stopped at the lap that read it: no further lap, no timer fired after it.
      expect(statusAt).toHaveLength(before.length + 1)
      expect(clock.now()).toBe(statusAt[statusAt.length - 1]!)
      expect(clock.firedCount()).toBe(before.length)
      expect(calls.readPaneCalls).toHaveLength(before.length)
      expect(calls.sendKeysCalls).toEqual([])
      expect(tmuxCalls).toEqual([])
      const message = approverFinishedMessage(NAMED.ref, state)
      expect(approverLines()).toEqual([approverLogLine(message)])
      expect(startupEntries()).toEqual(isStartup ? [{ label: STARTUP_ERROR_APPROVE_SPAWN_DIED, message }] : [])
    },
  )

  test('absent row (status answers ErrSpawnNotFound): stops (absent) with no pane read, one log line and no startup-errors entry', async () => {
    installStub([errSpawnNotFound(), PENDING_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_ABSENT)

    expect(statusAt).toHaveLength(1)
    expect(calls.readPaneCalls).toEqual([])
    expect(calls.sendKeysCalls).toEqual([])
    expect(approverLines()).toEqual([approverLogLine(approverAbsentMessage(PLAIN.ref))])
    expect(startupEntries()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A pending row with no launch start (b.jg5 SRJ-401, SRJ-402, SRJ-513)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: a pending row with no launch start is never read or typed into', () => {
  const noLaunchStartRow = (form: (typeof NO_LAUNCH_START_FORM_NAMES)[number]) =>
    cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: NO_LAUNCH_START_FORMS[form] })

  test.each([...NO_LAUNCH_START_FORM_NAMES])(
    'launch start %s, latch and configured-persona query installed: P latches with "launch start not recorded" (latched); no read-pane or send-keys follows',
    async (form) => {
      const latchLines: string[] = []
      const latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
      setConflictLatch(latch)
      setConfiguredPersonaQuery((key) => key === NAMED.key)
      installStub([noLaunchStartRow(form), PENDING_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

      expect(await approve(NAMED, true)).toBe(APPROVER_STOP_LATCHED)

      expect(latch.record(NAMED.key)).toEqual(launchStartRecord(NAMED.key))
      expect(statusAt).toHaveLength(1)
      expect(calls.readPaneCalls).toEqual([])
      expect(calls.sendKeysCalls).toEqual([])
      expect(approverLines()).toEqual([
        `[slack] ${APPROVER_LOG_SITE}: ${APPROVER_STATUS_READ_WHAT} for ${NAMED.ref}: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${describeLatchRowState(latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE))}) — the persona latched; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
      ])
      expect(startupEntries()).toEqual([])
      assertNoLeak(latchLines)
    },
  )

  test.each([...NO_LAUNCH_START_FORM_NAMES])(
    'launch start %s, neither latch nor query installed: stops (no-launch-start) with one log line and nothing read or typed',
    async (form) => {
      installStub([noLaunchStartRow(form), PENDING_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

      expect(await approve(NAMED, true)).toBe(APPROVER_STOP_NO_LAUNCH_START)

      expect(statusAt).toHaveLength(1)
      expect(calls.readPaneCalls).toEqual([])
      expect(calls.sendKeysCalls).toEqual([])
      expect(approverLines()).toEqual([approverLogLine(approverNoLaunchStartMessage(NAMED.ref))])
      expect(startupEntries()).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// Interim error handling and the cap (until T3)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: a failed call or an unknown state is logged once for its lap, redacted, and polling goes on', () => {
  /** [label, status answers, stub knobs, the one expected line given the error, expected send-keys count]. */
  type ErrorRow = readonly [
    string,
    () => { answers: Array<Phase1StatusResult | Error>; knobs: Omit<StubClientOptions, keyof StubCallLog | 'statusFn'>; line: string; sendKeys: number },
  ]
  const UNKNOWN_STATE = 'not-a-row-state'
  const ROWS: readonly ErrorRow[] = [
    ['status refused', () => {
      const err = leakyAdError('status')
      return { answers: [err, LIVE_ROW], knobs: {}, line: approverStatusRefusedMessage(PLAIN.ref, describeAgentDirectorFailure(err)), sendKeys: 0 }
    }],
    ['read-pane fails', () => {
      const err = leakyAdError('read-pane')
      return {
        answers: [PENDING_ROW, LIVE_ROW],
        knobs: { readPaneQueue: [cannedErr(err)] },
        line: approverPaneCallFailedMessage(PLAIN.ref, 'read-pane', describeAgentDirectorFailure(err)),
        sendKeys: 0,
      }
    }],
    ['send-keys fails', () => {
      const err = leakyAdError('send-keys')
      return {
        answers: [PENDING_ROW, LIVE_ROW],
        knobs: { readPaneResults: [dialogPane(DEV_CHANNELS_DIALOG_NEEDLE)], sendKeysQueue: [cannedErr(err)] },
        line: approverPaneCallFailedMessage(PLAIN.ref, 'send-keys', describeAgentDirectorFailure(err)),
        sendKeys: 1,
      }
    }],
  ]

  test.each(ROWS)('%s: one redacted line for that lap; the next lap reads a live row (live)', async (_label, build) => {
    const { answers, knobs, line, sendKeys } = build()
    installStub(answers, knobs)

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toHaveLength(2)
    expect(calls.sendKeysCalls).toHaveLength(sendKeys)
    expect(approverLines()).toEqual([approverLogLine(line)])
    expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(startupEntries()).toEqual([])
  })

  test('a state neither pending, live nor finished: one line, no pane read; the next lap reads a live row (live)', async () => {
    installStub([cannedStatusResult({ state: UNKNOWN_STATE }), LIVE_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toHaveLength(2)
    expect(calls.readPaneCalls).toEqual([])
    expect(approverLines()).toEqual([approverLogLine(approverUnknownStateMessage(PLAIN.ref, UNKNOWN_STATE))])
  })
})

describe('approvePreSessionDialogs: the cap (interim, measured from the approver\'s start)', () => {
  test('a row that stays pending with no needle: stops at the cap exactly (cap), one log line and dev-channels-approve-not-ready naming the reference', async () => {
    const capMs = 1_000
    _setDialogReadyTimeoutMs(capMs)
    installStub([PENDING_ROW], { readPaneResults: [CLEAR_PANE] })
    const run = startApprover(NAMED, true)

    expect(await runToStop(run, 10_000)).toBe(APPROVER_STOP_CAP)

    expect(clock.now()).toBe(capMs)
    expect(statusAt.every((t) => t < capMs)).toBe(true)
    expect(calls.sendKeysCalls).toEqual([])
    const message = approverCapMessage(NAMED.ref, capMs)
    expect(approverLines()).toEqual([approverLogLine(message)])
    expect(startupEntries()).toEqual([{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }])
  })
})

// ---------------------------------------------------------------------------
// The approver registry (b.jg5 SRJ-401, SRJ-404; hatch A2)
// ---------------------------------------------------------------------------

/** The verbs the approver calls, as the event list names them. */
type ApproverVerb = 'status' | 'read-pane' | 'send-keys'

/** A gate holding one call open until the case releases it. */
interface CallHold {
  /** True once the held call has started and is waiting on the gate. */
  reached: boolean
  release(): void
}

/** A promise's value once it has settled, read without awaiting. */
interface Tracked<T> {
  readonly settled: boolean
  readonly value: T | undefined
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const t = { settled: false, value: undefined as T | undefined }
  void promise.then((value) => {
    t.value = value
    t.settled = true
  })
  return t
}

/** The launch start the stub's default `pending` row carries, and a newer launch's. */
const LAUNCH_START_MS = parseLaunchStart(SAMPLE_LAUNCH_START_DEFAULT)!
const NEWER_PENDING_ROW = cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_WHOLE })

describe('the approver registry: start, stop, stop-all and the running query (b.jg5 SRJ-401, SRJ-404; hatch A2)', () => {
  /** Every call's start (`<verb> <instance id>`) and every marker a case adds, in order. */
  let events: string[]
  /** Status answers per instance id, the last sticking. */
  let rows: Map<string, Array<Phase1StatusResult | Error>>
  /** The pane per instance id (no dialog unless set). */
  let panes: Map<string, { pane: string }>
  /** One-shot failures per `<verb> <instance id>`. */
  let failures: Map<string, Error>
  let holds: Map<string, CallHold>
  let allHolds: CallHold[]
  /** Calls in progress per instance id, and the most seen at once. */
  let active: Map<string, number>
  let maxActive: Map<string, number>
  /** For each call: whether it ran inside a launch or recovery attempt for its persona. */
  let insideAttempt: boolean[]

  const keyOfId = new Map(PERSONAS.map((p) => [p.id, p.key]))
  const call = (verb: ApproverVerb, id: string): string => `${verb} ${id}`

  beforeEach(() => {
    _resetDialogApprovers()
    events = []
    rows = new Map()
    panes = new Map()
    failures = new Map()
    holds = new Map()
    allHolds = []
    active = new Map()
    maxActive = new Map()
    insideAttempt = []
    const stub = makeStubClient({})
    const wrap = <R>(verb: ApproverVerb, answer: (id: string) => R) => async (params: { claude_instance_id: string }): Promise<R> => {
      const id = params.claude_instance_id
      const name = call(verb, id)
      events.push(name)
      insideAttempt.push(isInsideAttempt(keyOfId.get(id) ?? id))
      const now = (active.get(id) ?? 0) + 1
      active.set(id, now)
      maxActive.set(id, Math.max(maxActive.get(id) ?? 0, now))
      try {
        const hold = holds.get(name)
        if (hold !== undefined) {
          holds.delete(name)
          hold.reached = true
          await new Promise<void>((resolve) => {
            hold.release = resolve
          })
        }
        const failure = failures.get(name)
        if (failure !== undefined) {
          failures.delete(name)
          throw failure
        }
        return answer(id)
      } finally {
        active.set(id, active.get(id)! - 1)
      }
    }
    Object.assign(stub, {
      status: wrap('status', (id) => {
        const answers = rows.get(id)
        if (answers === undefined || answers.length === 0) throw new Error(`no status answer set for ${id}`)
        const answer = answers.length > 1 ? answers.shift()! : answers[0]!
        if (answer instanceof Error) throw answer
        return answer
      }),
      readPane: wrap('read-pane', (id) => panes.get(id) ?? CLEAR_PANE),
      sendKeys: wrap('send-keys', () => ({})),
    })
    setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  })

  afterEach(async () => {
    for (const hold of allHolds) hold.release()
    await clock.flush()
    const stillRunning = PERSONAS.filter((p) => isDialogApproverRunning(p.key)).map((p) => p.label)
    _resetDialogApprovers()
    await clock.flush()
    expect(stillRunning).toEqual([])
  })

  /** Hold the next `verb` call for persona `who` open until released (the held call sets `release`). */
  function holdNext(verb: ApproverVerb, who: ApproverPersona): CallHold {
    const hold: CallHold = { reached: false, release: () => {} }
    holds.set(call(verb, who.id), hold)
    allHolds.push(hold)
    return hold
  }

  /** The events after index `from` that are calls for `who`. */
  const callsOf = (who: ApproverPersona, from = 0): string[] => events.slice(from).filter((e) => e.endsWith(` ${who.id}`))
  const lap = (who: ApproverPersona, ...verbs: ApproverVerb[]): string[] => verbs.map((v) => call(v, who.id))
  const sendKeysCount = (who: ApproverPersona): number => events.filter((e) => e === call('send-keys', who.id)).length

  /** Fire timers until `who`'s approver has stopped; answers its outcome. */
  async function runUntilStopped(who: ApproverPersona, maxTimers = 20): Promise<ApproverOutcome | undefined> {
    for (let fired = 0; ; fired++) {
      await clock.flush()
      if (!isDialogApproverRunning(who.key)) return _whenDialogApproverStopped(who.key)
      if (fired >= maxTimers) throw new Error(`the approver did not stop within ${maxTimers} timers`)
      await clock.runNext()
    }
  }

  test('the start entry returns before the first status; the running query is true while it runs and false once it stops', async () => {
    rows.set(PLAIN.id, [PENDING_ROW, LIVE_ROW])

    expect(startDialogApprover(PLAIN.key, true, PLAIN.ref)).toBe(true)
    expect(events).toEqual([])
    expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
    expect(dialogApproverLaunchStart(PLAIN.key)).toBeUndefined()

    await clock.flush()
    expect(events).toEqual(lap(PLAIN, 'status', 'read-pane'))
    expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
    expect(dialogApproverLaunchStart(PLAIN.key)).toBe(LAUNCH_START_MS)

    expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(dialogApproverLaunchStart(PLAIN.key)).toBeUndefined()
    expect(approverLines()).toEqual([])
  })

  test('a stop between laps ends P\'s approver at once with no further call; Q\'s goes on; a second stop and a stop of a key with no approver answer false and log nothing', async () => {
    rows.set(PLAIN.id, [PENDING_ROW])
    rows.set(NAMED.id, [PENDING_ROW])
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    startDialogApprover(NAMED.key, true, NAMED.ref)
    await clock.flush()
    expect(callsOf(PLAIN)).toEqual(lap(PLAIN, 'status', 'read-pane'))
    const at = clock.now()
    const fired = clock.firedCount()

    expect(await stopDialogApprover(PLAIN.key, 'teardown')).toBe(true)

    // Ended during its sleep: no timer fired and no time passed.
    expect(clock.now()).toBe(at)
    expect(clock.firedCount()).toBe(fired)
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(isDialogApproverRunning(NAMED.key)).toBe(true)
    expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason: APPROVER_STOP_TEARDOWN, launchStartMs: LAUNCH_START_MS })
    const stopLine = approverLogLine(approverStopRequestedMessage(PLAIN.ref, 'teardown'))
    expect(approverLines()).toEqual([stopLine])

    expect(await stopDialogApprover(PLAIN.key, 'teardown')).toBe(false)
    expect(await stopDialogApprover(personaKey('never-started'), 'teardown')).toBe(false)
    expect(approverLines()).toEqual([stopLine])

    // Q's next lap runs; P makes no call.
    const mark = events.length
    await clock.runNext()
    expect(events.slice(mark)).toEqual(lap(NAMED, 'status', 'read-pane'))

    rows.set(NAMED.id, [LIVE_ROW])
    expect(await runUntilStopped(NAMED)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
    expect(callsOf(PLAIN)).toEqual(lap(PLAIN, 'status', 'read-pane'))
  })

  /** [the call held open, the calls of the lap up to and including it]. */
  const HELD: ReadonlyArray<readonly [ApproverVerb, readonly ApproverVerb[]]> = [
    ['status', ['status']],
    ['read-pane', ['status', 'read-pane']],
    ['send-keys', ['status', 'read-pane', 'send-keys']],
  ]

  test.each(HELD)(
    'a stop while its %s is in progress (row pending, the pane showing a needle): resolves only after that call returns, and no call follows it',
    async (verb, upTo) => {
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const hold = holdNext(verb, PLAIN)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)

      const stop = track(stopDialogApprover(PLAIN.key, 'teardown'))
      await clock.flush()
      expect(stop.settled).toBe(false)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)

      hold.release()
      await clock.flush()
      expect(stop.value).toBe(true)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
      expect(events).toEqual(lap(PLAIN, ...upTo))
      expect(clock.pending()).toEqual([])
      expect((await _whenDialogApproverStopped(PLAIN.key))?.reason).toBe(APPROVER_STOP_TEARDOWN)
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, 'teardown'))])
    },
  )

  /**
   * Where the first approver is when a second start for P comes: before its
   * first call; asleep between laps (its lap read a pane with no dialog,
   * which shows from then on); in a `read-pane` that shows the dialog.
   * [where, the launch start the first approver kept].
   */
  const SUPERSEDED_AT: ReadonlyArray<readonly [string, number | undefined]> = [
    ['before its first call', undefined],
    ['asleep between laps', LAUNCH_START_MS],
    ['in a read-pane showing a needle', LAUNCH_START_MS],
  ]

  test.each(SUPERSEDED_AT)(
    'a second start for P with the first approver %s: the first stops (superseded) before the second\'s first call, never two approvers work at once, and one Enter is sent for the one dialog',
    async (where, keptByFirst) => {
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, where === 'asleep between laps' ? CLEAR_PANE : dialogPane(DEV_CHANNELS_DIALOG_NEEDLE))
      const hold = where === 'in a read-pane showing a needle' ? holdNext('read-pane', PLAIN) : undefined
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      if (where !== 'before its first call') await clock.flush()
      if (where === 'asleep between laps') panes.set(PLAIN.id, dialogPane(DEV_CHANNELS_DIALOG_NEEDLE))
      if (hold !== undefined) expect(hold.reached).toBe(true)
      const firstCalls = events.length
      const first = _whenDialogApproverStopped(PLAIN.key)
      void first.then(() => events.push('first stopped'))

      expect(startDialogApprover(PLAIN.key, true, PLAIN.ref)).toBe(true)
      await clock.flush()
      if (hold !== undefined) {
        // The first's read-pane is still in progress: nothing has started since.
        expect(events.length).toBe(firstCalls)
        expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
        hold.release()
        await clock.flush()
      }

      expect(await first).toEqual({ reason: APPROVER_STOP_SUPERSEDED, launchStartMs: keptByFirst })
      // Every call after the second start comes after the first's stop.
      expect(events.slice(firstCalls)).toEqual(['first stopped', ...lap(PLAIN, 'status', 'read-pane', 'send-keys')])
      expect(sendKeysCount(PLAIN)).toBe(1)
      expect(maxActive.get(PLAIN.id)).toBe(1)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, 'superseded'))])

      rows.set(PLAIN.id, [LIVE_ROW])
      expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
      expect(sendKeysCount(PLAIN)).toBe(1)
    },
  )

  test('a lap that reads a launch start other than the one kept stops it (superseded) with no read-pane or send-keys', async () => {
    rows.set(PLAIN.id, [PENDING_ROW])
    panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    await clock.flush()
    expect(events).toEqual(lap(PLAIN, 'status', 'read-pane', 'send-keys'))

    // A newer launch of P between laps.
    rows.set(PLAIN.id, [NEWER_PENDING_ROW])
    expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_SUPERSEDED, launchStartMs: LAUNCH_START_MS })

    expect(events).toEqual([...lap(PLAIN, 'status', 'read-pane', 'send-keys'), call('status', PLAIN.id)])
    expect(approverLines()).toEqual([approverLogLine(approverLaunchStartChangedMessage(PLAIN.ref))])
  })

  test.each(unavailableForms('ErrTmuxUnresponsive', 'ErrCallTimeout'))(
    'a first lap whose status answers UNAVAILABLE (%s) keeps no launch start: the next lap reads pending with a launch start, does not stop, and reads the pane',
    async (_label, make) => {
      const err = make('status')
      rows.set(PLAIN.id, [err, PENDING_ROW, LIVE_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(events).toEqual(lap(PLAIN, 'status'))
      expect(dialogApproverLaunchStart(PLAIN.key)).toBeUndefined()

      await clock.runNext()
      expect(events).toEqual(lap(PLAIN, 'status', 'status', 'read-pane', 'send-keys'))
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
      expect(dialogApproverLaunchStart(PLAIN.key)).toBe(LAUNCH_START_MS)

      expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
      expect(approverLines()).toEqual([approverLogLine(approverStatusRefusedMessage(PLAIN.ref, describeAgentDirectorFailure(err)))])
    },
  )

  test('two personas are independent: a second start for Q stops only Q\'s approver', async () => {
    rows.set(PLAIN.id, [PENDING_ROW])
    rows.set(NAMED.id, [PENDING_ROW])
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    startDialogApprover(NAMED.key, true, NAMED.ref)
    await clock.flush()
    const plainFirst = track(_whenDialogApproverStopped(PLAIN.key))
    const namedFirst = _whenDialogApproverStopped(NAMED.key)

    startDialogApprover(NAMED.key, true, NAMED.ref)
    expect((await namedFirst)?.reason).toBe(APPROVER_STOP_SUPERSEDED)
    await clock.flush()
    expect(plainFirst.settled).toBe(false)
    expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
    expect(isDialogApproverRunning(NAMED.key)).toBe(true)
    expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(NAMED.ref, 'superseded'))])

    rows.set(PLAIN.id, [LIVE_ROW])
    rows.set(NAMED.id, [LIVE_ROW])
    expect((await runUntilStopped(PLAIN))?.reason).toBe(APPROVER_STOP_LIVE)
    expect((await runUntilStopped(NAMED))?.reason).toBe(APPROVER_STOP_LIVE)
  })

  test('stop-all stops every approver (one asleep, one in a read-pane showing a needle) with no Enter, leaves no timer pending, and no approver starts after it', async () => {
    rows.set(PLAIN.id, [PENDING_ROW])
    rows.set(NAMED.id, [PENDING_ROW])
    panes.set(NAMED.id, dialogPane(TRUST_DIALOG_NEEDLE))
    const hold = holdNext('read-pane', NAMED)
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    startDialogApprover(NAMED.key, true, NAMED.ref)
    await clock.flush()
    expect(hold.reached).toBe(true)

    const all = track(stopAllDialogApprovers())
    await clock.flush()
    expect(all.settled).toBe(false)
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(isDialogApproverRunning(NAMED.key)).toBe(true)

    hold.release()
    await clock.flush()
    expect(all.settled).toBe(true)
    expect(PERSONAS.filter((p) => isDialogApproverRunning(p.key))).toEqual([])
    expect(clock.pending()).toEqual([])
    expect(sendKeysCount(NAMED)).toBe(0)
    expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason: APPROVER_STOP_SHUTDOWN, launchStartMs: LAUNCH_START_MS })
    expect(await _whenDialogApproverStopped(NAMED.key)).toEqual({ reason: APPROVER_STOP_SHUTDOWN, launchStartMs: LAUNCH_START_MS })
    const stopLines = PERSONAS.map((p) => approverLogLine(approverStopRequestedMessage(p.ref, 'shutdown')))
    expect([...approverLines()].sort()).toEqual([...stopLines].sort())

    const callsBefore = events.length
    expect(startDialogApprover(PLAIN.key, true, PLAIN.ref)).toBe(false)
    await clock.flush()
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(events.length).toBe(callsBefore)
    expect(clock.pending()).toEqual([])
    expect(approverLines().slice(stopLines.length)).toEqual([approverLogLine(approverNotStartedMessage(PLAIN.ref, 'shutdown'))])
  })

  test('its calls run outside P\'s launch attempt: none sees the attempt, and a failed send-keys records nothing on it', async () => {
    rows.set(PLAIN.id, [PENDING_ROW, LIVE_ROW])
    panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
    const err = unavailableForms('ErrTmuxUnresponsive')[0]![1]('send-keys')
    failures.set(call('send-keys', PLAIN.id), err)
    let startedInside: boolean | undefined
    let endAttempt!: () => void

    // The attempt stays open while the approver's first lap runs.
    const attempt = runInAttempt(PLAIN.key, 'launch', async (view) => {
      startedInside = isInsideAttempt(PLAIN.key)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await new Promise<void>((resolve) => {
        endAttempt = resolve
      })
      return view.lastError
    })
    await clock.flush()

    expect(startedInside).toBe(true)
    expect(events).toEqual(lap(PLAIN, 'status', 'read-pane', 'send-keys'))
    expect(insideAttempt).toEqual([false, false, false])
    endAttempt()
    expect(await attempt).toBeUndefined()

    expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
    expect(approverLines()).toEqual([approverLogLine(approverPaneCallFailedMessage(PLAIN.ref, 'send-keys', describeAgentDirectorFailure(err)))])
  })

  /** [the reason, the status answers, the launch start kept, optional setup]. */
  const OWN_STOPS: ReadonlyArray<
    readonly [ApproverStopReason, () => Array<Phase1StatusResult | Error>, number | undefined, (() => void) | undefined]
  > = [
    [APPROVER_STOP_LIVE, () => [PENDING_ROW, LIVE_ROW], LAUNCH_START_MS, undefined],
    [APPROVER_STOP_FINISHED, () => [cannedStatusResult({ state: [...AGENT_DIRECTOR_DEAD_STATES][0]! })], undefined, undefined],
    [APPROVER_STOP_ABSENT, () => [errSpawnNotFound()], undefined, undefined],
    [
      APPROVER_STOP_NO_LAUNCH_START,
      () => [cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: NO_LAUNCH_START_FORMS[NO_LAUNCH_START_FORM_NAMES[0]] })],
      undefined,
      undefined,
    ],
    [
      APPROVER_STOP_LATCHED,
      () => [cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: NO_LAUNCH_START_FORMS[NO_LAUNCH_START_FORM_NAMES[0]] })],
      undefined,
      () => {
        setConflictLatch(createConflictLatch({ log: () => {} }))
        setConfiguredPersonaQuery((key) => key === PLAIN.key)
      },
    ],
    [APPROVER_STOP_CAP, () => [PENDING_ROW], LAUNCH_START_MS, () => _setDialogReadyTimeoutMs(1_000)],
  ]

  test.each(OWN_STOPS)('the await seam reports a registered approver\'s own stop (%s) with the launch start it kept', async (reason, answers, kept, setup) => {
    setup?.()
    rows.set(PLAIN.id, answers())
    startDialogApprover(PLAIN.key, false, PLAIN.ref)

    expect(await runUntilStopped(PLAIN)).toEqual({ reason, launchStartMs: kept })
    expect(sendKeysCount(PLAIN)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Focused source audit (SRJ-601's approver part)
// ---------------------------------------------------------------------------

describe('source audit: the approver\'s raw tmux path, its seams and the dead-state streak are gone (b.jg5 SRJ-402, SRJ-601)', () => {
  const SRC_DIR = join(import.meta.dir, '..', 'src')
  const REMOVED = [
    'defaultTmuxCapturePane',
    'defaultTmuxSendEnter',
    '_setTmuxCapturePane',
    '_setTmuxSendEnter',
    '_resetTmuxDialogHelpers',
    'tmuxExactPaneTarget',
    'DIALOG_DEAD_GRACE_POLLS',
    '_setDialogDeadGracePolls',
    '_resetDialogDeadGracePolls',
    'DIALOG_READY_STATES',
    'DIALOG_DEAD_STATES',
  ]
  const sources = (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => [name, stripComments(readFileSync(join(SRC_DIR, name), 'utf-8'))] as const)

  test('the audit reads the approver\'s module', () => {
    expect(sources.map(([name]) => name)).toContain('session-manager.ts')
  })

  test.each(REMOVED)('no file in src/ names %s outside a comment', (name) => {
    const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`)
    expect(sources.filter(([, code]) => re.test(code)).map(([file]) => file)).toEqual([])
  })
})
