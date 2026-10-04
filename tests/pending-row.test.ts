/**
 * pending-row.test.ts — `src/pending-row.ts`: the launch-start reader and the
 * pending-with-no-launch-start predicate (b.jg5 SRJ-406, SRJ-408, SRJ-513).
 *
 * Covered now: `parseLaunchStart` gives the instant of both of the stub's
 * sample forms (with and without the fraction), a numeric-offset form,
 * fractions of other lengths (first three digits kept, the rest dropped, never
 * rounded) and lower-case `t`/`z`; it range-checks each field (Feb 30, a
 * non-leap Feb 29 and out-of-range fields give none; a leap-year Feb 29 and a
 * `:60` leap second give an instant); absent, `null`, empty, non-string and
 * malformed values give none. Expected instants are derived from the samples'
 * own components (`Date.parse` of an ECMAScript date-time string, `Date.UTC`
 * of the parts), never typed as epoch numbers.
 * `isPendingWithNoLaunchStart` holds for a `pending` `status` result, `get`
 * row or `list` row with no, a `null` or an unparseable launch start, and for
 * none with a valid one, in any other state, or for no row.
 * The stub's sample forms (fractional, whole, none), a numeric offset and a
 * fraction longer than milliseconds read the same from a `status` result, a
 * `get` row and a `list` row.
 *
 * Ageing (b.jg5 SRJ-406, SRJ-408; AC 30, AC 80), with G from the E6 accessor
 * (`adGraceMsInEffect`), never a literal: `isPendingRowAged` is false one
 * tick before launch start + G and true at it, for a fixed wait and for the
 * accessor, in both forms (a fractional and a whole launch start naming the
 * same instant age identically), and never from `started_at`; a launch start
 * of none is never aged, even with a wait of 0; `AD_WAIT_NEVER_ENDS`, NaN
 * and a throwing accessor are never aged. `armPendingRowWait` on
 * `createFakeClock`, on a resumed row whose `started_at` is older than G and
 * whose launch start is the arm time: fires once at launch start + G and not
 * one tick earlier, in both forms; a launch start of none answers
 * `PENDING_ROW_WAIT_NOT_ARMED`, leaves no timer and throws nothing; G raised
 * while armed (a settings file rewritten under a temp HOME and read by the
 * installed reader) is honoured; a G beyond `MAX_TIMER_DELAY_MS` does not
 * fire after 1 ms and fires at its deadline (E28's one case beyond the timer
 * maximum, E6's hatch note); `AD_WAIT_NEVER_ENDS`, fixed or from the
 * accessor, never fires; cancel stops it; a NaN wait still throws
 * `RangeError` and arms nothing. `afterEach` asserts the case's clock has no
 * pending timer and passes the settings reader's log lines to `assertNoLeak`.
 *
 * SRJ-408's own-row leg: a configured persona's own `pending` row with no
 * launch start (each form; P's current life, the covered shape, and a row
 * whose `cwd` is not P's, from `LAUNCH_START_CASE_ROWS`; each read shape)
 * gets E16's "launch start not recorded" decision (`decideOwnRowRead`) and
 * is never aged or armed. The old-key leg is `tests/old-life-wait.test.ts`'s.
 *
 * Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408,
 * SRJ-513; AC 30, AC 33, AC 35): a table over `decidePendingRowCover`, its
 * answers and reasons the exported ones: P's own current life is covered; a
 * retired key's row before its mark is not (its old life), after its mark it
 * is; a `cwd` or `config_dir` mismatch is not; an unresolved directory is
 * undecided; a configured persona's own row with no launch start answers "no
 * launch start" in every shape, never covered; the order of the checks, the
 * same at every site except that a status-only site decides an unresolved
 * directory before a `cwd` that resolves elsewhere (the ladder, the other
 * way round). Then
 * the session manager's read-and-step entry (`readAndStepPendingRow`) on
 * `makeRecoveryHarness` (`session_restart_delay` and `health_check_interval`
 * 0), after one `get`: a covered row (the key not recorded, recorded and
 * marked, or its mark held in memory after a failed write) and an undecided
 * one (its `claude_config_dir` unresolvable, or its working directory with no
 * real path whatever the row's `cwd`: one with no real path, P's configured
 * path lexically, or an existing directory elsewhere; the comparison these
 * status-only sites read is `pendingRowComparisonFor`'s, a pure table) arm P's
 * retry timer in pending-only mode with the controller's own armed line, with
 * no kill, launch, approver or sequence; a row that is not covered logs its
 * line and makes exactly one start request (step 1, the conversation not
 * kept, context `recovery`, the retired-key flag for an old life), with no
 * arm and no approver; P's own row with no launch start latches P and arms
 * nothing. Where the step is called from (the deferral, the pending-only
 * retry, the ladder) is tests/server.test.ts's,
 * tests/unavailable-retry.test.ts's and tests/session-manager.test.ts's.
 *
 * The stuck-launch post (b.jg5 SRJ-1017, SRJ-1016, SRJ-1001; AC 67). One pin
 * case holds SRJ-1017's texts literally (the file's only literal text): the
 * relaunching text at the default settings (B 5 minutes) and with
 * `pending_grace_seconds` 300 (6 minutes), and the held text with and
 * without the attach line. Every other case builds its expectation from
 * `src/`'s exports: B as `wholeMinutes(adLaunchBoundMsInEffect())`, rounded
 * down (a B that is not whole minutes); the session through
 * `quotedPersonaSessionName`, keys that prefix one another kept apart; the
 * held text's lines from the exported pieces, the flagged form with the
 * clause after the launch start and no attach line, the unflagged one with
 * all three remedies and the human-only line; the launch start through the
 * one renderer (`describeLaunchStartForLog`): an ISO 8601 UTC timestamp
 * ending in `Z`, one string for the stub's two sample forms, a numeric
 * offset and the parsed number of one instant, and never the raw text.
 * SRJ-1001: neither text in any form matches a session-ending command form
 * (`SESSION_ENDING_COMMAND_FORMS`), no line names anything of
 * `CSCB_OWN_LINE_FORBIDDEN` (kill-pane, set-option, agent-director delete,
 * clear-latch, has-session, a label option), every tmux target is exact
 * (`=`), and no text says "dispatcher bug" (SRJ-713). The posters over a real
 * `createPersonaEpisodes` on `createFakeClock`: each text once per
 * episode (both held forms share one mark), the other text still once; a
 * new episode after `endStuckLaunchEpisode` posts each again; nothing posted
 * and no episode begun while the injected `tmux-unavailable` query answers
 * raised or throws; `closed` after `close()`; a submitted teardown mutes the
 * post, which still counts; an episodes call that throws answers
 * failed, never the gate's suppressed; two personas are independent; one line per call, from the
 * exported line builders. The episode-end predicate's table. `assertNoLeak`
 * over every text and line, with a key carrying a fake token (masked by
 * `withoutName`), a raw launch start carrying one, and thrown values
 * carrying the leak marker. Where the episode ends at the session manager's
 * reads and at a latch is tests/session-manager.test.ts's and
 * tests/conflict-latch.test.ts's.
 *
 * The pending-row rule (b.jg5 SRJ-410; AC 30, AC 32, AC 33, AC 84). Its
 * pure decisions: `pendingRowAgeOf` (both forms; no launch start; G checked
 * before B; a G of `AD_WAIT_NEVER_ENDS`, NaN or a throwing accessor never
 * past G; a B that never ends; a G beyond the timer maximum compared, never
 * armed; the accessors read at each call), `isPendingRowLapEligible`,
 * SRJ-117's lap column one case per cell (`decidePendingRowLapPane`), the
 * lap's Enter one case per outcome (`decidePendingRowLapEnter`) and the
 * Enter's mapper by class and name (`pendingRowLapEnterFailureOf`), the
 * run-and-get reading (`readPendingRowRun`) and step 3
 * (`decidePendingRowStepThree`, `tmux-unavailable` winning over every
 * input). Its driver (`createPendingRowRule`) over injected dependencies:
 * every gate in order with one gate line and no call; nothing and no line
 * younger than G; from G the lap (no lap while an approver runs or after the
 * launch met `ErrSpawnNotInteractive`; a "Stop" cell ends the lap only), one
 * run and one get, one round line; the latch asked again after each call;
 * a refused run or a failed get ends the round; at B the held post on the
 * get's launch start, judged or not, without the attach line after
 * `ErrSpawnNotInteractive`, never while `tmux-unavailable` is raised; the
 * own-launch slot's branches; a throwing dependency's failed line. Then on
 * `makeRecoveryHarness` (both settings 0 unless a case says) with the rule
 * installed as `main()` installs it and P's row scripted by
 * `makePendingRowModel`: AC 30 over three origins (a row found `pending` at
 * the start pass, a failed fresh spawn, a server restart mid-launch), its
 * `tmux-unresponsive` and `tmux-unavailable` conditions and its outage; AC
 * 32's lap; AC 33's cadence and the approver-stop run's exemption; AC 84 at
 * two non-default G; SRJ-406's legs in both forms; E6's raised G and its G
 * beyond the timer maximum or never ending; SRJ-117's lap column end to end;
 * no further lap after the lap's or the approver's `ErrSpawnNotInteractive`,
 * and a new launch lapping again; a latched P and E16's own row with no
 * launch start; an uncovered and an undecided row; hatch A2's attempt at a
 * retry and at the approver's stop; a failed get after the run; SRJ-810's
 * held directory. Each harness run is passed to `assertNoLeak`. Which
 * approver stops run the rule, where the retry action, the deferral and the
 * ladder run it, and the lap's `send-keys` cells are
 * tests/approve-trust-folder-dialog.test.ts's,
 * tests/unavailable-retry.test.ts's, tests/server.test.ts's,
 * tests/restart.test.ts's and tests/session-manager.test.ts's.
 *
 * CSCB's own stuck launch, one abort per stuck-launch episode (b.jg5
 * SRJ-412; AC 9, AC 31, AC 48, AC 67, AC 84). `createStuckLaunchAbort` over
 * fake dependencies (the relaunching text's real poster over a real
 * episodes instance): the post, the approver's stop, the kill and the
 * sequence's start in order, one line each; each kill answer, whether it
 * uses the abort (`stuckLaunchAbortKillUsesAbort`) and what the round
 * answers; Q-12's same abort with no second post after a kill that did
 * nothing or was stopped; no abort once used, until the episode's end (a
 * live read, P's teardown) disposes of the state; no abort without the post
 * (suppressed, closed, failed, no episode open); one abort in progress at a
 * time; the latch and both outages asked again after the approver's stop,
 * a throwing query taken as raised; a rejecting stop or kill kept with its
 * redacted line and the next call aborting. Then on `makeRecoveryHarness`
 * with `harnessNow` and the own-launch drivers (`launchOwnPending`,
 * `scriptModelLaunch`, `launchByAnotherProcess`, `driveToB`): a resumed own
 * launch at an unrecognised prompt, judged at B or in neither list, gets one
 * relaunching post, one kill (`kill_sent` true), the sequence from step 2 and
 * the `resume` of the same row with nothing counted; a timed-out launch
 * inside its window is aborted, its `kill_sent` false going on to the
 * sequence; a launch whose approver's or lap's `send-keys` met
 * `ErrSpawnNotInteractive`, another process's launch and a launch start
 * before or after its window get the held post and no kill; the relaunch
 * still `pending` at its B gets the held text once and no kill; the abort
 * kill's `ErrTmuxKillFailed` (3 tries, 2 s apart, one alert with the
 * 'stuck-launch abort' context, the held text once at the next retry), the
 * CONFLICT kill backstop and one UNUSABLE NAME row of `conflict-cases.ts` (a
 * latch with one post, never retried; every row is session-manager.test.ts's
 * at unit level), UNAVAILABLE from the
 * approver's stop and from a retry (`tmux-unresponsive` or the arm, hatch
 * A2, then the same abort with no second post), `ErrTmuxNotAvailable` (the
 * same abort only once a lap clears the outage), CONFIG (the abort waits for
 * the clear), a survivor-naming failure then a non-success (one alert), and
 * tries stopped because P stopped being up (no alert, the abort unused);
 * no launch or delete after any non-success; neither text and no kill while
 * a lap's `tmux-unavailable` is raised at B, nor for P latched; a server
 * restart forgets the record; the sequence's SRJ-717 stop (no alert, the
 * held text once after) and its step-5 alert with the abort's context; a
 * running approver stopped with `stuck-launch-abort` and no rule run after
 * that stop. The own-launch record's set and forget points and the abort
 * kill's typed answers are tests/session-manager.test.ts's; the approver's
 * stop reason is tests/approve-trust-folder-dialog.test.ts's.
 *
 * A failed launch's `pending` row waited out (b.jg5 SRJ-713, SRJ-111; HO
 * rev 26, rev 28; AC 6, AC 30), on the same harness with `harnessNow`: a
 * fresh plain spawn's `ErrTmuxSessionCreate`, a "duplicate session" whose end
 * write was not applied (its `ErrTmuxSessionCreate`, and HO rev 26's
 * re-lookup `ErrTmuxUnresponsive`), and a `resume`'s and a reuse's
 * `ErrTmuxSessionCreate` whose row was not restored: P's answer (a LAUNCH
 * FAILURE counted once, the UNAVAILABLE re-lookup not), P's timer armed at
 * once with no approver, the call's window with no end and no own-launch
 * record; runs only from G, one held post at B and never the relaunching
 * post, an abort, a kill, a sequence or a further count; P brought up once
 * the row reads `missing`. An attempt meanwhile collides and its `get` reads
 * the same covered row: `no-op`, no second launch. HO rev 18's lost-reply
 * row (a timed-out launch) marked `missing` past G and before B: that
 * round's hand-off resumes it through get-then-act. These cases and AC 30's
 * check that nothing the harness captured says "dispatcher bug"
 * (`dispatcherBugWordingIn`). An uncovered row's
 * and a raised `tmux-unavailable`'s missing post are the rule's harness
 * describe's above.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AD_SETTING_INTEGER_MAX,
  AD_WAIT_NEVER_ENDS,
  adGraceMsInEffect,
  adLaunchBoundMs,
  adLaunchBoundMsInEffect,
  DEFAULT_AD_SETTINGS,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  installAdSettings,
  pendingGraceMinimumSeconds,
  resetAdSettingsForTests,
  wholeMinutes,
  type AdSettingsReader,
} from '../src/ad-settings.ts'
import {
  armPendingRowWait,
  decidePendingRowCover,
  describeLaunchStartForLog,
  endStuckLaunchEpisode,
  isPendingRowAged,
  isStuckLaunchEpisodeEndState,
  postStuckLaunchHeld,
  postStuckLaunchRelaunching,
  STUCK_LAUNCH_ALREADY_POSTED,
  STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE,
  STUCK_LAUNCH_HELD_HEAD,
  STUCK_LAUNCH_HUMAN_ONLY_LINE,
  STUCK_LAUNCH_MARK_HELD,
  STUCK_LAUNCH_MARK_RELAUNCHING,
  STUCK_LAUNCH_NOT_POSTED_CLOSED,
  STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE,
  STUCK_LAUNCH_POST_FAILED,
  STUCK_LAUNCH_POSTED,
  STUCK_LAUNCH_RELAUNCHING_HEAD,
  STUCK_LAUNCH_SUPPRESSED,
  STUCK_LAUNCH_ABORT_KEPT_KILL_FAILED,
  STUCK_LAUNCH_ABORT_KEPT_STOPPED,
  STUCK_LAUNCH_ABORT_KEPT_TRY_LATER,
  STUCK_LAUNCH_ABORT_KILL_FAILED,
  STUCK_LAUNCH_ABORT_KILL_LATCHED,
  STUCK_LAUNCH_ABORT_KILL_STOPPED,
  STUCK_LAUNCH_ABORT_KILL_SUCCEEDED,
  STUCK_LAUNCH_ABORT_KILL_TRY_LATER,
  STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED,
  STUCK_LAUNCH_ABORT_SEQUENCE_STARTED,
  STUCK_LAUNCH_ABORT_SKIP_CONFIG_MALFORMED,
  STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT,
  STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS,
  STUCK_LAUNCH_ABORT_SKIP_NO_EPISODE,
  STUCK_LAUNCH_ABORT_SKIP_POST_FAILED,
  STUCK_LAUNCH_ABORT_SKIP_SHUTDOWN,
  STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE,
  createStuckLaunchAbort,
  stuckLaunchAbortKillLine,
  stuckLaunchAbortKillUsesAbort,
  stuckLaunchAbortSequenceLine,
  stuckLaunchAbortSkippedLine,
  STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED,
  STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED,
  stuckLaunchPostSkippedLine,
  stuckLaunchAbortStartedLine,
  type StuckLaunchAbortDeps,
  type StuckLaunchAbortKillAnswer,
  type StuckLaunchAbortSequenceStart,
  stuckLaunchAttachRemedyLine,
  stuckLaunchEndRowLiveReason,
  stuckLaunchEpisodeEndedLine,
  stuckLaunchEpisodeEndFailedLine,
  stuckLaunchHeldText,
  stuckLaunchListRemedyLine,
  stuckLaunchOutageQueryFailedLine,
  stuckLaunchPostFailedLine,
  stuckLaunchPostLine,
  stuckLaunchRelaunchingText,
  type StuckLaunchPostAnswer,
  type StuckLaunchPostEpisodes,
  type StuckLaunchPosterDeps,
  type StuckLaunchTextMark,
  isPendingWithNoLaunchStart,
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
  PENDING_ROW_WAIT_NOT_ARMED,
  type PendingRowComparison,
  type PendingRowCover,
  type PendingRowCoverInput,
  type PendingRowFields,
  type PendingRowNotCoveredReason,
  type PendingRowUndecidedReason,
  type PendingRowWaitArmed,
  createPendingRowRule,
  decidePendingRowLapEnter,
  decidePendingRowLapPane,
  decidePendingRowStepThree,
  isPendingRowLapEligible,
  pendingRowAgeOf,
  pendingRowLapEnterFailureOf,
  pendingRowRuleFailedLine,
  pendingRowRuleGateLine,
  pendingRowRuleRoundLine,
  readPendingRowRun,
  PENDING_ROW_AGE_AT_B,
  PENDING_ROW_AGE_FROM_G,
  PENDING_ROW_AGE_NO_LAUNCH_START,
  PENDING_ROW_AGE_YOUNGER_THAN_G,
  PENDING_ROW_GET_ABSENT,
  PENDING_ROW_GET_LATCHED,
  PENDING_ROW_GET_REFUSED,
  PENDING_ROW_GET_ROW,
  PENDING_ROW_LAP_ENTER_ABSENT,
  PENDING_ROW_LAP_ENTER_CONFIG,
  PENDING_ROW_LAP_ENTER_CONFLICT,
  PENDING_ROW_LAP_ENTER_ENVIRONMENT,
  PENDING_ROW_LAP_ENTER_GONE,
  PENDING_ROW_LAP_ENTER_LATCHED,
  PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE,
  PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED,
  PENDING_ROW_LAP_ENTER_SENT,
  PENDING_ROW_LAP_ENTER_UNAVAILABLE,
  PENDING_ROW_LAP_ENTER_UNCLASSIFIED,
  PENDING_ROW_LAP_ENTER_UNUSABLE_NAME,
  PENDING_ROW_LAP_NEXT_ENTER,
  PENDING_ROW_LAP_NEXT_LATCHED,
  PENDING_ROW_LAP_NEXT_RUN,
  PENDING_ROW_LAP_NEXT_STOPPING,
  PENDING_ROW_READING_GONE,
  PENDING_ROW_READING_LATCHED,
  PENDING_ROW_READING_LIVE,
  PENDING_ROW_READING_PENDING,
  PENDING_ROW_READING_READ_REFUSED,
  PENDING_ROW_READING_RUN_REFUSED,
  PENDING_ROW_READING_UNKNOWN_STATE,
  PENDING_ROW_RELAUNCH_KEPT,
  PENDING_ROW_RELAUNCH_LATCHED,
  PENDING_ROW_RELAUNCH_SEQUENCE_STARTED,
  PENDING_ROW_RULE_GONE,
  PENDING_ROW_RULE_HELD,
  PENDING_ROW_RULE_LATCHED,
  PENDING_ROW_RULE_LIVE,
  PENDING_ROW_RULE_LOG_HEAD,
  PENDING_ROW_RULE_ORIGIN_APPROVER_STOP,
  PENDING_ROW_RULE_ORIGIN_RETRY,
  PENDING_ROW_RULE_READ_REFUSED,
  PENDING_ROW_RULE_REFUSAL,
  PENDING_ROW_RULE_RELAUNCH,
  PENDING_ROW_RUN_FAILED,
  PENDING_ROW_RUN_JUDGED_ALIVE,
  PENDING_ROW_RUN_LATCHED,
  PENDING_ROW_RUN_LEFT_LIVE,
  PENDING_ROW_RUN_MARKED_MISSING,
  PENDING_ROW_RUN_NOT_JUDGED,
  PENDING_ROW_RUN_REFUSED,
  PENDING_ROW_STEP3_CONFIG_MALFORMED,
  PENDING_ROW_STEP3_HELD,
  PENDING_ROW_STEP3_LATCHED,
  PENDING_ROW_STEP3_RELAUNCH,
  PENDING_ROW_STEP3_TMUX_UNAVAILABLE,
  type PendingRowLapEnterConflict,
  type PendingRowLapEnterFailure,
  type PendingRowLapEnterOutcome,
  type PendingRowLapNext,
  type PendingRowOwnLaunchHooks,
  type PendingRowRelaunchAnswer,
  type PendingRowRuleAnswer,
  type PendingRowRuleRefusalReason,
  type PendingRowRuleDeps,
  type PendingRowRuleGet,
  type PendingRowRuleInput,
  type PendingRowRunPlacement,
  type PendingRowRunReading,
  type PendingRowStepThree,
  type PendingRowStepThreeInput,
} from '../src/pending-row.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_DEAD_ROW_NO_ROW,
} from '../src/liveness-reading.ts'
import {
  FULL_PANE_READ_LINES,
  PANE_READ_LATCHED,
  PANE_READ_NOT_READ_LATCHED,
  PANE_READ_PANE,
  paneReadFailureOf,
  type PaneReadConflict,
  type PaneReadOutcome,
} from '../src/pane-read.ts'
import { getOutageFlags } from '../src/outage-state.ts'
import type { ConflictLatchRecord } from '../src/conflict-latch.ts'
import { OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL } from '../src/retired-keys.ts'
import { KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_RECOVERY, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT } from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import { describeKillOutcome, KILL_OUTCOME_KILLED } from '../src/checked-kill.ts'
import { AD_ERROR_CLASS_UNAVAILABLE, LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT } from '../src/ad-error-class.ts'
import { getFailureCount, recordFailure } from '../src/backoff.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'
import { LIVE_ROW_SEQUENCE_ENTRY_KILL, LIVE_ROW_START_STARTED, type LiveRowSequenceRequest } from '../src/live-row-sequence.ts'
import {
  CONFIG_DIR_LABEL_PREFIX,
  personaInstanceId,
  personaTmuxSessionName,
  quotedPersonaSessionName,
  renderPersonaRef,
  tmuxExactSessionTarget,
} from '../src/persona-identity.ts'
import { createPersonaEpisodes, killFailureStoppedRetryText, PERSONA_EPISODE_KIND_STUCK_LAUNCH, type PersonaEpisodes } from '../src/persona-episodes.ts'
import type { PersonaTeardownWindowState } from '../src/persona-notifier.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  _resetConfigDirFs,
  _resetFindMissingMemo,
  _setConfigDirFs,
  _setFindMissingMemoTtlMs,
  APPROVER_STOP_CAP,
  APPROVER_STOP_STUCK_LAUNCH_ABORT,
  buildPendingRowRuleDeps,
  isCscbOwnLaunch,
  LAUNCH_CALL_END_LAUNCH_TIMEOUT,
  launchCallWindowOf,
  noLaunchStartPendingRowLine,
  ownLaunchRecordOf,
  paneShowsStartupDialog,
  PENDING_ROW_STEP_LATCHED,
  pendingRowComparisonFor,
  pendingRowRuleApproverStopGatedLine,
  pendingRowRuleApproverStopLine,
  pendingRowRuleNoEpisodesLine,
  pendingRowRuleNoEpisodesRelaunchingLine,
  PERSONA_KILL_STOP_CAUSE_NOT_UP,
  readAndStepPendingRow,
  setStuckLaunchEpisodes,
  SPAWN_ACTION_RETRYING,
  type RowPersonaComparison,
  type SpawnPersonaResult,
  uncoveredPendingRowLine,
  undecidedPendingRowLine,
} from '../src/session-manager.ts'
import {
  RETRY_BLOCK_LAUNCH,
  UNAVAILABLE_RETRY_AGAIN_ROW_PENDING,
  UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_ROW_PENDING,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_HELD,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
} from '../src/unavailable-retry.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import { decideOwnRowRead, ROW_READ_LAUNCH_START_NOT_RECORDED } from '../src/row-read-rules.ts'
import {
  cannedFindMissing,
  cannedGetResult,
  cannedListRow,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errInvalidFlags,
  errNoSessionId,
  errSendKeysWhileRelayed,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotInteractiveNoLaunchStart,
  cannedKillResult,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxSessionCreateStaysPending,
  errTmuxUnresponsive,
  errTmuxUnresponsiveNewRowEnded,
  errUnusableName,
  holdFindMissing,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
  type CannedRowPersona,
  type PersonaGetResultOverrides,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  judgeMissingFrom,
  judgeMissingFromG,
  judgeNotJudged,
  judgeUnverified,
  launchStartText,
  makePendingRowModel,
  PENDING_ROW_DIALOG_DEV_CHANNELS,
  PENDING_ROW_DIALOG_NONE,
  PENDING_ROW_DIALOG_TRUST,
  PENDING_ROW_DIALOG_UNRECOGNISED,
  PENDING_ROW_MODEL_NO_ROW,
  pendingRowDialogPane,
  type PendingRowModel,
  type PendingRowModelOptions,
  type PendingRowModelVerb,
} from './test-helpers/pending-row-model.ts'
import { PRE_PERSONA_ID } from './test-helpers/old-life.ts'
import { settingsLinesOtherThanValues, writeAgentDirectorConfig, type AdConfigTables } from './test-helpers/ad-settings.ts'
import {
  CSCB_OWN_LINE_FORBIDDEN,
  cscbOwnLineForbiddenIn,
  expectedLatchRecord,
  STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS,
  STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS,
  LAUNCH_START_CASE_ROWS,
  SESSION_ENDING_COMMAND_FORMS,
  sessionEndingCommandsIn,
} from './test-helpers/conflict-cases.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, sentinelInMessage, withoutName } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  adConfigMalformedRaiseLines,
  DISPATCHER_BUG_WORDING,
  dispatcherBugWordingIn,
  driveToB,
  expectPendingOnlyWatch,
  killFailureLines,
  killFailureNotice,
  killFailurePostedLine,
  launchByAnotherProcess,
  launchOwnPending,
  makeRecoveryHarness,
  ordinaryAlertContent,
  personaOf,
  pendingOnlyStoppedLine,
  personaRow,
  reArmedLine,
  recordSequenceStarts,
  retryLinesOf,
  retryNow,
  scriptModelLaunch,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
} from './test-helpers/recovery-harness.ts'

const MINUTE_MS = 60_000

/** The whole sample with `suffix` in place of its `Z` (a fraction, a zone). */
function wholeWith(suffix: string): string {
  return SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, suffix)
}

/** The whole sample's instant, from its own ECMAScript date-time form. */
const WHOLE_INSTANT = Date.parse(SAMPLE_LAUNCH_START_WHOLE)

/** An RFC 3339 UTC date-time on `date` (`YYYY-MM-DD`) at `time`. */
function utcAt(date: string, time = '12:00:00'): string {
  return `${date}T${time}Z`
}

// ---------------------------------------------------------------------------
// parseLaunchStart — valid forms (SRJ-406: with or without the fraction)
// ---------------------------------------------------------------------------

