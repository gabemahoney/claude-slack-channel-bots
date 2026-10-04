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
 * reason the approver resolves with. A launch start that does not parse
 * throws nothing (no `RangeError` from arming B): the approver stops with its
 * one line.
 *
 * The pace (b.jg5 SRJ-403, AC 80): pane reads are `DIALOG_POLL_INTERVAL_MS`
 * apart until G past the launch start and `DIALOG_SLOW_POLL_INTERVAL_MS`
 * apart from G on, for both launch-start forms (fractional and whole), at
 * the default G and at a G of 120 s, on a resumed row whose `started_at` is
 * older (never read), the switch coming at G from the launch start
 * (b.jg5 SRJ-406); an approver that starts more
 * than G after the launch start keeps the slow pace from its first lap; a G
 * beyond the timer maximum keeps the fast pace and throws nothing. The pace
 * runs from the previous lap's `read-pane` call: with the stub's `status`
 * answering on a fake-clock timer, a `status` read longer than the pace, or
 * just under it, at the first or a later lap, before or past G, never brings
 * two pane reads closer than the pace in effect; a lap that read no pane (an
 * unknown state) is paced from its own start.
 *
 * B (b.jg5 SRJ-404, SRJ-210, SRJ-406): the approver stops exactly at the
 * launch start plus B (`adLaunchBoundMsInEffect()`), for both launch-start
 * forms and for a G that moves B above its floor; before any lap reads a
 * launch start it is measured from the approver's own start and then follows
 * the launch start a lap reads; a G raised while it runs moves the stop
 * (never early); the one case beyond the timer maximum (E6's hatch note) runs
 * past the moment a plain timer would have fired with no pending timer
 * asking more than `MAX_TIMER_DELAY_MS`. At B (SRJ-405): one line, the
 * not-ready entry for a start-pass launch only, and no notice through a
 * recording session notifier, the outage notify sink or the real persona
 * notifier. The test cap (`_setDialogReadyTimeoutMs`) stops it that long
 * after its own start, in place of B; B's cases leave it unset. Non-default
 * settings are written with `writeAgentDirectorConfig` under a temp HOME and
 * read by an installed reader (`installAdSettings`); `afterEach` resets it.
 *
 * Classes (b.jg5 SRJ-117, SRJ-118, SRJ-404): one case per cell for `status`,
 * `read-pane` and `send-keys` (the Enter column, a needle on screen), each
 * error built by the stub: GONE and `ErrSpawnNotFound` from a pane verb stop
 * (`gone`); `ErrSpawnNotInteractive`, both variants, stops with nothing typed,
 * no kill and one line; ENVIRONMENT stops (`tmux-unavailable`) and raises the
 * outage, arming P's retry timer, uncounted; UNAVAILABLE and CONFIG keep
 * polling, the next lap at the slow pace and the pace in effect after a
 * clean lap (CONFIG raising `ad-config-malformed` and arming P's retry
 * timer); UNCLASSIFIED keeps polling at the pace in effect; each keeps
 * polling until B; CONFLICT and UNUSABLE NAME latch P over the shared
 * case-table rows (`APPROVER_CONFLICT_CASE_ROWS`,
 * `APPROVER_UNUSABLE_NAME_CASE_ROWS`) with nothing typed. `afterEach` asserts
 * that no answer of the approver armed a retry timer but for ENVIRONMENT and
 * CONFIG, started a `tmux-unresponsive` condition or reached the
 * unclassified sink, and that no session notice was sent (hatch A2).
 *
 * The not-interactive record (b.jg5 SRJ-118, SRJ-412, SRJ-1017): the
 * approver's `send-keys` answering `ErrSpawnNotInteractive` (both variants),
 * at the first lap or a later one, records the launch start the first lap
 * kept, for both launch-start forms, and the record
 * (`launchMetSendKeysNotInteractive`) answers yes for that launch start as
 * raw text, parsed instant or a numeric offset naming it, and no for another
 * instant, none, or the other persona; a stop asked during that `send-keys`
 * still leaves it set (the answer counts, not the stop). A `read-pane` or
 * `status` answer of that name, an approver that never read a launch start,
 * and every other stop (live, finished, absent, superseded, gone,
 * `tmux-unavailable`, latched, the cap, and an UNAVAILABLE answer that polls
 * on) record nothing. `afterEach` forgets both personas' records
 * (`forgetLaunchCalls`).
 *
 * The record of CSCB's own launch (b.jg5 SRJ-412, SRJ-401): the approver's
 * first lap that keeps a launch start is its input. Its record needs a launch
 * call's window, so these cases run on the recovery harness (`harnessNow`,
 * the approver stopping at B) over P's pending-row model, launched through
 * the real launch path: a first lap whose `status` fails records nothing and
 * the next lap that reads the row `pending` records it; a later lap reading
 * another launch start stops the approver superseded and leaves the record
 * as it was, past the stop. Where the record is set, replaced and forgotten
 * is tests/session-manager.test.ts's.
 *
 * The registry (b.jg5 SRJ-401, SRJ-404; hatch A2) is driven through its
 * entries (`startDialogApprover`, `stopDialogApprover`,
 * `stopAllDialogApprovers`, `isDialogApproverRunning`,
 * `dialogApproverLaunchStart`) and its await seam
 * (`_whenDialogApproverStopped`): at most one approver per persona, a stop
 * that completes after the call in progress returns and types nothing after
 * it (asked with the teardown's reason, with the retired-key reason apply
 * step 1 stops a recorded key's approver with, b.jg5 SRJ-808, whose recorded
 * calls end at that stop, and with the stuck-launch abort's reason, b.jg5
 * SRJ-412, whose kill follows the stop), the launch start a running approver keeps, stop-all, and calls made
 * outside every launch attempt, and the latch (b.jg5 SRJ-502): a latch of P
 * set by another site through the installed latch stops P's approver (its
 * calls end at the latch) and a latch of another persona does not; with a
 * latch that has no set observer, P latched before a lap, or while its
 * `status` or `read-pane` is awaited, gets no further call. The start entry's
 * launch-timeout origin (b.jg5 SRJ-401, SRJ-407): an approver started after
 * a launch timeout whose `get` read P's row covered logs one line and then
 * stops under every SRJ-404 rule exactly as one started after a returned
 * launch (each rule run from both origins: a live, finished or absent row,
 * another launch start, a later launch's approver, each class, the test cap
 * and B from the launch start); a row not covered, undecided or with no
 * launch start gets no approver, no call and one line, and leaves an
 * approver already running alone. Its cases hold a
 * chosen call of a chosen persona open with a gate and record every call's
 * start in one ordered event list.
 *
 * The pending-row rule's one run at the approver's stop (b.jg5 SRJ-404,
 * SRJ-410; ruling R3), with the rule installed as `main()` installs it and a
 * serializer that holds each turn until the case runs it: one case per typed
 * stop reason (a table keyed by the reason type), each driven through the
 * registry. Its hand-written run column must agree with the arm's export
 * (`approverStopArmsPendingRow`) and with what happened: B or the test cap,
 * GONE, not interactive, tmux unavailable, superseded and a loop that threw
 * (`failed`) each ask one turn for P and, once it runs, make one lap
 * `read-pane` (none after the approver's `send-keys` met
 * `ErrSpawnNotInteractive`), one bypassing `find-missing` and one `get` on
 * the approver's last read, with one answer line, the held post at B, and no
 * kill or launch; live, finished, absent, no launch start, latched,
 * teardown, the retired-key recording (E25: its calls end at the stop),
 * shutdown and the stuck-launch abort's stop (asked through the abort's own
 * stop entry, `stopApproverForStuckLaunchAbort`) ask none and make no call. A stop in the run set whose last read
 * was not `pending` runs nothing; a run before G makes no call; a later stop
 * asks no second run; a run still queued at shutdown is dropped with one
 * line.
 *
 * Time: every case runs on `createFakeClock` through the approver's clock
 * seam (`_setApproverClock`); laps are driven with `runNext`, never a real
 * sleep, and `afterEach` asserts no timer is left pending. A case about B or
 * the pace starts its clock at a sample launch start, so launch starts are
 * built from the clock's time.
 *
 * tmux: a recording tmux runner (`_setTmuxCommandRunner`) is installed for
 * every case and `afterEach` asserts it recorded no call: the server starts no
 * tmux process for the approver.
 *
 * Every captured log line, notice, stub call and the state directory the
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
  approverBoundMessage,
  approverCapMessage,
  approverConflictMessage,
  approverFinishedMessage,
  approverGoneMessage,
  approverLatchedMessage,
  approverLaunchStartChangedMessage,
  approverLogLine,
  approverNoLaunchStartMessage,
  approverNotInteractiveMessage,
  approverNotStartedMessage,
  approverPaneCallFailedMessage,
  approverRefusedRowMessage,
  approverStartedAfterLaunchTimeoutMessage,
  approverStatusRefusedMessage,
  approverStopRequestedMessage,
  approverTmuxUnavailableMessage,
  approverUnknownStateMessage,
  approverUnusableNameMessage,
  APPROVER_BOUND_FROM_APPROVER_START,
  APPROVER_BOUND_FROM_LAUNCH_START,
  APPROVER_LOG_PREFIX,
  APPROVER_LOG_SITE,
  APPROVER_ORIGIN_AFTER_LAUNCH,
  APPROVER_ORIGIN_LAUNCH_TIMEOUT,
  APPROVER_START_AFTER_LAUNCH,
  APPROVER_STATUS_READ_WHAT,
  APPROVER_STOP_ABSENT,
  APPROVER_STOP_BOUND,
  APPROVER_STOP_CAP,
  APPROVER_STOP_FINISHED,
  APPROVER_STOP_GONE,
  APPROVER_STOP_LATCHED,
  APPROVER_STOP_LIVE,
  APPROVER_STOP_NO_LAUNCH_START,
  APPROVER_STOP_NOT_INTERACTIVE,
  APPROVER_STOP_RETIRED_KEY,
  APPROVER_STOP_SHUTDOWN,
  APPROVER_STOP_STUCK_LAUNCH_ABORT,
  APPROVER_STOP_SUPERSEDED,
  APPROVER_STOP_TEARDOWN,
  APPROVER_STOP_TMUX_UNAVAILABLE,
  DEV_CHANNELS_DIALOG_NEEDLE,
  DIALOG_POLL_INTERVAL_MS,
  DIALOG_READY_TIMEOUT_MS,
  DIALOG_SLOW_POLL_INTERVAL_MS,
  dialogApproverLaunchStart,
  forgetLaunchCalls,
  isCscbOwnLaunch,
  isDialogApproverRunning,
  launchCallWindowOf,
  launchMetSendKeysNotInteractive,
  ownLaunchRecordOf,
  setSessionNotifier,
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
  _resetFindMissingMemo,
  _resetNow,
  _resetPendingRowRule,
  _resetTmuxCommandRunner,
  _setApproverClock,
  _setDialogReadyTimeoutMs,
  _setNow,
  _setTmuxCommandRunner,
  _whenDialogApproverStopped,
  APPROVER_STOP_FAILED,
  approverStopArmsPendingRow,
  buildPendingRowRuleDeps,
  pendingRowRuleApproverStopDroppedLine,
  pendingRowRuleApproverStopGatedLine,
  pendingRowRuleApproverStopGateFailedWhy,
  pendingRowRuleApproverStopLine,
  setPendingRowRule,
  setConfiguredPersonaQuery,
  setConflictLatch,
  stopApproverForStuckLaunchAbort,
  type ApproverOutcome,
  type ApproverStart,
  type ApproverStopReason,
  type ApproverVerb,
} from '../src/session-manager.ts'
import {
  parseLaunchStart,
  PENDING_ROW_COVERED,
  PENDING_ROW_NO_LAUNCH_START,
  PENDING_ROW_NOT_COVERED,
  PENDING_ROW_REASON_CONFIG_DIR_MISMATCH,
  PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED,
  PENDING_ROW_REASON_CWD_MISMATCH,
  PENDING_ROW_REASON_CWD_UNRESOLVED,
  PENDING_ROW_REASON_RETIRED_OLD_LIFE,
  PENDING_ROW_UNDECIDED,
  type PendingRowCover,
  createPendingRowRule,
  describeLaunchStartForLog,
  PENDING_ROW_RULE_HELD,
  PENDING_ROW_RULE_LOG_HEAD,
  PENDING_ROW_RULE_ORIGIN_APPROVER_STOP,
  PENDING_ROW_RULE_REFUSAL,
  STUCK_LAUNCH_POSTED,
  stuckLaunchHeldText,
  type PendingRowRuleAnswer,
} from '../src/pending-row.ts'
import { createPersonaEpisodes, type PersonaEpisodes } from '../src/persona-episodes.ts'
import {
  isInsideAttempt,
  runInAttempt,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_STOP_HELD,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  type RetryRunGateDeps,
} from '../src/unavailable-retry.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
} from '../src/liveness-reading.ts'
import {
  CONFLICT_LATCH_SET_LATCHED,
  createConflictLatch,
  describeLatchRowState,
  latchRowStateRead,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  type ConflictLatch,
  type ConflictLatchRecord,
  type ConflictLatchSetEvent,
} from '../src/conflict-latch.ts'
import { describeAgentDirectorFailure } from '../src/ad-error-class.ts'
import type { Phase1StatusResult } from '../src/ad-phase1-types.ts'
import {
  AD_SETTING_INTEGER_MAX,
  AD_WAIT_NEVER_ENDS,
  adGraceMs,
  adGraceMsInEffect,
  adLaunchBoundMsInEffect,
  DEFAULT_AD_SETTINGS,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  installAdSettings,
  resetAdSettingsForTests,
  type AdSettingsReader,
} from '../src/ad-settings.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import { getClient, resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import {
  _resetOutageState,
  adConfigMalformedOnset,
  getOutageFlags,
  initOutageState,
  ONSET_TEMPLATES,
  type OutageClass,
} from '../src/outage-state.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedOk,
  cannedStatusResult,
  errConfigMalformed,
  errGeneric,
  errInternal,
  errSendKeysWhileRelayed,
  errSpawnNotFound,
  errSpawnNotInteractiveLeftover,
  errSpawnNotInteractiveNoLaunchStart,
  errTmuxCaptureFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  makeStubCallLog,
  makeStubClient,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
  unavailableForms,
  type StubCallLog,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  APPROVER_CONFLICT_CASE_ROWS,
  APPROVER_UNUSABLE_NAME_CASE_ROWS,
  CONFLICT_CASE_ROWS,
  expectedLatchRecord,
  isApproverSite,
  launchStartRecord,
  NO_LAUNCH_START_FORM_NAMES,
  NO_LAUNCH_START_FORMS,
  type ConflictCaseRow,
} from './test-helpers/conflict-cases.ts'
import { writeAgentDirectorConfig, type AdConfigTables } from './test-helpers/ad-settings.ts'
import { assertNoLeak, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  makePendingRowModel,
  PENDING_ROW_DIALOG_UNRECOGNISED,
  PENDING_ROW_MODEL_NO_ROW,
  type PendingRowModel,
} from './test-helpers/pending-row-model.ts'
import { launchByAnotherProcess, makeRecoveryHarness, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
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
  readonly name: string
}

function persona(label: string, name: string): ApproverPersona {
  const key = personaKey(name)
  return { label, key, ref: renderPersonaRef(name, key), id: personaInstanceId(key), name }
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

/** The launch start the stub's default `pending` row carries, in epoch ms. */
const LAUNCH_START_MS = parseLaunchStart(SAMPLE_LAUNCH_START_DEFAULT)!

/** The two paces (b.jg5 SRJ-403), short names for the timing arithmetic. */
const FAST = DIALOG_POLL_INTERVAL_MS
const SLOW = DIALOG_SLOW_POLL_INTERVAL_MS

/** Fires enough for an approver that runs to B at the fast pace. */
const MANY_TIMERS = 1_000

/** Milliseconds per second, to write a G from a wait in milliseconds. */
const MS_PER_SECOND = 1000

/** A launch start as agent-director shows it (RFC 3339 UTC, milliseconds), for a time on the case's clock. */
const isoAt = (ms: number): string => new Date(ms).toISOString()

/**
 * A resumed launch's `pending` row: `launchStartedAt`, and a `started_at` at
 * `startedAtMs`, the original spawn's time, which no wait may read (b.jg5
 * SRJ-406).
 */
function resumedRow(launchStartedAt: string, startedAtMs: number): Phase1StatusResult {
  return Object.assign(cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: launchStartedAt }), {
    started_at: isoAt(startedAtMs),
  })
}

