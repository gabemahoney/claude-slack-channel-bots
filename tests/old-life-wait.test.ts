/**
 * old-life-wait.test.ts — The old-life hold: start and end (b.jg5 SRJ-809;
 * SRJ-703's old-life clause, SRJ-714's sweep holds, SRJ-715's teardown hold,
 * SRJ-812's kill-failed mark), and the old-life wait's steps (SRJ-811,
 * SRJ-812, SRJ-1512). E27 T1 builds the holds; T2 the wait's steps; T3
 * (what a hold refuses, SRJ-810, SRJ-809's admission clause, AC 53, and the
 * gates that start a wait in production) extends this file.
 *
 * - The hold set (`createOldLifeHoldSet`, src/retired-keys.ts) over its own
 *   log: begin, a second begin on one instance id (only the cause changes;
 *   the held directory is kept and the declared one ignored), the directory's
 *   replacement, the end with its observers; directories compared by real
 *   path (a symlinked path) with the lexical fallback (a missing path), both
 *   inside the case's `mkdtempSync` directory, beside a control directory;
 *   two holds on one directory ending apart; who waits on a hold (a persona
 *   in its directory, the persona whose own `cscb_<key>` is held); the
 *   kill-failed mark; the old key a row gives (`oldLifeKeyOf`).
 * - The end rule at the session manager's one read entry
 *   (`noteOldLifeRowRead`): a read of `ended` or `missing`, no row, and a
 *   listing in a `find-missing` run's `ids` end the hold, each with one line
 *   built by the module; `pending`, any live state and a state CSCB does not
 *   know keep it, a live read's `cwd` re-pointing it; another id's read ends
 *   nothing; with no set installed nothing happens. Which reads reach the
 *   entry is tests/session-manager.test.ts's and tests/server.test.ts's.
 * - One case per start: apply step 1's holds (`oldLifeHoldsToBegin`, pure;
 *   which holds a confirmed apply begins, and when, are
 *   tests/reload-apply.test.ts's), and, end to end on the reload harness's
 *   real launch, a removal's or a rename's hold re-pointed to the old row's
 *   `cwd` by a later live read (`run.oldLifeHolds`); the start
 *   sweep's failed kills (an absent persona's row, a live pre-persona row,
 *   a row swept for its instance id and one swept for its `cwd`, Q-9), and
 *   apply step 1 begun later on a row the sweep held at its real `cwd`
 *   (the hold stays there, not on the declared directory); the
 *   sweep's `list` of a live row of a key recorded without its mark, killed,
 *   kept or spared for a latch, `pending` included; none for a marked key, a
 *   finished row or a key not recorded; none once the sweep's shutdown
 *   query answers true.
 * - Ends that are not kill outcomes (AC 54, AC 63): a teardown kill and a
 *   sweep kill, whatever they answer (a success with `kill_sent` true or
 *   false, gone, a CONFLICT, an UNUSABLE NAME, UNAVAILABLE, a failure), end
 *   no hold; only the tries that decided the ordinary kill-failure alert
 *   mark it kill-failed (SRJ-812), a failure after a survivor-naming one
 *   (UNAVAILABLE, a CONFLICT) included, never the survivor version.
 * - The new life: a reuse that begins the key's new life ends its hold,
 *   also when the mark's write failed; another key's reuse ends none.
 * - The restart: holds live in memory; a fresh harness over a record where
 *   P is recorded without its mark (a `credentials_file` destructive modify
 *   whose teardown kill failed) keeps P's own live row, whose `cwd` matches
 *   P, and begins its hold; a row that reads `ended` rebuilds none.
 *
 * - The wait (E27 T2), started through the session manager's ensure entry
 *   (`h.startOldLifeWait`, `h.runOldLifeWait`) on an old row held at P's
 *   working directory, so P waits on it, for each id form (a renamed-away
 *   key's own `cscb_<old>`, a pre-persona row's id, an id that is not its
 *   label's `cscb_<key>`, and P's own row): its calls are the kill, the
 *   `status` reads between tries, the `get`s and the bypassing runs, all on
 *   the old id, with no launch and no timer for the old key; a configured
 *   persona's own row in a run's `unverified_ids` gets its one `get`; a
 *   wait and a live-row sequence never run at once on one id (held
 *   `find-missing`). Its results by class (SRJ-811, SRJ-702, SRJ-717,
 *   SRJ-1002, SRJ-1013), for every id form, UNAVAILABLE and ENVIRONMENT at
 *   the kill and at the `get` and UNAVAILABLE at a run included: what the
 *   calls are, the round's one end line, whether the hold goes on and is
 *   marked kill-failed (SRJ-812), the waiting persona armed uncounted, the
 *   outages raised for it, the kill-failure alert's own line (its version on
 *   the not-configured, log-only route), the exact startup-errors entries
 *   (`persona-kill-failed`, `persona-kill-survivor`,
 *   `persona-teardown-notice` "during the wait"), no latch and no post;
 *   ENVIRONMENT raising `tmux-unavailable` and CONFIG
 *   `ad-config-malformed` for the waiting persona, a later round's
 *   successful call clearing `ad-config-malformed` but never
 *   `tmux-unavailable`; UNCLASSIFIED reported once per round that keeps the
 *   hold to the wait's own unclassified-error episode on the held id (E12:
 *   nothing at the first round, the one log-only `persona-unclassified-error`
 *   entry at the first round past the alert threshold, none later; the
 *   hold's end ends it; a round a shutdown stopped reports nothing); the
 *   session a stand-in id's alert names (the start sweep's listing, else
 *   "unknown"); an UNUSABLE NAME at a `get`, a run or a `status` read
 *   routed; SRJ-408's old `pending` row with no launch start killed and run
 *   at once; a configured persona's own row stopping at that persona's
 *   latch (a read latch keeps the ordinary alert and marks the hold; a
 *   latched persona's row gets no kill and no `get`; the persona latched
 *   between the kill's tries, by the keep-going check, is the configured
 *   persona's stop: one line naming the latch, no `persona-kill-failed`
 *   entry, while a shutdown there still writes the old key's entry), a
 *   waiting persona's
 *   latch never stopping a wait on another id, and two waiters' own
 *   launching sequences starting beside a wait on another id. The wait's
 *   ends (its hold's end, the registry's close), its kill keeping its tries
 *   while no persona is up and stopped by a shutdown (AC 64), and a hold
 *   that ends while its kill runs (SRJ-811's Test line, option A): between
 *   tries (also when a new hold is begun on the id before the next try), at
 *   the `status` read, during the third try that answers UNAVAILABLE, in the
 *   very try that names the survivor, and in the same window as a shutdown
 *   stop, each a success. Step 5's exact alert text per id form is
 *   tests/live-row-sequence.test.ts's. A wait round that a configured
 *   persona's own-row latch stopped arms only the waiting personas that are
 *   not latched (SRJ-305), with one latched line for each that is; a
 *   waiting persona not up or held on `ErrInvalidFlags` is never armed (one
 *   skip line at each arm) and not retried at its hold's end (SRJ-305). The
 *   start sweep's listing of a same-key row `pending` seeds its hold's first
 *   wait `pending`, so with `ad-config-malformed` raised that wait makes no
 *   kill (SRJ-316).
 *
 * - What a hold refuses (E27 T3; SRJ-810, SRJ-1502, SRJ-1505, SRJ-809's
 *   admission clause, SRJ-811's persona-waits half), on the harness that
 *   composes the gate, the restart hook, the reconnect guard, the admission
 *   driver (`h.admitSession`) and the end-retry observer
 *   (`h.holdEndRetries`) as `main()` does: AC 53 for a renamed-away key's old
 *   life in the directory a different persona names and for a destructive
 *   modify's same-key old life (a session from D refused as held with one
 *   line, the reconnect guard and P's restart run typing nothing into the
 *   old life, D P's again once the hold ends), and after a restart the sweep's
 *   rebuilt hold refusing a session from P's directory; the launch gate end
 *   to end (no call for Q, sequence-waiting, the wait started once, Q armed
 *   uncounted, B beside it up, Q retried at once at the clock time of the
 *   end with a plain first spawn); SRJ-810's same-key exception (the new
 *   half's reuse collides and its sequence replaces the old life, no gate);
 *   each failed sweep-kill source of Q-9 making P wait on that row's id; a
 *   persona already running when its directory becomes held (no call from its
 *   restart run until the hold ends, then nothing left to recover); and
 *   what stops the wait: the only waiter's teardown (with no further call,
 *   and between its kill's tries with the stopped-retry line and the old
 *   key's `persona-kill-failed` entry with no alert text, AC 64), never a
 *   teardown while another persona waits (its kill keeps its tries), and a
 *   shutdown. The multi-waiter setup production reaches (two personas in
 *   one directory are refused by config validation): B's own row swept for
 *   its `cwd` into P's directory, its kill failed; P's gate starts the wait
 *   on `cscb_<B>` and B's relaunch, refused `already-running`, records B as
 *   waiting. The hold's end retries P at once and B only once the stopped
 *   wait has settled (its deferred segment and its settled line), B removed
 *   or latched meanwhile not retried; B's teardown as the last waiter stops
 *   the wait.
 *
 * Every harness case but one runs on `makeRecoveryHarness`, whose one hold
 * set is built and installed as `main()` builds and installs it; its sweep is
 * `h.startSweep` on the harness clock. The one exception is the start-1 end
 * to end case, which runs on `makeReloadHarness` (its real launch and its
 * hold set, `run.oldLifeHolds`). Each harness case leak-checks everything
 * its harness captured and leaves no fake-clock timer pending. Labels, line
 * texts and read names come from src/retired-keys.ts and
 * src/session-manager.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Phase1ListRow } from '../src/ad-phase1-types.ts'
import {
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  killFailedDescriptionOf,
} from '../src/ad-error-class.ts'
import { adAlertThresholdMsInEffect } from '../src/ad-settings.ts'
import { getFailureCount } from '../src/backoff.ts'
import type { PersonaConfig, PersonaInput } from '../src/config.ts'
import { latchRowStateRead } from '../src/conflict-latch.ts'
import {
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  KILL_FAILURE_ROUTE_NOT_CONFIGURED,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  type KillFailureAlertVersion,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_ORDINARY, KILL_RETRY_ALERT_SURVIVOR, KILL_RETRY_TRIES, killRetryHoldEndedLine, type KillRetryAlert } from '../src/kill-retry.ts'
import {
  LIVE_ROW_OUTCOME_ABORTED,
  LIVE_ROW_OUTCOME_CONFIG_MALFORMED,
  LIVE_ROW_OUTCOME_ESCALATED,
  LIVE_ROW_OUTCOME_LAUNCHED,
  LIVE_ROW_OUTCOME_NOT_JUDGED,
  LIVE_ROW_OUTCOME_STOPPED,
  LIVE_ROW_SEQUENCE_MAX_RUNS,
  LIVE_ROW_SEQUENCE_STEP3_RUNS,
  LIVE_ROW_START_ALREADY_RUNNING,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_STOP_HOLD_ENDED,
  LIVE_ROW_STOP_LATCHED,
  LIVE_ROW_STOP_SHUTDOWN,
  LIVE_ROW_STOP_TEARDOWN,
  type LiveRowSequenceOutcome,
  type LiveRowSequenceStopReason,
} from '../src/live-row-sequence.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
} from '../src/liveness-reading.ts'
import {
  OLD_LIFE_WAIT_END_CALL_FAILED,
  OLD_LIFE_WAIT_END_CONFIG,
  OLD_LIFE_WAIT_END_ENVIRONMENT,
  OLD_LIFE_WAIT_END_ESCALATED,
  OLD_LIFE_WAIT_END_HOLD_ENDED,
  OLD_LIFE_WAIT_END_KILL_FAILED,
  OLD_LIFE_WAIT_END_LATCHED,
  OLD_LIFE_WAIT_END_NOT_JUDGED,
  OLD_LIFE_WAIT_END_REFUSED,
  OLD_LIFE_WAIT_END_STOPPED,
  OLD_LIFE_WAIT_END_UNAVAILABLE,
  OLD_LIFE_WAIT_AT_FIND_MISSING,
  OLD_LIFE_WAIT_AT_GET,
  OLD_LIFE_WAIT_AT_KILL,
  OLD_LIFE_WAIT_AT_STATUS_READ,
  OLD_LIFE_WAIT_SITE,
  oldLifeWaitRef,
  oldLifeWaitRefusalNoticeText,
  type OldLifeWaitEndKind,
  type OldLifeWaitRefusal,
  type OldLifeWaitRefusalAt,
} from '../src/old-life-wait.ts'
import { getOutageFlags, raiseAdConfigMalformed, type OutageClass } from '../src/outage-state.ts'
import { PERSONA_UNCLASSIFIED_ERROR_LABEL, UNCLASSIFIED_ERROR_END_HOLD_ENDED, killFailureStoppedRetryText, unclassifiedErrorAlertText } from '../src/persona-episodes.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { personaInstanceId, personaTmuxSessionName } from '../src/persona-identity.ts'
import { PERSONA_TEARDOWN_NOTICE_DURING_WAIT, personaTeardownNoticeEntryText } from '../src/persona-notifier.ts'
import { oldLifeHoldsToBegin } from '../src/reload.ts'
import { buildChangePlan, type ValidChangePlan } from '../src/reload-plan.ts'
import { sessionHeldRefusalLine } from '../src/registry.ts'
import {
  RESTART_OUTCOME_RECONNECT_DEFERRED,
  RESTART_OUTCOME_SEQUENCE_WAITING,
  restartOldLifeHeldLine,
  runRestartRetry,
} from '../src/restart.ts'
import {
  OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL,
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING,
  OLD_LIFE_HOLD_END_FIND_MISSING_IDS,
  OLD_LIFE_HOLD_END_NEW_LIFE,
  OLD_LIFE_HOLD_END_READ_ENDED,
  OLD_LIFE_HOLD_END_READ_MISSING,
  OLD_LIFE_HOLD_LOG_PREFIX,
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY,
  RETIRED_KEY_CAUSE_REMOVED,
  createOldLifeHoldSet,
  oldLifeHoldBeganLine,
  oldLifeHoldEndObserverFailedLine,
  oldLifeHoldEndedLine,
  oldLifeKeyOf,
  type OldLifeHold,
  type OldLifeHoldBegin,
  type OldLifeHoldCause,
  type OldLifeHoldEndReason,
  type OldLifeHoldSet,
  type RetiredKeyCause,
} from '../src/retired-keys.ts'
import {
  OLD_LIFE_HOLD_END_NOT_RETRIED_HELD,
  OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED,
  OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_APPLIED,
  OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_UP,
  OLD_LIFE_HOLD_WAIT_RUNNING,
  OLD_LIFE_NEW_LIFE_READ,
  OLD_LIFE_ROW_READ_FIND_MISSING_IDS,
  OLD_LIFE_ROW_READ_NO_ROW,
  OLD_LIFE_ROW_READ_STATE,
  OLD_LIFE_WAIT_STOP_CAUSE_LATCHED,
  OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN,
  OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN,
  OWN_ROW_READ_ROW,
  SPAWN_ACTION_FRESH_RETIRED,
  _resetOldLifeHolds,
  ensureOldLifeWait,
  isLaunchInFlight,
  killPersonaInstanceForTeardown,
  noteOldLifeRowRead,
  oldLifeHoldEndRetryLine,
  oldLifeHoldEndSettledRetryLine,
  oldLifeHoldLaunchLine,
  oldLifeHoldStep,
  oldLifeWaitHeldLine,
  oldLifeWaitLatchedLine,
  oldLifeWaitNotUpLine,
  oldLifeWaitRefusalLine,
  oldLifeWaitUnclassifiedEntryText,
  oldLifeWaitTeardownLine,
  oldLifeWaitUnclassifiedNotReportedLine,
  readPersonaOwnRow,
  reconnectMcpWithCause,
  setOldLifeHolds,
  setOldLifeWaitBindings,
  startLiveRowSequence,
  waitsOnKillFailedHold,
  type OldLifeRowRead,
} from '../src/session-manager.ts'
import { UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD, UNAVAILABLE_RETRY_ROW_ABSENT, UNAVAILABLE_RETRY_RUN_NOW_RAN } from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedListRow,
  cannedOk,
  cannedStatusResult,
  errConfigMalformed,
  errInstanceIdCollision,
  errInternal,
  errSpawnNotFound,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnusableName,
  holdFindMissing,
  provenanceNote,
  SAMPLE_LAUNCH_START_NONE,
  type CannedGetResult,
  type FindMissingHold,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import { LAUNCH_START_ABSENT_PERSONA_KEY } from './test-helpers/conflict-cases.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  PRE_PERSONA_ID,
  PRE_PERSONA_LABELS,
  absentRow,
  beginApplyHold,
  gateLine,
  gateLinesIn,
  heldBack,
  holdOldAt,
  listed,
  settledRetryLinePrefix,
  sweepOver,
  waitEndLine,
  waitEndLinePrefix,
} from './test-helpers/old-life.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  adConfigMalformedRaiseLines,
  launchThroughSequence,
  makeRecoveryHarness,
  ownRowsLiveThenMissing,
  pastSampleGrace,
  personaCallCounts,
  personaOf,
  personaRow,
  recordCallOrder,
  killFailureLines,
  killFailureLoggedLine,
  holdThroughReuse,
  killFailureStoppedEntryLine,
  rowReadsUntilSpawn,
  startSequenceHeldAtRun,
  startupEntries,
  unavailableAt,
  unclassifiedEndedLine,
  unclassifiedStartedLine,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import { makeReloadHarness, type ReloadHarness } from './test-helpers/reload-harness.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** What a case asserts of a hold: everything but the real path and the waiting personas. */
type HoldFields = Pick<OldLifeHold, 'instanceId' | 'oldKey' | 'directory' | 'cause' | 'killFailed'>