describe('parseLaunchStart: a valid launch start gives its instant', () => {
  test.each([
    ['fractional', SAMPLE_LAUNCH_START_FRACTIONAL],
    ['whole', SAMPLE_LAUNCH_START_WHOLE],
  ])('the stub\'s %s sample', (_form, sample) => {
    expect(parseLaunchStart(sample)).toBe(Date.parse(sample))
  })

  test('the fractional sample is its fraction\'s milliseconds after the same second', () => {
    const fraction = /\.(\d{3})Z$/.exec(SAMPLE_LAUNCH_START_FRACTIONAL)?.[1]
    const sameSecond = SAMPLE_LAUNCH_START_FRACTIONAL.replace(/\.\d+Z$/, 'Z')
    expect(fraction).toBeDefined()
    expect(parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL)).toBe(Date.parse(sameSecond) + Number(fraction))
  })

  test.each([
    ['+05:30', -(5 * 60 + 30)],
    ['-08:00', 8 * 60],
    ['+00:00', 0],
  ])('a numeric offset %s gives the same instant as UTC shifted by it', (offset, shiftMinutes) => {
    expect(parseLaunchStart(wholeWith(offset))).toBe(WHOLE_INSTANT + shiftMinutes * MINUTE_MS)
  })

  test('a fraction with a numeric offset', () => {
    expect(parseLaunchStart(wholeWith('.250-08:00'))).toBe(WHOLE_INSTANT + 250 + 8 * 60 * MINUTE_MS)
  })

  test.each([
    ['1 digit', '5', 500],
    ['2 digits', '12', 120],
    ['3 zero digits', '000', 0],
    ['6 digits (first 3 kept)', '123456', 123],
    ['9 digits (dropped, not rounded)', '987654321', 987],
  ])('a fraction of %s', (_label, fraction, ms) => {
    expect(parseLaunchStart(wholeWith(`.${fraction}Z`))).toBe(WHOLE_INSTANT + ms)
  })

  test('lower-case `t` and `z` read as `T` and `Z`', () => {
    expect(parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL.replace('T', 't').replace('Z', 'z'))).toBe(
      Date.parse(SAMPLE_LAUNCH_START_FRACTIONAL),
    )
  })

  test.each([
    ['Feb 29 in a leap year', 2024, 2, 29],
    ['Feb 29 in a century leap year', 2000, 2, 29],
    ['the last day of a 31-day month', 2026, 12, 31],
  ])('%s', (_label, year, month, day) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    expect(parseLaunchStart(utcAt(date))).toBe(Date.UTC(year, month - 1, day, 12, 0, 0))
  })

  test('a `:60` leap second is accepted, as the next minute\'s start', () => {
    expect(parseLaunchStart(utcAt('2016-12-31', '23:59:60'))).toBe(Date.UTC(2017, 0, 1, 0, 0, 0))
  })

  test('a year below 100 is that year, not 19xx', () => {
    const raw = utcAt('0050-01-01', '00:00:00')
    expect(parseLaunchStart(raw)).toBe(Date.parse(raw))
    expect(new Date(parseLaunchStart(raw) as number).getUTCFullYear()).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// parseLaunchStart — no launch start (SRJ-408: absent or unparseable = none)
// ---------------------------------------------------------------------------

describe('parseLaunchStart: an absent or unparseable launch start gives none', () => {
  test.each([
    ['absent (undefined)', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number (the sample\'s epoch ms)', Date.parse(SAMPLE_LAUNCH_START_WHOLE)],
    ['a Date', new Date(SAMPLE_LAUNCH_START_WHOLE)],
    ['an object', { launch_started_at: SAMPLE_LAUNCH_START_WHOLE }],
    ['a boolean', true],
  ])('%s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })

  test.each([
    ['no time part', SAMPLE_LAUNCH_START_WHOLE.slice(0, 10)],
    ['no zone', SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, '')],
    ['no zone, with a fraction', SAMPLE_LAUNCH_START_FRACTIONAL.replace(/Z$/, '')],
    ['not a date', 'not a date'],
    ['no seconds', SAMPLE_LAUNCH_START_WHOLE.replace(/:00Z$/, 'Z')],
    ['an empty fraction', wholeWith('.Z')],
    ['an offset without a colon', wholeWith('+0530')],
    ['surrounding whitespace', ` ${SAMPLE_LAUNCH_START_WHOLE} `],
    ['trailing text', `${SAMPLE_LAUNCH_START_WHOLE}x`],
  ])('a malformed string: %s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })

  test.each([
    ['Feb 30', utcAt('2024-02-30')],
    ['Feb 29 in a non-leap year', utcAt('2026-02-29')],
    ['Feb 29 in a non-leap century year', utcAt('1900-02-29')],
    ['Apr 31', utcAt('2026-04-31')],
    ['month 00', utcAt('2026-00-10')],
    ['month 13', utcAt('2026-13-10')],
    ['day 00', utcAt('2026-05-00')],
    ['hour 24', utcAt('2026-05-24', '24:00:00')],
    ['minute 60', utcAt('2026-05-24', '12:60:00')],
    ['second 61', utcAt('2026-05-24', '12:00:61')],
    ['offset hour 24', wholeWith('+24:00')],
    ['offset minute 60', wholeWith('+05:60')],
  ])('a field out of range: %s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isPendingWithNoLaunchStart (SRJ-408, SRJ-513)
// ---------------------------------------------------------------------------

/** A `status` result, `get` row and `list` row with the given fields. */
const ROW_FORMS: ReadonlyArray<[string, (fields: PendingRowFields) => PendingRowFields]> = [
  ['status result', (fields) => cannedStatusResult(fields)],
  ['get row', (fields) => cannedGetResult({ claude_instance_id: 'cscb_alpha', ...fields })],
  ['list row', (fields) => cannedListRow({ claude_instance_id: 'cscb_alpha', ...fields })],
]

/** Launch starts that are none: absent, `null`, empty and unparseable. */
const NO_LAUNCH_STARTS: ReadonlyArray<[string, string | null | undefined]> = [
  ['absent', SAMPLE_LAUNCH_STARTS.none],
  ['null', null],
  ['empty', ''],
  ['no zone', SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, '')],
  ['Feb 30', utcAt('2024-02-30')],
]

/** Valid launch starts: the stub's two sample forms. */
const VALID_LAUNCH_STARTS: ReadonlyArray<[string, string]> = [
  ['fractional', SAMPLE_LAUNCH_START_FRACTIONAL],
  ['whole', SAMPLE_LAUNCH_START_WHOLE],
]

const OTHER_STATES = ['waiting', 'working', 'ask_user', 'check_permission', 'ended', 'missing']

describe('isPendingWithNoLaunchStart', () => {
  test.each(ROW_FORMS.flatMap(([form, build]) => NO_LAUNCH_STARTS.map(([label, start]) => [form, label, build, start] as const)))(
    'a pending %s whose launch start is %s satisfies it',
    (_form, _label, build, start) => {
      expect(isPendingWithNoLaunchStart(build({ state: 'pending', launch_started_at: start }))).toBe(true)
    },
  )

  test.each(ROW_FORMS.flatMap(([form, build]) => VALID_LAUNCH_STARTS.map(([label, start]) => [form, label, build, start] as const)))(
    'a pending %s with the %s launch start does not',
    (_form, _label, build, start) => {
      expect(isPendingWithNoLaunchStart(build({ state: 'pending', launch_started_at: start }))).toBe(false)
    },
  )

  test.each(
    OTHER_STATES.flatMap((state) =>
      [...NO_LAUNCH_STARTS, ...VALID_LAUNCH_STARTS].map(([label, start]) => [state, label, start] as const),
    ),
  )('a %s row whose launch start is %s does not', (state, _label, start) => {
    expect(isPendingWithNoLaunchStart(cannedStatusResult({ state, launch_started_at: start }))).toBe(false)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('no row (%s) does not', (_label, row) => {
    expect(isPendingWithNoLaunchStart(row)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseLaunchStart over the stub's rows (SRJ-406, SRJ-1303)
// ---------------------------------------------------------------------------

/**
 * Launch starts as a row carries them, with the instant each names: the
 * stub's sample forms (SRJ-1303: with fractional seconds, without, none), a
 * numeric offset and a fraction longer than milliseconds.
 */
const ROW_LAUNCH_STARTS: ReadonlyArray<readonly [string, string | undefined, number | undefined]> = [
  ['fractional', SAMPLE_LAUNCH_STARTS.fractional, Date.parse(SAMPLE_LAUNCH_START_FRACTIONAL)],
  ['whole', SAMPLE_LAUNCH_STARTS.whole, WHOLE_INSTANT],
  ['none', SAMPLE_LAUNCH_STARTS.none, undefined],
  ['numeric-offset', wholeWith('-08:00'), WHOLE_INSTANT + 8 * 60 * MINUTE_MS],
  ['9-digit-fraction', wholeWith('.123456789Z'), WHOLE_INSTANT + 123],
]

describe('parseLaunchStart: a launch start reads the same from a status result, a get row and a list row', () => {
  test.each(
    ROW_FORMS.flatMap(([form, build]) => ROW_LAUNCH_STARTS.map(([label, raw, instant]) => [form, label, build, raw, instant] as const)),
  )('a pending %s with the %s launch start', (_form, _label, build, raw, instant) => {
    expect(parseLaunchStart(build({ state: 'pending', launch_started_at: raw }).launch_started_at)).toBe(instant)
  })
})

// ---------------------------------------------------------------------------
// A `pending` row's ageing (SRJ-406, SRJ-408; AC 30, AC 80)
// ---------------------------------------------------------------------------

/** The clock of the case, if it made one; `afterEach` asserts it has no timer left. */
let caseClock: FakeClock | undefined
/** The temp HOME the case's agent-director settings are written under, once it installs the reader. */
let settingsHome: string | undefined
/** The settings reader's log lines. */
let settingsLines: string[] = []
/** The directory the own-row leg's persona rows are built against (nothing is written there). */
let rowsHome: string | undefined

afterEach(() => {
  const pendingTimers = caseClock?.pending() ?? []
  const lines = settingsLines
  caseClock = undefined
  settingsLines = []
  try {
    expect(pendingTimers).toEqual([])
    expect(settingsLinesOtherThanValues(lines, settingsHome)).toEqual([])
    assertNoLeak(lines)
  } finally {
    resetAdSettingsForTests()
    for (const dir of [settingsHome, rowsHome]) if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    settingsHome = undefined
    rowsHome = undefined
  }
})

/** A fake clock starting at `startMs`, checked in `afterEach`. */
function clockAt(startMs: number): FakeClock {
  caseClock = createFakeClock({ start: startMs })
  return caseClock
}

/**
 * Install the settings reader over a temp HOME, with agent-director's
 * settings file written there first when `tables` is given. `afterEach`
 * resets the reader and removes the HOME.
 */
function installSettings(tables?: AdConfigTables): AdSettingsReader {
  settingsHome ??= mkdtempSync(join(tmpdir(), 'cscb-pending-row-home-'))
  const home = settingsHome
  if (tables !== undefined) writeAgentDirectorConfig(home, tables)
  return installAdSettings({
    home: () => home,
    log: (line) => {
      settingsLines.push(line)
    },
  })
}

/** Milliseconds per second, to write a G from a wait in milliseconds. */
const MS_PER_SECOND = 1000

/** Twice agent-director's default G. */
const G_DOUBLED: AdConfigTables = { tmux: { pending_grace_seconds: DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n } }

/**
 * A resumed launch's `pending` `get` row: launch start `raw`, and a
 * `started_at` at `startedAtMs`, the original spawn's time, which no wait
 * may read (SRJ-406).
 */
function resumedRow(raw: string, startedAtMs: number): ReturnType<typeof cannedGetResult> {
  return cannedGetResult({
    claude_instance_id: 'cscb_alpha',
    state: 'pending',
    launch_started_at: raw,
    started_at: new Date(startedAtMs).toISOString(),
  })
}

/** Both forms of G a check or an arm takes: the E6 accessor itself, and its value read as a number. */
const GRACE_WAITS: ReadonlyArray<readonly [string, () => number | (() => number)]> = [
  ['the G accessor', () => adGraceMsInEffect],
  ['G as a number', () => adGraceMsInEffect()],
]

/** Launch starts that are none: {@link NO_LAUNCH_STARTS} and a value that is not a string. */
const NONE_LAUNCH_STARTS: ReadonlyArray<readonly [string, unknown]> = [
  ...NO_LAUNCH_STARTS,
  ['a number (the sample\'s epoch ms)', WHOLE_INSTANT],
]

describe('isPendingRowAged: measured from the launch start, never from started_at', () => {
  test.each(VALID_LAUNCH_STARTS.flatMap(([form, raw]) => GRACE_WAITS.map(([wait, waitOf]) => [form, wait, raw, waitOf] as const)))(
    '%s launch start, %s, on a resumed row whose started_at is older than G: not aged one tick before launch start + G, aged at it',
    (_form, _wait, raw, waitOf) => {
      const graceMs = adGraceMsInEffect()
      const launchStartMs = parseLaunchStart(raw)!
      const row = resumedRow(raw, launchStartMs - 2 * graceMs)
      const oneTickBefore = launchStartMs + graceMs - 1
      // Measured from started_at, the row would already be aged.
      expect(Date.parse(row.started_at!) + graceMs).toBeLessThan(oneTickBefore)

      expect(isPendingRowAged(row.launch_started_at, waitOf(), oneTickBefore)).toBe(false)
      expect(isPendingRowAged(row.launch_started_at, waitOf(), launchStartMs + graceMs)).toBe(true)
    },
  )

  test.each([-1, 0])('a fractional and a whole launch start naming the same instant age identically (G %p ms from it)', (offsetMs) => {
    const fractional = wholeWith('.000Z')
    expect(parseLaunchStart(fractional)).toBe(parseLaunchStart(SAMPLE_LAUNCH_START_WHOLE))
    const nowMs = WHOLE_INSTANT + adGraceMsInEffect() + offsetMs
    expect(isPendingRowAged(fractional, adGraceMsInEffect, nowMs)).toBe(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, nowMs))
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, nowMs)).toBe(offsetMs === 0)
  })

  test.each(NONE_LAUNCH_STARTS.flatMap(([label, raw]) => [0, adGraceMsInEffect()].map((waitMs) => [label, waitMs, raw] as const)))(
    'a launch start %s is never aged, even with a wait of %p ms',
    (_label, waitMs, raw) => {
      expect(isPendingRowAged(raw, waitMs, Number.MAX_SAFE_INTEGER)).toBe(false)
    },
  )

  test.each([
    ['AD_WAIT_NEVER_ENDS', AD_WAIT_NEVER_ENDS],
    ['an accessor at AD_WAIT_NEVER_ENDS', () => AD_WAIT_NEVER_ENDS],
    ['NaN', Number.NaN],
    ['an accessor answering NaN', () => Number.NaN],
    [
      'an accessor that throws',
      () => {
        throw new Error('unreadable wait')
      },
    ],
  ])('a wait of %s is never aged and throws nothing', (_label, waitMs) => {
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, waitMs, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test('the accessor is read at the call: a G raised after one check moves the next one', () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + oldGraceMs)).toBe(true)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + oldGraceMs)).toBe(false)
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + newGraceMs - 1)).toBe(false)
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + newGraceMs)).toBe(true)
  })
})

describe('armPendingRowWait: never early, from the launch start, on createFakeClock', () => {
  /** Arm on `clock` with `waitMs`, recording each callback's time in the answer's `fired`. */
  function arm(clock: FakeClock, raw: unknown, waitMs: number | (() => number)) {
    const fired: number[] = []
    const armed = armPendingRowWait(clock, raw, waitMs, () => {
      fired.push(clock.now())
    })
    return { armed, fired }
  }

  /** The handle of an armed wait; fails the case for `PENDING_ROW_WAIT_NOT_ARMED`. */
  function handleOf(armed: ReturnType<typeof armPendingRowWait>): PendingRowWaitArmed {
    if (armed === PENDING_ROW_WAIT_NOT_ARMED) throw new Error('the wait was not armed')
    return armed
  }

  test.each(VALID_LAUNCH_STARTS)(
    '%s launch start, on a resumed row whose started_at is older than G, armed at the launch start with the G accessor: fires once at launch start + G, not one tick earlier',
    async (_form, raw) => {
      const graceMs = adGraceMsInEffect()
      const launchStartMs = parseLaunchStart(raw)!
      const row = resumedRow(raw, launchStartMs - 2 * graceMs)
      const clock = clockAt(launchStartMs)
      const { armed, fired } = arm(clock, row.launch_started_at, adGraceMsInEffect)
      expect(handleOf(armed).launchStartMs).toBe(launchStartMs)

      await clock.advanceTo(launchStartMs + graceMs - 1)
      expect(fired).toEqual([])
      await clock.advance(1)
      expect(fired).toEqual([launchStartMs + graceMs])
      expect(clock.pendingCount()).toBe(0)
    },
  )

  test.each(NONE_LAUNCH_STARTS)('a launch start %s: answers "not armed", arms no timer, throws nothing and never fires', async (_label, raw) => {
    const graceMs = adGraceMsInEffect()
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, raw, adGraceMsInEffect)

    expect(armed).toBe(PENDING_ROW_WAIT_NOT_ARMED)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * graceMs)
    expect(fired).toEqual([])
  })

  test('G raised while armed: no fire at the old deadline, once at the new one', async () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    const launchStartMs = parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL)!
    const clock = clockAt(launchStartMs)
    const { fired } = arm(clock, SAMPLE_LAUNCH_START_FRACTIONAL, adGraceMsInEffect)
    await clock.advanceTo(launchStartMs + oldGraceMs - 1)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    await clock.advanceTo(launchStartMs + newGraceMs - 1)
    expect(fired).toEqual([])
    await clock.advance(1)
    expect(fired).toEqual([launchStartMs + newGraceMs])
  })

  test('a G beyond the timer maximum at the pending wait\'s arm (E6; the rule\'s harness has its own case at a retry): no fire after 1 ms, one timer at a time none asking more than the maximum, and one fire exactly at launch start + G', async () => {
    installSettings({ tmux: { pending_grace_seconds: BigInt(Math.ceil(MAX_TIMER_DELAY_MS / MS_PER_SECOND)) } })
    const graceMs = adGraceMsInEffect()
    expect(graceMs).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    const launchStartMs = parseLaunchStart(SAMPLE_LAUNCH_START_WHOLE)!
    const clock = clockAt(launchStartMs)
    const { fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)

    await clock.advance(1)
    expect(fired).toEqual([])
    for (let step = 0; fired.length === 0; step++) {
      expect(step).toBeLessThan(5)
      expect(clock.pendingCount()).toBe(1)
      expect(clock.pending()[0]!.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
      await clock.runNext()
    }
    expect(fired).toEqual([launchStartMs + graceMs])
  })

  test('a fixed wait of AD_WAIT_NEVER_ENDS arms no timer and never fires', async () => {
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, AD_WAIT_NEVER_ENDS)

    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * MAX_TIMER_DELAY_MS)
    expect(fired).toEqual([])
    handleOf(armed).cancel()
  })

  test('the G accessor at AD_WAIT_NEVER_ENDS keeps one timer of the maximum pending and never fires; cancel leaves none', async () => {
    installSettings({ tmux: { pending_grace_seconds: AD_SETTING_INTEGER_MAX } })
    expect(adGraceMsInEffect()).toBe(AD_WAIT_NEVER_ENDS)
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)

    for (let step = 0; step < 3; step++) {
      expect(clock.pending().map((timer) => timer.delayMs)).toEqual([MAX_TIMER_DELAY_MS])
      await clock.runNext()
    }
    expect(fired).toEqual([])
    handleOf(armed).cancel()
    expect(clock.pendingCount()).toBe(0)
  })

  test('cancel before the deadline: no timer is left and it never fires; a second cancel does nothing', async () => {
    const graceMs = adGraceMsInEffect()
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)
    await clock.advanceTo(WHOLE_INSTANT + graceMs - 1)

    const { cancel } = handleOf(armed)
    cancel()
    expect(clock.pendingCount()).toBe(0)
    cancel()
    await clock.advance(graceMs)
    expect(fired).toEqual([])
  })

  test('a NaN wait with a launch start throws RangeError and arms nothing', () => {
    const clock = clockAt(WHOLE_INSTANT)
    expect(() => arm(clock, SAMPLE_LAUNCH_START_WHOLE, Number.NaN)).toThrow(RangeError)
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SRJ-408's own-row leg: a configured persona's own row with no launch start
// ---------------------------------------------------------------------------

describe('a configured persona\'s own pending row with no launch start latches through E16\'s decision and is never aged or armed (SRJ-408, SRJ-513)', () => {
  /** P's own rows: its current life (the covered shape) and a row whose cwd is not P's, each read shape and form. */
  const OWN_ROWS = LAUNCH_START_CASE_ROWS.filter((row) => row.variant === 'current life' || row.variant === 'other cwd').map(
    (row) => [row.name, row] as const,
  )

  /** Persona P, its directories under the case's rows home (not created). */
  function personaP(): { persona: CannedRowPersona; home: string } {
    rowsHome ??= mkdtempSync(join(tmpdir(), 'cscb-pending-row-rows-'))
    const home = rowsHome
    return { persona: { key: 'alpha', working_directory: join(home, 'alpha', 'work'), claude_config_dir: join(home, 'alpha', 'claude') }, home }
  }

  test.each(OWN_ROWS)('%s', async (_name, row) => {
    const { persona, home } = personaP()
    expect(decideOwnRowRead(row.decisionInput(persona, home))).toEqual(ROW_READ_LAUNCH_START_NOT_RECORDED)

    const raw = row.build(persona, home).launch_started_at
    expect(isPendingRowAged(raw, 0, Number.MAX_SAFE_INTEGER)).toBe(false)
    const clock = clockAt(WHOLE_INSTANT)
    let fired = 0
    expect(armPendingRowWait(clock, raw, adGraceMsInEffect, () => fired++)).toBe(PENDING_ROW_WAIT_NOT_ARMED)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * adGraceMsInEffect())
    expect(fired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408, SRJ-513)
// ---------------------------------------------------------------------------

/** A row comparison that matches P: `cwd` and `config_dir` label both P's, both directories resolved. */
const MATCHING: PendingRowComparison = { cwdMatches: true, cwdCheckDeferred: false, configDirResolved: true, configDirMatches: true }
/** The comparison of a row whose `cwd` resolves elsewhere. */
const CWD_ELSEWHERE: Partial<PendingRowComparison> = { cwdMatches: false }
/** The comparison when neither P's working directory nor the row's `cwd` resolves now (b.av2 SR-6.4). */
const CWD_UNRESOLVED: Partial<PendingRowComparison> = { cwdMatches: false, cwdCheckDeferred: true }
/** The comparison when P's `claude_config_dir` does not resolve (b.g57): no label verdict. */
const CONFIG_DIR_UNRESOLVED: Partial<PendingRowComparison> = { configDirResolved: false, configDirMatches: undefined }
/** The comparison of a row whose `config_dir` label is missing or differs. */
const CONFIG_DIR_ELSEWHERE: Partial<PendingRowComparison> = { configDirMatches: false }

/** The retired-key store's readings of a key. */
const NOT_RECORDED = { recorded: false, marked: false } as const
const RECORDED_UNMARKED = { recorded: true, marked: false } as const
const RECORDED_MARKED = { recorded: true, marked: true } as const

/**
 * The cover input for a `pending` `get` row with `launch` (the stub's
 * default sample unless given; `undefined` leaves it out), a configured
 * persona's own unless `ownConfigured` is false, the key not recorded and the
 * row matching P unless `retired` or `comparison` says otherwise; the site
 * flag `statusOnlySite` is left out unless given.
 */
function coverInput(
  options: {
    launch?: string | null | undefined
    ownConfigured?: boolean
    retired?: PendingRowCoverInput['retired']
    comparison?: Partial<PendingRowComparison>
    statusOnlySite?: boolean
  } = {},
): PendingRowCoverInput {
  const launch = 'launch' in options ? options.launch : SAMPLE_LAUNCH_START_WHOLE
  const [, getRow] = ROW_FORMS.find(([form]) => form === 'get row')!
  return {
    row: getRow({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: launch }),
    ownConfigured: options.ownConfigured ?? true,
    retired: options.retired ?? NOT_RECORDED,
    comparison: { ...MATCHING, ...options.comparison },
    ...(options.statusOnlySite === undefined ? {} : { statusOnlySite: options.statusOnlySite }),
  }
}

const COVERED: PendingRowCover = { answer: PENDING_ROW_COVERED }
const NO_LAUNCH_START: PendingRowCover = { answer: PENDING_ROW_NO_LAUNCH_START }
const notCovered = (reason: PendingRowNotCoveredReason): PendingRowCover => ({ answer: PENDING_ROW_NOT_COVERED, reason })
const undecided = (reason: PendingRowUndecidedReason): PendingRowCover => ({ answer: PENDING_ROW_UNDECIDED, reason })

/** `coverInput`'s options, without the site flag the tables set themselves. */
type CoverOptions = Omit<NonNullable<Parameters<typeof coverInput>[0]>, 'statusOnlySite'>

/** The site flag as each kind of site passes it: the collision ladder (absent or false) and a status-only site (true). */
const SITES: ReadonlyArray<readonly [string, boolean | undefined]> = [
  ['the ladder (no site flag)', undefined],
  ['the ladder (site flag false)', false],
  ['a status-only site', true],
]

describe('decidePendingRowCover: whether a pending row is P\'s current life (SRJ-409, SRJ-411), never for an own row with no launch start (SRJ-408, SRJ-513)', () => {
  // None of these inputs pairs a cwd that resolves elsewhere with a directory
  // that does not resolve, so every site answers the same (the site's order
  // is the table below).
  const COVER_CASES: ReadonlyArray<readonly [string, CoverOptions, PendingRowCover]> = [
    ['P\'s own current life, cwd and config_dir matching (whole launch start)', {}, COVERED],
    ['P\'s own current life, its launch start with fractional seconds', { launch: SAMPLE_LAUNCH_START_FRACTIONAL }, COVERED],
    ['a recorded key with no mark: its old life', { retired: RECORDED_UNMARKED }, notCovered(PENDING_ROW_REASON_RETIRED_OLD_LIFE)],
    ['a recorded key after its mark (written, or held in memory after a failed write)', { retired: RECORDED_MARKED }, COVERED],
    ['a cwd that resolves elsewhere', { comparison: CWD_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['a config_dir label missing or different', { comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CONFIG_DIR_MISMATCH)],
    ['a working directory and row cwd that do not resolve now', { comparison: CWD_UNRESOLVED }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['a claude_config_dir that does not resolve now', { comparison: CONFIG_DIR_UNRESOLVED }, undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)],
    // The order: the directories first, then the retired key, then the label.
    ['a cwd elsewhere on a recorded key with no mark: the cwd decides', { retired: RECORDED_UNMARKED, comparison: CWD_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['an unresolved cwd on a recorded key with no mark: undecided', { retired: RECORDED_UNMARKED, comparison: CWD_UNRESOLVED }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['an unresolved claude_config_dir on a recorded key with no mark: undecided', { retired: RECORDED_UNMARKED, comparison: CONFIG_DIR_UNRESOLVED }, undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)],
    ['a config_dir label elsewhere on a recorded key with no mark: the old life decides', { retired: RECORDED_UNMARKED, comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_RETIRED_OLD_LIFE)],
    ['a config_dir label elsewhere on a marked key', { retired: RECORDED_MARKED, comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CONFIG_DIR_MISMATCH)],
    ['a cwd and a config_dir label both elsewhere: the cwd decides', { comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_ELSEWHERE } }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    // Not a configured persona's own row: it latches nothing, so its fields decide.
    ['a row with no launch start that is no configured persona\'s own, matching', { launch: SAMPLE_LAUNCH_STARTS.none, ownConfigured: false }, COVERED],
  ]
  test.each(COVER_CASES.flatMap(([label, options, expected]) => SITES.map(([site, flag]) => [label, site, options, flag, expected] as const)))(
    '%s, at %s',
    (_label, _site, options, statusOnlySite, expected) => {
      expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite }))).toEqual(expected)
    },
  )

  // SRJ-409 (ruling R8): at a status-only site a directory that cannot be
  // resolved leaves the row undecided before any mismatch is checked; the
  // ladder keeps its order, a cwd that resolves elsewhere first.
  const CONFIG_DIR_UNDECIDED = undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)
  test.each<[string, CoverOptions, PendingRowCover, PendingRowCover]>([
    // [label, options, the ladder's answer, a status-only site's answer]
    ['a cwd elsewhere, P\'s claude_config_dir unresolvable', { comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH), CONFIG_DIR_UNDECIDED],
    [
      'a cwd elsewhere, P\'s claude_config_dir unresolvable, on a recorded key with no mark',
      { retired: RECORDED_UNMARKED, comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } },
      notCovered(PENDING_ROW_REASON_CWD_MISMATCH),
      CONFIG_DIR_UNDECIDED,
    ],
    // Both directories unresolved: the cwd is decided first at every site.
    ['an unresolved cwd and claude_config_dir', { comparison: { ...CWD_UNRESOLVED, ...CONFIG_DIR_UNRESOLVED } }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    // The own row with no launch start still answers first.
    ['P\'s own row with no launch start, a cwd elsewhere, P\'s claude_config_dir unresolvable', { launch: SAMPLE_LAUNCH_STARTS.none, comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } }, NO_LAUNCH_START, NO_LAUNCH_START],
  ])('the site\'s order: %s → the ladder\'s answer at the ladder, the status-only answer at a status-only site', (_label, options, ladder, statusOnly) => {
    expect(decidePendingRowCover(coverInput(options))).toEqual(ladder)
    expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite: false }))).toEqual(ladder)
    expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite: true }))).toEqual(statusOnly)
  })

  // SRJ-408, SRJ-513 (the E16 hatch note): every shape, covered or not, answers "no launch start".
  const NO_LAUNCH_START_SHAPES: ReadonlyArray<readonly [string, Parameters<typeof coverInput>[0]]> = [
    ['P\'s current life (the covered shape)', {}],
    ['a recorded key after its mark', { retired: RECORDED_MARKED }],
    ['a recorded key with no mark', { retired: RECORDED_UNMARKED }],
    ['a cwd elsewhere', { comparison: CWD_ELSEWHERE }],
    ['a config_dir label elsewhere', { comparison: CONFIG_DIR_ELSEWHERE }],
    ['an unresolved cwd', { comparison: CWD_UNRESOLVED }],
    ['an unresolved claude_config_dir', { comparison: CONFIG_DIR_UNRESOLVED }],
  ]
  test.each(NO_LAUNCH_START_SHAPES.flatMap(([shape, options]) => NO_LAUNCH_STARTS.map(([form, launch]) => [shape, form, options, launch] as const)))(
    'a configured persona\'s own row with no launch start, %s, its launch start %s: no launch start, never covered',
    (_shape, _form, options, launch) => {
      expect(decidePendingRowCover(coverInput({ ...options, launch }))).toEqual(NO_LAUNCH_START)
    },
  )
})

// ---------------------------------------------------------------------------
// The status-only sites' comparison (b.jg5 SRJ-411, hatch A3; b.av2 SR-6.4)
// ---------------------------------------------------------------------------

/** A row comparison as `compareRowToPersona` answers it: both directories resolved and the row matching P, unless `overrides` says otherwise. */
function rowComparison(overrides: Partial<RowPersonaComparison> = {}): RowPersonaComparison {
  return {
    ...MATCHING,
    workingDirectoryResolved: true,
    configDirLabel: 'the label',
    expectedConfigDirLabel: 'the label',
    ...overrides,
  }
}

