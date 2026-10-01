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
  approverLogLine,
  approverNoLaunchStartMessage,
  approverPaneCallFailedMessage,
  approverStatusRefusedMessage,
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
  DEV_CHANNELS_DIALOG_NEEDLE,
  STARTUP_ERROR_APPROVE_NOT_READY,
  STARTUP_ERROR_APPROVE_SPAWN_DIED,
  TRUST_DIALOG_NEEDLE,
  _resetApproverClock,
  _resetConfiguredPersonaQuery,
  _resetDialogReadyTimeoutMs,
  _resetTmuxCommandRunner,
  _setApproverClock,
  _setDialogReadyTimeoutMs,
  _setTmuxCommandRunner,
  setConfiguredPersonaQuery,
  setConflictLatch,
  type ApproverStopReason,
} from '../src/session-manager.ts'
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
  SAMPLE_LAUNCH_START_WHOLE,
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