/**
 * The lap times SRJ-403's pace gives from `firstMs` until (not including)
 * `endMs`: `DIALOG_POLL_INTERVAL_MS` after a lap before G past
 * `launchStartMs`, `DIALOG_SLOW_POLL_INTERVAL_MS` after a lap from G on.
 */
function paceLapTimes(firstMs: number, launchStartMs: number, graceMs: number, endMs: number): number[] {
  const times: number[] = []
  for (let t = firstMs; t < endMs; t += t - launchStartMs >= graceMs ? SLOW : FAST) times.push(t)
  return times
}

/** `count` times from `firstMs`, `stepMs` apart. */
function evenTimes(firstMs: number, stepMs: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => firstMs + i * stepMs)
}

/** The gaps between consecutive times. */
function gapsOf(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!)
}

/** G of 120 s (AC 80's case): twice agent-director's default G. */
const G_120_S: AdConfigTables = { tmux: { pending_grace_seconds: DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n } }

/** A G at B's floor, so B (G plus its addend) is above the floor (b.jg5 SRJ-210). */
const G_AT_B_FLOOR: AdConfigTables = { tmux: { pending_grace_seconds: BigInt(DIALOG_READY_TIMEOUT_MS / MS_PER_SECOND) } }

// ---------------------------------------------------------------------------
// Per-case state: the fake clock, the stub, the log lines, the tmux runner
// ---------------------------------------------------------------------------

let clock: FakeClock
let calls: StubCallLog
/** The virtual time of each `status` call: one per lap. */
let statusAt: number[]
/** The virtual time of each `read-pane` call. */
let readPaneAt: number[]
let errLines: string[]
let savedConsoleError: typeof console.error
let tmuxCalls: string[][]
let stateDir: string
let savedStateDir: string | undefined

/** One notice: the persona's key and the body. */
interface Notice {
  readonly key: string
  readonly text: string
}

/** Every notice the outage state's notify sink received (onsets, all-clears). */
let outageNotices: Notice[]
/** Every notice sent through the session notifier (the approver sends none). */
let sessionNotices: Notice[]
/** Where a recorded session notice goes next: the real persona notifier, when a case installs one. */
let forwardSessionNotice: ((key: string, text: string) => void | Promise<void>) | undefined
/** Every arm of a persona's retry timer through the outage state's trigger sink: the key and the cause's kind. */
let retryArms: Array<{ readonly key: string; readonly kind: string }>
/** Every `tmux-unresponsive` start through the outage state's condition sink. */
let conditionStarts: string[]
/** Every report to the outage state's unclassified sink. */
let unclassifiedReports: string[]
/** The temp HOME a case writes agent-director's settings under, once it installs the reader. */
let settingsHome: string | undefined
/** The settings reader's log lines (a refused read). */
let settingsLines: string[]

/** The retry causes an approver answer may arm, outside every attempt (b.jg5 SRJ-311, SRJ-316; hatch A2). */
const ANY_CONTEXT_CAUSES: ReadonlySet<string> = new Set([UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, UNAVAILABLE_RETRY_CAUSE_CONFIG])

beforeEach(() => {
  clock = createFakeClock()
  _setApproverClock(clock)
  _resetDialogReadyTimeoutMs()
  resetAdSettingsForTests()
  settingsHome = undefined
  settingsLines = []
  outageNotices = []
  sessionNotices = []
  forwardSessionNotice = undefined
  retryArms = []
  conditionStarts = []
  unclassifiedReports = []
  initOutageState({
    notify: (key, text) => {
      outageNotices.push({ key, text })
    },
    getClient,
    triggerSink: {
      arm: (key, cause) => {
        retryArms.push({ key, kind: cause.kind })
        return true
      },
    },
    conditionSink: {
      start: (key) => {
        conditionStarts.push(key)
      },
      end: () => {},
    },
    unclassifiedSink: {
      report: (key) => {
        unclassifiedReports.push(key)
      },
    },
  })
  setSessionNotifier((key, text) => {
    sessionNotices.push({ key, text })
    return forwardSessionNotice?.(key, text)
  })
  tmuxCalls = []
  _setTmuxCommandRunner(async (args) => {
    tmuxCalls.push([...args])
    return { code: 1, stdout: '' }
  })
  calls = makeStubCallLog()
  statusAt = []
  readPaneAt = []
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
  const leakCheck = {
    errLines,
    calls,
    tmuxCalls,
    outageNotices,
    sessionNotices,
    settingsLines,
    stateDir: writtenFile(stateDir),
  }
  try {
    expect(pendingTimers).toEqual([])
    expect(tmuxCalls).toEqual([])
    // The approver posts nothing (b.jg5 SRJ-405), and its calls run outside
    // every attempt: only ENVIRONMENT and CONFIG arm P's retry timer, and no
    // answer starts a condition or reaches the unclassified sink (hatch A2).
    expect(sessionNotices).toEqual([])
    expect(retryArms.filter((arm) => !ANY_CONTEXT_CAUSES.has(arm.kind))).toEqual([])
    expect(conditionStarts).toEqual([])
    expect(unclassifiedReports).toEqual([])
    expect(settingsLines).toEqual([])
    assertNoLeak(leakCheck)
  } finally {
    _resetApproverClock()
    _resetDialogReadyTimeoutMs()
    _resetTmuxCommandRunner()
    resetClientForTests()
    _resetOutageState()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    setSessionNotifier(undefined)
    resetAdSettingsForTests()
    // A `send-keys` answering `ErrSpawnNotInteractive` records its launch (b.jg5 SRJ-412): none outlives the case.
    for (const who of PERSONAS) forgetLaunchCalls(who.key)
    if (settingsHome !== undefined) rmSync(settingsHome, { recursive: true, force: true })
    if (savedStateDir === undefined) delete process.env['SLACK_STATE_DIR']
    else process.env['SLACK_STATE_DIR'] = savedStateDir
    rmSync(stateDir, { recursive: true, force: true })
  }
})

/** A `status` answer: a row, or an error the call rejects with. */
type StatusAnswer = Phase1StatusResult | Error

/**
 * Install the stub. `status` answers `statusAnswers` in order, one per lap,
 * the last sticking, or, given a function, its answer for the lap's index
 * (from 0); each call's virtual time goes to `statusAt`, and each
 * `read-pane`'s to `readPaneAt`. Every call is recorded in `calls`. Given
 * `statusDelayMs`, each `status` call is recorded when it starts and answers
 * `statusDelayMs(lap)` later on the case's clock (a slow agent-director; 0
 * answers at once).
 */
function installStub(
  statusAnswers: ReadonlyArray<StatusAnswer> | ((lap: number) => StatusAnswer),
  knobs: Omit<StubClientOptions, keyof StubCallLog | 'statusFn'> = {},
  statusDelayMs?: (lap: number) => number,
): void {
  const answerAt =
    typeof statusAnswers === 'function'
      ? statusAnswers
      : (lap: number): StatusAnswer => statusAnswers[Math.min(lap, statusAnswers.length - 1)]!
  let next = 0
  const stub = makeStubClient({
    ...calls,
    ...knobs,
    statusFn: (_params: StatusParams) => {
      statusAt.push(clock.now())
      return answerAt(next++)
    },
  })
  const readPane = stub.readPane
  stub.readPane = (params) => {
    readPaneAt.push(clock.now())
    return readPane(params)
  }
  if (statusDelayMs !== undefined) {
    const status = stub.status
    let lap = 0
    stub.status = async (params) => {
      const delayMs = statusDelayMs(lap++)
      const answer = status(params).then(
        (row) => ({ row }),
        (error: unknown) => ({ error }),
      )
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          clock.setTimeout(resolve, delayMs)
        })
      }
      const settled = await answer
      if ('error' in settled) throw settled.error
      return settled.row
    }
  }
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
}

/** Run the approver's clock from `startMs` (a case about B or the pace starts it at a launch start). */
function startClockAt(startMs: number): void {
  clock = createFakeClock({ start: startMs })
  _setApproverClock(clock)
}

/**
 * Install the settings reader over a temp HOME (`installAdSettings`), with
 * agent-director's settings file written there first when `tables` is given
 * (`writeAgentDirectorConfig`). `afterEach` resets the reader and removes the
 * HOME.
 */
function installSettings(tables?: AdConfigTables): AdSettingsReader {
  settingsHome ??= mkdtempSync(join(tmpdir(), 'cscb-approver-home-'))
  const home = settingsHome
  if (tables !== undefined) writeAgentDirectorConfig(home, tables)
  return installAdSettings({
    home: () => home,
    log: (line) => {
      settingsLines.push(line)
    },
  })
}