describe('pendingRowComparisonFor: a working directory with no real path leaves the cwd condition unresolved at a status-only site, whatever the row\'s cwd', () => {
  const UNRESOLVED_CWD = { cwdMatches: false, cwdCheckDeferred: true } as const

  test.each<[string, RowPersonaComparison, RowPersonaComparison, PendingRowCover]>([
    ['resolved, the row matching P: as is (covered)', rowComparison(), rowComparison(), COVERED],
    ['resolved, the row\'s cwd elsewhere: as is (a cwd mismatch)', rowComparison({ cwdMatches: false }), rowComparison({ cwdMatches: false }), notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['not resolved, the row\'s cwd lexically P\'s path', rowComparison({ workingDirectoryResolved: false, cwdMatches: true, cwdCheckDeferred: true }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['not resolved, the row\'s cwd an existing directory elsewhere', rowComparison({ workingDirectoryResolved: false, cwdMatches: false, cwdCheckDeferred: false }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['not resolved, the row\'s cwd with no real path either', rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
  ])('%s', (_label, comparison, expected, cover) => {
    const forSite = pendingRowComparisonFor(comparison)
    expect(forSite).toEqual(expected)
    expect(decidePendingRowCover({ ...coverInput(), comparison: forSite })).toEqual(cover)
  })
})

// ---------------------------------------------------------------------------
// The read-and-step entry (b.jg5 SRJ-409, SRJ-411, SRJ-513)
// ---------------------------------------------------------------------------

describe('readAndStepPendingRow: one get, then a covered or undecided row armed pending-only, an uncovered one sent to the live-row sequence (recovery harness; SRJ-409, SRJ-411)', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    _resetConfigDirFs()
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A harness over P and Q, its restart delay and health-check interval 0, P's `get` reading P's own `pending` row with `row`. */
  function pendingP(row: PersonaGetResultOverrides = {}): { h: RecoveryHarness; p: string; q: string } {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    h.script({ getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, ...row }) })
    return { h, p, q }
  }

  /** P's reference, as the step's lines name it. */
  const refOf = (h: RecoveryHarness, key: string): string => renderPersonaRef(personaOf(h, key).name, key)

  /** The retry controller's own armed lines for persona `key` in pending-only mode with the pending-row cause. */
  const pendingOnlyArmedLines = (h: RecoveryHarness, key: string): string[] =>
    h.lines.filter((line) => line.startsWith(`[slack] unavailable-retry: persona=${key} armed in pending-only mode (${UNAVAILABLE_RETRY_CAUSE_PENDING_ROW}) — `))

  /** One `get` of P's row and nothing else for it: no kill, launch, keystroke or pane read; no approver; no sequence. */
  function expectOneGetOnly(h: RecoveryHarness, key: string): void {
    const id = personaInstanceId(key)
    const { getCalls, killCalls, spawnCalls, resumeCalls, sendKeysCalls, readPaneCalls, statusCalls } = h.stub.calls
    expect(getCalls).toEqual([{ claude_instance_id: id }])
    expect([killCalls, spawnCalls, resumeCalls, sendKeysCalls, readPaneCalls, statusCalls]).toEqual([[], [], [], [], [], []])
    expect([h.approverRunning(key), h.sequenceRunning(key)]).toEqual([false, false])
  }

  test.each<[string, (h: RecoveryHarness, key: string) => void]>([
    ['the key not recorded', () => {}],
    ['the key recorded and marked', (h, key) => h.retireKey(key, { mark: true })],
    [
      'the key recorded, its mark held in memory after its write failed',
      (h, key) => {
        h.retireKey(key)
        h.failRetiredKeyWrites()
        h.retiredKeys.mark(key)
        expect(h.retiredKeyWrites.at(-1)?.ok).toBe(false)
        expect(h.retiredEntry(key).marked).toBe(true)
      },
    ],
  ])('P\'s own covered pending row, %s: covered and armed, carrying the row its get read (for the pending-row rule); the controller\'s armed line in pending-only mode with the pending-row cause; no kill, launch, approver or sequence', async (_label, arrange) => {
    const { h, p, q } = pendingP()
    arrange(h, p)

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({
      kind: PENDING_ROW_COVERED,
      armed: true,
      row: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_DEFAULT },
    })

    expectPendingOnlyWatch(h, p)
    expect(pendingOnlyArmedLines(h, p)).toHaveLength(1)
    expectOneGetOnly(h, p)
    expect(h.controller.isArmed(q)).toBe(false)
  })

  /** P's working directory removed, its `get` reading P's `pending` row with `cwd` (P's configured path, lexically equal, when undefined). */
  function workingDirectoryGone(h: RecoveryHarness, key: string, cwd?: string): void {
    rmSync(personaOf(h, key).working_directory, { recursive: true, force: true })
    h.script({ getResult: personaRow(h, key, { state: AGENT_DIRECTOR_PENDING_STATE, ...(cwd === undefined ? {} : { cwd }) }) })
  }

  // b.jg5 SRJ-411 (hatch A3), b.av2 SR-6.4: at the status-only sites a
  // working directory with no real path leaves the row undecided whatever its
  // `cwd` is: a lexically equal `cwd` is never taken as covered, and a `cwd`
  // that resolves elsewhere is not sent to the sequence.
  test.each<[string, PendingRowUndecidedReason, (h: RecoveryHarness, key: string) => void]>([
    [
      'its working directory gone, the row\'s cwd another directory that does not exist',
      PENDING_ROW_REASON_CWD_UNRESOLVED,
      (h, key) => workingDirectoryGone(h, key, join(h.home, 'gone-elsewhere')),
    ],
    ['its working directory gone, the row\'s cwd lexically its configured path', PENDING_ROW_REASON_CWD_UNRESOLVED, (h, key) => workingDirectoryGone(h, key)],
    ['its working directory gone, the row\'s cwd another existing directory', PENDING_ROW_REASON_CWD_UNRESOLVED, (h, key) => workingDirectoryGone(h, key, h.home)],
    [
      'its claude_config_dir unresolvable',
      PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED,
      () => _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } }),
    ],
  ])('P\'s pending row with %s: undecided and armed only, with its one line; no kill, launch, approver or sequence', async (_label, reason, arrange) => {
    const { h, p } = pendingP()
    arrange(h, p)
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_UNDECIDED, reason, armed: true })

    expectPendingOnlyWatch(h, p)
    expect(pendingOnlyArmedLines(h, p)).toHaveLength(1)
    expect(h.errors.filter((line) => line === undecidedPendingRowLine(refOf(h, p), reason, true))).toHaveLength(1)
    expect(starts).toEqual([])
    expectOneGetOnly(h, p)
  })

  /** Row labels without the `config_dir` label: a label missing is a mismatch (SRJ-1504). */
  const withoutConfigDir = (labels: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(labels ?? {}).filter(([name]) => `${name}=` !== CONFIG_DIR_LABEL_PREFIX))

  test.each<[string, PendingRowNotCoveredReason, (h: RecoveryHarness, key: string) => PersonaGetResultOverrides, boolean]>([
    [
      'the key recorded with no mark (its old life)',
      PENDING_ROW_REASON_RETIRED_OLD_LIFE,
      (h, key) => {
        h.retireKey(key)
        return {}
      },
      true,
    ],
    ['its cwd another existing directory', PENDING_ROW_REASON_CWD_MISMATCH, (h) => ({ cwd: h.home }), false],
    ['its config_dir label missing', PENDING_ROW_REASON_CONFIG_DIR_MISMATCH, (h, key) => ({ labels: withoutConfigDir(personaRow(h, key).labels) }), false],
  ])('P\'s pending row, %s: not covered; its one line and exactly one sequence start (step 1, the conversation not kept, context recovery); no pending-only arm, no approver, no kill or launch of its own', async (_label, reason, mismatch, retiredKey) => {
    const { h, p } = pendingP()
    h.script({ getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, ...mismatch(h, p) }) })
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_NOT_COVERED, reason, startAnswer: LIVE_ROW_START_STARTED })

    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      key: p,
      instanceId: personaInstanceId(p),
      lastReadState: AGENT_DIRECTOR_PENDING_STATE,
      entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
      keepsConversation: false,
      retiredKey,
      launches: true,
      alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
    } satisfies Partial<LiveRowSequenceRequest>)
    expect(h.errors.filter((line) => line === uncoveredPendingRowLine(refOf(h, p), reason))).toHaveLength(1)
    expect([h.triggers, h.controller.isArmed(p), pendingOnlyArmedLines(h, p)]).toEqual([[], false, []])
    expectOneGetOnly(h, p)
  })

  /** The launch starts a harness row can carry that are none: absent, empty, and unparseable. */
  const ROW_NO_LAUNCH_STARTS = NO_LAUNCH_STARTS.filter((entry): entry is [string, string | undefined] => entry[1] !== null)

  test.each(ROW_NO_LAUNCH_STARTS)('P\'s own pending row with no launch start (%s), covered in every other way: P latches; nothing armed, no sequence', async (_form, launch) => {
    const { h, p } = pendingP({ launch_started_at: launch })
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_STEP_LATCHED })

    expect(h.latch.isLatched(p)).toBe(true)
    expect([starts, h.triggers, h.controller.isArmed(p), pendingOnlyArmedLines(h, p)]).toEqual([[], [], false, []])
    expectOneGetOnly(h, p)
  })

  // b.jg5 SRJ-408, SRJ-513: the own-row read latches only a row carrying P's
  // own id; a pending row with no launch start under another id reaches the
  // pending-row step, whose no-launch-start answer logs its one line and
  // answers latched. Today nothing latches and nothing is armed or started.
  test.each(ROW_NO_LAUNCH_STARTS)('P\'s get answering a pending row with no launch start (%s) under another persona\'s id: the step\'s one no-launch-start line, the answer latched; no latch, nothing armed, no sequence', async (_form, launch) => {
    const { h, p, q } = pendingP({ launch_started_at: launch, claude_instance_id: personaInstanceId('other') })
    expect(personaInstanceId('other')).not.toBe(personaInstanceId(q))
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_STEP_LATCHED })

    expect(h.errors.filter((line) => line === noLaunchStartPendingRowLine(refOf(h, p)))).toHaveLength(1)
    expect([h.latch.isLatched(p), h.latch.isLatched(q)]).toEqual([false, false])
    expect(h.episodeNotices).toEqual([])
    expect([starts, h.triggers, h.controller.isArmed(p), pendingOnlyArmedLines(h, p)]).toEqual([[], [], false, []])
    expectOneGetOnly(h, p)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch post's texts, pinned (b.jg5 SRJ-1017): the one literal block
// ---------------------------------------------------------------------------

describe('the stuck-launch post\'s texts, pinned (b.jg5 SRJ-1017; AC 67)', () => {
  test('for key dev and the fractional sample: the relaunching text at the default settings (5 minutes) and with pending_grace_seconds 300 (6 minutes), and the held text with and without the attach line', () => {
    const key = 'dev'
    const relaunchingAtDefaults =
      ':hourglass_flowing_sand: *Launch stuck* — this persona\'s launch in session "slack_bot_dev" did not come up within 5 minutes. ' +
      'CSCB is ending that launch and relaunching it; a resumed persona keeps its conversation. Nothing is needed.'
    const relaunchingAtGrace300 =
      ':hourglass_flowing_sand: *Launch stuck* — this persona\'s launch in session "slack_bot_dev" did not come up within 6 minutes. ' +
      'CSCB is ending that launch and relaunching it; a resumed persona keeps its conversation. Nothing is needed.'
    const held = [
      ':hourglass_flowing_sand: *Session not starting* — this persona\'s session "slack_bot_dev" has not reported in since its launch at 2026-05-24T12:00:00.123Z, ' +
        'and may be held at a startup prompt CSCB cannot answer. CSCB keeps checking. A human\'s remedies:',
      '• look at the session and answer its startup prompt: `tmux attach -t =slack_bot_dev`;',
      '• end the launch: follow the "Operator actions" section of agent-director\'s README; CSCB\'s next `find-missing` run then marks the row missing, and this persona is brought up again;',
      '• see what holds the session: `agent-director list --tmux-session-name slack_bot_dev` (on the command line).',
      'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.',
    ].join('\n')
    const heldNoAttachLine = [
      ':hourglass_flowing_sand: *Session not starting* — this persona\'s session "slack_bot_dev" has not reported in since its launch at 2026-05-24T12:00:00.123Z, ' +
        'and the session holding its name was not started by CSCB\'s launch, ' +
        'and may be held at a startup prompt CSCB cannot answer. CSCB keeps checking. A human\'s remedies:',
      '• end the launch: follow the "Operator actions" section of agent-director\'s README; CSCB\'s next `find-missing` run then marks the row missing, and this persona is brought up again;',
      '• see what holds the session: `agent-director list --tmux-session-name slack_bot_dev` (on the command line).',
      'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.',
    ].join('\n')

    expect(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect())).toBe(relaunchingAtDefaults)
    expect(stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, false)).toBe(held)
    expect(stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, true)).toBe(heldNoAttachLine)

    installSettings({ tmux: { pending_grace_seconds: 300n } })
    expect(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect())).toBe(relaunchingAtGrace300)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch post's builders, through the exports (b.jg5 SRJ-1017)
// ---------------------------------------------------------------------------

/** Persona keys for the builder cases: two that prefix one another (b.1ix), and one with no digit. */
const PREFIX_KEY = 'dev'
const PREFIXED_KEY = 'dev_2'
const BUILDER_KEYS = [PREFIX_KEY, PREFIXED_KEY, 'ops_bot'] as const

/** Both forms of the held text: [name, whether a `send-keys` met `ErrSpawnNotInteractive`]. */
const HELD_FORMS: ReadonlyArray<readonly [string, boolean]> = [
  ['with the attach line', false],
  ['without the attach line', true],
]

/** One instant's launch start in other forms: its parsed instant, and a numeric offset naming the same instant. */
function sameInstantForms(raw: string): ReadonlyArray<readonly [string, unknown]> {
  const instant = parseLaunchStart(raw)!
  const offsetHours = 2
  const shifted = new Date(instant + offsetHours * 60 * MINUTE_MS).toISOString()
  return [
    ['its parsed instant (epoch ms)', instant],
    [`a +0${offsetHours}:00 offset`, shifted.replace(/Z$/, `+0${offsetHours}:00`)],
  ]
}

describe('stuckLaunchRelaunchingText: B in whole minutes, rounded down, and P\'s quoted session (b.jg5 SRJ-1017, SRJ-210)', () => {
  /** [settings, the agent-director settings written (none: the defaults), whether B is whole minutes there]. */
  const B_SETTINGS: ReadonlyArray<readonly [string, AdConfigTables | undefined, boolean]> = [
    ['the default settings', undefined, true],
    ['pending_grace_seconds 300', { tmux: { pending_grace_seconds: 300n } }, true],
    ['a G that leaves B short of a whole minute', { tmux: { pending_grace_seconds: 359n } }, false],
  ]

  test.each(B_SETTINGS)('at %s: B is wholeMinutes(adLaunchBoundMsInEffect()), the text\'s only number, rounded down', (_label, tables, wholeMinute) => {
    if (tables !== undefined) installSettings(tables)
    const boundMs = adLaunchBoundMsInEffect()
    const minutes = wholeMinutes(boundMs)
    expect(boundMs % MINUTE_MS === 0).toBe(wholeMinute)
    expect(minutes).toBe(Math.floor(boundMs / MINUTE_MS))

    const text = stuckLaunchRelaunchingText(PREFIX_KEY, boundMs)
    expect(text.startsWith(`${STUCK_LAUNCH_RELAUNCHING_HEAD} `)).toBe(true)
    expect(text.replace(quotedPersonaSessionName(PREFIX_KEY), '').match(/\d+/g)).toEqual([String(minutes)])
    // Rounded down: B's text is its whole minutes' text, never the next minute's.
    expect(text).toBe(stuckLaunchRelaunchingText(PREFIX_KEY, minutes * MINUTE_MS))
    expect(text).not.toBe(stuckLaunchRelaunchingText(PREFIX_KEY, (minutes + 1) * MINUTE_MS))
  })

})

describe('both texts name P\'s own session, quoted (b.jg5 SRJ-1017, SRJ-1001; b.1ix)', () => {
  test.each([
    [PREFIX_KEY, PREFIXED_KEY],
    [PREFIXED_KEY, PREFIX_KEY],
  ])('persona %s: its quoted session in every text, never %s\'s', (key, other) => {
    const texts = [
      stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
      ...HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, flagged)),
    ]
    for (const text of texts) {
      expect(text.split(quotedPersonaSessionName(key))).toHaveLength(2)
      expect(text).not.toContain(quotedPersonaSessionName(other))
    }
  })

  test.each([
    [PREFIX_KEY, PREFIXED_KEY],
    [PREFIXED_KEY, PREFIX_KEY],
  ])('persona %s: the attach line targets its exact session (=<name>) and the list line names its session once; each differs from %s\'s only in the name', (key, other) => {
    const attach = stuckLaunchAttachRemedyLine(key)
    const list = stuckLaunchListRemedyLine(key)
    expect(attach.split(tmuxExactSessionTarget(personaTmuxSessionName(key)))).toHaveLength(2)
    expect(list.split(personaTmuxSessionName(key))).toHaveLength(2)
    expect(list).not.toContain(tmuxExactSessionTarget(personaTmuxSessionName(key)))
    expect(attach.replace(personaTmuxSessionName(key), personaTmuxSessionName(other))).toBe(stuckLaunchAttachRemedyLine(other))
    expect(list.replace(personaTmuxSessionName(key), personaTmuxSessionName(other))).toBe(stuckLaunchListRemedyLine(other))
  })
})

describe('stuckLaunchHeldText: with and without the attach line (b.jg5 SRJ-1017)', () => {
  test.each(BUILDER_KEYS.flatMap((key) => VALID_LAUNCH_STARTS.map(([form, raw]) => [key, form, raw] as const)))(
    'persona %s, the %s launch start: unflagged, the head and all three remedies and the human-only line; flagged, the clause after the launch start and no attach line',
    (key, _form, raw) => {
      const rendered = describeLaunchStartForLog(raw)
      const [head, ...rest] = stuckLaunchHeldText(key, raw, false).split('\n')
      const [flaggedHead, ...flaggedRest] = stuckLaunchHeldText(key, raw, true).split('\n')

      expect(rest).toEqual([
        stuckLaunchAttachRemedyLine(key),
        STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE,
        stuckLaunchListRemedyLine(key),
        STUCK_LAUNCH_HUMAN_ONLY_LINE,
      ])
      expect(flaggedRest).toEqual([STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE, stuckLaunchListRemedyLine(key), STUCK_LAUNCH_HUMAN_ONLY_LINE])

      expect(head!.startsWith(`${STUCK_LAUNCH_HELD_HEAD} `)).toBe(true)
      expect(head).toContain(quotedPersonaSessionName(key))
      expect(head!.split(rendered)).toHaveLength(2)
      expect(head).not.toContain(STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE)
      // The flagged head is the unflagged one with the clause right after the launch start.
      expect(flaggedHead).toBe(head!.replace(rendered, `${rendered}${STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE}`))

      const target = tmuxExactSessionTarget(personaTmuxSessionName(key))
      expect(stuckLaunchHeldText(key, raw, false)).toContain(target)
      expect(stuckLaunchHeldText(key, raw, true)).not.toContain(target)
    },
  )
})

describe('the launch start in the held text: one renderer, ISO 8601 UTC ending in Z (b.jg5 SRJ-1017, hatch A3)', () => {
  /** An ISO 8601 UTC timestamp with milliseconds, ending in `Z`, as `Date.prototype.toISOString` writes one. */
  const ISO_UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  test.each(VALID_LAUNCH_STARTS)('the stub\'s %s sample renders as its instant in ISO 8601 UTC with Z, in the held text', (_form, raw) => {
    const rendered = describeLaunchStartForLog(raw)
    expect(rendered).toMatch(ISO_UTC_Z)
    expect(rendered).toBe(new Date(parseLaunchStart(raw)!).toISOString())
    for (const [, flagged] of HELD_FORMS) expect(stuckLaunchHeldText(PREFIX_KEY, raw, flagged)).toContain(rendered)
  })

  test.each(VALID_LAUNCH_STARTS.flatMap(([form, raw]) => sameInstantForms(raw).map(([other, value]) => [form, other, raw, value] as const)))(
    'the %s sample and %s naming the same instant give one held text, in both forms, and the raw offset text never reaches it',
    (_form, _other, raw, value) => {
      for (const [, flagged] of HELD_FORMS) {
        const text = stuckLaunchHeldText(PREFIX_KEY, value, flagged)
        expect(text).toBe(stuckLaunchHeldText(PREFIX_KEY, raw, flagged))
        if (typeof value === 'string') expect(text).not.toContain(value)
      }
    },
  )

  test('the whole sample\'s raw text does not reach the held text: its instant does, with milliseconds', () => {
    const text = stuckLaunchHeldText(PREFIX_KEY, SAMPLE_LAUNCH_START_WHOLE, false)
    expect(text).not.toContain(SAMPLE_LAUNCH_START_WHOLE)
    expect(text).toContain(new Date(WHOLE_INSTANT).toISOString())
  })
})

describe('neither stuck-launch text names a session-ending command (b.jg5 SRJ-1001, C22)', () => {
  /** Every text, in every form, for every key and launch start, at the default B and with `pending_grace_seconds` 300. */
  function everyStuckLaunchText(): string[] {
    const texts: string[] = []
    for (const key of BUILDER_KEYS) {
      texts.push(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()))
      for (const [, raw] of VALID_LAUNCH_STARTS) for (const [, flagged] of HELD_FORMS) texts.push(stuckLaunchHeldText(key, raw, flagged))
    }
    installSettings({ tmux: { pending_grace_seconds: 300n } })
    for (const key of BUILDER_KEYS) texts.push(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()))
    return texts
  }

  test('every text, in every form, for every key, launch start and B, matches none of SESSION_ENDING_COMMAND_FORMS', () => {
    const texts = everyStuckLaunchText()
    expect(SESSION_ENDING_COMMAND_FORMS.length).toBeGreaterThan(0)
    expect(texts.flatMap(sessionEndingCommandsIn)).toEqual([])
  })

  test('no line of any text names kill-pane, set-option, agent-director delete, clear-latch, has-session or a label option (CSCB_OWN_LINE_FORBIDDEN); a tmux target is always exact (=)', () => {
    const lines = everyStuckLaunchText().flatMap((text) => text.split('\n'))
    expect(CSCB_OWN_LINE_FORBIDDEN.length).toBeGreaterThan(0)
    expect(lines.flatMap(cscbOwnLineForbiddenIn)).toEqual([])
    // Every `-t` target any line names is an exact one (SRJ-1001: no tmux target without `=`).
    const targets = lines.flatMap((line) => [...line.matchAll(/-t\s+(\S+)/g)].map((match) => match[1]!))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(target.startsWith(tmuxExactSessionTarget(''))).toBe(true)
  })

  test('no text calls anything a "dispatcher bug" (b.jg5 SRJ-713)', () => {
    for (const text of everyStuckLaunchText()) expect(text).not.toMatch(DISPATCHER_BUG_WORDING)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch posters (b.jg5 SRJ-1017, SRJ-1016)
// ---------------------------------------------------------------------------

/** One stuck-launch text as a poster posts it: its mark, its held form, its poster and its text for a key. */
interface StuckLaunchTextCase {
  readonly name: string
  readonly mark: StuckLaunchTextMark
  readonly flagged: boolean
  readonly post: (deps: StuckLaunchPosterDeps, key: string) => StuckLaunchPostAnswer
  readonly text: (key: string) => string
}

/** The launch start the held posts carry: the stub's default sample. */
const POSTED_LAUNCH_START = SAMPLE_LAUNCH_START_FRACTIONAL

const RELAUNCHING: StuckLaunchTextCase = {
  name: 'the relaunching text',
  mark: STUCK_LAUNCH_MARK_RELAUNCHING,
  flagged: false,
  post: (deps, key) => postStuckLaunchRelaunching(deps, key, adLaunchBoundMsInEffect()),
  text: (key) => stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
}

/** The held text's poster in the form `flagged` picks. */
function heldCase(flagged: boolean): StuckLaunchTextCase {
  return {
    name: flagged ? 'the held text without the attach line' : 'the held text with the attach line',
    mark: STUCK_LAUNCH_MARK_HELD,
    flagged,
    post: (deps, key) => postStuckLaunchHeld(deps, key, POSTED_LAUNCH_START, flagged),
    text: (key) => stuckLaunchHeldText(key, POSTED_LAUNCH_START, flagged),
  }
}

const HELD = heldCase(false)
const HELD_NO_ATTACH = heldCase(true)
const TEXT_CASES: readonly StuckLaunchTextCase[] = [RELAUNCHING, HELD, HELD_NO_ATTACH]

/** The poster's line for `text` posted for `key` with `answer`. */
function posterLine(key: string, text: StuckLaunchTextCase, answer: StuckLaunchPostAnswer, muted = false): string {
  return stuckLaunchPostLine(key, text.mark, answer, { metNotInteractive: text.flagged, muted })
}

/** Two personas. */
const P = 'alpha'
const Q = 'beta'

/** A posters' rig: a real episodes instance on the case's fake clock, recording its sink and lines; the outage query and teardown state set by the case. */
interface PosterRig {
  readonly episodes: PersonaEpisodes
  readonly deps: StuckLaunchPosterDeps
  /** What the episodes' sink received (the persona notifier in production). */
  readonly posts: Array<{ readonly key: string; readonly text: string }>
  /** The posters' lines (their injected log). */
  readonly lines: string[]
  /** The episodes' own lines. */
  readonly episodeLines: string[]
  /** The keys whose `tmux-unavailable` outage the injected query answers raised. */
  readonly raised: Set<string>
  /** Each key's persona-teardown state (none unless set). */
  readonly teardown: Map<string, PersonaTeardownWindowState>
}

function posterRig(overrides: Partial<StuckLaunchPosterDeps> = {}): PosterRig {
  const clock = clockAt(WHOLE_INSTANT)
  const posts: Array<{ key: string; text: string }> = []
  const lines: string[] = []
  const episodeLines: string[] = []
  const raised = new Set<string>()
  const teardown = new Map<string, PersonaTeardownWindowState>()
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push({ key, text })
    },
    log: (line) => {
      episodeLines.push(line)
    },
    clock,
    teardownWindow: (key) => teardown.get(key) ?? 'none',
  })
  const deps: StuckLaunchPosterDeps = {
    episodes,
    tmuxUnavailableRaised: (key) => raised.has(key),
    log: (line) => {
      lines.push(line)
    },
    ...overrides,
  }
  return { episodes, deps, posts, lines, episodeLines, raised, teardown }
}

/** Whether `key`'s stuck-launch episode is open in `rig`. */
const isOpen = (rig: PosterRig, key: string): boolean => rig.episodes.isOpen(key, PERSONA_EPISODE_KIND_STUCK_LAUNCH)

/** A row state whose read ends the episode (a live state out of `pending`). */
const LIVE_OUT_OF_PENDING = [...AGENT_DIRECTOR_LIVE_STATES].find((state) => state !== AGENT_DIRECTOR_PENDING_STATE)!

describe('the stuck-launch posters: each text at most once per stuck-launch episode (b.jg5 SRJ-1017, SRJ-1016; AC 67)', () => {
  /** Each text against each text with the other mark, in both orders. */
  const ORDERED_PAIRS = TEXT_CASES.flatMap((first) =>
    TEXT_CASES.filter((second) => second.mark !== first.mark).map((second) => [first.name, second.name, first, second] as const),
  )

  test.each(ORDERED_PAIRS)('%s, then %s: each posts once, a second post of it posts nothing, and one episode holds both marks', (_first, _second, first, second) => {
    const rig = posterRig()

    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([
      { key: P, text: first.text(P) },
      { key: P, text: second.text(P) },
    ])
    expect(rig.lines).toEqual([
      posterLine(P, first, STUCK_LAUNCH_POSTED),
      posterLine(P, first, STUCK_LAUNCH_ALREADY_POSTED),
      posterLine(P, second, STUCK_LAUNCH_POSTED),
      posterLine(P, second, STUCK_LAUNCH_ALREADY_POSTED),
      posterLine(P, first, STUCK_LAUNCH_ALREADY_POSTED),
    ])
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)?.posted).toEqual([first.mark, second.mark])
    expect(rig.episodeLines).toEqual([])
    assertNoLeak({ posts: rig.posts, lines: rig.lines })
  })

  test.each([
    [HELD.name, HELD_NO_ATTACH.name, HELD, HELD_NO_ATTACH],
    [HELD_NO_ATTACH.name, HELD.name, HELD_NO_ATTACH, HELD],
  ])('%s, then %s: the held text\'s two forms share one mark, so the second posts nothing', (_first, _second, first, second) => {
    const rig = posterRig()

    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([{ key: P, text: first.text(P) }])
    expect(rig.lines).toEqual([posterLine(P, first, STUCK_LAUNCH_POSTED), posterLine(P, second, STUCK_LAUNCH_ALREADY_POSTED)])
  })

  test('after the episode ends (silently, with its one line), a new episode posts each text again', () => {
    const rig = posterRig()
    const reason = stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING)
    // No episode open yet: the end does nothing and logs nothing.
    expect(endStuckLaunchEpisode(rig.episodes, P, reason, rig.deps.log)).toBe(false)

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    const firstEpisode = rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)!.episode

    expect(endStuckLaunchEpisode(rig.episodes, P, reason, rig.deps.log)).toBe(true)
    expect(isOpen(rig, P)).toBe(false)
    expect(rig.posts).toHaveLength(2)

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(HELD_NO_ATTACH.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)!.episode).toBeGreaterThan(firstEpisode)

    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD_NO_ATTACH.text(P) },
    ])
    expect(rig.lines).toEqual([
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_POSTED),
      posterLine(P, HELD, STUCK_LAUNCH_POSTED),
      stuckLaunchEpisodeEndedLine(P, reason),
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_POSTED),
      posterLine(P, HELD_NO_ATTACH, STUCK_LAUNCH_POSTED),
    ])
  })

  test('two personas are independent: each posts its own texts once, and ending one\'s episode leaves the other\'s', () => {
    const rig = posterRig()
    for (const key of [P, Q]) for (const text of [RELAUNCHING, HELD]) expect(text.post(rig.deps, key)).toBe(STUCK_LAUNCH_POSTED)

    expect(endStuckLaunchEpisode(rig.episodes, P, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING), rig.deps.log)).toBe(true)
    expect([isOpen(rig, P), isOpen(rig, Q)]).toEqual([false, true])
    expect(RELAUNCHING.post(rig.deps, Q)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)

    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
      { key: Q, text: RELAUNCHING.text(Q) },
      { key: Q, text: HELD.text(Q) },
      { key: P, text: RELAUNCHING.text(P) },
    ])
  })
})

describe('the stuck-launch posters: nothing posted and no episode begun while tmux-unavailable is raised (b.jg5 SRJ-1017, SRJ-410 step 3)', () => {
  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s while P\'s outage is raised: suppressed, nothing posted, no episode begun; Q still posts', (_name, text) => {
    const rig = posterRig()
    rig.raised.add(P)

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)
    expect(text.post(rig.deps, Q)).toBe(STUCK_LAUNCH_POSTED)

    expect(isOpen(rig, P)).toBe(false)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)).toBeUndefined()
    expect(rig.posts).toEqual([{ key: Q, text: text.text(Q) }])
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_SUPPRESSED), posterLine(Q, text, STUCK_LAUNCH_POSTED)])
  })

  test('raised while an episode is open: the post is suppressed and the episode keeps its marks; once cleared, the text not yet posted posts', () => {
    const rig = posterRig()
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)

    rig.raised.add(P)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)?.posted).toEqual([RELAUNCHING.mark])

    rig.raised.delete(P)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
    ])
  })

  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s with a tmux-unavailable query that throws: taken as raised, with its line; nothing posted and no episode begun', (_name, text) => {
    const err = new Error(`outage query refused (${sentinelInMessage('outage')})`)
    const rig = posterRig({
      tmuxUnavailableRaised: () => {
        throw err
      },
    })

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)

    expect(isOpen(rig, P)).toBe(false)
    expect(rig.posts).toEqual([])
    expect(rig.lines).toEqual([stuckLaunchOutageQueryFailedLine(P, describeThrownValue(err)), posterLine(P, text, STUCK_LAUNCH_SUPPRESSED)])
    assertNoLeak(rig.lines)
  })
})

describe('the stuck-launch posters: closed episodes, a submitted teardown, and failures (b.jg5 SRJ-1017, SRJ-1003)', () => {
  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s after the episodes are closed (shutdown): closed, nothing posted', (_name, text) => {
    const rig = posterRig()
    rig.episodes.close()

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_NOT_POSTED_CLOSED)

    expect(rig.posts).toEqual([])
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_NOT_POSTED_CLOSED)])
  })

  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s while P\'s teardown is submitted: muted, with its muted line, and it counts as posted in its episode', (_name, text) => {
    const rig = posterRig()
    rig.teardown.set(P, 'submitted')

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([])
    expect(rig.episodes.hasPosted(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH, text.mark)).toBe(true)
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_POSTED, true), posterLine(P, text, STUCK_LAUNCH_ALREADY_POSTED)])
    // The episodes log their own mute line once.
    expect(rig.episodeLines).toHaveLength(1)
  })

  test('an episodes call that throws: failed (never suppressed, the tmux-unavailable gate\'s answer), with its one line, and nothing posted', () => {
    const err = new Error(`episodes refused (${sentinelInMessage('episodes')})`)
    const posts: string[] = []
    const episodes: StuckLaunchPostEpisodes = {
      begin: () => {
        throw err
      },
      post: (_key, _kind, text) => {
        posts.push(text)
        return true
      },
      teardownWindowState: () => 'none',
    }
    const lines: string[] = []
    const deps: StuckLaunchPosterDeps = { episodes, tmuxUnavailableRaised: () => false, log: (line) => void lines.push(line) }

    for (const text of TEXT_CASES) expect(text.post(deps, P)).toBe(STUCK_LAUNCH_POST_FAILED)
    expect(STUCK_LAUNCH_POST_FAILED).not.toBe(STUCK_LAUNCH_SUPPRESSED)

    expect(posts).toEqual([])
    expect(lines).toEqual(TEXT_CASES.map(() => stuckLaunchPostFailedLine(P, describeThrownValue(err))))
    assertNoLeak(lines)
  })

  test('the session manager\'s held poster with no episodes instance: failed (never suppressed, the tmux-unavailable gate\'s answer), with its one line', () => {
    setStuckLaunchEpisodes(undefined)
    const lines: string[] = []
    const deps = buildPendingRowRuleDeps({ appliedPersona: () => undefined, log: (line) => void lines.push(line) })

    expect(deps.postHeld(P, RULE_START, false)).toBe(STUCK_LAUNCH_POST_FAILED)

    expect(lines).toEqual([pendingRowRuleNoEpisodesLine(P)])
  })

  test('the session manager\'s relaunching poster with no episodes instance: its line, then the abort skipped for the failed post; kept, no kill', async () => {
    setStuckLaunchEpisodes(undefined)
    const lines: string[] = []
    const deps = buildPendingRowRuleDeps({ appliedPersona: () => undefined, log: (line) => void lines.push(line) })

    expect(await deps.ownLaunch!.relaunch(P, renderPersonaRef(P), RULE_START)).toEqual({ kind: PENDING_ROW_RELAUNCH_KEPT, why: STUCK_LAUNCH_ABORT_SKIP_POST_FAILED })

    expect(lines).toEqual([pendingRowRuleNoEpisodesRelaunchingLine(P), stuckLaunchAbortSkippedLine(P, STUCK_LAUNCH_ABORT_SKIP_POST_FAILED)])
  })

  test('an episode end that throws: one line describing the error, no episode reported ended, nothing posted', () => {
    const err = new Error(`episodes end refused (${sentinelInMessage('episode-end')})`)
    const lines: string[] = []
    const episodes = { end: (): boolean => { throw err } }

    expect(endStuckLaunchEpisode(episodes, P, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING), (line) => void lines.push(line))).toBe(false)

    expect(lines).toEqual([stuckLaunchEpisodeEndFailedLine(P, describeThrownValue(err))])
    assertNoLeak(lines)
  })

  test('a log that throws changes nothing: the text posts once, then posts nothing', () => {
    const rig = posterRig({
      log: () => {
        throw new Error('log refused')
      },
    })

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(rig.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
  })
})