/** The fields a case asserts of `view`. */
function fieldsOf(view: OldLifeHold): HoldFields {
  return { instanceId: view.instanceId, oldKey: view.oldKey, directory: view.directory, cause: view.cause, killFailed: view.killFailed }
}

/** A hold as a case expects it. */
function hold(instanceId: string, oldKey: string, directory: string, cause: OldLifeHoldCause, killFailed = false): HoldFields {
  return { instanceId, oldKey, directory, cause, killFailed }
}

/** The lines the hold set logged among `lines`. */
function holdLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} `))
}

/** The begin lines among `lines`. */
function beganLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} began `))
}

/** The hold set's end lines among `lines` (not the end-retry observer's `ended for` line). */
function endedLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} ended on `))
}

/** A began-again line ends, before its closing requirement tag, with the tail saying the one hold is kept on its held directory. */
function expectBeganAgainTail(line: string): void {
  expect(line.replace(/ \([^()]*\)$/, '')).toEndWith(`— ${OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL}`)
}

let harness: RecoveryHarness | undefined

/** A recovery harness over P and B, cleaned up after the case. */
function build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string } {
  const h = (harness = makeRecoveryHarness(options))
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** Every harness case: no fake-clock timer left, nothing captured leaks, then the harness is cleaned up. */
function harnessAfterEach(): void {
  const h = harness
  harness = undefined
  if (h === undefined) return
  try {
    expect(h.clock.pendingCount()).toBe(0)
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

/** The harness's holds, in begin order, as a case asserts them. */
const holdsOf = (h: RecoveryHarness): HoldFields[] => h.oldLifeHolds.snapshot().map(fieldsOf)

/** A live pre-persona row (b.1ix): only the `service` and `channel` labels. */
function prePersonaRow(state = 'waiting'): Phase1ListRow {
  const id = `cscb_old_${state}_C0OLD`
  return cannedListRow({ claude_instance_id: id, state, labels: { ...PRE_PERSONA_LABELS }, tmux_session_name: id.replace(/^cscb_/, 'slack_bot_') })
}

// ---------------------------------------------------------------------------
// The hold set
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809: the hold set — begin, re-point, end, the real-path queries, who waits and the kill-failed mark', () => {
  let dir: string
  let lines: string[]
  let set: OldLifeHoldSet

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak(lines)
  })

  /** A fresh set over a fresh temp directory holding `real`, a symlink `link` to it and a control `other`; `missing` is never made. */
  function fresh(): { real: string; link: string; other: string; missing: string } {
    dir = mkdtempSync(join(tmpdir(), 'old-life-holds-'))
    lines = []
    set = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    const real = join(dir, 'real')
    const other = join(dir, 'other')
    mkdirSync(real)
    mkdirSync(other)
    const link = join(dir, 'link')
    symlinkSync(real, link)
    return { real, link, other, missing: join(dir, 'missing') }
  }

  test('a begin holds the directory with its old key and cause, unmarked and with no one waiting, and logs one began line naming the real path', () => {
    const { real, link } = fresh()

    const view = set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: link, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(view).toEqual({ instanceId: 'cscb_p', oldKey: 'p', directory: link, realDirectory: realpathSync(real), cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, killFailed: false, waiting: [] })
    expect(set.snapshot()).toEqual([view])
    expect(lines).toEqual([oldLifeHoldBeganLine(view)])
    expect(lines[0]).toContain(JSON.stringify(realpathSync(real)))
  })

  test('a second begin on one instance id keeps one hold on its held directory: only the cause changes, the declared directory ignored and the old key, mark and waiting personas kept; one began-again line naming the kept directory', () => {
    const { real, other } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })
    set.markKillFailed('cscb_p')
    set.recordWaiting('cscb_p', 'q')

    const view = set.begin({ instanceId: 'cscb_p', oldKey: 'other_key', directory: other, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })

    expect(set.snapshot()).toEqual([view])
    expect(fieldsOf(view)).toEqual(hold('cscb_p', 'p', real, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true))
    expect(view.waiting).toEqual(['q'])
    expect(set.holdsOnDirectory(other)).toEqual([])
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(oldLifeHoldBeganLine(view, true))
    expect(lines[1]).toContain(JSON.stringify(realpathSync(real)))
    expect(lines[1]).not.toContain(other)
    expect(lines[1]).not.toContain(realpathSync(other))
    expectBeganAgainTail(lines[1]!)
  })

  test('replaceDirectory re-points a held id with no line; the same directory or an id not held changes nothing', () => {
    const { real, other } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect([set.replaceDirectory('cscb_p', real), set.replaceDirectory('cscb_q', other)]).toEqual([false, false])
    expect(set.replaceDirectory('cscb_p', other)).toBe(true)

    expect(set.holdOf('cscb_p')?.directory).toBe(other)
    expect(set.holdsOnDirectory(real)).toEqual([])
    expect(lines).toHaveLength(1)
  })

  test('directories compare by real path: a hold on a symlink answers for its target and a hold on its target for the symlink; a missing path compares lexically; a control directory answers nothing', () => {
    const { real, link, other, missing } = fresh()
    set.begin({ instanceId: 'cscb_a', oldKey: 'a', directory: link, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: 'cscb_b', oldKey: 'b', directory: missing, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(set.holdsOnDirectory(real).map((h) => h.instanceId)).toEqual(['cscb_a'])
    expect(set.holdsOnDirectory(link).map((h) => h.instanceId)).toEqual(['cscb_a'])
    expect(set.holdsOnDirectory(join(dir, 'real', '..', 'missing')).map((h) => h.instanceId)).toEqual(['cscb_b'])
    expect(set.holdOf('cscb_b')?.realDirectory).toBe(missing)
    expect(set.holdsOnDirectory(other)).toEqual([])
  })

  test('two holds on one directory end independently: one end line each, observers told once per end in registration order; an id not held ends nothing and logs nothing', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_a', oldKey: 'a', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })
    set.begin({ instanceId: 'cscb_old', oldKey: 'cscb_old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const told: string[] = []
    set.onEnd((view, reason) => { told.push(`first ${view.instanceId} ${reason}`) })
    set.onEnd((view, reason) => { told.push(`second ${view.instanceId} ${reason}`) })
    const a = set.holdOf('cscb_a')!

    expect(set.end('cscb_a', OLD_LIFE_HOLD_END_READ_ENDED, 'a test read')).toEqual(a)
    expect(set.holdsOnDirectory(real).map((h) => h.instanceId)).toEqual(['cscb_old'])
    expect(set.end('cscb_a', OLD_LIFE_HOLD_END_READ_ENDED)).toBeUndefined()
    const old = set.holdOf('cscb_old')!
    set.end('cscb_old', OLD_LIFE_HOLD_END_FIND_MISSING_IDS)

    expect(set.snapshot()).toEqual([])
    expect(endedLinesIn(lines)).toEqual([
      oldLifeHoldEndedLine(a, OLD_LIFE_HOLD_END_READ_ENDED, 'a test read'),
      oldLifeHoldEndedLine(old, OLD_LIFE_HOLD_END_FIND_MISSING_IDS),
    ])
    expect(told).toEqual([
      `first cscb_a ${OLD_LIFE_HOLD_END_READ_ENDED}`,
      `second cscb_a ${OLD_LIFE_HOLD_END_READ_ENDED}`,
      `first cscb_old ${OLD_LIFE_HOLD_END_FIND_MISSING_IDS}`,
      `second cscb_old ${OLD_LIFE_HOLD_END_FIND_MISSING_IDS}`,
    ])
  })

  test('an observer that throws is logged once and stops neither the end nor the next observer; a removed observer is not told', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    const told: string[] = []
    const remove = set.onEnd(() => { told.push('removed') })
    const broken = new Error('observer broken')
    set.onEnd(() => {
      throw broken
    })
    set.onEnd((view) => { told.push(view.instanceId) })
    remove()

    set.end('cscb_p', OLD_LIFE_HOLD_END_READ_MISSING)

    expect(set.holdOf('cscb_p')).toBeUndefined()
    expect(told).toEqual(['cscb_p'])
    expect(lines.filter((line) => line === oldLifeHoldEndObserverFailedLine('cscb_p', describeThrownValue(broken)))).toHaveLength(1)
  })

  test('who waits: a persona whose working directory is the held directory (by real path) and the persona whose own cscb_<key> is held; the waiting record is named in the end line and forgotten per persona', () => {
    const { real, link, other } = fresh()
    set.begin({ instanceId: 'cscb_old', oldKey: 'old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: personaInstanceId('own'), oldKey: 'own', directory: other, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })

    expect(set.holdsWaitedOnBy({ key: 'neighbour', working_directory: link }).map((h) => h.instanceId)).toEqual(['cscb_old'])
    expect(set.holdsWaitedOnBy({ key: 'own', working_directory: join(dir, 'elsewhere') }).map((h) => h.instanceId)).toEqual([personaInstanceId('own')])
    expect(set.holdsWaitedOnBy({ key: 'stranger', working_directory: join(dir, 'elsewhere') })).toEqual([])

    expect([set.recordWaiting('cscb_old', 'neighbour'), set.recordWaiting('cscb_old', 'gone'), set.recordWaiting('cscb_none', 'neighbour')]).toEqual([true, true, false])
    set.forgetWaiting('gone')
    const view = set.holdOf('cscb_old')!
    expect(view.waiting).toEqual(['neighbour'])
    set.end('cscb_old', OLD_LIFE_HOLD_END_READ_ENDED)
    expect(endedLinesIn(lines)).toEqual([oldLifeHoldEndedLine(view, OLD_LIFE_HOLD_END_READ_ENDED)])
    expect(endedLinesIn(lines)[0]).toContain('waiting personas: neighbour ')
  })

  test('the kill-failed mark: set only on a held id, read through each persona waiting on it, and lasting until the hold ends', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_old', oldKey: 'old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const waiter = { key: 'neighbour', working_directory: real }

    expect(set.waitsOnKillFailed(waiter)).toBe(false)
    expect([set.markKillFailed('cscb_none'), set.markKillFailed('cscb_old')]).toEqual([false, true])
    expect([set.holdOf('cscb_old')?.killFailed, set.waitsOnKillFailed(waiter)]).toEqual([true, true])
    set.end('cscb_old', OLD_LIFE_HOLD_END_READ_MISSING)
    expect(set.waitsOnKillFailed(waiter)).toBe(false)
  })

  test('two sets share nothing', () => {
    const { real } = fresh()
    const second = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(second.snapshot()).toEqual([])
    expect(second.holdsOnDirectory(real)).toEqual([])
  })

  test.each<[string, string, unknown, string]>([
    ['the persona label\'s own cscb_<key>', 'cscb_p', 'p', 'p'],
    ['no persona label (a pre-persona row)', PRE_PERSONA_ID, undefined, PRE_PERSONA_ID],
    ['an empty persona label', 'cscb_p', '', 'cscb_p'],
    ['an instance id that is not the label\'s cscb_<key> (swept for its instance id)', 'cscb_p_old', 'p', 'cscb_p_old'],
  ])('oldLifeKeyOf: %s gives the old key %s→%s', (_label, instanceId, label, oldKey) => {
    expect(oldLifeKeyOf(instanceId, label)).toBe(oldKey)
  })
})

// ---------------------------------------------------------------------------
// The end rule at the one read entry
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809: the one read entry ends a hold only on a read of ended or missing, no row, or a find-missing run\'s ids', () => {
  let dir: string
  let lines: string[]
  let set: OldLifeHoldSet

  /** A set installed as the session manager's, holding `cscb_p` and `cscb_q` in a fresh directory. */
  function installed(): { work: string; other: string } {
    dir = mkdtempSync(join(tmpdir(), 'old-life-entry-'))
    const work = join(dir, 'work')
    const other = join(dir, 'other')
    mkdirSync(work)
    mkdirSync(other)
    lines = []
    set = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    setOldLifeHolds(set)
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: work, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: 'cscb_q', oldKey: 'q', directory: work, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    return { work, other }
  }

  afterEach(() => {
    _resetOldLifeHolds()
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak(lines)
  })

  test.each<[string, OldLifeRowRead, OldLifeHoldEndReason, string]>([
    ['a read of ended', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, OLD_LIFE_HOLD_END_READ_ENDED, 'site: a read'],
    ['a read of missing', { kind: OLD_LIFE_ROW_READ_STATE, state: 'missing' }, OLD_LIFE_HOLD_END_READ_MISSING, 'site: a read'],
    ['no row (ErrSpawnNotFound)', { kind: OLD_LIFE_ROW_READ_NO_ROW }, OLD_LIFE_HOLD_END_READ_MISSING, 'site: a read: no row'],
    ['a listing in a find-missing run\'s ids', { kind: OLD_LIFE_ROW_READ_FIND_MISSING_IDS }, OLD_LIFE_HOLD_END_FIND_MISSING_IDS, 'site: a read'],
  ])('%s of cscb_p ends its hold with one line naming the read; cscb_q\'s hold on the same directory stays', (_label, read, reason, named) => {
    installed()
    const before = set.holdOf('cscb_p')!

    noteOldLifeRowRead('cscb_p', read, 'site: a read')

    expect(set.snapshot().map((h) => h.instanceId)).toEqual(['cscb_q'])
    expect(endedLinesIn(lines)).toEqual([oldLifeHoldEndedLine(before, reason, named)])
  })

  test.each([AGENT_DIRECTOR_PENDING_STATE, 'waiting', 'working', 'ask_user', 'check_permission', 'hibernating'])('a read of %s keeps the hold, logging nothing; its cwd re-points it, with no line', (state) => {
    const { work, other } = installed()

    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state }, 'site: a read')
    expect(set.holdOf('cscb_p')?.directory).toBe(work)
    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state, cwd: other }, 'site: a read')

    expect(set.holdOf('cscb_p')?.directory).toBe(other)
    expect(set.holdOf('cscb_q')?.directory).toBe(work)
    expect(holdLinesIn(lines)).toHaveLength(2)
  })

  test('a read of another id ends nothing; with the set removed, a read of ended ends nothing', () => {
    installed()

    noteOldLifeRowRead('cscb_other', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, 'site: a read')
    _resetOldLifeHolds()
    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, 'site: a read')

    expect(set.snapshot().map((h) => h.instanceId)).toEqual(['cscb_p', 'cscb_q'])
    expect(endedLinesIn(lines)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Start 1: apply step 1 (the pure begin list)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 start 1: apply step 1 holds each key it records at the old declaration\'s working directory (oldLifeHoldsToBegin)', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The applied configuration: alpha, beta, gamma and delta, under a fresh directory. */
  function appliedConfig(): PersonaConfig {
    dir = mkdtempSync(join(tmpdir(), 'old-life-apply-'))
    return makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }, { name: 'delta' }], dir)
  }

  /** The plan of `candidate` over `applied`, paths compared as written. */
  function planOf(applied: PersonaConfig, candidate: PersonaConfig): ValidChangePlan {
    const plan = buildChangePlan(applied, { kind: 'valid', config: candidate }, { realPath: (p) => p, home: dir })
    if (!plan.valid) throw new Error('the candidate is not valid')
    return plan
  }

  /** `applied` with the personas `edit` gives. */
  function edited(applied: PersonaConfig, edit: (personas: PersonaConfig['personas']) => PersonaConfig['personas']): PersonaConfig {
    return { ...applied, personas: edit(applied.personas.map((p) => ({ ...p }))) }
  }

  /** The begin apply step 1 makes for `key` at `directory`. */
  const applyBegin = (key: string, directory: string): OldLifeHoldBegin => ({ instanceId: personaInstanceId(key), oldKey: key, directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

  test.each<[string, (personas: PersonaConfig['personas'], root: string) => PersonaConfig['personas'], (applied: PersonaConfig) => OldLifeHoldBegin[]]>([
    ['a removal (beta)', (ps) => ps.filter((p) => p.key !== 'beta'), (a) => [applyBegin('beta', a.personas[1]!.working_directory)]],
    ['a rename (beta to beta_two: the old key, never the new)', (ps) => ps.map((p) => (p.key === 'beta' ? { ...p, name: 'beta_two', key: 'beta_two' } : p)), (a) => [applyBegin('beta', a.personas[1]!.working_directory)]],
    ['a destructive modify of working_directory (gamma: the old directory)', (ps, root) => ps.map((p) => (p.key === 'gamma' ? { ...p, working_directory: join(root, 'gamma-new') } : p)), (a) => [applyBegin('gamma', a.personas[2]!.working_directory)]],
    ['a destructive modify of credentials_file (delta: its unchanged directory)', (ps, root) => ps.map((p) => (p.key === 'delta' ? { ...p, credentials_file: join(root, 'delta-new.env') } : p)), (a) => [applyBegin('delta', a.personas[3]!.working_directory)]],
    ['an added persona only (none)', (ps, root) => [...ps, { ...ps[0]!, name: 'epsilon', key: 'epsilon', index: 4, working_directory: join(root, 'epsilon') }], () => []],
    ['no change (none)', (ps) => ps, () => []],
  ])('%s', (_label, edit, expected) => {
    const applied = appliedConfig()
    const plan = planOf(applied, edited(applied, (ps) => edit(ps, dir)))

    expect(oldLifeHoldsToBegin(plan, applied)).toEqual(expected(applied))
  })

  test('a removal, a rename and two destructive modifies in one apply: the removed keys first, then the destructive ones in candidate order, each once', () => {
    const applied = appliedConfig()
    const [alpha, beta, gamma, delta] = applied.personas as [PersonaConfig['personas'][number], PersonaConfig['personas'][number], PersonaConfig['personas'][number], PersonaConfig['personas'][number]]
    const candidate = edited(applied, () => [
      { ...delta, credentials_file: join(dir, 'delta-new.env') },
      { ...beta, name: 'beta_two', key: 'beta_two' },
      { ...gamma, working_directory: join(dir, 'gamma-new') },
    ])

    expect(oldLifeHoldsToBegin(planOf(applied, candidate), applied)).toEqual([
      applyBegin('alpha', alpha.working_directory),
      applyBegin('beta', beta.working_directory),
      applyBegin('delta', delta.working_directory),
      applyBegin('gamma', gamma.working_directory),
    ])
  })
})

// ---------------------------------------------------------------------------
// Start 1 end to end: a later live read re-points apply step 1's hold
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 start 1 end to end: a later read of the old row as live with another cwd re-points apply step 1\'s hold to that cwd (real launch)', () => {
  let rh: ReloadHarness | undefined

  afterEach(async () => {
    const done = rh
    rh = undefined
    await done?.cleanup()
  })

  /** The read the case makes: the shared own-row `get`. */
  const SITE = { site: 'old-life-wait.test', what: 'own-row get' }

  /** Yield event-loop turns (no timer) until `cond` holds; fails if it never does. */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 1_000 && !cond(); i++) await new Promise((done) => setImmediate(done))
    expect(cond()).toBe(true)
  }

  // A rename's new half shares bravo's directory, so its bring-up is held back and starts the old-life wait on
  // cscb_bravo (installed, as main() installs it); that round's kill answers a CONFLICT too, so the row stays live,
  // the hold is kept and bravo2 is armed (SRJ-811). A removal has no persona waiting, so no wait starts.
  test.each<[string, (alpha: PersonaInput, bravo: PersonaInput) => PersonaInput[], string | undefined]>([
    ['a removal of bravo', (alpha) => [alpha], undefined],
    ['a rename of bravo to bravo2', (alpha, bravo) => [alpha, { ...bravo, name: 'bravo2' }], 'bravo2'],
  ])('%s, its teardown kill answering a CONFLICT (the row stays live): the hold on bravo\'s old directory moves to the row\'s cwd, its old key, cause and mark kept, with no line', async (_label, change, waiter) => {
    const r = (rh = makeReloadHarness())
    const alpha = r.persona('alpha')
    const bravo = r.persona('bravo')
    r.materialize(alpha, bravo)
    r.writeRecord({ personas: [alpha, bravo] })
    r.writeConfig({ personas: [alpha, bravo] })
    // The teardown's kill, then (a rename) the wait's first kill.
    const killQueue = Array.from({ length: waiter === undefined ? 1 : 2 }, (): KillAnswer => cannedErr(errTmuxSessionConflict('kill', 'different-id')))
    const run = await r.startDetecting({ realLaunch: true, agentDirector: { killQueue } })
    await run.ticks.tick()
    const bravoKey = r.key('bravo')
    const bravoId = personaInstanceId(bravoKey)
    const waiting = waiter === undefined ? [] : [r.key(waiter)]

    r.writeConfig({ personas: change(alpha, bravo) })
    await (await run.confirmPending()).applying
    await until(() => run.retryTimers!.armedKeys().length === waiting.length)
    expect(run.retryTimers!.armedKeys()).toEqual(waiting)

    const begun = run.oldLifeHolds.holdOf(bravoId)!
    expect(begun.waiting).toEqual(waiting)
    expect(fieldsOf(begun)).toEqual(hold(bravoId, bravoKey, bravo.working_directory, OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1))
    expect(r.rowOf('bravo')?.state).toBe('waiting')
    const elsewhere = join(r.root, 'elsewhere')
    mkdirSync(elsewhere)
    r.seedRow(bravo, { cwd: elsewhere })

    expect(await readPersonaOwnRow(bravoKey, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, row: { state: 'waiting', cwd: elsewhere } })

    expect(run.oldLifeHolds.snapshot()).toEqual([{ ...begun, directory: elsewhere, realDirectory: realpathSync(elsewhere) }])
    expect(run.oldLifeHolds.holdsOnDirectory(bravo.working_directory)).toEqual([])
    expect(run.oldLifeHolds.holdsWaitedOnBy({ key: r.key('alpha'), working_directory: elsewhere }).map((view) => view.instanceId)).toEqual([bravoId])
    expect(holdLinesIn(run.logs)).toEqual([oldLifeHoldBeganLine(begun)])
    expect(run.slackPosts()).toEqual([])
    // A waiting persona's retry timer is the only timer left.
    expect(run.clock.pendingCount()).toBe(waiting.length)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Starts 2 and 3: the start sweep
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 starts 2 and 3, SRJ-714: the start sweep holds the cwd of each live row it failed to kill and of each live row of a key recorded without its mark', () => {
  afterEach(harnessAfterEach)

  test('every kill failing (ErrTmuxKillFailed through the tries): an absent persona\'s row, a live pre-persona row, a row swept for its instance id and one swept for its cwd are each held at the row\'s cwd and marked kill-failed; the absent key, just recorded, was held by the listing first; one began line each; nothing ends them', async () => {
    const { h, b } = build()
    h.script({ killError: errTmuxKillFailed() })
    const pre = prePersonaRow()
    const absent = absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY)
    const bOld = listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })
    const bElsewhere = listed(h, b, { cwd: h.home })

    await sweepOver(h, [pre, absent, bOld, bElsewhere])

    expect([...new Set(h.stub.calls.killCalls.map((k) => k.claude_instance_id))]).toEqual([pre, absent, bOld, bElsewhere].map((row) => row.claude_instance_id))
    expect(holdsOf(h)).toEqual([
      hold(absent.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, absent.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING, true),
      hold(pre.claude_instance_id, pre.claude_instance_id, pre.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
      hold(bOld.claude_instance_id, bOld.claude_instance_id, bOld.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
      hold(personaInstanceId(b), b, h.home, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
    ])
    expect(beganLinesIn(h.errors)).toEqual(h.oldLifeHolds.snapshot().map((view) => oldLifeHoldBeganLine(view)))
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test('P\'s own row swept for its cwd D0, its kill failing, then apply step 1 begun on cscb_<P> at P\'s declared directory D1: the one hold stays on D0, now apply step 1\'s and still kill-failed, D1 is not held, and the began-again line names D0, not D1', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxKillFailed() })
    const d0 = h.home
    const d1 = personaOf(h, p).working_directory
    expect(realpathSync(d0)).not.toBe(realpathSync(d1))

    await sweepOver(h, [listed(h, p, { cwd: d0 })])
    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, d0, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true)])

    const view = beginApplyHold(h, p)

    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, d0, OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, true)])
    expect(h.oldLifeHolds.holdsOnDirectory(d1)).toEqual([])
    expect(h.oldLifeHolds.holdsOnDirectory(d0).map((held) => held.instanceId)).toEqual([personaInstanceId(p)])
    const began = beganLinesIn(h.errors)
    expect(began).toHaveLength(2)
    expect(began[1]).toBe(oldLifeHoldBeganLine(view, true))
    expect(began[1]).toContain(JSON.stringify(realpathSync(d0)))
    expect(began[1]).not.toContain(JSON.stringify(realpathSync(d1)))
    expectBeganAgainTail(began[1]!)
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test.each([...AGENT_DIRECTOR_LIVE_STATES])('an absent persona\'s row listed %s, its kill succeeding: held at its cwd from the listing (its key recorded by this sweep, no mark), unmarked, and the kill ends nothing', async (state) => {
    const { h } = build()
    const row = absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY, { state })

    await sweepOver(h, [row])

    expect(h.stub.calls.killCalls.map((k) => k.claude_instance_id)).toEqual([row.claude_instance_id])
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(beganLinesIn(h.errors)).toHaveLength(1)
  })

  test.each<[string, (h: RecoveryHarness, p: string) => Phase1ListRow, (h: RecoveryHarness, p: string) => string]>([
    ['P\'s own row in its directory: kept, with no kill', (h, p) => listed(h, p), (_h, p) => p],
    ['P\'s own row listed pending (a launch start): kept, with no kill', (h, p) => listed(h, p, { state: AGENT_DIRECTOR_PENDING_STATE }), (_h, p) => p],
    ['P\'s own row carrying provenance_conflict: spared for P\'s latch, with no kill', (h, p) => listed(h, p, { liveness_note: provenanceNote }), (_h, p) => p],
    ['P\'s row under another instance id: swept and killed, its instance id the old key', (h, p) => listed(h, p, { claude_instance_id: `${personaInstanceId(p)}_old` }), (_h, p) => `${personaInstanceId(p)}_old`],
  ])('P recorded without its mark, %s: one listing hold at the row\'s cwd', async (_label, row, oldKey) => {
    const { h, p } = build()
    h.retireKey(p)
    const listedRow = row(h, p)

    await sweepOver(h, [listedRow])

    expect(holdsOf(h)).toEqual([hold(listedRow.claude_instance_id, oldKey(h, p), listedRow.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(beganLinesIn(h.errors)).toEqual([oldLifeHoldBeganLine(h.oldLifeHolds.snapshot()[0]!)])
  })

  test.each<[string, (h: RecoveryHarness, p: string, b: string) => Phase1ListRow[]]>([
    ['P recorded with its mark set, its own row live', (h, p) => {
      h.retireKey(p, { mark: true })
      return [listed(h, p, { state: AGENT_DIRECTOR_PENDING_STATE })]
    }],
    ['an absent persona\'s finished rows (its key recorded)', (h) => [...AGENT_DIRECTOR_DEAD_STATES].map((state, i) => absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY, { state, claude_instance_id: `${personaInstanceId(LAUNCH_START_ABSENT_PERSONA_KEY)}_${i}` }))],
    ['B not recorded: its row under another instance id, killed', (h, _p, b) => [listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })]],
    ['P recorded without its mark, its own row finished', (h, p) => {
      h.retireKey(p)
      return [listed(h, p, { state: 'ended' })]
    }],
  ])('no hold: %s', async (_label, rows) => {
    const { h, p, b } = build()

    await sweepOver(h, rows(h, p, b))

    expect(holdsOf(h)).toEqual([])
    expect(holdLinesIn(h.errors)).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness) => boolean, (h: RecoveryHarness, absent: Phase1ListRow) => HoldFields[], number]>([
    ['by the time the list returns', (h) => h.stub.calls.listCalls.length > 0, () => [], 0],
    ['once the absent key is recorded, before the first kill', (h) => h.retiredKeyWrites.length > 0, () => [], 0],
    [
      'during the first kill\'s tries (ErrTmuxKillFailed): the listing hold begun before stands, unmarked; the stopped kill begins and marks nothing, and no later row is killed',
      (h) => h.stub.calls.killCalls.length > 0,
      (_h, absent) => [hold(absent.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, absent.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)],
      1,
    ],
  ])('the sweep\'s shutdown query answering true %s: no hold begins after it', async (_label, shuttingDown, expected, kills) => {
    const { h, b } = build()
    h.script({ killError: errTmuxKillFailed() })
    const absent = absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY)

    await sweepOver(h, [absent, listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })], h.config, () => shuttingDown(h))

    expect(holdsOf(h)).toEqual(expected(h, absent))
    expect(h.stub.calls.killCalls).toHaveLength(kills)
  })
})

// ---------------------------------------------------------------------------
// No kill outcome ends a hold; only the ordinary alert marks it
// ---------------------------------------------------------------------------

/** One queued answer to a kill. */
type KillAnswer = NonNullable<RecoveryStubScript['killQueue']>[number]

/** Each answer a kill's tries can end with, the script giving it, and whether it decides the ordinary kill-failure alert (SRJ-812). */
const KILL_ANSWERS: ReadonlyArray<readonly [string, () => RecoveryStubScript, boolean]> = [
  ['ErrTmuxKillFailed at every try (the ordinary alert)', () => ({ killError: errTmuxKillFailed() }), true],
  ['a survivor-naming ErrTmuxKillFailed, then a success (the survivor version)', () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), cannedOk(cannedKillResult(true))] }), false],
  [
    'a survivor-naming ErrTmuxKillFailed, then ErrTmuxUnresponsive for the remaining tries (the ordinary alert)',
    () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), ...Array.from({ length: KILL_RETRY_TRIES - 1 }, (): KillAnswer => cannedErr(errTmuxUnresponsive('kill')))] }),
    true,
  ],
  [
    'a survivor-naming ErrTmuxKillFailed, then a CONFLICT (also the ordinary alert, SRJ-702)',
    () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), cannedErr(errTmuxSessionConflict('kill', 'different-id'))] }),
    true,
  ],
  ['a success with kill_sent true', () => ({ killResult: cannedKillResult(true) }), false],
  ['a success with kill_sent false (AC 63)', () => ({ killResult: cannedKillResult(false) }), false],
  ['ErrSpawnNotFound at the kill (gone: a success)', () => ({ killError: errSpawnNotFound() }), false],
  ['a CONFLICT (AC 54)', () => ({ killError: errTmuxSessionConflict('kill', 'different-id') }), false],
  ['an UNUSABLE NAME', () => ({ killError: errUnusableName() }), false],
  ['UNAVAILABLE at every try (ErrTmuxUnresponsive: no ordinary alert)', () => ({ killError: errTmuxUnresponsive('kill') }), false],
]

describe('b.jg5 SRJ-809, SRJ-703, SRJ-812 (AC 54, AC 63): no kill outcome ends a hold; only tries that decided the ordinary kill-failure alert mark it kill-failed', () => {
  afterEach(harnessAfterEach)

  test.each(KILL_ANSWERS)('the persona teardown\'s kill of P\'s held old life answering %s: the hold stays, with no end line', async (_label, script, marks) => {
    const { h, p } = build()
    const begun = beginApplyHold(h, p)
    h.script(script())

    await h.drive(killPersonaInstanceForTeardown(p, { clock: h.killRetryClock }))

    expect(holdsOf(h)).toEqual([{ ...fieldsOf(begun), killFailed: marks }])
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test.each(KILL_ANSWERS)('the start sweep\'s kill of an absent persona\'s held row answering %s: the listing hold stays through the post-kill find-missing that did not list it, with no end line', async (_label, script, marks) => {
    const { h } = build()
    h.script(script())
    const row = absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY)

    await sweepOver(h, [row])

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING, marks)])
    expect(endedLinesIn(h.errors)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The new life
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809, SRJ-806: a reuse that begins the key\'s new life ends its hold', () => {
  afterEach(harnessAfterEach)

  test.each<[string, boolean]>([
    ['its mark written', false],
    ['its mark\'s write failed (held in memory)', true],
  ])('P recorded without its mark and held, its reuse answering fresh-retired (%s): P\'s hold ends for its new life with one line; B\'s hold stays', async (_label, failMark) => {
    const { h, p, b } = build()
    h.retireKey(p)
    const pHold = beginApplyHold(h, p)
    const bHold = beginApplyHold(h, b)
    h.script({ getError: errSpawnNotFound(), statusError: errSpawnNotFound() })
    if (failMark) h.failRetiredKeyWrites()

    expect(await h.launch(p)).toStrictEqual({ key: p, action: SPAWN_ACTION_FRESH_RETIRED })
    await h.runApproverToStop(p)

    expect(h.retiredEntry(p).marked).toBe(true)
    expect(holdsOf(h)).toEqual([fieldsOf(bHold)])
    expect(endedLinesIn(h.errors)).toEqual([oldLifeHoldEndedLine(pHold, OLD_LIFE_HOLD_END_NEW_LIFE, OLD_LIFE_NEW_LIFE_READ)])
  })
})

// ---------------------------------------------------------------------------
// The restart
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809, SRJ-714 (hatch A3): after a restart the start sweep rebuilds the holds still needed from its list and the record', () => {
  afterEach(harnessAfterEach)

  /** P recorded as a destructive modify's old half (a credentials_file change whose teardown kill failed), with no mark, as the record a restart reads. */
  const RECORDED_P: RecoveryHarnessOptions = { retiredKeys: ([p]) => ({ [p!]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY } }) }

  test('the first server: apply step 1\'s hold on P and its failed teardown kill mark it kill-failed; the restarted server holds nothing until its sweep keeps P\'s own live row (its cwd still P\'s) and holds P\'s directory, naming cscb_<P>, unmarked', async () => {
    const first = build()
    first.h.retireKey(first.p, { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY })
    beginApplyHold(first.h, first.p)
    first.h.script({ killError: errTmuxKillFailed() })
    await first.h.drive(killPersonaInstanceForTeardown(first.p, { clock: first.h.killRetryClock }))
    expect(holdsOf(first.h).map((h) => h.killFailed)).toEqual([true])
    // The restart: the first server's memory goes with it.
    harnessAfterEach()

    const { h, p } = build(RECORDED_P)
    expect(p).toBe(first.p)
    expect(holdsOf(h)).toEqual([])
    const row = listed(h, p)

    await sweepOver(h, [row])

    expect(h.stub.calls.killCalls).toEqual([])
    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, personaOf(h, p).working_directory, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(h.oldLifeHolds.holdsWaitedOnBy(personaOf(h, p)).map((view) => view.instanceId)).toEqual([personaInstanceId(p)])
  })

  test('SRJ-809\'s admission clause (AC 53): after the restart, with the sweep\'s hold on P\'s kept own row, a session from P\'s directory is no persona\'s, P up, with one line naming cscb_<P>; a session from B\'s is B\'s', async () => {
    const { h, p, b } = build(RECORDED_P)
    await sweepOver(h, [listed(h, p)])
    const real = realpathSync(personaOf(h, p).working_directory)

    expect(h.admitSession(personaOf(h, p).working_directory)).toEqual({ kind: 'held', directory: real, instanceIds: [personaInstanceId(p)] })
    expect(h.admitSession(personaOf(h, b).working_directory)).toMatchObject({ kind: 'admitted', persona: { key: b } })
    expect(h.errors.filter((line) => line === sessionHeldRefusalLine(real, [personaInstanceId(p)]))).toHaveLength(1)
  })

  test.each(['ended', 'missing'])('a restart whose sweep lists P\'s own row %s rebuilds no hold', async (state) => {
    const { h, p } = build(RECORDED_P)

    await sweepOver(h, [listed(h, p, { state })])

    expect(holdsOf(h)).toEqual([])
    expect(holdLinesIn(h.errors)).toEqual([])
  })
})

// ===========================================================================
// The wait's steps (b.jg5 SRJ-811, SRJ-812, SRJ-1512; E27 T2)
//
// Every case holds an old row at P's working directory (so P waits on it)
// and starts its wait through the session manager's ensure entry
// (`h.startOldLifeWait`, `h.runOldLifeWait`), on the recovery harness whose
// wait bindings, registry and holds are composed as `main()` composes them.
// The gates that start a wait in production, and the persona-waits cases,
// are E27 T3's section at the end of this file.
// ===========================================================================

/** An old row a wait runs on (b.jg5 SRJ-809, SRJ-1007): its id, its old key, and the row as a `get` reads it (live `waiting` unless overridden). */
interface OldRow {
  readonly instanceId: string
  readonly oldKey: string
  readonly row: (overrides?: PersonaGetResultOverrides) => CannedGetResult
}

/** A non-persona old row in P's working directory, with `extra` fields (its labels). */
function oldRowAt(h: RecoveryHarness, p: string, instanceId: string, oldKey: string, extra: PersonaGetResultOverrides): OldRow {
  return { instanceId, oldKey, row: (overrides = {}) => cannedGetResult({ claude_instance_id: instanceId, cwd: personaOf(h, p).working_directory, ...extra, ...overrides }) }
}

/** The id forms an old row comes in (SRJ-809's old key, SRJ-1007's ids), each on a harness over P and B; P waits on each. */
const OLD_ROWS: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string, b: string) => OldRow]> = [
  ['a renamed-away key\'s own cscb_<old> (B, no longer applied)', (h, p, b) => {
    h.remove(b)
    return oldRowAt(h, p, personaInstanceId(b), b, {})
  }],
  ['a pre-persona row\'s id', (h, p) => oldRowAt(h, p, PRE_PERSONA_ID, PRE_PERSONA_ID, { labels: { ...PRE_PERSONA_LABELS } })],
  ['an id that is not its label\'s cscb_<key> (B\'s, B still applied)', (h, p, b) => oldRowAt(h, p, `${personaInstanceId(b)}_old`, `${personaInstanceId(b)}_old`, { labels: { service: 'cscb', persona: b } })],
  ['P\'s own row (P configured)', (h, p) => ({ instanceId: personaInstanceId(p), oldKey: p, row: (overrides = {}) => personaRow(h, p, overrides) })],
]

/** A harness over P and B with `form`'s old row held at P's working directory. */
function heldOld(form: (h: RecoveryHarness, p: string, b: string) => OldRow, options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string; old: OldRow } {
  const { h, p, b } = build(options)
  const old = form(h, p, b)
  holdOldAt(h, old.instanceId, old.oldKey, p)
  return { h, p, b, old }
}

/** Every wait case: the retry timers a wait armed for its waiting personas are stopped, then the harness checks as every case does (no timer of the wait's own left). */
function waitAfterEach(): void {
  harness?.controller.stopAll('the case is over')
  harnessAfterEach()
}

/**
 * The session the wait's kill-failure alert names before any `get` read the
 * row and with no start-sweep listing naming one (b.jg5 SRJ-1001): the old
 * key's `slack_bot_<key>` for its own `cscb_<key>` row; none for an id
 * standing in (never the id itself), which the alert renders as "unknown".
 */
function sessionBeforeGet(old: OldRow): string {
  return old.oldKey === old.instanceId ? '' : personaTmuxSessionName(old.oldKey)
}

/** The kill-failure entry text for `decision` under the wait's reference (`oldLifeWaitRef`, SRJ-1007; context `old-life wait`, log-only closing), naming `session`. */
function waitAlertEntry(old: OldRow, decision: KillRetryAlert, session: string): string {
  const content = killFailureAlertContentOf(decision, session, old.instanceId)
  if (content === undefined) throw new Error('no alert for a none decision')
  return killFailureAlertEntryText(oldLifeWaitRef(old.instanceId, old.oldKey), KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, killFailureAlertText(content, KILL_FAILURE_CLOSING_LOG_ONLY, false))
}

/** The old key's `persona-teardown-notice` entry for a CONFLICT or UNUSABLE NAME `err` met at `at` (worded "during the wait"). */
function waitRefusalEntry(old: OldRow, at: OldLifeWaitRefusalAt, errorClass: OldLifeWaitRefusal['errorClass'], err: Error): string {
  return personaTeardownNoticeEntryText(
    oldLifeWaitRef(old.instanceId, old.oldKey),
    oldLifeWaitRefusalNoticeText(old.instanceId, { at, errorClass, error: err }),
    PERSONA_TEARDOWN_NOTICE_DURING_WAIT,
  )
}

/** The raw description an `ErrTmuxKillFailed` carries. */
function descriptionOf(err: Error): string {
  const description = killFailedDescriptionOf(err)
  if (description === undefined) throw new Error('no ErrTmuxKillFailed description')
  return description
}

/** A survivor-naming `ErrTmuxKillFailed` (`pane-process-survived`). */
const survivorFailure = (): Error => errTmuxKillFailed(undefined, 'pane-process-survived')

/** The calls of a step-3 run and its `get`, `count` times. */
const runsAndGets = (count: number): string[] => Array.from({ length: count }, () => ['findMissing', 'get']).flat()

/** A kill's tries all answering UNAVAILABLE: each try after the first follows one `status` read. */
const killTries = (tries = KILL_RETRY_TRIES): string[] => ['kill', ...Array.from({ length: tries - 1 }, () => ['status', 'kill']).flat()]

/** Every call that names an instance id names `id`; and no launch (`spawn`, `resume`) was made. */
function expectOnlyOn(h: RecoveryHarness, id: string): void {
  const named = (Object.values(h.stub.calls).flat() as Array<{ claude_instance_id?: unknown } | undefined>).filter((params) => params?.claude_instance_id !== undefined)
  expect(named.filter((params) => params?.claude_instance_id !== id)).toEqual([])
  expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
}

/** Nothing latched, posted or noticed: no latch event, no episode post, no session-manager notice and no Slack call on any persona's stub. */
function expectNoLatchOrPost(h: RecoveryHarness): void {
  expect(h.keys.map((key) => h.latch.isLatched(key))).toEqual(h.keys.map(() => false))
  expect([h.latchEvents, h.episodeNotices, h.notices]).toEqual([[], [], []])
  for (const key of h.keys) expect(h.slack(key).callLog).toEqual([])
}

/** The triggers of the old-life cause, by key. */
function oldLifeArms(h: RecoveryHarness): string[] {
  return h.triggers.filter((t) => t.kind === UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD).map((t) => t.key)
}

describe('b.jg5 SRJ-811, SRJ-1512: the wait\'s steps run on the old id only, with no launch and no retry timer for the old key', () => {
  afterEach(waitAfterEach)

  test.each(OLD_ROWS)('%s, read live at every get and judged alive by every run: one kill, the step-2 get, three runs each with its get (each run reaching the stub: the memo is bypassed), the step-4 kill, one more run and get; every call on the old id; no spawn or resume; no timer or trigger for the old key', async (_label, form) => {
    const { h, p, old } = heldOld(form)
    h.script({ getResult: old.row() })
    const order = recordCallOrder(h)

    const outcome = await h.runOldLifeWait(old.instanceId)

    expect(outcome.kind).toBe(LIVE_ROW_OUTCOME_ESCALATED)
    expect(order).toEqual(['kill', 'get', ...runsAndGets(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runsAndGets(1)])
    expect(h.stub.calls.findMissingCalls).toHaveLength(LIVE_ROW_SEQUENCE_MAX_RUNS)
    expectOnlyOn(h, old.instanceId)
    // The waiting persona is armed (P, in the held directory); never the old key, unless it is P itself.
    expect(oldLifeArms(h)).toEqual([p])
    if (old.oldKey !== p) {
      expect(h.triggers.filter((t) => t.key === old.oldKey)).toEqual([])
      expect(h.controller.isArmed(old.oldKey)).toBe(false)
    }
  })

  test('a run that lists P\'s own row and Q\'s in unverified_ids, in a wait on P\'s own row: P\'s row gets only the wait\'s one get after each run, Q\'s its one get from the run (E14)', async () => {
    const { h, p, b, old } = heldOld(OLD_ROWS[3]![1])
    const q = b
    h.script({
      getFn: (params) => (params.claude_instance_id === personaInstanceId(q) ? personaRow(h, q) : personaRow(h, p)),
      findMissingResult: cannedFindMissing({ rows: { [personaInstanceId(p)]: 'unverified_ids', [personaInstanceId(q)]: 'unverified_ids' } }),
    })

    await h.runOldLifeWait(old.instanceId)

    const gets = h.stub.calls.getCalls.map((params) => params.claude_instance_id)
    // Step 2's get, then each of the four runs: Q's provenance get, then the wait's get of P's row.
    expect(gets).toEqual([personaInstanceId(p), ...Array.from({ length: LIVE_ROW_SEQUENCE_MAX_RUNS }, () => [personaInstanceId(q), personaInstanceId(p)]).flat()])
  })
})

describe('b.jg5 SRJ-811 (AC 54): the wait and a live-row sequence never run at once on one instance id', () => {
  afterEach(waitAfterEach)

  test('while P\'s live-row sequence runs (its first run held), a hold on cscb_<P> gets no wait: the ensure entry answers already-running and makes no call', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, p, hold)
    beginApplyHold(h, p)
    const calls = h.stub.callCount()

    expect(ensureOldLifeWait(personaInstanceId(p))).toBe(LIVE_ROW_START_ALREADY_RUNNING)
    await h.clock.flush()

    expect([h.stub.callCount(), hold.calls.length, h.oldLifeWaitRunning(personaInstanceId(p))]).toEqual([calls, 1, false])
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    expect((await h.driveSequence(run.outcome)).kind).toBe(LIVE_ROW_OUTCOME_LAUNCHED)
    await h.runApproverToStop(p)
    expect(h.oldLifeWaitRunning(personaInstanceId(p))).toBe(false)
  })

  test('while a wait runs on cscb_<P> (its first run held), a start of P\'s live-row sequence answers already-running and makes no call; once the run lists the row in ids the hold and the wait end', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    beginApplyHold(h, p)
    h.script({ getResult: personaRow(h, p) })
    const id = personaInstanceId(p)
    const outcome = h.startOldLifeWait(id)
    await h.driveSequence(hold.entered(1))
    const calls = h.stub.callCount()

    expect(startLiveRowSequence(h.sequenceRequest(p, { lastReadState: 'waiting' }))).toBe(LIVE_ROW_START_ALREADY_RUNNING)
    await h.clock.flush()

    expect([h.stub.callCount(), hold.calls.length, h.oldLifeWaitRunning(id)]).toEqual([calls, 1, true])
    hold.release(cannedFindMissing({ rows: { [id]: 'ids' } }))
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
    expect([h.oldLifeHolds.holdOf(id), h.oldLifeWaitRunning(id)]).toEqual([undefined, false])
  })
})

describe('b.jg5 SRJ-811, SRJ-706: a wait on one id never refuses a waiting persona\'s own live-row sequence on its cscb_<key>', () => {
  let shared: string | undefined

  afterEach(() => {
    try {
      waitAfterEach()
    } finally {
      if (shared !== undefined) rmSync(shared, { recursive: true, force: true })
      shared = undefined
    }
  })

  // P and B in one working directory: production cannot reach this setup
  // (configuration validation refuses two personas in one working directory,
  // src/config.ts), so this is a unit case of the registry's rule only (a
  // wait on one id beside two waiters' own launching sequences). The
  // two-waiter setup production reaches is B's own row swept into P's
  // directory (the Q-9 describe at the end of this file).
  test('P and B both waiting on a pre-persona row held in their one directory, its wait held at its first run: the second waiter\'s ensure answers already-running with no call; P\'s and B\'s own launching sequences each start, and once the runs list every row in ids the wait ends and both launch', async () => {
    shared = mkdtempSync(join(tmpdir(), 'old-life-shared-'))
    const { h, p, b } = build({ personas: [{ working_directory: shared }, { working_directory: shared }] })
    const old = oldRowAt(h, p, PRE_PERSONA_ID, PRE_PERSONA_ID, { labels: { ...PRE_PERSONA_LABELS } })
    holdOldAt(h, old.instanceId, old.oldKey, p)
    expect([p, b].map((key) => h.oldLifeHolds.holdsWaitedOnBy(personaOf(h, key)).map((view) => view.instanceId))).toEqual([[PRE_PERSONA_ID], [PRE_PERSONA_ID]])
    const read = new Set<string>()
    h.script({
      getFn: (params) => {
        if (params.claude_instance_id === PRE_PERSONA_ID) return old.row()
        const key = h.keys.find((k) => personaInstanceId(k) === params.claude_instance_id)!
        const first = !read.has(key)
        read.add(key)
        return personaRow(h, key, first ? {} : { state: LIVENESS_DEAD_ROW_MISSING })
      },
    })
    const hold = holdFindMissing(h.stub.client)
    const wait = h.startOldLifeWait(PRE_PERSONA_ID)
    await h.driveSequence(hold.entered(1))
    const calls = h.stub.callCount()

    expect(ensureOldLifeWait(PRE_PERSONA_ID)).toBe(LIVE_ROW_START_ALREADY_RUNNING)
    await h.clock.flush()
    expect([h.stub.callCount(), hold.calls.length]).toEqual([calls, 1])

    const runs = [await startSequenceHeldAtRun(h, p, hold), await startSequenceHeldAtRun(h, b, hold)]

    expect([h.sequenceRunning(p), h.sequenceRunning(b), h.oldLifeWaitRunning(PRE_PERSONA_ID)]).toEqual([true, true, true])
    // Neither own launching sequence was refused for the wait: no refusal line at its start entry, armed or not.
    const refusals = [p, b].flatMap((key) => [true, false].map((armed) => oldLifeWaitRefusalLine(startLiveRowSequence.name, `persona=${key}`, armed)))
    expect(h.errors.filter((line) => refusals.includes(line))).toEqual([])
    const ids = cannedFindMissing({ rows: { [PRE_PERSONA_ID]: 'ids', [personaInstanceId(p)]: 'ids', [personaInstanceId(b)]: 'ids' } })
    for (let i = 0; i < 3; i++) hold.release(ids)
    expect(await h.driveSequence(wait)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
    for (const run of runs) expect((await h.driveSequence(run.outcome)).kind).toBe(LIVE_ROW_OUTCOME_LAUNCHED)
    for (const key of [p, b]) await h.runApproverToStop(key)
    expect(h.oldLifeHolds.holdOf(PRE_PERSONA_ID)).toBeUndefined()
  })
})

/** What a results row arranges: the stub's answers for the old row, and the errors the expected entries quote. */
type ResultArrange = (h: RecoveryHarness, old: OldRow) => readonly Error[]

/** One row of the results table (SRJ-811, SRJ-812, SRJ-702, SRJ-717). */
interface ResultRow {
  /** The calls, in order. */
  readonly order: readonly string[]
  /** How the round ended, as its one end line names it (`oldLifeWaitEndLine`). */
  readonly end: OldLifeWaitEndKind
  /** Whether the hold goes on after the round (false: the round ended it, and the wait). */
  readonly kept: boolean
  /** Whether the hold is marked kill-failed (SRJ-812). */
  readonly marked: boolean
  /** The kill-failure alert version the round raised, on the not-configured log-only route; none when absent. */
  readonly alert?: KillFailureAlertVersion
  /** The outage classes raised for the waiting persona (SRJ-811: ENVIRONMENT raises `tmux-unavailable`); none when absent. */
  readonly outages?: readonly OutageClass[]
  /** The startup-errors entries, in order: the class and the exact text, or undefined for a text pinned elsewhere. */
  readonly entries: (old: OldRow, errors: readonly Error[]) => Array<readonly [string, string | undefined]>
}

/** The startup-errors class a kill-failure alert `version` is written under. */
const alertClassOf = (version: KillFailureAlertVersion): string => (version === KILL_FAILURE_VERSION_SURVIVOR ? PERSONA_KILL_SURVIVOR_LABEL : PERSONA_KILL_FAILED_LABEL)

const RESULTS: ReadonlyArray<readonly [string, ResultArrange, ResultRow]> = [
  ['UNAVAILABLE at every try (ErrTmuxUnresponsive)', (h) => {
    h.script({ killError: errTmuxUnresponsive('kill') })
    return []
  }, { order: killTries(), end: OLD_LIFE_WAIT_END_UNAVAILABLE, kept: true, marked: false, entries: () => [] }],
  ['ENVIRONMENT at the kill (ErrTmuxNotAvailable)', (h) => {
    h.script({ killError: errTmuxNotAvailable(undefined, 'kill') })
    return []
  }, { order: ['kill'], end: OLD_LIFE_WAIT_END_ENVIRONMENT, kept: true, marked: false, outages: ['tmux-unavailable'], entries: () => [] }],
  ['UNAVAILABLE at the get (ErrCallTimeout)', (h) => {
    h.script({ getError: unavailableAt('get') })
    return []
  }, { order: ['kill', 'get'], end: OLD_LIFE_WAIT_END_CALL_FAILED, kept: true, marked: false, entries: () => [] }],
  ['ENVIRONMENT at the get (ErrTmuxNotAvailable)', (h) => {
    h.script({ getError: errTmuxNotAvailable(undefined, 'get') })
    return []
  }, { order: ['kill', 'get'], end: OLD_LIFE_WAIT_END_CALL_FAILED, kept: true, marked: false, outages: ['tmux-unavailable'], entries: () => [] }],
  ['UNAVAILABLE at the run (ErrCallTimeout), the row read live: the round stops at that run', (h, old) => {
    h.script({ getResult: old.row(), findMissingError: unavailableAt('find-missing') })
    return []
  }, { order: ['kill', 'get', 'findMissing'], end: OLD_LIFE_WAIT_END_CALL_FAILED, kept: true, marked: false, entries: () => [] }],
  ['ErrTmuxKillFailed after the tries', (h) => {
    const err = errTmuxKillFailed()
    h.script({ killError: err })
    return [err]
  }, {
    order: killTries(),
    end: OLD_LIFE_WAIT_END_KILL_FAILED,
    kept: true,
    marked: true,
    alert: KILL_FAILURE_VERSION_ORDINARY,
    entries: (old, [err]) => [[PERSONA_KILL_FAILED_LABEL, waitAlertEntry(old, { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err!) }, sessionBeforeGet(old))]],
  }],
  ['a CONFLICT at the kill', (h) => {
    const err = errTmuxSessionConflict('kill', 'not-this-launch')
    h.script({ killError: err })
    return [err]
  }, { order: ['kill'], end: OLD_LIFE_WAIT_END_REFUSED, kept: true, marked: false, entries: (old, [err]) => [[PERSONA_TEARDOWN_NOTICE_LABEL, waitRefusalEntry(old, OLD_LIFE_WAIT_AT_KILL, AD_ERROR_CLASS_CONFLICT, err!)]] }],
  ['an UNUSABLE NAME at the kill', (h) => {
    const err = errUnusableName()
    h.script({ killError: err })
    return [err]
  }, { order: ['kill'], end: OLD_LIFE_WAIT_END_REFUSED, kept: true, marked: false, entries: (old, [err]) => [[PERSONA_TEARDOWN_NOTICE_LABEL, waitRefusalEntry(old, OLD_LIFE_WAIT_AT_KILL, AD_ERROR_CLASS_UNUSABLE_NAME, err!)]] }],
  ['a survivor-naming ErrTmuxKillFailed, then a success; the steps go on to the get, which reads the row ended', (h, old) => {
    const err = survivorFailure()
    h.script({ killQueue: [cannedErr(err), cannedOk(cannedKillResult(true))], getResult: old.row({ state: LIVENESS_DEAD_ROW_ENDED }) })
    return [err]
  }, {
    order: [...killTries(2), 'get'],
    end: OLD_LIFE_WAIT_END_HOLD_ENDED,
    kept: false,
    marked: false,
    alert: KILL_FAILURE_VERSION_SURVIVOR,
    entries: (old, [err]) => [[PERSONA_KILL_SURVIVOR_LABEL, waitAlertEntry(old, { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: descriptionOf(err!) }, sessionBeforeGet(old))]],
  }],
  ['a success with kill_sent false: it goes on to the get and a run (a pending row the run does not judge), and ends nothing', (h, old) => {
    h.script({ killResult: cannedKillResult(false), getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE }) })
    return []
  }, { order: ['kill', 'get', 'findMissing'], end: OLD_LIFE_WAIT_END_NOT_JUDGED, kept: true, marked: false, entries: () => [] }],
  ['a pending row the run does not judge: the round stops with no alert and nothing counted (SRJ-717)', (h, old) => {
    h.script({ getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE }) })
    return []
  }, { order: ['kill', 'get', 'findMissing'], end: OLD_LIFE_WAIT_END_NOT_JUDGED, kept: true, marked: false, entries: () => [] }],
  ['still live after runs that judged it (step 5): the ordinary version to the log and persona-kill-failed', (h, old) => {
    h.script({ getResult: old.row() })
    return []
  }, {
    order: ['kill', 'get', ...runsAndGets(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runsAndGets(1)],
    end: OLD_LIFE_WAIT_END_ESCALATED,
    kept: true,
    marked: true,
    alert: KILL_FAILURE_VERSION_ORDINARY,
    // Step 5's exact text for each id form is tests/live-row-sequence.test.ts's (SRJ-1007's Test line).
    entries: () => [[PERSONA_KILL_FAILED_LABEL, undefined]],
  }],
  ['the row listed in a run\'s ids: the hold ends, and the wait with it before its next call', (h, old) => {
    h.script({ getResult: old.row(), findMissingResult: cannedFindMissing({ rows: { [old.instanceId]: 'ids' } }) })
    return []
  }, { order: ['kill', 'get', 'findMissing'], end: OLD_LIFE_WAIT_END_HOLD_ENDED, kept: false, marked: false, entries: () => [] }],
  ['the row read ended at the get', (h, old) => {
    h.script({ getResult: old.row({ state: LIVENESS_DEAD_ROW_ENDED }) })
    return []
  }, { order: ['kill', 'get'], end: OLD_LIFE_WAIT_END_HOLD_ENDED, kept: false, marked: false, entries: () => [] }],
  ['the row read missing at the get', (h, old) => {
    h.script({ getResult: old.row({ state: LIVENESS_DEAD_ROW_MISSING }) })
    return []
  }, { order: ['kill', 'get'], end: OLD_LIFE_WAIT_END_HOLD_ENDED, kept: false, marked: false, entries: () => [] }],
]

const RESULT_CASES = RESULTS.flatMap(([result, arrange, row]) => OLD_ROWS.map(([form, make]) => [result, form, arrange, row, make] as const))

describe('b.jg5 SRJ-811, SRJ-812, SRJ-1002, SRJ-702, SRJ-717 (AC 54, AC 63): the wait\'s results follow their class, for every id form; nothing latches and nothing is posted', () => {
  afterEach(waitAfterEach)

  test.each(RESULT_CASES)('%s — %s', async (_result, _form, arrange, expected, form) => {
    const { h, p, old } = heldOld(form)
    // A pending row's launch start is past G: it is waited on no longer, and a configured persona's own such row latches no one.
    await pastSampleGrace(h)
    const errors = arrange(h, old)
    const order = recordCallOrder(h)

    await h.runOldLifeWait(old.instanceId)

    expect(order).toEqual([...expected.order])
    expectOnlyOn(h, old.instanceId)
    const held = h.oldLifeHolds.holdOf(old.instanceId)
    expect(held === undefined ? undefined : { killFailed: held.killFailed }).toEqual(expected.kept ? { killFailed: expected.marked } : undefined)
    expect(waitsOnKillFailedHold(p)).toBe(expected.kept && expected.marked)
    // A round that keeps the hold arms each waiting persona's timer, uncounted; a round that ended it arms nothing.
    expect(oldLifeArms(h)).toEqual(expected.kept ? [p] : [])
    expect(getFailureCount(p)).toBe(0)
    expect(h.oldLifeWaitRunning(old.instanceId)).toBe(false)
    const entries = startupEntries(h)
    const want = expected.entries(old, errors)
    expect(entries.map(([cls]) => cls)).toEqual(want.map(([cls]) => cls))
    entries.forEach(([, text], i) => {
      const exact = want[i]![1]
      if (exact === undefined) expect(text.startsWith(`${oldLifeWaitRef(old.instanceId, old.oldKey)} (${KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT}): `)).toBe(true)
      else expect(text).toBe(exact)
    })
    // Exactly one end line for the round, naming how it ended and the personas it armed.
    expect(h.errors.filter((line) => line.startsWith(waitEndLinePrefix(old.instanceId, old.oldKey)))).toEqual([
      waitEndLine(old.instanceId, old.oldKey, { kind: expected.end, kept: expected.kept, marked: expected.marked }, expected.kept ? [p] : []),
    ])
    // The kill-failure alert's own line for the old key: its version written on the not-configured, log-only route.
    expect(killFailureLines(h, old.oldKey)).toEqual(
      expected.alert === undefined ? [] : [killFailureLoggedLine(old.oldKey, expected.alert, alertClassOf(expected.alert), KILL_FAILURE_ROUTE_NOT_CONFIGURED)],
    )
    expectNoLatchOrPost(h)
    // The outage is the waiting persona's, never the old key's.
    expect([...getOutageFlags(p)]).toEqual([...(expected.outages ?? [])])
    if (old.oldKey !== p) expect(getOutageFlags(old.oldKey).size).toBe(0)
  })
})

describe('b.jg5 SRJ-1001, SRJ-811: the session a wait\'s kill-failure alert names for an id standing in, before any get', () => {
  afterEach(waitAfterEach)

  test('a pre-persona row the start sweep listed and failed to kill (a CONFLICT): the wait\'s persona-kill-failed entry names the listing\'s tmux_session_name', async () => {
    const { h, p } = build()
    const row: Phase1ListRow = { ...prePersonaRow(), cwd: personaOf(h, p).working_directory }
    h.script({ killQueue: [cannedErr(errTmuxSessionConflict('kill', 'different-id'))] })
    await sweepOver(h, [row])
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, row.claude_instance_id, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL)])
    const before = startupEntries(h).length
    const err = errTmuxKillFailed()
    h.script({ killQueue: [], killError: err })
    const old = oldRowAt(h, p, row.claude_instance_id, row.claude_instance_id, {})

    await h.runOldLifeWait(old.instanceId)

    const entries = startupEntries(h).slice(before)
    expect(entries).toEqual([[PERSONA_KILL_FAILED_LABEL, waitAlertEntry(old, { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err) }, row.tmux_session_name)]])
    expect(entries[0]![1]).toContain(`in session "${row.tmux_session_name}"`)
  })

  test('a pre-persona row held with no listing naming its session: the entry names the session "unknown", never the instance id', async () => {
    const { h, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ killError: errTmuxKillFailed() })

    await h.runOldLifeWait(old.instanceId)

    const [[, text]] = startupEntries(h) as [readonly [string, string]]
    expect(text).toContain('in session "unknown"')
    expect(text).not.toContain(`in session "${old.instanceId}"`)
  })
})

/** Where else a refusal is met (SRJ-1002, SRJ-1013): the form it is met on, its arrangement, where, how many times, and the calls. */
const REFUSALS_ELSEWHERE: ReadonlyArray<readonly [string, number, (h: RecoveryHarness, old: OldRow, err: Error) => void, OldLifeWaitRefusalAt, number, readonly string[]]> = [
  ['an UNUSABLE NAME at the get of P\'s own row (routed, SRJ-1002)', 3, (h, _old, err) => h.script({ getError: err }), OLD_LIFE_WAIT_AT_GET, 1, ['kill', 'get']],
  ['an UNUSABLE NAME at the get of a pre-persona row', 1, (h, _old, err) => h.script({ getError: err }), OLD_LIFE_WAIT_AT_GET, 1, ['kill', 'get']],
  // A failed run judges nothing and the step goes on (SRJ-120): every run fails, so no run judged the row and step 5 raises no alert.
  [
    'an UNUSABLE NAME at every run',
    1,
    (h, old, err) => h.script({ getResult: old.row(), findMissingError: err }),
    OLD_LIFE_WAIT_AT_FIND_MISSING,
    LIVE_ROW_SEQUENCE_MAX_RUNS,
    ['kill', 'get', ...runsAndGets(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runsAndGets(1)],
  ],
  [
    'an UNUSABLE NAME at each status read between the kill\'s tries (ErrTmuxUnresponsive), on P\'s own row',
    3,
    (h, _old, err) => h.script({ killError: errTmuxUnresponsive('kill'), statusError: err }),
    OLD_LIFE_WAIT_AT_STATUS_READ,
    KILL_RETRY_TRIES - 1,
    killTries(),
  ],
]

describe('b.jg5 SRJ-811, SRJ-1002, SRJ-1013: an UNUSABLE NAME met at a get, a run or a status read between tries is one persona-teardown-notice entry each, "during the wait", and latches no one', () => {
  afterEach(waitAfterEach)

  test.each(REFUSALS_ELSEWHERE)('%s', async (_label, form, arrange, at, times, calls) => {
    const { h, p, old } = heldOld(OLD_ROWS[form]![1])
    const err = errUnusableName()
    arrange(h, old, err)
    const order = recordCallOrder(h)

    await h.runOldLifeWait(old.instanceId)

    expect(order).toEqual([...calls])
    const entry = waitRefusalEntry(old, at, AD_ERROR_CLASS_UNUSABLE_NAME, err)
    expect(startupEntries(h)).toEqual(Array.from({ length: times }, () => [PERSONA_TEARDOWN_NOTICE_LABEL, entry] as const))
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect(oldLifeArms(h)).toEqual([p])
    expectNoLatchOrPost(h)
  })
})

describe('b.jg5 SRJ-811, E12: UNCLASSIFIED and CONFIG in the wait', () => {
  afterEach(waitAfterEach)

  test.each(OLD_ROWS)('UNCLASSIFIED at the kill (%s), round after round while the hold goes on: the first round begins the wait\'s episode on the held id and writes nothing; the first round past the alert threshold writes the one log-only persona-unclassified-error entry; a later round writes none; the hold\'s end ends the episode. P is armed uncounted each round; nothing latches or is posted, and the old key\'s own episode never opens', async (_label, form) => {
    const { h, p, old } = heldOld(form)
    const err = errInternal()
    h.script({ killError: err })
    /** One round, then P's timer it armed stopped, so the clock can pass the threshold with no retry firing. */
    const round = async (): Promise<void> => {
      await h.runOldLifeWait(old.instanceId)
      h.controller.stopAll('the round is over')
    }
    const entry = [PERSONA_UNCLASSIFIED_ERROR_LABEL, oldLifeWaitUnclassifiedEntryText(old.instanceId, unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false }))] as const

    await round()
    expect([startupEntries(h), h.oldLifeWaitUnclassifiedOpen(old.instanceId)]).toEqual([[], true])
    expect(h.errors.filter((line) => line === unclassifiedStartedLine(old.instanceId, err))).toHaveLength(1)

    await h.clock.advance(adAlertThresholdMsInEffect() + 1)
    await round()
    expect(startupEntries(h)).toEqual([entry])
    expect(entry[1]).toBe(`${oldLifeWaitRef(old.instanceId, old.oldKey)}: ${unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false })}`)

    await h.clock.advance(adAlertThresholdMsInEffect() + 1)
    await round()
    expect(startupEntries(h)).toEqual([entry])

    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect([oldLifeArms(h), getFailureCount(p)]).toEqual([[p, p, p], 0])
    expect(h.unclassifiedErrorOpen(old.oldKey)).toBe(false)
    expectNoLatchOrPost(h)

    endHoldByAnotherRead(old)
    expect(h.oldLifeWaitUnclassifiedOpen(old.instanceId)).toBe(false)
    expect(h.errors.filter((line) => line === unclassifiedEndedLine(old.instanceId, UNCLASSIFIED_ERROR_END_HOLD_ENDED))).toHaveLength(1)
  })

  test('with no unclassified-error episodes in the wait\'s bindings, a round that met UNCLASSIFIED writes no entry and logs the not-reported line once', async () => {
    const { h, old } = heldOld(OLD_ROWS[1]![1])
    setOldLifeWaitBindings({ retryArm: { arm: () => false, armPendingOnly: () => {} }, clock: h.clock, log: () => {}, appliedConfig: () => h.config })
    h.script({ killError: errInternal() })

    await h.runOldLifeWait(old.instanceId)

    expect([startupEntries(h), h.oldLifeWaitUnclassifiedOpen(old.instanceId)]).toEqual([[], false])
    expect(h.errors.filter((line) => line === oldLifeWaitUnclassifiedNotReportedLine(oldLifeWaitRef(old.instanceId, old.oldKey)))).toHaveLength(1)
  })

  test('an UNCLASSIFIED answer at a status read between tries, in a round a shutdown then stopped, is reported to no episode (SRJ-706): only the stopped kill\'s persona-kill-failed entry', async () => {
    const { h, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ killError: errTmuxUnresponsive('kill'), statusError: errInternal() })
    // The shutdown lands during the second try, after the status read met UNCLASSIFIED.
    const order = recordCallOrder(h, { at: 2, run: () => h.shutdown() })

    expect(await h.runOldLifeWait(old.instanceId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_SHUTDOWN })
    expect(order).toEqual(['kill', 'status', 'kill'])
    expect(h.oldLifeWaitUnclassifiedOpen(old.instanceId)).toBe(false)
    expect(startupEntries(h).map(([cls]) => cls)).toEqual([PERSONA_KILL_FAILED_LABEL])
    expect(oldLifeArms(h)).toEqual([])
  })

  test.each(OLD_ROWS)('CONFIG at the kill (%s): ad-config-malformed is raised for the waiting persona, the hold goes on and P\'s timer is armed', async (_label, form) => {
    const { h, p, old } = heldOld(form)
    h.script({ killError: errConfigMalformed() })

    await h.runOldLifeWait(old.instanceId)

    expect(adConfigMalformedRaiseLines(h, p)).toHaveLength(1)
    expect(getOutageFlags(p).has('ad-config-malformed')).toBe(true)
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect(oldLifeArms(h)).toEqual([p])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(startupEntries(h)).toEqual([])
    if (old.oldKey !== p) expect(getOutageFlags(old.oldKey).size).toBe(0)
  })

  // b.jg5 SRJ-809, SRJ-811, SRJ-316: the start sweep's listing begins the
  // hold before its read of the row is noted, so the hold's first wait is
  // seeded with the state the list gave.
  test('the start sweep lists P\'s own row pending, P recorded without its mark: the listing holds it and seeds its first wait pending, so with ad-config-malformed raised for P that wait makes no kill and no call (SRJ-316), keeps the hold and arms P', async () => {
    const { h, p } = build()
    h.retireKey(p)
    const row = listed(h, p, { state: AGENT_DIRECTOR_PENDING_STATE })
    await sweepOver(h, [row])
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, p, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    raiseAdConfigMalformed(p, errConfigMalformed())
    const order = recordCallOrder(h)

    expect(await h.runOldLifeWait(row.claude_instance_id)).toMatchObject({ kind: LIVE_ROW_OUTCOME_CONFIG_MALFORMED, step: 1 })

    expect(order).toEqual([])
    expect(h.oldLifeHolds.holdOf(row.claude_instance_id)?.killFailed).toBe(false)
    expect(oldLifeArms(h)).toEqual([p])
    expect(h.errors.filter((line) => line.startsWith(waitEndLinePrefix(row.claude_instance_id, p)))).toEqual([
      waitEndLine(row.claude_instance_id, p, { kind: OLD_LIFE_WAIT_END_CONFIG, kept: true }, [p]),
    ])
  })

  test.each(OLD_ROWS.slice(0, 3))('a later round whose kill succeeds clears the ad-config-malformed a CONFIG round raised for the waiting persona; the tmux-unavailable an ENVIRONMENT round raised stays raised (%s)', async (_label, form) => {
    const { h, p, old } = heldOld(form)
    await pastSampleGrace(h)
    h.script({ killError: errTmuxNotAvailable(undefined, 'kill') })
    await h.runOldLifeWait(old.instanceId)
    h.script({ killError: errConfigMalformed() })
    await h.runOldLifeWait(old.instanceId)
    expect([...getOutageFlags(p)].sort()).toEqual(['ad-config-malformed', 'tmux-unavailable'])

    // The kill succeeds; a pending row the run does not judge keeps the hold.
    h.script({ killError: undefined, getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE }) })
    const order = recordCallOrder(h)
    await h.runOldLifeWait(old.instanceId)

    expect(order).toEqual(['kill', 'get', 'findMissing'])
    expect(h.oldLifeHolds.holdOf(old.instanceId)).toBeDefined()
    expect([...getOutageFlags(p)]).toEqual(['tmux-unavailable'])
    if (old.oldKey !== p) expect(getOutageFlags(old.oldKey).size).toBe(0)
  })
})

describe('b.jg5 SRJ-408 (E16): an old key\'s pending row with no launch start gets the wait\'s kill and its run at once, with no wait for G, and latches nothing', () => {
  afterEach(waitAfterEach)

  test.each(OLD_ROWS.slice(0, 3))('%s, read pending with no launch start: the kill, the get and the first run all at the start\'s clock time; no latch', async (_label, form) => {
    const { h, old } = heldOld(form)
    h.script({ getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    const startedAt = h.clock.now()
    const calls: Array<readonly [string, number]> = []
    const order = recordCallOrder(h)
    const client = h.stub.client as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const verb of ['kill', 'get', 'findMissing'] as const) {
      const call = client[verb]!
      client[verb] = (...args: unknown[]) => {
        calls.push([verb, h.clock.now()])
        return call.apply(client, args)
      }
    }

    const outcome = await h.runOldLifeWait(old.instanceId)

    expect(outcome.kind).toBe(LIVE_ROW_OUTCOME_NOT_JUDGED)
    expect(order).toEqual(['kill', 'get', 'findMissing'])
    expect(calls).toEqual([['kill', startedAt], ['get', startedAt], ['findMissing', startedAt]])
    expectNoLatchOrPost(h)
  })
})

describe('b.jg5 SRJ-502, SRJ-513, SRJ-812, SRJ-811, SRJ-305, SRJ-702: a wait on a configured persona\'s own row stops at that persona\'s latch, keeps the hold and arms only the waiting personas that are not latched', () => {
  afterEach(waitAfterEach)

  // The two-waiter form (B latched by the wait's read of its own row while
  // P waits beside it, only P armed) runs on the setup production reaches:
  // B's own row swept into P's directory, in the Q-9 describe below.

  /** The wait's line for a waiting persona it does not arm because it is latched (SRJ-305). */
  const latchedLines = (h: RecoveryHarness, key: string): string[] => h.errors.filter((line) => line === oldLifeWaitLatchedLine(key))

  /** Latch P by another call's read of its own row carrying provenance_conflict, outside the wait (its keep-going check then finds P latched). */
  const latchP = async (h: RecoveryHarness, p: string): Promise<void> => {
    h.script({ getResult: personaRow(h, p, { liveness_note: provenanceNote }) })
    await readPersonaOwnRow(p, { site: 'old-life-wait.test', what: 'own-row get' })
    expect(h.latch.isLatched(p)).toBe(true)
  }

  // SRJ-702: a configured persona's stop writes the log line only. P's latch
  // is a stop of the wait on P's own row; a shutdown is the wait's stop, so
  // it writes the old key's persona-kill-failed entry too (SRJ-811).
  test.each<[string, (h: RecoveryHarness, p: string) => Promise<void> | void, LiveRowSequenceStopReason, string, boolean]>([
    ['P latched meanwhile (the keep-going check\'s latch): one line naming the latch as the cause and no persona-kill-failed entry; no shutdown wording; the hold goes on, P not armed (one latched line)', latchP, LIVE_ROW_STOP_LATCHED, OLD_LIFE_WAIT_STOP_CAUSE_LATCHED, false],
    ['a shutdown: one line naming the shutdown and the old key\'s persona-kill-failed entry with no alert text', (h) => h.shutdown(), LIVE_ROW_STOP_SHUTDOWN, OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN, true],
  ])('the wait on P\'s own row stopped between its kill\'s tries (ErrTmuxUnresponsive) by %s', async (_label, stop, reason, cause, entry) => {
    const { h, p, old } = heldOld(OLD_ROWS[3]![1])
    h.script({ killError: errTmuxUnresponsive('kill') })
    const { outcome } = await startedUntilKillWait(h, old, 1)

    await stop(h, p)

    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason })
    // No further kill or status read.
    expect([h.stub.calls.killCalls.length, h.stub.calls.statusCalls.length]).toEqual([1, 0])
    const stopped = stoppedWait(old, { kind: KILL_RETRY_ALERT_ORDINARY }, cause)
    expect(killFailureLines(h, p)).toEqual(entry ? [stopped.line, killFailureStoppedEntryLine(p)] : [stopped.line])
    expect(startupEntries(h)).toEqual(entry ? [[PERSONA_KILL_FAILED_LABEL, stopped.entry]] : [])
    if (!entry) expect(h.lines.filter((line) => line.includes(OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN))).toEqual([])
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect([oldLifeArms(h), h.controller.isArmed(p), latchedLines(h, p).length]).toEqual([[], false, entry ? 0 : 1])
    expect(h.errors.filter((line) => line.startsWith(waitEndLinePrefix(old.instanceId, old.oldKey)))).toEqual([
      entry
        ? waitEndLine(old.instanceId, old.oldKey, { kind: OLD_LIFE_WAIT_END_STOPPED, kept: false }, [])
        : waitEndLine(old.instanceId, old.oldKey, { kind: OLD_LIFE_WAIT_END_LATCHED, kept: true }, []),
    ])
  })

  test('a status read between the kill\'s tries reads P\'s own row pending with no launch start, latching P: the round ends stopped (latched) after one kill, the hold goes on marked kill-failed (the read-latch end keeps the ordinary alert), P (latched) is not armed, with one latched line, and the persona-kill-failed entry is written', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[3]![1])
    const err = errTmuxKillFailed()
    h.script({ killError: err, statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    const order = recordCallOrder(h)

    expect(await h.runOldLifeWait(old.instanceId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, kills: 1 })

    expect(order).toEqual(['kill', 'status'])
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(true)
    expect(waitsOnKillFailedHold(p)).toBe(true)
    expect([oldLifeArms(h), h.controller.isArmed(p), getFailureCount(p)]).toEqual([[], false, 0])
    expect(latchedLines(h, p)).toHaveLength(1)
    expect(startupEntries(h)).toEqual([[PERSONA_KILL_FAILED_LABEL, waitAlertEntry(old, { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err) }, sessionBeforeGet(old))]])
  })

  test('P\'s own row read pending with no launch start at the get latches P; a second round while P is latched makes no kill and no get, ends stopped (latched) and keeps the hold unmarked; neither round arms P (one latched line each)', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[3]![1])
    h.script({ getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    const order = recordCallOrder(h)

    expect(await h.runOldLifeWait(old.instanceId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED })
    expect([order, h.latch.isLatched(p)]).toEqual([['kill', 'get'], true])
    const calls = h.stub.callCount()

    expect(await h.runOldLifeWait(old.instanceId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, kills: 0 })

    expect([order, h.stub.callCount()]).toEqual([['kill', 'get'], calls])
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect([oldLifeArms(h), h.controller.isArmed(p), getFailureCount(p)]).toEqual([[], false, 0])
    expect(latchedLines(h, p)).toHaveLength(2)
    expect(startupEntries(h)).toEqual([])
  })

  test('a waiting persona\'s latch never stops a wait on a row it does not own: P latched by a read of its own row, the wait on a pre-persona row held in P\'s directory makes its kill and its get, which reads the row ended and ends the hold', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ getFn: (params) => (params.claude_instance_id === personaInstanceId(p) ? personaRow(h, p, { liveness_note: provenanceNote }) : old.row({ state: LIVENESS_DEAD_ROW_ENDED })) })
    await readPersonaOwnRow(p, { site: 'old-life-wait.test', what: 'own-row get' })
    expect(h.latch.isLatched(p)).toBe(true)
    const order = recordCallOrder(h)

    expect(await h.runOldLifeWait(old.instanceId)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })

    expect(order).toEqual(['kill', 'get'])
    expect(h.oldLifeHolds.holdOf(old.instanceId)).toBeUndefined()
  })
})

describe('b.jg5 SRJ-305, SRJ-811, SRJ-810: a waiting persona not up, or held on ErrInvalidFlags, is never armed by the wait and not retried at its hold\'s end', () => {
  afterEach(waitAfterEach)

  test.each<[string, (h: RecoveryHarness, p: string) => Promise<void> | void, (key: string) => string, string]>([
    ['not up (its bring-up owns it)', (h, p) => h.setUp(p, false), oldLifeWaitNotUpLine, OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_UP],
    ['held on ErrInvalidFlags (its reuse refused before the hold began)', (h, p) => holdThroughReuse(h, p), oldLifeWaitHeldLine, OLD_LIFE_HOLD_END_NOT_RETRIED_HELD],
  ])('P %s, recorded as waiting by the restart path\'s old-life hook on a pre-persona row held in its directory: neither the hook nor the round arms P, one skip line each; once the hold ends P is not retried, the end line naming why', async (_label, arrange, skipLine, reason) => {
    const { h, p, b } = build()
    await arrange(h, p)
    const old = OLD_ROWS[1]![1](h, p, b)
    holdOldAt(h, old.instanceId, old.oldKey, p)
    // The row reads pending past G: the round's run does not judge it, so the round keeps the hold and arms its waiters.
    await pastSampleGrace(h)
    h.script({ getResult: old.row({ state: AGENT_DIRECTOR_PENDING_STATE }) })

    expect(oldLifeHoldStep(personaOf(h, p), 'runRestartWork')).toBe(true)
    expect(await h.driveSequence(h.oldLifeWaitSettled(old.instanceId))).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED })

    expect(h.oldLifeHolds.holdOf(old.instanceId)?.waiting).toEqual([p])
    expect([oldLifeArms(h), h.controller.isArmed(p), getFailureCount(p)]).toEqual([[], false, 0])
    expect(h.errors.filter((line) => line === skipLine(p))).toHaveLength(2)
    expect(gateLinesIn(h)).toEqual([oldLifeHoldLaunchLine('runRestartWork', `persona=${p}`, realpathSync(personaOf(h, p).working_directory), [{ instanceId: old.instanceId, wait: LIVE_ROW_START_STARTED }], false)])
    expect(h.errors.filter((line) => line.startsWith(waitEndLinePrefix(old.instanceId, old.oldKey)))).toEqual([
      waitEndLine(old.instanceId, old.oldKey, { kind: OLD_LIFE_WAIT_END_NOT_JUDGED, kept: true }, []),
    ])

    endHoldByAnotherRead(old)
    await h.settle()

    expect(h.holdEndRetries).toEqual([])
    expect(h.errors.filter((line) => line === oldLifeHoldEndRetryLine(old.instanceId, [], [`${p} (${reason})`]))).toHaveLength(1)
  })
})

describe('b.jg5 SRJ-812: the kill-failed mark, and the per-persona query', () => {
  afterEach(waitAfterEach)

  test('a failed kill marks the hold P waits on: P\'s query answers true, Q\'s (in its own directory) false; the hold\'s end clears it', async () => {
    const { h, p, b, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ killError: errTmuxKillFailed() })

    await h.runOldLifeWait(old.instanceId)

    expect([waitsOnKillFailedHold(p), waitsOnKillFailedHold(b)]).toEqual([true, false])
    noteOldLifeRowRead(old.instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call')
    expect(waitsOnKillFailedHold(p)).toBe(false)
  })
})

describe('b.jg5 SRJ-811: the wait ends at its hold\'s end and at the registry\'s close, with no further call and no timer left', () => {
  afterEach(waitAfterEach)

  test.each<[string, (h: RecoveryHarness, old: OldRow) => void, string]>([
    ['its hold\'s end (another call reads the old row ended)', (_h, old) => noteOldLifeRowRead(old.instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call'), LIVE_ROW_STOP_HOLD_ENDED],
    ['the registry\'s close at shutdown', (h) => h.shutdown(), LIVE_ROW_STOP_SHUTDOWN],
  ])('%s while its first run is held: once the run is released no further call follows, nothing is armed and no timer is left', async (_label, end, reason) => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    const hold = holdFindMissing(h.stub.client)
    h.script({ getResult: old.row() })
    const order = recordCallOrder(h)
    const outcome = h.startOldLifeWait(old.instanceId)
    await h.driveSequence(hold.entered(1))

    end(h, old)
    hold.release(cannedFindMissing())

    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason })
    expect(order).toEqual(['kill', 'get', 'findMissing'])
    expect([oldLifeArms(h), h.controller.isArmed(p), h.oldLifeWaitRunning(old.instanceId), h.clock.pendingCount()]).toEqual([[], false, false, 0])
    expect(startupEntries(h)).toEqual([])
  })
})

/**
 * Start the wait on `old` and step its microtasks until its kill has made
 * `tries` tries and waits on the clock before the next one. Answers the
 * outcome promise.
 */
async function startedUntilKillWait(h: RecoveryHarness, old: OldRow, tries: number): Promise<{ readonly outcome: Promise<LiveRowSequenceOutcome> }> {
  const outcome = h.startOldLifeWait(old.instanceId)
  for (let turn = 0; turn < 100 && !(h.stub.calls.killCalls.length === tries && h.clock.pendingCount() === 1); turn++) await h.clock.flush()
  expect([h.stub.calls.killCalls.length, h.clock.pendingCount()]).toEqual([tries, 1])
  return { outcome }
}

/** The stopped-retry text for the old key's kill stopped for `stopCause` (b.jg5 SRJ-702): its line and its entry, quoting `quoted`. */
function stoppedWait(old: OldRow, quoted: KillRetryAlert, stopCause: string): { readonly line: string; readonly entry: string } {
  return killFailureStoppedRetryText({
    key: old.oldKey,
    decision: quoted,
    context: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
    lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE,
    stopCause,
  })
}

/** The stopped-retry text for the old key's kill stopped at a shutdown. */
const stoppedAtShutdown = (old: OldRow, quoted: KillRetryAlert): { readonly line: string; readonly entry: string } => stoppedWait(old, quoted, OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN)

describe('b.jg5 SRJ-702, SRJ-811 (AC 64): the wait\'s kill keeps its tries while no persona is up, and a shutdown is its stop', () => {
  afterEach(waitAfterEach)

  test.each(OLD_ROWS.slice(0, 3))('no persona is up (%s): the kill answering ErrTmuxKillFailed keeps its 3 tries and raises the ordinary version', async (_label, form) => {
    const { h, old } = heldOld(form)
    for (const key of h.keys) h.setUp(key, false)
    h.script({ killError: errTmuxKillFailed() })

    await h.runOldLifeWait(old.instanceId)

    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expect(startupEntries(h).map(([cls]) => cls)).toEqual([PERSONA_KILL_FAILED_LABEL])
  })

  test.each<[string, () => Error, (err: Error) => KillRetryAlert]>([
    ['a try that returned a survivor-naming ErrTmuxKillFailed: the line quotes it', survivorFailure, (err) => ({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err) })],
    ['a try that returned ErrTmuxUnresponsive: no description', () => errTmuxUnresponsive('kill'), () => ({ kind: KILL_RETRY_ALERT_ORDINARY })],
  ])('stopped between tries by the registry\'s close at shutdown, after %s: no further kill or status read, neither version, nothing posted or armed; one line and the old key\'s persona-kill-failed entry with no alert text', async (_label, make, decision) => {
    const { h, p, old } = heldOld(OLD_ROWS[0]![1])
    const err = make()
    h.script({ killError: err })
    const order = recordCallOrder(h)
    const { outcome } = await startedUntilKillWait(h, old, 1)

    h.shutdown()

    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_SHUTDOWN })
    expect(order).toEqual(['kill'])
    const stopped = stoppedAtShutdown(old, decision(err))
    expect(h.lines.filter((line) => line === stopped.line)).toHaveLength(1)
    expect(startupEntries(h)).toEqual([[PERSONA_KILL_FAILED_LABEL, stopped.entry]])
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    expect([oldLifeArms(h), h.controller.isArmed(p)]).toEqual([[], false])
    expectNoLatchOrPost(h)
  })
})

/** End `old`'s hold as another call's read of the row as `ended` ends it (the session manager's one read entry). */
function endHoldByAnotherRead(old: OldRow): void {
  noteOldLifeRowRead(old.instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call')
}

/**
 * The kill tries ended by the hold's end, asked `when` (`before try <n>` or
 * `after try <n>`), as a success with no stopped-retry line, no
 * persona-kill-failed entry and no mark; and the wait with them, stopped for
 * `reason` (the hold's end, or a shutdown that came first). The old
 * key's only kill-failure alert line is the survivor version's, written on
 * the not-configured, log-only route, when a try named a survivor.
 */
function expectHoldEndedSuccess(
  h: RecoveryHarness,
  p: string,
  old: OldRow,
  outcome: LiveRowSequenceOutcome,
  survivor: Error | undefined,
  when: string,
  reason: LiveRowSequenceStopReason = LIVE_ROW_STOP_HOLD_ENDED,
): void {
  expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason })
  const prefix = `[slack] ${OLD_LIFE_WAIT_SITE} for ${oldLifeWaitRef(old.instanceId, old.oldKey)}`
  expect(h.errors.filter((line) => line === killRetryHoldEndedLine(prefix, old.instanceId, when))).toHaveLength(1)
  expect(killFailureLines(h, old.oldKey)).toEqual(
    survivor === undefined ? [] : [killFailureLoggedLine(old.oldKey, KILL_FAILURE_VERSION_SURVIVOR, PERSONA_KILL_SURVIVOR_LABEL, KILL_FAILURE_ROUTE_NOT_CONFIGURED)],
  )
  expect(startupEntries(h)).toEqual(
    survivor === undefined
      ? []
      : [[PERSONA_KILL_SURVIVOR_LABEL, waitAlertEntry(old, { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: descriptionOf(survivor) }, sessionBeforeGet(old))]],
  )
  expect([h.oldLifeHolds.holdOf(old.instanceId), waitsOnKillFailedHold(p), oldLifeArms(h)]).toEqual([undefined, false, []])
  expectNoLatchOrPost(h)
}

describe('b.jg5 SRJ-811\'s Test line, SRJ-702 (AC 64; option A): a hold that ends while the wait\'s kill runs ends its tries as a success', () => {
  afterEach(waitAfterEach)

  test.each<[string, () => Error, boolean]>([
    ['a survivor-naming ErrTmuxKillFailed: one persona-kill-survivor entry quoting it', survivorFailure, true],
    ['ErrTmuxUnresponsive: no entry at all', () => errTmuxUnresponsive('kill'), false],
  ])('between tries (the 2 s wait after the first try answered %s): no further kill or status read', async (_label, make, names) => {
    const { h, p, old } = heldOld(OLD_ROWS[0]![1])
    const err = make()
    h.script({ killError: err })
    const order = recordCallOrder(h)
    const { outcome } = await startedUntilKillWait(h, old, 1)

    endHoldByAnotherRead(old)

    expectHoldEndedSuccess(h, p, old, await h.driveSequence(outcome), names ? err : undefined, 'before try 2')
    expect(order).toEqual(['kill'])
  })

  test('between tries, during the status read before try 2 (it reads the row live): no further kill, one persona-kill-survivor entry', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    const err = survivorFailure()
    h.script({ killError: err })
    const order = recordCallOrder(h, { at: 1, run: () => endHoldByAnotherRead(old) })

    expectHoldEndedSuccess(h, p, old, await h.runOldLifeWait(old.instanceId), err, 'before try 2')
    expect(order).toEqual(['kill', 'status'])
  })

  test.each<[string, () => Error, boolean]>([
    ['ErrTmuxUnresponsive, after a survivor-naming first try: one persona-kill-survivor entry', () => errTmuxUnresponsive('kill'), true],
    ['ErrTmuxKillFailed, after a survivor-naming first try: no persona-kill-failed entry, no mark, one persona-kill-survivor entry', () => errTmuxKillFailed(), true],
    ['ErrTmuxKillFailed, no try naming a survivor: no entry at all', () => errTmuxKillFailed(), false],
  ])('during the third try, which then answers %s', async (_label, make, survivorFirst) => {
    const { h, p, old } = heldOld(OLD_ROWS[0]![1])
    const first = survivorFirst ? survivorFailure() : make()
    h.script({ killQueue: [cannedErr(first)], killError: make() })
    const order = recordCallOrder(h, { at: killTries().length - 1, run: () => endHoldByAnotherRead(old) })

    expectHoldEndedSuccess(h, p, old, await h.runOldLifeWait(old.instanceId), survivorFirst ? first : undefined, `after try ${KILL_RETRY_TRIES}`)
    expect(order).toEqual(killTries())
  })

  test('in the very try that names the survivor (the first): one persona-kill-survivor entry quoting it, no further kill', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[2]![1])
    const err = survivorFailure()
    h.script({ killError: err })
    const order = recordCallOrder(h, { at: 0, run: () => endHoldByAnotherRead(old) })

    expectHoldEndedSuccess(h, p, old, await h.runOldLifeWait(old.instanceId), err, 'before try 2')
    expect(order).toEqual(['kill'])
  })

  test('a shutdown stop in the same window as the hold\'s end (the shutdown first): the hold\'s end wins — a success, no persona-kill-failed entry and no stopped-retry line; the survivor version is still written', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[0]![1])
    const err = survivorFailure()
    h.script({ killError: err })
    const order = recordCallOrder(h)
    const { outcome } = await startedUntilKillWait(h, old, 1)

    h.shutdown()
    endHoldByAnotherRead(old)

    // The tries end as a success; the wait itself ends for the shutdown that came first.
    expectHoldEndedSuccess(h, p, old, await h.driveSequence(outcome), err, 'before try 2', LIVE_ROW_STOP_SHUTDOWN)
    expect(order).toEqual(['kill'])
  })

  test('a hold that ends between tries and is begun again on the same id before try 2: the tries still end as a success — no further kill, no persona-kill-failed entry, no stopped-retry line; the new hold stands unmarked and nothing is armed', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ killError: errTmuxKillFailed() })
    const order = recordCallOrder(h)
    const { outcome } = await startedUntilKillWait(h, old, 1)

    endHoldByAnotherRead(old)
    holdOldAt(h, old.instanceId, old.oldKey, p)

    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
    expect(order).toEqual(['kill'])
    const prefix = `[slack] ${OLD_LIFE_WAIT_SITE} for ${oldLifeWaitRef(old.instanceId, old.oldKey)}`
    expect(h.errors.filter((line) => line === killRetryHoldEndedLine(prefix, old.instanceId, 'before try 2'))).toHaveLength(1)
    // No kill-failure alert line for the old key: neither version, and no stopped-retry line.
    expect(killFailureLines(h, old.oldKey)).toEqual([])
    expect(startupEntries(h)).toEqual([])
    expect([h.oldLifeHolds.holdOf(old.instanceId)?.killFailed, waitsOnKillFailedHold(p), oldLifeArms(h), h.oldLifeWaitRunning(old.instanceId)]).toEqual([false, false, [], false])
    expectNoLatchOrPost(h)
  })
})

// ===========================================================================
// What a hold refuses (b.jg5 SRJ-810, SRJ-1502, SRJ-1505; E27 T3)
//
// On the recovery harness, which composes the session manager's old-life gate
// (every launch reaches `spawnForPersona`), the restart path's old-life hook,
// the reconnect guard, the admission driver (`h.admitSession`, as
// `handleInitialized` decides) and the hold set's end-retry observer (bound
// to the retry controller's run-now entry, `h.holdEndRetries`) as `main()`
// composes them. Each wait a case starts through a launch is held at its
// first run (`holdFindMissing`) until the case releases it with the old row
// in the run's ids, which ends the hold.
// ===========================================================================

/** Persona `key`'s working directory, as its real path. */
const realDirOf = (h: RecoveryHarness, key: string): string => realpathSync(personaOf(h, key).working_directory)

/** Persona `key`'s spawns the stub recorded. */
const spawnsOf = (h: RecoveryHarness, key: string) => h.stub.calls.spawnCalls.filter((params) => params.claude_instance_id === personaInstanceId(key))

/** Every `send-keys` the stub recorded on `instanceId`. */
const sendKeysOn = (h: RecoveryHarness, instanceId: string) => h.stub.calls.sendKeysCalls.filter((params) => params.claude_instance_id === instanceId)

/**
 * End the hold on `instanceId` as its wait's held first run listing the old
 * row in its ids ends it, and drive the wait to its end; then settle the
 * retries at once the end fired. Answers the clock time the hold ended at
 * (no clock time passes between the release and the end).
 */
async function endHoldAtRun(h: RecoveryHarness, hold: FindMissingHold, instanceId: string): Promise<number> {
  const endedAt = h.clock.now()
  const wait = h.oldLifeWaitSettled(instanceId)
  hold.release(cannedFindMissing({ rows: { [instanceId]: 'ids' } }))
  expect(await h.driveSequence(wait)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
  await h.settle()
  expect(h.oldLifeHolds.holdOf(instanceId)).toBeUndefined()
  return endedAt
}

/**
 * Once the hold ended at `endedAt`, persona `key` was retried at once, at
 * that clock time (its pending retry run by the run-now entry), and came up
 * with one plain first spawn: no reuse flag and no `resume`.
 */
async function expectRetriedAtOnceAndUp(h: RecoveryHarness, key: string, endedAt: number): Promise<void> {
  expect(h.holdEndRetries.filter((r) => r.key === key)).toEqual([{ key, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN }])
  expect(h.attempts.filter((a) => a.key === key).map((a) => a.at)).toEqual([endedAt])
  const spawns = spawnsOf(h, key)
  expect(spawns).toHaveLength(1)
  expect('reuse_finished' in spawns[0]!).toBe(false)
  expect(h.stub.calls.resumeCalls).toEqual([])
  await h.runApproverToStop(key)
}

describe('b.jg5 SRJ-810 (AC 53), SRJ-1505: a retired key\'s old life that survived a failed kill is no persona\'s MCP session, and nothing types /mcp reconnect into it', () => {
  afterEach(waitAfterEach)

  test.each<[string, (h: RecoveryHarness, p: string, b: string) => OldRow, RetiredKeyCause]>([
    ['a renamed-away B\'s own cscb_<B>, in the directory P, a different persona, now names', OLD_ROWS[0]![1], RETIRED_KEY_CAUSE_REMOVED],
    ['P\'s own cscb_<P> (a destructive modify\'s same-key old life), in the directory P still names', OLD_ROWS[3]![1], RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY],
  ])('%s: a session from D, P up, is refused as held with one line; the guard types nothing into the old life; P\'s restart run types nothing into it; once the hold ends a session from D is P\'s', async (_label, form, cause) => {
    const { h, p, b } = build()
    const old = form(h, p, b)
    h.retireKey(old.oldKey, { cause })
    h.beginOldLifeHold({ instanceId: old.instanceId, oldKey: old.oldKey, directory: personaOf(h, p).working_directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    h.script({ killError: errTmuxKillFailed() })
    await h.drive(killPersonaInstanceForTeardown(old.oldKey, { clock: h.killRetryClock }))
    h.script({ killError: undefined })
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(true)
    const dir = personaOf(h, p).working_directory

    // Session admission (SRJ-1505): refused as held, whichever persona names D, P up.
    expect(h.admitSession(dir)).toEqual({ kind: 'held', directory: realDirOf(h, p), instanceIds: [old.instanceId] })
    expect(h.errors.filter((line) => line === sessionHeldRefusalLine(realDirOf(h, p), [old.instanceId]))).toHaveLength(1)

    // The reconnect guard, every caller's: nothing typed into the old life's own row.
    expect(await reconnectMcpWithCause(old.oldKey, latchRowStateRead('waiting'))).toEqual({ outcome: 'transient' })

    // P's restart run (the restart adapter's path; a health tick's restart reaches the same work).
    rowReadsUntilSpawn(h, old.oldKey === p ? 'waiting' : UNAVAILABLE_RETRY_ROW_ABSENT)
    // The old row reads live at its first get, missing after (the sequence's step-3 get once its run listed it).
    let gets = 0
    h.script({ getFn: () => old.row(gets++ === 0 ? {} : { state: LIVENESS_DEAD_ROW_MISSING }) })
    const hold = holdFindMissing(h.stub.client)
    expect(await runRestartRetry(p, dir, isLaunchInFlight)).toBe(old.oldKey === p ? RESTART_OUTCOME_RECONNECT_DEFERRED : RESTART_OUTCOME_SEQUENCE_WAITING)
    await h.driveSequence(hold.entered(1))
    // A different persona's run is held by the gate and starts the wait; P's own old life is replaced by its live-row sequence.
    expect([h.oldLifeWaitRunning(old.instanceId), h.sequenceRunning(p)]).toEqual(old.oldKey === p ? [false, true] : [true, false])
    expect(sendKeysOn(h, old.instanceId)).toEqual([])

    hold.release(cannedFindMissing({ rows: { [old.instanceId]: 'ids' } }))
    await h.driveSequence(old.oldKey === p ? h.sequenceSettled(p) : h.oldLifeWaitSettled(old.instanceId))
    await h.settle()
    expect(h.oldLifeHolds.holdOf(old.instanceId)).toBeUndefined()
    expect(h.admitSession(dir)).toMatchObject({ kind: 'admitted', persona: { key: p } })
    expect(h.stub.calls.sendKeysCalls).toEqual([])
    await h.runApproverToStop(p)
  })
})

describe('b.jg5 SRJ-810 bullet 3, SRJ-1502, SRJ-301: the launch gate holds back a persona whose working directory is held, starts the wait once, and retries it at once when the hold ends', () => {
  afterEach(waitAfterEach)

  test('Q in D, held for a pre-persona row: Q\'s launch makes no call for Q, answers sequence-waiting, starts the wait and arms Q\'s timer, uncounted; a second launch starts no second wait; B in its own directory comes up; once the hold ends Q is retried at once and comes up with a plain first spawn', async () => {
    const { h, p: q, b, old } = heldOld(OLD_ROWS[1]![1])
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    h.script({ getResult: old.row() })
    const hold = holdFindMissing(h.stub.client)

    expect(await h.launch(q)).toStrictEqual(heldBack(q))
    await h.driveSequence(hold.entered(1))

    expect(personaCallCounts(h, q)).toEqual({})
    expect(h.oldLifeWaitRunning(old.instanceId)).toBe(true)
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.waiting).toEqual([q])
    expect([oldLifeArms(h), h.controller.isArmed(q), getFailureCount(q)]).toEqual([[q], true, 0])

    expect(await h.launch(q)).toStrictEqual(heldBack(q))
    expect(gateLinesIn(h)).toEqual([gateLine(h, q, old.instanceId, LIVE_ROW_START_STARTED), gateLine(h, q, old.instanceId, OLD_LIFE_HOLD_WAIT_RUNNING)])
    expect([h.stub.calls.killCalls.length, hold.calls.length]).toEqual([1, 1])
    expect(personaCallCounts(h, q)).toEqual({})

    expect((await h.launch(b)).action).toBe('spawned')
    await h.runApproverToStop(b)
    expect(spawnsOf(h, q)).toEqual([])

    const endedAt = await endHoldAtRun(h, hold, old.instanceId)
    await expectRetriedAtOnceAndUp(h, q, endedAt)
    expect(getFailureCount(q)).toBe(0)
  })

  test('SRJ-805, SRJ-810\'s exception: P\'s destructive-modify new half, its own cscb_<P> held, is not held by the gate: its reuse collides and its live-row sequence replaces the old life, ending in the reuse; no gate line, no wait, no old-life arm', async () => {
    const { h, p } = build()
    h.retireKey(p, { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY })
    beginApplyHold(h, p)
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getQueue: [cannedOk(personaRow(h, p))], getResult: personaRow(h, p, { state: LIVENESS_DEAD_ROW_ENDED }) })

    expect(await launchThroughSequence(h, p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: SPAWN_ACTION_FRESH_RETIRED } })

    expect(gateLinesIn(h)).toEqual([])
    expect([oldLifeArms(h), h.oldLifeWaitRunning(personaInstanceId(p)), h.oldLifeHolds.holdOf(personaInstanceId(p))]).toEqual([[], false, undefined])
    expect(h.reuseSpawns().map((params) => params.claude_instance_id)).toEqual([personaInstanceId(p), personaInstanceId(p)])
    expect(spawnsOf(h, p)).toHaveLength(2)
    await h.runApproverToStop(p)
  })
})

/** A live row the start sweep kills, in P's working directory, by source (SRJ-809's sweep start; Q-9). */
const SWEPT_IN_P_DIR: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string, b: string) => Phase1ListRow]> = [
  ['an absent persona\'s row', (h) => absentRow(h, LAUNCH_START_ABSENT_PERSONA_KEY)],
  ['a live pre-persona row', (h, p) => ({ ...prePersonaRow(), cwd: personaOf(h, p).working_directory })],
  ['a row swept for its instance id (B\'s label, another id)', (h, p, b) => listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old`, cwd: personaOf(h, p).working_directory })],
  ['a row swept for its cwd (B\'s own row in P\'s directory)', (h, p, b) => listed(h, b, { cwd: personaOf(h, p).working_directory })],
]