/** Rewrite the settings file under the installed HOME and let `reader` read it (the next 120 s tick's read). */
function rewriteSettings(reader: AdSettingsReader, tables: AdConfigTables): void {
  writeAgentDirectorConfig(settingsHome!, tables)
  reader.read()
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

/**
 * Assert that `line` is the approver line `build` gives for some outcome
 * text (what became of the latch, which the session manager fills in): the
 * builder's own text on both sides of the outcome.
 */
function expectLineAroundOutcome(line: string | undefined, build: (outcome: string) => string): void {
  const mark = '\u0000'
  const [head, tail] = build(mark).split(mark)
  expect(line?.startsWith(approverLogLine(head!))).toBe(true)
  expect(line?.endsWith(tail!)).toBe(true)
}

/** The record a latch holds for the approver's CONFLICT row `row` of persona `key` (b.jg5 SRJ-501). */
function conflictRowRecord(key: string, row: ConflictCaseRow): ConflictLatchRecord {
  return expectedLatchRecord(key, {
    latchCase: row.latchCase,
    refusedOperation: row.refusedOperation,
    rowState: row.rowState,
    sessionName: row.sessionName,
    description: row.build().errDescription,
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
// A state neither pending, live nor finished
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: an unknown state is logged once and polling goes on (b.jg5 SRJ-402)', () => {
  const UNKNOWN_STATE = 'not-a-row-state'

  test('a state neither pending, live nor finished: one line, no pane read; the next lap, at the fast pace, reads a live row (live)', async () => {
    installStub([cannedStatusResult({ state: UNKNOWN_STATE }), LIVE_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toEqual(evenTimes(0, FAST, 2))
    expect(calls.readPaneCalls).toEqual([])
    expect(approverLines()).toEqual([approverLogLine(approverUnknownStateMessage(PLAIN.ref, UNKNOWN_STATE))])
  })
})

// ---------------------------------------------------------------------------
// The pace (b.jg5 SRJ-403, AC 80)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: the pace, from the launch start (b.jg5 SRJ-403, SRJ-406; AC 80)', () => {
  const GRACE_SETTINGS: ReadonlyArray<readonly [string, AdConfigTables | undefined]> = [
    ['the default G', undefined],
    ['a G of 120 s', G_120_S],
  ]
  /** Where the approver starts: [label, its start after the launch start, given G]. */
  const APPROVER_STARTS: ReadonlyArray<readonly [string, (graceMs: number) => number]> = [
    ['starting at the launch start', () => 0],
    ['starting more than G after the launch start', (graceMs) => graceMs + FAST],
  ]
  /** Both launch-start forms the row may show: [form, the raw value]. */
  const FORMS = (['fractional', 'whole'] as const).map((form) => [form, SAMPLE_LAUNCH_STARTS[form]!] as const)
  const ROWS = FORMS.flatMap(([form, raw]) =>
    GRACE_SETTINGS.flatMap(([grace, tables]) =>
      APPROVER_STARTS.map(([where, offset]) => [form, grace, where, raw, tables, offset] as const),
    ),
  )

  test.each(ROWS)(
    'launch start %s, %s, the approver %s, on a resumed row whose started_at is older than B: pane reads are the fast pace apart until G from launch_started_at and the slow pace apart from G on, until B',
    async (_form, _grace, _where, raw, tables, offset) => {
      installSettings(tables)
      const graceMs = adGraceMsInEffect()
      const boundMs = adLaunchBoundMsInEffect()
      if (tables !== undefined) expect(graceMs).toBe(2 * adGraceMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
      const launchStartMs = parseLaunchStart(raw)!
      const startMs = launchStartMs + offset(graceMs)
      startClockAt(startMs)
      installStub([resumedRow(raw, launchStartMs - boundMs - graceMs)], { readPaneResults: [CLEAR_PANE] })

      expect(await runToStop(startApprover(PLAIN, false), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

      expect(readPaneAt).toEqual(paceLapTimes(startMs, launchStartMs, graceMs, launchStartMs + boundMs))
      const gaps = gapsOf(readPaneAt)
      expect(gaps.every((gap) => gap >= FAST)).toBe(true)
      expect(gapsOf(readPaneAt.filter((t) => t - launchStartMs >= graceMs)).every((gap) => gap >= SLOW)).toBe(true)
      // From the launch start: G's worth of fast laps; none for an approver that starts past G.
      expect(gaps.filter((gap) => gap < SLOW)).toHaveLength(offset(graceMs) === 0 ? graceMs / FAST : 0)
      // The switch to the slow pace comes at G from the launch start, never from started_at.
      if (offset(graceMs) === 0) expect(readPaneAt.find((t, i) => readPaneAt[i + 1]! - t === SLOW)).toBe(launchStartMs + graceMs)
      expect(clock.now()).toBe(launchStartMs + boundMs)
      expect(approverLines()).toEqual([
        approverLogLine(approverBoundMessage(PLAIN.ref, boundMs, APPROVER_BOUND_FROM_LAUNCH_START)),
      ])
    },
  )

  /** A G, and so B, past the timer maximum: [label, the settings]. */
  const HUGE_G: ReadonlyArray<readonly [string, AdConfigTables]> = [
    ['beyond the timer maximum', { tmux: { pending_grace_seconds: BigInt(Math.ceil(MAX_TIMER_DELAY_MS / MS_PER_SECOND)) } }],
    ['too long for a millisecond count to hold exactly (it never ends)', { tmux: { pending_grace_seconds: AD_SETTING_INTEGER_MAX } }],
  ]
  /** Laps made before the live row ends the approver. */
  const LAPS = 5

  test.each(HUGE_G)(
    'a G %s (the one case beyond the timer maximum, E6): B is too; past the moment a plain timer would have fired the approver still runs at the fast pace and throws nothing, no pending timer asks more than the maximum, and a later live row ends it',
    async (label, tables) => {
      installSettings(tables)
      expect(adGraceMsInEffect()).toBeGreaterThan(MAX_TIMER_DELAY_MS)
      expect(adLaunchBoundMsInEffect()).toBeGreaterThan(MAX_TIMER_DELAY_MS)
      if (label.endsWith('(it never ends)')) expect(adGraceMsInEffect()).toBe(AD_WAIT_NEVER_ENDS)
      startClockAt(LAUNCH_START_MS)
      let row: Phase1StatusResult = PENDING_ROW
      installStub(() => row, { readPaneResults: [CLEAR_PANE] })
      const run = startApprover(PLAIN, true)

      await clock.flush()
      for (let lap = 1; lap < LAPS; lap++) {
        // B's timer and the sleep's, neither asking more than a real timer honours.
        expect(clock.pendingCount()).toBe(2)
        expect(clock.pending().every((timer) => timer.delayMs <= MAX_TIMER_DELAY_MS)).toBe(true)
        await clock.runNext()
        expect(run.stop()).toBeUndefined()
      }
      expect(readPaneAt).toEqual(evenTimes(LAUNCH_START_MS, FAST, LAPS))

      row = LIVE_ROW
      expect(await runToStop(run)).toBe(APPROVER_STOP_LIVE)
      expect(approverLines()).toEqual([])
      expect(startupEntries()).toEqual([])
    },
  )

  /** Where the approver starts: [label, its start after the launch start given G, the pace in effect]. */
  const PACE_REGIONS: ReadonlyArray<readonly [string, (graceMs: number) => number, number]> = [
    ['before G (starting at the launch start), at the fast pace', () => 0, FAST],
    ['past G (starting more than G after the launch start), at the slow pace', (graceMs) => graceMs + FAST, SLOW],
  ]
  /** Which lap's `status` read is slow: [label, the lap's index from 0]. */
  const SLOW_STATUS_LAPS: ReadonlyArray<readonly [string, number]> = [
    ['the first lap', 0],
    ['a later lap', 2],
  ]
  /** How long the slow `status` read takes: [label, its time given the pace in effect]. */
  const SLOW_STATUS_TIMES: ReadonlyArray<readonly [string, (paceMs: number) => number]> = [
    ['longer than the pace', (paceMs) => paceMs + 500],
    ['just under the pace', (paceMs) => paceMs - 1],
  ]
  /** Pending laps (a pane with no needle) before a live row ends the approver. */
  const PENDING_LAPS = 5

  /**
   * The `read-pane` times when lap `slowLap`'s `status` read takes `delayMs`
   * and every other answers at once: each lap starts `paceMs` after the
   * previous lap's pane read and reads the pane as its `status` read answers.
   */
  function readTimesWithSlowStatus(startMs: number, paceMs: number, slowLap: number, delayMs: number): number[] {
    const times: number[] = []
    for (let lap = 0; lap < PENDING_LAPS; lap++) {
      const lapStartMs = lap === 0 ? startMs : times[lap - 1]! + paceMs
      times.push(lapStartMs + (lap === slowLap ? delayMs : 0))
    }
    return times
  }

  const SLOW_STATUS_ROWS = PACE_REGIONS.flatMap(([region, offset, paceMs]) =>
    SLOW_STATUS_LAPS.flatMap(([which, slowLap]) =>
      SLOW_STATUS_TIMES.map(([howLong, statusMs]) => [region, which, howLong, offset, paceMs, slowLap, statusMs] as const),
    ),
  )

  test.each(SLOW_STATUS_ROWS)(
    '%s, %s\'s status read taking %s: the next lap starts the pace after that lap\'s pane read, so no two pane reads are closer than the pace',
    async (_region, _which, _howLong, offset, paceMs, slowLap, statusMs) => {
      const graceMs = adGraceMsInEffect()
      const boundMs = adLaunchBoundMsInEffect()
      const startMs = LAUNCH_START_MS + offset(graceMs)
      const delayMs = statusMs(paceMs)
      startClockAt(startMs)
      installStub(
        [...Array.from({ length: PENDING_LAPS }, () => PENDING_ROW), LIVE_ROW],
        { readPaneResults: [CLEAR_PANE] },
        (lap) => (lap === slowLap ? delayMs : 0),
      )

      expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_LIVE)

      expect(statusAt).toHaveLength(PENDING_LAPS + 1)
      expect(readPaneAt[slowLap]! - statusAt[slowLap]!).toBe(delayMs)
      expect(readPaneAt).toEqual(readTimesWithSlowStatus(startMs, paceMs, slowLap, delayMs))
      expect(gapsOf(readPaneAt).every((gap) => gap >= paceMs)).toBe(true)
      expect(statusAt[PENDING_LAPS]).toBe(readPaneAt[PENDING_LAPS - 1]! + paceMs)
      if (paceMs === FAST) expect(statusAt.every((t) => t - LAUNCH_START_MS < graceMs)).toBe(true)
      else expect(readPaneAt.every((t) => t - LAUNCH_START_MS >= graceMs)).toBe(true)
      expect(clock.now()).toBeLessThan(LAUNCH_START_MS + boundMs)
      expect(calls.sendKeysCalls).toEqual([])
      expect(approverLines()).toEqual([])
    },
  )

  test.each(SLOW_STATUS_TIMES)(
    'a lap that reads no pane (an unknown state), its status read taking %s: the next lap starts the fast pace after that lap\'s start, or as it ends once the pace has passed',
    async (_howLong, statusMs) => {
      const unknownState = 'not-a-row-state'
      const delayMs = statusMs(FAST)
      installStub([cannedStatusResult({ state: unknownState }), PENDING_ROW, LIVE_ROW], { readPaneResults: [CLEAR_PANE] }, (lap) =>
        lap === 0 ? delayMs : 0,
      )

      expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_LIVE)

      const secondLapMs = Math.max(FAST, delayMs)
      expect(statusAt).toEqual([0, secondLapMs, secondLapMs + FAST])
      expect(readPaneAt).toEqual([secondLapMs])
      expect(approverLines()).toEqual([approverLogLine(approverUnknownStateMessage(PLAIN.ref, unknownState))])
    },
  )
})

// ---------------------------------------------------------------------------
// B, from the launch start (b.jg5 SRJ-404, SRJ-210, SRJ-406)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: B, measured from the launch start and never early (b.jg5 SRJ-404, SRJ-210, SRJ-406)', () => {
  const FORMS = (['fractional', 'whole'] as const).map((form) => [form, SAMPLE_LAUNCH_STARTS[form]!] as const)
  const SETTINGS: ReadonlyArray<readonly [string, AdConfigTables | undefined]> = [
    ['the default settings (B at its floor)', undefined],
    ['a G that puts B above its floor', G_AT_B_FLOOR],
  ]
  const ROWS = FORMS.flatMap(([form, raw]) => SETTINGS.map(([settings, tables]) => [form, settings, raw, tables] as const))

  test.each(ROWS)(
    'launch start %s, %s, on a resumed row whose started_at is older: stops (bound) exactly at the launch start plus B, not before, with the line and the start-pass entry',
    async (_form, _settings, raw, tables) => {
      installSettings(tables)
      const graceMs = adGraceMsInEffect()
      const boundMs = adLaunchBoundMsInEffect()
      if (tables !== undefined) expect(boundMs).toBeGreaterThan(DIALOG_READY_TIMEOUT_MS)
      const launchStartMs = parseLaunchStart(raw)!
      // The approver starts once the launch call has returned.
      const startMs = launchStartMs + FAST
      startClockAt(startMs)
      installStub([resumedRow(raw, launchStartMs - 2 * boundMs)], { readPaneResults: [CLEAR_PANE] })

      expect(await runToStop(startApprover(NAMED, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

      expect(clock.now()).toBe(launchStartMs + boundMs)
      expect(statusAt).toEqual(paceLapTimes(startMs, launchStartMs, graceMs, launchStartMs + boundMs))
      expect(calls.sendKeysCalls).toEqual([])
      const message = approverBoundMessage(NAMED.ref, boundMs, APPROVER_BOUND_FROM_LAUNCH_START)
      expect(approverLines()).toEqual([approverLogLine(message)])
      expect(startupEntries()).toEqual([{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }])
    },
  )

  test('every status refused (UNAVAILABLE): polling goes on, backing off, and stops (bound) no earlier than B from its own start, the line saying so', async () => {
    startClockAt(LAUNCH_START_MS)
    const startMs = clock.now()
    const boundMs = adLaunchBoundMsInEffect()
    const err = errTmuxUnresponsive('status')
    installStub([err])

    expect(await runToStop(startApprover(PLAIN, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(startMs + boundMs)
    expect(statusAt).toEqual(evenTimes(startMs, SLOW, boundMs / SLOW))
    expect(calls.readPaneCalls).toEqual([])
    const refused = approverLogLine(approverStatusRefusedMessage(PLAIN.ref, describeAgentDirectorFailure(err)))
    const message = approverBoundMessage(PLAIN.ref, boundMs, APPROVER_BOUND_FROM_APPROVER_START)
    expect(approverLines()).toEqual([...statusAt.map(() => refused), approverLogLine(message)])
    expect(startupEntries()).toEqual([{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }])
  })

  test('the first laps refused, then a lap reads a launch start older than the approver: the bound follows that launch start (bound)', async () => {
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    const launchStartMs = LAUNCH_START_MS
    const startMs = launchStartMs + graceMs
    startClockAt(startMs)
    const refusedLaps = 2
    const err = errTmuxUnresponsive('status')
    installStub((lap) => (lap < refusedLaps ? err : resumedRow(isoAt(launchStartMs), launchStartMs - boundMs)), {
      readPaneResults: [CLEAR_PANE],
    })

    expect(await runToStop(startApprover(PLAIN, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(launchStartMs + boundMs)
    expect(clock.now()).toBeLessThan(startMs + boundMs)
    // Backing off after the refusals, then the slow pace: G has passed.
    expect(statusAt).toEqual(evenTimes(startMs, SLOW, (launchStartMs + boundMs - startMs) / SLOW))
    expect(readPaneAt).toEqual(statusAt.slice(refusedLaps))
    const message = approverBoundMessage(PLAIN.ref, boundMs, APPROVER_BOUND_FROM_LAUNCH_START)
    expect(approverLines().at(-1)).toBe(approverLogLine(message))
    expect(approverLines()).toHaveLength(refusedLaps + 1)
    expect(startupEntries()).toEqual([{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }])
  })

  test('a G raised while it runs: no stop at the old B, a stop at the new B (never early)', async () => {
    const reader = installSettings()
    const oldBoundMs = adLaunchBoundMsInEffect()
    const launchStartMs = LAUNCH_START_MS
    startClockAt(launchStartMs)
    installStub([PENDING_ROW], { readPaneResults: [CLEAR_PANE] })
    const run = startApprover(PLAIN, true)
    await clock.advanceTo(launchStartMs + oldBoundMs - FAST)
    expect(run.stop()).toBeUndefined()

    rewriteSettings(reader, G_AT_B_FLOOR)
    const newBoundMs = adLaunchBoundMsInEffect()
    expect(newBoundMs).toBeGreaterThan(oldBoundMs)

    expect(await runToStop(run, MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(launchStartMs + newBoundMs)
    // It went on polling at and past the old B.
    expect(statusAt).toContain(launchStartMs + oldBoundMs)
    const message = approverBoundMessage(PLAIN.ref, newBoundMs, APPROVER_BOUND_FROM_LAUNCH_START)
    expect(approverLines()).toEqual([approverLogLine(message)])
    expect(startupEntries()).toEqual([{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }])
  })
})

// ---------------------------------------------------------------------------
// At B nothing is posted (b.jg5 SRJ-405)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: at B, a line and the start-pass entry, and nothing posted (b.jg5 SRJ-405)', () => {
  test.each([true, false])(
    'isStartup %s: one line; the not-ready entry only for a start-pass launch; no notice reaches a recording session notifier, the outage notify sink or the real persona notifier',
    async (isStartup) => {
      const h = makeNotifierHarness(makeMultiPersonaConfig([{ name: PLAIN.name }, { name: NAMED.name }], stateDir))
      forwardSessionNotice = h.notifier.notify
      const boundMs = adLaunchBoundMsInEffect()
      startClockAt(LAUNCH_START_MS)
      installStub([PENDING_ROW], { readPaneResults: [CLEAR_PANE] })

      expect(await runToStop(startApprover(NAMED, isStartup), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

      expect(clock.now()).toBe(LAUNCH_START_MS + boundMs)
      const message = approverBoundMessage(NAMED.ref, boundMs, APPROVER_BOUND_FROM_LAUNCH_START)
      expect(approverLines()).toEqual([approverLogLine(message)])
      expect(startupEntries()).toEqual(isStartup ? [{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }] : [])
      expect(sessionNotices).toEqual([])
      expect(outageNotices).toEqual([])
      expect(h.totalPosts()).toBe(0)
      expect(h.logs).toEqual([])
      expect(h.clock.pending()).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// The test cap (b.jg5 SRJ-404, SRJ-1303)
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs: the test cap, in place of B (b.jg5 SRJ-404, SRJ-1303)', () => {
  test.each([true, false])(
    'set (isStartup %s): stops (cap) that long after its own start, though B from an older launch start had passed when it started; the cap line, the entry only for a start-pass launch; B reads the same set or unset',
    async (isStartup) => {
      const boundMs = adLaunchBoundMsInEffect()
      const capMs = 2 * SLOW
      _setDialogReadyTimeoutMs(capMs)
      expect(adLaunchBoundMsInEffect()).toBe(boundMs)
      const startMs = LAUNCH_START_MS + boundMs
      startClockAt(startMs)
      installStub([PENDING_ROW], { readPaneResults: [CLEAR_PANE] })

      expect(await runToStop(startApprover(NAMED, isStartup), MANY_TIMERS)).toBe(APPROVER_STOP_CAP)

      expect(clock.now()).toBe(startMs + capMs)
      // The pane was read though B from the launch start had passed (G too: the slow pace).
      expect(readPaneAt).toEqual(evenTimes(startMs, SLOW, capMs / SLOW))
      expect(calls.sendKeysCalls).toEqual([])
      const message = approverCapMessage(NAMED.ref, capMs)
      expect(approverLines()).toEqual([approverLogLine(message)])
      expect(startupEntries()).toEqual(isStartup ? [{ label: STARTUP_ERROR_APPROVE_NOT_READY, message }] : [])
      _resetDialogReadyTimeoutMs()
      expect(adLaunchBoundMsInEffect()).toBe(boundMs)
    },
  )
})

// ---------------------------------------------------------------------------
// Each answer by class (b.jg5 SRJ-117, SRJ-118, SRJ-404)
// ---------------------------------------------------------------------------

/** The outage an ENVIRONMENT answer raises (b.jg5 SRJ-311). */
const TMUX_UNAVAILABLE: OutageClass = 'tmux-unavailable'

/** E10's UNAVAILABLE forms of agent-director's own errors (all but `ErrTmuxKillFailed`, which only a kill answers). */
const TMUX_UNAVAILABLE_FORMS = unavailableForms(
  'ErrTmuxUnresponsive',
  'ErrTmuxUnresponsive, still stopping',
  'ErrTmuxUnresponsive, still starting',
  'ErrTmuxUnresponsive, launch timeout',
  'ErrCallTimeout',
  ['ErrUnknownErrorName', 'an unknown error name from a later binary'],
  'a wrapped UnknownError',
)

describe('approvePreSessionDialogs: each answer by class, one case per cell (b.jg5 SRJ-117, SRJ-118, SRJ-404)', () => {
  beforeEach(() => {
    startClockAt(LAUNCH_START_MS)
  })

  /** One cell: [name, the verb whose call answers, its error built by the stub]. */
  type Cell = readonly [string, ApproverVerb, () => Error]
  const VERBS: readonly ApproverVerb[] = ['status', 'read-pane', 'send-keys']
  const cellsOf = (label: string, verbs: readonly ApproverVerb[], make: (verb: ApproverVerb) => Error): Cell[] =>
    verbs.map((verb) => [`${verb}: ${label}`, verb, () => make(verb)] as const)

  /**
   * Install the stub so that the first lap's `verb` call answers `err`. Each
   * later lap's calls succeed (the pane showing a needle for a `send-keys`
   * cell, so Enter is pressed again); the third lap reads a live row.
   */
  function installFirstLapRefusal(verb: ApproverVerb, err: Error): void {
    installStub(verb === 'status' ? [err, PENDING_ROW, LIVE_ROW] : [PENDING_ROW, PENDING_ROW, LIVE_ROW], {
      readPaneResults: [verb === 'send-keys' ? dialogPane(TRUST_DIALOG_NEEDLE) : CLEAR_PANE],
      ...(verb === 'read-pane' ? { readPaneQueue: [cannedErr(err)] } : {}),
      ...(verb === 'send-keys' ? { sendKeysQueue: [cannedErr(err)] } : {}),
    })
  }

  /** Stopped at the first lap, at once: its calls up to the refused one, no further call, nothing typed but the refused Enter, no kill. */
  function expectStoppedAtFirstLap(verb: ApproverVerb): void {
    expect(statusAt).toEqual([LAUNCH_START_MS])
    expect(clock.now()).toBe(LAUNCH_START_MS)
    expect(calls.readPaneCalls).toHaveLength(verb === 'status' ? 0 : 1)
    expect(calls.sendKeysCalls).toHaveLength(verb === 'send-keys' ? 1 : 0)
    expect(calls.killCalls).toEqual([])
  }

  /** The one line a refused call that keeps the approver polling gives. */
  function pollingOnLine(verb: ApproverVerb, err: Error): string {
    const failure = describeAgentDirectorFailure(err)
    return approverLogLine(
      verb === 'status' ? approverStatusRefusedMessage(PLAIN.ref, failure) : approverPaneCallFailedMessage(PLAIN.ref, verb, failure),
    )
  }

  /**
   * A first-lap refusal that keeps the approver polling: the second lap
   * `firstGapMs` after the first, the third (live) at the fast pace after a
   * clean second lap; one line.
   */
  async function expectPollsOn(verb: ApproverVerb, err: Error, firstGapMs: number): Promise<void> {
    installFirstLapRefusal(verb, err)

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_LIVE)

    expect(statusAt).toEqual([LAUNCH_START_MS, LAUNCH_START_MS + firstGapMs, LAUNCH_START_MS + firstGapMs + FAST])
    expect(calls.sendKeysCalls).toHaveLength(verb === 'send-keys' ? 2 : 0)
    expect(approverLines()).toEqual([pollingOnLine(verb, err)])
    expect(startupEntries()).toEqual([])
  }

  // Stop cells.

  const GONE_CELLS: readonly Cell[] = [
    ...cellsOf('GONE (ErrTmuxCaptureFailed)', ['status', 'read-pane'], (verb) => errTmuxCaptureFailed(undefined, verb)),
    ['send-keys: GONE (ErrTmuxSendKeys)', 'send-keys', () => errTmuxSendKeys()],
    ...cellsOf('ErrSpawnNotFound', ['read-pane', 'send-keys'], () => errSpawnNotFound()),
  ]

  test.each(GONE_CELLS)('%s: stops (gone) at that lap with one line and nothing typed', async (_name, verb, make) => {
    const err = make()
    installFirstLapRefusal(verb, err)

    expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_GONE)

    expectStoppedAtFirstLap(verb)
    expect(approverLines()).toEqual([approverLogLine(approverGoneMessage(PLAIN.ref, verb, describeAgentDirectorFailure(err)))])
    expect(startupEntries()).toEqual([])
    expect(outageNotices).toEqual([])
    expect(retryArms).toEqual([])
  })

  const NOT_INTERACTIVE_CELLS: readonly Cell[] = [
    ...cellsOf("ErrSpawnNotInteractive, a leftover's session", ['read-pane', 'send-keys'], (verb) =>
      errSpawnNotInteractiveLeftover(undefined, verb),
    ),
    ...cellsOf('ErrSpawnNotInteractive, no launch start', ['read-pane', 'send-keys'], (verb) =>
      errSpawnNotInteractiveNoLaunchStart(verb),
    ),
  ]

  test.each(NOT_INTERACTIVE_CELLS)(
    '%s: stops (not-interactive) with nothing typed, no kill and exactly one line',
    async (_name, verb, make) => {
      const err = make()
      installFirstLapRefusal(verb, err)

      expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_NOT_INTERACTIVE)

      expectStoppedAtFirstLap(verb)
      expect(approverLines()).toEqual([
        approverLogLine(approverNotInteractiveMessage(PLAIN.ref, verb, describeAgentDirectorFailure(err))),
      ])
      expect(startupEntries()).toEqual([])
      expect(retryArms).toEqual([])
    },
  )

  test.each(cellsOf('ErrTmuxNotAvailable (ENVIRONMENT)', VERBS, (verb) => errTmuxNotAvailable(undefined, verb)))(
    "%s: stops (tmux-unavailable) with one line; tmux-unavailable is raised and P's retry timer armed, and nothing is counted (no notice, no entry)",
    async (_name, verb, make) => {
      const err = make()
      installFirstLapRefusal(verb, err)

      expect(await approve(PLAIN, true)).toBe(APPROVER_STOP_TMUX_UNAVAILABLE)

      expectStoppedAtFirstLap(verb)
      expect(approverLines()).toEqual([
        approverLogLine(approverTmuxUnavailableMessage(PLAIN.ref, verb, describeAgentDirectorFailure(err))),
      ])
      expect([...getOutageFlags(PLAIN.key)]).toEqual([TMUX_UNAVAILABLE])
      expect(outageNotices).toEqual([{ key: PLAIN.key, text: ONSET_TEMPLATES[TMUX_UNAVAILABLE]() }])
      expect(retryArms).toEqual([{ key: PLAIN.key, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT }])
      expect(startupEntries()).toEqual([])
    },
  )

  test.each(APPROVER_CONFLICT_CASE_ROWS.map((row) => [row.name, row] as const))(
    "%s: CONFLICT latches P through the latch's CONFLICT entry (P's next check or recovery, recorded pending); stops (latched) with nothing typed and one line",
    async (_name, row) => {
      const latchLines: string[] = []
      const latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
      setConflictLatch(latch)
      const verb = row.verb as ApproverVerb
      const err = row.build()
      installFirstLapRefusal(verb, err)

      expect(await approve(NAMED, true)).toBe(APPROVER_STOP_LATCHED)

      expectStoppedAtFirstLap(verb)
      expect(latch.record(NAMED.key)).toEqual(conflictRowRecord(NAMED.key, row))
      const lines = approverLines()
      expect(lines).toHaveLength(1)
      expectLineAroundOutcome(lines[0], (outcome) =>
        approverConflictMessage(NAMED.ref, verb, describeAgentDirectorFailure(err), outcome),
      )
      expect(startupEntries()).toEqual([])
      expect(retryArms).toEqual([])
      assertNoLeak(latchLines)
    },
  )

  test.each(APPROVER_UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const))(
    '%s: UNUSABLE NAME latches P (unusable recorded name, refused operation none); stops (latched) with nothing typed and one line',
    async (_name, row) => {
      const latchLines: string[] = []
      const latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
      setConflictLatch(latch)
      const verb = row.verb as ApproverVerb
      const err = row.build()
      installFirstLapRefusal(verb, err)

      expect(await approve(NAMED, true)).toBe(APPROVER_STOP_LATCHED)

      expectStoppedAtFirstLap(verb)
      expect(latch.record(NAMED.key)).toEqual(row.record(NAMED.key))
      const lines = approverLines()
      expect(lines).toHaveLength(1)
      const failure = describeAgentDirectorFailure(err)
      if (verb === 'status') {
        // The shared own-row read latched it and wrote its own line.
        expect(lines[0]!.startsWith(`${APPROVER_LOG_PREFIX}${APPROVER_STATUS_READ_WHAT} for ${NAMED.ref}: ${failure}`)).toBe(true)
      } else {
        expectLineAroundOutcome(lines[0], (outcome) => approverUnusableNameMessage(NAMED.ref, verb, failure, outcome))
      }
      expect(startupEntries()).toEqual([])
      expect(retryArms).toEqual([])
      assertNoLeak(latchLines)
    },
  )

  // Polling-on cells.

  test.each(TMUX_UNAVAILABLE_FORMS.flatMap(([label, make]) => cellsOf(`UNAVAILABLE (${label})`, VERBS, make)))(
    '%s: polling goes on, the next lap at the slow pace (backing off) and the one after a clean lap at the pace in effect; nothing armed, no condition, no notice',
    async (_name, verb, make) => {
      await expectPollsOn(verb, make(), SLOW)
      expect(outageNotices).toEqual([])
      expect(retryArms).toEqual([])
    },
  )

  test.each(cellsOf('CONFIG (ErrConfigMalformed)', VERBS, () => errConfigMalformed()))(
    "%s: raises ad-config-malformed and arms P's retry timer as from any verb; polling goes on, the next lap at the slow pace and the one after a clean lap at the pace in effect",
    async (_name, verb, make) => {
      const err = make()
      await expectPollsOn(verb, err, SLOW)
      expect(outageNotices[0]).toEqual({ key: PLAIN.key, text: adConfigMalformedOnset(err) })
      expect(retryArms).toEqual([{ key: PLAIN.key, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG }])
    },
  )

  const UNCLASSIFIED_CELLS: readonly Cell[] = [
    ...cellsOf('UNCLASSIFIED (ErrInternal with no phrase)', VERBS, () => errInternal()),
    ...cellsOf('UNCLASSIFIED (an error name CSCB gives no handling)', VERBS, (verb) => errGeneric(verb, 'ErrBroken')),
    ['send-keys: UNCLASSIFIED (ErrSendKeysWhileRelayed)', 'send-keys', () => errSendKeysWhileRelayed()],
  ]

  test.each(UNCLASSIFIED_CELLS)(
    '%s: polling goes on at the pace in effect; nothing armed, no episode, no notice',
    async (_name, verb, make) => {
      await expectPollsOn(verb, make(), FAST)
      expect(outageNotices).toEqual([])
      expect(retryArms).toEqual([])
    },
  )

  test.each([...VERBS])(
    '%s refused with the leak marker in its message: the one line carries the message redacted, and polling goes on',
    async (verb) => {
      const err = leakyAdError(verb)
      await expectPollsOn(verb, err, FAST)
      expect(pollingOnLine(verb, err)).toContain(REDACTED_SENTINEL_TAIL)
    },
  )

  // Polling on until B.

  test("CONFIG from every status: polling goes on, backing off, until B from its own start (bound); the outage is raised once and P's retry timer armed at each answer", async () => {
    const err = errConfigMalformed()
    installStub([err])
    const boundMs = adLaunchBoundMsInEffect()

    expect(await runToStop(startApprover(PLAIN, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(LAUNCH_START_MS + boundMs)
    expect(statusAt).toEqual(evenTimes(LAUNCH_START_MS, SLOW, boundMs / SLOW))
    expect(outageNotices).toEqual([{ key: PLAIN.key, text: adConfigMalformedOnset(err) }])
    expect(retryArms).toEqual(statusAt.map(() => ({ key: PLAIN.key, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG })))
    expect(approverLines().at(-1)).toBe(
      approverLogLine(approverBoundMessage(PLAIN.ref, boundMs, APPROVER_BOUND_FROM_APPROVER_START)),
    )
  })

  test('UNAVAILABLE from every Enter (a needle on screen): polling goes on, backing off, until B from the launch start (bound)', async () => {
    const err = errTmuxUnresponsive('send-keys')
    installStub([PENDING_ROW], { readPaneResults: [dialogPane(DEV_CHANNELS_DIALOG_NEEDLE)], sendKeysError: err })
    const boundMs = adLaunchBoundMsInEffect()

    expect(await runToStop(startApprover(PLAIN, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(LAUNCH_START_MS + boundMs)
    expect(readPaneAt).toEqual(evenTimes(LAUNCH_START_MS, SLOW, boundMs / SLOW))
    expect(calls.sendKeysCalls).toHaveLength(readPaneAt.length)
    expect(approverLines()).toHaveLength(readPaneAt.length + 1)
  })

  test('UNCLASSIFIED from every read-pane: polling goes on at the pace in effect until B from the launch start (bound)', async () => {
    const err = errInternal()
    installStub([PENDING_ROW], { readPaneError: err })
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()

    expect(await runToStop(startApprover(PLAIN, true), MANY_TIMERS)).toBe(APPROVER_STOP_BOUND)

    expect(clock.now()).toBe(LAUNCH_START_MS + boundMs)
    expect(readPaneAt).toEqual(paceLapTimes(LAUNCH_START_MS, LAUNCH_START_MS, graceMs, LAUNCH_START_MS + boundMs))
    expect(approverLines()).toEqual([
      ...readPaneAt.map(() => pollingOnLine('read-pane', err)),
      approverLogLine(approverBoundMessage(PLAIN.ref, boundMs, APPROVER_BOUND_FROM_LAUNCH_START)),
    ])
  })
})

// ---------------------------------------------------------------------------
// The not-interactive record (b.jg5 SRJ-118, SRJ-412, SRJ-1017)
// ---------------------------------------------------------------------------

/** The stub's two launch-start forms that carry one: [form, raw]. */
const RECORD_LAUNCH_STARTS: ReadonlyArray<readonly [string, string]> = [
  ['fractional', SAMPLE_LAUNCH_STARTS.fractional!],
  ['whole', SAMPLE_LAUNCH_STARTS.whole!],
]

/** A `pending` row whose launch start is `raw`. */
function pendingRowAt(raw: string): Phase1StatusResult {
  return cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: raw })
}

/** A newer launch's `pending` row: the whole sample, another instant than the stub's default. */
const NEWER_RECORD_ROW = pendingRowAt(SAMPLE_LAUNCH_STARTS.whole!)

/** One launch start's forms that name its instant: the raw text, its parsed instant, and a numeric offset naming it. */
function sameLaunchStartForms(raw: string): unknown[] {
  const instant = parseLaunchStart(raw)!
  const offsetHours = 2
  const offsetForm = isoAt(instant + offsetHours * 3_600_000).replace(/Z$/, `+0${offsetHours}:00`)
  expect(parseLaunchStart(offsetForm)).toBe(instant)
  return [raw, instant, offsetForm]
}

/** Whether the record answers yes for persona `key` and launch start `launchStart`. */
const met = (key: string, launchStart: unknown): boolean => launchMetSendKeysNotInteractive(key, launchStart)

/** Expect no record for either persona and any launch start the cases use. */
function expectNoRecord(): void {
  for (const who of PERSONAS) {
    for (const [, raw] of RECORD_LAUNCH_STARTS) for (const form of sameLaunchStartForms(raw)) expect(met(who.key, form)).toBe(false)
  }
}

describe('the approver\'s send-keys answering ErrSpawnNotInteractive records its launch; nothing else does (b.jg5 SRJ-118, SRJ-412, SRJ-1017)', () => {
  beforeEach(() => {
    startClockAt(LAUNCH_START_MS)
    for (const who of PERSONAS) forgetLaunchCalls(who.key)
  })

  /** Both of the stub's `ErrSpawnNotInteractive` variants for `verb`. */
  const notInteractiveVariants = (verb: ApproverVerb): ReadonlyArray<readonly [string, () => Error]> => [
    ["a leftover's session", () => errSpawnNotInteractiveLeftover(undefined, verb)],
    ['no launch start', () => errSpawnNotInteractiveNoLaunchStart(verb)],
  ]

  test.each(
    PERSONAS.flatMap((who) =>
      RECORD_LAUNCH_STARTS.flatMap(([form, raw]) =>
        notInteractiveVariants('send-keys').map(([variant, make]) => [who.label, form, variant, who, raw, make] as const),
      ),
    ),
  )(
    '%s, the %s launch start, send-keys answering ErrSpawnNotInteractive (%s) at the first lap: stops not-interactive, and the record is set for the launch start it read',
    async (_label, _form, _variant, who, raw, make) => {
      installStub([pendingRowAt(raw)], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)], sendKeysQueue: [cannedErr(make())] })

      expect(await approve(who, false)).toBe(APPROVER_STOP_NOT_INTERACTIVE)

      expect(calls.sendKeysCalls).toEqual([expectedEnter(who.id)])
      // The record's matching (forms, other instants, other keys) is session-manager.test.ts's.
      expect(met(who.key, raw)).toBe(true)
    },
  )

  test.each(RECORD_LAUNCH_STARTS)(
    'the %s launch start: a first lap whose Enter is typed records nothing; a later lap\'s send-keys answering ErrSpawnNotInteractive records the launch start the first lap kept',
    async (_form, raw) => {
      installStub([pendingRowAt(raw)], {
        readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)],
        sendKeysQueue: [cannedOk({}), cannedErr(errSpawnNotInteractiveLeftover(undefined, 'send-keys'))],
      })
      const run = startApprover(PLAIN, false)

      await clock.flush()
      expect(calls.sendKeysCalls).toHaveLength(1)
      expect(run.stop()).toBeUndefined()
      expectNoRecord()

      expect(await runToStop(run)).toBe(APPROVER_STOP_NOT_INTERACTIVE)
      expect(calls.sendKeysCalls).toHaveLength(2)
      expect(met(PLAIN.key, raw)).toBe(true)
    },
  )

  test.each(
    RECORD_LAUNCH_STARTS.flatMap(([form, raw]) => notInteractiveVariants('read-pane').map(([variant, make]) => [form, variant, raw, make] as const)),
  )(
    'the %s launch start kept, read-pane answering ErrSpawnNotInteractive (%s): stops not-interactive with nothing typed, and records nothing (send-keys only)',
    async (_form, _variant, raw, make) => {
      installStub([pendingRowAt(raw)], { readPaneQueue: [cannedErr(make())] })

      expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_NOT_INTERACTIVE)

      expect(calls.readPaneCalls).toHaveLength(1)
      expect(calls.sendKeysCalls).toEqual([])
      expectNoRecord()
    },
  )

  test.each(notInteractiveVariants('status'))(
    'an approver that never read a launch start (its status answering ErrSpawnNotInteractive, %s): stops not-interactive with no pane call, and records nothing',
    async (_variant, make) => {
      installStub([make()])

      expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_NOT_INTERACTIVE)

      expect([calls.readPaneCalls, calls.sendKeysCalls]).toEqual([[], []])
      expectNoRecord()
    },
  )

  test('an approver that never read a launch start (a pending row with none): stops with no pane call, and records nothing', async () => {
    installStub([cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_STARTS.none })])

    expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_NO_LAUNCH_START)

    expect([calls.readPaneCalls, calls.sendKeysCalls]).toEqual([[], []])
    expectNoRecord()
  })

  /** The approver's CONFLICT and UNUSABLE NAME rows at its `send-keys`. */
  const SEND_KEYS_CONFLICT_ROW = APPROVER_CONFLICT_CASE_ROWS.find((row) => row.verb === 'send-keys')!
  const SEND_KEYS_UNUSABLE_NAME_ROW = APPROVER_UNUSABLE_NAME_CASE_ROWS.find((row) => row.verb === 'send-keys')!

  /**
   * Every other stop, and a refusal that polls on: [name, the status answers
   * (the dialog on screen), the first send-keys' error (none: typed), whether
   * the case installs a latch, the stop reason].
   */
  const OTHER_STOPS: ReadonlyArray<readonly [string, StatusAnswer[], (() => Error) | undefined, boolean, ApproverStopReason]> = [
    ['the row live after a typed Enter', [PENDING_ROW, LIVE_ROW], undefined, false, APPROVER_STOP_LIVE],
    ['the row finished after a typed Enter', [PENDING_ROW, cannedStatusResult({ state: [...AGENT_DIRECTOR_DEAD_STATES][0]! })], undefined, false, APPROVER_STOP_FINISHED],
    ['the row absent after a typed Enter', [PENDING_ROW, errSpawnNotFound()], undefined, false, APPROVER_STOP_ABSENT],
    ['another launch start at the next lap', [PENDING_ROW, NEWER_RECORD_ROW], undefined, false, APPROVER_STOP_SUPERSEDED],
    ['send-keys: GONE (ErrTmuxSendKeys)', [PENDING_ROW], () => errTmuxSendKeys(), false, APPROVER_STOP_GONE],
    ['send-keys: ErrSpawnNotFound', [PENDING_ROW], () => errSpawnNotFound(), false, APPROVER_STOP_GONE],
    ['send-keys: ENVIRONMENT (ErrTmuxNotAvailable)', [PENDING_ROW], () => errTmuxNotAvailable(undefined, 'send-keys'), false, APPROVER_STOP_TMUX_UNAVAILABLE],
    ['send-keys: UNAVAILABLE, polling on until the row is live', [PENDING_ROW, PENDING_ROW, LIVE_ROW], () => errTmuxUnresponsive('send-keys'), false, APPROVER_STOP_LIVE],
    ['send-keys: CONFLICT', [PENDING_ROW], () => SEND_KEYS_CONFLICT_ROW.build(), true, APPROVER_STOP_LATCHED],
    ['send-keys: UNUSABLE NAME', [PENDING_ROW], () => SEND_KEYS_UNUSABLE_NAME_ROW.build(), true, APPROVER_STOP_LATCHED],
  ]

  test.each(OTHER_STOPS)('%s: the approver stops (%s) and records nothing', async (_name, statusAnswers, sendKeysError, latches, reason) => {
    if (latches) setConflictLatch(createConflictLatch({ log: () => {} }))
    installStub(statusAnswers, {
      readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)],
      ...(sendKeysError === undefined ? {} : { sendKeysQueue: [cannedErr(sendKeysError())] }),
    })

    expect(await approve(PLAIN, false)).toBe(reason)

    expect(calls.sendKeysCalls.length).toBeGreaterThan(0)
    expectNoRecord()
  })

  test('the test cap stops an approver whose Enter was typed: nothing recorded', async () => {
    _setDialogReadyTimeoutMs(DIALOG_POLL_INTERVAL_MS)
    installStub([PENDING_ROW], { readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)] })

    expect(await approve(PLAIN, false)).toBe(APPROVER_STOP_CAP)

    expect(calls.sendKeysCalls.length).toBeGreaterThan(0)
    expectNoRecord()
  })
})