describe('isStuckLaunchEpisodeEndState: a live state out of pending ends the episode; pending, ended, missing and no row do not (b.jg5 SRJ-1016)', () => {
  test.each([...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE))('%s ends it', (state) => {
    expect(isStuckLaunchEpisodeEndState(state)).toBe(true)
  })

  test.each<[string, unknown]>([
    [AGENT_DIRECTOR_PENDING_STATE, AGENT_DIRECTOR_PENDING_STATE],
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state): [string, unknown] => [state, state]),
    ['no row (undefined)', undefined],
    ['null', null],
    ['an unknown state', 'starting'],
    ['a non-string', 1],
  ])('%s does not', (_label, state) => {
    expect(isStuckLaunchEpisodeEndState(state)).toBe(false)
  })
})

describe('assertNoLeak over the stuck-launch texts and lines (b.jg5 SRJ-1017)', () => {
  test('a key carrying a fake token: every text and line carries it only as the key, and nothing else token-like', () => {
    const key = `p_${fakeToken(BOT_TOKEN_PREFIX, 'key')}`
    const texts = [
      stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
      ...HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(key, POSTED_LAUNCH_START, flagged)),
    ]
    const answers: StuckLaunchPostAnswer[] = [STUCK_LAUNCH_POSTED, STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_SUPPRESSED, STUCK_LAUNCH_NOT_POSTED_CLOSED, STUCK_LAUNCH_POST_FAILED]
    const lines = [
      ...TEXT_CASES.flatMap((text) => answers.map((answer) => posterLine(key, text, answer))),
      posterLine(key, RELAUNCHING, STUCK_LAUNCH_POSTED, true),
      stuckLaunchEpisodeEndedLine(key, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING)),
    ]

    // The key is in them (the check would fail unmasked), and nothing else is token-like.
    expect(() => assertNoLeak({ texts, lines })).toThrow()
    assertNoLeak(withoutName({ texts, lines }, key, key))
  })

  test('a raw launch start carrying a fake token never reaches the held text: it renders as no launch start', () => {
    const raw = `${SAMPLE_LAUNCH_START_WHOLE}${fakeToken(BOT_TOKEN_PREFIX, 'launch')}`
    expect(describeLaunchStartForLog(raw)).toBe(describeLaunchStartForLog(undefined))
    assertNoLeak(HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(PREFIX_KEY, raw, flagged)))
  })
})

// ---------------------------------------------------------------------------
// The pending-row rule's pure decisions (b.jg5 SRJ-410, SRJ-117, SRJ-118)
// ---------------------------------------------------------------------------

describe('pendingRowAgeOf: the rule\'s step from the launch start, G before B, with the derived waits read at each call (b.jg5 SRJ-410, SRJ-406, SRJ-408)', () => {
  test.each(VALID_LAUNCH_STARTS)('%s launch start at the defaults: younger than G one tick before G, from G at G and one tick before B, at B at B', (_form, raw) => {
    const launchStartMs = parseLaunchStart(raw)!
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    expect(boundMs).toBeGreaterThan(graceMs)

    expect(pendingRowAgeOf(raw, launchStartMs + graceMs - 1)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(raw, launchStartMs + graceMs)).toBe(PENDING_ROW_AGE_FROM_G)
    expect(pendingRowAgeOf(raw, launchStartMs + boundMs - 1)).toBe(PENDING_ROW_AGE_FROM_G)
    expect(pendingRowAgeOf(raw, launchStartMs + boundMs)).toBe(PENDING_ROW_AGE_AT_B)
  })

  test.each(NONE_LAUNCH_STARTS)('a launch start %s: no launch start at any time, with any waits', (_label, raw) => {
    expect(pendingRowAgeOf(raw, Number.MAX_SAFE_INTEGER)).toBe(PENDING_ROW_AGE_NO_LAUNCH_START)
    expect(pendingRowAgeOf(raw, Number.MAX_SAFE_INTEGER, { graceMs: 0, launchBoundMs: 0 })).toBe(PENDING_ROW_AGE_NO_LAUNCH_START)
  })

  test('G is checked first: with B shorter than G, a row past B but not past G is younger than G', () => {
    const waits = { graceMs: 10 * MINUTE_MS, launchBoundMs: MINUTE_MS }
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + 5 * MINUTE_MS, waits)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + 10 * MINUTE_MS, waits)).toBe(PENDING_ROW_AGE_AT_B)
  })

  test.each<[string, number | (() => number)]>([
    ['AD_WAIT_NEVER_ENDS', AD_WAIT_NEVER_ENDS],
    ['NaN', Number.NaN],
    ['an accessor answering NaN', () => Number.NaN],
    [
      'an accessor that throws',
      () => {
        throw new Error('unreadable wait')
      },
    ],
  ])('a G of %s: the row is never past G, so neither a lap nor a run is ever due', (_label, graceMs) => {
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, Number.MAX_SAFE_INTEGER, { graceMs, launchBoundMs: 0 })).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
  })

  test('a B of AD_WAIT_NEVER_ENDS: from G at any later time, never at B', () => {
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, Number.MAX_SAFE_INTEGER, { graceMs: 0, launchBoundMs: AD_WAIT_NEVER_ENDS })).toBe(PENDING_ROW_AGE_FROM_G)
  })

  test('a G beyond the timer maximum is compared, never armed: younger one tick before launch start + G, from G at it (E6)', () => {
    const graceMs = MAX_TIMER_DELAY_MS + MINUTE_MS
    const waits = { graceMs, launchBoundMs: graceMs + MINUTE_MS }
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + graceMs - 1, waits)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + graceMs, waits)).toBe(PENDING_ROW_AGE_FROM_G)
  })

  test('the accessors are read at each call: a G raised in the settings file moves the next answer', () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + oldGraceMs)).toBe(PENDING_ROW_AGE_FROM_G)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + oldGraceMs)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + adGraceMsInEffect())).toBe(PENDING_ROW_AGE_FROM_G)
  })
})

describe('isPendingRowLapEligible: a lap only with no approver running and no not-interactive record on the launch (b.jg5 SRJ-410, SRJ-118)', () => {
  test.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false],
  ])('approver running %p, the launch met ErrSpawnNotInteractive %p: lap %p', (approverRunning, metNotInteractive, eligible) => {
    expect(isPendingRowLapEligible({ approverRunning, metNotInteractive })).toBe(eligible)
  })
})

/** The read-pane outcome of `err`, through the one mapper (`paneReadFailureOf`). */
const paneFailure = (err: Error): PaneReadOutcome => paneReadFailureOf(err)

/** A read-pane CONFLICT for persona `key`'s session (a leftover). */
const readPaneConflict = (key: string): Error => errTmuxSessionConflict('read-pane', 'leftover', personaTmuxSessionName(key))

/** A send-keys CONFLICT for persona `key`'s session (not this launch's). */
const sendKeysConflict = (key: string): Error => errTmuxSessionConflict('send-keys', 'not-this-launch', personaTmuxSessionName(key))

/** An UNCLASSIFIED answer of `verb`: a name no table knows. */
const unclassifiedAt = (verb: string): Error => errGeneric(verb, 'ErrBrandNewName', 'a new failure')

/**
 * The lap Enter outcome of a thrown `err` that does not latch (the session
 * manager's Enter answers a latching CONFLICT or UNUSABLE NAME as latched).
 */
const enterFailure = (err: Error): PendingRowLapEnterOutcome => pendingRowLapEnterFailureOf(err) as PendingRowLapEnterOutcome

/**
 * SRJ-117's pending-row lap column, one row per cell: the lap's read-pane
 * outcome, what follows it, and whether the run goes on.
 */
const LAP_PANE_CELLS: ReadonlyArray<readonly [string, () => PaneReadOutcome, PendingRowLapNext]> = [
  ['a pane showing the trust dialog', () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }), PENDING_ROW_LAP_NEXT_ENTER],
  ['a pane showing the dev-channels dialog', () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_DEV_CHANNELS) }), PENDING_ROW_LAP_NEXT_ENTER],
  ['a pane with no needle (a prompt the approver does not know)', () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_UNRECOGNISED) }), PENDING_ROW_LAP_NEXT_RUN],
  ['an empty pane', () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_NONE) }), PENDING_ROW_LAP_NEXT_RUN],
  ['GONE (ErrTmuxCaptureFailed)', () => paneFailure(errTmuxCaptureFailed()), PENDING_ROW_LAP_NEXT_RUN],
  ['ErrSpawnNotFound', () => paneFailure(errSpawnNotFound()), PENDING_ROW_LAP_NEXT_RUN],
  ['UNAVAILABLE (a call timeout)', () => paneFailure(errCallTimeout('read-pane')), PENDING_ROW_LAP_NEXT_RUN],
  ['UNAVAILABLE (ErrTmuxUnresponsive)', () => paneFailure(errTmuxUnresponsive('read-pane')), PENDING_ROW_LAP_NEXT_RUN],
  ['CONFIG (ErrConfigMalformed)', () => paneFailure(errConfigMalformed()), PENDING_ROW_LAP_NEXT_RUN],
  ['ENVIRONMENT (ErrTmuxNotAvailable)', () => paneFailure(errTmuxNotAvailable(undefined, 'read-pane')), PENDING_ROW_LAP_NEXT_RUN],
  ['UNCLASSIFIED', () => paneFailure(unclassifiedAt('read-pane')), PENDING_ROW_LAP_NEXT_RUN],
  ['UNCLASSIFIED whose version re-check decided that the server stops', () => ({ ...paneReadFailureOf(unclassifiedAt('read-pane')), stopping: true }) as PaneReadOutcome, PENDING_ROW_LAP_NEXT_STOPPING],
  ['CONFLICT', () => paneFailure(readPaneConflict('alpha')), PENDING_ROW_LAP_NEXT_LATCHED],
  ['UNUSABLE NAME', () => paneFailure(errUnusableName()), PENDING_ROW_LAP_NEXT_LATCHED],
  ['latched before the read (no call)', () => PANE_READ_NOT_READ_LATCHED, PENDING_ROW_LAP_NEXT_LATCHED],
  ['latched by the read\'s CONFLICT', () => ({ kind: PANE_READ_LATCHED, cause: paneReadFailureOf(readPaneConflict('alpha')) as PaneReadConflict }), PENDING_ROW_LAP_NEXT_LATCHED],
]

describe('decidePendingRowLapPane: SRJ-117\'s pending-row lap column, one case per cell (b.jg5 SRJ-117, SRJ-613)', () => {
  test.each(LAP_PANE_CELLS)('%s', (_label, outcome, next) => {
    const decision = decidePendingRowLapPane(outcome(), paneShowsStartupDialog)
    expect(decision.next).toBe(next)
    // Only a send-keys answer sets the not-interactive record (SRJ-412).
    expect(decision.setNotInteractiveRecord).toBe(false)
    expect(decision.note).not.toContain('\n')
  })

  test('a recognition that throws counts as no dialog: the run goes on, nothing typed', () => {
    const decision = decidePendingRowLapPane({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }, () => {
      throw new Error('recognition failed')
    })
    expect(decision.next).toBe(PENDING_ROW_LAP_NEXT_RUN)
  })

  test('a failure\'s note carries its description, redacted: assertNoLeak over a sentinel-bearing failure', () => {
    const outcome = paneFailure(errGeneric('read-pane', 'ErrBrandNewName', sentinelInMessage('lap pane')))
    const decision = decidePendingRowLapPane(outcome, paneShowsStartupDialog)
    expect(decision.note).toContain((outcome as { description: string }).description)
    assertNoLeak(decision)
  })
})

/** SRJ-118's approver-and-lap row for the lap's Enter: the outcome, what follows, and whether the record is set. */
const LAP_ENTER_CELLS: ReadonlyArray<readonly [string, () => PendingRowLapEnterOutcome, PendingRowLapNext, boolean]> = [
  ['typed (success)', () => ({ kind: PENDING_ROW_LAP_ENTER_SENT }), PENDING_ROW_LAP_NEXT_RUN, false],
  ['GONE', () => enterFailure(errTmuxSendKeys()), PENDING_ROW_LAP_NEXT_RUN, false],
  ['ErrSpawnNotFound', () => enterFailure(errSpawnNotFound()), PENDING_ROW_LAP_NEXT_RUN, false],
  ['ErrSpawnNotInteractive', () => enterFailure(errSpawnNotInteractive('send-keys')), PENDING_ROW_LAP_NEXT_RUN, true],
  ['UNAVAILABLE', () => enterFailure(errCallTimeout('send-keys')), PENDING_ROW_LAP_NEXT_RUN, false],
  ['CONFIG', () => enterFailure(errConfigMalformed()), PENDING_ROW_LAP_NEXT_RUN, false],
  ['ENVIRONMENT', () => enterFailure(errTmuxNotAvailable(undefined, 'send-keys')), PENDING_ROW_LAP_NEXT_RUN, false],
  ['UNCLASSIFIED', () => enterFailure(errSendKeysWhileRelayed()), PENDING_ROW_LAP_NEXT_RUN, false],
  ['UNCLASSIFIED whose version re-check decided that the server stops', () => ({ ...pendingRowLapEnterFailureOf(unclassifiedAt('send-keys')), stopping: true }) as PendingRowLapEnterOutcome, PENDING_ROW_LAP_NEXT_STOPPING, false],
  ['latched before the Enter (no call)', () => PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED, PENDING_ROW_LAP_NEXT_LATCHED, false],
  ['latched by the Enter\'s CONFLICT', () => ({ kind: PENDING_ROW_LAP_ENTER_LATCHED, cause: pendingRowLapEnterFailureOf(sendKeysConflict('alpha')) as PendingRowLapEnterConflict }), PENDING_ROW_LAP_NEXT_LATCHED, false],
]

describe('decidePendingRowLapEnter: the lap\'s Enter, one case per outcome; a "Stop" ends the lap only, and the run goes on unless P latched (b.jg5 SRJ-118, SRJ-410)', () => {
  test.each(LAP_ENTER_CELLS)('%s', (_label, outcome, next, record) => {
    const decision = decidePendingRowLapEnter(outcome())
    expect([decision.next, decision.setNotInteractiveRecord]).toEqual([next, record])
    expect(decision.note).not.toContain('\n')
  })
})

describe('pendingRowLapEnterFailureOf: a thrown Enter by class and by name, never by class identity (b.jg5 SRJ-118)', () => {
  test.each<[string, () => Error, PendingRowLapEnterFailure['kind'], boolean]>([
    ['GONE (ErrTmuxSendKeys)', errTmuxSendKeys, PENDING_ROW_LAP_ENTER_GONE, false],
    ['ErrSpawnNotFound', errSpawnNotFound, PENDING_ROW_LAP_ENTER_ABSENT, false],
    ['ErrSpawnNotInteractive (a leftover holds the name)', () => errSpawnNotInteractive('send-keys'), PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE, false],
    ['ErrSpawnNotInteractive (no launch start)', () => errSpawnNotInteractiveNoLaunchStart('send-keys'), PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE, false],
    ['CONFLICT', () => sendKeysConflict('alpha'), PENDING_ROW_LAP_ENTER_CONFLICT, true],
    ['UNUSABLE NAME', () => errUnusableName(), PENDING_ROW_LAP_ENTER_UNUSABLE_NAME, true],
    ['CONFIG', () => errConfigMalformed(), PENDING_ROW_LAP_ENTER_CONFIG, false],
    ['ENVIRONMENT', () => errTmuxNotAvailable(undefined, 'send-keys'), PENDING_ROW_LAP_ENTER_ENVIRONMENT, false],
    ['UNAVAILABLE (a call timeout)', () => errCallTimeout('send-keys'), PENDING_ROW_LAP_ENTER_UNAVAILABLE, false],
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('send-keys'), PENDING_ROW_LAP_ENTER_UNAVAILABLE, false],
    ['UNCLASSIFIED (ErrSendKeysWhileRelayed)', errSendKeysWhileRelayed, PENDING_ROW_LAP_ENTER_UNCLASSIFIED, false],
    ['UNCLASSIFIED (a name no table knows)', () => unclassifiedAt('send-keys'), PENDING_ROW_LAP_ENTER_UNCLASSIFIED, false],
  ])('%s', (_label, make, kind, keepsError) => {
    const err = make()
    const failure = pendingRowLapEnterFailureOf(err)
    expect(failure.kind).toBe(kind)
    // Only a latching answer keeps the thrown value, so the caller can latch through the latch's entries.
    expect('error' in failure ? failure.error : undefined).toBe(keepsError ? err : undefined)
    expect(failure.description).not.toContain('\n')
  })

  test('the description is redacted: assertNoLeak over a sentinel-bearing Enter failure', () => {
    assertNoLeak(pendingRowLapEnterFailureOf(errGeneric('send-keys', 'ErrBrandNewName', sentinelInMessage('lap enter'))).description)
  })
})

describe('readPendingRowRun: the round\'s reading of its run and its get; never step 3 on an earlier read (b.jg5 SRJ-410, SRJ-120)', () => {
  const pendingGet: PendingRowRuleGet = { kind: PENDING_ROW_GET_ROW, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_WHOLE }
  const refusedErr = errCallTimeout('get')

  test.each<[string, PendingRowRunPlacement, PendingRowRuleGet, PendingRowRunReading]>([
    ['the run latched P (the get is never read)', PENDING_ROW_RUN_LATCHED, pendingGet, { kind: PENDING_ROW_READING_LATCHED }],
    ['the run was refused (the get is never read)', PENDING_ROW_RUN_REFUSED, pendingGet, { kind: PENDING_ROW_READING_RUN_REFUSED }],
    ['the get latched P', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_LATCHED }, { kind: PENDING_ROW_READING_LATCHED }],
    ['the get failed', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_REFUSED, error: refusedErr }, { kind: PENDING_ROW_READING_READ_REFUSED, error: refusedErr }],
    ['the get found no row', PENDING_ROW_RUN_MARKED_MISSING, { kind: PENDING_ROW_GET_ABSENT }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_NO_ROW }],
    ['the get read ended', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_ENDED, launchStartedAt: undefined }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_ENDED }],
    ['the get read missing', PENDING_ROW_RUN_MARKED_MISSING, { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_MISSING, launchStartedAt: undefined }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_MISSING }],
    ['the get read a state CSCB does not know', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state: 'starting', launchStartedAt: undefined }, { kind: PENDING_ROW_READING_UNKNOWN_STATE, state: 'starting' }],
  ])('%s', (_label, run, get, reading) => {
    expect(readPendingRowRun(run, get)).toEqual(reading)
  })

  test.each([...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE))('the get read %s: live, no action from the rule', (state) => {
    expect(readPendingRowRun(PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state, launchStartedAt: undefined })).toEqual({ kind: PENDING_ROW_READING_LIVE, state })
  })

  test.each<[PendingRowRunPlacement, boolean]>([
    [PENDING_ROW_RUN_MARKED_MISSING, true],
    [PENDING_ROW_RUN_LEFT_LIVE, true],
    [PENDING_ROW_RUN_JUDGED_ALIVE, true],
    [PENDING_ROW_RUN_NOT_JUDGED, false],
    [PENDING_ROW_RUN_FAILED, false],
  ])('the run placed the row %s and the get still reads pending: judged %p, with the get\'s own launch start', (run, judged) => {
    expect(readPendingRowRun(run, { ...pendingGet, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL })).toEqual({
      kind: PENDING_ROW_READING_PENDING,
      judged,
      launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL,
    })
  })
})