describe('b.jg5 SRJ-811\'s Test line (Q-9), SRJ-810: a persona in the cwd of each row whose start-sweep kill failed waits on its hold, and the wait runs on that row\'s id', () => {
  afterEach(waitAfterEach)

  test.each(SWEPT_IN_P_DIR)('%s: P\'s launch is held back and starts the wait on the row\'s id, every wait call on that id; once the hold ends P is retried at once and comes up', async (_label, swept) => {
    const { h, p, b } = build()
    const row = swept(h, p, b)
    h.script({ killError: errTmuxKillFailed() })
    await sweepOver(h, [row])
    const id = row.claude_instance_id
    expect(h.oldLifeHolds.holdOf(id)).toMatchObject({ directory: personaOf(h, p).working_directory, killFailed: true })
    const killsBefore = h.stub.calls.killCalls.length
    h.script({ killError: undefined, getFn: (params) => cannedGetResult({ claude_instance_id: params.claude_instance_id, cwd: row.cwd }) })
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const hold = holdFindMissing(h.stub.client)

    expect(await h.launch(p)).toStrictEqual(heldBack(p))
    await h.driveSequence(hold.entered(1))

    expect(h.oldLifeWaitRunning(id)).toBe(true)
    expect(h.oldLifeHolds.holdOf(id)?.waiting).toEqual([p])
    expect(h.stub.calls.killCalls.slice(killsBefore).map((k) => k.claude_instance_id)).toEqual([id])
    expect(hold.calls).toHaveLength(1)
    expect(gateLinesIn(h)).toEqual([gateLine(h, p, id, LIVE_ROW_START_STARTED)])
    expect(spawnsOf(h, p)).toEqual([])

    await expectRetriedAtOnceAndUp(h, p, await endHoldAtRun(h, hold, id))
  })
})