// ---------------------------------------------------------------------------
// The approver's first lap as the input to the record of CSCB's own launch
// (b.jg5 SRJ-412, SRJ-401; E17's kept first-lap launch start)
// ---------------------------------------------------------------------------

/**
 * Run `body` on a recovery harness built with `harnessNow` (so the launch
 * call's window is on the harness clock) and the approver stopping at B, not
 * the test cap, over persona P's pending-row model: no row, so `h.launch(p)`
 * is a plain spawn that leaves a new `pending` launch whose launch start lies
 * inside the call's window, held at a prompt the approver does not know. The
 * harness's lines are leak-checked and it is cleaned up whatever happens.
 */
async function onOwnLaunchHarness(body: (h: RecoveryHarness, p: string, row: PendingRowModel) => Promise<void>): Promise<void> {
  const h = makeRecoveryHarness({ harnessNow: true })
  try {
    h.setApproverCap(undefined)
    const p = h.keys[0]!
    await body(h, p, makePendingRowModel(h, p, { state: PENDING_ROW_MODEL_NO_ROW, dialog: PENDING_ROW_DIALOG_UNRECOGNISED }))
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

describe('the approver\'s first lap that keeps a launch start is the input to the record of CSCB\'s own launch (b.jg5 SRJ-412, SRJ-401)', () => {
  test('a first lap whose status read fails keeps no launch start and records nothing; the next lap that reads the row pending records its launch start as CSCB\'s own, in the launch call\'s window', async () => {
    await onOwnLaunchHarness(async (h, p, row) => {
      // The approver's first status read (no other status is made while it runs) answers UNAVAILABLE.
      const modelStatus = (h.stub.calls as StubClientOptions).statusFn!
      let failed = false
      h.script({
        statusFn: (params) => {
          if (failed || !isDialogApproverRunning(p)) return modelStatus(params)
          failed = true
          return errTmuxUnresponsive('status')
        },
      })

      await h.launch(p)
      await h.settle()

      expect(failed).toBe(true)
      expect([h.approverRunning(p), dialogApproverLaunchStart(p), ownLaunchRecordOf(p)]).toEqual([true, undefined, undefined])
      expect(isCscbOwnLaunch(p, row.launchStartedAt())).toBe(false)

      // UNAVAILABLE backs off: the next lap comes at the slow pace.
      await h.advance(DIALOG_SLOW_POLL_INTERVAL_MS)

      expect(dialogApproverLaunchStart(p)).toBe(row.launchStartMs())
      expect(ownLaunchRecordOf(p)).toEqual({ launchStartMs: row.launchStartMs()!, window: launchCallWindowOf(p)! })
      expect(isCscbOwnLaunch(p, row.launchStartedAt())).toBe(true)
    })
  })

  test('a later lap that reads another launch start stops the approver as superseded and leaves the record as the first lap set it, past the approver\'s stop', async () => {
    await onOwnLaunchHarness(async (h, p, row) => {
      await h.launch(p)
      await h.settle()
      const own = row.launchStartedAt()
      const ownMs = row.launchStartMs()!
      const recorded = ownLaunchRecordOf(p)
      expect(recorded).toEqual({ launchStartMs: ownMs, window: launchCallWindowOf(p)! })

      const other = launchByAnotherProcess(h, row, ownMs + DIALOG_POLL_INTERVAL_MS)

      expect(await h.runApproverToStop(p)).toEqual({ reason: APPROVER_STOP_SUPERSEDED, launchStartMs: ownMs })
      // The kept launch start ends with the approver; the record does not.
      expect(dialogApproverLaunchStart(p)).toBeUndefined()
      expect(ownLaunchRecordOf(p)).toBe(recorded)
      expect([isCscbOwnLaunch(p, own), isCscbOwnLaunch(p, other)]).toEqual([true, false])
    })
  })
})

// ---------------------------------------------------------------------------
// The approver registry (b.jg5 SRJ-401, SRJ-404; hatch A2)
// ---------------------------------------------------------------------------

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

/** A newer launch's `pending` row: its launch start differs from the stub's default. */
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
  /** The installed latch's log lines. */
  let latchLines: string[]

  const keyOfId = new Map(PERSONAS.map((p) => [p.id, p.key]))
  const call = (verb: ApproverVerb, id: string): string => `${verb} ${id}`

  /** A CONFLICT another site met (a pane read outside the approver), with which it latches a persona. */
  const OTHER_SITE_ROW = CONFLICT_CASE_ROWS.find((row) => !isApproverSite(row.site) && row.verb === 'read-pane')!

  /**
   * Install a latch through the session manager's installer
   * (`setConflictLatch`): the latch itself, which registers the approver's
   * stop as a set observer, or, with `withSetObserver` false, a view of it
   * with no `addSetObserver`, so only the approver's own latch checks can
   * stop it.
   */
  function installLatch(withSetObserver: boolean): ConflictLatch {
    const latch = createConflictLatch({
      log: (line) => {
        latchLines.push(line)
      },
    })
    setConflictLatch(
      withSetObserver
        ? latch
        : { isLatched: latch.isLatched, record: latch.record, set: latch.set, setFromConflict: latch.setFromConflict },
    )
    return latch
  }

  /** Latch persona `who` as another site does, through the latch's CONFLICT entry. */
  function latchElsewhere(latch: ConflictLatch, who: ApproverPersona): void {
    latch.setFromConflict(who.key, OTHER_SITE_ROW.build(), {
      refusedOperation: OTHER_SITE_ROW.refusedOperation,
      rowState: OTHER_SITE_ROW.rowState,
    })
  }

  beforeEach(() => {
    _resetDialogApprovers()
    latchLines = []
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
    assertNoLeak(latchLines)
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

  /**
   * The reasons the stop entry is asked for one key with: the teardown's
   * (b.jg5 SRJ-404, SRJ-715), apply step 1's once the key is recorded as
   * retired (b.jg5 SRJ-808), whose recorded calls end at that stop, and the
   * stuck-launch abort's (b.jg5 SRJ-412), whose kill follows only once the
   * stop has resolved.
   */
  const STOP_ENTRY_REASONS: ReadonlyArray<typeof APPROVER_STOP_TEARDOWN | typeof APPROVER_STOP_RETIRED_KEY | typeof APPROVER_STOP_STUCK_LAUNCH_ABORT> = [
    APPROVER_STOP_TEARDOWN,
    APPROVER_STOP_RETIRED_KEY,
    APPROVER_STOP_STUCK_LAUNCH_ABORT,
  ]

  test.each(STOP_ENTRY_REASONS.map((reason) => [reason] as const))('a stop (%s) between laps ends P\'s approver at once with no further call and one line naming the reason; Q\'s goes on; a second stop and a stop of a key with no approver answer false and log nothing; no timer is left', async (reason) => {
    rows.set(PLAIN.id, [PENDING_ROW])
    rows.set(NAMED.id, [PENDING_ROW])
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    startDialogApprover(NAMED.key, true, NAMED.ref)
    await clock.flush()
    expect(callsOf(PLAIN)).toEqual(lap(PLAIN, 'status', 'read-pane'))
    const at = clock.now()
    const fired = clock.firedCount()

    expect(await stopDialogApprover(PLAIN.key, reason)).toBe(true)

    // Ended during its sleep: no timer fired and no time passed.
    expect(clock.now()).toBe(at)
    expect(clock.firedCount()).toBe(fired)
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(isDialogApproverRunning(NAMED.key)).toBe(true)
    expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason, launchStartMs: LAUNCH_START_MS })
    const stopLine = approverLogLine(approverStopRequestedMessage(PLAIN.ref, reason))
    expect(stopLine).toContain(`(${reason}): `)
    expect(approverLines()).toEqual([stopLine])

    expect(await stopDialogApprover(PLAIN.key, reason)).toBe(false)
    expect(await stopDialogApprover(personaKey('never-started'), reason)).toBe(false)
    expect(approverLines()).toEqual([stopLine])

    // Q's next lap runs; P makes no call.
    const mark = events.length
    await clock.runNext()
    expect(events.slice(mark)).toEqual(lap(NAMED, 'status', 'read-pane'))

    rows.set(NAMED.id, [LIVE_ROW])
    expect(await runUntilStopped(NAMED)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
    expect(callsOf(PLAIN)).toEqual(lap(PLAIN, 'status', 'read-pane'))
    expect(clock.pending()).toEqual([])
  })

  /** [the call held open, the calls of the lap up to and including it]. */
  const HELD: ReadonlyArray<readonly [ApproverVerb, readonly ApproverVerb[]]> = [
    ['status', ['status']],
    ['read-pane', ['status', 'read-pane']],
    ['send-keys', ['status', 'read-pane', 'send-keys']],
  ]

  test.each(HELD.flatMap(([verb, upTo]) => STOP_ENTRY_REASONS.map((reason) => [verb, reason, upTo] as const)))(
    'a stop while its %s is in progress (row pending, the pane showing a needle), asked with the %s reason: resolves only after that call returns, and no call follows it',
    async (verb, reason, upTo) => {
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const hold = holdNext(verb, PLAIN)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)

      const stop = track(stopDialogApprover(PLAIN.key, reason))
      await clock.flush()
      expect(stop.settled).toBe(false)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)

      hold.release()
      await clock.flush()
      expect(stop.value).toBe(true)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
      expect(events).toEqual(lap(PLAIN, ...upTo))
      expect(sendKeysCount(PLAIN)).toBe(verb === 'send-keys' ? 1 : 0)
      expect(clock.pending()).toEqual([])
      expect((await _whenDialogApproverStopped(PLAIN.key))?.reason).toBe(reason)
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, reason))])
    },
  )

  // b.jg5 SRJ-412, SRJ-1017: the record follows the send-keys answer, not the
  // stop's reason, so a stop asked during that call still leaves it set.
  test.each(STOP_ENTRY_REASONS.map((reason) => [reason] as const))(
    'a stop (%s) asked while its send-keys is in progress, that send-keys then answering ErrSpawnNotInteractive: the stop asked decides the reason, with its one line, and the launch start kept is still recorded',
    async (reason) => {
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const hold = holdNext('send-keys', PLAIN)
      failures.set(call('send-keys', PLAIN.id), errSpawnNotInteractiveLeftover(undefined, 'send-keys'))
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)
      expect(launchMetSendKeysNotInteractive(PLAIN.key, SAMPLE_LAUNCH_START_DEFAULT)).toBe(false)

      const stop = track(stopDialogApprover(PLAIN.key, reason))
      await clock.flush()
      hold.release()
      await clock.flush()

      expect(stop.value).toBe(true)
      expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason, launchStartMs: LAUNCH_START_MS })
      expect(events).toEqual(lap(PLAIN, 'status', 'read-pane', 'send-keys'))
      expect(launchMetSendKeysNotInteractive(PLAIN.key, SAMPLE_LAUNCH_START_DEFAULT)).toBe(true)
      expect(launchMetSendKeysNotInteractive(PLAIN.key, LAUNCH_START_MS)).toBe(true)
      expect(launchMetSendKeysNotInteractive(NAMED.key, SAMPLE_LAUNCH_START_DEFAULT)).toBe(false)
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, reason))])
    },
  )

  test("a latch of Q set by another site stops Q's approver at once with no further call; P's goes on, and a latch of P then stops it the same way (b.jg5 SRJ-502)", async () => {
    const latch = installLatch(true)
    rows.set(PLAIN.id, [PENDING_ROW])
    rows.set(NAMED.id, [PENDING_ROW])
    startDialogApprover(PLAIN.key, true, PLAIN.ref)
    startDialogApprover(NAMED.key, true, NAMED.ref)
    await clock.flush()
    const at = clock.now()

    latchElsewhere(latch, NAMED)
    await clock.flush()
    expect(isDialogApproverRunning(NAMED.key)).toBe(false)
    expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
    expect(clock.now()).toBe(at)
    expect(await _whenDialogApproverStopped(NAMED.key)).toEqual({ reason: APPROVER_STOP_LATCHED, launchStartMs: LAUNCH_START_MS })

    // P's next lap runs; Q makes no call.
    const mark = events.length
    await clock.runNext()
    expect(events.slice(mark)).toEqual(lap(PLAIN, 'status', 'read-pane'))

    const fired = clock.firedCount()
    latchElsewhere(latch, PLAIN)
    await clock.flush()
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(clock.firedCount()).toBe(fired)
    expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason: APPROVER_STOP_LATCHED, launchStartMs: LAUNCH_START_MS })
    expect(callsOf(NAMED)).toEqual(lap(NAMED, 'status', 'read-pane'))
    expect(callsOf(PLAIN)).toEqual([...lap(PLAIN, 'status', 'read-pane'), ...lap(PLAIN, 'status', 'read-pane')])
    expect(approverLines()).toEqual([
      approverLogLine(approverStopRequestedMessage(NAMED.ref, APPROVER_STOP_LATCHED)),
      approverLogLine(approverStopRequestedMessage(PLAIN.ref, APPROVER_STOP_LATCHED)),
    ])
  })

  test.each(HELD)(
    'a latch of P set by another site while its %s is in progress (the pane showing a needle): that call returns, no call follows it, and it stops (latched) (b.jg5 SRJ-502)',
    async (verb, upTo) => {
      const latch = installLatch(true)
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const hold = holdNext(verb, PLAIN)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)

      latchElsewhere(latch, PLAIN)
      await clock.flush()
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)

      hold.release()
      await clock.flush()
      expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
      expect(events).toEqual(lap(PLAIN, ...upTo))
      expect(clock.pending()).toEqual([])
      expect((await _whenDialogApproverStopped(PLAIN.key))?.reason).toBe(APPROVER_STOP_LATCHED)
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, APPROVER_STOP_LATCHED))])
    },
  )

  /** [when P latches, the call held open while it latches (none: between laps), P's calls in all]. */
  const LATCHED_WHEN: ReadonlyArray<readonly [string, ApproverVerb | undefined, readonly ApproverVerb[]]> = [
    ['between laps', undefined, ['status', 'read-pane']],
    ['while its status is awaited', 'status', ['status']],
    ['while its read-pane is awaited (the pane showing a needle)', 'read-pane', ['status', 'read-pane']],
  ]

  test.each(LATCHED_WHEN)(
    'P latched %s through a latch with no set observer: the approver finds it latched before its next call, makes none, and stops (latched) with one line (b.jg5 SRJ-502)',
    async (_when, heldVerb, made) => {
      const latch = installLatch(false)
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, heldVerb === 'read-pane' ? dialogPane(TRUST_DIALOG_NEEDLE) : CLEAR_PANE)
      const hold = heldVerb === undefined ? undefined : holdNext(heldVerb, PLAIN)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      if (hold !== undefined) expect(hold.reached).toBe(true)

      latchElsewhere(latch, PLAIN)
      await clock.flush()
      expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
      hold?.release()

      expect(await runUntilStopped(PLAIN)).toEqual({
        reason: APPROVER_STOP_LATCHED,
        launchStartMs: heldVerb === 'status' ? undefined : LAUNCH_START_MS,
      })
      expect(events).toEqual(lap(PLAIN, ...made))
      expect(approverLines()).toEqual([approverLogLine(approverLatchedMessage(PLAIN.ref))])
    },
  )

  test("its own CONFLICT, running in the registry: P latches and the approver stops (latched) with its one line; the latch's set observer adds no stop line", async () => {
    const latch = installLatch(true)
    const row = APPROVER_CONFLICT_CASE_ROWS.find((caseRow) => caseRow.verb === 'read-pane')!
    rows.set(PLAIN.id, [PENDING_ROW])
    failures.set(call('read-pane', PLAIN.id), row.build())
    startDialogApprover(PLAIN.key, true, PLAIN.ref)

    expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LATCHED, launchStartMs: LAUNCH_START_MS })

    expect(events).toEqual(lap(PLAIN, 'status', 'read-pane'))
    expect(latch.record(PLAIN.key)).toEqual(conflictRowRecord(PLAIN.key, row))
    const lines = approverLines()
    expect(lines).toHaveLength(1)
    expectLineAroundOutcome(lines[0], (outcome) =>
      approverConflictMessage(PLAIN.ref, 'read-pane', describeAgentDirectorFailure(row.build()), outcome),
    )
  })

  /** The stops a caller asks of a running approver here: the stop entry's teardown, and stop-all's shutdown. */
  const ASKED_STOPS: ReadonlyArray<readonly [typeof APPROVER_STOP_TEARDOWN | typeof APPROVER_STOP_SHUTDOWN, () => Promise<unknown>]> = [
    [APPROVER_STOP_TEARDOWN, () => stopDialogApprover(PLAIN.key, APPROVER_STOP_TEARDOWN)],
    [APPROVER_STOP_SHUTDOWN, () => stopAllDialogApprovers()],
  ]

  /** The approver's CONFLICT row at its `read-pane`, and its UNUSABLE NAME row at its `send-keys`. */
  const STOP_CONFLICT_ROW = APPROVER_CONFLICT_CASE_ROWS.find((caseRow) => caseRow.verb === 'read-pane')!
  const STOP_UNUSABLE_NAME_ROW = APPROVER_UNUSABLE_NAME_CASE_ROWS.find((caseRow) => caseRow.verb === 'send-keys')!

  /**
   * A latching answer to a pane call held open while a stop is asked: [the
   * class, the held verb, its answer, the record P latches with, the
   * approver's line for it (around the latch outcome), the lap's calls].
   */
  const LATCHING_DURING_STOP: ReadonlyArray<
    readonly [string, ApproverVerb, () => Error, () => ConflictLatchRecord, (failure: string, outcome: string) => string, readonly ApproverVerb[]]
  > = [
    [
      'CONFLICT',
      'read-pane',
      () => STOP_CONFLICT_ROW.build(),
      () => conflictRowRecord(PLAIN.key, STOP_CONFLICT_ROW),
      (failure, outcome) => approverConflictMessage(PLAIN.ref, 'read-pane', failure, outcome),
      ['status', 'read-pane'],
    ],
    [
      'UNUSABLE NAME',
      'send-keys',
      () => STOP_UNUSABLE_NAME_ROW.build(),
      () => STOP_UNUSABLE_NAME_ROW.record(PLAIN.key),
      (failure, outcome) => approverUnusableNameMessage(PLAIN.ref, 'send-keys', failure, outcome),
      ['status', 'read-pane', 'send-keys'],
    ],
  ]

  test.each(LATCHING_DURING_STOP.flatMap(([cls, verb, make, record, line, upTo]) => ASKED_STOPS.map(([reason, ask]) => [cls, verb, reason, ask, make, record, line, upTo] as const)))(
    'a %s answer to its %s held open while a stop (%s) is asked: P latches once with the whole record and one line, the approver stops with the reason asked, and nothing is typed after it (b.jg5 SRJ-404, SRJ-501, SRJ-512)',
    async (_cls, verb, reason, ask, make, record, line, upTo) => {
      const latch = installLatch(true)
      const sets: ConflictLatchSetEvent[] = []
      latch.addSetObserver((event) => {
        sets.push(event)
      })
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const err = make()
      const hold = holdNext(verb, PLAIN)
      failures.set(call(verb, PLAIN.id), err)
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)

      const stop = track(ask())
      await clock.flush()
      expect(stop.settled).toBe(false)
      expect(latch.isLatched(PLAIN.key)).toBe(false)

      hold.release()
      await clock.flush()
      expect(stop.settled).toBe(true)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
      expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason, launchStartMs: LAUNCH_START_MS })
      expect(events).toEqual(lap(PLAIN, ...upTo))
      expect(sendKeysCount(PLAIN)).toBe(verb === 'send-keys' ? 1 : 0)
      expect(clock.pending()).toEqual([])

      expect(latch.record(PLAIN.key)).toEqual(record())
      expect(sets.map((event) => [event.key, event.outcome])).toEqual([[PLAIN.key, CONFLICT_LATCH_SET_LATCHED]])
      // The stop's own line, then the one latch line; the latch's set observer adds no stop line.
      const lines = approverLines()
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe(approverLogLine(approverStopRequestedMessage(PLAIN.ref, reason)))
      expectLineAroundOutcome(lines[1], (outcome) => line(describeAgentDirectorFailure(err), outcome))
    },
  )

  test.each(ASKED_STOPS)(
    'an UNAVAILABLE answer to its read-pane held open while a stop (%s) is asked: no latch and no line for it; the approver stops with the reason asked and types nothing',
    async (reason, ask) => {
      const latch = installLatch(true)
      rows.set(PLAIN.id, [PENDING_ROW])
      panes.set(PLAIN.id, dialogPane(TRUST_DIALOG_NEEDLE))
      const hold = holdNext('read-pane', PLAIN)
      failures.set(call('read-pane', PLAIN.id), errTmuxUnresponsive('read-pane'))
      startDialogApprover(PLAIN.key, true, PLAIN.ref)
      await clock.flush()
      expect(hold.reached).toBe(true)

      const stop = track(ask())
      await clock.flush()
      expect(stop.settled).toBe(false)

      hold.release()
      await clock.flush()
      expect(stop.settled).toBe(true)
      expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
      expect(await _whenDialogApproverStopped(PLAIN.key)).toEqual({ reason, launchStartMs: LAUNCH_START_MS })
      expect(events).toEqual(lap(PLAIN, 'status', 'read-pane'))
      expect(clock.pending()).toEqual([])
      expect([latch.isLatched(PLAIN.key), latch.record(PLAIN.key)]).toEqual([false, undefined])
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, reason))])
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
      expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(PLAIN.ref, APPROVER_STOP_SUPERSEDED))])

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

      // Backing off: the next lap comes at the slow pace.
      await clock.runNext()
      expect(clock.now()).toBe(SLOW)
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
    expect(approverLines()).toEqual([approverLogLine(approverStopRequestedMessage(NAMED.ref, APPROVER_STOP_SUPERSEDED))])

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
    const stopLines = PERSONAS.map((p) => approverLogLine(approverStopRequestedMessage(p.ref, APPROVER_STOP_SHUTDOWN)))
    expect([...approverLines()].sort()).toEqual([...stopLines].sort())

    const callsBefore = events.length
    expect(startDialogApprover(PLAIN.key, true, PLAIN.ref)).toBe(false)
    await clock.flush()
    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(events.length).toBe(callsBefore)
    expect(clock.pending()).toEqual([])
    expect(approverLines().slice(stopLines.length)).toEqual([approverLogLine(approverNotStartedMessage(PLAIN.ref, APPROVER_STOP_SHUTDOWN))])
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
    [APPROVER_STOP_CAP, () => [PENDING_ROW], LAUNCH_START_MS, () => _setDialogReadyTimeoutMs(DIALOG_POLL_INTERVAL_MS)],
  ]

  test.each(OWN_STOPS)('the await seam reports a registered approver\'s own stop (%s) with the launch start it kept', async (reason, answers, kept, setup) => {
    setup?.()
    rows.set(PLAIN.id, answers())
    startDialogApprover(PLAIN.key, false, PLAIN.ref)

    expect(await runUntilStopped(PLAIN)).toEqual({ reason, launchStartMs: kept })
    expect(sendKeysCount(PLAIN)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // The launch-timeout origin (b.jg5 SRJ-401, SRJ-404, SRJ-407): an approver
  // started after a launch timeout whose get read P's row covered follows
  // every stop rule as one started after a returned launch; the start entry
  // refuses a row that is not covered, undecided or has no launch start.
  // Its lap that reads this launch's row live ending the condition (SRJ-310
  // rule 3) is tests/tmux-unresponsive.test.ts's, where the launch sets the
  // record of this launch's row.
  // -------------------------------------------------------------------------

  /** The launch-timeout origin's start: the get read P's pending row covered, with the stub's default launch start. */
  const LAUNCH_TIMEOUT_START: ApproverStart = {
    origin: APPROVER_ORIGIN_LAUNCH_TIMEOUT,
    cover: { answer: PENDING_ROW_COVERED },
    launchStartedAt: SAMPLE_LAUNCH_START_DEFAULT,
  }

  /** Both origins, each with the lines its start logs: one for the launch-timeout origin, none after a returned launch. */
  const ORIGINS: ReadonlyArray<readonly [string, ApproverStart, (who: ApproverPersona) => string[]]> = [
    [APPROVER_ORIGIN_AFTER_LAUNCH, APPROVER_START_AFTER_LAUNCH, () => []],
    [APPROVER_ORIGIN_LAUNCH_TIMEOUT, LAUNCH_TIMEOUT_START, (who) => [approverLogLine(approverStartedAfterLaunchTimeoutMessage(who.ref))]],
  ]

  /**
   * One SRJ-404 stop rule, the same for both origins: the stub's answers for
   * P (and, for a class cell, the error its call answers with), what the case
   * does once the approver runs, the stop it resolves with, P's calls in
   * order (left out for B's many laps), and the approver's own lines after
   * the start's.
   */
  interface StopRule {
    readonly name: string
    setup(who: ApproverPersona): Error | undefined
    /** The approver's run once started: by default, fire timers until it stops. */
    run?(who: ApproverPersona, start: ApproverStart): Promise<ApproverOutcome | undefined>
    readonly reason: ApproverStopReason
    readonly kept: number | undefined
    readonly calls?: readonly ApproverVerb[]
    lines(who: ApproverPersona, err: Error | undefined): string[] | ((lines: string[]) => void)
  }

  const DEAD_STATE = [...AGENT_DIRECTOR_DEAD_STATES][0]!

  const STOP_RULES: readonly StopRule[] = [
    {
      name: 'a lap reading the row live',
      setup: (who) => void rows.set(who.id, [PENDING_ROW, LIVE_ROW]),
      reason: APPROVER_STOP_LIVE,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: () => [],
    },
    {
      name: 'a lap reading the row finished',
      setup: (who) => void rows.set(who.id, [PENDING_ROW, cannedStatusResult({ state: DEAD_STATE })]),
      reason: APPROVER_STOP_FINISHED,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: (who) => [approverLogLine(approverFinishedMessage(who.ref, DEAD_STATE))],
    },
    {
      name: 'a lap finding no row',
      setup: (who) => void rows.set(who.id, [PENDING_ROW, errSpawnNotFound()]),
      reason: APPROVER_STOP_ABSENT,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: (who) => [approverLogLine(approverAbsentMessage(who.ref))],
    },
    {
      name: 'a lap reading another launch start',
      setup: (who) => void rows.set(who.id, [PENDING_ROW, NEWER_PENDING_ROW]),
      reason: APPROVER_STOP_SUPERSEDED,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: (who) => [approverLogLine(approverLaunchStartChangedMessage(who.ref))],
    },
    {
      name: 'a later launch’s approver',
      setup: (who) => void rows.set(who.id, [PENDING_ROW]),
      run: async (who, start) => {
        startDialogApprover(who.key, false, who.ref, start)
        await clock.flush()
        const first = _whenDialogApproverStopped(who.key)
        expect(startDialogApprover(who.key, false, who.ref)).toBe(true)
        const outcome = await first
        // The later approver runs on, then stops on the row live.
        rows.set(who.id, [LIVE_ROW])
        expect((await runUntilStopped(who))?.reason).toBe(APPROVER_STOP_LIVE)
        return outcome
      },
      reason: APPROVER_STOP_SUPERSEDED,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: (who) => [approverLogLine(approverStopRequestedMessage(who.ref, APPROVER_STOP_SUPERSEDED))],
    },
    {
      name: 'GONE at its read-pane',
      setup: (who) => {
        rows.set(who.id, [PENDING_ROW])
        const err = errTmuxCaptureFailed(undefined, 'read-pane')
        failures.set(call('read-pane', who.id), err)
        return err
      },
      reason: APPROVER_STOP_GONE,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane'],
      lines: (who, err) => [approverLogLine(approverGoneMessage(who.ref, 'read-pane', describeAgentDirectorFailure(err)))],
    },
    {
      name: 'ErrSpawnNotInteractive at its Enter (a needle on screen)',
      setup: (who) => {
        rows.set(who.id, [PENDING_ROW])
        panes.set(who.id, dialogPane(TRUST_DIALOG_NEEDLE))
        const err = errSpawnNotInteractiveLeftover(undefined, 'send-keys')
        failures.set(call('send-keys', who.id), err)
        return err
      },
      reason: APPROVER_STOP_NOT_INTERACTIVE,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'send-keys'],
      lines: (who, err) => [approverLogLine(approverNotInteractiveMessage(who.ref, 'send-keys', describeAgentDirectorFailure(err)))],
    },
    {
      name: 'ENVIRONMENT (ErrTmuxNotAvailable) at its status',
      setup: (who) => {
        rows.set(who.id, [PENDING_ROW])
        const err = errTmuxNotAvailable(undefined, 'status')
        failures.set(call('status', who.id), err)
        return err
      },
      reason: APPROVER_STOP_TMUX_UNAVAILABLE,
      kept: undefined,
      calls: ['status'],
      lines: (who, err) => [approverLogLine(approverTmuxUnavailableMessage(who.ref, 'status', describeAgentDirectorFailure(err)))],
    },
    {
      name: 'UNAVAILABLE at its read-pane (polling goes on), then a lap reading the row live',
      setup: (who) => {
        rows.set(who.id, [PENDING_ROW, LIVE_ROW])
        const err = errTmuxUnresponsive('read-pane')
        failures.set(call('read-pane', who.id), err)
        return err
      },
      reason: APPROVER_STOP_LIVE,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane', 'status'],
      lines: (who, err) => [approverLogLine(approverPaneCallFailedMessage(who.ref, 'read-pane', describeAgentDirectorFailure(err)))],
    },
    {
      name: 'CONFLICT at its read-pane (P latched)',
      setup: (who) => {
        installLatch(true)
        rows.set(who.id, [PENDING_ROW])
        const err = STOP_CONFLICT_ROW.build()
        failures.set(call('read-pane', who.id), err)
        return err
      },
      reason: APPROVER_STOP_LATCHED,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane'],
      lines: (who, err) => (lines) => {
        expect(lines).toHaveLength(1)
        expectLineAroundOutcome(lines[0], (outcome) => approverConflictMessage(who.ref, 'read-pane', describeAgentDirectorFailure(err), outcome))
      },
    },
    {
      name: 'the test cap',
      setup: (who) => {
        _setDialogReadyTimeoutMs(DIALOG_POLL_INTERVAL_MS)
        rows.set(who.id, [PENDING_ROW])
        return undefined
      },
      reason: APPROVER_STOP_CAP,
      kept: LAUNCH_START_MS,
      calls: ['status', 'read-pane'],
      lines: (who) => [approverLogLine(approverCapMessage(who.ref, DIALOG_POLL_INTERVAL_MS))],
    },
    {
      name: 'B, from the launch start',
      setup: (who) => {
        // The approver starts once the launch call has returned, after the launch start.
        startClockAt(LAUNCH_START_MS + FAST)
        rows.set(who.id, [PENDING_ROW])
        return undefined
      },
      run: async (who, start) => {
        startDialogApprover(who.key, false, who.ref, start)
        const outcome = await runUntilStopped(who, MANY_TIMERS)
        expect(clock.now()).toBe(LAUNCH_START_MS + adLaunchBoundMsInEffect())
        return outcome
      },
      reason: APPROVER_STOP_BOUND,
      kept: LAUNCH_START_MS,
      lines: (who) => [approverLogLine(approverBoundMessage(who.ref, adLaunchBoundMsInEffect(), APPROVER_BOUND_FROM_LAUNCH_START))],
    },
  ]

  test.each(STOP_RULES.flatMap((rule) => ORIGINS.map(([origin, start, startLines]) => [rule.name, origin, rule, start, startLines] as const)))(
    'stop rule %s, the approver started from the %s origin: the same stop, the launch start kept, P\'s calls and the rule\'s lines as for every origin, after the start\'s own line',
    async (_name, _origin, rule, start, startLines) => {
      const err = rule.setup(PLAIN)

      const outcome = rule.run !== undefined ? await rule.run(PLAIN, start) : (startDialogApprover(PLAIN.key, false, PLAIN.ref, start), await runUntilStopped(PLAIN))

      expect(outcome).toEqual({ reason: rule.reason, launchStartMs: rule.kept })
      if (rule.calls !== undefined) expect(callsOf(PLAIN).slice(0, rule.calls.length)).toEqual(lap(PLAIN, ...rule.calls))
      if (rule.calls !== undefined && rule.run === undefined) expect(callsOf(PLAIN)).toEqual(lap(PLAIN, ...rule.calls))
      const lines = approverLines()
      const own = startLines(PLAIN)
      expect(lines.slice(0, own.length)).toEqual(own)
      const expected = rule.lines(PLAIN, err)
      if (typeof expected === 'function') expected(lines.slice(own.length))
      else expect(lines.slice(own.length)).toEqual(expected)
      expect(startupEntries()).toEqual([])
    },
  )

  /** The launch-timeout origin with `cover` and `launchStartedAt` (the raw field, `undefined` when absent) for the row the get read. */
  const timedOutStart = (cover: PendingRowCover, launchStartedAt: unknown): ApproverStart => ({
    origin: APPROVER_ORIGIN_LAUNCH_TIMEOUT,
    cover,
    launchStartedAt,
  })

  /** The rows the start entry refuses after a launch timeout, each with the reason its line names, if the decision has one. */
  const REFUSED_ROWS: ReadonlyArray<readonly [string, ApproverStart, string | undefined]> = [
    ['not covered: a retired key’s old life', timedOutStart({ answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_RETIRED_OLD_LIFE }, SAMPLE_LAUNCH_START_DEFAULT), PENDING_ROW_REASON_RETIRED_OLD_LIFE],
    ['not covered: a cwd that resolves elsewhere', timedOutStart({ answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_CWD_MISMATCH }, SAMPLE_LAUNCH_START_DEFAULT), PENDING_ROW_REASON_CWD_MISMATCH],
    ['not covered: a config_dir label missing or different', timedOutStart({ answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_CONFIG_DIR_MISMATCH }, SAMPLE_LAUNCH_START_DEFAULT), PENDING_ROW_REASON_CONFIG_DIR_MISMATCH],
    ['undecided: a cwd that cannot be compared now', timedOutStart({ answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CWD_UNRESOLVED }, SAMPLE_LAUNCH_START_DEFAULT), PENDING_ROW_REASON_CWD_UNRESOLVED],
    ['undecided: a claude_config_dir that cannot be resolved', timedOutStart({ answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED }, SAMPLE_LAUNCH_START_DEFAULT), PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED],
    ['no launch start, by the decision', timedOutStart({ answer: PENDING_ROW_NO_LAUNCH_START }, NO_LAUNCH_START_FORMS.absent), undefined],
    ...NO_LAUNCH_START_FORM_NAMES.map((form) => [`covered, but its launch start ${form}`, timedOutStart({ answer: PENDING_ROW_COVERED }, NO_LAUNCH_START_FORMS[form]), undefined] as const),
  ]

  test.each(REFUSED_ROWS)('after a launch timeout, a row %s gets no approver: the start entry answers false, makes no status, read-pane or send-keys, starts no timer and logs one line naming why', async (_what, start, reason) => {
    rows.set(PLAIN.id, [PENDING_ROW, LIVE_ROW])

    expect(startDialogApprover(PLAIN.key, false, PLAIN.ref, start)).toBe(false)
    await clock.flush()

    expect(isDialogApproverRunning(PLAIN.key)).toBe(false)
    expect(events).toEqual([])
    expect(clock.pending()).toEqual([])
    const lines = approverLines()
    expect(lines).toHaveLength(1)
    expectLineAroundOutcome(lines[0], (why) => approverRefusedRowMessage(PLAIN.ref, why))
    if (reason !== undefined) expect(lines[0]).toContain(reason)
  })

  test('a refused launch-timeout start leaves P\'s running approver alone: no supersede, and it goes on to its own stop', async () => {
    rows.set(PLAIN.id, [PENDING_ROW])
    startDialogApprover(PLAIN.key, false, PLAIN.ref)
    await clock.flush()
    const mark = events.length

    expect(startDialogApprover(PLAIN.key, false, PLAIN.ref, timedOutStart({ answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_CWD_MISMATCH }, SAMPLE_LAUNCH_START_DEFAULT))).toBe(false)
    await clock.flush()

    expect(events.slice(mark)).toEqual([])
    expect(isDialogApproverRunning(PLAIN.key)).toBe(true)
    rows.set(PLAIN.id, [LIVE_ROW])
    expect(await runUntilStopped(PLAIN)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: LAUNCH_START_MS })
    expect(approverLines().filter((line) => line.includes(approverLogLine(approverStopRequestedMessage(PLAIN.ref, APPROVER_STOP_SUPERSEDED))))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The pending-row rule's one run at the approver's stop (b.jg5 SRJ-404,
// SRJ-410; ruling R3)
//
// The rule is installed as `main()` installs it (`createPendingRowRule` over
// `buildPendingRowRuleDeps`, the session manager's clock on the case's fake
// clock), with a serializer that queues each turn until the case runs it, so
// a case sees the run asked for P's turn before any of its calls. Every
// typed stop reason has one case (the table is keyed by the reason type),
// driven through the registry's start entry; its hand-written `runs` must
// match both the export the arm reads (`approverStopArmsPendingRow`) and
// what happened: one turn for P and, once it runs, one lap `read-pane`
// (none after the approver's `send-keys` met `ErrSpawnNotInteractive`), one
// bypassing `find-missing` and one `get`, with one answer line; or no turn
// and no call after the stop. A stop whose last read was not `pending` with a
// launch start runs nothing. At B the run's held post is the only post; no
// kill or launch follows any stop.
// ---------------------------------------------------------------------------

/** One serializer turn the case holds: P's key and the operation, run when the case runs it. */
interface QueuedTurn {
  readonly key: string
  readonly run: () => Promise<void>
}

/** The stub's call counts by call list, leaving out the lists with none. */
function callCountsOf(log: StubCallLog): Record<string, number> {
  return Object.fromEntries(
    Object.entries(log)
      .filter(([, list]) => (list as unknown[]).length > 0)
      .map(([verb, list]) => [verb, (list as unknown[]).length]),
  )
}

/** The calls `after` holds beyond `before`, by call list, leaving out the lists with none. */
function countsSince(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(after).map(([verb, n]) => [verb, n - (before[verb] ?? 0)] as const).filter(([, n]) => n > 0))
}

describe('the pending-row rule runs once at the approver\'s stop, for the stops that leave the row to it (b.jg5 SRJ-404, SRJ-410)', () => {
  const who = PLAIN
  /** P's own row as the rule's `get` reads it: `pending`, with the stub's default launch start. */
  const PENDING_GET = cannedGetResult({ claude_instance_id: who.id, state: AGENT_DIRECTOR_PENDING_STATE })
  /** The test cap of the cap cases: past the approver's second slow lap, before its third. */
  const CAP_MS = SLOW + FAST
  /** The run's lap, its run and its get, as call-list counts. */
  const LAP_RUN_GET = { readPaneCalls: 1, findMissingCalls: 1, getCalls: 1 }
  /** The run and its get, with no lap. */
  const RUN_GET = { findMissingCalls: 1, getCalls: 1 }
  /** The answer of a run from G, before B, on a row the run did not judge. */
  const NOT_JUDGED: PendingRowRuleAnswer = { kind: PENDING_ROW_RULE_REFUSAL, reason: 'not-judged' }
  /** The answer of a run at B on a row never CSCB's own: the held text posted. */
  const HELD_POSTED: PendingRowRuleAnswer = { kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_POSTED }

  let turns: QueuedTurn[]
  let posts: Notice[]
  let episodeLines: string[]
  let episodes: PersonaEpisodes

  /** Install the rule as main() does, with a serializer that queues each turn, and `gate` when given (absent: no gate). */
  function installRule(gate?: RetryRunGateDeps): void {
    setPendingRowRule({
      rule: createPendingRowRule(buildPendingRowRuleDeps({ appliedPersona: () => undefined, episodes })),
      serialize: <T,>(key: string, operation: () => T | Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          turns.push({ key, run: () => Promise.resolve().then(operation).then(resolve, reject) })
        }),
      ...(gate === undefined ? {} : { gate }),
    })
  }

  beforeEach(() => {
    _resetDialogApprovers()
    _resetFindMissingMemo()
    turns = []
    posts = []
    episodeLines = []
    _setNow(() => clock.now())
    episodes = createPersonaEpisodes({
      sink: (key, text) => {
        posts.push({ key, text })
      },
      log: (line) => {
        episodeLines.push(line)
      },
      clock,
    })
    installRule()
  })

  afterEach(async () => {
    await runTurns()
    _resetPendingRowRule()
    _resetNow()
    _resetDialogApprovers()
    _resetFindMissingMemo()
    assertNoLeak({ posts, episodeLines })
  })

  /** Run every queued turn, in order, and let each finish. */
  async function runTurns(): Promise<void> {
    for (const turn of turns.splice(0)) await turn.run()
    await clock.flush()
  }

  /** Fire timers until P's registered approver has stopped; answers its outcome. */
  async function untilStopped(maxTimers = MANY_TIMERS): Promise<ApproverOutcome | undefined> {
    for (let fired = 0; ; fired++) {
      await clock.flush()
      if (!isDialogApproverRunning(who.key)) return _whenDialogApproverStopped(who.key)
      if (fired >= maxTimers) throw new Error(`the approver did not stop within ${maxTimers} timers`)
      await clock.runNext()
    }
  }

  /** The head of every line of the run at the stop (its round, its answer, its drop). */
  const runHead = `${PENDING_ROW_RULE_LOG_HEAD} ${who.ref} rule (${PENDING_ROW_RULE_ORIGIN_APPROVER_STOP}): `
  /** The session manager's lines for the run at the stop: its answer, or its drop. */
  const approverStopRunLines = (): string[] =>
    errLines.filter((line) => line.startsWith(`${runHead}its dialog approver stopped (`) || line.startsWith(`${runHead}dropped`))

  /** The clock at G past the stub's default launch start: the rule acts on a row read `pending` from then on. */
  const startAtG = (): void => startClockAt(LAUNCH_START_MS + adGraceMsInEffect())

  /** How a case ends P's approver, and what follows the stop. */
  interface StopCase {
    /** Installs the stub (and anything else the stop needs) on the clock at G. */
    readonly arrange: () => void
    /** Stops the approver from outside once its first lap has run; unset, it runs to its own stop. */
    readonly stop?: () => Promise<unknown>
    /** Whether the approver's last `status` read gave the row `pending` with a launch start. */
    readonly pendingRead: boolean
    /** Written by hand: whether the rule runs once after this stop. */
    readonly runs: boolean
    /** The run's calls, when it runs. */
    readonly calls?: Record<string, number>
    /** The run's answer, when it runs. */
    readonly answer?: PendingRowRuleAnswer
    /** The launch start the approver last read, which the run uses. */
    readonly lastLaunchStart?: string
  }

  const pendingNoDialog = (knobs: Omit<StubClientOptions, keyof StubCallLog | 'statusFn'> = {}): void =>
    installStub([PENDING_ROW], { getResult: PENDING_GET, ...knobs })

  /** One case per typed stop reason: the key type makes a new reason fail the typecheck until it has a case. */
  const STOP_CASES: { readonly [R in ApproverStopReason]: StopCase } = {
    // B, from the launch start: the run at B gives the held post on a row never CSCB's own.
    [APPROVER_STOP_BOUND]: {
      arrange: () => pendingNoDialog(),
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: HELD_POSTED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    [APPROVER_STOP_CAP]: {
      arrange: () => {
        _setDialogReadyTimeoutMs(CAP_MS)
        pendingNoDialog()
      },
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    [APPROVER_STOP_GONE]: {
      arrange: () => pendingNoDialog({ readPaneQueue: [cannedErr(errTmuxCaptureFailed())] }),
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    // b.jg5 SRJ-118: no further lap on a launch whose send-keys met ErrSpawnNotInteractive.
    [APPROVER_STOP_NOT_INTERACTIVE]: {
      arrange: () => pendingNoDialog({ readPaneResults: [dialogPane(TRUST_DIALOG_NEEDLE)], sendKeysQueue: [cannedErr(errSpawnNotInteractiveLeftover(undefined, 'send-keys'))] }),
      pendingRead: true,
      runs: true,
      calls: RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    [APPROVER_STOP_TMUX_UNAVAILABLE]: {
      arrange: () => pendingNoDialog({ readPaneQueue: [cannedErr(errTmuxNotAvailable(undefined, 'read-pane'))] }),
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    // The one-approver rule: a later lap reads another launch start; the run uses that last read.
    [APPROVER_STOP_SUPERSEDED]: {
      arrange: () => installStub([PENDING_ROW, NEWER_PENDING_ROW], { getResult: PENDING_GET }),
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_WHOLE,
    },
    // Ruling R3: a loop that threw (its clock failing after a lap read the row pending) gets the one run.
    [APPROVER_STOP_FAILED]: {
      arrange: () => {
        let failing = false
        pendingNoDialog({
          readPaneFn: () => {
            failing = true
            return undefined
          },
        })
        const base = clock
        _setApproverClock({
          now: () => {
            if (failing) throw new Error('the approver clock failed')
            return base.now()
          },
          setTimeout: (callback, delayMs) => base.setTimeout(callback, delayMs),
          clearTimeout: (handle) => base.clearTimeout(handle),
        })
      },
      pendingRead: true,
      runs: true,
      calls: LAP_RUN_GET,
      answer: NOT_JUDGED,
      lastLaunchStart: SAMPLE_LAUNCH_START_DEFAULT,
    },
    // No pending row is left: a live, finished, absent row, or one with no launch start.
    [APPROVER_STOP_LIVE]: { arrange: () => installStub([LIVE_ROW]), pendingRead: false, runs: false },
    [APPROVER_STOP_FINISHED]: { arrange: () => installStub([cannedStatusResult({ state: LIVENESS_DEAD_ROW_ENDED })]), pendingRead: false, runs: false },
    [APPROVER_STOP_ABSENT]: { arrange: () => installStub([errSpawnNotFound()]), pendingRead: false, runs: false },
    [APPROVER_STOP_NO_LAUNCH_START]: {
      arrange: () => installStub([cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: NO_LAUNCH_START_FORMS[NO_LAUNCH_START_FORM_NAMES[0]!] })]),
      pendingRead: false,
      runs: false,
    },
    // SRJ-404: the row is pending, yet these stops leave it to no run.
    [APPROVER_STOP_LATCHED]: {
      arrange: () => {
        setConflictLatch(createConflictLatch({ log: () => {} }))
        const row = APPROVER_CONFLICT_CASE_ROWS.find((caseRow) => caseRow.verb === 'read-pane')!
        pendingNoDialog({ readPaneQueue: [cannedErr(row.build())] })
      },
      pendingRead: true,
      runs: false,
    },
    [APPROVER_STOP_TEARDOWN]: { arrange: () => pendingNoDialog(), stop: () => stopDialogApprover(who.key, APPROVER_STOP_TEARDOWN), pendingRead: true, runs: false },
    // E25: the retired-key recording's stop; the recorded calls end at it.
    [APPROVER_STOP_RETIRED_KEY]: { arrange: () => pendingNoDialog(), stop: () => stopDialogApprover(who.key, APPROVER_STOP_RETIRED_KEY), pendingRead: true, runs: false },
    [APPROVER_STOP_SHUTDOWN]: { arrange: () => pendingNoDialog(), stop: () => stopAllDialogApprovers(), pendingRead: true, runs: false },
    // b.jg5 SRJ-404, SRJ-412: the stuck-launch abort's own stop, through the
    // abort's stop entry, its kill to follow; no run after it.
    [APPROVER_STOP_STUCK_LAUNCH_ABORT]: {
      arrange: () => pendingNoDialog(),
      stop: () => stopApproverForStuckLaunchAbort(who.key),
      pendingRead: true,
      runs: false,
    },
  }

  test.each(Object.entries(STOP_CASES) as Array<[ApproverStopReason, StopCase]>)(
    'a stop (%s): the run follows exactly when the reason is in the run set and the last read was pending with a launch start, once, in P\'s serializer turn; no kill or launch',
    async (reason, row) => {
      startAtG()
      row.arrange()
      expect(startDialogApprover(who.key, false, who.ref)).toBe(true)
      if (row.stop !== undefined) {
        await clock.flush()
        await row.stop()
      }
      expect((await untilStopped())?.reason).toBe(reason)

      // The run set is the arm's (`approverStopArmsPendingRow`); the hand column pins it.
      expect(approverStopArmsPendingRow(reason) && row.pendingRead).toBe(row.runs)
      // Asked for P's turn; nothing called before the turn runs.
      expect(turns.map((turn) => turn.key)).toEqual(row.runs ? [who.key] : [])
      const atStop = callCountsOf(calls)
      await runTurns()

      expect(countsSince(callCountsOf(calls), atStop)).toEqual(row.runs ? row.calls! : {})
      expect(approverStopRunLines()).toEqual(row.runs ? [pendingRowRuleApproverStopLine(who.ref, reason, row.answer!)] : [])
      if (row.runs) {
        // The run read the approver's last read: its round line names that launch start.
        const roundHead = `${runHead}launch started ${describeLaunchStartForLog(row.lastLaunchStart)}; `
        expect(errLines.filter((line) => line.startsWith(roundHead))).toHaveLength(1)
      }
      expect(posts).toEqual(row.answer?.kind === PENDING_ROW_RULE_HELD ? [{ key: who.key, text: stuckLaunchHeldText(who.key, SAMPLE_LAUNCH_START_DEFAULT, false) }] : [])
      expect([calls.killCalls, calls.spawnCalls, calls.resumeCalls, calls.deleteCalls]).toEqual([[], [], [], []])
    },
  )

  /** Stops in the run set whose last read leaves no `pending` row with a launch start. */
  const NO_PENDING_READ: ReadonlyArray<readonly [string, ApproverStopReason, () => void]> = [
    [
      'the test cap after its last status read a state CSCB does not know',
      APPROVER_STOP_CAP,
      () => {
        _setDialogReadyTimeoutMs(CAP_MS)
        installStub([PENDING_ROW, cannedStatusResult({ state: 'hibernating' })], { getResult: PENDING_GET })
      },
    ],
    ['ErrTmuxNotAvailable at its first status (no row read)', APPROVER_STOP_TMUX_UNAVAILABLE, () => installStub([errTmuxNotAvailable(undefined, 'status')], { getResult: PENDING_GET })],
  ]

  test.each(NO_PENDING_READ)('%s: a stop in the run set (%s) runs nothing; no turn, no call after the stop', async (_name, reason, arrange) => {
    startAtG()
    arrange()
    startDialogApprover(who.key, false, who.ref)
    expect((await untilStopped())?.reason).toBe(reason)
    expect(approverStopArmsPendingRow(reason)).toBe(true)
    const atStop = callCountsOf(calls)

    await runTurns()

    expect(turns).toEqual([])
    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([])
  })

  test('before G the run makes no call: its answer is the refusal for a row younger than G, and nothing is posted', async () => {
    startClockAt(LAUNCH_START_MS)
    _setDialogReadyTimeoutMs(CAP_MS)
    pendingNoDialog()
    startDialogApprover(who.key, false, who.ref)
    expect((await untilStopped())?.reason).toBe(APPROVER_STOP_CAP)
    const atStop = callCountsOf(calls)

    await runTurns()

    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopLine(who.ref, APPROVER_STOP_CAP, { kind: PENDING_ROW_RULE_REFUSAL, reason: 'younger-than-g' })])
    expect(posts).toEqual([])
  })

  test('the run happens once, whatever stops are asked afterwards: a later teardown or shutdown stop asks no second turn and makes no call', async () => {
    startAtG()
    _setDialogReadyTimeoutMs(CAP_MS)
    pendingNoDialog()
    startDialogApprover(who.key, false, who.ref)
    expect((await untilStopped())?.reason).toBe(APPROVER_STOP_CAP)
    await runTurns()
    const afterRun = callCountsOf(calls)

    expect(await stopDialogApprover(who.key, APPROVER_STOP_TEARDOWN)).toBe(false)
    await stopAllDialogApprovers()
    await runTurns()

    expect(turns).toEqual([])
    expect(countsSince(callCountsOf(calls), afterRun)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopLine(who.ref, APPROVER_STOP_CAP, NOT_JUDGED)])
  })

  test('a run still queued when the shutdown begins is dropped with one line and no call', async () => {
    startAtG()
    _setDialogReadyTimeoutMs(CAP_MS)
    pendingNoDialog()
    startDialogApprover(who.key, false, who.ref)
    expect((await untilStopped())?.reason).toBe(APPROVER_STOP_CAP)
    expect(turns.map((turn) => turn.key)).toEqual([who.key])
    const atStop = callCountsOf(calls)

    await stopAllDialogApprovers()
    await runTurns()

    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopDroppedLine(who.ref)])
  })

  // b.jg5 SRJ-404, SRJ-305, SRJ-303: the installed gate is the retry
  // action's (`retryRunGateStop`), asked when the run's turn starts. Its
  // stops for a persona removed, latched, held, not up or at the cap, and a
  // teardown queued ahead, are tests/pending-row.test.ts's, end to end; here:
  // when it is asked, its open answer, its shutdown, its throws and the
  // server's own shutdown ahead of it.

  /** P as the applied configuration holds it. */
  const APPLIED = makeMultiPersonaConfig([{ name: who.name }], tmpdir()).personas[0]!

  /** A gate over P with every stop open, recording each member asked as `[member, key]`, `changed` members replaced. */
  function recordingGate(changed: Partial<RetryRunGateDeps> = {}): { gate: RetryRunGateDeps; asked: Array<readonly [string, string | undefined]> } {
    const asked: Array<readonly [string, string | undefined]> = []
    const open: RetryRunGateDeps = {
      isShuttingDown: () => false,
      appliedPersona: (key) => (key === who.key ? APPLIED : undefined),
      isLatched: () => false,
      isHeld: () => false,
      canRelaunch: () => true,
      isAtCap: () => false,
    }
    const members = { ...open, ...changed }
    const gate = Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        name,
        (key?: string) => {
          asked.push([name, key])
          return (member as (key?: string) => unknown)(key)
        },
      ]),
    ) as unknown as RetryRunGateDeps
    return { gate, asked }
  }

  /** P's approver stopped at the test cap at G, its run queued and not yet run; the call counts at the stop. */
  async function capStopQueued(): Promise<Record<string, number>> {
    startAtG()
    _setDialogReadyTimeoutMs(CAP_MS)
    pendingNoDialog()
    startDialogApprover(who.key, false, who.ref)
    expect((await untilStopped())?.reason).toBe(APPROVER_STOP_CAP)
    expect(turns.map((turn) => turn.key)).toEqual([who.key])
    return callCountsOf(calls)
  }

  test('a gate with every stop open is asked for P only once the run\'s turn starts, never at the stop, and the run is the one with no gate', async () => {
    const { gate, asked } = recordingGate()
    installRule(gate)
    const atStop = await capStopQueued()
    expect(asked).toEqual([])

    await runTurns()

    expect(asked).toContainEqual(['appliedPersona', who.key])
    expect(asked.filter(([, key]) => key !== undefined && key !== who.key)).toEqual([])
    expect(countsSince(callCountsOf(calls), atStop)).toEqual(LAP_RUN_GET)
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopLine(who.ref, APPROVER_STOP_CAP, NOT_JUDGED)])
  })

  test('the gate\'s own shutdown read drops the run with the gated line naming the retry action\'s shutdown stop, and no call', async () => {
    installRule(recordingGate({ isShuttingDown: () => true }).gate)
    const atStop = await capStopQueued()

    await runTurns()

    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopGatedLine(who.ref, UNAVAILABLE_RETRY_STOP_SHUTDOWN)])
    expect(posts).toEqual([])
  })

  test('the server\'s shutdown, begun while the run waits, drops it with the shutdown line before the gate is asked', async () => {
    const { gate, asked } = recordingGate({ appliedPersona: () => undefined })
    installRule(gate)
    const atStop = await capStopQueued()

    await stopAllDialogApprovers()
    await runTurns()

    expect(asked).toEqual([])
    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopDroppedLine(who.ref)])
  })

  /** A gate member's failure. */
  const GATE_FAILURE = new Error('the gate member failed')
  const throwing = (): never => {
    throw GATE_FAILURE
  }

  // A latched or held query that throws counts as latched or held (the retry
  // action's fail-safe, with its own line); any other member that throws
  // fails the gate, which counts as stopped.
  test.each<readonly [keyof RetryRunGateDeps, string]>([
    ['isLatched', UNAVAILABLE_RETRY_STOP_LATCHED],
    ['isHeld', UNAVAILABLE_RETRY_STOP_HELD],
    ['isShuttingDown', pendingRowRuleApproverStopGateFailedWhy(describeThrownValue(GATE_FAILURE))],
    ['appliedPersona', pendingRowRuleApproverStopGateFailedWhy(describeThrownValue(GATE_FAILURE))],
    ['canRelaunch', pendingRowRuleApproverStopGateFailedWhy(describeThrownValue(GATE_FAILURE))],
    ['isAtCap', pendingRowRuleApproverStopGateFailedWhy(describeThrownValue(GATE_FAILURE))],
  ])('a gate whose %s throws: the run is dropped with one gated line (%s), no call and no post', async (member, why) => {
    installRule(recordingGate({ [member]: throwing }).gate)
    const atStop = await capStopQueued()

    await runTurns()

    expect(countsSince(callCountsOf(calls), atStop)).toEqual({})
    expect(approverStopRunLines()).toEqual([pendingRowRuleApproverStopGatedLine(who.ref, why)])
    expect(posts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Focused source audit (SRJ-601's approver part)
// ---------------------------------------------------------------------------

describe('source audit: the approver\'s raw tmux path, its seams, the dead-state streak and its spawn-failure notice at B are gone (b.jg5 SRJ-402, SRJ-405, SRJ-601)', () => {
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
    '_setDialogPollIntervalMs',
    '_resetDialogPollIntervalMs',
    'DIALOG_READY_STATES',
    'DIALOG_DEAD_STATES',
    // The spawn-failure notice the approver posted at its cap (b.jg5 SRJ-405).
    'DialogApprovalTimeout',
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