describe('decidePendingRowStepThree: still pending at B, judged or not (b.jg5 SRJ-410, SRJ-412, SRJ-1017)', () => {
  const quiet: PendingRowStepThreeInput = {
    tmuxUnavailableRaised: false,
    latched: false,
    ownLaunch: false,
    configMalformedRaised: false,
    abortAvailable: false,
    metNotInteractive: false,
  }
  const flags = ['latched', 'ownLaunch', 'configMalformedRaised', 'abortAvailable', 'metNotInteractive'] as const

  test('tmux-unavailable raised wins over every other input, in every combination', () => {
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const input = { ...quiet, tmuxUnavailableRaised: true, ...Object.fromEntries(flags.map((flag, i) => [flag, (mask & (1 << i)) !== 0])) }
      expect(decidePendingRowStepThree(input)).toEqual({ kind: PENDING_ROW_STEP3_TMUX_UNAVAILABLE })
    }
  })

  test.each<[string, Partial<PendingRowStepThreeInput>, PendingRowStepThree]>([
    ['P latched (whatever else)', { latched: true, ownLaunch: true, abortAvailable: true }, { kind: PENDING_ROW_STEP3_LATCHED }],
    ['CSCB\'s own launch, its abort available', { ownLaunch: true, abortAvailable: true }, { kind: PENDING_ROW_STEP3_RELAUNCH }],
    ['CSCB\'s own launch, its abort available, ad-config-malformed raised', { ownLaunch: true, abortAvailable: true, configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_CONFIG_MALFORMED }],
    ['CSCB\'s own launch, its abort spent: the held text', { ownLaunch: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['CSCB\'s own launch, its abort spent, ad-config-malformed raised: neither text', { ownLaunch: true, configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_CONFIG_MALFORMED }],
    ['any other row: the held text with the attach line', {}, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['any other row, ad-config-malformed raised: still the held text', { configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['any other row whose launch met ErrSpawnNotInteractive: the held text without the attach line', { metNotInteractive: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: false }],
  ])('%s', (_label, input, expected) => {
    expect(decidePendingRowStepThree({ ...quiet, ...input })).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// The pending-row rule's driver over injected dependencies (b.jg5 SRJ-410)
// ---------------------------------------------------------------------------

/** The driver cases' persona, its reference and its row's launch start. */
const RULE_KEY = 'alpha'
const RULE_REF = renderPersonaRef('Alpha', RULE_KEY)
const RULE_START = SAMPLE_LAUNCH_START_WHOLE

/** A dependency call the rule makes that reaches agent-director, posts or records. */
type RuleCall = 'read-pane' | 'send-keys' | 'find-missing' | 'get' | 'post' | 'record' | 'relaunch'

/** A rig over the rule's injected dependencies: what each call answers, and what was called. */
interface RuleRig {
  readonly rule: ReturnType<typeof createPendingRowRule>
  /** The calls made, in order. */
  readonly calls: RuleCall[]
  /** The rule's lines. */
  readonly lines: string[]
  /** Each held post: the key, the launch start and the not-interactive flag. */
  readonly posts: Array<readonly [string, unknown, boolean]>
  /** Each not-interactive record: the key and the launch start. */
  readonly records: Array<readonly [string, unknown]>
  /** Each "blocks a retry" ask: the key and `withinOwnLaunch`. */
  readonly blockedAsks: Array<readonly [string, boolean]>
}

/** Options of {@link ruleRig}. */
interface RuleRigOptions {
  /** The clock's now: the launch start plus this many ms (G by default). */
  readonly sinceStartMs?: number
  /** P is latched once this call has answered. */
  readonly latchAfter?: RuleCall
}

/**
 * The rule over fake dependencies for {@link RULE_KEY}, with the derived waits
 * read from their accessors as in production: P not latched, nothing in
 * flight, not held, no approver running, no not-interactive record (but one
 * that `recordNotInteractive` sets), an empty pane, Enter typed, a run that
 * did not judge the row, a get reading it still `pending` with
 * {@link RULE_START}, no outage, and the held post posted; `overrides`
 * replace any of them.
 */
function ruleRig(overrides: Partial<PendingRowRuleDeps> = {}, options: RuleRigOptions = {}): RuleRig {
  const calls: RuleCall[] = []
  const lines: string[] = []
  const posts: Array<readonly [string, unknown, boolean]> = []
  const records: Array<readonly [string, unknown]> = []
  const blockedAsks: Array<readonly [string, boolean]> = []
  let latched = false
  const call = (name: RuleCall): void => {
    calls.push(name)
    if (options.latchAfter === name) latched = true
  }
  const nowMs = parseLaunchStart(RULE_START)! + (options.sinceStartMs ?? adGraceMsInEffect())
  const deps: PendingRowRuleDeps = {
    now: () => nowMs,
    log: (line) => void lines.push(line),
    isLatched: () => latched,
    retryBlockedBy: (key, withinOwnLaunch) => {
      blockedAsks.push([key, withinOwnLaunch])
      return undefined
    },
    isHeldForOldLife: () => false,
    isApproverRunning: () => false,
    launchMetNotInteractive: (key, launchStart) => records.some(([k, start]) => k === key && start === launchStart),
    recordNotInteractive: (key, launchStart) => {
      records.push([key, launchStart])
      call('record')
    },
    readLapPane: async () => {
      call('read-pane')
      return { kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_NONE) }
    },
    paneShowsStartupDialog,
    sendLapEnter: async () => {
      call('send-keys')
      return { kind: PENDING_ROW_LAP_ENTER_SENT }
    },
    runFindMissing: async () => {
      call('find-missing')
      return PENDING_ROW_RUN_NOT_JUDGED
    },
    readRow: async () => {
      call('get')
      return { kind: PENDING_ROW_GET_ROW, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: RULE_START }
    },
    isTmuxUnavailableRaised: () => false,
    isConfigMalformedRaised: () => false,
    postHeld: (key, launchStart, metNotInteractive) => {
      posts.push([key, launchStart, metNotInteractive])
      call('post')
      return STUCK_LAUNCH_POSTED
    },
  }
  // Each override keeps the rig's call record for the agent-director calls it replaces.
  const recorded: Partial<PendingRowRuleDeps> = { ...overrides }
  const wrap = <K extends 'readLapPane' | 'sendLapEnter' | 'runFindMissing' | 'readRow'>(name: K, as: RuleCall): void => {
    const given = overrides[name] as ((key: string, ref: string) => Promise<unknown>) | undefined
    if (given === undefined) return
    ;(recorded as Record<string, unknown>)[name] = async (key: string, ref: string) => {
      call(as)
      return given(key, ref)
    }
  }
  wrap('readLapPane', 'read-pane')
  wrap('sendLapEnter', 'send-keys')
  wrap('runFindMissing', 'find-missing')
  wrap('readRow', 'get')
  return { rule: createPendingRowRule({ ...deps, ...recorded }), calls, lines, posts, records, blockedAsks }
}

/** The rule's input for P on its `pending` row with {@link RULE_START}, at a retry unless `overrides` say otherwise. */
function ruleInput(overrides: Partial<PendingRowRuleInput> = {}): PendingRowRuleInput {
  return {
    key: RULE_KEY,
    ref: RULE_REF,
    row: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: RULE_START },
    origin: PENDING_ROW_RULE_ORIGIN_RETRY,
    ...overrides,
  }
}

/** Where the rule runs from: a retry of P's timer, and P's approver's stop. */
const RULE_INPUT_ORIGINS: Array<PendingRowRuleInput['origin']> = [PENDING_ROW_RULE_ORIGIN_RETRY, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP]

/** A refusal answer with `reason`. */
const refusalOf = (reason: PendingRowRuleRefusalReason): PendingRowRuleAnswer => ({ kind: PENDING_ROW_RULE_REFUSAL, reason })

/** The fixed start of the rule's gate line for `ref` at `origin` (everything before its reason). */
const gateLineStart = (ref: string, origin: PendingRowRuleInput['origin']): string => pendingRowRuleGateLine(ref, origin, '').split(' — ')[0]!

/** The fixed start of the rule's round line for `ref` at `origin` with launch start `start` (everything before its steps). */
const roundLineStart = (ref: string, origin: PendingRowRuleInput['origin'], start: unknown): string =>
  pendingRowRuleRoundLine(ref, origin, start, [], '').split('; ')[0]!

/** The lap note a pane with no startup dialog gives, as the round line carries it. */
const NO_DIALOG_LAP_STEP = `lap: ${decidePendingRowLapPane({ kind: PANE_READ_PANE, pane: '' }, paneShowsStartupDialog).note}`

describe('the pending-row rule\'s gate: one line and no call for a latched, blocked or held persona, a row not pending or one with no launch start (b.jg5 SRJ-410, SRJ-502, SRJ-303, SRJ-810, SRJ-408)', () => {
  const throwing = (): never => {
    throw new Error('query failed')
  }

  test.each<[string, Partial<PendingRowRuleDeps>, Partial<PendingRowRuleInput>, PendingRowRuleAnswer]>([
    ['P latched (SRJ-502)', { isLatched: () => true }, {}, { kind: PENDING_ROW_RULE_LATCHED }],
    ['a latched query that throws: taken as latched', { isLatched: throwing }, {}, { kind: PENDING_ROW_RULE_LATCHED }],
    ['a launch call in flight blocks it (SRJ-303)', { retryBlockedBy: () => RETRY_BLOCK_LAUNCH }, {}, refusalOf('blocked')],
    ['a work-in-flight query that throws: taken as blocked', { retryBlockedBy: throwing }, {}, refusalOf('blocked')],
    ['its working directory held for an old life (SRJ-810)', { isHeldForOldLife: () => true }, {}, refusalOf('held-for-old-life')],
    ['a held query that throws: taken as held', { isHeldForOldLife: throwing }, {}, refusalOf('held-for-old-life')],
    ['a row it was given that is not pending', {}, { row: { state: 'waiting', launchStartedAt: undefined } }, refusalOf('not-pending')],
    ...NO_LAUNCH_STARTS.map(([form, launch]): [string, Partial<PendingRowRuleDeps>, Partial<PendingRowRuleInput>, PendingRowRuleAnswer] => [
      `a pending row with no launch start (${form}; SRJ-408)`,
      {},
      { row: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: launch } },
      refusalOf('no-launch-start'),
    ]),
  ])('%s: its answer, one gate line, no lap, run, get or post', async (_label, overrides, input, answer) => {
    const rig = ruleRig(overrides, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput(input))).toEqual(answer)
    expect(rig.calls).toEqual([])
    expect(rig.lines).toHaveLength(1)
    expect(rig.lines[0]!.startsWith(gateLineStart(RULE_REF, PENDING_ROW_RULE_ORIGIN_RETRY))).toBe(true)
  })

  test('the gates in order: latched first, then work in flight, then the old-life hold, then the row', async () => {
    const all = { isLatched: () => true, retryBlockedBy: () => RETRY_BLOCK_LAUNCH, isHeldForOldLife: () => true }
    const notPending = { row: { state: 'waiting', launchStartedAt: undefined } }
    expect(await ruleRig(all).rule.run(ruleInput(notPending))).toEqual({ kind: PENDING_ROW_RULE_LATCHED })
    expect(await ruleRig({ ...all, isLatched: () => false }).rule.run(ruleInput(notPending))).toEqual(refusalOf('blocked'))
    expect(await ruleRig({ ...all, isLatched: () => false, retryBlockedBy: () => undefined }).rule.run(ruleInput(notPending))).toEqual(refusalOf('held-for-old-life'))
  })

  test('the work-in-flight query is asked with withinOwnLaunch from the ladder\'s pending step, without it otherwise', async () => {
    const rig = ruleRig({}, { sinceStartMs: 0 })
    await rig.rule.run(ruleInput())
    await rig.rule.run(ruleInput({ withinOwnLaunch: true }))
    expect(rig.blockedAsks).toEqual([
      [RULE_KEY, false],
      [RULE_KEY, true],
    ])
  })

  test.each(RULE_INPUT_ORIGINS)('a row younger than G at %s: a refusal with no call and no line (step 1)', async (origin) => {
    const rig = ruleRig({}, { sinceStartMs: adGraceMsInEffect() - 1 })
    expect(await rig.rule.run(ruleInput({ origin }))).toEqual(refusalOf('younger-than-g'))
    expect([rig.calls, rig.lines]).toEqual([[], []])
  })
})

describe('the pending-row rule\'s step 2 from G: one lap when no approver runs, then one bypassing run and one get; before B nothing more (b.jg5 SRJ-410, SRJ-118, SRJ-120)', () => {
  test.each(RULE_INPUT_ORIGINS)('at %s, an empty pane, a run that did not judge the row: read-pane, find-missing, get; a refusal; one round line', async (origin) => {
    const rig = ruleRig()
    expect(await rig.rule.run(ruleInput({ origin }))).toEqual(refusalOf('not-judged'))
    expect(rig.calls).toEqual(['read-pane', 'find-missing', 'get'])
    expect(rig.lines).toHaveLength(1)
    const [line] = rig.lines
    expect(line!.startsWith(roundLineStart(RULE_REF, origin, RULE_START))).toBe(true)
    expect(line).toContain(NO_DIALOG_LAP_STEP)
    expect(line).toContain(`find-missing: ${PENDING_ROW_RUN_NOT_JUDGED}`)
    expect(rig.posts).toEqual([])
  })

  test('a pane showing a startup dialog: Enter, then the run and the get', async () => {
    const rig = ruleRig({ readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }) })
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('not-judged'))
    expect(rig.calls).toEqual(['read-pane', 'send-keys', 'find-missing', 'get'])
  })

  test.each<[string, PendingRowRunPlacement]>([
    ['left live (unverified_ids)', PENDING_ROW_RUN_LEFT_LIVE],
    ['judged alive', PENDING_ROW_RUN_JUDGED_ALIVE],
  ])('a run that judged the row %s, the get still pending before B: a refusal, no post', async (_label, placement) => {
    const rig = ruleRig({ runFindMissing: async () => placement })
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('still-pending'))
    expect(rig.posts).toEqual([])
  })

  test('a run that failed in another way: the get still follows, and the row counts as not judged', async () => {
    const rig = ruleRig({ runFindMissing: async () => PENDING_ROW_RUN_FAILED })
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('not-judged'))
    expect(rig.calls).toEqual(['read-pane', 'find-missing', 'get'])
  })

  test.each<[string, PendingRowRunPlacement, PendingRowRuleAnswer]>([
    ['refused', PENDING_ROW_RUN_REFUSED, refusalOf('run-refused')],
    ['latched P', PENDING_ROW_RUN_LATCHED, { kind: PENDING_ROW_RULE_LATCHED }],
  ])('a run that %s ends the round: no get, no post', async (_label, placement, answer) => {
    const rig = ruleRig({ runFindMissing: async () => placement }, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput())).toEqual(answer)
    expect(rig.calls).toEqual(['read-pane', 'find-missing'])
  })

  test.each<[string, PendingRowRuleGet, PendingRowRuleAnswer]>([
    ['no row', { kind: PENDING_ROW_GET_ABSENT }, { kind: PENDING_ROW_RULE_GONE, state: LIVENESS_DEAD_ROW_NO_ROW }],
    ['ended', { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_ENDED, launchStartedAt: undefined }, { kind: PENDING_ROW_RULE_GONE, state: LIVENESS_DEAD_ROW_ENDED }],
    ['missing', { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_MISSING, launchStartedAt: undefined }, { kind: PENDING_ROW_RULE_GONE, state: LIVENESS_DEAD_ROW_MISSING }],
    ['waiting', { kind: PENDING_ROW_GET_ROW, state: 'waiting', launchStartedAt: undefined }, { kind: PENDING_ROW_RULE_LIVE, state: 'waiting' }],
    ['a state CSCB does not know', { kind: PENDING_ROW_GET_ROW, state: 'starting', launchStartedAt: undefined }, refusalOf('unknown-state')],
    ['latched P', { kind: PENDING_ROW_GET_LATCHED }, { kind: PENDING_ROW_RULE_LATCHED }],
  ])('a get after the run reading %s, at B: its answer and no post', async (_label, get, answer) => {
    const rig = ruleRig({ readRow: async () => get }, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput())).toEqual(answer)
    expect(rig.posts).toEqual([])
  })

  test('a failed get after the run, at B: nothing more that round (read refused), no post, the failure described on the round line', async () => {
    const err = errGeneric('get', 'ErrBrandNewName', sentinelInMessage('rule get'))
    const rig = ruleRig({ readRow: async () => ({ kind: PENDING_ROW_GET_REFUSED, error: err }) }, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_READ_REFUSED, error: err })
    expect(rig.posts).toEqual([])
    expect(rig.lines).toHaveLength(1)
    assertNoLeak(rig.lines)
  })

  test.each<[string, Partial<PendingRowRuleDeps>]>([
    ['a dialog approver runs (SRJ-303\'s approver-only case)', { isApproverRunning: () => true }],
    ['an approver query that throws: taken as running', { isApproverRunning: () => { throw new Error('registry failed') } }],
    ['this launch\'s send-keys met ErrSpawnNotInteractive', { launchMetNotInteractive: () => true }],
    ['a record query that throws: taken as met', { launchMetNotInteractive: () => { throw new Error('record failed') } }],
  ])('%s: no lap; the run and the get still follow', async (_label, overrides) => {
    const rig = ruleRig({ readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }), ...overrides })
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('not-judged'))
    expect(rig.calls).toEqual(['find-missing', 'get'])
  })

  test.each<[string, PaneReadOutcome, PendingRowRuleAnswer, RuleCall[]]>([
    ['latched P', PANE_READ_NOT_READ_LATCHED, { kind: PENDING_ROW_RULE_LATCHED }, ['read-pane']],
    ['CONFLICT (the shared reader latched P)', { kind: PANE_READ_LATCHED, cause: paneReadFailureOf(readPaneConflict(RULE_KEY)) as PaneReadConflict }, { kind: PENDING_ROW_RULE_LATCHED }, ['read-pane']],
    ['UNCLASSIFIED with the stop mark', { ...paneReadFailureOf(unclassifiedAt('read-pane')), stopping: true } as PaneReadOutcome, refusalOf('lap-only'), ['read-pane']],
    ['GONE (a "Stop" cell: the lap ends, the run goes on)', paneFailure(errTmuxCaptureFailed()), { kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_POSTED }, ['read-pane', 'find-missing', 'get', 'post']],
  ])('a lap read-pane answering %s, at B', async (_label, outcome, answer, calls) => {
    const rig = ruleRig({ readLapPane: async () => outcome }, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput())).toEqual(answer)
    expect(rig.calls).toEqual(calls)
  })

  test.each<[string, PendingRowLapEnterOutcome, PendingRowRuleAnswer, RuleCall[]]>([
    ['latched P', PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED, { kind: PENDING_ROW_RULE_LATCHED }, ['read-pane', 'send-keys']],
    ['UNCLASSIFIED with the stop mark', { ...pendingRowLapEnterFailureOf(unclassifiedAt('send-keys')), stopping: true } as PendingRowLapEnterOutcome, refusalOf('lap-only'), ['read-pane', 'send-keys']],
    ['GONE (a "Stop" cell)', enterFailure(errTmuxSendKeys()), refusalOf('not-judged'), ['read-pane', 'send-keys', 'find-missing', 'get']],
    ['ErrSpawnNotInteractive: the record is set, then the run', enterFailure(errSpawnNotInteractive('send-keys')), refusalOf('not-judged'), ['read-pane', 'send-keys', 'record', 'find-missing', 'get']],
  ])('a lap Enter answering %s', async (_label, outcome, answer, calls) => {
    const rig = ruleRig({
      readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }),
      sendLapEnter: async () => outcome,
    })
    expect(await rig.rule.run(ruleInput())).toEqual(answer)
    expect(rig.calls).toEqual(calls)
  })

  test('the Enter\'s ErrSpawnNotInteractive records this launch only: a second round on it makes no lap, a new launch laps again', async () => {
    const rig = ruleRig({
      readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }),
      sendLapEnter: async () => enterFailure(errSpawnNotInteractive('send-keys')),
    })
    await rig.rule.run(ruleInput())
    expect(rig.records).toEqual([[RULE_KEY, RULE_START]])
    rig.calls.length = 0
    await rig.rule.run(ruleInput())
    expect(rig.calls).toEqual(['find-missing', 'get'])

    // A new launch (another launch start, also past G at the rig's now): the lap again.
    rig.calls.length = 0
    const newStart = launchStartText(parseLaunchStart(RULE_START)! - 1)
    await rig.rule.run(ruleInput({ row: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: newStart } }))
    expect(rig.calls.slice(0, 2)).toEqual(['read-pane', 'send-keys'])
  })

  test.each<[string, RuleCall, boolean, RuleCall[]]>([
    ['the lap\'s read-pane (an empty pane)', 'read-pane', false, ['read-pane']],
    ['the lap\'s read-pane (a dialog: no Enter)', 'read-pane', true, ['read-pane']],
    ['the lap\'s Enter', 'send-keys', true, ['read-pane', 'send-keys']],
    ['the run', 'find-missing', false, ['read-pane', 'find-missing']],
    ['the get', 'get', false, ['read-pane', 'find-missing', 'get']],
  ])('P latching once %s answered: latched, no further call and no post, at B (SRJ-502)', async (_label, after, dialog, calls) => {
    const rig = ruleRig(
      dialog ? { readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }) } : {},
      { sinceStartMs: adLaunchBoundMsInEffect(), latchAfter: after },
    )
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_LATCHED })
    expect(rig.calls).toEqual(calls)
    expect(rig.posts).toEqual([])
  })
})

describe('the pending-row rule\'s step 3 at B: the held post, never a kill; nothing while tmux-unavailable is raised (b.jg5 SRJ-410, SRJ-1017)', () => {
  const atB = { sinceStartMs: adLaunchBoundMsInEffect() }

  test.each<[string, PendingRowRunPlacement]>([
    ['not judged', PENDING_ROW_RUN_NOT_JUDGED],
    ['judged and left live', PENDING_ROW_RUN_LEFT_LIVE],
  ])('a row still pending at B, %s: one held post with the attach line, on the get\'s launch start; the answer carries the post', async (_label, placement) => {
    const rig = ruleRig({ runFindMissing: async () => placement }, atB)
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_POSTED })
    expect(rig.calls).toEqual(['read-pane', 'find-missing', 'get', 'post'])
    expect(rig.posts).toEqual([[RULE_KEY, RULE_START, false]])
    expect(rig.lines).toHaveLength(1)
  })

  test('a launch that met ErrSpawnNotInteractive: no lap, and the held post without the attach line', async () => {
    const rig = ruleRig({ launchMetNotInteractive: () => true }, atB)
    await rig.rule.run(ruleInput())
    expect(rig.calls).toEqual(['find-missing', 'get', 'post'])
    expect(rig.posts).toEqual([[RULE_KEY, RULE_START, true]])
  })

  test('the lap\'s own Enter meeting ErrSpawnNotInteractive in this round: the held post drops the attach line', async () => {
    const rig = ruleRig(
      {
        readLapPane: async () => ({ kind: PANE_READ_PANE, pane: pendingRowDialogPane(PENDING_ROW_DIALOG_TRUST) }),
        sendLapEnter: async () => enterFailure(errSpawnNotInteractive('send-keys')),
      },
      atB,
    )
    await rig.rule.run(ruleInput())
    expect(rig.posts).toEqual([[RULE_KEY, RULE_START, true]])
  })

  test.each<[string, () => boolean]>([
    ['raised', () => true],
    ['a query that throws: taken as raised', () => { throw new Error('outage query failed') }],
  ])('tmux-unavailable %s: a refusal, no post', async (_label, isTmuxUnavailableRaised) => {
    const rig = ruleRig({ isTmuxUnavailableRaised }, atB)
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('tmux-unavailable'))
    expect(rig.posts).toEqual([])
  })

  test('the row read at the call is at B but the get reads a new launch younger than B: nothing more, never step 3 on the earlier read', async () => {
    const nowMs = parseLaunchStart(RULE_START)! + adLaunchBoundMsInEffect()
    const newStart = launchStartText(nowMs - adGraceMsInEffect())
    const rig = ruleRig({ readRow: async () => ({ kind: PENDING_ROW_GET_ROW, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: newStart }) }, atB)
    expect(await rig.rule.run(ruleInput())).toEqual(refusalOf('not-judged'))
    expect(rig.posts).toEqual([])
  })

  test('the row read at the call is not yet at B but the get reads an older launch start past B: step 3 on the get\'s read', async () => {
    const nowMs = parseLaunchStart(RULE_START)! + adGraceMsInEffect()
    const olderStart = launchStartText(nowMs - adLaunchBoundMsInEffect())
    const rig = ruleRig({ readRow: async () => ({ kind: PENDING_ROW_GET_ROW, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: olderStart }) })
    await rig.rule.run(ruleInput())
    expect(rig.posts).toEqual([[RULE_KEY, olderStart, false]])
  })

  /** Own-launch hooks recording their relaunch calls; `own` and `abort` are what they answer. */
  function ownLaunchHooks(own: () => boolean, abort: boolean, relaunched: unknown[]): PendingRowOwnLaunchHooks {
    return {
      isOwnLaunch: own,
      isAbortAvailable: () => abort,
      relaunch: async (key, ref, launchStart) => {
        relaunched.push([key, ref, launchStart])
        return { kind: PENDING_ROW_RELAUNCH_KEPT, why: 'the case keeps it' }
      },
    }
  }

  /**
   * Overrides that latch P at step 3 itself: P is not latched until step 3
   * asks its tmux-unavailable query (not raised), so the latched query step 3
   * asks next is the first to answer latched.
   */
  function latchedAtStepThree(): Partial<PendingRowRuleDeps> {
    let latched = false
    return {
      isLatched: () => latched,
      isTmuxUnavailableRaised: () => {
        latched = true
        return false
      },
    }
  }

  // SRJ-412: the "earlier abort" line is logged exactly when CSCB's own
  // launch, its episode's abort used, gets the held text, just before the
  // held round line; never when step 3 answers anything else. SRJ-1017: the
  // skipped-post line is logged exactly when step 3 answers config-malformed
  // (CSCB's own launch only), just before that round line.
  test.each<[string, () => boolean, boolean, Partial<PendingRowRuleDeps>, RuleRigOptions, 'relaunch' | 'held' | 'latched' | PendingRowRuleRefusalReason, boolean]>([
    ['the own-launch slot answering own with its abort available: the slot\'s branch, no held post', () => true, true, {}, {}, 'relaunch', false],
    ['own, its abort available, ad-config-malformed raised: neither text, no abort', () => true, true, { isConfigMalformedRaised: () => true }, {}, 'config-malformed', false],
    ['own, its abort spent, ad-config-malformed raised: neither text, no earlier-abort line', () => true, false, { isConfigMalformedRaised: () => true }, {}, 'config-malformed', false],
    ['not own, ad-config-malformed raised: still the held post, no skipped-post line', () => false, false, { isConfigMalformedRaised: () => true }, {}, 'held', false],
    ['own, its abort spent: the held post, after the earlier-abort line', () => true, false, {}, {}, 'held', true],
    ['an own-launch query that throws: not own, the held post, no earlier-abort line', () => { throw new Error('record failed') }, true, {}, {}, 'held', false],
    ['own while tmux-unavailable is raised: nothing', () => true, true, { isTmuxUnavailableRaised: () => true }, {}, 'tmux-unavailable', false],
    ['own, its abort spent, tmux-unavailable raised: nothing, no earlier-abort line', () => true, false, { isTmuxUnavailableRaised: () => true }, {}, 'tmux-unavailable', false],
    ['own, its abort spent, latched at step 3: nothing, no earlier-abort line', () => true, false, latchedAtStepThree(), {}, 'latched', false],
  ])('%s', async (_label, own, abort, overrides, options, expected, earlierAbortLine) => {
    const relaunched: unknown[] = []
    const rig = ruleRig({ ownLaunch: ownLaunchHooks(own, abort, relaunched), ...overrides }, { ...atB, ...options })
    const answer = await rig.rule.run(ruleInput())
    switch (expected) {
      case 'relaunch':
        expect(answer).toEqual({ kind: PENDING_ROW_RULE_RELAUNCH, answer: { kind: PENDING_ROW_RELAUNCH_KEPT, why: 'the case keeps it' } })
        expect([relaunched, rig.posts]).toEqual([[[RULE_KEY, RULE_REF, RULE_START]], []])
        break
      case 'held':
        expect(answer.kind).toBe(PENDING_ROW_RULE_HELD)
        expect([relaunched, rig.posts]).toEqual([[], [[RULE_KEY, RULE_START, false]]])
        break
      case 'latched':
        expect(answer.kind).toBe(PENDING_ROW_RULE_LATCHED)
        expect([relaunched, rig.posts]).toEqual([[], []])
        break
      default:
        expect(answer).toEqual(refusalOf(expected))
        expect([relaunched, rig.posts]).toEqual([[], []])
    }
    const earlier = stuckLaunchAbortSkippedLine(RULE_KEY, STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT)
    if (earlierAbortLine) {
      expect(rig.lines.slice(-2)).toEqual([earlier, rig.lines.at(-1)!])
      expect(rig.lines.at(-1)!.startsWith(roundLineStart(RULE_REF, PENDING_ROW_RULE_ORIGIN_RETRY, RULE_START))).toBe(true)
      expect(rig.lines.filter((line) => line === earlier)).toHaveLength(1)
    } else {
      expect(rig.lines).not.toContain(earlier)
    }
    const skippedLines = [STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED, STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED].map((why) => stuckLaunchPostSkippedLine(RULE_KEY, why))
    if (expected === PENDING_ROW_STEP3_CONFIG_MALFORMED) {
      const skipped = stuckLaunchPostSkippedLine(RULE_KEY, abort ? STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED : STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED)
      expect(rig.lines.filter((line) => skippedLines.includes(line))).toEqual([skipped])
      expect(rig.lines.at(-2)).toBe(skipped)
    } else {
      expect(rig.lines.filter((line) => skippedLines.includes(line))).toEqual([])
    }
  })

  // AC 84; SRJ-316, SRJ-410 step 3, SRJ-412: on the harness every successful
  // call clears ad-config-malformed before step 3, so the gate is pinned here
  // over the real abort with its outage held raised across rounds.
  test('CSCB\'s own launch at B over the real abort while ad-config-malformed stays raised: no relaunching or held post, no stop or kill, the abort not used, at every round; once it clears, the relaunching post and the one abort', async () => {
    const abort = abortRig()
    abort.flags.configMalformed = true
    const rig = ruleRig({ ownLaunch: abort.abort, isConfigMalformedRaised: () => abort.flags.configMalformed }, atB)

    for (const origin of [PENDING_ROW_RULE_ORIGIN_APPROVER_STOP, PENDING_ROW_RULE_ORIGIN_RETRY, PENDING_ROW_RULE_ORIGIN_RETRY] as const) {
      expect(await rig.rule.run(ruleInput({ origin }))).toEqual(refusalOf(PENDING_ROW_STEP3_CONFIG_MALFORMED))
    }
    expect([abort.calls, abort.posters.posts, rig.posts, abort.abort.isAbortUsed(P)]).toEqual([[], [], [], false])
    expect(abort.posters.episodes.isOpen(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)).toBe(false)

    abort.flags.configMalformed = false
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_RELAUNCH, answer: { kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED } })
    expect(abort.calls).toEqual(['stop', 'kill', 'sequence'])
    expect(abort.posters.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
    expect(rig.posts).toEqual([])
    expect(abort.abort.isAbortUsed(P)).toBe(true)
  })

  // SRJ-1017 over SRJ-412: CSCB's own launch whose one abort is used gets
  // neither text while ad-config-malformed is raised; once it clears, the held
  // text through the real poster, once in the episode.
  test('CSCB\'s own launch whose abort is used, still pending at B while ad-config-malformed is raised: no post and the abort-used skipped-post line at every round; once it clears, the held text once', async () => {
    const abort = abortRig()
    const rig = ruleRig(
      {
        ownLaunch: abort.abort,
        isConfigMalformedRaised: () => abort.flags.configMalformed,
        postHeld: (key, launchStart, metNotInteractive) => postStuckLaunchHeld(abort.posters.deps, key, launchStart, metNotInteractive),
      },
      atB,
    )
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_RELAUNCH, answer: { kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED } })
    expect(abort.abort.isAbortUsed(P)).toBe(true)
    const callsAfterAbort = [...abort.calls]

    abort.flags.configMalformed = true
    const skipped = stuckLaunchPostSkippedLine(RULE_KEY, STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED)
    const earlier = stuckLaunchAbortSkippedLine(RULE_KEY, STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT)
    const origins = [PENDING_ROW_RULE_ORIGIN_APPROVER_STOP, PENDING_ROW_RULE_ORIGIN_RETRY] as const
    for (const origin of origins) {
      const before = rig.lines.length
      expect(await rig.rule.run(ruleInput({ origin }))).toEqual(refusalOf(PENDING_ROW_STEP3_CONFIG_MALFORMED))
      expect(rig.lines.slice(before)).toHaveLength(2)
      expect(rig.lines[before]).toBe(skipped)
    }
    expect(rig.lines).not.toContain(earlier)
    expect([abort.calls, abort.posters.posts]).toEqual([callsAfterAbort, [{ key: P, text: RELAUNCHING.text(P) }]])

    abort.flags.configMalformed = false
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_POSTED })
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_ALREADY_POSTED })
    expect(abort.posters.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: stuckLaunchHeldText(P, RULE_START, false) },
    ])
    expect(rig.lines.filter((line) => line === skipped)).toHaveLength(origins.length)
    expect(abort.calls).toEqual(callsAfterAbort)
  })
})

describe('the pending-row rule never rejects: a dependency that throws ends the round with one line (b.jg5 SRJ-410)', () => {
  test.each<[string, Partial<PendingRowRuleDeps>]>([
    ['the lap\'s read-pane', { readLapPane: async () => { throw new Error(`pane reader failed (${sentinelInMessage('rule pane')})`) } }],
    ['the run', { runFindMissing: async () => { throw new Error(`run failed (${sentinelInMessage('rule run')})`) } }],
    ['the held post', { postHeld: () => { throw new Error(`poster failed (${sentinelInMessage('rule post')})`) } }],
  ])('%s throwing: a refusal (failed) and its failed line, redacted', async (_label, overrides) => {
    const rig = ruleRig(overrides, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput({ origin: PENDING_ROW_RULE_ORIGIN_APPROVER_STOP }))).toEqual(refusalOf('failed'))
    const failed = rig.lines.at(-1)!
    expect(failed.startsWith(pendingRowRuleFailedLine(RULE_REF, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP, '').split(': failed:')[0]!)).toBe(true)
    assertNoLeak(rig.lines)
  })

  test('a log that throws changes nothing: the round still answers and posts', async () => {
    const rig = ruleRig({ log: () => { throw new Error('log failed') } }, { sinceStartMs: adLaunchBoundMsInEffect() })
    expect(await rig.rule.run(ruleInput())).toEqual({ kind: PENDING_ROW_RULE_HELD, post: STUCK_LAUNCH_POSTED })
  })
})

// ---------------------------------------------------------------------------
// The abort of CSCB's own stuck launch over injected dependencies (b.jg5 SRJ-412)
// ---------------------------------------------------------------------------

/** A step of the abort that reaches its dependencies: the approver's stop, the kill, the sequence's start. */
type AbortCall = 'stop' | 'kill' | 'sequence'

/** A rig over the abort's injected dependencies: a real episodes instance (the posters' rig), the outages and the latch the case sets, scripted kill answers. */
interface AbortRig {
  readonly abort: ReturnType<typeof createStuckLaunchAbort>
  /** The posters' rig: its episodes, its posts and its lines (the abort logs to the same lines). */
  readonly posters: PosterRig
  readonly calls: AbortCall[]
  /** P latched, and P's `ad-config-malformed` outage raised (the posters' rig holds `tmux-unavailable`). */
  readonly flags: { latched: boolean; configMalformed: boolean }
}

/** A kill answer of `kind` (`try-later` as UNAVAILABLE), with a fixed description. */
function abortKillAnswer(kind: StuckLaunchAbortKillAnswer['kind'], killSent?: boolean): StuckLaunchAbortKillAnswer {
  const description = `the case's ${kind} outcome`
  if (kind === STUCK_LAUNCH_ABORT_KILL_TRY_LATER) return { kind, errorClass: AD_ERROR_CLASS_UNAVAILABLE, description }
  if (kind === STUCK_LAUNCH_ABORT_KILL_SUCCEEDED && killSent !== undefined) return { kind, killSent, description }
  return { kind, description } as StuckLaunchAbortKillAnswer
}

/**
 * The abort for {@link P} over fake dependencies: P's launch own, not
 * latched, no outage; the relaunching text's real poster over the posters'
 * rig (B in effect); the approver's stop recorded; each kill answering the
 * next of `kills` (then success with `kill_sent` true); the sequence started.
 * `overrides` replace any of them.
 */
function abortRig(kills: StuckLaunchAbortKillAnswer[] = [], overrides: Partial<StuckLaunchAbortDeps> = {}): AbortRig {
  const posters = posterRig()
  const calls: AbortCall[] = []
  const flags = { latched: false, configMalformed: false }
  const deps: StuckLaunchAbortDeps = {
    log: posters.deps.log,
    isOwnLaunch: () => true,
    isLatched: () => flags.latched,
    isTmuxUnavailableRaised: (key) => posters.raised.has(key),
    isConfigMalformedRaised: () => flags.configMalformed,
    postRelaunching: (key) => postStuckLaunchRelaunching(posters.deps, key, adLaunchBoundMsInEffect()),
    episodes: posters.episodes,
    stopApprover: async () => {
      calls.push('stop')
    },
    abortKill: async () => {
      calls.push('kill')
      return kills.shift() ?? abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, true)
    },
    startSequence: (): StuckLaunchAbortSequenceStart => {
      calls.push('sequence')
      return { kind: STUCK_LAUNCH_ABORT_SEQUENCE_STARTED }
    },
    ...overrides,
  }
  return { abort: createStuckLaunchAbort(deps), posters, calls, flags }
}

/** The abort's relaunch of P on {@link RULE_START}. */
const relaunchOf = (rig: AbortRig) => rig.abort.relaunch(P, RULE_REF, RULE_START)

/** A kept answer with `why`. */
const keptFor = (why: string): PendingRowRelaunchAnswer => ({ kind: PENDING_ROW_RELAUNCH_KEPT, why })

/** The fixed start of the abort's kill line for `answer` (everything before what follows). */
const abortKillLineStart = (answer: StuckLaunchAbortKillAnswer, key = P): string => stuckLaunchAbortKillLine(key, answer, '').split(' — ')[0]!