describe('b.jg5 SRJ-810 (hatch A3), SRJ-812: a persona already running when its directory becomes held gets no reconnect, kill or launch from the restart path until the hold ends', () => {
  afterEach(waitAfterEach)

  test('P\'s row live, its session connected: once D is held, P\'s restart run makes no call for P, starts the wait and arms P, and P\'s worker is not killed; once the hold ends P is retried at once, finds its session connected and its timer stops', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    h.setConnected(p, true)
    h.script({ statusResult: cannedStatusResult(), getResult: old.row() })
    const hold = holdFindMissing(h.stub.client)

    expect(await runRestartRetry(p, personaOf(h, p).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)
    await h.driveSequence(hold.entered(1))

    expect(personaCallCounts(h, p)).toEqual({})
    expect(h.stub.calls.sendKeysCalls).toEqual([])
    expect(h.errors.filter((line) => line === restartOldLifeHeldLine(p))).toHaveLength(1)
    expect(gateLinesIn(h)).toEqual([gateLine(h, p, old.instanceId, LIVE_ROW_START_STARTED, 'runRestartWork', `persona=${p}`)])
    expect([h.oldLifeWaitRunning(old.instanceId), h.oldLifeHolds.holdOf(old.instanceId)?.waiting, oldLifeArms(h), getFailureCount(p)]).toEqual([true, [p], [p], 0])

    const endedAt = await endHoldAtRun(h, hold, old.instanceId)

    expect(h.holdEndRetries).toEqual([{ key: p, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN }])
    expect(h.attempts.map((a) => [a.key, a.at])).toEqual([[p, endedAt]])
    expect(personaCallCounts(h, p)).toEqual({ statusCalls: 1 })
    expect([h.stub.calls.killCalls.filter((k) => k.claude_instance_id === personaInstanceId(p)), h.stub.calls.sendKeysCalls, spawnsOf(h, p)]).toEqual([[], [], []])
    expect(h.controller.isArmed(p)).toBe(false)
  })
})