describe('createStuckLaunchAbort: the relaunching post, the approver stopped, one checked kill, then the sequence from step 2; one abort per stuck-launch episode (b.jg5 SRJ-412, SRJ-1017; AC 9, AC 67)', () => {
  test('a success with kill_sent true: the relaunching post, then the approver\'s stop, the kill and the sequence\'s start, in order; "sequence started"; the abort used; one line per step', async () => {
    const rig = abortRig()
    const killed = abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, true)

    expect(await relaunchOf(rig)).toEqual({ kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED })

    expect(rig.calls).toEqual(['stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
    expect(rig.abort.isAbortUsed(P)).toBe(true)
    const [post, started, kill, sequence, ...rest] = rig.posters.lines
    expect([post, started, sequence, rest]).toEqual([
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_POSTED),
      stuckLaunchAbortStartedLine(P, RULE_REF, RULE_START),
      stuckLaunchAbortSequenceLine(P, { kind: STUCK_LAUNCH_ABORT_SEQUENCE_STARTED }),
      [],
    ])
    expect(started).toContain(describeLaunchStartForLog(RULE_START))
    expect(kill!.startsWith(abortKillLineStart(killed))).toBe(true)
  })

  test.each<[string, StuckLaunchAbortKillAnswer, StuckLaunchAbortSequenceStart | undefined, unknown, boolean]>([
    ['a success with kill_sent false: the sequence', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, false), undefined, { kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED }, true],
    ['a success whose sequence did not start: kept, the abort used', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, true), { kind: STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED, why: 'held' }, { kind: PENDING_ROW_RELAUNCH_KEPT, why: expect.stringContaining('(held)') }, true],
    ['ErrTmuxKillFailed after its tries: kept, the abort used, no sequence', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_FAILED), undefined, keptFor(STUCK_LAUNCH_ABORT_KEPT_KILL_FAILED), true],
    ['a latch (CONFLICT, UNUSABLE NAME): latched, the abort used, no sequence', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_LATCHED), undefined, { kind: PENDING_ROW_RELAUNCH_LATCHED }, true],
    ['a kill that did nothing (Q-12): kept, the abort not used, no sequence', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_TRY_LATER), undefined, keptFor(STUCK_LAUNCH_ABORT_KEPT_TRY_LATER), false],
    ['tries SRJ-702\'s stop rule stopped: kept, the abort not used, no sequence', abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_STOPPED), undefined, keptFor(STUCK_LAUNCH_ABORT_KEPT_STOPPED), false],
  ])('the kill answering %s', async (_label, killed, sequence, answer, used) => {
    const rig = abortRig([killed], sequence === undefined ? {} : { startSequence: () => (rig.calls.push('sequence'), sequence) })

    expect(await relaunchOf(rig)).toEqual(answer as Awaited<ReturnType<typeof relaunchOf>>)

    expect(stuckLaunchAbortKillUsesAbort(killed)).toBe(used)
    expect(rig.abort.isAbortUsed(P)).toBe(used)
    expect(rig.calls).toEqual(killed.kind === STUCK_LAUNCH_ABORT_KILL_SUCCEEDED ? ['stop', 'kill', 'sequence'] : ['stop', 'kill'])
    expect(rig.posters.lines.filter((line) => line.startsWith(abortKillLineStart(killed)))).toHaveLength(1)
  })

  test('a kill that did nothing, then the next call: the same abort, with no second relaunching post (Q-12); a success then uses it', async () => {
    const rig = abortRig([abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_TRY_LATER), abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_STOPPED)])

    expect(await relaunchOf(rig)).toEqual(keptFor(STUCK_LAUNCH_ABORT_KEPT_TRY_LATER))
    expect(await relaunchOf(rig)).toEqual(keptFor(STUCK_LAUNCH_ABORT_KEPT_STOPPED))
    expect(rig.abort.isAbortAvailable(P)).toBe(true)
    expect(await relaunchOf(rig)).toEqual({ kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED })

    expect(rig.calls).toEqual(['stop', 'kill', 'stop', 'kill', 'stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
    expect(rig.posters.lines.filter((line) => line === posterLine(P, RELAUNCHING, STUCK_LAUNCH_ALREADY_POSTED))).toHaveLength(2)
  })

  test('once the abort is used: the abort is not available (a pure query: no line), and a further relaunch makes no kill, with its one line; Q\'s abort is its own', async () => {
    const rig = abortRig()
    expect(rig.abort.isAbortAvailable(P)).toBe(true)
    expect(rig.posters.lines).toEqual([])
    await relaunchOf(rig)
    const lines = rig.posters.lines.length

    expect(rig.abort.isAbortAvailable(P)).toBe(false)
    expect(rig.abort.isAbortAvailable(P)).toBe(false)
    expect(rig.posters.lines.slice(lines)).toEqual([])
    expect(await relaunchOf(rig)).toEqual(keptFor(STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT))
    expect(rig.posters.lines.slice(lines)).toEqual([
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_ALREADY_POSTED),
      stuckLaunchAbortSkippedLine(P, STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT),
    ])
    expect([rig.abort.isAbortAvailable(Q), rig.abort.isAbortUsed(Q)]).toEqual([true, false])

    expect(rig.calls).toEqual(['stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
  })

  test.each<[string, (rig: AbortRig) => void]>([
    ['a read of the row live out of pending', (rig) => void endStuckLaunchEpisode(rig.posters.episodes, P, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING), rig.posters.deps.log)],
    ['P\'s teardown (the episodes forget P)', (rig) => rig.posters.episodes.forget(P)],
  ])('the episode\'s end at %s disposes of its abort state: a new episode posts the relaunching text and aborts again', async (_label, end) => {
    const rig = abortRig()
    await relaunchOf(rig)
    end(rig)

    expect([rig.abort.isAbortUsed(P), rig.abort.isAbortAvailable(P)]).toEqual([false, true])
    expect(await relaunchOf(rig)).toEqual({ kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED })
    expect(rig.calls).toEqual(['stop', 'kill', 'sequence', 'stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: RELAUNCHING.text(P) },
    ])
  })

  test.each<[string, (rig: AbortRig) => void, Partial<StuckLaunchAbortDeps>, string]>([
    ['P\'s tmux-unavailable outage raised (suppressed)', (rig) => void rig.posters.raised.add(P), {}, STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE],
    ['the episodes closed (shutdown)', (rig) => rig.posters.episodes.close(), {}, STUCK_LAUNCH_ABORT_SKIP_SHUTDOWN],
    ['an episodes call that threw (failed)', () => {}, { postRelaunching: () => STUCK_LAUNCH_POST_FAILED }, STUCK_LAUNCH_ABORT_SKIP_POST_FAILED],
    ['a post with no stuck-launch episode open to hold the abort', () => {}, { postRelaunching: () => STUCK_LAUNCH_POSTED }, STUCK_LAUNCH_ABORT_SKIP_NO_EPISODE],
  ])('no abort without the relaunching post: %s: kept with its one line; no stop, kill or sequence; the abort not used', async (_label, arrange, overrides, why) => {
    const rig = abortRig([], overrides)
    arrange(rig)

    expect(await relaunchOf(rig)).toEqual(keptFor(why))

    expect(rig.calls).toEqual([])
    expect(rig.posters.posts).toEqual([])
    expect(rig.posters.lines.at(-1)).toBe(stuckLaunchAbortSkippedLine(P, why))
    expect(rig.abort.isAbortUsed(P)).toBe(false)
  })

  test('an abort of P in progress: a second call makes no post, stop or kill, with its line; the first then ends as before', async () => {
    let release!: (answer: StuckLaunchAbortKillAnswer) => void
    let entered!: () => void
    const killEntered = new Promise<void>((resolve) => (entered = resolve))
    const rig = abortRig([], {
      abortKill: () => {
        rig.calls.push('kill')
        entered()
        return new Promise((resolve) => (release = resolve))
      },
    })
    const first = relaunchOf(rig)
    await killEntered
    expect(rig.calls).toEqual(['stop', 'kill'])

    expect(await relaunchOf(rig)).toEqual(keptFor(STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS))
    expect(rig.posters.lines.at(-1)).toBe(stuckLaunchAbortSkippedLine(P, STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS))
    release(abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, true))

    expect(await first).toEqual({ kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED })
    expect(rig.calls).toEqual(['stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toHaveLength(1)
  })

  const throwing = (): never => {
    throw new Error('query failed')
  }

  test.each<[string, (rig: AbortRig) => void, Partial<StuckLaunchAbortDeps>, unknown]>([
    ['P latched while its approver stopped (SRJ-502)', (rig) => void (rig.flags.latched = true), {}, { kind: PENDING_ROW_RELAUNCH_LATCHED }],
    ['a latched query that throws: taken as latched', () => {}, { isLatched: throwing }, { kind: PENDING_ROW_RELAUNCH_LATCHED }],
    ['tmux-unavailable raised while its approver stopped', (rig) => void rig.posters.raised.add(P), {}, keptFor(STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE)],
    ['a tmux-unavailable query that throws: taken as raised', () => {}, { isTmuxUnavailableRaised: throwing }, keptFor(STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE)],
    ['ad-config-malformed raised while its approver stopped (SRJ-316: no kill of a row read pending)', (rig) => void (rig.flags.configMalformed = true), {}, keptFor(STUCK_LAUNCH_ABORT_SKIP_CONFIG_MALFORMED)],
    ['an ad-config-malformed query that throws: taken as raised', () => {}, { isConfigMalformedRaised: throwing }, keptFor(STUCK_LAUNCH_ABORT_SKIP_CONFIG_MALFORMED)],
  ])('asked again after the approver\'s stop: %s: no kill, the abort not used', async (_label, onStop, overrides, answer) => {
    const rig = abortRig([], {
      stopApprover: async () => {
        rig.calls.push('stop')
        onStop(rig)
      },
      ...overrides,
    })

    expect(await relaunchOf(rig)).toEqual(answer as Awaited<ReturnType<typeof relaunchOf>>)

    expect(rig.calls).toEqual(['stop'])
    expect(rig.posters.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
    expect(rig.abort.isAbortUsed(P)).toBe(false)
  })

  test.each<[string, AbortCall]>([
    ['the approver\'s stop', 'stop'],
    ['the kill', 'kill'],
  ])('%s rejecting: never rejects; kept with its redacted line; the abort not used, and the next call aborts', async (_label, failing) => {
    let failed = false
    const failOnce = (): void => {
      if (failed) return
      failed = true
      throw new Error(`${failing} failed (${sentinelInMessage(`abort ${failing}`)})`)
    }
    const rig = abortRig([], {
      stopApprover: async () => {
        rig.calls.push('stop')
        if (failing === 'stop') failOnce()
      },
      abortKill: async () => {
        rig.calls.push('kill')
        if (failing === 'kill') failOnce()
        return abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, true)
      },
    })

    const answer = await relaunchOf(rig)
    expect(answer).toEqual({ kind: PENDING_ROW_RELAUNCH_KEPT, why: expect.stringContaining('the abort failed: ') })
    expect(rig.posters.lines.at(-1)).toBe(stuckLaunchAbortSkippedLine(P, (answer as { why: string }).why))
    expect(rig.abort.isAbortUsed(P)).toBe(false)
    assertNoLeak(rig.posters.lines)

    expect(await relaunchOf(rig)).toEqual({ kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED })
    expect(rig.calls.slice(-3)).toEqual(['stop', 'kill', 'sequence'])
    expect(rig.posters.posts).toHaveLength(1)
  })

  test('the own-launch query: passed P\'s key and the launch start as read now; a throw is not own', () => {
    const asked: unknown[] = []
    const own = abortRig([], { isOwnLaunch: (key, start) => (asked.push([key, start]), true) }).abort
    expect(own.isOwnLaunch(P, RULE_START)).toBe(true)
    expect(asked).toEqual([[P, RULE_START]])
    expect(abortRig([], { isOwnLaunch: throwing }).abort.isOwnLaunch(P, RULE_START)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The pending-row rule on the recovery harness (b.jg5 SRJ-410; AC 30, AC 32, AC 33, AC 84)
// ---------------------------------------------------------------------------

/** The harness of the rule's harness cases; `afterEach` leak-checks and cleans it up. */
let ruleHarness: RecoveryHarness | undefined

/** A rule harness (both settings 0, the rule installed as `main()` installs it), with `options`. */
function ruleHarnessOf(options: RecoveryHarnessOptions = {}): { h: RecoveryHarness; p: string } {
  const h = (ruleHarness = makeRecoveryHarness(options))
  expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
  // Every run must make a new find-missing call however long the memo window (SRJ-120: bypassing).
  _setFindMissingMemoTtlMs(Number.MAX_SAFE_INTEGER)
  return { h, p: h.keys[0]! }
}

/** Replace the model's knob `name` with `wrap` over it (the model's own answer stays reachable). */
function wrapModelKnob<K extends 'spawnFn' | 'resumeFn' | 'getFn' | 'readPaneFn' | 'findMissingFn' | 'killFn'>(
  h: RecoveryHarness,
  name: K,
  wrap: (model: NonNullable<StubClientOptions[K]>) => NonNullable<StubClientOptions[K]>,
): void {
  const model = (h.stub.calls as StubClientOptions)[name]
  if (model === undefined) throw new Error(`wrapModelKnob: the model installed no ${name}`)
  h.script({ [name]: wrap(model as NonNullable<StubClientOptions[K]>) } as Partial<StubClientOptions>)
}

/** Whether a stub call's params ask the lap's read: the rule's `read-pane` (40 lines, `allow_pending`). */
const isLapRead = (params: unknown): boolean => (params as { allow_pending?: unknown }).allow_pending === true

/** One origin of a covered `pending` row for AC 30: how P's row comes to read `pending` with P's timer armed pending-only. */
interface RuleOrigin {
  readonly name: string
  /** Bring P's row about over `model` (P's own options merged in) and settle; answers the row. */
  begin(h: RecoveryHarness, p: string, model: PendingRowModelOptions): Promise<PendingRowModel>
}

/** P's row found `pending` at the start pass: its launch start now, the start pass's spawn colliding with it. */
const ORIGIN_START_PASS: RuleOrigin = {
  name: 'a row found pending at the start pass',
  async begin(h, p, model) {
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(h.clock.now()), launches: [errInstanceIdCollision()], ...model })
    await h.launch(p)
    await h.settle()
    return row
  },
}

/** A launch call that fails having left P's row `pending` (b.jg5 SRJ-713; HO rev 28): which call of P's own id, and its answer. */
interface FailedLaunch {
  /** A plain spawn, a reuse spawn (`reuse_finished`) or a `resume`. */
  readonly call: 'plain spawn' | 'reuse spawn' | 'resume'
  readonly error: () => Error
}

/** P's next `launch.call` leaves `row` `pending`, its launch start the clock's now, and answers `launch.error()`; every other call is the model's. */
function failNextLaunch(h: RecoveryHarness, row: PendingRowModel, launch: FailedLaunch): void {
  let used = false
  const fail = (): Error => {
    used = true
    row.setState(AGENT_DIRECTOR_PENDING_STATE)
    row.setLaunchStartedAt(launchStartText(h.clock.now()))
    return launch.error()
  }
  if (launch.call === 'resume') {
    wrapModelKnob(h, 'resumeFn', (modelResume) => (params) => (used || params.claude_instance_id !== row.instanceId ? modelResume(params) : fail()))
    return
  }
  const reuse = launch.call === 'reuse spawn'
  wrapModelKnob(h, 'spawnFn', (modelSpawn) => (params) => (used || params.claude_instance_id !== row.instanceId || 'reuse_finished' in params !== reuse ? modelSpawn(params) : fail()))
}

/** A failed fresh spawn: no row, then the spawn leaves the row `pending` and answers `ErrTmuxSessionCreate` (`launchError`, for the outage case). */
function failedSpawnOrigin(launchError: () => Error = () => errTmuxSessionCreateStaysPending('spawn')): RuleOrigin {
  return {
    name: 'a failed fresh spawn',
    async begin(h, p, model) {
      const row = makePendingRowModel(h, p, { ...model, state: PENDING_ROW_MODEL_NO_ROW })
      failNextLaunch(h, row, { call: 'plain spawn', error: launchError })
      await h.launch(p)
      await h.settle()
      return row
    },
  }
}

/** A server restart mid-launch: the launch succeeds (its approver runs), the server restarts, and the start pass collides with the `pending` row. */
const ORIGIN_SERVER_RESTART: RuleOrigin = {
  name: 'a server restart mid-launch',
  async begin(h, p, model) {
    const row = makePendingRowModel(h, p, { ...model, state: PENDING_ROW_MODEL_NO_ROW })
    await h.launch(p)
    await h.settle()
    expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
    await h.restartServer(p)
    row.scriptLaunches(errInstanceIdCollision())
    await h.launch(p)
    await h.settle()
    return row
  },
}

const RULE_ORIGINS: ReadonlyArray<readonly [string, RuleOrigin]> = [ORIGIN_START_PASS, failedSpawnOrigin(), ORIGIN_SERVER_RESTART].map((origin) => [origin.name, origin] as const)

/** One retry of P's timer as a case saw it: when, after which wait, and what P's row was asked. */
interface RuleRound {
  readonly at: number
  readonly waitMs: number
  readonly verbs: PendingRowModelVerb[]
  /** Refusals in a row once it settled (undefined once the timer stopped). */
  readonly refusals: number | undefined
  /** P's held posts so far. */
  readonly posts: number
  /** The retry's number on P's timer (`h.attempts`). */
  readonly retry: number
  /** The retry timer's last line for P after the round (its re-armed or stopped line). */
  readonly retryLine: string | undefined
}

/** Every post to P's destination in `h`, in order: the session manager's, the outage state's, the episodes' and the lost-message driver's. */
const noticesOf = (h: RecoveryHarness, p: string): string[] =>
  [...h.notices, ...h.outageNotices, ...h.episodeNotices, ...h.lostMessageNotices].filter((notice) => notice.key === p).map((notice) => notice.text)

/** The times of P's `read-pane` calls in `h` at or after `fromMs` (the rule's laps, once P's approver has stopped). */
const readPaneTimesOf = (h: RecoveryHarness, row: PendingRowModel, fromMs = 0): number[] =>
  h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId && call.at >= fromMs).map((call) => call.at)

/** P's stuck-launch held posts in `h`. */
const heldPostsOf = (h: RecoveryHarness, p: string): string[] =>
  h.episodeNotices.filter((notice) => notice.key === p && notice.text.startsWith(STUCK_LAUNCH_HELD_HEAD)).map((notice) => notice.text)

/** The number of P's last retry in `h`. */
const lastRetryOf = (h: RecoveryHarness, p: string): number => h.attempts.filter((attempt) => attempt.key === p).at(-1)!.retry

/** The retry timer's re-armed line for a pending-only retry `retry` of P that its rule kept on the pending row (`reason`), after `refusals` refusals. */
const pendingOnlyReArmedLine = (p: string, retry: number, refusals: number, reason: string = UNAVAILABLE_RETRY_AGAIN_ROW_PENDING): string =>
  reArmedLine(p, retry, reason, refusals, { ranPendingOnly: true })

/** Run `count` retries of P's timer, each settled, recording each round. */
async function runRounds(h: RecoveryHarness, p: string, row: PendingRowModel, count: number): Promise<RuleRound[]> {
  const rounds: RuleRound[] = []
  for (let i = 0; i < count; i++) {
    const waitMs = h.controller.view(p)!.waitMs!
    const before = row.calls.length
    const at = await retryNow(h, p)
    rounds.push({
      at,
      waitMs,
      verbs: row.calls.slice(before).map((call) => call.verb),
      refusals: h.controller.view(p)?.refusals,
      posts: heldPostsOf(h, p).length,
      retry: lastRetryOf(h, p),
      retryLine: retryLinesOf(h, p).at(-1),
    })
  }
  return rounds
}

/** The waits of P's timer from its arm: the base, doubling, up to the ceiling (`src/unavailable-retry.ts`). */
const timerWaits = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.min(UNAVAILABLE_RETRY_BASE_S * 2 ** i, UNAVAILABLE_RETRY_CEILING_S) * MS_PER_SECOND)

/** The verbs of a retry that reads P's `pending` row and stops there (a refusal): its `status`, then the read-and-step `get`. */
const READ_ONLY_ROUND: PendingRowModelVerb[] = ['status', 'get']
/** The verbs of a retry whose rule round laps an empty pane, runs and reads: no keystroke. */
const LAP_RUN_ROUND: PendingRowModelVerb[] = ['status', 'get', 'read-pane', 'find-missing', 'get']
/** The model's verbs of such a round whose lap read-pane a case answered itself (an error, never reaching the model). */
const FAILED_LAP_RUN_ROUND: PendingRowModelVerb[] = ['status', 'get', 'find-missing', 'get']

/** P's rule round lines (`[slack] pending-row: <ref> rule (<origin>)`) in `h.errors`. */
function ruleLinesOf(h: RecoveryHarness, p: string, origin: PendingRowInputOrigin = PENDING_ROW_RULE_ORIGIN_RETRY): string[] {
  const ref = renderPersonaRef(personaOf(h, p).name, p)
  const head = `${PENDING_ROW_RULE_LOG_HEAD} ${ref} rule (${origin})`
  return h.errors.filter((line) => line.startsWith(head))
}

/** A rule input's origin. */
type PendingRowInputOrigin = PendingRowRuleInput['origin']

/** The rule's next lap read-pane (P's approver not running) answers `make()`; every other read-pane is the model's. */
function failNextLapRead(h: RecoveryHarness, p: string, make: () => Error): void {
  let armed = true
  wrapModelKnob(h, 'readPaneFn', (modelReadPane) => (params) => {
    if (!armed || !isLapRead(params) || h.approverRunning(p)) return modelReadPane(params)
    armed = false
    return make()
  })
}

/** The launch-path verbs that must never reach a `pending` row: no kill and no launch over it. */
const KILL_OR_LAUNCH: readonly PendingRowModelVerb[] = ['kill', 'spawn', 'resume']

/** A lap-column answer's own effect: P's `tmux-unavailable` raised. */
const LAP_COLUMN_TMUX_UNAVAILABLE = 'tmux-unavailable'
/** A lap-column answer's own effect: P's CONFIG cause armed. */
const LAP_COLUMN_CONFIG_CAUSE = 'config-cause'
/** A lap-column answer's own effect, if any. */
type LapColumnEffect = typeof LAP_COLUMN_TMUX_UNAVAILABLE | typeof LAP_COLUMN_CONFIG_CAUSE | undefined