describe('b.jg5 SRJ-811 (hatch A3): what stops the wait — the teardown of the only waiting persona, never one while another waits, and shutdown', () => {
  let shared: string | undefined

  afterEach(() => {
    try {
      waitAfterEach()
    } finally {
      if (shared !== undefined) rmSync(shared, { recursive: true, force: true })
      shared = undefined
    }
  })

  /**
   * P and B in one working directory, a pre-persona row held there and its row
   * read live. Configuration validation refuses two personas in one working
   * directory (src/config.ts), so this setup is a unit case of the
   * teardown's other-waiter rule only; the multi-waiter setup production
   * reaches is B's own row swept into P's directory (the next describe), which
   * covers the same teardown logic.
   */
  function sharedHeld(): { h: RecoveryHarness; p: string; b: string; old: OldRow } {
    shared = mkdtempSync(join(tmpdir(), 'old-life-stops-'))
    const { h, p, b } = build({ personas: [{ working_directory: shared }, { working_directory: shared }] })
    const old = oldRowAt(h, p, PRE_PERSONA_ID, PRE_PERSONA_ID, { labels: { ...PRE_PERSONA_LABELS } })
    holdOldAt(h, old.instanceId, old.oldKey, p)
    h.script({ getResult: old.row() })
    return { h, p, b, old }
  }

  test('P, the only waiting persona, removed and torn down while the wait\'s first run is held: the wait stops (teardown) with no further call, P is forgotten as waiting with one line, the hold goes on and nothing is armed', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ getResult: old.row() })
    const hold = holdFindMissing(h.stub.client)
    expect(await h.launch(p)).toStrictEqual(heldBack(p))
    await h.driveSequence(hold.entered(1))
    const order = recordCallOrder(h)

    h.remove(p)
    h.teardown(p)
    hold.release(cannedFindMissing())

    expect(await h.driveSequence(h.oldLifeWaitSettled(old.instanceId))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN })
    expect(order).toEqual([])
    expect(h.errors.filter((line) => line === oldLifeWaitTeardownLine(p, old.instanceId, [], true))).toHaveLength(1)
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.waiting).toEqual([])
    expect([h.oldLifeWaitRunning(old.instanceId), h.controller.isArmed(p), h.holdEndRetries]).toEqual([false, false, []])
  })

  test('P and B both waiting (each held back by its launch, one wait): P removed and torn down, the wait goes on, with one line naming B; once the hold ends B, not P, is retried at once and comes up', async () => {
    const { h, p, b, old } = sharedHeld()
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const hold = holdFindMissing(h.stub.client)
    expect(await h.launch(p)).toStrictEqual(heldBack(p))
    await h.driveSequence(hold.entered(1))
    expect(await h.launch(b)).toStrictEqual(heldBack(b))
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.waiting).toEqual([p, b].sort())

    h.remove(p)
    h.teardown(p)
    await h.clock.flush()

    expect(h.errors.filter((line) => line === oldLifeWaitTeardownLine(p, old.instanceId, [b], true))).toHaveLength(1)
    expect([h.oldLifeWaitRunning(old.instanceId), h.oldLifeHolds.holdOf(old.instanceId)?.waiting]).toEqual([true, [b]])

    const endedAt = await endHoldAtRun(h, hold, old.instanceId)
    await expectRetriedAtOnceAndUp(h, b, endedAt)
    expect(h.holdEndRetries.map((r) => r.key)).toEqual([b])
    expect(spawnsOf(h, p)).toEqual([])
  })

  test('a shutdown while P waits (the wait\'s first run held): the wait stops with no further call, nothing is armed or retried, and no timer is left', async () => {
    const { h, p, old } = heldOld(OLD_ROWS[1]![1])
    h.script({ getResult: old.row() })
    const hold = holdFindMissing(h.stub.client)
    expect(await h.launch(p)).toStrictEqual(heldBack(p))
    await h.driveSequence(hold.entered(1))
    const order = recordCallOrder(h)

    h.shutdown()
    hold.release(cannedFindMissing())

    expect(await h.driveSequence(h.oldLifeWaitSettled(old.instanceId))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_SHUTDOWN })
    expect(order).toEqual([])
    expect([h.controller.isArmed(p), h.holdEndRetries, h.clock.pendingCount()]).toEqual([false, [], 0])
  })

  /** Launch `key`, held back, and step until the wait's kill has made its first try and waits on the clock for the next (beside `key`'s retry timer). */
  async function launchedUntilKillWait(h: RecoveryHarness, key: string): Promise<void> {
    expect(await h.launch(key)).toStrictEqual(heldBack(key))
    for (let turn = 0; turn < 100 && !(h.stub.calls.killCalls.length === 1 && h.clock.pendingCount() === 2); turn++) await h.clock.flush()
    expect([h.stub.calls.killCalls.length, h.clock.pendingCount()]).toEqual([1, 2])
  }

  test.each<[string, () => Error, (err: Error) => KillRetryAlert]>([
    ['a try that returned a survivor-naming ErrTmuxKillFailed: the line quotes it', survivorFailure, (err) => ({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(err) })],
    ['a try that returned ErrTmuxUnresponsive: no description', () => errTmuxUnresponsive('kill'), () => ({ kind: KILL_RETRY_ALERT_ORDINARY })],
  ])('AC 64: the wait\'s kill stopped between tries by the teardown of the only waiting persona, after %s: no further kill or status read, neither version, nothing posted or armed; one line and the old key\'s persona-kill-failed entry with no alert text', async (_label, make, decision) => {
    const { h, p, old } = heldOld(OLD_ROWS[0]![1])
    const err = make()
    h.script({ killError: err })
    await launchedUntilKillWait(h, p)
    const order = recordCallOrder(h)

    h.remove(p)
    h.teardown(p)

    expect(await h.driveSequence(h.oldLifeWaitSettled(old.instanceId))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN })
    expect(order).toEqual([])
    const stopped = stoppedWait(old, decision(err), OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN)
    expect(h.lines.filter((line) => line === stopped.line)).toHaveLength(1)
    expect(startupEntries(h)).toEqual([[PERSONA_KILL_FAILED_LABEL, stopped.entry]])
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.killFailed).toBe(false)
    // The one arm is the gate's, at P's launch; the stopped kill arms nothing.
    expect([oldLifeArms(h), h.controller.isArmed(p)]).toEqual([[p], false])
    expectNoLatchOrPost(h)
  })

  test('AC 64: with B still waiting, P\'s teardown between the kill\'s tries stops neither the wait nor its kill: it makes all its tries, writes no stopped-retry line, and the round arms B', async () => {
    const { h, p, b, old } = sharedHeld()
    h.script({ killError: errTmuxUnresponsive('kill') })
    await launchedUntilKillWait(h, p)
    expect(await h.launch(b)).toStrictEqual(heldBack(b))

    h.remove(p)
    h.teardown(p)

    expect(await h.driveSequence(h.oldLifeWaitSettled(old.instanceId))).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 1, errorClass: AD_ERROR_CLASS_UNAVAILABLE, latched: false })
    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    // UNAVAILABLE at every try decides no alert, and the tries were not stopped: no kill-failure line at all.
    expect(killFailureLines(h, old.oldKey)).toEqual([])
    expect(h.oldLifeHolds.holdOf(old.instanceId)?.waiting).toEqual([b])
    expect([h.controller.isArmed(b), h.controller.isArmed(p)]).toEqual([true, false])
  })
})