/** `afterEach` of the rule's harness cases: the seams reset, the case's harness leak-checked and cleaned up. */
function cleanUpRuleHarness(): void {
  const h = ruleHarness
  ruleHarness = undefined
  _resetConfigDirFs()
  _resetFindMissingMemo()
  if (h === undefined) return
  try {
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

describe('the pending-row rule on the recovery harness (b.jg5 SRJ-410; AC 30, AC 32, AC 33, AC 84)', () => {
  afterEach(cleanUpRuleHarness)

  // AC 30, SRJ-410, SRJ-405, SRJ-1010.
  test.each(RULE_ORIGINS)('AC 30, %s: nothing before G; from G a lap and a bypassing run, then the get, on the timer; nothing more before B; waits doubling to the ceiling; one held post at B naming the session; no kill or launch while pending; the post is the persona\'s only notice; brought up once marked missing', async (_name, origin) => {
    const { h, p } = ruleHarnessOf()
    const row = await origin.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, judgment: judgeNotJudged })
    expectPendingOnlyWatch(h, p)
    const launchStartMs = row.launchStartMs()!
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    const fromOrigin = row.calls.length
    const findMissingBefore = h.callTimes('findMissing').length
    const noticesBefore = noticesOf(h, p)

    const rounds = await runRounds(h, p, row, 6)

    // Each round before G only reads; from G the lap, the bypassing run and the get, each round a refusal.
    expect(rounds.some((round) => round.at < launchStartMs + graceMs)).toBe(true)
    expect(rounds.some((round) => round.at >= launchStartMs + graceMs && round.at < launchStartMs + boundMs)).toBe(true)
    for (const round of rounds) expect(round.verbs).toEqual(round.at < launchStartMs + graceMs ? READ_ONLY_ROUND : LAP_RUN_ROUND)
    expect(rounds.map((round) => round.refusals)).toEqual(rounds.map((_, i) => i + 1))
    expect(rounds.map((round) => round.waitMs)).toEqual(timerWaits(rounds.length))
    // Every round, before G, from G and at B alike, re-arms the timer on the pending row, pending-only.
    expect(rounds.map((round) => round.retryLine)).toEqual(rounds.map((round) => pendingOnlyReArmedLine(p, round.retry, round.refusals!)))
    expect(h.controller.view(p)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    // A new find-missing call at every round from G, the memo notwithstanding.
    expect(h.callTimes('findMissing').slice(findMissingBefore)).toEqual(rounds.filter((round) => round.at >= launchStartMs + graceMs).map((round) => round.at))
    // One round line per acting round; none for a round younger than G.
    expect(ruleLinesOf(h, p)).toHaveLength(rounds.filter((round) => round.at >= launchStartMs + graceMs).length)

    // The held post at the first round at or past B, once, naming P's session.
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect(heldPostsOf(h, p)[0]).toContain(quotedPersonaSessionName(p))
    // SRJ-405, SRJ-1010: while the launch does not report in, the held post is the persona's only post about it.
    expect(noticesOf(h, p).slice(noticesBefore.length)).toEqual(heldPostsOf(h, p))
    // Never a kill or a launch while pending.
    expect(row.calls.slice(fromOrigin).filter((call) => KILL_OR_LAUNCH.includes(call.verb))).toEqual([])

    // Marked missing: the retry hands P to the restart path's decision, which brings P up with no kill.
    row.setJudgment(judgeMissingFrom(h.clock.now()))
    const before = row.calls.length
    await retryNow(h, p)
    const verbs = row.calls.slice(before).map((call) => call.verb)
    expect(verbs.slice(0, LAP_RUN_ROUND.length)).toEqual(LAP_RUN_ROUND)
    expect(verbs).toContain('spawn')
    expect(verbs).not.toContain('kill')
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_ROW_GONE })
    expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
    expect(row.launchStartMs()).toBeGreaterThan(launchStartMs)
    // SRJ-713 (AC 6's unit half): no post or line of the whole case, the origin's own included, calls anything a "dispatcher bug".
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })

  // AC 30's conditions: the timer keeps running while the row is pending.
  test.each<[string, () => Error, (h: RecoveryHarness, p: string) => boolean, (h: RecoveryHarness, p: string) => number]>([
    ['tmux-unresponsive: a lap read-pane answering ErrTmuxUnresponsive starts it', () => errTmuxUnresponsive('read-pane'), (h, p) => h.tmuxUnresponsive.holds(p), (h, p) => h.conditionEnds.filter((end) => end.key === p).length],
    ['tmux-unavailable: a lap read-pane answering ErrTmuxNotAvailable raises it', () => errTmuxNotAvailable(undefined, 'read-pane'), (_h, p) => getOutageFlags(p).has('tmux-unavailable'), (h, p) => h.outageClears.filter((clear) => clear.key === p).length],
  ])('AC 30, %s; the next lap\'s read-pane succeeds and ends it, and the timer keeps running while pending', async (_label, make, holds, ends) => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, readPane: [make()] })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adGraceMsInEffect())

    const [failed] = await runRounds(h, p, row, 1)
    expect(failed!.verbs).toEqual(LAP_RUN_ROUND)
    expect([holds(h, p), ends(h, p)]).toEqual([true, 0])

    const [succeeded, after] = await runRounds(h, p, row, 2)
    expect(succeeded!.verbs).toEqual(LAP_RUN_ROUND)
    expect([holds(h, p), ends(h, p)]).toEqual([false, 1])
    expect(after!.verbs).toEqual(LAP_RUN_ROUND)
    expect(h.controller.isArmed(p)).toBe(true)
    expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
  })

  // AC 30's outage: no held post while tmux-unavailable is raised; step 3 at the first retry after it clears.
  test('AC 30, a row left pending by a plain spawn\'s ErrTmuxNotAvailable: no held post while tmux-unavailable stays raised past B; the held post at the first retry after it clears', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await failedSpawnOrigin(() => errTmuxNotAvailable(undefined, 'spawn')).begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(true)
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()
    // Every lap's read-pane answers ENVIRONMENT until the case stops it: the outage stays raised.
    let failLaps = true
    wrapModelKnob(h, 'readPaneFn', (modelReadPane) => (params) => (failLaps && isLapRead(params) ? errTmuxNotAvailable(undefined, 'read-pane') : modelReadPane(params)))

    await retryUntil(h, p, launchStartMs + boundMs)
    const [pastB] = await runRounds(h, p, row, 1)
    expect(pastB!.at).toBeGreaterThanOrEqual(launchStartMs + boundMs)
    expect(pastB!.verbs).toEqual(FAILED_LAP_RUN_ROUND)
    expect(readPaneTimesOf(h, row, pastB!.at)).toEqual([pastB!.at])
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(true)
    expect(heldPostsOf(h, p)).toEqual([])

    failLaps = false
    const [cleared] = await runRounds(h, p, row, 1)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(false)
    expect(cleared!.posts).toBe(1)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    // The failed spawn was answered by the case itself, so the model saw no kill or launch at all.
    expect(row.calls.filter((call) => KILL_OR_LAUNCH.includes(call.verb))).toEqual([])
  })

  // AC 32.
  test('AC 32: a row held at the trust dialog with no approver running gets one lap per retry from G (read-pane 40 lines, then Enter, each with allow_pending); the lap clears it and the row reaches waiting with no kill, launch or post; the timer stops', async () => {
    const { h, p } = ruleHarnessOf()
    // The first Enter answers GONE (nothing typed), so the dialog is still there at the next retry.
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_TRUST, sendKeys: [errTmuxSendKeys()] })
    expect(h.approverRunning(p)).toBe(false)
    const launchStartMs = row.launchStartMs()!
    const id = personaInstanceId(p)
    const fromOrigin = row.calls.length

    const rounds: RuleRound[] = []
    while (h.controller.view(p) !== undefined) rounds.push(...(await runRounds(h, p, row, 1)))

    const lapping = rounds.filter((round) => round.at >= launchStartMs + adGraceMsInEffect())
    expect(rounds.filter((round) => !lapping.includes(round)).every((round) => round.verbs.join() === READ_ONLY_ROUND.join())).toBe(true)
    expect(lapping.map((round) => round.verbs)).toEqual([
      ['status', 'get', 'read-pane', 'send-keys', 'find-missing', 'get'],
      ['status', 'get', 'read-pane', 'send-keys', 'find-missing', 'get'],
    ])
    expect(h.stub.calls.readPaneCalls).toEqual(lapping.map(() => ({ claude_instance_id: id, n_lines: FULL_PANE_READ_LINES, allow_pending: true })))
    expect(h.stub.calls.sendKeysCalls).toEqual(lapping.map(() => ({ claude_instance_id: id, text: '', allow_pending: true })))
    // The second Enter cleared the dialog; the round's get read the row live, and the retry stopped the timer.
    expect([row.dialog(), row.state()]).toEqual([PENDING_ROW_DIALOG_NONE, 'waiting'])
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE })
    expect(rounds.at(-1)!.retryLine).toBe(pendingOnlyStoppedLine(p, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expect(rounds.slice(0, -1).map((round) => round.retryLine)).toEqual(rounds.slice(0, -1).map((round) => pendingOnlyReArmedLine(p, round.retry, round.refusals!)))
    expect([h.controller.isArmed(p), h.clock.pendingCount()]).toEqual([false, 0])
    expect(row.calls.slice(fromOrigin).filter((call) => KILL_OR_LAUNCH.includes(call.verb))).toEqual([])
    expect(h.episodeNotices.filter((notice) => notice.key === p)).toEqual([])
  })

  // AC 33.
  test('AC 33: from the harness\'s call times, the laps and the runs are never closer than the timer\'s interval in effect', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    const findMissingBefore = h.callTimes('findMissing').length
    const rounds = await runRounds(h, p, row, 7)

    const runs = h.callTimes('findMissing').slice(findMissingBefore)
    const laps = h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId).map((call) => call.at)
    expect(runs.length).toBeGreaterThan(3)
    expect(laps).toEqual(runs)
    for (let i = 1; i < runs.length; i++) {
      const waitMs = rounds.find((round) => round.at === runs[i])!.waitMs
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(waitMs)
      expect(waitMs).toBeGreaterThanOrEqual(UNAVAILABLE_RETRY_BASE_S * MS_PER_SECOND)
    }
  })

  test('AC 33: the one run at the approver\'s stop is exempt from the cadence: the next retry\'s run may come closer than the interval, and every later run keeps it', async () => {
    const graceMs = adGraceMsInEffect()
    const { h, p } = ruleHarnessOf({ approverCapMs: graceMs + 20 * MS_PER_SECOND })
    const row = makePendingRowModel(h, p, { state: PENDING_ROW_MODEL_NO_ROW, dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    await h.launch(p)
    await h.runApproverToStop(p)
    await h.settle()
    const stopRunAt = h.clock.now()
    // The one run: its round line and its answer line.
    expect(ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)).toHaveLength(2)
    expect(h.callTimes('findMissing')).toEqual([stopRunAt])

    const rounds = await runRounds(h, p, row, 4)
    const runs = h.callTimes('findMissing')
    const firstRetryRun = rounds.find((round) => round.verbs.includes('find-missing'))!
    // The approver-stop run is not tied to a retry: the next retry's run comes closer than that retry's interval.
    expect(runs[1]).toBe(firstRetryRun.at)
    expect(runs[1]! - runs[0]!).toBeLessThan(firstRetryRun.waitMs)
    for (let i = 2; i < runs.length; i++) {
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(rounds.find((round) => round.at === runs[i])!.waitMs)
    }
  })

  // AC 84 (SRJ-410; HO C21 steps 2 and 3).
  test.each<[string, bigint, PendingRowModelOptions['judgment']]>([
    ['pending_grace_seconds at its minimum, the runs leaving the row in neither list', pendingGraceMinimumSeconds(DEFAULT_AD_SETTINGS.tmux.create_timeout_ms, DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms), judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs leaving the row in neither list', 400n, judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs judging the row (unverified_ids) while it stays pending', 400n, judgeUnverified],
  ])('AC 84, %s: no escalation, post or kill before B; at B, judged or not, one held post and no kill', async (_label, graceSeconds, judgment) => {
    expect(graceSeconds).not.toBe(DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)
    const { h, p } = ruleHarnessOf({ adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBe(Number(graceSeconds) * MS_PER_SECOND)
    const starts = recordSequenceStarts()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, judgment })
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()

    const rounds: RuleRound[] = []
    while (rounds.length === 0 || rounds.at(-1)!.at < launchStartMs + boundMs) rounds.push(...(await runRounds(h, p, row, 1)))
    rounds.push(...(await runRounds(h, p, row, 1)))

    expect(rounds.filter((round) => round.at >= launchStartMs + adGraceMsInEffect() && round.at < launchStartMs + boundMs).length).toBeGreaterThan(0)
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect([starts, row.callTimes('kill'), h.notices.filter((n) => n.key === p)]).toEqual([[], [], []])
  })

  // SRJ-406 (E28 bullet 1): the rule's legs measure from the launch start, never from started_at.
  test.each([
    ['whole', 10 * MINUTE_MS],
    ['fractional', 10 * MINUTE_MS + 123],
  ])('SRJ-406, a resumed row whose started_at is older than G and whose launch start (%s form) is recent: no lap, run or post before G from the launch start, and no held post before B from it', async (_form, launchStartMs) => {
    const { h, p } = ruleHarnessOf()
    await h.clock.advanceTo(launchStartMs)
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, startedAt: new Date(launchStartMs - 2 * boundMs).toISOString() })
    expect(row.launchStartedAt()).toBe(launchStartText(launchStartMs))
    expect(row.launchStartMs()).toBe(launchStartMs)
    expect(row.getRow().started_at).toBe(new Date(launchStartMs - 2 * boundMs).toISOString())

    const rounds = await runRounds(h, p, row, 5)
    const lapsAt = h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId).map((call) => call.at)
    expect(rounds[0]!.at).toBeLessThan(launchStartMs + graceMs)
    expect(lapsAt.length).toBeGreaterThan(0)
    expect(lapsAt.every((at) => at >= launchStartMs + graceMs)).toBe(true)
    expect(h.callTimes('findMissing').every((at) => at >= launchStartMs + graceMs)).toBe(true)
    expect(rounds.some((round) => round.at < launchStartMs + boundMs && round.at >= launchStartMs + graceMs)).toBe(true)
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
  })

  // E6: never-early waits through the accessors.
  test('E6, a G raised while P\'s timer waits delays the first lap and run past the old G to the new one', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    const launchStartMs = row.launchStartMs()!
    const oldGraceMs = adGraceMsInEffect()
    h.rewriteAdSettings({ tmux: { pending_grace_seconds: DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n } })
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    const rounds = await runRounds(h, p, row, 4)
    expect(rounds.some((round) => round.at >= launchStartMs + oldGraceMs && round.at < launchStartMs + newGraceMs)).toBe(true)
    for (const round of rounds) expect(round.verbs).toEqual(round.at < launchStartMs + newGraceMs ? READ_ONLY_ROUND : LAP_RUN_ROUND)
  })

  test.each<[string, bigint]>([
    ['a derived G beyond MAX_TIMER_DELAY_MS', BigInt(Math.ceil(MAX_TIMER_DELAY_MS / MS_PER_SECOND)) + 60n],
    ['G at AD_WAIT_NEVER_ENDS', AD_SETTING_INTEGER_MAX],
  ])('E6, %s: retries well past the default G and B make no lap, run or post, and the timer keeps running', async (_label, graceSeconds) => {
    const { h, p } = ruleHarnessOf({ adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    const rounds = await runRounds(h, p, row, 8)
    expect(rounds.at(-1)!.at - row.launchStartMs()!).toBeGreaterThan(2 * adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    for (const round of rounds) expect(round.verbs).toEqual(READ_ONLY_ROUND)
    expect([h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], []])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  // SRJ-117's lap column, end to end: what is typed, whether the run follows,
  // and the answer's own effect (tmux-unavailable raised, or CONFIG's cause armed).
  test.each<[string, PendingRowModelOptions['dialog'], (key: string) => Error | undefined, boolean, boolean, LapColumnEffect]>([
    ['a pane showing the trust dialog: Enter typed, the run follows', PENDING_ROW_DIALOG_TRUST, () => undefined, true, true, undefined],
    ['a pane showing the dev-channels dialog: Enter typed, the run follows', PENDING_ROW_DIALOG_DEV_CHANNELS, () => undefined, true, true, undefined],
    ['a pane with no needle: nothing typed, the run follows', PENDING_ROW_DIALOG_UNRECOGNISED, () => undefined, false, true, undefined],
    ['GONE (ErrTmuxCaptureFailed): nothing typed, the run follows', PENDING_ROW_DIALOG_TRUST, () => errTmuxCaptureFailed(), false, true, undefined],
    ['ErrSpawnNotFound: nothing typed, the run follows', PENDING_ROW_DIALOG_TRUST, () => errSpawnNotFound(), false, true, undefined],
    ['UNAVAILABLE: nothing typed, the run follows', PENDING_ROW_DIALOG_TRUST, () => errCallTimeout('read-pane'), false, true, undefined],
    ['CONFLICT: nothing typed; P latches, no run', PENDING_ROW_DIALOG_TRUST, (key) => errTmuxSessionConflict('read-pane', 'leftover', personaTmuxSessionName(key)), false, false, undefined],
    ['ENVIRONMENT: nothing typed, tmux-unavailable raised, the run follows', PENDING_ROW_DIALOG_TRUST, () => errTmuxNotAvailable(undefined, 'read-pane'), false, true, LAP_COLUMN_TMUX_UNAVAILABLE],
    ['UNCLASSIFIED: nothing typed, the run follows', PENDING_ROW_DIALOG_TRUST, () => unclassifiedAt('read-pane'), false, true, undefined],
    ['UNUSABLE NAME: nothing typed; P latches, no run', PENDING_ROW_DIALOG_TRUST, () => errUnusableName(), false, false, undefined],
    ['CONFIG: nothing typed, its cause armed, the run follows', PENDING_ROW_DIALOG_TRUST, () => errConfigMalformed(), false, true, LAP_COLUMN_CONFIG_CAUSE],
  ])('the lap column, %s', async (_label, dialog, answer, typed, runs, effect) => {
    const { h, p } = ruleHarnessOf()
    const err = answer(p)
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog, readPane: [err] })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adGraceMsInEffect())
    const lapAt = h.controller.view(p)!.dueAt!
    await retryNow(h, p)

    expect(h.stub.calls.readPaneCalls).toEqual([{ claude_instance_id: row.instanceId, n_lines: FULL_PANE_READ_LINES, allow_pending: true }])
    expect(h.stub.calls.sendKeysCalls).toEqual(typed ? [{ claude_instance_id: row.instanceId, text: '', allow_pending: true }] : [])
    expect(h.callTimes('findMissing')).toEqual(runs ? [lapAt] : [])
    expect(h.latch.isLatched(p)).toBe(!runs)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(effect === LAP_COLUMN_TMUX_UNAVAILABLE)
    // The CONFIG answer raised ad-config-malformed (its onset posted) and armed its cause; the run's success cleared it.
    expect(h.triggers.some((trigger) => trigger.key === p && trigger.kind === UNAVAILABLE_RETRY_CAUSE_CONFIG)).toBe(effect === LAP_COLUMN_CONFIG_CAUSE)
    expect(row.calls.filter((call) => KILL_OR_LAUNCH.includes(call.verb)).map((call) => call.verb)).toEqual(['spawn'])
  })

  // SRJ-118, SRJ-412 (R13): after a send-keys answered ErrSpawnNotInteractive, no further lap on that launch.
  test.each<[string, number, (h: RecoveryHarness, p: string) => Promise<PendingRowModel>]>([
    [
      'the lap\'s Enter',
      1,
      (h, p) => ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_TRUST, sendKeys: [errSpawnNotInteractive('send-keys')] }),
    ],
    [
      'the approver\'s Enter',
      0,
      async (h, p) => {
        const row = makePendingRowModel(h, p, { state: PENDING_ROW_MODEL_NO_ROW, dialog: PENDING_ROW_DIALOG_TRUST, sendKeys: [errSpawnNotInteractive('send-keys')] })
        await h.launch(p)
        await h.settle()
        return row
      },
    ],
  ])('after %s answered ErrSpawnNotInteractive: no further lap on that launch (the run still follows each retry), and the held post at B drops the attach line', async (_label, lapsBefore, begin) => {
    const { h, p } = ruleHarnessOf()
    const row = await begin(h, p)
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()
    const rounds: RuleRound[] = []
    while (rounds.length === 0 || rounds.at(-1)!.at < launchStartMs + boundMs) rounds.push(...(await runRounds(h, p, row, 1)))

    // The one Enter that met it, and at most the one lap that made it; none after.
    expect(h.stub.calls.sendKeysCalls).toHaveLength(1)
    expect(readPaneTimesOf(h, row, launchStartMs + adGraceMsInEffect())).toHaveLength(lapsBefore)
    expect(rounds.filter((round) => round.at >= launchStartMs + adGraceMsInEffect()).every((round) => round.verbs.includes('find-missing'))).toBe(true)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), true)])
    expect(heldPostsOf(h, p)[0]).not.toContain(stuckLaunchAttachRemedyLine(p))
  })

  test('a new launch after the lap\'s ErrSpawnNotInteractive laps again from its own G', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, {
      dialog: PENDING_ROW_DIALOG_TRUST,
      dialogOnLaunch: PENDING_ROW_DIALOG_UNRECOGNISED,
      sendKeys: [errSpawnNotInteractive('send-keys')],
    })
    const firstStartMs = row.launchStartMs()!
    await retryUntil(h, p, firstStartMs + adGraceMsInEffect())
    await runRounds(h, p, row, 2)
    expect(readPaneTimesOf(h, row)).toHaveLength(1)

    // Marked missing: P is brought up with a new launch, whose pane shows no needle.
    row.setJudgment(judgeMissingFrom(h.clock.now()))
    await retryNow(h, p)
    const newStartMs = row.launchStartMs()!
    expect(newStartMs).toBeGreaterThan(firstStartMs)
    row.setJudgment(judgeNotJudged)
    await retryUntil(h, p, newStartMs + adGraceMsInEffect())
    expect(readPaneTimesOf(h, row, newStartMs + adGraceMsInEffect())).toEqual([])
    const lapAt = await retryNow(h, p)
    expect(readPaneTimesOf(h, row, newStartMs + adGraceMsInEffect())).toEqual([lapAt])
  })

  // SRJ-502 (E13): no lap, run or kill for a latched P.
  test('a P latched by its lap (the read-pane\'s CONFLICT): the timer stops; a later arm\'s retry makes no call; no lap, run, kill or post as time passes', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_TRUST, readPane: [errTmuxSessionConflict('read-pane', 'leftover', personaTmuxSessionName(p))] })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adGraceMsInEffect())
    await retryNow(h, p)
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED })
    const calls = row.calls.length

    h.controller.armPendingOnly(p)
    await h.advance(2 * adLaunchBoundMsInEffect())
    await h.settle()
    expect(row.calls.slice(calls)).toEqual([])
    expect([h.callTimes('findMissing'), heldPostsOf(h, p), row.callTimes('kill')]).toEqual([[], [], []])
  })

  // E16, SRJ-513: an own pending row with no launch start latches through E16's read.
  test('an own pending row with no launch start latches through E16\'s read: no lap, run or kill, and none as time passes', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { launchStartedAt: SAMPLE_LAUNCH_STARTS.none, dialog: PENDING_ROW_DIALOG_TRUST })
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.controller.isArmed(p)).toBe(false)
    await h.advance(2 * adLaunchBoundMsInEffect())
    await h.settle()
    expect(row.calls.map((call) => call.verb)).toEqual(['spawn', 'get'])
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p)]).toEqual([[], [], []])
  })

  // E28 bullet 2, SRJ-411: no post for an uncovered row; undecided rows get no rule run.
  test('an uncovered pending row past B (its cwd elsewhere): its live-row sequence is started; no lap, run or stuck-launch post', async () => {
    const { h, p } = ruleHarnessOf()
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(0), dialog: PENDING_ROW_DIALOG_TRUST, row: { cwd: h.home } })
    const starts = recordSequenceStarts()
    await h.clock.advanceTo(adLaunchBoundMsInEffect() + MINUTE_MS)
    h.controller.armPendingOnly(p)
    await retryNow(h, p)

    expect(starts).toHaveLength(1)
    expect(row.calls.map((call) => call.verb)).toEqual(['status', 'get'])
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], [], []])
  })

  test('an undecided pending row past B (its claude_config_dir unresolvable): armed only, with no lap, run or post at any retry', async () => {
    const { h, p } = ruleHarnessOf()
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(0), dialog: PENDING_ROW_DIALOG_TRUST })
    _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } })
    await h.clock.advanceTo(adLaunchBoundMsInEffect() + MINUTE_MS)
    h.controller.armPendingOnly(p)
    const rounds = await runRounds(h, p, row, 3)

    for (const round of rounds) expect(round.verbs).toEqual(READ_ONLY_ROUND)
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], [], []])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  // SRD hatch A2: the run at a retry and the run at the approver's stop are attempts.
  const ATTEMPT_ANSWERS: ReadonlyArray<readonly [string, () => Error, (h: RecoveryHarness, p: string) => boolean]> = [
    ['ErrTmuxUnresponsive starts tmux-unresponsive', () => errTmuxUnresponsive('read-pane'), (h, p) => h.tmuxUnresponsive.holds(p)],
    ['UNAVAILABLE arms its cause (SRJ-105)', () => errCallTimeout('read-pane'), (h, p) => h.triggers.some((t) => t.key === p && t.kind === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)],
    ['UNCLASSIFIED opens P\'s unclassified-error episode', () => unclassifiedAt('read-pane'), (h, p) => h.unclassifiedErrorOpen(p)],
  ]

  test.each(ATTEMPT_ANSWERS)('at a retry, the lap\'s read-pane answering %s; the run still follows', async (_label, make, holds) => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adGraceMsInEffect())
    expect(holds(h, p)).toBe(false)
    failNextLapRead(h, p, make)

    const [round] = await runRounds(h, p, row, 1)
    expect(round!.verbs).toEqual(FAILED_LAP_RUN_ROUND)
    expect(readPaneTimesOf(h, row, round!.at)).toEqual([round!.at])
    expect(holds(h, p)).toBe(true)
  })

  test.each(ATTEMPT_ANSWERS)('at the approver\'s stop past G, the one run\'s lap read-pane answering %s; the run still follows', async (_label, make, holds) => {
    const { h, p } = ruleHarnessOf({ approverCapMs: adGraceMsInEffect() + 20 * MS_PER_SECOND })
    makePendingRowModel(h, p, { state: PENDING_ROW_MODEL_NO_ROW, dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    failNextLapRead(h, p, make)
    await h.launch(p)
    await h.runApproverToStop(p)
    await h.settle()

    // The one run: its round line and its answer line.
    expect(ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)).toHaveLength(2)
    expect(h.callTimes('findMissing')).toEqual([h.clock.now()])
    expect(holds(h, p)).toBe(true)
  })

  // The Task's ruling: a failed get after the run ends the round; never step 3 on an earlier read.
  test('a failed get after the run at B: nothing more that round and no post; the next retry\'s round posts', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adLaunchBoundMsInEffect())
    // The get right after this round's run (and only this round's) answers UNAVAILABLE.
    let failThisRound = true
    let failNextGet = false
    wrapModelKnob(h, 'findMissingFn', (modelFindMissing) => async (params) => {
      failNextGet = failThisRound
      failThisRound = false
      return modelFindMissing(params)
    })
    wrapModelKnob(h, 'getFn', (modelGet) => (params) => {
      if (!failNextGet || params.claude_instance_id !== row.instanceId) return modelGet(params)
      failNextGet = false
      return errCallTimeout('get')
    })

    const [failed] = await runRounds(h, p, row, 1)
    expect(failed!.verbs).toEqual(['status', 'get', 'read-pane', 'find-missing'])
    expect(heldPostsOf(h, p)).toEqual([])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(ruleLinesOf(h, p).at(-1)).toContain(errCallTimeout('get').errName)

    await runRounds(h, p, row, 1)
    expect(heldPostsOf(h, p)).toHaveLength(1)
  })

  // SRJ-810 (Task reconcile note): no lap, run or post while P's working directory is held for an old life.
  test('SRJ-810: while P\'s working directory is held for an old life, a retry on P\'s covered pending row past G makes no read-pane, send-keys or find-missing of its own and posts nothing; once the hold ends, the next retry runs the rule', async () => {
    const { h, p } = ruleHarnessOf()
    const directory = personaOf(h, p).working_directory
    // The old life's row reads live in P's directory, so its wait keeps the hold until its run lists it.
    h.script({ getFn: (params) => (params.claude_instance_id === PRE_PERSONA_ID ? cannedGetResult({ claude_instance_id: PRE_PERSONA_ID, cwd: directory, state: 'waiting' }) : undefined) })
    const row = await ORIGIN_START_PASS.begin(h, p, { dialog: PENDING_ROW_DIALOG_TRUST })
    const launchStartMs = row.launchStartMs()!
    h.beginOldLifeHold({ instanceId: PRE_PERSONA_ID, oldKey: PRE_PERSONA_ID, directory, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const hold = holdFindMissing(h.stub.client)
    const waited = h.startOldLifeWait(PRE_PERSONA_ID)
    await hold.entered(1)

    while (h.controller.view(p)!.dueAt! < launchStartMs + adLaunchBoundMsInEffect()) {
      await retryNow(h, p, { settle: false })
      await h.advance(0)
    }
    expect(h.clock.now()).toBeGreaterThanOrEqual(launchStartMs + adGraceMsInEffect())
    expect([h.stub.calls.readPaneCalls, h.stub.calls.sendKeysCalls, hold.calls.length, heldPostsOf(h, p)]).toEqual([[], [], 1, []])

    // The old life is listed missing: the hold ends with its wait.
    hold.release(cannedFindMissing({ rows: { [PRE_PERSONA_ID]: 'ids' } }))
    await waited
    expect(h.oldLifeHolds.holdOf(PRE_PERSONA_ID)).toBeUndefined()
    await h.settle()

    await retryNow(h, p, { settle: false })
    await hold.entered(2)
    hold.release(cannedFindMissing({ rows: { [row.instanceId]: 'neither' } }))
    await h.settle()
    expect(h.stub.calls.readPaneCalls!.filter(isLapRead)).toHaveLength(1)
    expect(ruleLinesOf(h, p)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The run at the approver's stop, gated as a retry is (b.jg5 SRJ-404, SRJ-410,
// SRJ-411, SRJ-305): the harness installs the rule with main()'s gate (the
// retry action's, `retryRunGateStop`), asked when the run's turn in P's
// serializer starts. Here, end to end: the stops for a persona removed (its
// teardown's turn ahead of the run), latched, held, not up or at the cap. The
// gate's own shutdown, its throws and when it is asked are
// tests/approve-trust-folder-dialog.test.ts's; its order is
// tests/session-manager.test.ts's.
// ---------------------------------------------------------------------------

/** P's approver stopped at its test cap past G with the row `pending`, its one run queued behind a turn of P's serializer the case holds. */
interface QueuedApproverStopRun {
  readonly h: RecoveryHarness
  readonly p: string
  readonly row: PendingRowModel
  /** End the held turn, so the queued run's turn starts. */
  release(): void
}

async function approverStopRunQueuedBehindTurn(): Promise<QueuedApproverStopRun> {
  const capMs = adGraceMsInEffect() + 20 * MS_PER_SECOND
  const { h, p } = ruleHarnessOf({ approverCapMs: capMs })
  const row = makePendingRowModel(h, p, { state: PENDING_ROW_MODEL_NO_ROW, dialog: PENDING_ROW_DIALOG_UNRECOGNISED })
  const startedAt = h.clock.now()
  await h.launch(p)
  await h.settle()
  let release!: () => void
  void h.serializer.run(p, () => new Promise<void>((resolve) => (release = resolve)))
  // The clock moved to the approver's cap by hand: `runApproverToStop` and
  // `settle` await the queued run, which waits for the held turn.
  await h.advance(startedAt + capMs - h.clock.now())
  expect(h.approverRunning(p)).toBe(false)
  expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
  expect(ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)).toEqual([])
  return { h, p, row, release: () => release() }
}

/** Hold P on `ErrInvalidFlags` through a real reuse (SRJ-207): a launch whose spawn collides with P's row read `ended` elsewhere, and whose reuse spawn answers `ErrInvalidFlags`. */
async function holdOnInvalidFlags(h: RecoveryHarness, p: string): Promise<void> {
  const ended = cannedGetResult({ cwd: h.home, state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, p), h.home)
  h.script({
    spawnFn: (params) => ('reuse_finished' in params ? errInvalidFlags('spawn') : errInstanceIdCollision()),
    getFn: () => ended,
  })
  expect(await h.launch(p)).toStrictEqual({ key: p, action: 'held' })
  expect(h.invalidFlagsHold.isHeld(p)).toBe(true)
}

describe('the run at the approver\'s stop is dropped when the retry action\'s gate would stop a retry then (recovery harness; b.jg5 SRJ-404, SRJ-410, SRJ-411, SRJ-305)', () => {
  afterEach(cleanUpRuleHarness)

  test.each<[string, (h: RecoveryHarness, p: string, row: PendingRowModel) => Promise<void> | void, string]>([
    [
      'P\'s teardown, its turn ahead of the run (P removed from the applied set)',
      (h, p) => {
        h.remove(p)
        h.teardown(p)
        h.episodes.forget(p)
      },
      UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
    ],
    [
      'P latched while the run waits (its own row read with no launch start)',
      async (h, p, row) => {
        row.setLaunchStartedAt(SAMPLE_LAUNCH_STARTS.none)
        expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_STEP_LATCHED })
        expect(h.latch.isLatched(p)).toBe(true)
      },
      UNAVAILABLE_RETRY_STOP_LATCHED,
    ],
    ['P held on ErrInvalidFlags while the run waits', (h, p) => holdOnInvalidFlags(h, p), UNAVAILABLE_RETRY_STOP_HELD],
    ['P no longer up', (h, p) => h.setUp(p, false), UNAVAILABLE_RETRY_STOP_NOT_UP],
    [
      'P at the restart cap',
      (_h, p) => {
        for (let failures = 0; failures < RESTART_FAILURE_CAP; failures++) recordFailure(p)
      },
      UNAVAILABLE_RETRY_STOP_CAPPED,
    ],
  ])('%s: when the run\'s turn starts it is dropped with one line; no read-pane, Enter, find-missing, get, post or kill', async (_label, arrange, why) => {
    const { h, p, row, release } = await approverStopRunQueuedBehindTurn()
    await arrange(h, p, row)
    const callsBefore = h.timedCalls.length
    const noticesBefore = noticesOf(h, p)

    release()
    await h.settle()

    expect(ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)).toEqual([pendingRowRuleApproverStopGatedLine(renderPersonaRef(personaOf(h, p).name, p), why)])
    expect(h.timedCalls.slice(callsBefore)).toEqual([])
    expect(noticesOf(h, p)).toEqual(noticesBefore)
  })

  test('with every stop of the gate open, the same run makes its round when its turn starts: a lap, one bypassing find-missing and one get', async () => {
    const { h, p, row, release } = await approverStopRunQueuedBehindTurn()
    const callsBefore = row.calls.length

    release()
    await h.settle()

    const ref = renderPersonaRef(personaOf(h, p).name, p)
    const lines = ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)
    // Its round line, then its answer line.
    expect(lines).toHaveLength(2)
    expect(lines[0]!.startsWith(roundLineStart(ref, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP, row.launchStartedAt()))).toBe(true)
    expect(lines[1]).toBe(pendingRowRuleApproverStopLine(ref, APPROVER_STOP_CAP, refusalOf('not-judged')))
    expect(row.calls.slice(callsBefore).map((call) => call.verb)).toEqual(['read-pane', 'find-missing', 'get'])
  })
})

// ---------------------------------------------------------------------------
// CSCB's own stuck launch at B on the recovery harness (b.jg5 SRJ-412; AC 9, AC 31, AC 48, AC 67, AC 84)
// ---------------------------------------------------------------------------

/** The session id of the row CSCB's own launch resumed, so the abort's sequence ends in a `resume` that keeps it. */
const OWN_SESSION_ID = 'a-resumed-session'

/** P's relaunching text with B in effect. */
const relaunchingTextOf = (p: string): string => stuckLaunchRelaunchingText(p, adLaunchBoundMsInEffect())

/** P's stuck-launch relaunching posts in `h`. */
const relaunchingPostsOf = (h: RecoveryHarness, p: string): string[] =>
  h.episodeNotices.filter((notice) => notice.key === p && notice.text === relaunchingTextOf(p)).map((notice) => notice.text)

/** Where the abort's round runs from: P's approver stopping at B, or a retry of P's timer (its approver stopped at the stub's cap). */
const ABORT_ORIGIN_APPROVER_STOP = 'the approver\'s stop at B'
const ABORT_ORIGIN_RETRY = 'a retry of P\'s timer'
type AbortOrigin = typeof ABORT_ORIGIN_APPROVER_STOP | typeof ABORT_ORIGIN_RETRY
const ABORT_ORIGINS: readonly AbortOrigin[] = [ABORT_ORIGIN_APPROVER_STOP, ABORT_ORIGIN_RETRY]

/**
 * An own-launch harness (`harnessNow`, both settings 0) and P's model: a
 * finished row with a session id whose pane shows a prompt no approver
 * clears, the start pass's spawn colliding with it, so P's launch is a
 * `resume` of that row (`options` merged in). From
 * {@link ABORT_ORIGIN_APPROVER_STOP} the approver runs to B (no test cap);
 * from {@link ABORT_ORIGIN_RETRY} it stops at the stub's cap and P's timer
 * runs the rule.
 */
function ownStuckLaunchOf(
  options: PendingRowModelOptions = {},
  origin: AbortOrigin = ABORT_ORIGIN_APPROVER_STOP,
  harness: RecoveryHarnessOptions = {},
): { h: RecoveryHarness; p: string; row: PendingRowModel } {
  const { h, p } = ruleHarnessOf({ harnessNow: true, ...harness })
  if (origin === ABORT_ORIGIN_APPROVER_STOP) h.setApproverCap(undefined)
  const row = makePendingRowModel(h, p, {
    state: LIVENESS_DEAD_ROW_ENDED,
    sessionId: OWN_SESSION_ID,
    dialog: PENDING_ROW_DIALOG_UNRECOGNISED,
    launches: [errInstanceIdCollision()],
    ...options,
  })
  return { h, p, row }
}

/** One retry of P's timer, its abort kill's waits between tries and any sequence it started driven on the harness clock; answers the retry's time. */
async function retryDriven(h: RecoveryHarness, p: string): Promise<number> {
  const at = await h.drive(retryNow(h, p, { settle: false }))
  await h.drive(h.settle())
  await h.driveSequence(h.sequenceSettled(p))
  return at
}

/** Retry P's timer (each retry settled) until its next retry is the first at or past `atMs`. */
async function retryUntil(h: RecoveryHarness, p: string, atMs: number): Promise<void> {
  while (h.controller.view(p)!.dueAt! < atMs) await retryNow(h, p)
}

/** Retry P's timer until its next retry is the first at or past B from the row's launch start now; answers that B. */
async function retryUntilB(h: RecoveryHarness, p: string, row: PendingRowModel): Promise<number> {
  const atB = row.launchStartMs()! + adLaunchBoundMsInEffect()
  while (h.controller.view(p)!.dueAt! < atB) await retryDriven(h, p)
  return atB
}

/** Drive P's row to B from `origin`: the approver's stop at B, or the first retry at or past B. Answers the clock time of the round at B. */
async function abortRoundAtB(h: RecoveryHarness, p: string, row: PendingRowModel, origin: AbortOrigin): Promise<number> {
  if (origin === ABORT_ORIGIN_RETRY) {
    await retryUntilB(h, p, row)
    return retryDriven(h, p)
  }
  const atB = row.launchStartMs()! + adLaunchBoundMsInEffect()
  await driveToB(h, row)
  await h.driveSequence(h.sequenceSettled(p))
  return atB
}

/** P's model with no row, so P's launch is a plain spawn the case may time (`scriptModelLaunch`). */
const PLAIN_SPAWN_LAUNCH: PendingRowModelOptions = { state: PENDING_ROW_MODEL_NO_ROW, launches: [] }

/** The model's verbs at or after `fromMs`, without the dialog approver's laps (each a `status` and a `read-pane` while one runs). */
const roundVerbsFrom = (h: RecoveryHarness, row: PendingRowModel, fromMs: number): PendingRowModelVerb[] =>
  row.calls.filter((call) => call.at >= fromMs).map((call) => call.verb)

/** The abort's sequence from step 2 after its one kill: a get, a run, a get, then the `resume` keeping the conversation. */
const ABORT_ROUND_TO_RESUME: PendingRowModelVerb[] = ['read-pane', 'find-missing', 'get', 'kill', 'get', 'find-missing', 'get', 'resume']

/** P's model calls of a launch or a delete (no `delete` is modelled: the stub's own record is read too). */
const launchesOf = (row: PendingRowModel): PendingRowModelVerb[] => row.calls.filter((call) => call.verb === 'spawn' || call.verb === 'resume').map((call) => call.verb)

/** P's abort kill lines in `h`, each up to what follows (its kind and the kill's described outcome). */
function abortKillLinesOf(h: RecoveryHarness, p: string): string[] {
  const head = stuckLaunchAbortKillLine(p, abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_FAILED), '').split(STUCK_LAUNCH_ABORT_KILL_FAILED)[0]!
  return h.errors.filter((line) => line.startsWith(head)).map((line) => line.split(' — ')[0]!)
}

/** The start of P's abort kill line for a success with `kill_sent` as given, its outcome described by `src/checked-kill.ts`. */
const killedLineStart = (p: string, killSent: boolean): string =>
  abortKillLineStart({ kind: STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, killSent, description: describeKillOutcome({ kind: KILL_OUTCOME_KILLED, killSent }) }, p)

/** P's kill-failure alerts with the abort's context as the alerts' own lines record them. */
const abortAlertLinesOf = (h: RecoveryHarness, p: string): string[] =>
  killFailureLines(h, p).filter((line) => line.includes(`(${KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT}`))

/** Everything P's destination got that is not a stuck-launch text: the alerts, the latch notices and any other notice. */
const otherNoticesOf = (h: RecoveryHarness, p: string): string[] =>
  noticesOf(h, p).filter((text) => text !== relaunchingTextOf(p) && !text.startsWith(STUCK_LAUNCH_HELD_HEAD))

describe('CSCB\'s own stuck launch at B: the relaunching post, one checked kill, the live-row sequence from step 2 (recovery harness; b.jg5 SRJ-412; AC 9, AC 31, AC 48, AC 67, AC 84)', () => {
  afterEach(cleanUpRuleHarness)

  // AC 9; AC 84 and SRJ-410 step 2 / SRJ-1426: at B, judged or not, the own launch is aborted.
  test.each<[string, PendingRowModelOptions['judgment']]>([
    ['its runs leaving the row in neither ids nor unverified_ids', judgeNotJudged],
    ['its runs judging it and leaving it live (unverified_ids)', judgeUnverified],
  ])('AC 9, a resumed launch CSCB started, held at an unrecognised prompt, %s: at B one relaunching post, one kill with kill_sent true, the sequence from step 2 (no step-1 kill) and a resume of the same row; nothing counted', async (_label, judgment) => {
    const { h, p, row } = ownStuckLaunchOf({ judgment })
    const launchStart = await launchOwnPending(h, row)
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: row.instanceId }])

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    expect(atB).toBe(parseLaunchStart(launchStart)! + adLaunchBoundMsInEffect())
    expect(roundVerbsFrom(h, row, atB).slice(0, ABORT_ROUND_TO_RESUME.length)).toEqual(ABORT_ROUND_TO_RESUME)
    expect(row.callTimes('kill')).toEqual([atB])
    expect(abortKillLinesOf(h, p)).toEqual([killedLineStart(p, true)])
    // The resume of the same row (its session id kept), and no reuse spawn or delete.
    expect(row.getRow().claude_session_id).toBe(OWN_SESSION_ID)
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: row.instanceId }, { claude_instance_id: row.instanceId }])
    expect([h.reuseSpawns(), h.stub.calls.deleteCalls]).toEqual([[], []])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect([heldPostsOf(h, p), otherNoticesOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
    // The relaunch is pending, CSCB's own, its approver at its first lap.
    expect([row.state(), row.launchStartMs(), isCscbOwnLaunch(p, row.launchStartedAt())]).toEqual([AGENT_DIRECTOR_PENDING_STATE, atB, true])
  })

  // AC 84 (SRJ-410; HO C21 steps 2 and 3), the own-launch half at non-default
  // G (the held half is in the rule's harness describe above).
  test.each<[string, bigint, PendingRowModelOptions['judgment']]>([
    ['pending_grace_seconds at its minimum, the runs leaving the row in neither list', pendingGraceMinimumSeconds(DEFAULT_AD_SETTINGS.tmux.create_timeout_ms, DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms), judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs leaving the row in neither list', 400n, judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs judging the row (unverified_ids) while it stays pending', 400n, judgeUnverified],
  ])('AC 84, CSCB\'s own stuck launch with %s: no post, kill or alert before B while the retries run; at B, judged or not, one relaunching post and one abort, no held post', async (_label, graceSeconds, judgment) => {
    expect(graceSeconds).not.toBe(DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)
    const { h, p, row } = ownStuckLaunchOf({ judgment }, ABORT_ORIGIN_RETRY, { adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBe(Number(graceSeconds) * MS_PER_SECOND)
    await launchOwnPending(h, row)
    const launchStartMs = row.launchStartMs()!

    const atB = await retryUntilB(h, p, row)

    expect(h.callTimes('findMissing').some((at) => at >= launchStartMs + adGraceMsInEffect() && at < atB)).toBe(true)
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), otherNoticesOf(h, p), row.callTimes('kill')]).toEqual([[], [], [], []])
    expect(h.stuckLaunchAbortUsed(p)).toBe(false)

    const roundAt = await retryDriven(h, p)

    expect(roundAt).toBeGreaterThanOrEqual(atB)
    expect(row.callTimes('kill')).toEqual([roundAt])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect([heldPostsOf(h, p), otherNoticesOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
    // The retry is a refusal naming the live-row sequence its rule started, the last row read kept pending.
    expect(retryLinesOf(h, p)).toContain(pendingOnlyReArmedLine(p, lastRetryOf(h, p), h.controller.view(p)!.refusals, UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED))
    expect(h.controller.view(p)).toMatchObject({ mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
  })

  // SRJ-412, SRJ-713: a later launch call of P that answers
  // ErrInstanceIdCollision started no launch, so CSCB's own launch keeps its
  // record and still gets the relaunching post and its abort at B.
  test('a later spawn of P colliding with CSCB\'s own pending launch keeps that launch\'s own-launch record: at B the relaunching post and the abort\'s one kill, no held post', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    const launchStart = await launchOwnPending(h, row)
    const record = ownLaunchRecordOf(p)
    expect(record).toBeDefined()
    const spawnsBefore = h.stub.calls.spawnCalls.length
    row.scriptLaunches(errInstanceIdCollision())

    await h.launch(p)
    await h.settle()

    expect(h.stub.calls.spawnCalls).toHaveLength(spawnsBefore + 1)
    expect([row.state(), row.launchStartedAt()]).toEqual([AGENT_DIRECTOR_PENDING_STATE, launchStart])
    expect(ownLaunchRecordOf(p)).toEqual(record)
    expect(isCscbOwnLaunch(p, launchStart)).toBe(true)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(row.callTimes('kill')).toEqual([atB])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(heldPostsOf(h, p)).toEqual([])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
  })

  // AC 31: a timed-out launch inside its window is CSCB's own; a kill_sent false success goes on to the sequence.
  test('AC 31, a launch that timed out with its launch start inside its window: aborted at B; its kill answering kill_sent false goes on to the sequence and its resume', async () => {
    const { h, p, row } = ownStuckLaunchOf({ ...PLAIN_SPAWN_LAUNCH, kill: [cannedKillResult(false)] })
    scriptModelLaunch(h, row, { takesMs: MINUTE_MS, end: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })
    await launchOwnPending(h, row)
    expect(ownLaunchRecordOf(p)?.window.end).toBe(LAUNCH_CALL_END_LAUNCH_TIMEOUT)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    expect(row.callTimes('kill')).toEqual([atB])
    expect(abortKillLinesOf(h, p)).toEqual([killedLineStart(p, false)])
    expect(roundVerbsFrom(h, row, atB).slice(0, ABORT_ROUND_TO_RESUME.length)).toEqual(ABORT_ROUND_TO_RESUME)
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(heldPostsOf(h, p)).toEqual([])
  })

  // AC 9, AC 31, AC 48: every other pending row at B gets the held post and is never killed.
  type NotOwnArrange = (h: RecoveryHarness, p: string, row: PendingRowModel) => Promise<void>
  test.each<[string, PendingRowModelOptions, NotOwnArrange, boolean]>([
    [
      'the approver\'s send-keys answered ErrSpawnNotInteractive (R13)',
      { dialogOnLaunch: PENDING_ROW_DIALOG_TRUST, sendKeys: [errSpawnNotInteractive('send-keys')] },
      async (h, p) => {
        await h.launch(p)
        await h.settle()
        expect(ownLaunchRecordOf(p)).toBeDefined()
      },
      true,
    ],
    [
      'a lap\'s send-keys answered ErrSpawnNotInteractive (R13)',
      {},
      async (h, _p, row) => {
        await launchOwnPending(h, row)
        row.setDialog(PENDING_ROW_DIALOG_TRUST)
        row.scriptSendKeys(errSpawnNotInteractive('send-keys'))
      },
      true,
    ],
    [
      'another process\'s launch over CSCB\'s own (AC 48)',
      {},
      async (h, _p, row) => {
        await launchOwnPending(h, row)
        await h.advance(MS_PER_SECOND)
        launchByAnotherProcess(h, row)
      },
      false,
    ],
    ...(['before', 'after'] as const).map((placement): [string, PendingRowModelOptions, NotOwnArrange, boolean] => [
      `a launch whose launch start lies ${placement} its call's window (AC 31)`,
      PLAIN_SPAWN_LAUNCH,
      async (h, p, row) => {
        scriptModelLaunch(h, row, { takesMs: MINUTE_MS, launchStart: placement })
        await h.launch(p)
        await h.settle()
        expect(ownLaunchRecordOf(p)).toBeUndefined()
      },
      false,
    ]),
  ])('%s: at B the held post, with no relaunching post and no kill', async (_label, model, arrange, flagged) => {
    const { h, p, row } = ownStuckLaunchOf(model, ABORT_ORIGIN_RETRY)
    await arrange(h, p, row)
    const launches = launchesOf(row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    await retryDriven(h, p)

    expect([row.state(), isCscbOwnLaunch(p, row.launchStartedAt())]).toEqual([AGENT_DIRECTOR_PENDING_STATE, false])
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), flagged)])
    expect([relaunchingPostsOf(h, p), row.callTimes('kill'), launchesOf(row)]).toEqual([[], [], launches])
  })

  // SRJ-1017's Test clause; SRJ-412: at most one abort per stuck-launch episode.
  test('a relaunch still pending at B in the same episode: the held text once and no kill, and no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    await launchOwnPending(h, row)
    await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    const relaunchStart = row.launchStartedAt()
    expect(isCscbOwnLaunch(p, relaunchStart)).toBe(true)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    await retryDriven(h, p)

    expect(row.launchStartedAt()).toBe(relaunchStart)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, relaunchStart, false)])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(row.callTimes('kill')).toHaveLength(1)
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
  })

  // AC 67, SRJ-702, SRJ-704: ErrTmuxKillFailed after its tries uses the abort; one alert; then the held text once.
  test('the abort kill answering ErrTmuxKillFailed at each of its 3 tries, 2 s apart: one ordinary alert with the stuck-launch abort context; not retried; no launch or delete; the held text once at the next retry, never in the same round', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    const failed = errTmuxKillFailed(personaTmuxSessionName(p))
    row.scriptKill(...Array.from({ length: KILL_RETRY_TRIES }, () => failed))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    expect(row.callTimes('kill')).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => atB + i * KILL_RETRY_SPACING_MS))
    const alert = ordinaryAlertContent(p, { last: failed })
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect([launchesOf(row), h.stub.calls.deleteCalls, heldPostsOf(h, p)]).toEqual([launches, [], []])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)

    await retryDriven(h, p)
    await retryDriven(h, p)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect([row.callTimes('kill').length, otherNoticesOf(h, p).length, relaunchingPostsOf(h, p).length, launchesOf(row)]).toEqual([KILL_RETRY_TRIES, 1, 1, launches])
  })

  // SRJ-501, SRJ-505, SRJ-512, SRJ-613 (AC 9): the abort kill's CONFLICT and UNUSABLE NAME latch P, never retried.
  // End to end, SRJ-613's kill backstop ("not this launch's session") and one
  // UNUSABLE NAME row; every row is session-manager.test.ts's at unit level.
  const ABORT_KILL_LATCHES: ReadonlyArray<readonly [string, () => Error, (key: string) => ConflictLatchRecord, (key: string) => string]> = [
    ...STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.killBackstop === true).map((caseRow) => [
      `CONFLICT (${caseRow.name}, SRJ-613's kill backstop)`,
      caseRow.build,
      (key: string) =>
        expectedLatchRecord(key, {
          latchCase: caseRow.latchCase,
          refusedOperation: caseRow.refusedOperation,
          rowState: caseRow.rowState,
          sessionName: caseRow.sessionName,
          description: caseRow.build().errDescription,
        }),
      () => caseRow.notice.text,
    ] as const),
    ...STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS.slice(0, 1).map((caseRow) => [`UNUSABLE NAME (${caseRow.name})`, caseRow.build, caseRow.record, caseRow.notice] as const),
  ]

  test.each(ABORT_KILL_LATCHES)('the abort kill answering %s: P latches with the row\'s record and one post; nothing is sent after the kill (no launch, delete or further call), and it is never tried again', async (_label, error, record, notice) => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(error())
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    expect(roundVerbsFrom(h, row, atB)).toEqual(['read-pane', 'find-missing', 'get', 'kill'])
    expect(h.latch.record(p)).toEqual(record(p))
    expect(otherNoticesOf(h, p)).toEqual([notice(p)])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED })

    await h.advance(2 * adLaunchBoundMsInEffect())
    await h.drive(h.settle())
    expect([row.callTimes('kill'), launchesOf(row), h.stub.calls.deleteCalls, heldPostsOf(h, p), otherNoticesOf(h, p).length]).toEqual([[atB], launches, [], [], 1])
  })

  // SRD hatch A2 and Q-12: the abort's kill is part of the round's attempt; a kill that did nothing is made again at the next retry reaching step 3.
  const ABORT_KILL_ATTEMPTS: ReadonlyArray<readonly [string, () => Error, (h: RecoveryHarness, p: string) => boolean]> = [
    ['ErrTmuxUnresponsive, a tmux-touching UNAVAILABLE: starts tmux-unresponsive', () => errTmuxUnresponsive('kill'), (h, p) => h.tmuxUnresponsive.holds(p)],
    ['ErrCallTimeout, UNAVAILABLE: arms its cause (SRJ-105)', () => errCallTimeout('kill'), (h, p) => h.triggers.some((t) => t.key === p && t.kind === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)],
  ]

  test.each(ABORT_ORIGINS.flatMap((origin) => ABORT_KILL_ATTEMPTS.map(([label, make, holds]) => [origin, label, make, holds] as const)))('from %s, the abort kill answering %s at each try: no alert, the abort not used, no launch; the next retry reaching step 3 makes the same abort with no second relaunching post', async (origin, _label, make, holds) => {
    const { h, p, row } = ownStuckLaunchOf({}, origin)
    row.scriptKill(...Array.from({ length: KILL_RETRY_TRIES }, make))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, origin)

    expect(row.callTimes('kill')).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => atB + i * KILL_RETRY_SPACING_MS))
    expect(holds(h, p)).toBe(true)
    expect([h.stuckLaunchAbortUsed(p), launchesOf(row), h.stub.calls.deleteCalls, abortAlertLinesOf(h, p), heldPostsOf(h, p)]).toEqual([false, launches, [], [], []])

    await retryDriven(h, p)
    expect(row.callTimes('kill')).toHaveLength(KILL_RETRY_TRIES + 1)
    expect(launchesOf(row)).toEqual([...launches, 'resume'])
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([[relaunchingTextOf(p)], [], true])
  })

  // AC 67, SRJ-111's ErrTmuxNotAvailable row: no abort while tmux-unavailable is raised; the same abort once it clears.
  test('the abort kill answering ErrTmuxNotAvailable: tmux-unavailable raised, one try, the abort not used; a retry whose lap keeps it raised makes no kill and no post; once a lap clears it, the same abort with no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(errTmuxNotAvailable(undefined, 'kill'))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    expect([row.callTimes('kill'), getOutageFlags(p).has('tmux-unavailable'), h.stuckLaunchAbortUsed(p)]).toEqual([[atB], true, false])

    failNextLapRead(h, p, () => errTmuxNotAvailable(undefined, 'read-pane'))
    await retryDriven(h, p)
    expect([row.callTimes('kill').length, getOutageFlags(p).has('tmux-unavailable'), heldPostsOf(h, p)]).toEqual([1, true, []])

    const clearedAt = await retryDriven(h, p)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(false)
    expect(row.callTimes('kill')).toEqual([atB, clearedAt])
    expect(launchesOf(row)).toEqual([...launches, 'resume'])
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p)]).toEqual([[relaunchingTextOf(p)], []])
  })

  // SRJ-316 (E12): a CONFIG answer raises ad-config-malformed, and the abort waits for it to clear.
  test('the abort kill answering CONFIG: ad-config-malformed raised, no further try, the abort not used and no launch; the next retry\'s reads clear it, and the same abort follows with no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(errConfigMalformed())
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    expect([row.callTimes('kill'), adConfigMalformedRaiseLines(h, p).length, h.stuckLaunchAbortUsed(p), launchesOf(row)]).toEqual([[atB], 1, false, launches])

    const retryAt = await retryDriven(h, p)
    expect(getOutageFlags(p).has('ad-config-malformed')).toBe(false)
    expect(row.callTimes('kill')).toEqual([atB, retryAt])
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([[relaunchingTextOf(p)], [], true])
  })

  // SRJ-702, SRJ-412: an abort kill SRJ-702's stop rule stopped uses up no abort and raises no alert.
  test('the abort kill\'s tries stopped because P stopped being up: no alert of either version, the abort not used; once P is up, the next retry reaching step 3 makes the same abort with no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(errTmuxUnresponsive('kill'))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)
    let stopsUp = true
    wrapModelKnob(h, 'killFn', (modelKill) => (params) => {
      if (stopsUp) h.setUp(p, false)
      return modelKill(params)
    })

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    expect(row.callTimes('kill')).toEqual([atB])
    // SRJ-702, SRJ-1014: the stop's one record, naming its cause and the last outcome's class; no alert text.
    const stoppedLine = killFailureStoppedRetryText({
      key: p,
      decision: { kind: KILL_RETRY_ALERT_NONE },
      context: KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
      lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE,
      stopCause: PERSONA_KILL_STOP_CAUSE_NOT_UP,
    }).line
    expect([abortAlertLinesOf(h, p), otherNoticesOf(h, p), h.killFailureOpen(p), h.stuckLaunchAbortUsed(p)]).toEqual([[stoppedLine], [], false, false])

    h.setUp(p, true)
    stopsUp = false
    const retryAt = await retryDriven(h, p)
    expect(row.callTimes('kill')).toEqual([atB, retryAt])
    expect([relaunchingPostsOf(h, p), h.stuckLaunchAbortUsed(p), launchesOf(row)]).toEqual([[relaunchingTextOf(p)], true, [...launches, 'resume']])
  })

  // SRJ-702, SRJ-704: a survivor-naming failure, then a non-success: the ordinary alert, once.
  test('the abort kill naming a survivor at its first try, then ErrTmuxUnresponsive: one ordinary alert with the stuck-launch abort context, quoting the survivor-naming description; the abort not used', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    const survivor = errTmuxKillFailed(personaTmuxSessionName(p), 'pane-process-survived')
    row.scriptKill(survivor, errTmuxUnresponsive('kill'), errTmuxUnresponsive('kill'))
    await launchOwnPending(h, row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    const alert = ordinaryAlertContent(p, { earlierSurvivor: survivor })
    expect(row.callTimes('kill')).toHaveLength(KILL_RETRY_TRIES)
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect(h.stuckLaunchAbortUsed(p)).toBe(false)
  })

  // AC 67: an own stuck launch at B while a lap's read-pane raised tmux-unavailable: neither text and no kill until it clears.
  test('an own stuck launch whose lap at the round reaching B raises tmux-unavailable: neither text and no kill; the next retry\'s lap clears it, and that round makes the relaunching post and the abort', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    await launchOwnPending(h, row)
    await retryUntilB(h, p, row)
    failNextLapRead(h, p, () => errTmuxNotAvailable(undefined, 'read-pane'))

    await retryDriven(h, p)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(true)
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), row.callTimes('kill')]).toEqual([[], [], []])

    const clearedAt = await retryDriven(h, p)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(false)
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), row.callTimes('kill')]).toEqual([[relaunchingTextOf(p)], [], [clearedAt]])
  })

  // SRJ-502: no abort for a latched P.
  test('an own stuck launch latched by its lap\'s read-pane CONFLICT at the round reaching B: no relaunching post and no kill, then or later', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    await launchOwnPending(h, row)
    await retryUntilB(h, p, row)
    failNextLapRead(h, p, () => errTmuxSessionConflict('read-pane', 'leftover', personaTmuxSessionName(p)))

    await retryDriven(h, p)
    h.controller.armPendingOnly(p)
    await h.advance(adLaunchBoundMsInEffect())
    await h.drive(h.settle())

    expect(h.latch.isLatched(p)).toBe(true)
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), row.callTimes('kill')]).toEqual([[], [], []])
  })

  // SRJ-412: the record is in memory only; a server restart forgets it.
  test('after a server restart the same pending row is no longer CSCB\'s own: at B the held post, no relaunching post and no kill', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    const launchStart = await launchOwnPending(h, row)
    await h.restartServer(p)
    row.scriptLaunches(errInstanceIdCollision())
    await h.launch(p)
    await h.settle()
    expect([row.launchStartedAt(), ownLaunchRecordOf(p)]).toEqual([launchStart, undefined])

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    await retryDriven(h, p)

    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, launchStart, false)])
    expect([relaunchingPostsOf(h, p), row.callTimes('kill')]).toEqual([[], []])
  })

  /** The model's row stays `pending` (its launch start kept) after each of its kills succeeds. */
  function keepPendingAfterKill(h: RecoveryHarness, row: PendingRowModel): void {
    wrapModelKnob(h, 'killFn', (modelKill) => (params) => {
      const answer = modelKill(params)
      if (params.claude_instance_id === row.instanceId) row.setState(AGENT_DIRECTOR_PENDING_STATE)
      return answer
    })
  }

  // SRJ-717 after the abort's kill: the sequence stops on an unjudged run; the abort is used; the held text once.
  test('the abort\'s sequence stopping at its first run that leaves the row pending in neither list (SRJ-717): no alert and no launch; the held text once at the next retry, and no further kill', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    await launchOwnPending(h, row)
    keepPendingAfterKill(h, row)
    const launches = launchesOf(row)
    const launchStart = row.launchStartedAt()

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)
    expect(roundVerbsFrom(h, row, atB)).toEqual(['read-pane', 'find-missing', 'get', 'kill', 'get', 'find-missing'])
    expect([launchesOf(row), abortAlertLinesOf(h, p), otherNoticesOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([launches, [], [], [], true])

    await retryDriven(h, p)
    await retryDriven(h, p)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, launchStart, false)])
    expect([row.callTimes('kill'), relaunchingPostsOf(h, p).length]).toEqual([[atB], 1])
  })

  // SRJ-705 step 5 with the abort's context.
  test('the abort\'s sequence reaching step 5 (the row still pending after runs that judged it and its step-4 kill): the ordinary alert with no description and the stuck-launch abort context; no launch', async () => {
    const { h, p, row } = ownStuckLaunchOf({ judgment: judgeUnverified })
    await launchOwnPending(h, row)
    keepPendingAfterKill(h, row)
    const launches = launchesOf(row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_APPROVER_STOP)

    const alert = ordinaryAlertContent(p)
    expect(row.callTimes('kill')).toHaveLength(2)
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect(launchesOf(row)).toEqual(launches)
  })

  // SRJ-404, hatch A3: the abort stops P's running approver first, with its own stop reason, and no rule run follows that stop.
  test('a retry reaching B while P\'s approver still runs (a test cap past B): the abort stops it with the stuck-launch-abort reason, no pending-row run follows that stop, and the kill and the resume follow', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY, { approverCapMs: 2 * adLaunchBoundMsInEffect() })
    await launchOwnPending(h, row)
    await retryUntilB(h, p, row)
    expect(h.approverRunning(p)).toBe(true)

    const atB = await retryDriven(h, p)

    expect(h.errors.filter((line) => line.includes(`(${APPROVER_STOP_STUCK_LAUNCH_ABORT})`))).toHaveLength(1)
    expect(ruleLinesOf(h, p, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP)).toEqual([])
    expect(row.callTimes('kill')).toEqual([atB])
    // The retry's own reads, then the rule's run and get with no lap (the approver ran), the kill and the sequence.
    expect(roundVerbsFrom(h, row, atB).slice(0, 9)).toEqual(['status', 'get', 'find-missing', 'get', 'kill', 'get', 'find-missing', 'get', 'resume'])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
  })
})

// ---------------------------------------------------------------------------
// SRJ-713: a failed launch's pending row waited out through the rule (recovery harness; b.jg5 SRJ-713, SRJ-111, SRJ-410, SRJ-412; AC 6, AC 30)
// ---------------------------------------------------------------------------

/** One launch of SRJ-713 (with HO rev 28's `resume` and reuse legs) that leaves P's row `pending`: P's row before it, the failing call and P's launch's answer. */
interface WaitedOutLaunch extends FailedLaunch {
  readonly name: string
  readonly before: PendingRowModelOptions
  readonly answer: Omit<SpawnPersonaResult, 'key'>
}

/** A LAUNCH FAILURE's answer: counted once, P's timer armed at once in pending-only mode (b.jg5 SRJ-602, SRJ-301). */
const COUNTED_LAUNCH_FAILURE: Omit<SpawnPersonaResult, 'key'> = { action: 'failed', countedClass: true, pendingOnlyArmed: true }

/** P's row `ended` with a session id, the start pass's plain spawn colliding with it, then `more` launch answers: P's launch is a `resume`, or after `ErrNoSessionId` a reuse spawn. */
const endedRowColliding = (...more: Error[]): PendingRowModelOptions => ({ state: LIVENESS_DEAD_ROW_ENDED, sessionId: OWN_SESSION_ID, launches: [errInstanceIdCollision(), ...more] })

const WAITED_OUT_LAUNCHES: readonly WaitedOutLaunch[] = [
  {
    name: 'a fresh plain spawn answering ErrTmuxSessionCreate',
    before: { state: PENDING_ROW_MODEL_NO_ROW },
    call: 'plain spawn',
    error: () => errTmuxSessionCreateStaysPending('spawn'),
    answer: COUNTED_LAUNCH_FAILURE,
  },
  {
    name: 'a plain spawn meeting "duplicate session" whose end write was not applied (ErrTmuxSessionCreate)',
    before: { state: PENDING_ROW_MODEL_NO_ROW },
    call: 'plain spawn',
    error: () => errTmuxSessionCreate('spawn'),
    answer: COUNTED_LAUNCH_FAILURE,
  },
  {
    name: 'a plain spawn whose re-lookup after "duplicate session" could not answer, its end write not applied (HO rev 26, ErrTmuxUnresponsive)',
    before: { state: PENDING_ROW_MODEL_NO_ROW },
    call: 'plain spawn',
    error: () => errTmuxUnresponsiveNewRowEnded('spawn'),
    answer: { action: SPAWN_ACTION_RETRYING },
  },
  {
    name: 'a resume answering ErrTmuxSessionCreate, its row not restored (HO rev 28)',
    before: endedRowColliding(),
    call: 'resume',
    error: () => errTmuxSessionCreateStaysPending('resume'),
    answer: COUNTED_LAUNCH_FAILURE,
  },
  {
    name: 'a reuse of a key that is not retired answering ErrTmuxSessionCreate, its row not restored (HO rev 28)',
    before: endedRowColliding(errNoSessionId()),
    call: 'reuse spawn',
    error: () => errTmuxSessionCreateStaysPending('spawn'),
    answer: COUNTED_LAUNCH_FAILURE,
  },
]

/** P's start-pass launch over `row`, its `launch.call` failing as `launch` says; answers the launch's result, once settled. */
async function launchFailing(h: RecoveryHarness, p: string, row: PendingRowModel, launch: FailedLaunch): Promise<SpawnPersonaResult> {
  failNextLaunch(h, row, launch)
  const result = await h.launch(p)
  await h.settle()
  return result
}

describe('SRJ-713: a failed launch\'s pending row, never CSCB\'s own, waited out through the rule until it reads missing (recovery harness; b.jg5 SRJ-713, SRJ-111, SRJ-410, SRJ-412; AC 6, AC 30)', () => {
  afterEach(cleanUpRuleHarness)

  test.each(WAITED_OUT_LAUNCHES.map((launch) => [launch.name, launch] as const))('%s: P\'s timer armed at once; never CSCB\'s own; runs only from G; at B one held post and never the relaunching post, an abort or a kill; nothing more counted; P brought up once the row reads missing; no "dispatcher bug"', async (_name, launch) => {
    const { h, p } = ruleHarnessOf({ harnessNow: true })
    const row = makePendingRowModel(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, ...launch.before })
    const starts = recordSequenceStarts()

    expect(await launchFailing(h, p, row, launch)).toStrictEqual({ key: p, ...launch.answer })

    // Armed at once over the pending row, with no approver; the failed call's window has no end, so no own-launch record.
    expect([row.state(), h.controller.isArmed(p), h.approverRunning(p)]).toEqual([AGENT_DIRECTOR_PENDING_STATE, true, false])
    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW })
    expect(launchCallWindowOf(p)?.end).toBeUndefined()
    expect([ownLaunchRecordOf(p), isCscbOwnLaunch(p, row.launchStartedAt())]).toEqual([undefined, false])
    const launchStartMs = row.launchStartMs()!
    const launches = launchesOf(row)
    const noticesBefore = noticesOf(h, p).length

    const rounds: RuleRound[] = []
    while (rounds.length === 0 || rounds.at(-1)!.at < launchStartMs + adLaunchBoundMsInEffect()) rounds.push(...(await runRounds(h, p, row, 1)))
    rounds.push(...(await runRounds(h, p, row, 1)))

    expect(rounds.some((round) => round.at < launchStartMs + adGraceMsInEffect())).toBe(true)
    for (const round of rounds) expect(round.verbs.includes('find-missing')).toBe(round.at >= launchStartMs + adGraceMsInEffect())
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + adLaunchBoundMsInEffect() ? 1 : 0)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    // From the failure on, the held post is P's only post: no relaunching post, alert or other notice.
    expect(noticesOf(h, p).slice(noticesBefore)).toEqual(heldPostsOf(h, p))
    expect([launchesOf(row), row.callTimes('kill'), starts, h.stuckLaunchAbortUsed(p), getFailureCount(p)]).toEqual([launches, [], [], false, 0])

    // Marked missing: the retry hands P to the restart path's decision, which brings P up with no kill.
    row.setJudgment(judgeMissingFrom(h.clock.now()))
    await retryNow(h, p)
    expect(launchesOf(row)).toHaveLength(launches.length + 1)
    expect([row.state(), row.callTimes('kill'), getFailureCount(p)]).toEqual([AGENT_DIRECTOR_PENDING_STATE, [], 0])
    expect(row.launchStartMs()).toBeGreaterThan(launchStartMs)
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })

  test('an attempt that spawns while a failed fresh spawn\'s row waits collides, and its get reads the same covered pending row: no second launch, nothing counted or posted, the row still waited out', async () => {
    const { h, p } = ruleHarnessOf({ harnessNow: true })
    const [freshSpawn] = WAITED_OUT_LAUNCHES
    const row = makePendingRowModel(h, p, { dialog: PENDING_ROW_DIALOG_UNRECOGNISED, ...freshSpawn!.before })
    await launchFailing(h, p, row, freshSpawn!)
    await runRounds(h, p, row, 1)
    const launchStart = row.launchStartedAt()
    const fromCalls = row.calls.length
    const noticesBefore = noticesOf(h, p).length
    row.scriptLaunches(errInstanceIdCollision())

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'no-op' })
    await h.settle()

    expect(row.calls.slice(fromCalls).map((call) => call.verb)).toEqual(['spawn', 'get'])
    expect([row.launchStartedAt(), getFailureCount(p), noticesOf(h, p).slice(noticesBefore), h.approverRunning(p)]).toEqual([launchStart, 0, [], false])
    expectPendingOnlyWatch(h, p)
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })

  test('HO rev 18: a lost-reply row (its launch call timed out) marked missing past G, before B, by the rule\'s run: that step hands P to the restart decision, whose get-then-act resumes the row, keeping its conversation; no kill, no post, nothing counted', async () => {
    const { h, p } = ruleHarnessOf({ harnessNow: true })
    const row = makePendingRowModel(h, p, { ...PLAIN_SPAWN_LAUNCH, sessionId: OWN_SESSION_ID, dialog: PENDING_ROW_DIALOG_UNRECOGNISED, judgment: judgeMissingFromG() })
    scriptModelLaunch(h, row, { end: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })
    await h.launch(p)
    await h.settle()
    const launchStartMs = row.launchStartMs()!
    // agent-director answers the restart path's plain spawn of the finished row with a collision.
    row.scriptLaunches(errInstanceIdCollision())

    const rounds: RuleRound[] = []
    while (h.stub.calls.resumeCalls.length === 0 && rounds.length < 12) rounds.push(...(await runRounds(h, p, row, 1)))

    const recovered = rounds.at(-1)!
    expect(recovered.at).toBeGreaterThanOrEqual(launchStartMs + adGraceMsInEffect())
    expect(recovered.at).toBeLessThan(launchStartMs + adLaunchBoundMsInEffect())
    // The round's lap, run and get read the row missing; then the restart decision's plain spawn collides, its get reads the row and it resumes.
    expect(recovered.verbs.slice(0, LAP_RUN_ROUND.length + 3)).toEqual([...LAP_RUN_ROUND, 'spawn', 'get', 'resume'])
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: row.instanceId }])
    expect([row.getRow().claude_session_id, h.reuseSpawns(), row.callTimes('kill')]).toEqual([OWN_SESSION_ID, [], []])
    expect([heldPostsOf(h, p), relaunchingPostsOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })
})