describe('b.jg5 SRJ-810, SRJ-811 (Q-9): B\'s own row swept into P\'s directory, its kill failed — P and B both wait on the one hold; B is retried only once the stopped wait on its own row has settled, and its teardown as the last waiter stops the wait', () => {
  afterEach(waitAfterEach)

  /**
   * B's own row listed by the start sweep with its `cwd` in P's working
   * directory, its kill failing, so the sweep holds `cscb_<B>` at P's
   * directory (the multi-waiter setup production reaches: config validation
   * refuses two personas in one directory). P's launch is held back by the
   * gate and starts the wait on `cscb_<B>`, its first run held; B's relaunch
   * (the start entry for its own launching sequence) is refused
   * `already-running` and B is recorded as waiting.
   */
  async function bOwnRowWaitedOn(): Promise<{ h: RecoveryHarness; p: string; b: string; id: string; hold: FindMissingHold }> {
    const { h, p, b } = build()
    const row = listed(h, b, { cwd: personaOf(h, p).working_directory })
    h.script({ killError: errTmuxKillFailed() })
    await sweepOver(h, [row])
    const id = personaInstanceId(b)
    expect(row.claude_instance_id).toBe(id)
    h.script({ killError: undefined, getFn: (params) => cannedGetResult({ claude_instance_id: params.claude_instance_id, cwd: row.cwd }) })
    rowReadsUntilSpawn(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const hold = holdFindMissing(h.stub.client)

    expect(await h.launch(p)).toStrictEqual(heldBack(p))
    await h.driveSequence(hold.entered(1))
    expect(startLiveRowSequence(h.sequenceRequest(b, { lastReadState: 'waiting' }))).toBe(LIVE_ROW_START_ALREADY_RUNNING)

    expect(h.oldLifeWaitRunning(id)).toBe(true)
    expect([...(h.oldLifeHolds.holdOf(id)?.waiting ?? [])].sort()).toEqual([p, b].sort())
    expect([oldLifeArms(h), h.controller.isArmed(p), h.controller.isArmed(b)]).toEqual([[p, b], true, true])
    return { h, p, b, id, hold }
  }

  test('the hold ends while the wait\'s run is held: P is retried at once; B, whose own cscb_<B> the wait runs on, only once the stopped wait has settled, both at the end\'s clock time; one end line naming B as deferred and one settled line; both come up with a plain first spawn', async () => {
    const { h, p, b, id, hold } = await bOwnRowWaitedOn()
    const endedAt = h.clock.now()

    noteOldLifeRowRead(id, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call')

    expect(h.oldLifeHolds.holdOf(id)).toBeUndefined()
    expect(h.holdEndRetries).toEqual([{ key: p, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN }])
    expect(h.errors.filter((line) => line === oldLifeHoldEndRetryLine(id, [p], [], [b]))).toHaveLength(1)
    expect(h.errors.filter((line) => line.startsWith(settledRetryLinePrefix(id, b)))).toEqual([])

    hold.release(cannedFindMissing())
    expect(await h.driveSequence(h.oldLifeWaitSettled(id))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
    await h.settle()

    expect(h.holdEndRetries).toEqual([
      { key: p, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN },
      { key: b, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN },
    ])
    expect(h.errors.filter((line) => line === oldLifeHoldEndSettledRetryLine(id, b, undefined))).toHaveLength(1)
    await expectRetriedAtOnceAndUp(h, p, endedAt)
    await expectRetriedAtOnceAndUp(h, b, endedAt)
  })

  test('B latched by the wait\'s own read of its row (its get after the held run reads it pending with no launch start): the round ends stopped as latched and keeps the hold; it arms P, uncounted, and not B, with one latched line for B', async () => {
    const { h, p, b, id, hold } = await bOwnRowWaitedOn()
    const armsBefore = oldLifeArms(h).length
    h.script({ getFn: () => personaRow(h, b, { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE, cwd: personaOf(h, p).working_directory }) })

    hold.release(cannedFindMissing())

    expect(await h.driveSequence(h.oldLifeWaitSettled(id))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED })
    expect([h.latch.isLatched(p), h.latch.isLatched(b)]).toEqual([false, true])
    expect(h.oldLifeHolds.holdOf(id)?.waiting).toEqual([p, b])
    // The round's arms: P only; B, latched, gets one latched line and its timer stays stopped (SRJ-305).
    expect(oldLifeArms(h).slice(armsBefore)).toEqual([p])
    expect([h.controller.isArmed(p), h.controller.isArmed(b)]).toEqual([true, false])
    expect([p, b].map((key) => h.errors.filter((line) => line === oldLifeWaitLatchedLine(key)).length)).toEqual([0, 1])
    expect(h.errors.filter((line) => line.startsWith(waitEndLinePrefix(id, b)))).toEqual([waitEndLine(id, b, { kind: OLD_LIFE_WAIT_END_LATCHED, kept: true }, [p])])
    expect([getFailureCount(p), getFailureCount(b)]).toEqual([0, 0])
  })

  test('P torn down first (B, its own row held, still waits: the wait goes on); then B\'s teardown as the last waiter stops the wait (teardown) with no further call, and the hold goes on with no one waiting and no one retried', async () => {
    const { h, p, b, id, hold } = await bOwnRowWaitedOn()

    h.remove(p)
    h.teardown(p)
    await h.clock.flush()

    expect(h.errors.filter((line) => line === oldLifeWaitTeardownLine(p, id, [b], true))).toHaveLength(1)
    expect([h.oldLifeWaitRunning(id), h.oldLifeHolds.holdOf(id)?.waiting]).toEqual([true, [b]])

    const order = recordCallOrder(h)
    h.remove(b)
    h.teardown(b)
    hold.release(cannedFindMissing())

    expect(await h.driveSequence(h.oldLifeWaitSettled(id))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN })
    expect(order).toEqual([])
    expect(h.errors.filter((line) => line === oldLifeWaitTeardownLine(b, id, [], true))).toHaveLength(1)
    expect(h.oldLifeHolds.holdOf(id)?.waiting).toEqual([])
    expect([h.oldLifeWaitRunning(id), h.holdEndRetries, spawnsOf(h, p), spawnsOf(h, b)]).toEqual([false, [], [], []])
  })

  // The wait's outcome names the stop it met first: the hold's end, or B's
  // latch, at which a wait on B's own row stops (SRJ-502).
  test.each<[string, string, (h: RecoveryHarness, b: string) => Promise<void>, string]>([
    ['removed', OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_APPLIED, async (h, b) => h.remove(b), LIVE_ROW_STOP_HOLD_ENDED],
    ['latched (a reconnect of its own row, no longer held, answered CONFLICT)', OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED, async (h, b) => {
      h.script({ sendKeysError: errTmuxSessionConflict('send-keys', 'different-id') })
      expect(await reconnectMcpWithCause(b, latchRowStateRead('waiting'))).toMatchObject({ outcome: 'transient', latched: true })
      expect(h.latch.isLatched(b)).toBe(true)
    }, LIVE_ROW_STOP_LATCHED],
  ])('B %s after the hold ended but before the stopped wait settled: P is retried at once, B is not retried once the wait settles, with one settled line saying why', async (_label, why, change, stopReason) => {
    const { h, p, b, id, hold } = await bOwnRowWaitedOn()
    const endedAt = h.clock.now()
    noteOldLifeRowRead(id, { kind: OLD_LIFE_ROW_READ_STATE, state: LIVENESS_DEAD_ROW_ENDED }, 'another call')
    expect(h.errors.filter((line) => line === oldLifeHoldEndRetryLine(id, [p], [], [b]))).toHaveLength(1)

    await change(h, b)
    hold.release(cannedFindMissing())
    expect(await h.driveSequence(h.oldLifeWaitSettled(id))).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: stopReason })
    await h.settle()

    expect(h.holdEndRetries).toEqual([{ key: p, at: endedAt, result: UNAVAILABLE_RETRY_RUN_NOW_RAN }])
    expect(h.errors.filter((line) => line === oldLifeHoldEndSettledRetryLine(id, b, why))).toHaveLength(1)
    expect(spawnsOf(h, b)).toEqual([])
    await expectRetriedAtOnceAndUp(h, p, endedAt)
  })
})
