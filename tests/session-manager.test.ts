/**
 * session-manager.test.ts — Library-backed session-manager tests.
 *
 * Replaces the deleted tmux-direct test suite. Drives spawnForPersona via the
 * agent-director-stub (no real FFI). Coverage:
 *
 *   - Fresh-spawn happy path: emits SpawnParams matching SR-1.1 and the
 *     persona identity of b.av2 SR-2.2 (relay_mode='on', template name,
 *     `cscb_<key>` / `slack_bot_<key>`, the `service` / `persona` /
 *     `config_dir` labels plus the interim `channel` label, and the persona
 *     spawn environment).
 *   - The real-path `config_dir` label (b.av2 SR-1.5, SR-2.2).
 *   - AC 3: one persona listed in two channels is spawned exactly once.
 *   - SR-1.4 idempotency: ErrInstanceIdCollision → client.get(); each state
 *     drives the documented branch. Collision fixtures build their row for
 *     the persona under test (`personaRow`), so its `cwd` and `config_dir`
 *     label match and each case stays on the path it tests.
 *   - b.jg5 SRJ-104: a `resume` rejecting with ErrInvalidFlags makes exactly
 *     one immediate version re-check (the real installed re-check over a
 *     counting stub `resolveSystemBinary` and an unmoved fake clock), logs one
 *     UNCLASSIFIED line and kills, deletes, spawns and resumes nothing more;
 *     an ErrNoSessionId makes no re-check. A re-check that answers stop posts
 *     no spawn-failure notice, answers `{ failed, stopping }` and makes
 *     `launchSession` answer `'skipped'`; after a pass or could-not-run it
 *     takes SRJ-105's UNCLASSIFIED row (b.jg5 SRJ-313, on
 *     `makeRecoveryHarness`): no notice, one refusal line, `{ failed,
 *     refused }`, the timer armed with the UNCLASSIFIED cause, never counted,
 *     and reported once (over recording sinks: exactly once, with the site's
 *     classification) to the persona's unclassified-error episode.
 *   - b.jg5 SRJ-313 (SRJ-105's UNCLASSIFIED row, AC 69), on
 *     `makeRecoveryHarness`: every spawn, resume, kill, delete, reconnect
 *     keystroke and findMissing sweep of the ladder, fed an `ErrInternal`
 *     (not the unusable recorded name) and an unhandled name, and every
 *     action site fed `ErrSystemInstallDisappeared` (which still raises
 *     `ad-unreachable`), is refused as an UNAVAILABLE outcome is, arms the
 *     timer with the UNCLASSIFIED cause, never starts the condition, and is
 *     reported to the persona's unclassified-error episode (B's untouched);
 *     an `ErrInternal` at a read keeps the read-error cause and is reported
 *     too. Over recording sinks, each such outcome is handed to the sink
 *     exactly once and arms once; outside an attempt nothing is reported.
 *     The `errGeneric` cases whose point is a launch failure use the LAUNCH
 *     FAILURE answer (`ErrTmuxSessionCreate`), and a findMissing rejection
 *     the launch proceeds past is an UNUSABLE NAME answer (a sweep is not a
 *     verb on the persona's own row, so it latches no one).
 *   - b.jg5 SRJ-301 / SRJ-302 launch attempt: with a trigger sink installed
 *     through `initOutageState` (a recording sink, or the real
 *     `createUnavailableRetryController` on a fake clock, stopped in
 *     afterEach with nothing pending and nothing run), an UNAVAILABLE spawn
 *     and an UNCLASSIFIED collision `get` arm the persona's timer and mark the
 *     failed launch refused (`launchSession` answers `'refused'`); a LAUNCH
 *     FAILURE or DIRECTORY spawn, or no sink at all, marks nothing
 *     (`launchSession` false); a joiner shares the marker; a start pass with
 *     one UNAVAILABLE persona tallies as before and arms only that persona.
 *   - b.jg5 SRJ-105 (AC 25), on `makeRecoveryHarness`: every spawn, resume,
 *     replacement kill and delete, and reconnect keystroke (first try and the
 *     `ErrTmuxSendKeys` retry) of the ladder, fed `ErrUnknownErrorName`,
 *     `ErrCallTimeout`, a wrapped `UnknownError`, `ErrTmuxUnresponsive` and
 *     (at kills and deletes) `ErrTmuxKillFailed`, makes no kill, delete or
 *     launch after it and no dead-session resume, posts no spawn-failure
 *     notice, records no `spawn-failed` entry, answers `{ failed, refused }`
 *     (`launchSession` `'refused'`) and is never counted; B launches as
 *     before. The read-error row: the collision `get` and the working-row
 *     wait's poll and timeout `status`, fed those forms, an UNCLASSIFIED read
 *     error and a store that cannot be opened, likewise, and start no
 *     condition; `ErrSpawnNotFound` keeps each site's meaning, and is the
 *     only answer that still reaches the timeout's tmux fallback.
 *     SRJ-105's CONFIG row (b.jg5 SRJ-316): every one of those sites, and
 *     each findMissing sweep, fed `ErrConfigMalformed`, is refused the same
 *     way, arms P's timer with the CONFIG cause, starts no condition, never
 *     reaches the tmux fallback or the inconclusive report, and raises P's
 *     `ad-config-malformed` with one onset. E8's hatch note: a refused kill
 *     (UNAVAILABLE or CONFIG) on each replace path is
 *     followed by no delete or launch, also through the restart path's retry
 *     (`runRestartRetry`), with the failure count at 0. The
 *     `ErrSpawnNotResumable` kill is declared a kill of a row read live. The
 *     approver's pane read and Enter, the working-row pane read and the
 *     persona teardown's kill keep their outcomes. At most one onset across
 *     several retries past the floor; none for a refusal that clears, or for
 *     `ErrTmuxKillFailed`.
 *   - b.jg5 SRJ-105's CONFLICT row, SRJ-501, SRJ-502, SRJ-111, SRJ-113,
 *     SRJ-1015 (AC 7's unit half), on `makeRecoveryHarness` with its latch
 *     composed as `main()` composes it: every spawn and resume of the
 *     ladder, fed each case-table row for its verb
 *     (`tests/test-helpers/conflict-cases.ts`), latches P with the row's case
 *     and session, the site's refused operation and the state the path last
 *     read (one latch-time `status` read where it read nothing, none added
 *     where it did); the refused call is the last; the holds run before one
 *     CONFLICT notice; nothing counted, posted as a spawn failure or recorded
 *     `spawn-failed`. A latched P is launched by no path (`spawnForPersona`
 *     either way, `launchSession` `'skipped'`, the start pass) with no
 *     agent-director call or trust patch; B launches. A failing latch-time
 *     read records an unreadable state and its timer and episode are ended
 *     by the holds. With no latch installed a CONFLICT still answers
 *     `latched` and latches nothing; a latch the gate cannot read is taken as
 *     latched; a latch whose set throws still answers `latched`.
 *   - b.jg5 SRJ-105's UNUSABLE NAME row, SRJ-512 (E16), on
 *     `makeRecoveryHarness`: an UNUSABLE NAME answer, each fault of the
 *     case table's rows for the site (`UNUSABLE_NAME_CASE_ROWS`), at every
 *     ladder spawn and `resume`, at the ladder's kill and delete, at the
 *     working-pane read (the launch wait's evidence read, `checkWorkingRowPane`
 *     → `defer`, `checkWaitingRowPane` → `defer`, never `reconnect`), at the
 *     shared own-row `status` read (its four answers; the wait's poll and
 *     timeout, `reconcileAndReadRowState`, the retry timer's row read, the
 *     latch-time read, which records unreadable and reads once) and at E14's
 *     shared own-row `get` read (the collision `get`, the ErrJsonlMissing
 *     diagnosis `get`, the transcript `get`, the post-run `get` after
 *     `unverified_ids`) latches P with "unusable recorded name", "none" and
 *     the state its path last read; nothing is called after it, raw tmux
 *     included; nothing counted, no spawn-failure notice, `spawn-failed`
 *     entry, `tmux-unresponsive` onset or unclassified episode; one SRJ-1019
 *     post; B launches. Controls: a phrase-less `ErrInternal` keeps E12's
 *     UNCLASSIFIED handling, and the persona teardown's kill and delete
 *     rethrow and latch nothing.
 *   - b.jg5 SRJ-513, SRJ-1020 (E16 T2), with SRJ-114's and SRJ-115's sites,
 *     on `makeRecoveryHarness`: a configured persona's own row reading
 *     `pending` with no launch start (`LAUNCH_START_CASE_ROWS`: absent,
 *     `null` or unparseable; P's current life, another `cwd`, another
 *     `config_dir` label) at E14's four `get` sites and at the shared
 *     own-row `status` read's sites latches P with "launch start not
 *     recorded", "none" and `pending`; nothing is called after that read, raw
 *     tmux included; one SRJ-1020 post; at the latch-time read that latch
 *     stands alone (no CONFLICT or UNUSABLE NAME latch or post on top).
 *     Controls: the same row with a launch start keeps today's `pending`
 *     branch, a key the configured-persona query does not hold latches no
 *     one, and the permission poller's and the JSONL persistence
 *     safeguard's `get`s (SRJ-122) latch and post nothing.
 *   - b.jg5 SRJ-303 / SRJ-115 the retry timer's row read
 *     (`readPersonaRowState`): one `status` call for `cscb_<key>` and no
 *     other, answering each state as is (`pending` included), a `pending`
 *     row's launch start raw and no launch start for any other state or for a
 *     missing, `null` or empty one, `absent` for
 *     `ErrSpawnNotFound` (by name), and any other error rethrown as the same
 *     value, quietly; through the outage wrapper (flags raised and cleared as
 *     for any wrapped `status`; an error reported to a recording sink only
 *     inside a recovery attempt for that persona, with the predicate's cause).
 *   - b.av2 SR-6.2 ladder guards: a row in another directory (by real path) is
 *     killed, deleted and spawned fresh on every path; a missing or changed
 *     `config_dir` label means a fresh spawn instead of a resume (AC 48).
 *   - b.av2 SR-6.3: the fixed instance ID, one launch in flight per persona,
 *     and the start sweep (`reconcileOrphans`) keyed by the `persona` label
 *     (AC 4). b.1ix: a pre-persona row (no `persona` label) is kept, never
 *     deleted, and killed only when live; one findMissing sweep after the
 *     kills lets a killed row whose session is gone read `missing`, so the
 *     next start doesn't kill it again.
 *   - b.1ix raw tmux: through the tmux runner seam (`_setTmuxCommandRunner`,
 *     a failing stand-in by default, so no test reaches a real tmux server),
 *     the b.vub kill and the liveness probe target the persona's own session
 *     exactly, never a prefix neighbour (`slack_bot_dev` / `slack_bot_dev_2`).
 *   - b.4ie / b.jg5 SRJ-402 startup-dialog approver, through agent-director
 *     only, on a fake clock (`_setApproverClock`, `useApproverClock`): a
 *     fresh or resumed row reading `pending` with either dialog is cleared
 *     with one `readPane` (40 lines, `allow_pending`) and one `sendKeys`
 *     (empty text, `allow_pending`) on the persona's instance, and a
 *     recording tmux runner records no call (AC 34, AC 48); `ended` or
 *     `missing` at the first lap stops it at once with no pane read, the
 *     spawn-died entry written once for a start-pass launch only and the
 *     launch result unchanged; a row leaving `pending` for `missing` between
 *     laps (b.dup) stops it at the next lap; the cap, the restart path's
 *     silence and the redacted error lines (AC 20).
 *   - b.jg5 SRJ-401: every spawn or `resume` of the ladder that returns
 *     success, `launchSession`'s included, starts the approver on its own:
 *     the launch returns its own result, with the approver's fake clock held,
 *     while the approver runs, with no launch in flight and the launch
 *     settled, and the approver's `status` and `read-pane` follow the launch
 *     call on the persona's row; no other branch, result or dry run starts
 *     one; a stop made while the launch is in flight cancels the approver
 *     that launch would start. On `makeRecoveryHarness`, its calls are
 *     outside the launch attempt: an UNAVAILABLE or UNCLASSIFIED answer to its
 *     `status`, `read-pane` or `send-keys` arms nothing and starts or opens
 *     nothing, while ENVIRONMENT and CONFIG raise their outages and arm.
 *   - b.av2 SR-6.1 start: `startupSessionManager` with `bringUp` (a persona
 *     not brought up is counted apart; every Slack bring-up runs at once and
 *     only the launches share the pool, in readiness order; a launch that
 *     throws is one failed persona), and `launchSession`'s relaunch gate
 *     (`canLaunch` false → `'skipped'`, nothing launched or patched), asked
 *     before the key is looked up.
 *   - b.av2 SR-8.6: a key outside the applied set, refused by the real
 *     relaunch gate over a live applied set, is `'skipped'` with no
 *     agent-director call, trust patch or reply-guard record, whether or not
 *     the config passed still holds it; an applied key launches as before.
 *   - b.av2 SR-6.2 pre-launch trust patch: through the injectable seam
 *     (`setPreLaunchTrustPatcher`, empty by default and reset in afterEach,
 *     so no test installs the production patch or writes a `.claude.json`),
 *     once per ladder, before its first spawn or resume, on every launch path;
 *     never in dry run or for a joining caller; a throw is only logged.
 *   - b.av2 SR-9.4 / SR-6.2 pre-launch reply guard: the real
 *     `preLaunchReplyGuard`, installed with `setPreLaunchReplyGuard` over a
 *     `mkdtempSync` state directory (the seam and the launched-with dirs are
 *     reset in afterEach, so no other test writes a record). The persona's
 *     record holds its effective value, and the managed hook is in place,
 *     immediately before every spawn and resume, at each call site that
 *     makes one (one row per site, plus the ticket's named paths); a live
 *     or no-op row and dry run launch nothing, and the optimistic spawn's step
 *     is undone on ErrInstanceIdCollision (E10 Director decision 9); an
 *     unwritable record is one log line and the launch goes on.
 *   - b.av2 SR-7.4 transcript-loss diagnosis: only the persona's
 *     `delivery: all` channels are counted, and a zero count is inconclusive
 *     for a persona with a `mentions` channel or DMs on.
 *   - SR-8.6 invariant: every successful spawn call site passes
 *     relay_mode='on'.
 *   - b.svb / b.f2b: every spawn on every launch path carries
 *     `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` in `extra_env`, and a
 *     resume passes only the instance ID (agent-director restores the env
 *     stored at the row's spawn, modelled in one case).
 *   - Persona notices (b.av2 SR-7.2): spawn failure (generic, dialog-approval
 *     timeout, self-heal failure, restart cap), lost and inconclusive history,
 *     held-until-validated notices (channel and `dm` destinations) and the
 *     `spawn-failure-post` startup error and restart-path stderr line, whose
 *     cause names a failed DM open's step and code,
 *     through the real per-persona notifier installed with
 *     `setSessionNotifier`. A failed post or DM open is held by the
 *     destination hold (b.av2 SR-7.1), on a fake clock: one
 *     `persona-destination-failed` line per episode, retries on the SR-3.2
 *     backoff, delivery in raised order once the cause clears, and the
 *     failure callback run once per notice, not per retry.
 *   - b.dup: a reconnect whose keystrokes agent-director refuses
 *     (ErrSpawnNotInteractive) because a findMissing sweep ended the row
 *     after it was read is a dead session, recovered through resume with no
 *     `[spawn-failed]` entry or notice, at a launch's `waiting` row (the live
 *     race: another persona's wait sweeps) and in each reconnect of the wait.
 *   - b.jdc: a launch that meets an `ask_user` or `check_permission` row
 *     probes the persona's own tmux session exactly and, when it is gone,
 *     sweeps and resumes the persona once its row reads dead; the restart
 *     path's run of deferrals on such a row (`checkPromptRowDeferral`)
 *     sweeps from 10 min on; the escalate-dead line is worded by its verdict.
 *   - b.f2b stale `working` rows: how a pane read is classified (a Linux
 *     screen's `●` reply and tool lines are not a spinner; a custom spinner
 *     verb of several words is) and folded into evidence, the restart path's
 *     evidence across reconnect attempts (`checkWorkingRowPane`), the
 *     once-per-episode not-connected notice, the unproven-idle notice once
 *     deferrals on a `working` row have run for 10 min at any restart delay,
 *     the wait at a launch reconnecting a stale row within 60 s (never typing
 *     into a running turn or a prompt) and giving up honestly
 *     (`not-reconnected`, the notice at `session_restart_delay` 0), and the
 *     start pass leaving a launch that waits on a `working` row in flight in
 *     the background. These
 *     cases pass a fake clock's `now` to the session manager's clock seam
 *     (`_setNow`, reset in afterEach) and build their screens and transcripts
 *     from `tests/test-helpers/working-row-panes.ts`.
 *
 * Most blocks use a stand-in persona keyed by its channel ID
 * (`makeStandInPersonaConfig`), so their `cscb_<channelId>` ids and outage
 * keys stay short and fixed. Every test gets a bare notice capture
 * (`notices`); the notice-routing cases replace it with the real notifier
 * over a two-persona config whose notice persona's name, key and destination
 * all differ.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  reconcileOrphans,
  reconnectMcp,
  waitForWaitingAndReconnect,
  approvePreSessionDialogs,
  spawnForPersona,
  startupSessionManager,
  launchSession,
  personaConfigDirLabelValue,
  AGENT_DIRECTOR_LIVE_STATES,
  DEV_CHANNELS_DIALOG_NEEDLE,
  TRUST_DIALOG_NEEDLE,
  _setDialogReadyTimeoutMs,
  _resetDialogReadyTimeoutMs,
  _setWaitForWaitingTimeoutMs,
  _resetWaitForWaitingTimeoutMs,
  _setFindMissingMemoTtlMs,
  _resetFindMissingMemo,
  bypassingFindMissingSweep,
  readFindMissingRow,
  FIND_MISSING_LATCHED,
  FIND_MISSING_MEMO_TTL_MS,
  FIND_MISSING_REFUSED,
  FIND_MISSING_ROW_JUDGED_ALIVE,
  FIND_MISSING_ROW_LEFT_LIVE,
  FIND_MISSING_ROW_MARKED_MISSING,
  FIND_MISSING_ROW_NOT_JUDGED,
  type FindMissingRowReading,
  sweepDeadTmuxChannel,
  _setTmuxSessionKiller,
  _resetTmuxSessionKiller,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setTmuxCommandRunner,
  _resetTmuxCommandRunner,
  hasPersonaTmuxSession,
  type TmuxCommandRunner,
  _setApproverClock,
  _resetApproverClock,
  _whenDialogApproverStopped,
  isDialogApproverRunning,
  stopDialogApprover,
  approverNotStartedMessage,
  APPROVER_STOP_TEARDOWN,
  type ApproverOutcome,
  DIALOG_POLL_INTERVAL_MS,
  APPROVER_LOG_PREFIX,
  APPROVER_PANE_LINES,
  APPROVER_STOP_CAP,
  APPROVER_STOP_FINISHED,
  APPROVER_STOP_LIVE,
  STARTUP_ERROR_APPROVE_NOT_READY,
  STARTUP_ERROR_APPROVE_SPAWN_DIED,
  approverCapMessage,
  approverFinishedMessage,
  approverLogLine,
  approverPaneCallFailedMessage,
  approverStatusRefusedMessage,
  type ApproverStopReason,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  checkLaunchConfigDir,
  _resetInFlightLaunches,
  isLaunchInFlight,
  compareRowToPersona,
  setSessionNotifier,
  notifySpawnFailure,
  notifyRestartCapReached,
  setPreLaunchTrustPatcher,
  _resetPreLaunchTrustPatcher,
  _resetPreLaunchReplyGuard,
  setPreLaunchReplyGuard,
  killPersonaInstance,
  deletePersonaInstance,
  readPersonaRowState,
  whenLaunchSettled,
  ConfigDirUnresolvableError,
  _setConfigDirFs,
  _resetConfigDirFs,
  setConfigDirUnresolvableHook,
  STALE_WORKING_WINDOW_MS,
  UNPROVEN_IDLE_NOTICE_AFTER_MS,
  WAIT_FOR_WAITING_TIMEOUT_MS,
  _resetNow,
  _setNow,
  _resetNotConnectedEpisodes,
  _resetUnprovenIdleNoticeAfterMs,
  _setUnprovenIdleNoticeAfterMs,
  cancelWorkingRowWait,
  checkPromptRowDeferral,
  PROMPT_ROW_SWEEP_AFTER_MS,
  checkWaitingRowPane,
  checkWorkingRowPane,
  classifyWorkingPane,
  foldWorkingPaneRun,
  endWorkingRowDeferral,
  forgetNotConnectedEpisode,
  hasPendingWorkingRowEvidence,
  noteWorkingRowDeferral,
  notifyDisconnectedWithAutoRestartDisabled,
  notifyPersonaNotConnected,
  setConflictLatch,
  _resetConfiguredPersonaQuery,
  setConfiguredPersonaQuery,
  readPersonaOwnRow,
  readPersonaOwnRowStatus,
  OWN_ROW_READ_ROW,
  OWN_ROW_STATUS_ABSENT,
  OWN_ROW_STATUS_LATCHED,
  OWN_ROW_STATUS_REFUSED,
  OWN_ROW_STATUS_STATE,
  WAIT_OUTCOME_LATCHED,
  type OwnRowReadSite,
  type SessionConflictLatch,
  type ConfigDirUnresolvableHook,
  type NotConnectedNotice,
  type SpawnPersonaResult,
  type StartupPersonaOutcome,
  type UndeliverableCause,
  type WorkingPaneReading,
  type WorkingPaneRun,
} from '../src/session-manager.ts'
import type { TranscriptReading, TranscriptSnapshot } from '../src/session-transcript.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { stripComments } from './test-helpers/source-audit.ts'
import {
  _resetLaunchedWithDirs,
  getLaunchedWithDir,
  managedHookCommand,
  preLaunchReplyGuard,
} from '../src/stop-hook-bootstrap.ts'
import { makeReplyGuardRecordDir, type ReplyGuardRecordDir } from './test-helpers/reply-guard-record.ts'
import { installRecordingReplyGuard, observeLaunchCalls, type LaunchCall } from './test-helpers/reply-guard-launch.ts'
import { UNATTRIBUTABLE_ZERO_REASON, runJsonlPersistenceSafeguard } from '../src/jsonl-persistence-check.ts'
import { _resetPollerState, stopPermissionPoller, type PollerDeps } from '../src/permission-poller.ts'
import { makePersonaClients, makeTrailCapture, posts, startManualPoller } from './test-helpers/permission-relay-harness.ts'
import { resolveJsonlPath } from '../src/cozempic.ts'
import type { PersonaNoticeOptions } from '../src/persona-notifier.ts'
import type { PersonaDestinationHold } from '../src/persona-destination-hold.ts'
import { PERSONA_CONFIG_DIR_UNRESOLVABLE, PERSONA_DESTINATION_FAILED } from '../src/persona-diagnostics.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  makeDeferredConnect,
  makeStubSlack,
  openedDm,
  type DeferredConnect,
  type StubSlackOptions,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import type { PersonaConnectionManager, PersonaConnectionStatus } from '../src/persona-connections.ts'
import { createPersonaRelaunchGate, type PersonaBringUpStep } from '../src/persona-start.ts'
import {
  createPersonaBringUpController,
  type PersonaBringUpController,
  type PersonaBringUpOutcome,
} from '../src/persona-bringup-controller.ts'
import { makeConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
  writtenFile,
} from './test-helpers/credentials.ts'
import { MCP_SERVER_NAME, type Persona, type PersonaConfig, resolveRealPath } from '../src/config.ts'
import { PERSONA_INSTANCE_ID_PREFIX, configDirLabelValue, personaInstanceId, personaKey, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import { resetClientForTests, setClientForTests, getClient } from '../src/agent-director-client.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedPermissionRequest,
  cannedStatusResult,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  cannedFindMissing,
  cannedOk,
  cannedErr,
  errInstanceIdCollision,
  errNoSessionId,
  errJsonlMissing,
  errJsonlNeverWritten,
  errSpawnNotFound,
  errSpawnNotResumable,
  errGeneric,
  errSpawnNotInteractive,
  errTmuxSendKeys,
  errTmuxSessionCreate,
  errInvalidFlags,
  errInternal,
  errTmuxUnresponsive,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errConfigMalformed,
  errUnusableName,
  errSchemaMismatch,
  errSystemInstallDisappeared,
  errUnknownErrorName,
  holdSpawns,
  makeStubCallLog,
  makeStubClient,
  makeStubResolveSystemBinary,
  nonLatchingNotes,
  provenanceNote,
  stubCallCount,
  unknownNote,
  type CannedGetResult,
  type CannedResponse,
  type FindMissingRowPlacement,
  type PersonaGetResultOverrides,
  type StubClient,
  type StubClientOptions,
  type StubResolveSystemBinaryOutcome,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import { buildTempArchiveDb, messagesSince } from './test-helpers/archive-db.ts'
import {
  CUSTOM_VERB_SPINNER_PANE,
  DEV_CHANNELS_DIALOG_PANE,
  IDLE_PANE,
  LINUX_IDLE_PANE,
  MCP_SERVER_DIALOG_PANE,
  MODEL_PICKER_PANE,
  OTHER_IDLE_PANE,
  PERMISSION_PANE,
  PLAN_APPROVAL_PANE,
  QUOTED_DIALOG_PANE,
  QUOTED_MENU_PANE,
  SELECT_MENU_PANE,
  SPINNER_PANE,
  TRANSCRIPT_SESSION_ID,
  TRUST_DIALOG_PANE,
  appendTranscript,
  endedTurn,
  linuxWithLastLine,
  promptEntry,
  queuedPromptEntry,
  toolResultEntry,
  toolUseEntry,
  withLastLine,
  writeTranscript,
  type TranscriptEntry,
} from './test-helpers/working-row-panes.ts'
import {
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  ALL_CLEAR_TEMPLATE,
  ONSET_TEMPLATES,
  tmuxServerChangedOnset,
  adConfigMalformedOnset,
  _resetOutageState,
  type OutageClass,
} from '../src/outage-state.ts'
import {
  AgentDirectorError,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrJsonlMissing,
  ErrSpawnNotFound,
} from '../src/agent-director-errors.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { UNUSABLE_RECORDED_NAME_PHRASE } from '../src/ad-description-phrases.ts'
import { RESTART_FAILURE_CAP, RESTART_OUTCOME_REFUSED, runRestartRetry, type LaunchSessionResult } from '../src/restart.ts'
import { AD_ERROR_CLASS_UNCLASSIFIED, describeAdErrorClassification, describeAgentDirectorFailure } from '../src/ad-error-class.ts'
import type { UnclassifiedErrorSink } from '../src/persona-episodes.ts'
import { getFailureCount } from '../src/backoff.ts'
import {
  adConfigMalformedRaiseLines,
  collided,
  conditionStartedLines,
  makeRecoveryHarness,
  personaOf as harnessPersona,
  recordCallOrder,
  retryNow,
  unclassifiedLinePrefix,
  unclassifiedStartedLine,
  unclassifiedStartedLines,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryRowState,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import {
  CONFLICT_CASE_ROWS,
  LAUNCH_START_AND_NOTE_ROW,
  LAUNCH_START_CASE_ROWS,
  LAUNCH_START_NON_LATCHING_ROWS,
  UNUSABLE_NAME_CASE_ROWS,
  expectedConflictNotice,
  expectedLatchRecord,
  type ConflictCaseRow,
  type LaunchStartCaseRow,
  type LaunchStartCaseRowOf,
  type LaunchStartNonLatchingRowOf,
  type LaunchStartReadShape,
  type UnusableNameCaseRow,
  type UnusableNameSite,
} from './test-helpers/conflict-cases.ts'
import {
  CONFLICT_LATCH_SET_LATCHED,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_KIND_READ,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  createConflictLatch,
  describeLatchRowState,
  latchRowStateRead,
  type ConflictLatch,
  type ConflictLatchRecord,
  type ConflictLatchSetInput,
  type LatchRowState,
  type RefusedOperation,
} from '../src/conflict-latch.ts'
import {
  installAdVersionRecheck,
  RECHECK_OUTCOME_COULD_NOT_RUN,
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  createUnavailableRetryController,
  runInAttempt,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  type AttemptView,
  type UnavailableRetryController,
  type UnavailableRetryRowRead,
  type UnavailableRetryTriggerSink,
} from '../src/unavailable-retry.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import type { Phase1StatusResult } from '../src/ad-phase1-types.ts'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function installStub(opts?: Parameters<typeof makeStubClient>[0]): StubClient {
  const stub = makeStubClient(opts)
  setClientForTests(stub as unknown as Parameters<typeof setClientForTests>[0])
  return stub
}

/**
 * Per-test temp directory: `baseDir` for the persona fixtures and the parent
 * of any working, config or home directory a test creates. Removed in afterEach.
 */
let fixtureDir: string

/** The applied persona with `key`; fails the test when there is none. */
function personaOf(config: PersonaConfig, key: string): Persona {
  const persona = config.personas.find((p) => p.key === key)
  if (!persona) throw new Error(`test fixture has no persona with key ${key}`)
  return persona
}

/**
 * Point SLACK_STATE_DIR at `<fixtureDir>/state` for this test and return a
 * reader for the startup-errors.log recorded there. The directory goes with
 * fixtureDir in afterEach, which also restores the environment.
 */
function captureStartupErrors(): () => string {
  const dir = join(fixtureDir, 'state')
  process.env['SLACK_STATE_DIR'] = dir
  const logPath = join(dir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

/**
 * Create a temp home `<fixtureDir>/<name>` holding `.claude` and make the spawn
 * path resolve an unset claude_config_dir against it (`_setSpawnHomeDir`,
 * reset in afterEach), so no label depends on the process home. Returns it.
 */
function useSpawnHome(name = 'home'): string {
  const home = fixtureSubdir(name)
  mkdirSync(join(home, '.claude'))
  _setSpawnHomeDir(home)
  seamHome = home
  return home
}

/**
 * Replace `<home>/.claude` with a symlink to a new directory under the fixture
 * dir and return that directory's real path (what a spawn's `config_dir`
 * label is computed from).
 */
function linkClaudeDir(home: string): string {
  const target = fixtureSubdir('claude-dir-target')
  rmSync(join(home, '.claude'), { recursive: true, force: true })
  symlinkSync(target, join(home, '.claude'))
  return realpathSync(target)
}

/** The home the latest `useSpawnHome` of this test installed; cleared in beforeEach. */
let seamHome: string | undefined

/** This test's seam home, created with `useSpawnHome()` on first use. */
function ladderHome(): string {
  return seamHome ?? useSpawnHome()
}

/**
 * The row a spawn of persona `key` left behind, for a collision fixture:
 * `cannedGetResult` in persona form, so its `cwd` is the persona's working
 * directory, its instance ID `cscb_<key>` and its `config_dir` label the
 * persona's current one under the seam home (`ladderHome`). A ladder fixture
 * built from it stays on the state path it tests instead of meeting the `cwd`
 * or `config_dir` guard (b.av2 SR-6.2). Overrides win, so a guard case can
 * replace `cwd` or `labels`.
 */
function personaRow(cfg: PersonaConfig, key: string, overrides: PersonaGetResultOverrides = {}): CannedGetResult {
  return cannedGetResult(overrides, personaOf(cfg, key), ladderHome())
}

/** A stub `get` that answers each `cscb_<key>` with `personaRow(cfg, key, overrides)`. */
function personaRowsGet(
  cfg: PersonaConfig,
  overrides: PersonaGetResultOverrides = {},
): (params: import('agent-director').GetParams) => Promise<CannedGetResult> {
  return async (params) => personaRow(cfg, params.claude_instance_id.slice(PERSONA_INSTANCE_ID_PREFIX.length), overrides)
}

/** Capture of outage-state notices (onsets + all-clears), by persona key, across each test. */
let outageEmissions: Array<{ key: string; text: string }> = []

/**
 * Bare capture of every session-manager notice raised during the test: the
 * recording sink `beforeEach` installs through `setSessionNotifier`. Enough
 * for "no notice" assertions; routing is asserted through the real notifier
 * (`installNoticeNotifier`), which replaces this sink for its test.
 */
let notices: Array<{ key: string; text: string; options?: PersonaNoticeOptions }> = []

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  fixtureDir = mkdtempSync(join(tmpdir(), 'cscb-sm-'))
  // A launch that returns success starts the persona's dialog approver in
  // the background (b.jg5 SRJ-401). Cap it short, so one left on the real
  // clock stops soon; afterEach stops every approver (`_resetInFlightLaunches`).
  // An approver case runs it on a fake clock (`useApproverClock`).
  _setDialogReadyTimeoutMs(200)
  // Wire the outage-state module so withOutageDetection / withSpawnDetection
  // can resolve the AD client and emit Slack onset/all-clear messages.
  outageEmissions = []
  initOutageState({
    getClient,
    notify: (key, text) => { outageEmissions.push({ key, text }) },
  })
  notices = []
  setSessionNotifier((key, text, options) => { notices.push({ key, text, options }) })
  seamHome = undefined
  // Every launch resolves an unset claude_config_dir against a scratch home
  // holding a real `.claude`, never the process home (a dangling
  // `$HOME/.claude` would hold every launch). A test that needs its own seam
  // home replaces it with `useSpawnHome`.
  const defaultHome = fixtureSubdir('default-home')
  mkdirSync(join(defaultHome, '.claude'))
  _setSpawnHomeDir(defaultHome)
  // Default the b.3ce timeout-liveness prober to "alive" so unit tests never
  // shell out to real tmux and the timeout verdict stays 'ok' unless a test
  // explicitly drives the dead-session path.
  _setTmuxSessionProber(async () => true)
  // Every raw tmux call goes through one runner (b.1ix): a failing stand-in,
  // so a default seam a test reaches (the b.vub kill) never touches a real
  // tmux server.
  _setTmuxCommandRunner(async () => ({ code: 1, stdout: '' }))
})

afterEach(() => {
  // First: stop every dialog approver a launch started (b.jg5 SRJ-401), so
  // none makes a call after this test's client and seams are put back.
  _resetInFlightLaunches()
  resetClientForTests()
  _resetDialogReadyTimeoutMs()
  _resetWaitForWaitingTimeoutMs()
  _resetFindMissingMemo()
  _resetTmuxSessionKiller()
  _resetTmuxServerEnsurer()
  _resetTmuxSessionProber()
  _resetTmuxCommandRunner()
  // An approver case runs the approver on a fake clock (`useApproverClock`).
  _resetApproverClock()
  _resetOutageState()
  _resetSpawnHomeDir()
  _resetPreLaunchTrustPatcher()
  _resetPreLaunchReplyGuard()
  _resetLaunchedWithDirs()
  _resetConfigDirFs()
  _resetNotConnectedEpisodes()
  _resetUnprovenIdleNoticeAfterMs()
  // b.f2b cases pass a fake clock's `now` to the session manager (`_setNow`).
  _resetNow()
  setConfigDirUnresolvableHook(undefined)
  setSessionNotifier(undefined)
  // b.jg5 SRJ-502: a case that installs its own latch leaves none behind.
  setConflictLatch(undefined)
  // b.jg5 SRJ-114: nor its own configured-persona query.
  _resetConfiguredPersonaQuery()
  installedHold?.cancelAll()
  installedHold = undefined
  process.env = savedEnv as NodeJS.ProcessEnv
  rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 shared helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persona notices (b.av2 SR-7.2) — the real notifier over per-persona stubs
// ---------------------------------------------------------------------------

/** The notice persona: its name differs from its key. */
const NOTICE_NAME = 'Ops Desk'
const NOTICE_KEY = personaKey(NOTICE_NAME)
/** Its destination (`permission_prompts`): its second channel, an `all` one. */
const NOTICE_DEST = 'C0DEST001'
/** Its first channel, `mentions` only: never a notice target. */
const NOTICE_MENTIONS = 'C0MENT002'
/** The second persona, whose stub must never see a notice for the first. */
const OTHER_NAME = 'Other Bot'
const OTHER_KEY = personaKey(OTHER_NAME)
const OTHER_DEST = 'C0OTHER03'

/**
 * Two personas: the notice persona (first channel NOTICE_MENTIONS, destination
 * its second channel NOTICE_DEST, so a post to its first channel is told apart
 * from a post to its destination) and a second one with its own destination.
 */
function makeNoticeConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeMultiPersonaConfig(
    [
      {
        name: NOTICE_NAME,
        working_directory: '/x',
        channels: [
          { id: NOTICE_MENTIONS, delivery: 'mentions' },
          { id: NOTICE_DEST, delivery: 'all' },
        ],
        permission_prompts: NOTICE_DEST,
      },
      {
        name: OTHER_NAME,
        working_directory: '/y',
        channels: [{ id: OTHER_DEST, delivery: 'all' }],
        permission_prompts: OTHER_DEST,
      },
    ],
    fixtureDir,
    overrides,
  )
}

/** The notice persona's `dm.contact` in the DM-destination config (a user ID, never posted to). */
const NOTICE_CONTACT = 'U0OPER001'
/** The DM conversation `conversations.open` returns for NOTICE_CONTACT (scripted with `openedDm`). */
const NOTICE_DM = 'D0NOTEDM1'

/**
 * `makeNoticeConfig` with the notice persona's destination switched to `dm`
 * (DMs on, contact NOTICE_CONTACT); the second persona keeps its channel
 * destination OTHER_DEST.
 */
function makeDmNoticeConfig(): PersonaConfig {
  const cfg = makeNoticeConfig()
  const personas = cfg.personas.map((p) =>
    p.key === NOTICE_KEY
      ? { ...p, permission_prompts: 'dm', dm: { enabled: true, contact: NOTICE_CONTACT } }
      : p,
  )
  return { ...cfg, personas }
}

/** The Web API methods called on `key`'s validated client (its stub `web`), in call order. */
function webMethods(h: NotifierHarness, key: string): string[] {
  return h.stub(key).web.callLog.map((c) => c.method)
}

/** The destination hold of this test's installed notifier; cancelled in afterEach. */
let installedHold: PersonaDestinationHold | undefined

/**
 * Build the real persona notifier over `cfg` (`makeNotifierHarness`: one
 * `makeStubSlack` stub per persona) and install its `notify` through
 * `setSessionNotifier` (reset to no notifier in afterEach). Every persona is
 * validated unless `validated: false`; `post` scripts the notice persona's
 * `chat.postMessage` outcomes; `leakMarker` goes to every stub.
 *
 * The notifier's destination hold (b.av2 SR-7.1, `h.hold`) runs on the
 * harness's fake clock (`h.clock`), so a notice held after a failed post
 * creates no real timer: its retry runs only when the test moves the clock.
 */
function installNoticeNotifier(
  cfg: PersonaConfig,
  opts: { validated?: boolean; post?: WebApiOutcome[]; leakMarker?: string } = {},
): NotifierHarness {
  const h = makeNotifierHarness(cfg, {
    validated: opts.validated ?? true,
    post: opts.post ? { [NOTICE_KEY]: opts.post } : undefined,
    leakMarker: opts.leakMarker,
  })
  installedHold = h.hold
  setSessionNotifier(h.notifier.notify)
  return h
}

/** The notifier's `persona-destination-failed` lines (episode opened and cleared). */
function destinationFailedLines(h: NotifierHarness): string[] {
  return h.logs.filter((l) => l.startsWith(`[slack] ${PERSONA_DESTINATION_FAILED}: `))
}

/** The expected `persona-destination-failed` line prefix for the notice persona (personas[0]). */
const NOTICE_DIAG_PREFIX = `[slack] ${PERSONA_DESTINATION_FAILED}: personas[0] ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)}: `

/** Capture console.error output for the duration of `fn`, then restore. */
async function withCapturedErr(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.error = orig
  }
  return lines.join('\n')
}

/**
 * Poll `cond` in real time, 1 ms steps, for at most `ms`; the caller asserts
 * afterwards. Only for launches through the real `spawnForPersona`, which
 * take no fake clock.
 */
async function pollUntil(cond: () => boolean, ms = 2_000): Promise<void> {
  for (let waited = 0; !cond() && waited < ms; waited++) await new Promise((r) => setTimeout(r, 1))
}

/** Let fire-and-forget notice posts (and their rejection handlers) settle. */
async function settleNotices(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run the startup-dialog approver on a fresh fake clock for this test
 * (`_setApproverClock`; the file's afterEach restores the real clock), at its
 * real pace (`DIALOG_POLL_INTERVAL_MS`) and its real cap
 * (`DIALOG_READY_TIMEOUT_MS`) unless the case sets a shorter one. Every
 * approver case settles its call with `runOnApproverClock`, never on real
 * time.
 */
function useApproverClock(): FakeClock {
  const clock = createFakeClock()
  _setApproverClock(clock)
  _resetDialogReadyTimeoutMs()
  return clock
}

/** Most event-loop turns `runOnApproverClock` gives a call to settle. */
const APPROVER_DRIVE_TURNS = 5_000

/**
 * Settle `work` (an approver call, or a launch that awaits one) on `clock`,
 * the approver's clock (`useApproverClock`). Virtual time moves only while
 * the approver sleeps between laps, that is while a timer besides its cap is
 * pending, and then by one `runNext` (the next lap, or the cap when that is
 * due first). Between steps it yields one event-loop turn, so a launch's own
 * file I/O before the approver starts goes on. Fails the test when `work`
 * has not settled after `APPROVER_DRIVE_TURNS` turns.
 */
async function runOnApproverClock<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let settled = false
  work.then(
    () => { settled = true },
    () => { settled = true },
  )
  for (let turn = 0; !settled && turn < APPROVER_DRIVE_TURNS; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (!settled && clock.pendingCount() >= 2) await clock.runNext()
  }
  if (!settled) throw new Error(`the approver did not stop within ${APPROVER_DRIVE_TURNS} event-loop turns (virtual time ${clock.now()} ms)`)
  return work
}

/**
 * Settle `work` without moving the approver's clock: yield event-loop turns,
 * at most `APPROVER_DRIVE_TURNS`, and fail the test when `work` has not
 * settled by then. A launch settles so whatever its dialog approver does:
 * the approver runs on its own after the launch call (b.jg5 SRJ-401), and
 * its laps after the first wait for the clock.
 */
async function settleOffApproverClock<T>(work: Promise<T>): Promise<T> {
  let settled = false
  work.then(
    () => { settled = true },
    () => { settled = true },
  )
  for (let turn = 0; !settled && turn < APPROVER_DRIVE_TURNS; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (!settled) throw new Error(`the call did not settle within ${APPROVER_DRIVE_TURNS} event-loop turns with the approver's clock held`)
  return work
}

/**
 * Settle `launch`, a launch of persona `key`, with the approver's clock held
 * (`settleOffApproverClock`), then run the dialog approver its success
 * started (b.jg5 SRJ-401) to its stop on `clock` (`useApproverClock`), awaited
 * through the stop seam (`_whenDialogApproverStopped`). Answers the launch's
 * result; the seam answers how the approver ended.
 */
async function launchThenRunApprover<T>(clock: FakeClock, key: string, launch: Promise<T>): Promise<T> {
  const result = await settleOffApproverClock(launch)
  await runOnApproverClock(clock, _whenDialogApproverStopped(key))
  return result
}

/**
 * Record every raw tmux call from now on, in order: each command through the
 * runner seam (`_setTmuxCommandRunner`, answering as the file's failing
 * stand-in does) as its argv, and the session prober, killer and server
 * ensurer as `[<seam>, <session>]`. The file's afterEach puts every seam
 * back. The startup-dialog approver makes none of these calls.
 */
function recordTmuxCalls(): string[][] {
  const calls: string[][] = []
  _setTmuxCommandRunner(async (args) => {
    calls.push([...args])
    return { code: 1, stdout: '' }
  })
  _setTmuxSessionProber(async (name) => {
    calls.push(['prober', name])
    return true
  })
  _setTmuxSessionKiller(async (name) => {
    calls.push(['killer', name])
  })
  _setTmuxServerEnsurer(async () => {
    calls.push(['ensurer'])
  })
  return calls
}

/** A `status` answer through the stub's canned builder: a `pending` row carries the sample launch start. */
function statusReads(...states: string[]): CannedResponse<Phase1StatusResult>[] {
  return states.map((state) => cannedOk(cannedStatusResult({ state })))
}

/**
 * Assert exactly one notice was posted, to the notice persona's destination
 * only, through its own client, as a top-level message whose text names the
 * persona in rendered form and never identifies it by a channel ID; nothing
 * is posted through the other persona's client. Returns the posted text.
 */
function expectOneNoticeToDestination(h: NotifierHarness): string {
  const posts = h.posts(NOTICE_KEY)
  expect(posts).toHaveLength(1)
  const post = posts[0]!
  expect(post.channel).toBe(NOTICE_DEST)
  // Top-level, the persona's own identity: exactly channel + text.
  expect(Object.keys(post).sort()).toEqual(['channel', 'text'])
  expect(post.text.startsWith(`Persona ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)}: `)).toBe(true)
  expect(post.text).not.toContain(NOTICE_DEST)
  expect(post.text).not.toContain(NOTICE_MENTIONS)
  expect(h.posts(OTHER_KEY)).toHaveLength(0)
  return post.text
}

/** Number of `[<classLabel>]` entries in a startup-errors.log body. */
function countStartupEntries(log: string, classLabel: string): number {
  return log.split('\n').filter((line) => line.includes(`] [${classLabel}] `)).length
}

/** The one `[<classLabel>]` entry of a startup-errors.log body; fails the test unless there is exactly one. */
function onlyStartupEntry(log: string, classLabel: string): string {
  const entries = log.split('\n').filter((line) => line.includes(`] [${classLabel}] `))
  expect(entries).toHaveLength(1)
  return entries[0]!
}

// AC 20 (b.av2 SR-10.3, E13 Director decision 16): an agent-director error's
// description can carry a short-lived URL or a token. These build one that
// carries both (the URL embeds the sentinel), and what `redactSlackLogText`
// leaves of it.

/** An agent-director error description holding a URL (with the sentinel) and a fake token. */
const adDescription = (): string =>
  `upload https://files.example.test/v1/${LEAK_SENTINEL}?ticket=1 refused ${fakeToken(BOT_TOKEN_PREFIX, 'desc')} retry later`
/** `adDescription()` after `redactSlackLogText`. */
const REDACTED_AD_DESCRIPTION = `upload ${REDACTED_URL_PLACEHOLDER} refused ${REDACTED_TOKEN_PLACEHOLDER} retry later`
/** A token-shaped `errName`, which never passes `isSafeIdentifier`. */
const tokenErrName = (): string => fakeToken(APP_TOKEN_PREFIX, 'errname')

// A thrown error's message stays in log lines after `redactSlackLogText`
// (Task 0 decision B1), so a leak case plants the sentinel in a message only
// inside a fake token and a Socket Mode `ticket=` URL, the shapes redaction
// removes; a bare sentinel there would survive redaction and prove nothing.

/** `text`, then the sentinel inside a fake token and a `?ticket=` URL (`sentinelInMessage`). */
const leakyMessage = (text: string, suffix: string): string => `${text} (${sentinelInMessage(suffix)})`
/** `leakyMessage(text, …)` after `redactSlackLogText`. */
const redactedLeakyMessage = (text: string): string => `${text} (${REDACTED_SENTINEL_TAIL})`

/** Pre-raise all three outage flags for a persona key so success-clear tests start with full bad-stretch. */
function preSetAllFlags(key: string): void {
  setOutageFlag(key, 'cwd-unreachable', '/test/cwd')
  setOutageFlag(key, 'ad-unreachable', '/bin/ad')
  setOutageFlag(key, 'tmux-unavailable')
}

// ---------------------------------------------------------------------------
// SR-1.1 / b.av2 SR-2.2 — fresh spawn parameters
// ---------------------------------------------------------------------------
//
// Spawns are keyed by persona: `cscb_<key>`, `slack_bot_<key>`, the labels
// `service=cscb`, `persona=<key>`, `config_dir=<12 hex of the REAL effective
// claude_config_dir>` and nothing else (no `channel` label since E3 Task 6),
// and the env `CSCB_PERSONA` / `CLAUDE_MANAGED_CHANNEL` (the key),
// `CSCB_CRONTABLE_PATH`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` (b.svb;
// every launch path is covered in its own block below), and
// `CLAUDE_CONFIG_DIR` only when a directory is configured.
//
// extra_env always carries CSCB_CRONTABLE_PATH — the resolved, absolute
// cron_table_path from the config — for every persona, whether or not a
// (per-persona or top-level) claude_config_dir is present. buildSpawnParams
// copies the field verbatim; it never recomputes or re-resolves the path, so a
// distinctive absolute override on the config must appear untouched in
// extra_env (see the pass-through test below).
//
// There is deliberately no "cron_table_path missing" case here: cron_table_path
// is a required field on the resolved config type, and the env-var fallback
// server mode has no config at all — server.ts guards every spawn on a loaded
// config, so buildSpawnParams is never reached without one. A missing-field
// case is therefore unrepresentable, not merely untested.

/** Create `name` under the per-test fixture dir and return its path. */
function fixtureSubdir(name: string): string {
  const dir = join(fixtureDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Expected `config_dir=` label for a configured directory that exists. */
function configDirLabelFor(dir: string): string {
  return `config_dir=${configDirLabelValue(realpathSync(dir))}`
}

describe('spawnForPersona: SR-1.1 / SR-2.2 fresh spawn parameters', () => {
  test('emits SpawnParams with the persona instance id, tmux name, exact labels and env', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const configDir = fixtureSubdir('claude-corp')
    const workDir = fixtureSubdir('work')
    const cfg = makeMultiPersonaConfig(
      [{ name: 'Ops Bot', working_directory: workDir, claude_config_dir: configDir }],
      fixtureDir,
    )
    const key = personaKey('Ops Bot')
    expect(key).not.toBe('Ops Bot') // the name needs normalisation, so name and key differ

    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result).toEqual({ key, action: 'spawned' })
    expect(spawnCalls).toHaveLength(1)
    const params = spawnCalls[0]
    expect(params.template).toBe('slack-channel-bot')
    expect(params.cwd).toBe(workDir)
    expect(params.claude_instance_id).toBe(`cscb_${key}`)
    expect(params.tmux_session_name).toBe(`slack_bot_${key}`)
    expect(params.relay_mode).toBe('on')
    expect(params.label).toEqual(['service=cscb', `persona=${key}`, configDirLabelFor(configDir)])
    // The interim `channel=<key>` label is no longer written (E3 Task 6).
    expect(params.label!.some((l) => l.startsWith('channel='))).toBe(false)
    expect(params.extra_env).toEqual({
      CLAUDE_CONFIG_DIR: configDir,
      CSCB_PERSONA: key,
      CLAUDE_MANAGED_CHANNEL: key,
      CSCB_CRONTABLE_PATH: join(fixtureDir, 'crontab'),
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    })
    expect(params.claude_args).toBeUndefined()
  })

  test('no claude_config_dir configured → CLAUDE_CONFIG_DIR absent (not empty), label is that of <home>/.claude', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    expect(cfg.claude_config_dir).toBeUndefined()

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    const env = spawnCalls[0].extra_env!
    expect(env).toEqual({
      CSCB_PERSONA: 'C',
      CLAUDE_MANAGED_CHANNEL: 'C',
      CSCB_CRONTABLE_PATH: cfg.cron_table_path,
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    })
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
    expect(spawnCalls[0].label).toEqual([
      'service=cscb',
      'persona=C',
      `config_dir=${personaConfigDirLabelValue(undefined, home)}`,
    ])
    // Independent of the helper: the hash of the real <home>/.claude.
    expect(spawnCalls[0].label).toContain(`config_dir=${configDirLabelValue(join(realpathSync(home), '.claude'))}`)
  })

  test('the seam home is followed through a symlink: a linked home gives the label of its target', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const target = fixtureSubdir('real-home')
    mkdirSync(join(target, '.claude'))
    const linkedHome = join(fixtureDir, 'linked-home')
    symlinkSync(target, linkedHome)
    _setSpawnHomeDir(linkedHome)
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    const label = spawnCalls[0].label!.find((l) => l.startsWith('config_dir='))
    expect(label).toBe(`config_dir=${personaConfigDirLabelValue(undefined, target)}`)
    expect(label).toBe(`config_dir=${configDirLabelValue(join(realpathSync(target), '.claude'))}`)
    // The lexical hash under the link differs, so equality proves the real path was hashed.
    expect(label).not.toBe(`config_dir=${configDirLabelValue(join(linkedHome, '.claude'))}`)
    expect('CLAUDE_CONFIG_DIR' in spawnCalls[0].extra_env!).toBe(false)
  })

  test('a configured absolute claude_config_dir ignores the seam home', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const configured = fixtureSubdir('absolute-config')
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: configured } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(spawnCalls[0].label).toContain(configDirLabelFor(configured))
    expect(spawnCalls[0].label).not.toContain(`config_dir=${personaConfigDirLabelValue(undefined, home)}`)
    expect(spawnCalls[0].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configured)
  })

  test('a ~-prefixed claude_config_dir expands against the seam home for the label; env keeps it as configured', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const home = useSpawnHome()
    const expanded = join(home, 'tilde-config')
    mkdirSync(expanded)
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: '~/tilde-config' } }, fixtureDir)

    await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(spawnCalls[0].label).toContain(configDirLabelFor(expanded))
    // Not expanded against the process home.
    expect(spawnCalls[0].label).not.toContain(`config_dir=${configDirLabelValue(join(homedir(), 'tilde-config'))}`)
    expect(spawnCalls[0].extra_env?.['CLAUDE_CONFIG_DIR']).toBe('~/tilde-config')
  })

  test('extra_env passes the already-resolved cron_table_path through untouched (no recomputation)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { cron_table_path: '/srv/resolved/absolute/crontable.md' })
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(spawnCalls[0].extra_env).toEqual({
      CSCB_PERSONA: 'C',
      CLAUDE_MANAGED_CHANNEL: 'C',
      CSCB_CRONTABLE_PATH: '/srv/resolved/absolute/crontable.md',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    })
  })

  test('extra_env carries the crontable path alongside a per-persona claude_config_dir', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const perPersona = fixtureSubdir('per-persona')
    const cfg = makeStandInPersonaConfig(
      { C: { working_directory: '/x', claude_config_dir: perPersona } },
      fixtureDir,
      { cron_table_path: '/srv/resolved/absolute/crontable.md' },
    )
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(spawnCalls[0].extra_env).toEqual({
      CLAUDE_CONFIG_DIR: perPersona,
      CSCB_PERSONA: 'C',
      CLAUDE_MANAGED_CHANNEL: 'C',
      CSCB_CRONTABLE_PATH: '/srv/resolved/absolute/crontable.md',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    })
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-2.2, SR-1.5 — the `config_dir` label hashes the REAL path of the
// effective claude_config_dir; a directory not created yet gets the label of
// the real path it will have (bug b.g57: no lexical fallback; see the b.g57
// block for the unresolvable and not-yet-created cases).
// ---------------------------------------------------------------------------

describe('spawnForPersona: config_dir label (SR-2.2, SR-1.5)', () => {
  /** Spawn every persona of `cfg` once and return the spawn params by key. */
  async function spawnAll(cfg: PersonaConfig): Promise<Map<string, import('agent-director').SpawnParams>> {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    for (const persona of cfg.personas) await spawnForPersona(persona, cfg)
    return new Map(spawnCalls.map((p) => [String(p.claude_instance_id).slice('cscb_'.length), p]))
  }

  test('a per-persona directory overrides the top-level one in the label and the env', async () => {
    const top = fixtureSubdir('top-level')
    const per = fixtureSubdir('per-persona')
    const cfg = makeMultiPersonaConfig(
      [{ name: 'ops_bot', working_directory: '/x', claude_config_dir: per }],
      fixtureDir,
      { claude_config_dir: top },
    )
    const params = (await spawnAll(cfg)).get('ops_bot')!
    expect(params.label).toContain(configDirLabelFor(per))
    expect(params.label).not.toContain(configDirLabelFor(top))
    expect(params.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(per)
  })

  test('two different directories give different labels', async () => {
    const one = fixtureSubdir('dir-one')
    const two = fixtureSubdir('dir-two')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: '/x/a', claude_config_dir: one },
        { name: 'beta', working_directory: '/x/b', claude_config_dir: two },
      ],
      fixtureDir,
    )
    const byKey = await spawnAll(cfg)
    const alpha = byKey.get('alpha')!.label!.find((l) => l.startsWith('config_dir='))
    const beta = byKey.get('beta')!.label!.find((l) => l.startsWith('config_dir='))
    expect(alpha).toBe(configDirLabelFor(one))
    expect(beta).toBe(configDirLabelFor(two))
    expect(alpha).not.toBe(beta)
  })

  test('a symlink to a directory gives the same label as the directory (env keeps the path as configured)', async () => {
    const target = fixtureSubdir('real-config')
    const link = join(fixtureDir, 'config-link')
    symlinkSync(target, link)
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'direct', working_directory: '/x/d', claude_config_dir: target },
        { name: 'via_link', working_directory: '/x/l', claude_config_dir: link },
      ],
      fixtureDir,
    )
    const byKey = await spawnAll(cfg)
    const direct = byKey.get('direct')!.label!.find((l) => l.startsWith('config_dir='))
    const viaLink = byKey.get('via_link')!.label!.find((l) => l.startsWith('config_dir='))
    expect(viaLink).toBe(direct)
    expect(viaLink).toBe(configDirLabelFor(target))
    // The lexical hash of the link path differs, so equality proves the real path was hashed.
    expect(viaLink).not.toBe(`config_dir=${configDirLabelValue(link)}`)
    expect(byKey.get('via_link')!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(link)
  })

  test('a configured path not created yet, with no symlink on it, gets the label of that path (its nearest existing ancestor\'s real path plus the rest)', async () => {
    const missing = join(fixtureDir, 'not-created', 'claude')
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x', claude_config_dir: missing } }, fixtureDir)
    const params = (await spawnAll(cfg)).get('C')!
    expect(params.label).toContain(`config_dir=${configDirLabelValue(missing)}`)
  })

  test('no directory configured: the label is that of .claude under an injected temp home', () => {
    const home = fixtureSubdir('home')
    mkdirSync(join(home, '.claude'))
    const expected = configDirLabelValue(resolveRealPath(join(realpathSync(home), '.claude')), home)
    expect(personaConfigDirLabelValue(undefined, home)).toBe(expected)
    // Unset equals an explicit <home>/.claude, in absolute and tilde form.
    expect(personaConfigDirLabelValue(join(home, '.claude'), home)).toBe(expected)
    expect(personaConfigDirLabelValue('~/.claude', home)).toBe(expected)
    // A symlinked home resolves to the same real directory.
    const linkedHome = join(fixtureDir, 'home-link')
    symlinkSync(home, linkedHome)
    expect(personaConfigDirLabelValue(undefined, linkedHome)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-2.2 — spawn identity is the persona key, never the name
// ---------------------------------------------------------------------------

describe('spawnForPersona: persona identity (SR-2.2)', () => {
  test('an in-form name is its own key', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeMultiPersonaConfig([{ name: 'ops_bot', working_directory: '/repo/ops' }], fixtureDir)

    await spawnForPersona(personaOf(cfg, 'ops_bot'), cfg)

    expect(spawnCalls[0].claude_instance_id).toBe('cscb_ops_bot')
    expect(spawnCalls[0].tmux_session_name).toBe('slack_bot_ops_bot')
    expect(spawnCalls[0].label).toContain('persona=ops_bot')
  })

  test('a persona whose key is set directly (a channel-ID stand-in) spawns byte-identically as cscb_<key>', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const topLevel = fixtureSubdir('top-level')
    const cfg = makeStandInPersonaConfig(
      { C0AMDDZEHCY: { working_directory: '/repo/general' } },
      fixtureDir,
      { claude_config_dir: topLevel },
    )

    const result = await spawnForPersona(personaOf(cfg, 'C0AMDDZEHCY'), cfg)

    expect(result).toEqual({ key: 'C0AMDDZEHCY', action: 'spawned' })
    const params = spawnCalls[0]
    expect(params.claude_instance_id).toBe('cscb_C0AMDDZEHCY')
    expect(params.tmux_session_name).toBe('slack_bot_C0AMDDZEHCY')
    expect(params.cwd).toBe('/repo/general')
    expect(params.label).toEqual([
      'service=cscb',
      'persona=C0AMDDZEHCY',
      configDirLabelFor(topLevel),
    ])
    // The top-level claude_config_dir reaches the env of a stand-in with none of its own.
    expect(params.extra_env).toEqual({
      CLAUDE_CONFIG_DIR: topLevel,
      CSCB_PERSONA: 'C0AMDDZEHCY',
      CLAUDE_MANAGED_CHANNEL: 'C0AMDDZEHCY',
      CSCB_CRONTABLE_PATH: cfg.cron_table_path,
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    })
  })

  test('collision handling addresses the same cscb_<key> for get and resume', async () => {
    const getCalls: import('agent-director').GetParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const key = personaKey('General Chat')
    const cfg = makeMultiPersonaConfig([{ name: 'General Chat', working_directory: '/x' }], fixtureDir)
    installStub({
      getCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, key, { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result.action).toBe('resumed')
    expect(getCalls[0].claude_instance_id).toBe(`cscb_${key}`)
    expect(resumeCalls[0].claude_instance_id).toBe(`cscb_${key}`)
  })
})

// ---------------------------------------------------------------------------
// SR-1.4 — idempotency dispatch on ErrInstanceIdCollision
// ---------------------------------------------------------------------------

describe('spawnForPersona: SR-1.4 collision-then-act', () => {
  test('ended state + resume_enabled → resume()', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0].claude_instance_id).toBe('cscb_C')
  })

  test('ended state + ErrNoSessionId on resume → delete + fresh spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].claude_instance_id).toEqual(['cscb_C'])
  })

  test('ended state + resume_enabled=false → kill + delete + fresh spawn (no resume)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      resumeCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'missing' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  test('waiting state → reconnectMcp (sendKeys with /mcp reconnect)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0].text).toContain('/mcp reconnect')
  })

  test('pending/check_permission/ask_user → no-op', async () => {
    for (const state of ['pending', 'check_permission', 'ask_user']) {
      const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
      installStub({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state }),
      })
      const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      expect(result.action).toBe('no-op')
      resetClientForTests()
    }
  })

  // b.2oy — resume rejects with ErrSpawnNotFound (row vanished between the
  // dead-session verdict and resume: operator delete, expire, race). Recovery
  // must fresh-spawn directly with the original params — NO kill, NO delete,
  // no spawn-failure notice — and report 'spawned'. Pre-fix this fell
  // into the generic resume-catch, which posted a Slack "spawn failure" and
  // returned action: 'failed'.
  test('b.2oy: ErrSpawnNotFound on resume → fresh spawn (no kill, no delete, no spawn-failure notice)', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const home = useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errSpawnNotFound(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result).toEqual({ key: 'C', action: 'spawned' })
    // initial collision spawn + the fresh spawn after ErrSpawnNotFound
    expect(spawnCalls).toHaveLength(2)
    // fresh spawn carries the original params (same persona labels / id)
    expect(spawnCalls[1].claude_instance_id).toBe('cscb_C')
    expect(spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', `config_dir=${personaConfigDirLabelValue(undefined, home)}`])
    // row was already gone — no kill and no delete of a missing row
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    // no spawn-failure notice
    expect(notices).toHaveLength(0)
  })

  // b.2oy — ErrSpawnNotFound recovery still surfaces genuine spawn failures.
  // Resume throws ErrSpawnNotFound, then the fresh spawn fails with a LAUNCH
  // FAILURE (ErrTmuxSessionCreate; this site has no self-heal) → 'failed' and
  // a spawn-failure notice goes to the persona's destination (b.av2 SR-7.2).
  test('b.2oy: ErrSpawnNotFound on resume + fresh spawn fails → failed + spawn-failure notice to the persona destination', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    const launchFailure = errTmuxSessionCreate('spawn')
    installStub({
      spawnCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(launchFailure),
      ],
      resumeError: errSpawnNotFound(),
      getResult: personaRow(cfg, NOTICE_KEY, { state: 'ended' }),
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()
    expect(result.action).toBe('failed')
    expect(spawnCalls).toHaveLength(2)
    expect(deleteCalls).toHaveLength(0)
    // the launch failure is surfaced to the persona's destination only
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain(`Error: \`${launchFailure.errName}\``)
    expect(text).toContain('Remediation: Check server.log for details.')
    // startup-error side effect is part of the tested contract
    expect(readLog()).toContain('[spawn-failed]')
  })

  test('ErrSpawnNotFound after collision → single retry-spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(spawnCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-104 — ErrInvalidFlags from resume: one immediate re-check, UNCLASSIFIED
// ---------------------------------------------------------------------------
//
// The real re-check (`installAdVersionRecheck`) runs over a counting stub
// `resolveSystemBinary` and a fake clock that is never moved, so every call
// recorded is the immediate re-check the resume path triggered. A re-check
// that does not stop the server leaves the resume's ErrInvalidFlags
// UNCLASSIFIED, which takes SRJ-105's UNCLASSIFIED row (b.jg5 SRJ-313): no
// spawn-failure notice, one refusal line, the persona's timer armed with the
// UNCLASSIFIED cause, a refused launch (never counted), and the outcome
// reported once to the persona's unclassified-error episode, with the site's
// own classification. Those cases run on `makeRecoveryHarness` (the
// production composition); the exact-once report runs over recording sinks.

describe('collision ladder: ErrInvalidFlags on resume makes one version re-check, then is UNCLASSIFIED (b.jg5 SRJ-104)', () => {
  /** Every `resolveSystemBinary` call the installed re-check made, by its opts. */
  let resolveCalls: Array<object | undefined>
  /** The exit codes the re-check stopped with. */
  let stops: number[]

  beforeEach(() => {
    resolveCalls = []
    stops = []
    installAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls }),
      baselineVersion: PHASE1_RC_VERSION,
      recordStartupError: () => {},
      stop: (exitCode) => { stops.push(exitCode) },
      log: () => {},
      clock: createFakeClock(),
    })
  })

  afterEach(() => {
    resetAdVersionRecheckForTests()
    srj105AfterEach()
  })

  /** A persona `C` whose spawn collides with its `ended` row, so the ladder resumes it and the resume rejects with `resumeError`. */
  function installEndedRowResumeRejects(resumeError: Error) {
    const calls = {
      spawnCalls: [] as import('agent-director').SpawnParams[],
      resumeCalls: [] as import('agent-director').ResumeParams[],
      killCalls: [] as import('agent-director').KillParams[],
      deleteCalls: [] as import('agent-director').DeleteParams[],
    }
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError,
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    return { cfg, calls }
  }

  /** The UNCLASSIFIED rendering of a resume's ErrInvalidFlags after its re-check (the site's classification, b.jg5 SRJ-104). */
  function invalidFlagsClassText(invalidFlags: Error & { errName: string; errDescription: string }): string {
    return `class=${AD_ERROR_CLASS_UNCLASSIFIED} name=${invalidFlags.errName} message=${JSON.stringify(invalidFlags.errDescription)}`
  }

  /** The one refusal line of a resume's ErrInvalidFlags for persona `key` after the re-check answered `kind` (b.jg5 SRJ-105, SRJ-313). */
  function invalidFlagsRefusalLine(key: string, invalidFlags: Error & { errName: string; errDescription: string }, kind: string): string {
    return (
      `[slack] spawnForPersona: resume refused for ${renderPersonaRef(key, key)}: ${invalidFlagsClassText(invalidFlags)} ` +
      `(after one immediate agent-director version re-check: ${kind}) — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`
    )
  }

  test('b.jg5 SRJ-313: the resume\'s ErrInvalidFlags is reported once to the unclassified sink, with the site\'s UNCLASSIFIED classification (never as STATE by the wrapper too), and arms the timer once with the UNCLASSIFIED cause', async () => {
    const reports: Array<{ key: string; error: unknown; classification: unknown }> = []
    const armed: Array<{ key: string; kind: string }> = []
    const unclassifiedSink: UnclassifiedErrorSink = {
      report: (key, error, classification) => { reports.push({ key, error, classification }) },
    }
    initOutageState({
      getClient,
      notify: (key, text) => { outageEmissions.push({ key, text }) },
      triggerSink: { arm: (key, cause) => { armed.push({ key, kind: cause.kind }); return true } },
      unclassifiedSink,
    })
    const invalidFlags = errInvalidFlags('resume')
    const { cfg } = installEndedRowResumeRejects(invalidFlags)

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'failed', refused: true })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.key).toBe('C')
    expect(reports[0]!.error).toBe(invalidFlags)
    expect(describeAdErrorClassification(reports[0]!.classification as Parameters<typeof describeAdErrorClassification>[0])).toBe(invalidFlagsClassText(invalidFlags))
    expect(armed).toEqual([{ key: 'C', kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect(notices).toEqual([])
  })

  test('ErrNoSessionId: no re-check call; delete + fresh spawn as before', async () => {
    const { cfg, calls } = installEndedRowResumeRejects(errNoSessionId())
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(resolveCalls).toHaveLength(0)
    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(2)
  })

  // E8 (b.jg5 SRJ-205, SRJ-302): a re-check that decides the stop posts
  // nothing and ends a launch the restart path does not count; any other
  // re-check answer (it passes, or could not run) leaves the ErrInvalidFlags
  // UNCLASSIFIED: a refusal with no notice (b.jg5 SRJ-105, SRJ-313).

  /** Replace the installed re-check with one whose `resolveSystemBinary` answers `outcome`, recorded as the default one is. */
  function reinstallRecheck(outcome: StubResolveSystemBinaryOutcome): void {
    resetAdVersionRecheckForTests()
    installAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls, outcomes: [outcome] }),
      baselineVersion: PHASE1_RC_VERSION,
      recordStartupError: () => {},
      stop: (exitCode) => { stops.push(exitCode) },
      log: () => {},
      clock: createFakeClock(),
    })
  }

  /** The `resume failed` lines for persona C in `log`. */
  function resumeFailedLines(log: string): string[] {
    return log.split('\n').filter((l) => l.includes(`resume failed for ${renderPersonaRef('C', 'C')}: `))
  }

  test('the re-check answers stop: no spawn-failure notice, { failed, stopping }, the one UNCLASSIFIED line kept, nothing more killed, deleted or launched', async () => {
    reinstallRecheck({ version: OLD_AD_VERSION })
    const invalidFlags = errInvalidFlags('resume')
    const { cfg, calls } = installEndedRowResumeRejects(invalidFlags)

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const log = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(resolveCalls).toHaveLength(1)
    expect(stops).toHaveLength(1)
    expect(result).toStrictEqual({ key: 'C', action: 'failed', stopping: true })
    expect(notices).toEqual([])
    expect(resumeFailedLines(log)).toEqual([
      `[slack] spawnForPersona: resume failed for ${renderPersonaRef('C', 'C')}: ` +
        `class=${AD_ERROR_CLASS_UNCLASSIFIED} name=${invalidFlags.errName} message=${JSON.stringify(invalidFlags.errDescription)} ` +
        `(after one immediate agent-director version re-check: ${RECHECK_OUTCOME_STOP})`,
    ])
    expect(calls.resumeCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.killCalls).toEqual([])
    expect(calls.deleteCalls).toEqual([])
  })

  test('the re-check answers stop: launchSession answers \'skipped\' (counted toward no failure or cap) and posts nothing', async () => {
    reinstallRecheck({ version: OLD_AD_VERSION })
    const { cfg } = installEndedRowResumeRejects(errInvalidFlags('resume'))

    let result: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      result = await launchSession('C', cfg)
    })

    expect(stops).toHaveLength(1)
    expect(result).toBe('skipped')
    expect(notices).toEqual([])
  })

  // The passing answer is `makeStubResolveSystemBinary`'s default (the
  // installed baseline); could-not-run is a resolve that throws.
  test.each([
    [RECHECK_OUTCOME_PASS, undefined],
    [RECHECK_OUTCOME_COULD_NOT_RUN, { throws: new Error('the resolve failed') }],
  ] as const)('b.jg5 SRJ-105, SRJ-313: the re-check answers %s (exactly one resolveSystemBinary call): UNCLASSIFIED handling — no spawn-failure notice or spawn-failed entry, one refusal line and no resume failed line, { failed, refused }, P\'s timer armed with the UNCLASSIFIED cause, never counted (launchSession \'refused\'), the outcome reported once to P\'s episode; nothing killed, deleted or launched after it; B launches', async (kind, outcome) => {
    if (outcome !== undefined) reinstallRecheck(outcome)
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    const invalidFlags = errInvalidFlags('resume')
    const script = (): RecoveryStubScript => ({ ...collided(h, persona, { state: 'ended' }), resumeError: invalidFlags })
    h.script(script())

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'failed', refused: true })

    expect(resolveCalls).toHaveLength(1)
    expect(stops).toEqual([])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, resume: 1 }))
    expect(h.notices).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(refusalLines(h, p)).toEqual([invalidFlagsRefusalLine(p, invalidFlags, kind)])
    expect(h.errors.filter((line) => line.includes(`resume failed for ${renderPersonaRef(p, p)}: `))).toEqual([])
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(getFailureCount(p)).toBe(0)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    // Reported to P's episode with the site's classification (the classifier
    // alone would call ErrInvalidFlags STATE).
    expect(unclassifiedStartedLines(h, p)).toEqual([`${unclassifiedLinePrefix(p)}started — ${invalidFlagsClassText(invalidFlags)}`])
    expect(h.unclassifiedErrorOpen(p)).toBe(true)
    expect(h.episodeNotices).toEqual([])

    // The restart path's entry: the same answer is refused, never counted.
    h.script(script())
    expect(await launchSession(p, h.config)).toBe('refused')
    expect(getFailureCount(p)).toBe(0)
    expect(resolveCalls).toHaveLength(2)
    expect(h.notices).toEqual([])
    expect(unclassifiedStartedLines(h, p)).toHaveLength(1)

    // B is unaffected.
    h.script(clearedScript(script()))
    expect(await h.launch(b)).toEqual({ key: b, action: 'spawned' })
    expect(h.controller.isArmed(b)).toBe(false)
    expect(h.unclassifiedErrorOpen(b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / SR-6.3 — row-vs-persona comparison (compareRowToPersona)
// ---------------------------------------------------------------------------

describe('compareRowToPersona (b.av2 SR-6.2, SR-6.3)', () => {
  /** Paths for one case, all under this test's fixture dir; `home` is real-pathed. */
  interface CompareFixture {
    work: string
    config: string
    home: string
  }

  function compareFixture(): CompareFixture {
    const home = realpathSync(fixtureSubdir('home'))
    mkdirSync(join(home, '.claude'))
    return { work: fixtureSubdir('work'), config: fixtureSubdir('claude-config'), home }
  }

  // agent-director stores the real path a spawn ran in, so in practice the
  // symlink is on the persona side: its configured working_directory or
  // claude_config_dir. Row-side links are covered too.
  test.each<[string, boolean, (f: CompareFixture) => { rowCwd: string | undefined; personaWork: string }]>([
    ['equal', true, (f) => ({ rowCwd: f.work, personaWork: f.work })],
    [
      'the real directory, persona working_directory a symlink to it',
      true,
      (f) => {
        const link = join(fixtureDir, 'work-link')
        symlinkSync(f.work, link)
        return { rowCwd: realpathSync(f.work), personaWork: link }
      },
    ],
    [
      'a symlink to the working directory',
      true,
      (f) => {
        const link = join(fixtureDir, 'work-link')
        symlinkSync(f.work, link)
        return { rowCwd: link, personaWork: f.work }
      },
    ],
    ['a different existing directory', false, (f) => ({ rowCwd: fixtureSubdir('elsewhere'), personaWork: f.work })],
    ['a nonexistent path (lexical fallback, differs)', false, (f) => ({ rowCwd: join(fixtureDir, 'never-created'), personaWork: f.work })],
    [
      'a nonexistent path (lexical fallback, same after normalisation)',
      true,
      () => ({ rowCwd: join(fixtureDir, 'absent-work') + '/./', personaWork: join(fixtureDir, 'absent-work') }),
    ],
    ['absent', false, (f) => ({ rowCwd: undefined, personaWork: f.work })],
    ['empty', false, (f) => ({ rowCwd: '', personaWork: f.work })],
  ])('row cwd %s → cwdMatches=%p', (_label, expected, build) => {
    const f = compareFixture()
    const { rowCwd, personaWork } = build(f)
    const persona = { working_directory: personaWork, claude_config_dir: f.config }
    const row = { cwd: rowCwd, labels: { config_dir: personaConfigDirLabelValue(f.config, f.home) } }
    expect(compareRowToPersona(row, persona, f.home).cwdMatches).toBe(expected)
  })

  test.each<[string, boolean, (f: CompareFixture) => { label: string | undefined; configDir: string | undefined }]>([
    ['equal', true, (f) => ({ label: configDirLabelValue(realpathSync(f.config)), configDir: f.config })],
    ['missing', false, (f) => ({ label: undefined, configDir: f.config })],
    ['different', false, (f) => ({ label: configDirLabelValue(realpathSync(fixtureSubdir('other-config'))), configDir: f.config })],
    [
      'the one its spawn wrote (the real directory), persona claude_config_dir a symlink to it',
      true,
      (f) => {
        const link = join(fixtureDir, 'config-link')
        symlinkSync(f.config, link)
        return { label: configDirLabelValue(realpathSync(f.config)), configDir: link }
      },
    ],
    [
      'equal, persona with no claude_config_dir (the injected home’s .claude)',
      true,
      (f) => ({ label: configDirLabelValue(join(f.home, '.claude')), configDir: undefined }),
    ],
    [
      'the one its spawn wrote (the real directory), no claude_config_dir and the injected home’s .claude a symlink',
      true,
      (f) => ({ label: configDirLabelValue(linkClaudeDir(f.home)), configDir: undefined }),
    ],
  ])('config_dir label %s → configDirMatches=%p', (_label, expected, build) => {
    const f = compareFixture()
    const { label, configDir } = build(f)
    const labels: Record<string, string> = { service: 'cscb', persona: 'C' }
    if (label !== undefined) labels['config_dir'] = label
    const result = compareRowToPersona({ cwd: f.work, labels }, { working_directory: f.work, claude_config_dir: configDir }, f.home)
    expect(result.configDirMatches).toBe(expected)
    expect(result.configDirLabel).toBe(label)
    // The expected label is the one a spawn of the persona writes.
    expect(result.expectedConfigDirLabel).toBe(personaConfigDirLabelValue(configDir, f.home))
    expect(result.cwdMatches).toBe(true)
  })
})

/** Calls captured by a collision-ladder stub (the cwd and config_dir guard blocks). */
interface LadderCalls {
  spawnCalls: import('agent-director').SpawnParams[]
  killCalls: import('agent-director').KillParams[]
  deleteCalls: import('agent-director').DeleteParams[]
  resumeCalls: import('agent-director').ResumeParams[]
  sendKeysCalls: import('agent-director').SendKeysParams[]
  findMissingCalls: import('agent-director').FindMissingParams[]
}

function newLadderCalls(): LadderCalls {
  return { spawnCalls: [], killCalls: [], deleteCalls: [], resumeCalls: [], sendKeysCalls: [], findMissingCalls: [] }
}

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / AC 4 — a row in another directory is replaced on every
// ladder path (kill + delete + fresh spawn in the persona's working directory)
// ---------------------------------------------------------------------------

describe('collision ladder: cwd guard (b.av2 SR-6.2, AC 4)', () => {
  const COLLISION_STATES = ['ended', 'missing', 'waiting', 'working', 'pending', 'check_permission', 'ask_user'] as const

  /** Persona `C` with working_directory `work` (a real temp directory by default), the seam home installed. */
  function guardConfig(work = fixtureSubdir('work')): { cfg: PersonaConfig; work: string } {
    useSpawnHome()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: work } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    return { cfg, work }
  }

  /** A colliding spawn whose `get` returns `row`; a second spawn succeeds. */
  function installCollision(row: CannedGetResult, calls: LadderCalls, extra: Parameters<typeof makeStubClient>[0] = {}): StubClient {
    return installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: row,
      ...extra,
    })
  }

  test.each([...COLLISION_STATES])('state=%s, row cwd another existing directory → kill + delete + one fresh spawn, no resume or reconnect', async (state) => {
    const { cfg, work } = guardConfig()
    const elsewhere = fixtureSubdir('elsewhere')
    const calls = newLadderCalls()
    installCollision(personaRow(cfg, 'C', { state, cwd: elsewhere }), calls)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    // The colliding spawn plus exactly one fresh spawn, in the persona's directory.
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].claude_instance_id).toBe('cscb_C')
    expect(calls.spawnCalls[1].cwd).toBe(work)
    // Never resumed, reconnected or reconciled-then-resumed.
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.sendKeysCalls.filter((s) => String(s.text).includes('/mcp reconnect'))).toHaveLength(0)
    expect(calls.findMissingCalls).toHaveLength(0)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=${elsewhere} differs from working_directory=${work} (state=${state}) — replacing the row: kill+delete+fresh`,
    )
  })

  test.each([
    ['ended', 'resumed'],
    ['waiting', 'reconnected'],
    ['pending', 'no-op'],
  ] as const)('control: state=%s, persona working_directory a symlink and the row cwd its real directory → normal path (%s), nothing killed or deleted', async (state, action) => {
    const real = fixtureSubdir('work-real')
    const link = join(fixtureDir, 'work-link')
    symlinkSync(real, link)
    const { cfg } = guardConfig(link)
    const calls = newLadderCalls()
    // agent-director records the real path the spawn ran in.
    installCollision(personaRow(cfg, 'C', { state, cwd: realpathSync(real) }), calls)

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action })
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(state === 'ended' ? 1 : 0)
    expect(calls.sendKeysCalls.filter((s) => String(s.text).includes('/mcp reconnect'))).toHaveLength(state === 'waiting' ? 1 : 0)
  })

  test('control: a row cwd that does not exist falls back to lexical comparison and is a mismatch', async () => {
    const { cfg, work } = guardConfig()
    const absent = join(fixtureDir, 'never-created')
    const calls = newLadderCalls()
    installCollision(personaRow(cfg, 'C', { state: 'ended', cwd: absent }), calls)

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].cwd).toBe(work)
  })

  test.each(['empty', 'absent'] as const)('a row with an %s cwd is a mismatch; the log prints cwd=<none>, never cwd=undefined', async (variant) => {
    const { cfg, work } = guardConfig()
    const calls = newLadderCalls()
    const base = personaRow(cfg, 'C', { state: 'ended' })
    const { cwd: _cwd, ...withoutCwd } = base
    installCollision(variant === 'empty' ? { ...base, cwd: '' } : (withoutCwd as CannedGetResult), calls)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.spawnCalls[1].cwd).toBe(work)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=<none> differs from working_directory=${work} (state=ended) — replacing the row`,
    )
    expect(errLog).not.toContain('cwd=undefined')
  })

  test('a failed delete on the mismatch path → failed, no fresh spawn (never two instances)', async () => {
    const readLog = captureStartupErrors()
    const { cfg } = guardConfig()
    const calls = newLadderCalls()
    // A delete failure that is no refusal (a LAUNCH FAILURE answer; an
    // UNCLASSIFIED one is refused, b.jg5 SRJ-313, below).
    const deleteError = errTmuxSessionCreate('delete')
    installCollision(personaRow(cfg, 'C', { state: 'waiting', cwd: fixtureSubdir('elsewhere') }), calls, { deleteError })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.sendKeysCalls).toHaveLength(0)
    const log = readLog()
    expect(log).toContain('[spawn-failed]')
    expect(log).toContain(`delete failed for ${renderPersonaRef('C', 'C')}: ${deleteError.errName}`)
    expect(notices).toHaveLength(1)
    expect(notices[0].key).toBe('C')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 / AC 48 — before any resume, a missing or changed `config_dir`
// label means delete + fresh spawn (a resume would keep the old config dir)
// ---------------------------------------------------------------------------

/** The four ways the ladder reaches a resume. */
const RESUME_ENTRIES = ['ended', 'missing', 'waiting (dead session)', 'working (dead session)'] as const
type ResumeEntry = (typeof RESUME_ENTRIES)[number]

/**
 * Persona `C` with a real working directory and a real per-persona
 * claude_config_dir; `overrides` go to the server-wide settings.
 */
function labelConfig(
  overrides: Partial<Omit<PersonaConfig, 'personas'>> = {},
): { cfg: PersonaConfig; home: string; configDir: string } {
  const home = useSpawnHome()
  const configDir = fixtureSubdir('claude-config')
  const cfg = makeStandInPersonaConfig(
    { C: { working_directory: fixtureSubdir('work'), claude_config_dir: configDir } },
    fixtureDir,
    { agent_director_poll_interval_ms: 1, ...overrides },
  )
  return { cfg, home, configDir }
}

/**
 * Drive `entry` to its resume decision. `ended` / `missing` resolve straight
 * to it; `waiting` meets a dead session through persistent ErrTmuxSendKeys;
 * `working` through the up-front findMissing sweep reconciling the row to
 * `missing`. The resumed or fresh session reports `waiting`, so the dialog
 * approver returns at once. `key` is the persona's key (default the stand-in
 * `C`). Returns the installed stub.
 */
function installResumeEntry(entry: ResumeEntry, row: CannedGetResult, calls: LadderCalls, key = 'C'): StubClient {
  const state = entry.split(' ')[0] as 'ended' | 'missing' | 'waiting' | 'working'
  if (state === 'waiting' || state === 'working') _setTmuxServerEnsurer(async () => {})
  if (state === 'working') _setWaitForWaitingTimeoutMs(30)
  return installStub({
    ...calls,
    spawnQueue: [
      cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${key}` }),
    ],
    getResult: { ...row, state },
    sendKeysError: state === 'waiting' ? errTmuxSendKeys() : undefined,
    findMissingResult: cannedFindMissing({ count: 1, ids: [`cscb_${key}`] }),
    statusFn: () =>
      ({
        state:
          calls.resumeCalls.length > 0 || calls.spawnCalls.length > 1
            ? 'waiting'
            : state === 'working' && calls.findMissingCalls.length > 0
              ? 'missing'
              : state,
      }) as import('agent-director').StatusResult,
  })
}

describe('collision ladder: config_dir guard before resume (b.av2 SR-6.2, AC 48)', () => {
  /** How the row's `config_dir` label relates to the persona's current one. */
  const LABEL_VARIANTS = ['matching', 'changed', 'missing'] as const
  type LabelVariant = (typeof LABEL_VARIANTS)[number]

  /** The row's labels for `variant`. */
  function labelsFor(variant: LabelVariant, cfg: PersonaConfig, home: string): Record<string, string> {
    const base = { ...personaRow(cfg, 'C').labels }
    switch (variant) {
      case 'matching':
        return base
      case 'changed':
        return { ...base, config_dir: personaConfigDirLabelValue(fixtureSubdir('earlier-config'), home) }
      case 'missing': {
        delete base['config_dir']
        return base
      }
    }
  }

  const CASES = RESUME_ENTRIES.flatMap((entry) => LABEL_VARIANTS.map((variant) => [entry, variant] as const))

  test.each(CASES)('%s row, %s config_dir label', async (entry, variant) => {
    const readLog = captureStartupErrors()
    const { cfg, home, configDir } = labelConfig()
    const expectedLabel = personaConfigDirLabelValue(configDir, home)
    const labels = labelsFor(variant, cfg, home)
    const calls = newLadderCalls()
    installResumeEntry(entry, personaRow(cfg, 'C', { labels }), calls)
    const dead = entry.includes('dead session')

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    if (variant === 'matching') {
      // Resumed as before the guard existed.
      expect(result).toEqual({ key: 'C', action: 'resumed' })
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1)
      expect(errLog).not.toContain('config_dir label')
      return
    }

    // No resume: the row is deleted (and killed first when it may still be
    // live) and exactly one fresh spawn follows, carrying the current label
    // and CLAUDE_CONFIG_DIR.
    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(dead ? 1 : 0)
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', `config_dir=${expectedLabel}`])
    expect(calls.spawnCalls[1].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configDir)
    // A fresh spawn, not amnesia: no transcript diagnosis, record or notice.
    const log = readLog()
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
    expect(log).not.toContain('jsonl-diagnosis-inconclusive')
    expect(notices).toHaveLength(0)
    const ref = renderPersonaRef('C', 'C')
    if (variant === 'missing') {
      expect(errLog).toContain(
        `spawnForPersona: ${ref} config_dir label missing (label absent, now=${expectedLabel} for claude_config_dir=${configDir}) — not resuming; spawning fresh`,
      )
    } else {
      expect(errLog).toContain(
        `spawnForPersona: ${ref} config_dir label changed (was=${labels['config_dir']}, now=${expectedLabel} for claude_config_dir=${configDir}) — not resuming; spawning fresh`,
      )
    }
  })

  // agent-director stores the label a spawn wrote, computed from the REAL
  // effective directory; the symlink is on the persona side.
  test.each(['claude_config_dir a symlink', 'no claude_config_dir and the seam home’s .claude a symlink'] as const)(
    'ended row carrying the label its spawn wrote, persona %s → resumed',
    async (variant) => {
      const home = useSpawnHome()
      let configDir: string | undefined
      let real: string
      if (variant === 'claude_config_dir a symlink') {
        real = realpathSync(fixtureSubdir('claude-config'))
        configDir = join(fixtureDir, 'config-link')
        symlinkSync(real, configDir)
      } else {
        real = linkClaudeDir(home)
      }
      const cfg = makeStandInPersonaConfig(
        { C: { working_directory: fixtureSubdir('work'), claude_config_dir: configDir } },
        fixtureDir,
        { agent_director_poll_interval_ms: 1 },
      )
      const labels = { ...personaRow(cfg, 'C').labels, config_dir: configDirLabelValue(real) }
      const calls = newLadderCalls()
      installResumeEntry('ended', personaRow(cfg, 'C', { labels }), calls)

      let result!: Awaited<ReturnType<typeof spawnForPersona>>
      const errLog = await withCapturedErr(async () => {
        result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      })

      expect(result).toEqual({ key: 'C', action: 'resumed' })
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1)
      expect(errLog).not.toContain('config_dir label')
    },
  )

  test('a live waiting row with a matching cwd and a stale label still reconnects (the check applies only before a resume)', async () => {
    const { cfg, home } = labelConfig()
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting', labels: labelsFor('changed', cfg, home) }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'reconnected' })
    expect(calls.sendKeysCalls.map((s) => s.text)).toEqual([`/mcp reconnect ${MCP_SERVER_NAME}`])
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
  })

  test('resume_enabled: false with a stale label keeps its kill + delete + fresh path', async () => {
    const { cfg, home } = labelConfig({ resume_enabled: false })
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended', labels: labelsFor('changed', cfg, home) }),
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(1)
    expect(calls.spawnCalls).toHaveLength(2)
    expect(errLog).toContain(`resume_enabled=false — kill+delete+fresh for ${renderPersonaRef('C', 'C')}`)
    expect(errLog).not.toContain('config_dir label')
  })

  // AC 48 (b.av2 SR-14 "session-manager"): a persona inheriting the top-level
  // claude_config_dir runs; its effective directory then changes through a
  // per-persona override. The row still carries the earlier label, so the
  // ladder deletes it and spawns fresh with the new CLAUDE_CONFIG_DIR.
  test('AC 48: a changed effective claude_config_dir (inherited, then overridden) gives a fresh spawn with the new CLAUDE_CONFIG_DIR', async () => {
    const home = useSpawnHome()
    const work = fixtureSubdir('work')
    const earlier = fixtureSubdir('top-level-config')
    const later = fixtureSubdir('persona-config')
    const before = makeStandInPersonaConfig({ C: { working_directory: work } }, fixtureDir, { claude_config_dir: earlier })
    expect(personaOf(before, 'C').claude_config_dir).toBe(earlier) // inherited
    const after = makeStandInPersonaConfig({ C: { working_directory: work, claude_config_dir: later } }, fixtureDir, { claude_config_dir: earlier })
    expect(personaOf(after, 'C').claude_config_dir).toBe(later) // overridden
    // The row a spawn under the earlier configuration left behind.
    const row = personaRow(before, 'C', { state: 'ended' })
    expect(row.labels['config_dir']).toBe(personaConfigDirLabelValue(earlier, home))

    // Control: under the unchanged configuration the same row resumes.
    const controlResume: import('agent-director').ResumeParams[] = []
    installStub({
      resumeCalls: controlResume,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: row,
    })
    expect(await spawnForPersona(personaOf(before, 'C'), before)).toEqual({ key: 'C', action: 'resumed' })
    expect(controlResume).toHaveLength(1)
    resetClientForTests()

    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    installStub({
      spawnCalls,
      deleteCalls,
      resumeCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: row,
    })

    const result = await spawnForPersona(personaOf(after, 'C'), after)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(resumeCalls).toHaveLength(0)
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].extra_env?.['CLAUDE_CONFIG_DIR']).toBe(later)
    expect(spawnCalls[1].label).toEqual(['service=cscb', 'persona=C', configDirLabelFor(later)])
    expect(spawnCalls[1].label).not.toContain(configDirLabelFor(earlier))
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.2 — the pre-launch trust patch precedes every launch
// ---------------------------------------------------------------------------
//
// The seam is empty by default (and reset in afterEach), so no test here
// installs the production trust patch or writes a `.claude.json`. Order is
// read from one shared event log: the recording patcher and the stub's
// `spawn` / `resume` all append to it.

/** One entry of the shared launch-order log. */
type LaunchEvent = 'patch' | 'spawn' | 'resume'

/**
 * Append 'spawn' / 'resume' to `events` on each such call through `stub`, then
 * delegate to the stub's own verb, so its call captures and queues still apply.
 */
function recordLaunchCalls(stub: StubClient, events: LaunchEvent[]): StubClient {
  return observeLaunchCalls(stub, (call) => events.push(call))
}

/**
 * Install a recording pre-launch trust patcher: each call appends 'patch' to
 * `events`. Returns the personas it was called with, in order.
 */
function installRecordingPatcher(events: LaunchEvent[]): Persona[] {
  const patched: Persona[] = []
  setPreLaunchTrustPatcher((persona) => {
    events.push('patch')
    patched.push(persona)
  })
  return patched
}

describe('pre-launch trust patch (b.av2 SR-6.2)', () => {
  /** One launch path: how to reach it, what it returns and the expected launch-order log. */
  interface LaunchPath {
    install: (cfg: PersonaConfig, calls: LadderCalls) => StubClient
    launch: (cfg: PersonaConfig) => Promise<unknown>
    expected: unknown
    events: LaunchEvent[]
  }

  const spawnC = (cfg: PersonaConfig) => spawnForPersona(personaOf(cfg, 'C'), cfg)

  /**
   * One row per way a ladder reaches agent-director: a fresh spawn, a resume
   * (straight, and after a dead session), the restart adapter, and the two
   * paths that spawn again after a first launch call.
   */
  const LAUNCH_PATHS: Array<[string, LaunchPath]> = [
    ['fresh spawn', {
      install: (_cfg, calls) => installStub({ ...calls }),
      launch: spawnC,
      expected: { key: 'C', action: 'spawned' },
      events: ['patch', 'spawn'],
    }],
    ['resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls),
      launch: spawnC,
      expected: { key: 'C', action: 'resumed' },
      events: ['patch', 'spawn', 'resume'],
    }],
    ['dead-session recovery from a waiting row that resumes', {
      install: (cfg, calls) => installResumeEntry('waiting (dead session)', personaRow(cfg, 'C'), calls),
      launch: spawnC,
      expected: { key: 'C', action: 'resumed' },
      events: ['patch', 'spawn', 'resume'],
    }],
    ['restart launchSession adapter, resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls),
      launch: (cfg) => launchSession('C', cfg),
      expected: true,
      events: ['patch', 'spawn', 'resume'],
    }],
    ['delete then fresh spawn after resume ErrJsonlMissing', {
      install: (cfg, calls) =>
        installStub({
          ...calls,
          spawnQueue: [
            cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
            cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
          ],
          getResult: personaRow(cfg, 'C', { state: 'ended' }),
          resumeError: errJsonlMissing(),
        }),
      launch: spawnC,
      expected: { key: 'C', action: 'fresh-after-inconclusive-amnesia' },
      events: ['patch', 'spawn', 'resume', 'spawn'],
    }],
    ['self-heal after ErrTmuxSessionCreate', {
      install: (_cfg, calls) => {
        _setTmuxSessionKiller(async () => {})
        return installStub({
          ...calls,
          spawnQueue: [
            cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
            cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
          ],
        })
      },
      launch: spawnC,
      expected: { key: 'C', action: 'spawned' },
      events: ['patch', 'spawn', 'spawn'],
    }],
  ]

  test.each(LAUNCH_PATHS)('%s: patched once, for the persona, before its first spawn or resume', async (_name, path) => {
    captureStartupErrors()
    const { cfg, configDir } = labelConfig()
    const persona = personaOf(cfg, 'C')
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    recordLaunchCalls(path.install(cfg, newLadderCalls()), events)

    let result: unknown
    await withCapturedErr(async () => {
      result = await path.launch(cfg)
    })

    expect(result).toEqual(path.expected)
    // Exactly one patch, and it comes before every agent-director launch call.
    expect(events).toEqual(path.events)
    expect(patched).toHaveLength(1)
    // For the persona being launched: its effective config dir and working directory.
    expect(patched[0]).toBe(persona)
    expect(patched[0]!.claude_config_dir).toBe(configDir)
    expect(patched[0]!.working_directory).toBe(persona.working_directory)
  })

  test('a persona whose claude_config_dir overrides the top-level one is patched for its own directory; one that inherits gets the top-level one', async () => {
    useSpawnHome()
    const topLevel = fixtureSubdir('top-level-config')
    const own = fixtureSubdir('persona-config')
    const cfg = makeStandInPersonaConfig(
      {
        C: { working_directory: fixtureSubdir('work-c'), claude_config_dir: own },
        D: { working_directory: fixtureSubdir('work-d') },
      },
      fixtureDir,
      { claude_config_dir: topLevel },
    )
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const patched = installRecordingPatcher([])

    expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'spawned' })
    expect(await spawnForPersona(personaOf(cfg, 'D'), cfg)).toEqual({ key: 'D', action: 'spawned' })

    expect(patched.map((p) => [p.key, p.claude_config_dir, p.working_directory])).toEqual([
      ['C', own, personaOf(cfg, 'C').working_directory],
      ['D', topLevel, personaOf(cfg, 'D').working_directory],
    ])
    // The patched directory is the one the launch runs under.
    expect(spawnCalls.map((p) => p.extra_env?.['CLAUDE_CONFIG_DIR'])).toEqual([own, topLevel])
  })

  test('dry run: the patcher is never called and nothing is launched', async () => {
    process.env['SLACK_DRY_RUN'] = '1'
    const { cfg } = labelConfig()
    const calls = newLadderCalls()
    installStub({ ...calls })
    const patched = installRecordingPatcher([])

    await withCapturedErr(async () => {
      expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'no-op' })
      expect(await launchSession('C', cfg)).toBe(true)
    })

    expect(patched).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(0)
    expect(calls.resumeCalls).toHaveLength(0)
  })

  test('a caller that joins a launch in flight does not patch again; the next ladder patches once more', async () => {
    const { cfg } = labelConfig()
    const persona = personaOf(cfg, 'C')
    let spawnsSeen = 0
    const stub = installStub({})
    // Hold only the first spawn open, so the second caller joins that ladder.
    const held = holdSpawns(stub, () => spawnsSeen++ === 0)
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    recordLaunchCalls(stub, events)

    let results!: Awaited<ReturnType<typeof spawnForPersona>>[]
    const errLog = await withCapturedErr(async () => {
      const a = spawnForPersona(persona, cfg)
      const b = spawnForPersona(persona, cfg)
      await held.entered('cscb_C')
      held.release('cscb_C')
      results = await Promise.all([a, b])
    })

    expect(results[1]).toBe(results[0])
    expect(errLog).toContain(`launch already in flight for ${renderPersonaRef('C', 'C')} — joining it`)
    expect(events).toEqual(['patch', 'spawn'])
    expect(patched).toEqual([persona])

    // A later call is a new ladder: patched once, before its spawn.
    expect(await spawnForPersona(persona, cfg)).toEqual({ key: 'C', action: 'spawned' })
    expect(events).toEqual(['patch', 'spawn', 'patch', 'spawn'])
  })

  test.each([
    ['fresh spawn', 'spawned'],
    ['resume of an ended row', 'resumed'],
  ] as const)('a patcher that throws is logged and the launch goes on (%s → %s)', async (path, action) => {
    const readLog = captureStartupErrors()
    const { cfg } = labelConfig()
    const calls = newLadderCalls()
    if (path === 'fresh spawn') installStub({ ...calls })
    else installResumeEntry('ended', personaRow(cfg, 'C'), calls)
    let attempts = 0
    setPreLaunchTrustPatcher(() => {
      attempts++
      throw Object.assign(new Error('trust patch exploded'), { code: 'EACCES' })
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    // The ladder outcome is what it would be with no patcher at all.
    expect(result).toEqual({ key: 'C', action })
    expect(attempts).toBe(1)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(action === 'resumed' ? 1 : 0)
    expect(errLog).toContain(
      `spawnForPersona: pre-launch trust patch failed for ${renderPersonaRef('C', 'C')} — launching anyway: `,
    )
    // Described the safe-to-log way: its type and code.
    expect(errLog).toContain('launching anyway: Error code=EACCES')
    // Logged only: no startup error, no spawn-failure notice.
    expect(readLog()).toBe('')
    expect(notices).toHaveLength(0)
  })

  test("with no patcher installed (the default, and after the test-only reset) no patch runs and the persona's .claude.json is untouched", async () => {
    const { cfg, configDir } = labelConfig()
    // A patchable file in the persona's config dir: any trust patch would add
    // the working directory to `projects`.
    const claudeJson = join(configDir, '.claude.json')
    writeFileSync(claudeJson, '{"projects":{}}')
    const before = readFileSync(claudeJson)
    const patched = installRecordingPatcher([])
    _resetPreLaunchTrustPatcher()
    const calls = newLadderCalls()
    installStub({ ...calls })

    expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'spawned' })

    expect(patched).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(readFileSync(claudeJson).equals(before)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-9.4 / SR-6.2 — the reply-guard pre-launch step precedes every
// spawn and resume (E10 Director decisions 1, 2 and 9)
// ---------------------------------------------------------------------------
//
// The real `preLaunchReplyGuard` is installed through `setPreLaunchReplyGuard`
// (`installRecordingReplyGuard`, tests/test-helpers/reply-guard-launch.ts),
// bound to a per-test `mkdtempSync` state directory (`makeReplyGuardRecordDir`,
// removed in afterEach) and the test's applied persona set. The file-level
// afterEach resets the seam and the launched-with directories. The persona
// has a hashed key (`Guard Desk`), because a record key must be a real
// persona key, and its own temp claude_config_dir, so the launch-time hook
// pass only ever writes under the fixture directory.
//
// Order comes from one shared log: the installed step appends 'guard', its
// undo 'undo', and the stub's `spawn` / `resume` their verb
// (`observeLaunchCalls`, same helper). At each spawn or
// resume the stub also snapshots the record's exact text, the launched-with
// directory and whether the persona's settings.json holds the managed hook.

/** The reply-guard persona: its name differs from its hashed key. */
const GUARD_NAME = 'Guard Desk'
const GUARD_KEY = personaKey(GUARD_NAME)
const GUARD_INSTANCE = `${PERSONA_INSTANCE_ID_PREFIX}${GUARD_KEY}`

/** One entry of the reply-guard order log. */
type GuardEvent = 'guard' | 'undo' | 'spawn' | 'resume'

/** What the stub saw at one spawn or resume call. */
interface GuardSnapshot {
  call: LaunchCall
  /** The record's exact text, or null when there is none. */
  record: string | null
  launchedWith: string | undefined
  /** Whether the persona's settings.json held the managed reply-guard hook. */
  hooked: boolean
}

describe('pre-launch reply guard (b.av2 SR-9.4, SR-6.2)', () => {
  let rg: ReplyGuardRecordDir

  beforeEach(() => {
    rg = makeReplyGuardRecordDir()
  })

  afterEach(() => {
    rg.cleanup()
  })

  type SpawnResult = import('agent-director').SpawnResult
  const collision = () => cannedErr<SpawnResult>(errInstanceIdCollision())
  const spawnOk = () => cannedOk<SpawnResult>({ claude_instance_id: GUARD_INSTANCE })

  /**
   * The reply-guard persona with a real working directory and its own real
   * claude_config_dir; `spec` adds persona fields.
   */
  function guardConfig(spec: { stop_hook_bootstrap?: boolean } = {}): { cfg: PersonaConfig; persona: Persona; configDir: string } {
    useSpawnHome()
    const configDir = fixtureSubdir('claude-config')
    const cfg = makeMultiPersonaConfig(
      [{ name: GUARD_NAME, working_directory: fixtureSubdir('work'), claude_config_dir: configDir, ...spec }],
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
    return { cfg, persona: personaOf(cfg, GUARD_KEY), configDir }
  }

  /** Whether `dir`/settings.json holds the managed hook for this test's state directory. */
  function hookedIn(dir: string): boolean {
    const path = join(dir, 'settings.json')
    if (!existsSync(path)) return false
    return readFileSync(path, 'utf-8').includes(JSON.stringify(managedHookCommand(rg.stateDir)))
  }

  /**
   * Log each spawn / resume through `stub` to `events` and snapshot the
   * persona's record, launched-with dir and hook at that moment.
   */
  function observeGuardCalls(stub: StubClient, configDir: string, events: GuardEvent[], seen: GuardSnapshot[]): StubClient {
    return observeLaunchCalls(stub, (call) => {
      events.push(call)
      seen.push({ call, record: rg.readRecord(GUARD_KEY), launchedWith: getLaunchedWithDir(GUARD_KEY), hooked: hookedIn(configDir) })
    })
  }

  /** A ladder row for the reply-guard persona (its cwd and config_dir label match unless overridden). */
  function guardRow(cfg: PersonaConfig, overrides: PersonaGetResultOverrides = {}): CannedGetResult {
    return personaRow(cfg, GUARD_KEY, overrides)
  }

  /** One launch path: how to reach it, its `spawnForPersona` action and its order log. */
  interface GuardPath {
    install: (cfg: PersonaConfig, calls: LadderCalls) => StubClient
    expected: string
    events: GuardEvent[]
  }

  /** A stub whose first spawn collides with a row `row` and whose resume rejects with `resumeError`. */
  function installResumeRejects(row: CannedGetResult, calls: LadderCalls, resumeError: Error): StubClient {
    _setTmuxSessionKiller(async () => {})
    return installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getResult: row, resumeError })
  }

  const SPAWN = ['guard', 'spawn'] as const satisfies readonly GuardEvent[]
  /** The optimistic spawn met a row: its step is undone before the ladder goes on. */
  const COLLIDED = ['guard', 'spawn', 'undo'] as const satisfies readonly GuardEvent[]
  const RESUME = ['guard', 'resume'] as const satisfies readonly GuardEvent[]

  /**
   * The ticket's named paths (fresh spawn; resume of an ended or missing row;
   * dead-session recovery; a fresh spawn after a cwd or config_dir mismatch),
   * which between them reach the optimistic spawn, `client.resume` and
   * `replaceWithFreshSpawn`, plus one row for each other spawn call site: the
   * single retry after ErrSpawnNotFound on the post-collision get, the
   * self-heal respawn, and each fallback spawn in `resumeOrFreshSpawn`.
   * Paths that share a call site with a row here (resume_enabled false, a
   * dead working row, the other delete-then-spawn resume errors, the restart
   * adapter — covered end to end in restart.test.ts) have no row of their own.
   */
  const GUARD_PATHS: Array<[string, GuardPath]> = [
    ['fresh spawn', {
      install: (_cfg, calls) => installStub({ ...calls }),
      expected: 'spawned',
      events: [...SPAWN],
    }],
    ['resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', guardRow(cfg), calls, GUARD_KEY),
      expected: 'resumed',
      events: [...COLLIDED, ...RESUME],
    }],
    ['resume of a missing row', {
      install: (cfg, calls) => installResumeEntry('missing', guardRow(cfg), calls, GUARD_KEY),
      expected: 'resumed',
      events: [...COLLIDED, ...RESUME],
    }],
    ['dead-session recovery from a waiting row', {
      install: (cfg, calls) => installResumeEntry('waiting (dead session)', guardRow(cfg), calls, GUARD_KEY),
      expected: 'resumed',
      events: [...COLLIDED, ...RESUME],
    }],
    ['live row in another directory (cwd mismatch): kill + delete + fresh spawn', {
      install: (cfg, calls) =>
        installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getResult: guardRow(cfg, { state: 'waiting', cwd: fixtureSubdir('elsewhere') }) }),
      expected: 'spawned',
      events: [...COLLIDED, ...SPAWN],
    }],
    ['ended row with a changed config_dir label: delete + fresh spawn', {
      install: (cfg, calls) => {
        const labels = { ...guardRow(cfg).labels, config_dir: personaConfigDirLabelValue(fixtureSubdir('earlier-config'), ladderHome()) }
        return installResumeEntry('ended', guardRow(cfg, { labels }), calls, GUARD_KEY)
      },
      expected: 'spawned',
      events: [...COLLIDED, ...SPAWN],
    }],
    ['ErrSpawnNotFound on the post-collision get: the single retry spawn', {
      install: (_cfg, calls) => installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getError: errSpawnNotFound() }),
      expected: 'spawned',
      events: [...COLLIDED, ...SPAWN],
    }],
    ['self-heal respawn after ErrTmuxSessionCreate on the first spawn', {
      install: (_cfg, calls) => {
        _setTmuxSessionKiller(async () => {})
        return installStub({ ...calls, spawnQueue: [cannedErr<SpawnResult>(errTmuxSessionCreate('spawn')), spawnOk()] })
      },
      expected: 'spawned',
      // Not a collision: the first step is not undone, and the respawn runs its own.
      events: [...SPAWN, ...SPAWN],
    }],
    ['resume ErrJsonlMissing: delete + fresh spawn', {
      install: (cfg, calls) => installResumeRejects(guardRow(cfg, { state: 'ended' }), calls, errJsonlMissing()),
      expected: 'fresh-after-inconclusive-amnesia',
      events: [...COLLIDED, ...RESUME, ...SPAWN],
    }],
    ['resume ErrSpawnNotResumable: kill + delete + fresh spawn', {
      install: (cfg, calls) => installResumeRejects(guardRow(cfg, { state: 'ended' }), calls, errSpawnNotResumable()),
      expected: 'spawned',
      events: [...COLLIDED, ...RESUME, ...SPAWN],
    }],
    ['resume ErrSpawnNotFound: fresh spawn', {
      install: (cfg, calls) => installResumeRejects(guardRow(cfg, { state: 'ended' }), calls, errSpawnNotFound()),
      expected: 'spawned',
      events: [...COLLIDED, ...RESUME, ...SPAWN],
    }],
  ]

  test.each(GUARD_PATHS)('%s: the record holds the effective value, and the hook is in place, before each spawn or resume', async (_name, path) => {
    captureStartupErrors()
    const { cfg, persona, configDir } = guardConfig()
    const events: GuardEvent[] = []
    const seen: GuardSnapshot[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    observeGuardCalls(path.install(cfg, calls), configDir, events, seen)

    let result: unknown
    await withCapturedErr(async () => {
      result = await spawnForPersona(persona, cfg)
    })

    expect(result).toEqual({ key: GUARD_KEY, action: path.expected })
    // Each spawn and resume is immediately preceded by its own step.
    expect(events).toEqual(path.events)
    expect(seen.map((s) => s.call)).toEqual(path.events.filter((e): e is LaunchCall => e === 'spawn' || e === 'resume'))
    for (const snap of seen) {
      expect(snap).toEqual({ call: snap.call, record: 'true', launchedWith: configDir, hooked: true })
    }
    // The launch leaves the persona's record and launched-with dir in place.
    expect(rg.readRecord(GUARD_KEY)).toBe('true')
    expect(getLaunchedWithDir(GUARD_KEY)).toBe(configDir)
  })

  // Production reads only the persona's own effective `stop_hook_bootstrap`
  // (the loader's inheritance is covered in stop-hook-bootstrap.test.ts), and
  // GUARD_PATHS covers `true`; this is the `false` value on each launch verb.
  test.each([
    ['fresh spawn', 'spawned', ['spawn']],
    ['resume of an ended row', 'resumed', ['spawn', 'resume']],
  ] as const)('stop_hook_bootstrap false (%s): the record reads exactly false before each call and no hook is installed', async (path, action, verbs) => {
    const { cfg, persona, configDir } = guardConfig({ stop_hook_bootstrap: false })
    expect(persona.stop_hook_bootstrap).toBe(false)
    const events: GuardEvent[] = []
    const seen: GuardSnapshot[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    const stub = path === 'fresh spawn'
      ? installStub({ ...calls })
      : installResumeEntry('ended', guardRow(cfg), calls, GUARD_KEY)
    observeGuardCalls(stub, configDir, events, seen)

    await withCapturedErr(async () => {
      expect(await spawnForPersona(persona, cfg)).toEqual({ key: GUARD_KEY, action })
    })

    expect(seen.map((s) => s.call)).toEqual([...verbs])
    // The exact text `false`, and no managed hook for a disabled persona.
    for (const snap of seen) expect(snap).toEqual({ call: snap.call, record: 'false', launchedWith: configDir, hooked: false })
    expect(rg.readRecord(GUARD_KEY)).toBe('false')
  })

  /**
   * Leave the persona's running instance as an earlier launch left it: that
   * launch's real step, for the persona as it was then (`then`), over the
   * persona set as it was then.
   */
  function launchedEarlier(persona: Persona, then: Partial<Persona>): void {
    const earlier = { ...persona, ...then }
    preLaunchReplyGuard(earlier, [earlier], rg.stateDir)
  }

  // Every live state runs the same undo; one reconnect branch and one no-op
  // branch here (the decision-9 table below covers a live waiting row).
  test.each([
    ['working', 'reconnected'],
    ['pending', 'no-op'],
  ] as const)('a live %s row (%s): no launch, so the running instance keeps its record, launched-with dir and hook', async (state, action) => {
    // The instance launched enabled; the persona is now configured off.
    const { cfg, persona, configDir } = guardConfig({ stop_hook_bootstrap: false })
    launchedEarlier(persona, { stop_hook_bootstrap: true })
    expect(rg.readRecord(GUARD_KEY)).toBe('true')
    expect(hookedIn(configDir)).toBe(true)
    const events: GuardEvent[] = []
    const seen: GuardSnapshot[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    observeGuardCalls(installStub({ ...calls, spawnQueue: [collision()], getResult: guardRow(cfg, { state }) }), configDir, events, seen)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    await withCapturedErr(async () => {
      result = await spawnForPersona(persona, cfg)
    })

    expect(result).toEqual({ key: GUARD_KEY, action })
    // Only the optimistic spawn ran a step, and it was undone (decision 9).
    expect(events).toEqual([...COLLIDED])
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.resumeCalls).toHaveLength(0)
    expect(rg.readRecord(GUARD_KEY)).toBe('true')
    expect(getLaunchedWithDir(GUARD_KEY)).toBe(configDir)
    expect(hookedIn(configDir)).toBe(true)
  })

  test.each([
    {
      label: 'a record reading true from the running instance, the persona now off',
      spec: { stop_hook_bootstrap: false },
      earlier: { stop_hook_bootstrap: true } as Partial<Persona> | undefined,
      atCall: { record: 'false', dir: 'current', hooked: false },
      after: { record: 'true', dir: 'current', hooked: true },
    },
    {
      label: 'a record reading false and another launched-with dir, the persona now on',
      spec: { stop_hook_bootstrap: true },
      earlier: { stop_hook_bootstrap: false, claude_config_dir: 'previous' } as Partial<Persona> | undefined,
      atCall: { record: 'true', dir: 'current', hooked: true },
      after: { record: 'false', dir: 'previous', hooked: true },
    },
    {
      label: 'no record and no launched-with dir',
      spec: { stop_hook_bootstrap: true },
      earlier: undefined,
      atCall: { record: 'true', dir: 'current', hooked: true },
      after: { record: null, dir: undefined, hooked: true },
    },
  ] as const)('decision 9: the optimistic spawn meets ErrInstanceIdCollision (live waiting row) — $label: its step is undone', async ({ spec, earlier, atCall, after }) => {
    const { cfg, persona, configDir } = guardConfig(spec)
    const previousDir = fixtureSubdir('previous-config')
    const dirOf = (d: 'current' | 'previous' | undefined) => (d === 'current' ? configDir : d === 'previous' ? previousDir : undefined)
    if (earlier) {
      launchedEarlier(persona, { ...earlier, ...(earlier.claude_config_dir ? { claude_config_dir: previousDir } : {}) })
    }
    const before = rg.readRecord(GUARD_KEY)
    const events: GuardEvent[] = []
    const seen: GuardSnapshot[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    observeGuardCalls(installStub({ ...calls, spawnQueue: [collision()], getResult: guardRow(cfg, { state: 'waiting' }) }), configDir, events, seen)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    await withCapturedErr(async () => {
      result = await spawnForPersona(persona, cfg)
    })

    expect(result).toEqual({ key: GUARD_KEY, action: 'reconnected' })
    expect(events).toEqual([...COLLIDED])
    // The step ran before the optimistic spawn…
    expect(seen).toEqual([{ call: 'spawn', record: atCall.record, launchedWith: dirOf(atCall.dir), hooked: atCall.hooked }])
    // …and the undo restored the previous text (or deleted the record), the
    // launched-with dir and, through the re-run launch pass, the hook.
    expect(rg.readRecord(GUARD_KEY)).toBe(after.record)
    expect(rg.readRecord(GUARD_KEY)).toBe(before)
    expect(getLaunchedWithDir(GUARD_KEY)).toBe(dirOf(after.dir))
    expect(hookedIn(configDir)).toBe(after.hooked)
  })

  test('dry run: no step runs — no record, record directory, launched-with dir or settings.json — and nothing is launched', async () => {
    process.env['SLACK_DRY_RUN'] = '1'
    const { cfg, persona, configDir } = guardConfig()
    const events: GuardEvent[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    observeGuardCalls(installStub({ ...calls }), configDir, events, [])

    await withCapturedErr(async () => {
      expect(await spawnForPersona(persona, cfg)).toEqual({ key: GUARD_KEY, action: 'no-op' })
      expect(await launchSession(GUARD_KEY, cfg)).toBe(true)
    })

    expect(events).toEqual([])
    expect(calls).toEqual(newLadderCalls())
    expect(existsSync(rg.recordDir)).toBe(false)
    expect(getLaunchedWithDir(GUARD_KEY)).toBeUndefined()
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false)
  })

  test('the record cannot be written (a regular file where reply-guard/ belongs): the spawn still reaches agent-director and one log line names the persona key', async () => {
    const readLog = captureStartupErrors()
    const { cfg, persona, configDir } = guardConfig()
    // A file, not a directory: unwritable even for root, which ignores mode bits.
    writeFileSync(rg.recordDir, 'not a directory')
    const events: GuardEvent[] = []
    const seen: GuardSnapshot[] = []
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const calls = newLadderCalls()
    observeGuardCalls(installStub({ ...calls }), configDir, events, seen)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(persona, cfg)
    })

    expect(result).toEqual({ key: GUARD_KEY, action: 'spawned' })
    expect(events).toEqual([...SPAWN])
    expect(calls.spawnCalls.map((p) => p.claude_instance_id)).toEqual([GUARD_INSTANCE])
    const lines = errLog.split('\n').filter((l) => l.includes('reply-guard: could not write the record'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`[slack] reply-guard: could not write the record for ${renderPersonaRef(GUARD_NAME, GUARD_KEY)} at `)
    expect(lines[0]).toContain(`key=${GUARD_KEY}`)
    expect(lines[0]).toContain('launching anyway')
    // The file is left as it was; the failure is a log line, not a startup error or a notice.
    expect(readFileSync(rg.recordDir, 'utf-8')).toBe('not a directory')
    expect(readLog()).toBe('')
    expect(notices).toHaveLength(0)
  })

  // AC 20 (b.av2 SR-10.3): a guard, or its undo, that throws an error whose
  // message and properties carry fake tokens is logged by description only:
  // type, safe code and the redacted message.
  const guardError = (step: string): Error =>
    Object.assign(new Error(leakyMessage(`${step} failed`, step)), { code: 'EIO', detail: LEAK_SENTINEL })

  test.each([
    ['the guard throws (fresh spawn)', 'spawned', 'guard', 'pre-launch reply guard failed', ' — launching anyway: '],
    ['its undo throws (the optimistic spawn met an ended row, which is resumed)', 'resumed', 'undo', 'undoing the pre-launch reply guard failed', ': '],
  ] as const)('AC 20: %s with an error carrying fake tokens — the launch goes on; one line names the error with its redacted message; nothing logged leaks', async (_label, action, step, fragment, separator) => {
    const readLog = captureStartupErrors()
    const { cfg, persona } = guardConfig()
    const calls = newLadderCalls()
    if (action === 'spawned') {
      setPreLaunchReplyGuard(() => { throw guardError('guard') })
      installStub({ ...calls })
    } else {
      setPreLaunchReplyGuard(() => () => { throw guardError('undo') })
      installResumeEntry('ended', guardRow(cfg), calls, GUARD_KEY)
    }

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(persona, cfg)
    })

    expect(result).toEqual({ key: GUARD_KEY, action })
    expect(errLog.split('\n').filter((l) => l.includes(fragment)).map((l) => l.split(' at ')[0])).toEqual([
      `[slack] spawnForPersona: ${fragment} for ${renderPersonaRef(GUARD_NAME, GUARD_KEY)}${separator}Error code=EIO message=${JSON.stringify(redactedLeakyMessage(`${step} failed`))}`,
    ])
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })
})

// ---------------------------------------------------------------------------
// b.svb / b.f2b — Claude Code's prompt suggestions are off in every persona
// session. Its end-of-turn suggestion fork runs the session's PreToolUse
// hooks and flips an idle persona's row to `working`, so every spawn a ladder
// makes carries CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false in `extra_env`.
// agent-director's resume takes only the instance ID and restores the env it
// stored with the row at spawn, so a resume passes nothing else.
// ---------------------------------------------------------------------------

describe('prompt suggestions off on every launch (b.svb, b.f2b)', () => {
  type SpawnResult = import('agent-director').SpawnResult
  const collision = () => cannedErr<SpawnResult>(errInstanceIdCollision())
  const spawnOk = () => cannedOk<SpawnResult>({ claude_instance_id: 'cscb_C' })

  /** The env var and value every persona launch must run with, written out here, not taken from src. */
  const VAR = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'
  const OFF = 'false'

  /** One launch path: how to reach it, its result, and how many spawn and resume calls it makes. */
  interface EnvPath {
    config?: Partial<Omit<PersonaConfig, 'personas'>>
    install: (cfg: PersonaConfig, calls: LadderCalls) => StubClient
    launch?: (cfg: PersonaConfig) => Promise<unknown>
    expected: unknown
    spawns: number
    resumes: number
  }

  const spawned = { key: 'C', action: 'spawned' } as const
  const resumed = { key: 'C', action: 'resumed' } as const

  /** A stub whose first spawn collides with an ended row and whose resume rejects with `resumeError`. */
  function installResumeRejects(cfg: PersonaConfig, calls: LadderCalls, resumeError: Error): StubClient {
    _setTmuxSessionKiller(async () => {})
    return installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getResult: personaRow(cfg, 'C', { state: 'ended' }), resumeError })
  }

  /**
   * Every way a launch reaches agent-director: the fresh spawn; a resume
   * (ended, missing, dead waiting and working rows, the restart relaunch);
   * each replacement spawn (resume_enabled false, cwd and config_dir
   * mismatches, the retry after ErrSpawnNotFound on the get); the b.vub
   * self-heal respawn (after the first spawn and after a resume); and each
   * fresh spawn after a rejected resume, the fresh-after-amnesia one included.
   */
  const ENV_PATHS: Array<[string, EnvPath]> = [
    ['fresh spawn', { install: (_cfg, calls) => installStub({ ...calls }), expected: spawned, spawns: 1, resumes: 0 }],
    ['resume of an ended row', { install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls), expected: resumed, spawns: 1, resumes: 1 }],
    ['resume of a missing row', { install: (cfg, calls) => installResumeEntry('missing', personaRow(cfg, 'C'), calls), expected: resumed, spawns: 1, resumes: 1 }],
    ['dead-session recovery from a waiting row', {
      install: (cfg, calls) => installResumeEntry('waiting (dead session)', personaRow(cfg, 'C'), calls),
      expected: resumed, spawns: 1, resumes: 1,
    }],
    ['dead-session recovery from a working row', {
      install: (cfg, calls) => installResumeEntry('working (dead session)', personaRow(cfg, 'C'), calls),
      expected: resumed, spawns: 1, resumes: 1,
    }],
    ['restart relaunch (launchSession), resume of an ended row', {
      install: (cfg, calls) => installResumeEntry('ended', personaRow(cfg, 'C'), calls),
      launch: (cfg) => launchSession('C', cfg),
      expected: true, spawns: 1, resumes: 1,
    }],
    ['resume_enabled false: kill + delete + fresh spawn', {
      config: { resume_enabled: false },
      install: (cfg, calls) => installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getResult: personaRow(cfg, 'C', { state: 'ended' }) }),
      expected: spawned, spawns: 2, resumes: 0,
    }],
    ['live row in another directory (cwd mismatch): kill + delete + fresh spawn', {
      install: (cfg, calls) =>
        installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getResult: personaRow(cfg, 'C', { state: 'waiting', cwd: fixtureSubdir('elsewhere') }) }),
      expected: spawned, spawns: 2, resumes: 0,
    }],
    ['ended row with a changed config_dir label: delete + fresh spawn', {
      install: (cfg, calls) => {
        const labels = { ...personaRow(cfg, 'C').labels, config_dir: personaConfigDirLabelValue(fixtureSubdir('earlier-config'), ladderHome()) }
        return installResumeEntry('ended', personaRow(cfg, 'C', { labels }), calls)
      },
      expected: spawned, spawns: 2, resumes: 0,
    }],
    ['ErrSpawnNotFound on the post-collision get: the single retry spawn', {
      install: (_cfg, calls) => installStub({ ...calls, spawnQueue: [collision(), spawnOk()], getError: errSpawnNotFound() }),
      expected: spawned, spawns: 2, resumes: 0,
    }],
    ['self-heal respawn after ErrTmuxSessionCreate on the first spawn', {
      install: (_cfg, calls) => {
        _setTmuxSessionKiller(async () => {})
        return installStub({ ...calls, spawnQueue: [cannedErr<SpawnResult>(errTmuxSessionCreate('spawn')), spawnOk()] })
      },
      expected: spawned, spawns: 2, resumes: 0,
    }],
    ['self-heal respawn after ErrTmuxSessionCreate on resume', {
      install: (cfg, calls) => installResumeRejects(cfg, calls, errTmuxSessionCreate('resume')),
      expected: spawned, spawns: 2, resumes: 1,
    }],
    ['resume ErrJsonlMissing: delete + fresh spawn (fresh after amnesia)', {
      install: (cfg, calls) => installResumeRejects(cfg, calls, errJsonlMissing()),
      expected: { key: 'C', action: 'fresh-after-inconclusive-amnesia' }, spawns: 2, resumes: 1,
    }],
    ['resume ErrNoSessionId: delete + fresh spawn', {
      install: (cfg, calls) => installResumeRejects(cfg, calls, errNoSessionId()),
      expected: spawned, spawns: 2, resumes: 1,
    }],
    ['resume ErrSpawnNotResumable: kill + delete + fresh spawn', {
      install: (cfg, calls) => installResumeRejects(cfg, calls, errSpawnNotResumable()),
      expected: spawned, spawns: 2, resumes: 1,
    }],
    ['resume ErrSpawnNotFound: fresh spawn', {
      install: (cfg, calls) => installResumeRejects(cfg, calls, errSpawnNotFound()),
      expected: spawned, spawns: 2, resumes: 1,
    }],
  ]

  test.each(ENV_PATHS)('%s: every spawn carries it in extra_env; a resume passes only the instance ID', async (_name, path) => {
    captureStartupErrors()
    const { cfg } = labelConfig(path.config)
    const calls = newLadderCalls()
    path.install(cfg, calls)

    let result: unknown
    await withCapturedErr(async () => {
      result = await (path.launch ?? ((c: PersonaConfig) => spawnForPersona(personaOf(c, 'C'), c)))(cfg)
    })

    expect(result).toEqual(path.expected)
    expect(calls.spawnCalls).toHaveLength(path.spawns)
    expect(calls.resumeCalls).toHaveLength(path.resumes)
    for (const params of calls.spawnCalls) expect(params.extra_env?.[VAR]).toBe(OFF)
    for (const params of calls.resumeCalls) expect(params).toEqual({ claude_instance_id: 'cscb_C' })
  })

  test('a row this version spawned resumes with it: agent-director restores the env stored at the spawn', async () => {
    captureStartupErrors()
    const { cfg } = labelConfig()
    // agent-director's side, modelled: a successful spawn stores its extra_env
    // with the row; a resume launches with the env stored for its instance ID.
    const stored = new Map<string, Record<string, string> | undefined>()
    const launches: Array<{ call: 'spawn' | 'resume'; env: Record<string, string> | undefined }> = []
    const modelStoredEnv = (stub: StubClient): void => {
      const spawn = stub.spawn.bind(stub)
      const resume = stub.resume.bind(stub)
      stub.spawn = async (params) => {
        launches.push({ call: 'spawn', env: params.extra_env })
        const r = await spawn(params)
        stored.set(String(params.claude_instance_id), params.extra_env)
        return r
      }
      stub.resume = async (params) => {
        launches.push({ call: 'resume', env: stored.get(params.claude_instance_id) })
        return resume(params)
      }
    }

    // First launch: a fresh spawn creates the row.
    modelStoredEnv(installStub({ ...newLadderCalls() }))
    await withCapturedErr(async () => {
      expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual(spawned)
    })
    // The row ends; the next launch meets it and resumes it.
    modelStoredEnv(installResumeEntry('ended', personaRow(cfg, 'C'), newLadderCalls()))
    await withCapturedErr(async () => {
      expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual(resumed)
    })

    expect(launches.map((l) => l.call)).toEqual(['spawn', 'spawn', 'resume'])
    for (const launch of launches) expect(launch.env?.[VAR]).toBe(OFF)
  })
})

// ---------------------------------------------------------------------------
// launchSession's relaunch gate (b.av2 SR-6.1: a persona whose Slack
// connection is not serving is not relaunched). The server passes
// `createPersonaRelaunchGate` as `canLaunch`; tests/persona-relaunch-gate.test.ts
// covers the gate itself.
// ---------------------------------------------------------------------------

describe('launchSession: the relaunch gate (canLaunch)', () => {
  /** Persona C with a recording trust patcher and a stub whose spawn and resume calls are logged with the patch. */
  function gateFixture() {
    const readLog = captureStartupErrors()
    const { cfg } = labelConfig()
    const events: LaunchEvent[] = []
    const patched = installRecordingPatcher(events)
    const calls = newLadderCalls()
    recordLaunchCalls(installStub({ ...calls }), events)
    return { cfg, events, patched, calls, readLog }
  }

  test('canLaunch false: \'skipped\' — the gate is asked once with the key; no trust patch, no agent-director call, no notice, no startup error', async () => {
    const f = gateFixture()
    const asked: string[] = []

    let result: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchSession('C', f.cfg, { canLaunch: (key) => (asked.push(key), false) })
    })

    expect(result).toBe('skipped')
    expect(asked).toEqual(['C'])
    expect(f.events).toEqual([])
    expect(f.patched).toEqual([])
    expect(f.calls).toEqual(newLadderCalls())
    expect(notices).toEqual([])
    expect(f.readLog()).toBe('')
    expect(errLog).toBe('')
  })

  test('canLaunch true: launched as without a gate — patched once, then spawned; true', async () => {
    const f = gateFixture()

    let result: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      result = await launchSession('C', f.cfg, { canLaunch: () => true })
    })

    expect(result).toBe(true)
    expect(f.events).toEqual(['patch', 'spawn'])
    expect(f.calls.spawnCalls.map((p) => p.claude_instance_id)).toEqual(['cscb_C'])
  })

  // The gate is asked first (b.av2 SR-8.6: a key a confirmed apply removed is
  // 'skipped', not a failure); a key the gate lets through that no applied
  // persona has is still a failure that launches nothing.
  test('an unknown key the gate lets through is false: the gate is asked once, then nothing is patched or launched', async () => {
    const f = gateFixture()
    const asked: string[] = []

    expect(await launchSession('C_UNKNOWN', f.cfg, { canLaunch: (key) => (asked.push(key), true) })).toBe(false)

    expect(asked).toEqual(['C_UNKNOWN'])
    expect(f.events).toEqual([])
    expect(f.patched).toEqual([])
    expect(f.calls).toEqual(newLadderCalls())
    expect(notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-8.6 — a key outside the applied set is never launched. From a
// confirmed apply's step 1 on, the server's relaunch gate (the real
// `createPersonaRelaunchGate`, with the bring-up controller's `isApplied`)
// refuses a removed key, whether or not the config the restart path passes
// still holds it; `launchSession` asks the gate before it looks the key up.
// ---------------------------------------------------------------------------

describe('launchSession: a key outside the applied set (b.av2 SR-8.6)', () => {
  const SERVING: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0APPLIED', botId: 'B0APPLIED' } }

  /**
   * The reply-guard persona (its connection serving, its bring-up `up`) with
   * a real working directory and claude_config_dir, a recording trust
   * patcher, the real reply guard over a temp record dir and a stub recording
   * every verb. The applied set, read live by the gate and the reply guard,
   * starts as the persona's config; `applied` replaces it.
   */
  function appliedFixture() {
    const readLog = captureStartupErrors()
    useSpawnHome()
    const configDir = fixtureSubdir('claude-config')
    const cfg = makeMultiPersonaConfig(
      [{ name: GUARD_NAME, working_directory: fixtureSubdir('work'), claude_config_dir: configDir }],
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
    let appliedSet: readonly Persona[] = cfg.personas
    const events: Array<LaunchEvent | 'guard' | 'undo'> = []
    setPreLaunchTrustPatcher(() => void events.push('patch'))
    const rg = makeReplyGuardRecordDir({ parentDir: fixtureDir })
    installRecordingReplyGuard(() => appliedSet, rg.stateDir, events)
    const calls = makeStubCallLog()
    observeLaunchCalls(installStub(calls), (call) => events.push(call))
    const gateLines: string[] = []
    const canLaunch = createPersonaRelaunchGate({ status: () => SERVING }, (line) => gateLines.push(line), {
      isUp: () => true,
      isApplied: (key) => appliedSet.some((p) => p.key === key),
    })
    const applied = (personas: readonly Persona[]): void => {
      appliedSet = personas
    }
    return { cfg, configDir, events, calls, rg, gateLines, canLaunch, applied, readLog }
  }

  test.each([
    ['the config passed still holds it (a stale snapshot)', true],
    ['the config passed no longer holds it', false],
  ] as const)('removed from the applied set, %s: \'skipped\', one gate line, no agent-director call, no trust patch, no reply-guard record or hook', async (_label, passStale) => {
    const f = appliedFixture()
    // Step 1 of an apply that removes the persona: the applied set no longer holds it.
    f.applied([])
    const passed = passStale ? f.cfg : { ...f.cfg, personas: [] }

    let result: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchSession(GUARD_KEY, passed, { canLaunch: f.canLaunch })
    })

    expect(result).toBe('skipped')
    expect(f.gateLines).toEqual([`[slack] persona=${GUARD_KEY}: not relaunched — it is no longer in the applied configuration`])
    expect(stubCallCount(f.calls)).toBe(0)
    expect(f.events).toEqual([])
    expect(f.rg.readRecord(GUARD_KEY)).toBeNull()
    expect(getLaunchedWithDir(GUARD_KEY)).toBeUndefined()
    expect(existsSync(join(f.configDir, 'settings.json'))).toBe(false)
    expect(notices).toEqual([])
    expect(f.readLog()).toBe('')
    expect(errLog).toBe('')
  })

  test('control: an applied key through the same gate is patched, guarded and spawned as before; true', async () => {
    const f = appliedFixture()

    let result: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      result = await launchSession(GUARD_KEY, f.cfg, { canLaunch: f.canLaunch })
    })

    expect(result).toBe(true)
    expect(f.gateLines).toEqual([])
    expect(f.events).toEqual(['patch', 'guard', 'spawn'])
    expect(f.calls.spawnCalls.map((p) => p.claude_instance_id)).toEqual([GUARD_INSTANCE])
    expect(f.rg.readRecord(GUARD_KEY)).toBe('true')
    expect(getLaunchedWithDir(GUARD_KEY)).toBe(f.configDir)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-8.6 next-launch rows (AC 59): a launch takes the persona's
// effective claude_config_dir and stop_hook_bootstrap from the applied set it
// is handed at that moment (the server hands `personaConfig`, which a
// confirmed apply's step 1 swaps), and the reply guard reads the live applied
// set; nothing is kept from an earlier launch.
// ---------------------------------------------------------------------------

describe('next launch: the applied values at launch time (b.av2 SR-8.6 next-launch rows, AC 59)', () => {
  test('claude_config_dir and stop_hook_bootstrap changed between two launches: the first uses the old values; the second deletes the old-label row and spawns fresh with the new CLAUDE_CONFIG_DIR (not created yet, under a symlinked parent) and writes the new record', async () => {
    useSpawnHome()
    const work = fixtureSubdir('work')
    const oldDir = fixtureSubdir('claude-config-old')
    const realParent = fixtureSubdir('config-parent-real')
    const linkParent = join(fixtureDir, 'config-parent-link')
    symlinkSync(realParent, linkParent)
    // Claude Code creates it at first launch; its parent's real path differs from the lexical one.
    const newDir = join(linkParent, 'claude-config-new')
    const configFor = (claude_config_dir: string, stop_hook_bootstrap: boolean) =>
      makeMultiPersonaConfig([{ name: GUARD_NAME, working_directory: work, claude_config_dir, stop_hook_bootstrap }], fixtureDir, {
        agent_director_poll_interval_ms: 1,
      })
    const before = configFor(oldDir, true)
    const after = configFor(newDir, false)
    let applied = before
    const rg = makeReplyGuardRecordDir({ parentDir: fixtureDir })
    installRecordingReplyGuard(() => applied.personas, rg.stateDir, [])

    const first = makeStubCallLog()
    installStub(first)
    expect(await launchSession(GUARD_KEY, applied)).toBe(true)
    expect(first.spawnCalls).toHaveLength(1)
    expect(first.spawnCalls[0]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(oldDir)
    expect(first.spawnCalls[0]!.label).toContain(configDirLabelFor(oldDir))
    expect(rg.readRecord(GUARD_KEY)).toBe('true')
    // The row the first launch left behind carries the old label.
    const row = personaRow(before, GUARD_KEY, { state: 'ended' })
    expect(first.spawnCalls[0]!.label).toContain(`config_dir=${row.labels['config_dir']}`)

    // Step 1 of a confirmed apply swaps the applied set; the next launch is handed it.
    applied = after
    resetClientForTests()
    const second = makeStubCallLog()
    installStub({
      ...second,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: GUARD_INSTANCE }),
      ],
      getResult: row,
    })
    let result: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchSession(GUARD_KEY, applied)
    })

    expect(result).toBe(true)
    expect(second.resumeCalls).toHaveLength(0)
    expect(second.deleteCalls.map((d) => d.claude_instance_id)).toEqual([[GUARD_INSTANCE]])
    expect(second.spawnCalls).toHaveLength(2)
    expect(second.spawnCalls[1]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(newDir)
    expect(second.spawnCalls[1]!.label).toEqual([
      'service=cscb',
      `persona=${GUARD_KEY}`,
      `config_dir=${configDirLabelValue(join(realpathSync(realParent), 'claude-config-new'))}`,
    ])
    expect(rg.readRecord(GUARD_KEY)).toBe('false')
    // Not held for the directory that does not exist yet (bug b.g57, Director decision 1).
    expect(errLog).not.toContain(PERSONA_CONFIG_DIR_UNRESOLVABLE)
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 / AC 4 — the fixed instance ID and one in-flight launch per persona
// ---------------------------------------------------------------------------

describe('spawnForPersona: fixed instance ID and one launch in flight per persona (b.av2 SR-6.3, AC 4)', () => {
  test('the same persona spawned twice in turn: both spawns use cscb_<key>; the second meets ErrInstanceIdCollision and resolves through the ladder', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const getCalls: import('agent-director').GetParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      spawnCalls,
      getCalls,
      sendKeysCalls,
      spawnQueue: [
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })

    const first = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    const second = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(first).toEqual({ key: 'C', action: 'spawned' })
    expect(second).toEqual({ key: 'C', action: 'reconnected' })
    // No second instance ID is ever requested.
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual(['cscb_C', 'cscb_C'])
    expect(getCalls.map((g) => g.claude_instance_id)).toEqual(['cscb_C'])
    expect(sendKeysCalls.map((s) => s.text)).toEqual([`/mcp reconnect ${MCP_SERVER_NAME}`])
  })

  test('two overlapping calls for one persona make exactly one spawn and both get the same result', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))
    const persona = personaOf(cfg, 'C')

    let results!: Awaited<ReturnType<typeof spawnForPersona>>[]
    const errLog = await withCapturedErr(async () => {
      const a = spawnForPersona(persona, cfg)
      const b = spawnForPersona(persona, cfg)
      await held.entered('cscb_C')
      held.release('cscb_C')
      results = await Promise.all([a, b])
    })

    expect(held.calls).toHaveLength(1)
    expect(results[0]).toEqual({ key: 'C', action: 'spawned' })
    expect(results[1]).toBe(results[0])
    expect(errLog).toContain(`spawnForPersona: launch already in flight for ${renderPersonaRef('C', 'C')} — joining it`)
  })

  test('a launchSession for K issued while startupSessionManager is launching K joins that launch: one spawn in total', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    const start = startupSessionManager(cfg, { concurrency: 1 })
    await held.entered('cscb_C')
    const restart = launchSession('C', cfg)
    held.release('cscb_C')
    const [startResult, launched] = await Promise.all([start, restart])

    expect(held.calls).toHaveLength(1)
    expect(launched).toBe(true)
    expect(startResult.perPersona).toEqual([{ key: 'C', action: 'spawned' }])
  })

  test('overlapping calls for two personas make one spawn each, and neither waits for the other', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' }, L: { working_directory: '/x/l' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    const k = spawnForPersona(personaOf(cfg, 'K'), cfg)
    const l = spawnForPersona(personaOf(cfg, 'L'), cfg)
    // L's spawn starts while K's is still held open.
    await held.entered('cscb_K')
    await held.entered('cscb_L')
    // L settles while K is still in flight.
    held.release('cscb_L')
    expect(await l).toEqual({ key: 'L', action: 'spawned' })
    let kSettled = false
    void k.then(() => { kSettled = true })
    await settleNotices()
    expect(kSettled).toBe(false)
    held.release('cscb_K')
    expect(await k).toEqual({ key: 'K', action: 'spawned' })

    expect(held.calls.map((p) => p.claude_instance_id).sort()).toEqual(['cscb_K', 'cscb_L'])
  })

  test('isLaunchInFlight is true for a persona only while its launch is unsettled; other keys stay false', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' }, L: { working_directory: '/x/l' } }, fixtureDir)
    const held = holdSpawns(installStub({}))
    expect(isLaunchInFlight('K')).toBe(false)

    const k = spawnForPersona(personaOf(cfg, 'K'), cfg)
    await held.entered('cscb_K')
    expect(isLaunchInFlight('K')).toBe(true)
    expect(isLaunchInFlight('L')).toBe(false)

    held.release('cscb_K')
    expect(await k).toEqual({ key: 'K', action: 'spawned' })
    expect(isLaunchInFlight('K')).toBe(false)
  })

  test.each(['success', 'failed', 'a throw'] as const)('after a launch settles (%s), the next call for the persona starts a new ladder', async (settlement) => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const first =
      settlement === 'success'
        ? cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' })
        : settlement === 'failed'
          ? cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken'))
          : cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())
    const stub = installStub({
      spawnCalls,
      spawnQueue: [first, cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' })],
    })
    // 'a throw': the collision get returns no row, so the ladder throws while reading it.
    stub.get = async () => undefined as unknown as import('agent-director').GetResult
    const persona = personaOf(cfg, 'C')

    if (settlement === 'a throw') {
      await expect(spawnForPersona(persona, cfg)).rejects.toThrow()
    } else {
      expect((await spawnForPersona(persona, cfg)).action).toBe(settlement === 'success' ? 'spawned' : 'failed')
    }
    const again = await spawnForPersona(persona, cfg)

    expect(again).toEqual({ key: 'C', action: 'spawned' })
    expect(spawnCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-301 — every collision ladder is a launch attempt. An
// agent-director error inside it that the arming predicate answers a cause
// for is sent to the trigger sink installed with `initOutageState`
// (`triggerSink`; gone with `_resetOutageState` in afterEach), and a `failed`
// launch whose last error armed the timer carries the refusal marker;
// `launchSession` answers `'refused'` for it, which the restart path never
// counts (SRJ-302). The notice and the failed tally are unchanged (E10).
// ---------------------------------------------------------------------------

describe('launch attempt: the refusal marker and launchSession\'s \'refused\' (b.jg5 SRJ-301, SRJ-302)', () => {
  /** Every arm the recording sink received: persona key and cause kind. */
  let armed: Array<{ key: string; kind: string }>
  /** The controller a case installed as the sink, with its fake clock and log lines; stopped in afterEach. */
  let retry: { controller: UnavailableRetryController; clock: FakeClock; lines: string[]; runs: string[] } | undefined

  beforeEach(() => {
    armed = []
    retry = undefined
    captureStartupErrors()
  })

  afterEach(() => {
    if (retry !== undefined) {
      retry.controller.stopAll('test teardown')
      // No retry timer is left behind, and none ever fired.
      expect(retry.clock.pendingCount()).toBe(0)
      expect(retry.runs).toEqual([])
      assertNoLeak({ lines: retry.lines }, 'unavailable-retry controller lines')
    }
    retry = undefined
  })

  /** Re-wire the outage state as `beforeEach` does, with `sink` as its trigger sink. */
  function installSink(sink: UnavailableRetryTriggerSink): void {
    initOutageState({
      getClient,
      notify: (key, text) => { outageEmissions.push({ key, text }) },
      triggerSink: sink,
    })
  }

  /** A sink that records each arm in `armed` and answers true (the persona has a timer), as the real controller's `arm` does. */
  function installRecordingSink(): void {
    installSink({
      arm: (key, cause) => {
        armed.push({ key, kind: cause.kind })
        return true
      },
    })
  }

  /** The real controller on a fake clock as the sink; its retry action records the key and is never reached here. */
  function installController(): NonNullable<typeof retry> {
    const clock = createFakeClock()
    const lines: string[] = []
    const runs: string[] = []
    const controller = createUnavailableRetryController({
      clock,
      log: (line) => { lines.push(line) },
      action: (key) => {
        runs.push(key)
        return { kind: 'again' }
      },
    })
    retry = { controller, clock, lines, runs }
    installSink(controller)
    return retry
  }

  /**
   * The fresh spawn's answers: an UNAVAILABLE one arms (and marks), a LAUNCH
   * FAILURE (ErrTmuxSessionCreate, also after its one self-heal respawn) or
   * DIRECTORY one does not. Each is built with the stub's builders or the
   * client's own class.
   */
  const SPAWN_ANSWERS: ReadonlyArray<readonly [string, () => Error, boolean]> = [
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('spawn'), true],
    ['UNAVAILABLE (a plain Error)', () => new Error('boom'), true],
    ['LAUNCH FAILURE (ErrTmuxSessionCreate)', () => errTmuxSessionCreate('spawn'), false],
    ['DIRECTORY (ErrCwdNotFound)', () => new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd /x does not exist'), false],
  ]

  /** Persona C whose every spawn rejects with `build()`; the self-heal's tmux kill is a no-op. */
  function installSpawnRejects(build: () => Error): { cfg: PersonaConfig; spawnCalls: import('agent-director').SpawnParams[] } {
    _setTmuxSessionKiller(async () => {})
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls, spawnError: build() })
    return { cfg: makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir), spawnCalls }
  }

  test.each(SPAWN_ANSWERS)('the spawn answers %s: the marker iff the timer was armed, for C only', async (_label, build, arms) => {
    installRecordingSink()
    const { cfg } = installSpawnRejects(build)

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toStrictEqual(arms ? { key: 'C', action: 'failed', refused: true } : { key: 'C', action: 'failed' })
    expect(armed).toEqual(arms ? [{ key: 'C', kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }] : [])
  })

  test.each(SPAWN_ANSWERS)('the spawn answers %s: launchSession answers \'refused\' iff the timer was armed, false otherwise', async (_label, build, arms) => {
    installRecordingSink()
    const { cfg } = installSpawnRejects(build)

    let result: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      result = await launchSession('C', cfg)
    })

    expect(result).toBe(arms ? 'refused' : false)
    expect(armed.map((a) => a.key)).toEqual(arms ? ['C'] : [])
  })

  test('no trigger sink installed: an UNAVAILABLE spawn arms nothing and carries no marker; launchSession answers false as before', async () => {
    const { cfg } = installSpawnRejects(() => errTmuxUnresponsive('spawn'))

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    let launched: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      launched = await launchSession('C', cfg)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'failed' })
    expect(launched).toBe(false)
  })

  test('a `get` error inside the ladder (the collision read, UNCLASSIFIED) arms a read error, and the failed launch carries the marker', async () => {
    installRecordingSink()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({ spawnError: errInstanceIdCollision(), getError: errInternal() })

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'failed', refused: true })
    expect(armed).toEqual([{ key: 'C', kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR }])
  })

  test('a joining call gets the ladder\'s result, marker included; the timer is armed once', async () => {
    installRecordingSink()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))
    const persona = personaOf(cfg, 'C')

    let results!: Awaited<ReturnType<typeof spawnForPersona>>[]
    const errLog = await withCapturedErr(async () => {
      const a = spawnForPersona(persona, cfg)
      const b = spawnForPersona(persona, cfg)
      await held.entered('cscb_C')
      held.fail('cscb_C', errTmuxUnresponsive('spawn'))
      results = await Promise.all([a, b])
    })

    expect(held.calls).toHaveLength(1)
    expect(results[0]).toStrictEqual({ key: 'C', action: 'failed', refused: true })
    expect(results[1]).toBe(results[0])
    expect(armed).toEqual([{ key: 'C', kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expect(errLog).toContain(`spawnForPersona: launch already in flight for ${renderPersonaRef('C', 'C')} — joining it`)
  })

  test('a launchSession that joins the start pass\'s refused launch answers \'refused\'; the start pass still tallies it failed', async () => {
    installRecordingSink()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    let startResult!: Awaited<ReturnType<typeof startupSessionManager>>
    let launched: LaunchSessionResult | undefined
    await withCapturedErr(async () => {
      const start = startupSessionManager(cfg, { concurrency: 1 })
      await held.entered('cscb_C')
      const restart = launchSession('C', cfg)
      held.fail('cscb_C', errTmuxUnresponsive('spawn'))
      ;[startResult, launched] = await Promise.all([start, restart])
    })

    expect(held.calls).toHaveLength(1)
    expect(launched).toBe('refused')
    expect(startResult.failed).toBe(1)
    expect(startResult.perPersona).toEqual([{ key: 'C', action: 'failed' }])
    expect(armed.map((a) => a.key)).toEqual(['C'])
  })

  test('a start pass where one persona\'s spawn answers UNAVAILABLE counts the others as before; the controller on a fake clock arms only that persona, due one base wait on, and runs nothing', async () => {
    const r = installController()
    const stub = installStub({})
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      if (params.claude_instance_id === 'cscb_beta') throw errTmuxUnresponsive('spawn')
      return realSpawn(params)
    }
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: '/x1' },
        { name: 'beta', working_directory: '/x2' },
        { name: 'gamma', working_directory: '/x3' },
      ],
      fixtureDir,
    )

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.succeeded).toBe(2)
    expect(result.freshSpawned).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.perPersona).toEqual([
      { key: 'alpha', action: 'spawned' },
      { key: 'beta', action: 'failed' },
      { key: 'gamma', action: 'spawned' },
    ])
    expect(r.controller.armedKeys()).toEqual(['beta'])
    expect(r.controller.isArmed('alpha')).toBe(false)
    expect(r.controller.isArmed('gamma')).toBe(false)
    const view = r.controller.view('beta')
    expect(view?.phase).toBe('waiting')
    expect(view?.waitMs).toBe(UNAVAILABLE_RETRY_BASE_S * 1000)
    expect(view?.dueAt).toBe(r.clock.now() + UNAVAILABLE_RETRY_BASE_S * 1000)
    expect(view?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE])
    expect(r.clock.pendingCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// E3 Task 3: resume_enabled: false now replaces the row through the shared
// kill+delete+fresh path, which self-heals ErrTmuxSessionCreate (b.vub)
// ---------------------------------------------------------------------------

describe('resume_enabled: false fresh spawn self-heals ErrTmuxSessionCreate', () => {
  test('ErrTmuxSessionCreate on the fresh spawn → kill orphan tmux by name, retry once → spawned, no notice', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(killedSessions).toEqual(['slack_bot_C'])
    expect(spawnCalls).toHaveLength(3) // collision + fresh (tmux-create) + self-heal retry
    expect(notices).toHaveLength(0)
  })

  test('the self-heal retry also fails → failed, spawn-failed recorded and a spawn-failure notice', async () => {
    const readLog = captureStartupErrors()
    _setTmuxSessionKiller(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(readLog()).toContain(`self-heal spawn after ErrTmuxSessionCreate failed for ${renderPersonaRef('C', 'C')}: ErrTmuxSessionCreate`)
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('ErrTmuxSessionCreate')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.4 — a directory-broken persona's working directory
// ---------------------------------------------------------------------------

/**
 * The ways a directory-broken persona's working directory cannot be resolved
 * to a real path, each with the `cwd` its surviving row carries. A missing
 * directory's row holds the configured path. A dangling symlink's row holds
 * either the link or the link's old real target (what agent-director recorded
 * when the spawn ran there): the second compares lexically unequal to the
 * configured path.
 */
const UNRESOLVABLE_WORKDIRS = [
  'a missing directory, row cwd the configured path',
  'a dangling symlink, row cwd the link',
  'a dangling symlink, row cwd its old real target',
] as const
type UnresolvableWorkdir = (typeof UNRESOLVABLE_WORKDIRS)[number]

interface BrokenWorkdir {
  /** The persona's configured working_directory; it has no real path yet. */
  workingDirectory: string
  /** The `cwd` of the row the persona's last spawn left behind. */
  rowCwd: string
  /** Create the missing directory (or the link's target) at the same path, so the working directory resolves. */
  recreate: () => void
}

/** Build `variant` under this test's fixture dir (named `name`); nothing resolves until `recreate()`. */
function brokenWorkdir(variant: UnresolvableWorkdir, name = 'broken'): BrokenWorkdir {
  if (variant === 'a missing directory, row cwd the configured path') {
    const dir = join(fixtureDir, `${name}-work`)
    return { workingDirectory: dir, rowCwd: dir, recreate: () => void fixtureSubdir(`${name}-work`) }
  }
  const target = fixtureSubdir(`${name}-target`)
  const realTarget = realpathSync(target)
  const link = join(fixtureDir, `${name}-link`)
  symlinkSync(target, link)
  rmSync(target, { recursive: true })
  return {
    workingDirectory: link,
    rowCwd: variant === 'a dangling symlink, row cwd the link' ? link : realTarget,
    recreate: () => void fixtureSubdir(`${name}-target`),
  }
}

/** The start sweep's line for a persona whose `cwd` check it defers. */
function deferredSweepLine(name: string, key: string, workingDirectory: string): string {
  return (
    `reconcileOrphans: persona ${renderPersonaRef(name, key)} working_directory="${workingDirectory}" ` +
    'cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch'
  )
}

/** Number of deferred-check lines in a captured log. */
function countDeferredLines(errLog: string): number {
  return errLog.split('\n').filter((line) => line.includes('the cwd check is deferred to its launch')).length
}

/**
 * A pre-persona row (b.1ix) as the start sweep's `list` answers it: only the
 * `service` and `channel` labels, in `state`, with instance id `id` and the
 * tmux session that id names.
 */
function prePersonaRow(state: string, id = `cscb_old_${state}_C0OLD`): import('agent-director').ListRow {
  return cannedListRow({
    claude_instance_id: id,
    state,
    labels: { service: 'cscb', channel: 'C0OLD' },
    tmux_session_name: id.replace(/^cscb_/, 'slack_bot_'),
  })
}

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 (formerly SR-1.6) — the start sweep
// ---------------------------------------------------------------------------

describe('reconcileOrphans: the start sweep by persona (b.av2 SR-6.3, AC 4)', () => {
  /**
   * Three applied personas in real temp working directories, except that
   * beta's configured working_directory is a symlink to `betaReal` (the path
   * agent-director records for beta's spawn).
   */
  function sweepConfig(): { cfg: PersonaConfig; home: string; betaReal: string } {
    const home = useSpawnHome()
    const betaReal = realpathSync(fixtureSubdir('beta-work'))
    const betaLink = join(fixtureDir, 'beta-link')
    symlinkSync(betaReal, betaLink)
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: fixtureSubdir('alpha-work') },
        { name: 'beta', working_directory: betaLink },
        { name: 'gamma', working_directory: fixtureSubdir('gamma-work') },
      ],
      fixtureDir,
    )
    return { cfg, home, betaReal }
  }

  test('kills and deletes exactly the rows with an absent persona, a wrong instance ID or a wrong cwd; kills a live pre-persona row but keeps it; keeps correct rows', async () => {
    const { cfg, home, betaReal } = sweepConfig()
    const alpha = personaOf(cfg, 'alpha')
    const beta = personaOf(cfg, 'beta')
    const gamma = personaOf(cfg, 'gamma')
    const elsewhere = fixtureSubdir('elsewhere')
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const listCalls: import('agent-director').ListParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listCalls,
      listResult: {
        spawns: [
          // Kept: correct row for an applied persona.
          cannedListRow({}, alpha, home),
          // Kept: the persona's working_directory is a symlink; the row's cwd is its real directory.
          cannedListRow({ cwd: betaReal }, beta, home),
          // Pre-persona (only the interim `channel` label, no `persona` label), live: killed, kept.
          cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb', channel: 'alpha' } }, alpha, home),
          // Swept: names a persona absent from the applied configuration.
          cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed', channel: 'departed' } }, alpha, home),
          // Swept: right persona label, another instance ID.
          cannedListRow({ claude_instance_id: 'cscb_alpha_old' }, alpha, home),
          // Swept: right label and instance ID, another cwd.
          cannedListRow({ cwd: elsewhere }, gamma, home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(listCalls).toEqual([{ label: ['service=cscb'] }])
    expect(result).toEqual({ found: 3, killed: 3, failed: 0, prePersona: { kept: 1, live: 1, killFailed: 0 } })
    const swept = ['cscb_alpha_old', 'cscb_departed', 'cscb_gamma']
    expect(killCalls.map((k) => k.claude_instance_id).sort()).toEqual([...swept, 'cscb_legacy'])
    expect(deleteCalls.map((d) => d.claude_instance_id).sort()).toEqual(swept.map((id) => [id]))
    // Each row is swept for its own reason, named in the log; the pre-persona row is not swept.
    expect(errLog).toContain('reconcileOrphans: pre-persona row (no persona label) instanceId=cscb_legacy state=waiting')
    expect(errLog).not.toContain('sweeping row (no persona label)')
    expect(errLog).toContain('reconcileOrphans: sweeping row (absent persona) persona=departed instanceId=cscb_departed state=waiting — killing and deleting')
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong instance ID) persona=${renderPersonaRef('alpha', 'alpha')} instanceId=cscb_alpha_old state=waiting — killing and deleting`)
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('gamma', 'gamma')} instanceId=cscb_gamma state=waiting cwd=${elsewhere} — killing and deleting`)
    expect(errLog).not.toContain('instanceId=cscb_alpha state=')
    expect(errLog).not.toContain('instanceId=cscb_beta ')
    // Every working directory resolves, so nothing is deferred.
    expect(countDeferredLines(errLog)).toBe(0)
  })

  // b.av2 SR-6.4: the sweep runs before any bring-up, so it cannot compare a
  // directory-broken persona's rows by real path. It keeps them and defers the
  // cwd check to the launch; the other three conditions still apply, to that
  // persona and to every other row in the same sweep.
  test.each([...UNRESOLVABLE_WORKDIRS])(
    'working directory %s: its row is kept (neither found nor failed) with one deferred-check line; the other conditions still kill and delete, and a pre-persona row is killed but kept',
    async (variant) => {
      const home = useSpawnHome()
      const broken = brokenWorkdir(variant)
      const cfg = makeMultiPersonaConfig(
        [
          { name: 'alpha', working_directory: fixtureSubdir('alpha-work') },
          { name: 'delta', working_directory: broken.workingDirectory },
          { name: 'gamma', working_directory: fixtureSubdir('gamma-work') },
        ],
        fixtureDir,
      )
      const alpha = personaOf(cfg, 'alpha')
      const delta = personaOf(cfg, 'delta')
      const gamma = personaOf(cfg, 'gamma')
      const elsewhere = fixtureSubdir('elsewhere')
      const killCalls: import('agent-director').KillParams[] = []
      const deleteCalls: import('agent-director').DeleteParams[] = []
      installStub({
        killCalls,
        deleteCalls,
        listResult: {
          spawns: [
            // Kept, check deferred: the directory-broken persona's own row.
            cannedListRow({ cwd: broken.rowCwd }, delta, home),
            // Swept: the directory-broken persona's label, another instance ID.
            cannedListRow({ claude_instance_id: 'cscb_delta_old', cwd: broken.rowCwd }, delta, home),
            // Swept: an absent persona.
            cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed' } }, alpha, home),
            // Pre-persona (no persona label), live: killed, kept.
            cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb' } }, alpha, home),
            // Kept: a correct row for a resolvable persona.
            cannedListRow({}, alpha, home),
            // Swept: a resolvable persona's row in another directory.
            cannedListRow({ cwd: elsewhere }, gamma, home),
          ],
        },
      })

      let result!: Awaited<ReturnType<typeof reconcileOrphans>>
      const errLog = await withCapturedErr(async () => {
        result = await reconcileOrphans(cfg)
      })

      expect(result).toEqual({ found: 3, killed: 3, failed: 0, prePersona: { kept: 1, live: 1, killFailed: 0 } })
      const swept = ['cscb_delta_old', 'cscb_departed', 'cscb_gamma']
      expect(killCalls.map((k) => k.claude_instance_id).sort()).toEqual([...swept, 'cscb_legacy'])
      expect(deleteCalls.map((d) => d.claude_instance_id).sort()).toEqual(swept.map((id) => [id]))
      expect(errLog).toContain(deferredSweepLine('delta', 'delta', broken.workingDirectory))
      expect(countDeferredLines(errLog)).toBe(1)
      expect(errLog).toContain(
        `reconcileOrphans: sweeping row (wrong instance ID) persona=${renderPersonaRef('delta', 'delta')} instanceId=cscb_delta_old state=waiting — killing and deleting`,
      )
      expect(errLog).toContain('reconcileOrphans: sweeping row (absent persona) persona=departed instanceId=cscb_departed')
      expect(errLog).toContain('reconcileOrphans: pre-persona row (no persona label) instanceId=cscb_legacy')
      expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('gamma', 'gamma')} instanceId=cscb_gamma state=waiting cwd=${elsewhere}`)
      expect(errLog).not.toContain('instanceId=cscb_delta state=')
    },
  )

  test('two directory-broken personas: one deferred-check line each, and neither row is swept', async () => {
    const home = useSpawnHome()
    const first = brokenWorkdir('a missing directory, row cwd the configured path', 'first')
    const second = brokenWorkdir('a dangling symlink, row cwd its old real target', 'second')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'delta', working_directory: first.workingDirectory },
        { name: 'epsilon', working_directory: second.workingDirectory },
      ],
      fixtureDir,
    )
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({ cwd: first.rowCwd }, personaOf(cfg, 'delta'), home),
          cannedListRow({ cwd: second.rowCwd }, personaOf(cfg, 'epsilon'), home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(result).toEqual({ found: 0, killed: 0, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } })
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    expect(errLog).toContain(deferredSweepLine('delta', 'delta', first.workingDirectory))
    expect(errLog).toContain(deferredSweepLine('epsilon', 'epsilon', second.workingDirectory))
    expect(countDeferredLines(errLog)).toBe(2)
  })

  // A directory-broken persona's row whose cwd resolves to an existing
  // directory (here another persona's) is not deferred: it is swept as wrong
  // cwd, so the persona can never adopt that instance. A row with no real
  // path in the same sweep is still deferred.
  test('a directory-broken persona whose row cwd is an existing directory elsewhere: swept as wrong cwd, no deferred line for it', async () => {
    const home = useSpawnHome()
    const alphaWork = fixtureSubdir('alpha-work')
    const delta = brokenWorkdir('a missing directory, row cwd the configured path', 'delta')
    const epsilon = brokenWorkdir('a dangling symlink, row cwd its old real target', 'epsilon')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'alpha', working_directory: alphaWork },
        { name: 'delta', working_directory: delta.workingDirectory },
        { name: 'epsilon', working_directory: epsilon.workingDirectory },
      ],
      fixtureDir,
    )
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: {
        spawns: [
          cannedListRow({}, personaOf(cfg, 'alpha'), home),
          // Swept: delta's row sits in alpha's existing directory.
          cannedListRow({ cwd: alphaWork }, personaOf(cfg, 'delta'), home),
          // Kept, check deferred: epsilon's row cwd has no real path.
          cannedListRow({ cwd: epsilon.rowCwd }, personaOf(cfg, 'epsilon'), home),
        ],
      },
    })

    let result!: Awaited<ReturnType<typeof reconcileOrphans>>
    const errLog = await withCapturedErr(async () => {
      result = await reconcileOrphans(cfg)
    })

    expect(result).toEqual({ found: 1, killed: 1, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } })
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_delta'])
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_delta']])
    expect(errLog).toContain(`reconcileOrphans: sweeping row (wrong cwd) persona=${renderPersonaRef('delta', 'delta')} instanceId=cscb_delta state=waiting cwd=${alphaWork}`)
    expect(errLog).toContain(deferredSweepLine('epsilon', 'epsilon', epsilon.workingDirectory))
    expect(countDeferredLines(errLog)).toBe(1)
  })

  test.each([
    ['kill', 'killed 1, failed 0', { found: 1, killed: 1, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } }],
    ['delete', 'killed 0, failed 1', { found: 1, killed: 0, failed: 1, prePersona: { kept: 0, live: 0, killFailed: 0 } }],
  ] as const)('a %s failure records orphan-cleanup; the delete is still attempted (%s)', async (verb, _label, expected) => {
    const readLog = captureStartupErrors()
    const { cfg, home } = sweepConfig()
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installStub({
      killCalls,
      deleteCalls,
      listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_alpha_old' }, personaOf(cfg, 'alpha'), home)] },
      killError: verb === 'kill' ? errGeneric('kill', 'ErrKillBroken') : undefined,
      deleteError: verb === 'delete' ? errGeneric('delete', 'ErrDeleteBroken') : undefined,
    })

    const result = await reconcileOrphans(cfg)

    expect(result).toEqual(expected)
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_alpha_old'])
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_alpha_old']])
    const log = readLog()
    expect(countStartupEntries(log, 'orphan-cleanup')).toBe(1)
    expect(log).toContain(
      `${verb} failed for orphan instanceId=cscb_alpha_old persona=${renderPersonaRef('alpha', 'alpha')}: Err${verb === 'kill' ? 'Kill' : 'Delete'}Broken`,
    )
  })

  // b.1ix: a pre-persona row (no persona label; a build before personas made
  // it, with a `cscb_<name>_<channel>` ID) is never deleted, since no launch
  // reuses its ID. A live one gets one kill call per start and is kept whether
  // its kill reports success or fails; an ended or missing one gets no call.
  // One findMissing sweep follows the kills, since agent-director 0.10.0's
  // kill leaves the row's state as it was. A row naming an absent persona is
  // still killed and deleted, even after a failed kill.
  describe('pre-persona rows are kept, never deleted (b.1ix)', () => {
    test.each([
      ['reports success', undefined],
      ['fails', errGeneric('kill', 'ErrKillBroken')],
    ] as const)('a live pre-persona row whose kill %s: one kill call, kept (no delete), the result logged, then one findMissing sweep; an absent persona’s row is still killed and deleted', async (_label, killError) => {
      const readLog = captureStartupErrors()
      const { cfg } = sweepConfig()
      const killCalls: import('agent-director').KillParams[] = []
      const deleteCalls: import('agent-director').DeleteParams[] = []
      const callLog: string[] = []
      installStub({
        killCalls,
        deleteCalls,
        killError,
        callLog,
        listResult: {
          spawns: [
            prePersonaRow('waiting'),
            cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed' } }),
          ],
        },
      })

      let result!: Awaited<ReturnType<typeof reconcileOrphans>>
      const errLog = await withCapturedErr(async () => {
        result = await reconcileOrphans(cfg)
      })

      const failed = killError ? 1 : 0
      expect(result).toEqual({ found: 1, killed: 1, failed: 0, prePersona: { kept: 1, live: 1, killFailed: failed } })
      expect(killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_old_waiting_C0OLD', 'cscb_departed'])
      expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_departed']])
      expect(errLog).toContain('reconcileOrphans: pre-persona row (no persona label) instanceId=cscb_old_waiting_C0OLD state=waiting tmux_session=slack_bot_old_waiting_C0OLD is live')
      expect(errLog).toContain(`pre-persona rows kept=1 live=1 kill-failed=${failed}`)
      // The sweep runs after a failed kill too: the session may be gone all the same.
      expect(callLog).toEqual(['findMissing'])
      expect(errLog).toContain('reconcileOrphans: findMissing after the kills of 1 live pre-persona row(s): missing=0 [] still-live=1 [cscb_old_waiting_C0OLD]')
      const entries = readLog()
      if (killError) {
        expect(entries).toContain('kill failed for pre-persona row instanceId=cscb_old_waiting_C0OLD: ErrKillBroken')
        expect(entries).toContain('row kept, its session may still be running')
        expect(errLog).not.toContain('kill reported success')
      } else {
        expect(errLog).toContain('kill reported success for pre-persona row instanceId=cscb_old_waiting_C0OLD — row kept')
        expect(entries).not.toContain('pre-persona')
      }
    })

    test('every live state gets one kill call and all share one findMissing sweep, whose outcome line counts the killed pending row left in neither list as not judged and a killed pending row in unverified_ids as still live; ended and missing pre-persona rows get no kill, no delete and no line', async () => {
      const { cfg } = sweepConfig()
      const killCalls: import('agent-director').KillParams[] = []
      const deleteCalls: import('agent-director').DeleteParams[] = []
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      const states = [...AGENT_DIRECTOR_LIVE_STATES, 'ended', 'missing']
      const liveIds = [...AGENT_DIRECTOR_LIVE_STATES].map((s) => `cscb_old_${s}_C0OLD`)
      // A second killed pending row, which the sweep judges and leaves live.
      const pendingLeftLive = 'cscb_old_pending_left_live_C0OLD'
      installStub({
        killCalls,
        deleteCalls,
        findMissingCalls,
        // The sweep marks two of the killed rows missing (and a row the start sweep never saw).
        findMissingResult: cannedFindMissing({ count: 3, ids: [liveIds[1]!, liveIds[3]!, 'cscb_other'].sort(), unverified: 1, unverified_ids: [pendingLeftLive] }),
        listResult: { spawns: [...states.map((state) => prePersonaRow(state)), prePersonaRow(AGENT_DIRECTOR_PENDING_STATE, pendingLeftLive)] },
      })

      let result!: Awaited<ReturnType<typeof reconcileOrphans>>
      const errLog = await withCapturedErr(async () => {
        result = await reconcileOrphans(cfg)
      })

      expect(result).toEqual({ found: 0, killed: 0, failed: 0, prePersona: { kept: 8, live: 6, killFailed: 0 } })
      expect(killCalls.map((k) => k.claude_instance_id)).toEqual([...liveIds, pendingLeftLive])
      expect(deleteCalls).toHaveLength(0)
      expect(findMissingCalls).toEqual([{}])
      // b.jg5 SRJ-120: the killed `pending` row the sweep left in neither list
      // was not judged; the one in unverified_ids and the other rows in
      // neither list still read live.
      const pendingId = `cscb_old_${AGENT_DIRECTOR_PENDING_STATE}_C0OLD`
      expect(liveIds[0]).toBe(pendingId)
      const stillLive = [...liveIds.filter((_, i) => i !== 0 && i !== 1 && i !== 3), pendingLeftLive]
      expect(errLog).toContain(
        `reconcileOrphans: findMissing after the kills of 6 live pre-persona row(s): missing=2 [${liveIds[1]},${liveIds[3]}] still-live=3 [${stillLive.join(',')}] not-judged=1 [${pendingId}] — a row that still reads live is killed again at the next start; a not-judged row was pending and not judged by this sweep (retry later)`,
      )
      // The summary line still ends the sweep.
      const lines = errLog.trim().split('\n')
      expect(lines.at(-1)).toContain('reconcileOrphans: found=0 killed=0 failed=0; pre-persona rows kept=8 live=6 kill-failed=0')
      expect(errLog).not.toContain('cscb_old_ended_C0OLD')
      expect(errLog).not.toContain('cscb_old_missing_C0OLD')
    })

    test.each([
      ['no pre-persona row', [] as string[]],
      ['only ended and missing pre-persona rows', ['ended', 'missing']],
    ])('%s is live: no findMissing sweep and no outcome line (a swept persona row runs none either)', async (_label, states) => {
      const { cfg } = sweepConfig()
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      installStub({
        findMissingCalls,
        listResult: {
          spawns: [
            ...states.map((state) => prePersonaRow(state)),
            cannedListRow({ claude_instance_id: 'cscb_departed', labels: { service: 'cscb', persona: 'departed' } }),
          ],
        },
      })

      const errLog = await withCapturedErr(async () => {
        await reconcileOrphans(cfg)
      })

      expect(findMissingCalls).toHaveLength(0)
      expect(errLog).not.toContain('findMissing')
    })

    test.each([
      ['a generic agent-director error', errGeneric('find-missing', 'ErrFindBroken')],
      ['agent-director disappeared', new ErrSystemInstallDisappeared('find-missing', '/usr/bin/agent-director')],
    ])('the findMissing sweep fails (%s): one failure line and an outcome line saying the rows still read live; the start sweep finishes, and no persona’s outage flag or notice is raised', async (_label, findMissingError) => {
      const { cfg } = sweepConfig()
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      installStub({ findMissingCalls, findMissingError, listResult: { spawns: [prePersonaRow('working')] } })

      let result!: Awaited<ReturnType<typeof reconcileOrphans>>
      const errLog = await withCapturedErr(async () => {
        result = await reconcileOrphans(cfg)
      })

      expect(findMissingCalls).toHaveLength(1)
      expect(result).toEqual({ found: 0, killed: 0, failed: 0, prePersona: { kept: 1, live: 1, killFailed: 0 } })
      expect(errLog).toContain('[slack] reconcileOrphans: findMissing sweep failed for killed pre-persona rows:')
      expect(errLog).toContain(
        '[slack] reconcileOrphans: findMissing after the kills of 1 live pre-persona row(s) failed — they still read live and are killed again at the next start',
      )
      expect(errLog).toContain('pre-persona rows kept=1 live=1 kill-failed=0')
      for (const key of ['alpha', 'beta', 'gamma']) expect(getOutageFlags(key).size).toBe(0)
      expect(outageEmissions).toHaveLength(0)
    })

    // agent-director 0.10.0 modelled: `kill` ends the tmux session but leaves
    // the row's state as it was, and `findMissing` marks a live row whose
    // session is gone `missing`. Before b.1ix's follow-up the killed row still
    // read live at every later start and was killed again each time.
    test('across two starts: a killed row whose session is gone reads missing after the first start’s sweep and the second start leaves it alone; a row whose session survived its kill is killed again', async () => {
      const { cfg } = sweepConfig()
      const gone = prePersonaRow('waiting')
      const survivor = prePersonaRow('working')
      const rows = new Map([gone, survivor].map((row) => [row.claude_instance_id, row]))
      const sessions = new Set([gone.tmux_session_name, survivor.tmux_session_name])
      const killCalls: string[] = []
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      const stub = installStub()
      stub.list = async () => ({ spawns: [...rows.values()] })
      stub.kill = async (params) => {
        killCalls.push(params.claude_instance_id)
        // The survivor's kill reports success while its session lives on.
        if (params.claude_instance_id !== survivor.claude_instance_id) {
          sessions.delete(rows.get(params.claude_instance_id)!.tmux_session_name)
        }
        return {}
      }
      stub.findMissing = async (params) => {
        findMissingCalls.push(params)
        const ids: string[] = []
        for (const row of rows.values()) {
          if (!AGENT_DIRECTOR_LIVE_STATES.has(row.state) || sessions.has(row.tmux_session_name)) continue
          rows.set(row.claude_instance_id, { ...row, state: 'missing' })
          ids.push(row.claude_instance_id)
        }
        return cannedFindMissing({ count: ids.length, ids: ids.sort() })
      }

      const firstLog = await withCapturedErr(async () => {
        await reconcileOrphans(cfg)
      })
      expect(killCalls).toEqual([gone.claude_instance_id, survivor.claude_instance_id])
      expect(findMissingCalls).toHaveLength(1)
      expect(rows.get(gone.claude_instance_id)!.state).toBe('missing')
      expect(rows.get(survivor.claude_instance_id)!.state).toBe('working')
      expect(firstLog).toContain(
        `findMissing after the kills of 2 live pre-persona row(s): missing=1 [${gone.claude_instance_id}] still-live=1 [${survivor.claude_instance_id}]`,
      )

      // The next start is a new server process: nothing memoized.
      _resetFindMissingMemo()
      killCalls.length = 0
      const secondLog = await withCapturedErr(async () => {
        await reconcileOrphans(cfg)
      })
      expect(killCalls).toEqual([survivor.claude_instance_id])
      expect(findMissingCalls).toHaveLength(2)
      expect(secondLog).not.toContain(`instanceId=${gone.claude_instance_id}`)
      expect(secondLog).toContain('pre-persona rows kept=2 live=1 kill-failed=0')
      expect([...rows.keys()]).toEqual([gone.claude_instance_id, survivor.claude_instance_id])
    })
  })

  test('list failure → recorded + zero counts (no crash)', async () => {
    const readLog = captureStartupErrors()
    installStub({ listError: new Error('AD down') })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await reconcileOrphans(cfg)
    expect(result.found).toBe(0)
    expect(result.killed).toBe(0)
    expect(readLog()).toContain('[orphan-cleanup-list-failed]')
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.4 — the collision ladder keeps a row while the persona's
// working directory cannot be resolved, and reuses it once the persona is up
// ---------------------------------------------------------------------------

describe('collision ladder: a directory-broken persona keeps its row (b.av2 SR-6.4)', () => {
  /** Persona `C` in `workingDirectory`, the seam home installed. */
  function brokenConfig(workingDirectory: string): PersonaConfig {
    useSpawnHome()
    return makeStandInPersonaConfig({ C: { working_directory: workingDirectory } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
  }

  /** `n` colliding spawns, then one that succeeds (for a fresh spawn after kill + delete). */
  function collisionsThenOk(n: number): CannedResponse<import('agent-director').SpawnResult>[] {
    return [
      ...Array.from({ length: n }, () => cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())),
      cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
    ]
  }

  async function launch(cfg: PersonaConfig): Promise<{ result: Awaited<ReturnType<typeof spawnForPersona>>; errLog: string }> {
    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })
    return { result, errLog }
  }

  // A working directory that stops resolving between the persona's directory
  // check and its launch, with a row `cwd` that has no real path either and
  // differs lexically from the configured path (a lexically equal one never
  // reaches the cwd guard). The guard runs before the ladder branches on
  // state, so two states that would otherwise reuse the row are enough.
  test.each(['ended', 'waiting'] as const)(
    'a dangling symlink, row cwd its old real target, state=%s: no kill, delete, resume or reconnect; cwd-unreachable and failed (the spawn-failure path)',
    async (state) => {
      const { workingDirectory, rowCwd } = brokenWorkdir('a dangling symlink, row cwd its old real target')
      const cfg = brokenConfig(workingDirectory)
      const calls = newLadderCalls()
      installStub({ ...calls, spawnQueue: collisionsThenOk(1), getResult: personaRow(cfg, 'C', { state, cwd: rowCwd }) })

      const { result, errLog } = await launch(cfg)

      expect(result).toEqual({ key: 'C', action: 'failed' })
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
      expect(calls.resumeCalls).toHaveLength(0)
      expect(calls.sendKeysCalls).toHaveLength(0)
      expect(calls.findMissingCalls).toHaveLength(0)
      // As a spawn in a missing directory fails: the cwd-unreachable onset
      // naming the working directory, and no spawn-failure notice.
      expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
      expect(outageEmissions.filter((e) => e.key === 'C' && e.text.includes(workingDirectory))).toHaveLength(1)
      expect(notices).toHaveLength(0)
      expect(errLog).toContain(
        `spawnForPersona: ${renderPersonaRef('C', 'C')} working_directory=${workingDirectory} cannot be resolved to a real path — ` +
          `keeping its row (cwd=${rowCwd}, state=${state}); the launch fails and is retried by the restart path`,
      )
      expect(errLog).not.toContain('replacing the row')
    },
  )

  // The common case: the row holds the configured path itself, which matches
  // lexically, so the ladder reaches the row's own branch. Its resume fails
  // on the missing directory as a spawn would, and the row is never removed.
  test('a removed directory whose row cwd is the configured path: the resume fails with ErrCwdNotFound → cwd-unreachable and failed, no kill or delete', async () => {
    const work = fixtureSubdir('work')
    const cfg = brokenConfig(work)
    rmSync(work, { recursive: true })
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: collisionsThenOk(1),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: new ErrCwdNotFound('resume', 'ErrCwdNotFound', `cwd ${work} does not exist`),
    })

    const { result } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1)
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // A row whose cwd resolves to an existing directory elsewhere is not
  // deferred even while the persona's own directory is missing: it may be
  // another persona's instance, so it is replaced, never adopted. The fresh
  // spawn then fails on the missing directory as any spawn there would.
  test('a removed directory whose row cwd is another existing directory: killed, deleted and spawned fresh; the fresh spawn fails with ErrCwdNotFound → cwd-unreachable', async () => {
    const work = fixtureSubdir('work')
    const cfg = brokenConfig(work)
    rmSync(work, { recursive: true })
    const elsewhere = fixtureSubdir('elsewhere')
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${work} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended', cwd: elsewhere }),
    })

    const { result, errLog } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(calls.killCalls.map((k) => k.claude_instance_id)).toEqual(['cscb_C'])
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.resumeCalls).toHaveLength(0)
    // The colliding spawn, then the fresh one in the persona's directory.
    expect(calls.spawnCalls).toHaveLength(2)
    expect(calls.spawnCalls[1].cwd).toBe(work)
    expect(errLog).toContain(
      `spawnForPersona: ${renderPersonaRef('C', 'C')} row cwd=${elsewhere} differs from working_directory=${work} (state=ended) — replacing the row: kill+delete+fresh`,
    )
    expect(errLog).not.toContain('cannot be resolved')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // The persona's retry launch once its directory is usable goes through
  // spawnForPersona (the bring-up controller's launch). Its row first survives
  // the start sweep, then the ladder reuses it: the history is kept. The row
  // holds the old real target, the one shape that compares lexically unequal
  // (the other shapes are covered by the sweep table).
  test.each([
    ['waiting', 'reconnected'],
    ['working', 'reconnected'],
    ['ended', 'resumed'],
    ['missing', 'resumed'],
  ] as const)(
    'a dangling symlink, row cwd its old real target, kept by the sweep, then created: a %s row is reused (%s) — no kill, delete or fresh spawn',
    async (state, action) => {
      const broken = brokenWorkdir('a dangling symlink, row cwd its old real target')
      const cfg = brokenConfig(broken.workingDirectory)
      const calls = newLadderCalls()
      installStub({
        ...calls,
        listResult: { spawns: [cannedListRow({ cwd: broken.rowCwd, state }, personaOf(cfg, 'C'), ladderHome())] },
        spawnQueue: collisionsThenOk(1),
        getResult: personaRow(cfg, 'C', { state, cwd: broken.rowCwd }),
        // A working row reaches waiting on the second poll.
        statusQueue: state === 'working' ? [cannedOk<import('agent-director').StatusResult>({ state: 'working' })] : undefined,
      })

      let sweep!: Awaited<ReturnType<typeof reconcileOrphans>>
      const sweepLog = await withCapturedErr(async () => {
        sweep = await reconcileOrphans(cfg)
      })
      expect(sweep).toEqual({ found: 0, killed: 0, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } })
      expect(sweepLog).toContain(deferredSweepLine('C', 'C', broken.workingDirectory))

      broken.recreate()
      const { result, errLog } = await launch(cfg)

      expect(result).toEqual({ key: 'C', action })
      expect(calls.killCalls).toHaveLength(0)
      expect(calls.deleteCalls).toHaveLength(0)
      expect(calls.spawnCalls).toHaveLength(1) // only the colliding spawn
      expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual(action === 'resumed' ? ['cscb_C'] : [])
      expect(calls.sendKeysCalls.map((s) => s.text)).toEqual(action === 'reconnected' ? [`/mcp reconnect ${MCP_SERVER_NAME}`] : [])
      // The resume passed the config_dir check; neither guard fired.
      expect(errLog).not.toContain('config_dir label')
      expect(errLog).not.toContain('cannot be resolved')
      expect(errLog).not.toContain('replacing the row')
      expect(getOutageFlags('C').has('cwd-unreachable')).toBe(false)
    },
  )

  test('a persona come up with an ended row carrying a stale config_dir label: the config_dir check still runs → delete + fresh spawn, no resume', async () => {
    const broken = brokenWorkdir('a dangling symlink, row cwd its old real target')
    const cfg = brokenConfig(broken.workingDirectory)
    const stale = personaConfigDirLabelValue(fixtureSubdir('earlier-config'), ladderHome())
    const row = personaRow(cfg, 'C', { state: 'ended', cwd: broken.rowCwd })
    const calls = newLadderCalls()
    installStub({ ...calls, spawnQueue: collisionsThenOk(1), getResult: { ...row, labels: { ...row.labels, config_dir: stale } } })

    broken.recreate()
    const { result, errLog } = await launch(cfg)

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.resumeCalls).toHaveLength(0)
    expect(calls.killCalls).toHaveLength(0)
    expect(calls.deleteCalls.map((d) => d.claude_instance_id)).toEqual([['cscb_C']])
    expect(calls.spawnCalls).toHaveLength(2)
    expect(errLog).toContain(`spawnForPersona: ${renderPersonaRef('C', 'C')} config_dir label changed (was=${stale}`)
  })
})

// ---------------------------------------------------------------------------
// Bug b.g57 — a claude_config_dir with no real path has no `config_dir` label
// (no lexical fallback): the launch keeps the row, makes no agent-director
// call that could kill, delete, spawn or resume, hands the persona to the
// hold hook and is `'skipped'` on the restart path. The failing realpath is
// injected through the session manager's `_setConfigDirFs` seam (reset in
// the file's afterEach, with the hook); dangling symlinks and not-yet-created
// directories are real, under the fixture dir.
// ---------------------------------------------------------------------------

/** An errno-style error, as `fs.realpathSync` throws it. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

/** A realpath that throws `code` for `dir` and anything under it while `broken()` holds, and is the real one otherwise. */
function realpathFailingUnder(dir: string, broken: () => boolean, code = 'EIO'): (path: string) => string {
  return (path) => {
    if (broken() && (path === dir || path.startsWith(`${dir}/`))) throw errnoError(code)
    return realpathSync(path)
  }
}

/**
 * Assert `line` is a `persona-config-dir-unresolvable` line for `persona` and
 * its configured `path`, giving `reason`: the class, persona and path prefix
 * and the reason only. The whole cause sentence is pinned once, in
 * tests/persona-bringup.test.ts.
 */
function expectConfigDirUnresolvableLine(line: string | undefined, persona: Persona, path: string, reason = 'EIO'): void {
  expect(line).toStartWith(
    `[slack] ${PERSONA_CONFIG_DIR_UNRESOLVABLE}: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)} ` +
      `path=${JSON.stringify(path)}: `,
  )
  expect(line).toContain(`(${reason})`)
}

/** The captured lines of the `persona-config-dir-unresolvable` class. */
function configDirLines(errLog: string): string[] {
  return errLog.split('\n').filter((line) => line.includes(`${PERSONA_CONFIG_DIR_UNRESOLVABLE}:`))
}

describe('b.g57: an unresolvable claude_config_dir keeps the row and skips the launch', () => {
  /** When the injected realpath starts failing for the persona's claude_config_dir. */
  const FAILURE_POINTS = ['before the launch', 'during the launch (after its pre-launch check)'] as const
  const ENTRIES = ['ended', 'missing', 'waiting (dead session)'] as const

  /**
   * The reply-guard persona (a hashed key) with a real working directory and
   * claude_config_dir, a recording trust patcher, the real reply guard over a
   * temp record dir, and a recording hold hook that does not hold (so the
   * session manager logs the line itself). `broken` drives the injected
   * realpath for the config dir.
   */
  function unresolvableFixture() {
    const readLog = captureStartupErrors()
    useSpawnHome()
    const configDir = fixtureSubdir('claude-config')
    const cfg = makeMultiPersonaConfig(
      [{ name: GUARD_NAME, working_directory: fixtureSubdir('work'), claude_config_dir: configDir }],
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
    const persona = personaOf(cfg, GUARD_KEY)
    // The row the persona's last spawn left: its label matches the directory.
    const row = personaRow(cfg, GUARD_KEY)
    const events: string[] = []
    setPreLaunchTrustPatcher(() => void events.push('patch'))
    const rg = makeReplyGuardRecordDir({ parentDir: fixtureDir })
    installRecordingReplyGuard(cfg.personas, rg.stateDir, events)
    const held: Array<Parameters<ConfigDirUnresolvableHook>> = []
    setConfigDirUnresolvableHook((...args) => (held.push(args), false))
    return { cfg, persona, configDir, row, events, rg, held, readLog }
  }

  test.each(ENTRIES.flatMap((entry) => FAILURE_POINTS.map((point) => [entry, point] as const)))(
    'b.g57: %s row with its matching label, realpath failing %s: \'skipped\' — no kill, delete or resume, no fresh spawn, one line naming the persona and the path, one hold; once it resolves the same row is resumed',
    async (entry, point) => {
      const f = unresolvableFixture()
      const calls = makeStubCallLog()
      installResumeEntry(entry, f.row, calls, GUARD_KEY)
      let resolved = false
      // During the launch: the pre-launch check passes and the directory stops
      // resolving once the ladder has fetched the row.
      const broken = () => !resolved && (point === 'before the launch' || calls.getCalls.length > 0)
      _setConfigDirFs({ realpath: realpathFailingUnder(f.configDir, broken) })

      let result: LaunchSessionResult | undefined
      const errLog = await withCapturedErr(async () => {
        result = await launchSession(GUARD_KEY, f.cfg)
      })

      expect(result).toBe('skipped')
      expect(calls.killCalls).toEqual([])
      expect(calls.deleteCalls).toEqual([])
      expect(calls.resumeCalls).toEqual([])
      if (point === 'before the launch') {
        // Nothing ran: no agent-director call at all, no trust patch, no reply-guard step or record.
        expect(stubCallCount(calls)).toBe(0)
        expect(f.events).toEqual([])
      } else {
        // Only the optimistic spawn (it collided) and the row fetch; never a replacement.
        expect(calls.spawnCalls).toHaveLength(1)
        expect(calls.getCalls).toHaveLength(1)
        expect(errLog).not.toContain('config_dir label')
      }
      expect(f.rg.readRecord(GUARD_KEY)).toBeNull()
      expect(f.held.map(([p, failure]) => [p.key, failure.class])).toEqual([[GUARD_KEY, PERSONA_CONFIG_DIR_UNRESOLVABLE]])
      expect(configDirLines(errLog)).toHaveLength(1)
      expectConfigDirUnresolvableLine(configDirLines(errLog)[0], f.persona, f.configDir)
      expect(f.readLog()).toBe('')
      expect(notices).toEqual([])

      // Resolved: the same row, with the same label, is resumed.
      resolved = true
      resetClientForTests()
      const after = makeStubCallLog()
      installResumeEntry(entry, f.row, after, GUARD_KEY)
      const resumedLog = await withCapturedErr(async () => {
        result = await launchSession(GUARD_KEY, f.cfg)
      })

      expect(result).toBe(true)
      expect(after.resumeCalls.map((r) => r.claude_instance_id)).toEqual([GUARD_INSTANCE])
      expect(after.deleteCalls).toEqual([])
      expect(after.spawnCalls).toHaveLength(1)
      expect(f.rg.readRecord(GUARD_KEY)).toBe('true')
      expect(configDirLines(resumedLog)).toEqual([])
      assertNoLeak({ errLog, resumedLog, held: f.held })
    },
  )

  test('b.g57: the ladder\'s comparison finds the directory unresolvable and the re-check right after finds it resolved again: \'skipped\' — the row kept (no kill, delete, resume or fresh spawn), one line, no hold', async () => {
    const f = unresolvableFixture()
    const calls = makeStubCallLog()
    installResumeEntry('ended', f.row, calls, GUARD_KEY)
    // Only the first resolution after the ladder fetched the row fails: its comparison.
    let failedOnce = false
    _setConfigDirFs({
      realpath: (path) => {
        if (path === f.configDir && calls.getCalls.length > 0 && !failedOnce) {
          failedOnce = true
          throw errnoError('EIO')
        }
        return realpathSync(path)
      },
    })

    let result: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchSession(GUARD_KEY, f.cfg)
    })

    expect(failedOnce).toBe(true)
    expect(result).toBe('skipped')
    expect(calls.killCalls).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(calls.resumeCalls).toEqual([])
    expect(calls.spawnCalls).toHaveLength(1) // only the optimistic spawn, which collided
    expect(
      errLog.split('\n').filter((line) => line.includes('claude_config_dir could not be resolved during the launch')),
    ).toEqual([
      `[slack] spawnForPersona: ${renderPersonaRef(f.persona.name, f.persona.key)} claude_config_dir could not be resolved during the launch — keeping its row; not launching`,
    ])
    expect(errLog).not.toContain('config_dir label')
    expect(f.held).toEqual([])
    expect(configDirLines(errLog)).toEqual([])
    expect(f.rg.readRecord(GUARD_KEY)).toBeNull()
    expect(notices).toEqual([])
    assertNoLeak({ errLog, result })
  })

  // AC 20 (b.av2 SR-10.3): the same mid-launch line when the realpath error
  // carries fake tokens in its message and properties; every console.error
  // argument is kept unformatted (errors whole), so a line that echoed the
  // thrown error would fail the check. The configured claude_config_dir path
  // is not a credential (paths stay echoed on purpose), so it stays plain.
  test('AC 20: the mid-launch "could not be resolved during the launch" line, under a realpath error carrying fake tokens — no captured argument, record or result carries a credential value', async () => {
    const f = unresolvableFixture()
    const calls = makeStubCallLog()
    installResumeEntry('ended', f.row, calls, GUARD_KEY)
    let failedOnce = false
    _setConfigDirFs({
      realpath: (path) => {
        if (path === f.configDir && calls.getCalls.length > 0 && !failedOnce) {
          failedOnce = true
          throw Object.assign(new Error(`EIO: i/o error, realpath ${fakeToken(BOT_TOKEN_PREFIX, 'realpath')}`), {
            code: 'EIO',
            path: fakeToken(APP_TOKEN_PREFIX, 'path'),
            syscall: LEAK_SENTINEL,
          })
        }
        return realpathSync(path)
      },
    })
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    let result: LaunchSessionResult | undefined
    try {
      result = await launchSession(GUARD_KEY, f.cfg)
    } finally {
      console.error = orig
    }

    expect(failedOnce).toBe(true)
    expect(result).toBe('skipped')
    expect(calls.killCalls).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(calls.resumeCalls).toEqual([])
    const midLaunch = errArgs.filter((args) => String(args[0]).includes('could not be resolved during the launch'))
    expect(midLaunch).toHaveLength(1)
    expect(f.held).toEqual([])
    assertNoLeak({ errArgs, result, startupErrorsLog: f.readLog(), notices })
  })

  test.each<[string, number, ConfigDirUnresolvableHook | undefined]>([
    ['no hook installed', 1, undefined],
    ['a hook that holds the persona (the holder logs the line)', 0, () => true],
    [
      'a hook that throws',
      1,
      () => {
        throw new Error('hold exploded')
      },
    ],
  ])('b.g57: %s — deferred with no agent-director call; the session manager logs the line %d time(s)', async (_label, lineCount, hook) => {
    const f = unresolvableFixture()
    setConfigDirUnresolvableHook(hook)
    const calls = makeStubCallLog()
    installStub(calls)
    _setConfigDirFs({ realpath: realpathFailingUnder(f.configDir, () => true) })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(f.persona, f.cfg)
    })

    expect(result).toEqual({
      key: GUARD_KEY,
      action: 'deferred',
      deferredBy: { step: 'claude-config-dir', class: PERSONA_CONFIG_DIR_UNRESOLVABLE, cause: expect.stringContaining('(EIO)') },
    })
    expect(stubCallCount(calls)).toBe(0)
    expect(configDirLines(errLog)).toHaveLength(lineCount)
    if (lineCount > 0) expectConfigDirUnresolvableLine(configDirLines(errLog)[0], f.persona, f.configDir)
    assertNoLeak({ errLog, result })
  })

  test('b.g57: dry run runs the same check — deferred, not the dry-run no-op; nothing launched', async () => {
    process.env['SLACK_DRY_RUN'] = '1'
    const f = unresolvableFixture()
    const calls = makeStubCallLog()
    installStub(calls)
    _setConfigDirFs({ realpath: realpathFailingUnder(f.configDir, () => true) })

    const errLog = await withCapturedErr(async () => {
      expect((await spawnForPersona(f.persona, f.cfg)).action).toBe('deferred')
      expect(await launchSession(GUARD_KEY, f.cfg)).toBe('skipped')
    })

    expect(stubCallCount(calls)).toBe(0)
    expect(f.events).toEqual([])
    expect(errLog).not.toContain('dry-run: skipping spawn')
    assertNoLeak({ errLog, held: f.held })
  })

  test('b.g57: the start pass counts a persona whose claude_config_dir is unresolvable as not brought up (retrying, its cause the claude_config_dir); the other persona is spawned', async () => {
    const readLog = captureStartupErrors()
    useSpawnHome()
    const aDir = fixtureSubdir('claude-config-a')
    const cfg = makeMultiPersonaConfig(
      [
        { name: 'Alpha Desk', working_directory: fixtureSubdir('work-a'), claude_config_dir: aDir },
        { name: 'Beta Ops', working_directory: fixtureSubdir('work-b'), claude_config_dir: fixtureSubdir('claude-config-b') },
      ],
      fixtureDir,
    )
    const [a, b] = cfg.personas as [Persona, Persona]
    const calls = makeStubCallLog()
    installStub(calls)
    _setConfigDirFs({ realpath: realpathFailingUnder(aDir, () => true) })

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.perPersona).toEqual([
      {
        key: a.key,
        action: 'not-brought-up',
        outcome: 'retrying',
        failures: [{ step: 'claude-config-dir', class: PERSONA_CONFIG_DIR_UNRESOLVABLE, cause: expect.stringContaining('(EIO)') }],
      },
      { key: b.key, action: 'spawned' },
    ])
    expect(result.notBroughtUp).toBe(1)
    expect(result.failed).toBe(0)
    expect(calls.spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${b.key}`])
    expect(configDirLines(errLog)).toHaveLength(1)
    expectConfigDirUnresolvableLine(configDirLines(errLog)[0], a, aDir)
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    assertNoLeak({ errLog, result })
  })

  test('b.g57: a claude_config_dir not created yet under a symlinked parent spawns fresh with its parent\'s real path plus the rest; once created, the next launch computes the same label and resumes', async () => {
    const home = useSpawnHome()
    const realParent = fixtureSubdir('config-parent-real')
    const linkParent = join(fixtureDir, 'config-parent-link')
    symlinkSync(realParent, linkParent)
    const configDir = join(linkParent, 'nested', 'claude')
    const expected = configDirLabelValue(join(realpathSync(realParent), 'nested', 'claude'))
    // A symlink on the path: the lexical label would differ.
    expect(expected).not.toBe(configDirLabelValue(configDir))
    const cfg = makeStandInPersonaConfig(
      { C: { working_directory: fixtureSubdir('work'), claude_config_dir: configDir } },
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
    const first = makeStubCallLog()
    installStub(first)

    const errLog = await withCapturedErr(async () => {
      expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'spawned' })
    })

    expect(first.spawnCalls[0]!.label).toEqual(['service=cscb', 'persona=C', `config_dir=${expected}`])
    expect(first.spawnCalls[0]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configDir)
    expect(configDirLines(errLog)).toEqual([])

    // Claude Code creates it at first launch; the label does not change.
    mkdirSync(join(realParent, 'nested', 'claude'), { recursive: true })
    expect(personaConfigDirLabelValue(configDir, home)).toBe(expected)
    resetClientForTests()
    const second = makeStubCallLog()
    installResumeEntry('ended', personaRow(cfg, 'C', { labels: { service: 'cscb', persona: 'C', config_dir: expected } }), second)

    expect(await spawnForPersona(personaOf(cfg, 'C'), cfg)).toEqual({ key: 'C', action: 'resumed' })
    expect(second.resumeCalls.map((r) => r.claude_instance_id)).toEqual(['cscb_C'])
    expect(second.deleteCalls).toEqual([])
    assertNoLeak({ errLog })
  })
})

// Bug b.g57 — compareRowToPersona gives no config_dir verdict for an
// unresolvable directory, and personaConfigDirLabelValue has no label for it.
describe('b.g57: compareRowToPersona and personaConfigDirLabelValue with an unresolvable claude_config_dir', () => {
  /** How the directory is unresolvable: the configured path, the realpath override (none: the real one) and the errno code. */
  interface Unresolvable {
    configDir: string
    realpath?: (path: string) => string
    code: string
  }

  test.each<[string, () => Unresolvable]>([
    [
      'realpath fails with EIO (a dropped mount, injected)',
      () => {
        const configDir = fixtureSubdir('claude-config')
        return { configDir, realpath: realpathFailingUnder(configDir, () => true), code: 'EIO' }
      },
    ],
    [
      'a dangling symlink',
      () => {
        const configDir = join(fixtureDir, 'config-link')
        symlinkSync(join(fixtureDir, 'unmounted-target'), configDir)
        return { configDir, code: 'ENOENT' }
      },
    ],
    [
      'a dangling symlink on an ancestor',
      () => {
        const link = join(fixtureDir, 'drive-link')
        symlinkSync(join(fixtureDir, 'unmounted-drive'), link)
        return { configDir: join(link, 'claude'), code: 'ENOENT' }
      },
    ],
    [
      'a path under a regular file (ENOTDIR)',
      () => {
        const file = join(fixtureDir, 'plain-file')
        writeFileSync(file, '')
        return { configDir: join(file, 'claude'), code: 'ENOTDIR' }
      },
    ],
  ])('b.g57: %s — configDirResolved false, no config_dir verdict, no label; the row\'s lexical label is not a match', (_label, build) => {
    const home = realpathSync(fixtureSubdir('home'))
    const work = fixtureSubdir('work')
    const { configDir, realpath, code } = build()
    const fs = realpath === undefined ? undefined : { realpath }
    // The label the lexical fallback would have computed and matched.
    const row = { cwd: work, labels: { service: 'cscb', persona: 'C', config_dir: configDirLabelValue(configDir) } }

    const result = compareRowToPersona(row, { working_directory: work, claude_config_dir: configDir }, home, undefined, fs)

    expect(result).toEqual({
      cwdMatches: true,
      workingDirectoryResolved: true,
      cwdCheckDeferred: false,
      configDirResolved: false,
      configDirMatches: undefined,
      configDirLabel: configDirLabelValue(configDir),
      expectedConfigDirLabel: undefined,
    })
    let thrown: unknown
    try {
      personaConfigDirLabelValue(configDir, home, fs)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ConfigDirUnresolvableError)
    expect(thrown).toMatchObject({ path: configDir, code })
  })

  test('b.g57 control: a resolvable directory (and one not created yet) has configDirResolved true and the verdict as before', () => {
    const home = realpathSync(fixtureSubdir('home'))
    const work = fixtureSubdir('work')
    const existing = fixtureSubdir('claude-config')
    const notYet = join(fixtureDir, 'not-created', 'claude')
    for (const configDir of [existing, notYet]) {
      const label = personaConfigDirLabelValue(configDir, home)
      const persona = { working_directory: work, claude_config_dir: configDir }
      const matching = compareRowToPersona({ cwd: work, labels: { config_dir: label } }, persona, home)
      expect(matching).toMatchObject({ configDirResolved: true, configDirMatches: true, expectedConfigDirLabel: label })
      const stale = compareRowToPersona({ cwd: work, labels: { config_dir: 'aaaaaaaaaaaa' } }, persona, home)
      expect(stale).toMatchObject({ configDirResolved: true, configDirMatches: false, expectedConfigDirLabel: label })
    }
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager — iterate personas (b.av2 SR-6.3)
// ---------------------------------------------------------------------------

describe('startupSessionManager', () => {
  test('counts succeeded/failed per persona', async () => {
    captureStartupErrors()
    let callIdx = 0
    const stub = installStub({})
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      callIdx++
      if (callIdx === 2) throw new Error('boom')
      return realSpawn(params)
    }
    const cfg = makeMultiPersonaConfig(
      [
        // alpha is listed in two channels and still counts once.
        {
          name: 'alpha',
          working_directory: '/x1',
          channels: [
            { id: 'C0HOME01', delivery: 'all' },
            { id: 'C0SHARED1', delivery: 'mentions' },
          ],
        },
        { name: 'beta', working_directory: '/x2' },
        { name: 'gamma', working_directory: '/x3' },
      ],
      fixtureDir,
    )
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.succeeded + result.failed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(2)
    // One outcome per persona, keyed by persona; concurrency 1 makes the second (beta) the failure.
    expect(result.perPersona).toEqual([
      { key: 'alpha', action: 'spawned' },
      { key: 'beta', action: 'failed' },
      { key: 'gamma', action: 'spawned' },
    ])
  })

  // AC 3 (b.av2 SR-14 "session-manager: one spawn"): a persona listed in two
  // channels is ONE instance — exactly one spawn, never one per channel.
  test('AC 3: one persona listed in two channels produces exactly one spawn', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const cfg = makeMultiPersonaConfig(
      [
        {
          name: 'alpha',
          working_directory: '/x/alpha',
          channels: [
            { id: 'C0HOME01', delivery: 'all' },
            { id: 'C0SHARED1', delivery: 'mentions' },
          ],
          permission_prompts: 'C0HOME01',
        },
        {
          name: 'beta',
          working_directory: '/x/beta',
          channels: [{ id: 'C0SHARED1', delivery: 'mentions' }],
          permission_prompts: 'C0SHARED1',
        },
      ],
      fixtureDir,
    )

    const result = await startupSessionManager(cfg)

    const ids = spawnCalls.map((p) => p.claude_instance_id)
    expect(spawnCalls).toHaveLength(2)
    expect(ids.filter((id) => id === 'cscb_alpha')).toHaveLength(1)
    expect(ids.filter((id) => id === 'cscb_beta')).toHaveLength(1)
    // No spawn is keyed by a channel.
    expect(ids.some((id) => String(id).includes('C0HOME01') || String(id).includes('C0SHARED1'))).toBe(false)
    // Each spawn carries its own persona's working directory and persona label.
    const byId = new Map(spawnCalls.map((p) => [p.claude_instance_id, p]))
    expect(byId.get('cscb_alpha')!.cwd).toBe('/x/alpha')
    expect(byId.get('cscb_alpha')!.label).toEqual(['service=cscb', 'persona=alpha', expect.stringMatching(/^config_dir=/)])
    expect(byId.get('cscb_beta')!.cwd).toBe('/x/beta')
    expect(byId.get('cscb_beta')!.label).toEqual(['service=cscb', 'persona=beta', expect.stringMatching(/^config_dir=/)])
    // Result counts are per persona.
    expect(result.succeeded).toBe(2)
    expect(result.freshSpawned).toBe(2)
    expect(result.failed).toBe(0)
    expect([...result.perPersona].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'alpha', action: 'spawned' },
      { key: 'beta', action: 'spawned' },
    ])
  })

  // b.av2 SR-2.2: logs and errors name the persona in rendered form — the name
  // JSON-quoted with the key beside it.
  test('a startup spawn failure names the persona in rendered form (JSON-quoted name plus key)', async () => {
    const readLog = captureStartupErrors()
    // A LAUNCH FAILURE at every spawn: the self-heal's respawn fails too.
    _setTmuxSessionKiller(async () => {})
    const launchFailure = errTmuxSessionCreate('spawn')
    installStub({ spawnError: launchFailure })
    const name = 'Ops "Prod" Bot'
    const key = personaKey(name)
    const cfg = makeMultiPersonaConfig([{ name, working_directory: '/x/ops' }], fixtureDir)
    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    try {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    } finally {
      console.error = realError
    }

    expect(result.failed).toBe(1)
    const rendered = `"Ops \\"Prod\\" Bot" (key=${key})`
    expect(rendered).toBe(renderPersonaRef(name, key))
    const log = readLog()
    expect(log).toContain('[spawn-failed]')
    expect(log).toContain(`self-heal spawn after ErrTmuxSessionCreate failed for ${rendered}: ${launchFailure.errName}`)
    expect(lines.some((l) => l.includes(`spawnForPersona: self-heal spawn after ErrTmuxSessionCreate failed for ${rendered}`))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// startupSessionManager with the SR-6.1 bring-up (b.av2 SR-6.1, SR-11)
//
// The server passes its bring-up controller as `bringUp`: each persona goes
// through its credentials, working-directory and Slack steps and ends `up`,
// `broken` or `retrying`; only an `up` persona is launched by the pool. The
// procedure and the controller are tested in tests/persona-bringup.test.ts and
// tests/persona-connections.test.ts; these cases pin the start pool's
// bookkeeping: a `broken` or `retrying` persona is "not brought up", never a
// failed spawn, a startup error or a notice, and a retrying persona that
// comes up later is launched outside the pool.
// ---------------------------------------------------------------------------

describe('startupSessionManager: SR-6.1 bring-up', () => {
  let managers: PersonaConnectionManager[] = []
  let controllers: PersonaBringUpController[] = []

  beforeEach(() => {
    managers = []
    controllers = []
    // This block handles credentials: an accidental environment read gets fakes (restored by the file's afterEach).
    process.env['SLACK_BOT_TOKEN'] = fakeToken(BOT_TOKEN_PREFIX, 'env')
    process.env['SLACK_APP_TOKEN'] = fakeToken(APP_TOKEN_PREFIX, 'env')
    delete process.env['SLACK_DRY_RUN']
  })

  afterEach(async () => {
    for (const c of controllers) c.cancelAll()
    await Promise.all(managers.map((m) => m.stopAll()))
  })

  /**
   * Personas named `names` (A and B by default; names differ from keys), each
   * with its own working directory and credentials file under fixtureDir, on
   * the real connection manager over the stub factory and a fake clock
   * (`makeConnectionHarness` with `files: true`). `slack` scripts each
   * persona's stub by name. `bringUp` is what the server passes to
   * `startupSessionManager`: the real bring-up controller over the harness's
   * recording `connections` (which records `slack:<key>` in `order`) and the
   * manager's status, on the harness's fake clock, with the manager's status
   * listener wired to it and `spawnForPersona(persona, cfg, false)` as its
   * launch after a retry, and `checkLaunchConfigDir` (against the seam home
   * `beforeEach` installs) as its claude_config_dir check, as server.ts wires
   * them. `lines` holds the manager's and the controller's lines. The
   * controller's `connections.stop` (which closes a persona held for its
   * claude_config_dir, bug b.g57) is the manager's.
   */
  function bringUpFixture(slackA: StubSlackOptions = {}, names = ['Alpha Desk', 'Beta Ops'], slack: Record<string, StubSlackOptions> = {}) {
    const h = makeConnectionHarness(names.map((name) => ({ name })), fixtureDir, {
      files: true,
      stubOptions: { [names[0]!]: slackA, ...slack },
    })
    managers.push(h.manager)
    const [a, b] = h.personas as [Persona, Persona]
    const lines = h.lines
    const cfg = h.config!
    const bringUp = createPersonaBringUpController({
      connections: {
        bringUp: h.connections.bringUp,
        status: (key) => h.manager.status(key),
        stop: (key) => h.manager.stop(key),
      },
      dryRun: false,
      log: (line) => void lines.push(line),
      launch: (persona) => spawnForPersona(persona, cfg, false),
      checkConfigDir: checkLaunchConfigDir,
      clock: h.clock,
    })
    controllers.push(bringUp)
    h.onStatus = (key, status) => bringUp.onConnectionStatus(key, status)
    return { h, cfg, a, b, lines, order: h.order, bringUp }
  }

  // b.av2 SR-6.1: each cause gives A its outcome — credentials-broken is
  // `broken`; directory-broken and Slack-unreachable are `retrying` (their
  // retries run on the persona's own timers, which these cases never fire).
  test.each<[string, (f: ReturnType<typeof bringUpFixture>) => void, StubSlackOptions, Exclude<PersonaBringUpOutcome, 'up'>, PersonaBringUpStep, string]>([
    ['credentials file missing (step 1) → broken', (f) => rmSync(f.a.credentials_file), {}, 'broken', 'credentials', 'persona-credentials-missing'],
    ['working directory missing (step 2) → retrying', (f) => rmSync(f.a.working_directory, { recursive: true }), {}, 'retrying', 'working-directory', 'persona-directory-missing'],
    ['Slack refuses A\'s bot token (step 3) → broken', () => {}, { authTest: [{ kind: 'platform', error: 'invalid_auth' }] }, 'broken', 'slack', 'persona-credentials-refused'],
    ['Slack unreachable for A (step 3) → retrying', () => {}, { authTest: [{ kind: 'network' }] }, 'retrying', 'slack', 'persona-slack-unreachable'],
  ])('%s: A is not brought up — no spawn, no failed count, no startup error, no notice; B is launched', async (_label, arrange, slackA, outcome, step, cls) => {
    const readLog = captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const f = bringUpFixture(slackA)
    arrange(f)

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'not-brought-up', outcome, failures: [{ step, class: cls, cause: expect.any(String) }] },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.notBroughtUp).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(result.freshSpawned).toBe(1)
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${f.b.key}`])
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    expect(outageEmissions).toEqual([])
    expect(errLog).toContain(
      'startupSessionManager: complete — 2 persona(s): 0 resumed, 1 fresh-spawned, 0 fresh-after-amnesia, ' +
        '0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 1 not brought up',
    )
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  test('a persona brought up goes on to the collision ladder after its connection is up: its ended row is resumed', async () => {
    captureStartupErrors()
    const f = bringUpFixture()
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${f.b.key}` }),
      ],
      getResult: personaRow(f.cfg, f.a.key, { state: 'ended' }),
    })
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      f.order.push(`spawn:${params.claude_instance_id}`)
      return realSpawn(params)
    }

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    // Both Slack bring-ups start at once; only the launches are pooled (here one at a time, in readiness order).
    expect(f.order).toEqual([`slack:${f.a.key}`, `slack:${f.b.key}`, `spawn:cscb_${f.a.key}`, `spawn:cscb_${f.b.key}`])
    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'resumed' },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.notBroughtUp).toBe(0)
    expect(result.resumed).toBe(1)
    expect(errLog).toContain('0 failed, 0 not brought up')
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // A launch that throws (not a failed ladder: spawnForPersona itself rejects)
  // is caught per persona; the next persona in the pool still launches.
  test('concurrency 1: A\'s launch throws — A is counted failed with a startup error, and B is still spawned', async () => {
    const readLog = captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({ spawnCalls })
    const f = bringUpFixture()
    // Building A's spawn parameters throws, so A's launch rejects outright.
    Object.defineProperty(f.a, 'claude_config_dir', {
      get() {
        throw new Error('launch exploded for A')
      },
    })

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    })

    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'failed' },
      { key: f.b.key, action: 'spawned' },
    ])
    expect(result.failed).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.notBroughtUp).toBe(0)
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual([`cscb_${f.b.key}`])
    expect(errLog).toContain(`startupSessionManager: unexpected error for ${renderPersonaRef(f.a.name, f.a.key)}`)
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(1)
    expect(readLog()).toContain(`unexpected error spawning ${renderPersonaRef(f.a.name, f.a.key)}`)
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // AC 20 (b.av2 SR-10.3): the launch covers the persona's Slack bring-up, so
  // the thrown value's message can carry a secret. The unexpected-error line
  // and its startup-errors.log entry carry only its description (type, safe
  // code, redacted message, frames), with no cause appended; every
  // console.error argument is kept unformatted.
  test('AC 20: A\'s launch throws an error carrying fake tokens — the unexpected-error line and its startup-errors.log detail name its type, code and redacted message; nothing logged, recorded or returned leaks', async () => {
    const readLog = captureStartupErrors()
    installStub({})
    const f = bringUpFixture()
    Object.defineProperty(f.a, 'claude_config_dir', {
      get() {
        throw Object.assign(new Error(leakyMessage('launch exploded', 'msg')), {
          code: 'EIO',
          detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
          note: LEAK_SENTINEL,
        })
      },
    })
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    try {
      result = await startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
    } finally {
      console.error = orig
    }

    const ref = renderPersonaRef(f.a.name, f.a.key)
    expect(result.perPersona).toEqual([
      { key: f.a.key, action: 'failed' },
      { key: f.b.key, action: 'spawned' },
    ])
    const lines = errArgs.filter((args) => String(args[0]).includes('startupSessionManager: unexpected error'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1)
    const described = `Error code=EIO message=${JSON.stringify(redactedLeakyMessage('launch exploded'))} at `
    expect(String(lines[0]![0])).toStartWith(`[slack] startupSessionManager: unexpected error for ${ref}: ${described}`)
    const entries = readLog().split('\n').filter((l) => l.includes('] [spawn-failed] '))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(`] [spawn-failed] unexpected error spawning ${ref}: ${described}`)
    expect(entries[0]).not.toContain(' — ')
    assertNoLeak({ lines: f.lines, errArgs, startupErrorsLog: readLog(), result })
  })

  // The launch pool: steps 1–3 run for every persona at once; only the
  // launches share `concurrency` slots, taken in the order personas become
  // ready. Each persona's socket open is deferred so the test picks the
  // readiness order, and every spawn is held so no launch settles until the
  // test releases it.
  test('pool (5 personas, concurrency 3, launches held): every Slack bring-up finishes before any launch settles; at most 3 launches run, in readiness order; a persona not brought up takes no slot', async () => {
    captureStartupErrors()
    const names = ['Alpha Desk', 'Beta Ops', 'Gamma Hub', 'Delta Bay', 'Echo Den']
    const connects = new Map<string, DeferredConnect>(names.map((name) => [name, makeDeferredConnect()]))
    const f = bringUpFixture({}, names, Object.fromEntries(names.map((name) => [name, { connect: [connects.get(name)!.outcome] }])))
    const [alpha, beta, gamma, delta, echo] = f.h.personas as Persona[]
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)
    const id = (p: Persona) => `cscb_${p.key}`
    const settle = async (p: Persona, outcome?: Parameters<DeferredConnect['settle']>[0]) => {
      connects.get(p.name)!.settle(outcome)
      await pollUntil(() => f.h.manager.status(p.key)?.state !== 'connecting')
    }

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      const start = startupSessionManager(f.cfg, { concurrency: 3, bringUp: f.bringUp })

      // Every persona's Slack step starts at once, before any launch.
      await pollUntil(() => f.order.length === names.length)
      expect(f.order).toEqual(f.h.personas.map((p) => `slack:${p.key}`))
      expect(launched()).toEqual([])

      // Ready in the order Delta, (Beta refused), Echo, Alpha, Gamma.
      await settle(delta)
      await pollUntil(() => launched().length === 1)
      await settle(beta, { kind: 'platform', error: 'invalid_auth' })
      await settle(echo)
      await pollUntil(() => launched().length === 2)
      await settle(alpha)
      await pollUntil(() => launched().length === 3)
      await settle(gamma)
      await pollUntil(() => launched().length > 3, 50)

      // Beta took no slot: the three slots are Delta, Echo and Alpha, all held; Gamma waits.
      expect(launched()).toEqual([id(delta), id(echo), id(alpha)])
      expect(held.held()).toEqual([id(delta), id(echo), id(alpha)])
      // Every Slack bring-up has finished while no launch has settled.
      expect(f.h.personas.map((p) => [p.key, f.h.manager.status(p.key)?.state])).toEqual([
        [alpha.key, 'up'], [beta.key, 'broken'], [gamma.key, 'up'], [delta.key, 'up'], [echo.key, 'up'],
      ])

      // A slot frees: the next ready persona (Gamma) takes it; still at most 3 running.
      held.release(id(echo))
      await pollUntil(() => launched().length === 4)
      expect(launched()).toEqual([id(delta), id(echo), id(alpha), id(gamma)])
      expect(held.held()).toEqual([id(delta), id(alpha), id(gamma)])

      held.releaseAll()
      result = await start
    })

    expect(result.notBroughtUp).toBe(1)
    expect(result.freshSpawned).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.perPersona.find((o) => o.key === beta.key)).toEqual({
      key: beta.key,
      action: 'not-brought-up',
      outcome: 'broken',
      failures: [{ step: 'slack', class: 'persona-credentials-refused', cause: expect.any(String) }],
    })
    expect(launched()).not.toContain(id(beta))
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  // b.av2 SR-6.1: retries run outside the pool. A (Slack unreachable at start)
  // is `retrying` and B (credentials file missing) is `broken`; neither takes a
  // slot or counts as failed. With the single slot held by C and D queued, A's
  // manager retry (fake clock) brings it up and the controller launches it at
  // once, not behind the pool; the pass then returns while A's launch is still
  // held, and A's later launch never enters the pass's counts.
  test('concurrency 1, launches held: a retrying persona that comes up later is launched outside the pool — it neither waits for the pass nor blocks it; broken and retrying take no slot and are not failures', async () => {
    const readLog = captureStartupErrors()
    const names = ['Alpha Desk', 'Beta Ops', 'Gamma Hub', 'Delta Bay']
    const f = bringUpFixture({ authTest: [{ kind: 'network' }] }, names)
    const [alpha, beta, gamma, delta] = f.h.personas as Persona[]
    rmSync(beta.credentials_file)
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)
    const id = (p: Persona) => `cscb_${p.key}`

    let result: Awaited<ReturnType<typeof startupSessionManager>> | undefined
    const errLog = await withCapturedErr(async () => {
      const start = startupSessionManager(f.cfg, { concurrency: 1, bringUp: f.bringUp })
      void start.then((r) => { result = r })

      // Gamma holds the only slot; Delta queues; Alpha is retrying, Beta broken.
      await pollUntil(() => launched().length === 1)
      await pollUntil(() => launched().length > 1, 50)
      expect(launched()).toEqual([id(gamma)])
      expect(f.h.manager.status(alpha.key)).toMatchObject({ state: 'retrying', phase: 'bring-up' })
      expect(f.bringUp.state(beta.key)?.outcome).toBe('broken')

      // Alpha's retry succeeds: its launch starts at once, beside the held slot.
      await f.h.clock.runNext()
      await pollUntil(() => launched().length === 2)
      expect(f.h.manager.status(alpha.key)?.state).toBe('up')
      expect(launched()).toEqual([id(gamma), id(alpha)])
      expect(held.held()).toEqual([id(gamma), id(alpha)])
      expect(result).toBeUndefined()

      // The pool finishes Gamma then Delta; the pass returns with Alpha's launch still held.
      held.release(id(gamma))
      await pollUntil(() => launched().length === 3)
      held.release(id(delta))
      await pollUntil(() => result !== undefined)
      expect(result).toBeDefined()
      expect(held.held()).toEqual([id(alpha)])
      expect(isLaunchInFlight(alpha.key)).toBe(true)

      held.release(id(alpha))
      await pollUntil(() => !isLaunchInFlight(alpha.key))
    })

    expect(isLaunchInFlight(alpha.key)).toBe(false)
    expect(launched()).toEqual([id(gamma), id(alpha), id(delta)])
    const byKey = (x: { key: string }, y: { key: string }) => x.key.localeCompare(y.key)
    const expected: StartupPersonaOutcome[] = [
      { key: gamma.key, action: 'spawned' },
      { key: delta.key, action: 'spawned' },
      {
        key: alpha.key,
        action: 'not-brought-up',
        outcome: 'retrying',
        failures: [{ step: 'slack', class: 'persona-slack-unreachable', cause: expect.any(String) }],
      },
      {
        key: beta.key,
        action: 'not-brought-up',
        outcome: 'broken',
        failures: [{ step: 'credentials', class: 'persona-credentials-missing', cause: expect.any(String) }],
      },
    ]
    expect([...result!.perPersona].sort(byKey)).toEqual(expected.sort(byKey))
    expect(result!.notBroughtUp).toBe(2)
    expect(result!.failed).toBe(0)
    expect(result!.succeeded).toBe(2)
    expect(result!.freshSpawned).toBe(2)
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    expect(errLog).toContain('0 failed, 2 not brought up')
    assertNoLeak({ lines: f.lines, errLog, result })
  })

  test('without bringUp: launches go through the same pool in config order, at most `concurrency` at once', async () => {
    const cfg = makeMultiPersonaConfig(
      ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, working_directory: `/x/${name}` })),
      fixtureDir,
    )
    const held = holdSpawns(installStub({}))
    const launched = () => held.calls.map((p) => p.claude_instance_id)

    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    await withCapturedErr(async () => {
      const start = startupSessionManager(cfg, { concurrency: 3 })
      await pollUntil(() => launched().length === 3)
      await pollUntil(() => launched().length > 3, 50)
      expect(launched()).toEqual(['cscb_alpha', 'cscb_beta', 'cscb_gamma'])

      held.release('cscb_beta')
      await pollUntil(() => launched().length === 4)
      expect(launched()).toEqual(['cscb_alpha', 'cscb_beta', 'cscb_gamma', 'cscb_delta'])
      expect(held.held()).toEqual(['cscb_alpha', 'cscb_gamma', 'cscb_delta'])

      held.releaseAll()
      result = await start
    })

    expect(result.freshSpawned).toBe(4)
    expect(result.notBroughtUp).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// b.rmy — ErrTmuxSendKeys self-heal + accurate reconnect outcome reporting
// ---------------------------------------------------------------------------

describe('b.rmy: ErrTmuxSendKeys self-heal + reconnect outcome', () => {
  test('reconnectMcp: ErrTmuxSendKeys → ensure tmux server + retry once → success', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('ok')
    expect(ensureCalls).toBe(1)
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls[1].text).toContain('/mcp reconnect')
    // Retry succeeded — no failure notice
    expect(notices).toHaveLength(0)
  })

  test('reconnectMcp: retry after ErrTmuxSendKeys also fails → dead-session (b.3ce: caller recovers, no failure notice)', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errTmuxSendKeys(), // persistent — first attempt AND retry fail
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('dead-session')
    expect(ensureCalls).toBe(1) // self-heal attempted exactly once (single retry)
    expect(sendKeysCalls).toHaveLength(2)
    // b.3ce: dead-session hands recovery to the caller — no premature failure notice
    expect(notices).toHaveLength(0)
  })

  test('reconnectMcp: non-tmux sendKeys error → no self-heal, no retry', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysError: errGeneric('send-keys', 'ErrSomethingElse'),
    })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(ensureCalls).toBe(0)
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('spawnForPersona waiting branch: self-heal retry succeeds → reconnected', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    _setTmuxServerEnsurer(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedOk<import('agent-director').SendKeysResult>({}),
      ],
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('reconnected')
    expect(sendKeysCalls).toHaveLength(2)
  })

  test('spawnForPersona waiting branch (b.3ce): persistent ErrTmuxSendKeys → resume recovery, not failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent — self-heal retry fails too (dead session)
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    // b.3ce: pre-fix this reported 'failed' and gave up; now the dead session
    // falls through to the ended/missing recovery logic (resume-first).
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
    expect(readLog()).toBe('')
  })

  test('spawnForPersona waiting branch (b.3ce): dead session + resume not resumable → kill+delete+fresh spawn', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errSpawnNotResumable(), // stale `waiting` row rejects resume
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2) // initial collision + fresh spawn
  })

  test('spawnForPersona waiting branch: dead session and recovery also fails → action=failed', async () => {
    const readLog = captureStartupErrors()
    _setTmuxServerEnsurer(async () => {})
    _setTmuxSessionKiller(async () => {})
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      // Recovery fails too: a LAUNCH FAILURE at the resume, and at the self-heal respawn after it.
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errTmuxSessionCreate('resume'),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    // The recovery's failure raises a spawn-failure notice and its own one
    // spawn-failed entry (the self-heal respawn's); no reconnect-failed startup entry.
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(onlyStartupEntry(readLog(), 'spawn-failed')).toContain(`self-heal spawn after ErrTmuxSessionCreate failed for ${renderPersonaRef('C', 'C')}: `)
    expect(readLog()).not.toContain('reconnect failed')
  })

  test('startupSessionManager: unrecoverable channels are counted (no false "0 failed")', async () => {
    captureStartupErrors() // keep startup-errors.log in a temp dir
    _setTmuxServerEnsurer(async () => {})
    // Both routes collide into `waiting` rows whose reconnect send-keys fails
    // persistently — the 2026-09-18 post-reboot outage shape — AND the b.3ce
    // resume recovery fails, so both must land in the failed bucket.
    const cfg = makeStandInPersonaConfig({ C1: { working_directory: '/x1' }, C2: { working_directory: '/x2' } }, fixtureDir)
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      sendKeysError: errTmuxSendKeys(),
      resumeError: errGeneric('resume', 'ErrResumeBroken'),
    })
    // Each persona's collision get returns its own `waiting` row.
    stub.get = personaRowsGet(cfg, { state: 'waiting' })
    const result = await startupSessionManager(cfg, { concurrency: 1 })
    expect(result.failed).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.perPersona.every((p) => p.action === 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// b.3ce — waitForWaitingAndReconnect timeout liveness verdict + working-branch
// dead-session recovery
// ---------------------------------------------------------------------------

describe('b.3ce: waitForWaitingAndReconnect timeout liveness + dead-session recovery', () => {
  // b.ecw: the timeout branch now keys on the claude PROCESS via a fresh
  // findMissing sweep + one status call, NOT the raw tmux probe. A process
  // merely mid-long-turn reports a live state and is left alive — the tmux
  // prober is never consulted on the happy/live path. b.f2b: the outcome is
  // 'not-reconnected' ('ok' only when `/mcp reconnect` was typed).
  test('timeout with claude process alive (status working) → not-reconnected, nothing typed, tmux NOT probed (long turns are not errors — regression guard)', async () => {
    _setWaitForWaitingTimeoutMs(30)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      findMissingCalls,
      sendKeysCalls,
      findMissingResult: cannedFindMissing(), // b.m4r: empty sweep — a genuinely-alive long-turn row is untouched
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // process mid-long-turn
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('not-reconnected')
    expect(sendKeysCalls).toEqual([])
    // b.ecw: the live-status verdict is authoritative — the raw tmux probe is
    // NOT called on this path.
    expect(probed).toEqual([])
    expect(findMissingCalls).toHaveLength(1)
  })

  // b.ecw: at the 10-minute deadline the 10s memo has expired, so a FRESH
  // whole-store findMissing sweep fires before the timeout status call. TTL=0
  // forces the memo to expire so the second (timeout) sweep is observable.
  test('timeout fires a FRESH findMissing sweep before the timeout status call', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0) // memo expired by the deadline → timeout re-sweeps
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing(),
      statusResult: { state: 'working' } as import('agent-director').StatusResult, // stays live → up-front sweep does not short-circuit the loop
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('not-reconnected') // status live at timeout → left alive, nothing typed (b.f2b)
    // Up-front sweep + fresh timeout sweep = 2 (TTL=0 defeats memo reuse).
    expect(findMissingCalls).toHaveLength(2)
  })

  // b.ecw: the timeout status reports the process is gone (`missing`) → provably
  // dead → 'dead-session', with NO tmux probe. The poll loop stays `working`
  // (frozen mid-turn) until the deadline; only the timeout status flips to
  // `missing`, so the timeout branch (not the ended/missing loop branch) decides.
  test('timeout with claude process gone (status missing at deadline) → dead-session, tmux NOT probed', async () => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0) // memo expired by the deadline → the timeout re-sweeps
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true }) // even an "alive" tmux shell must not save a dead process
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      // Poll loop (after the up-front sweep, findMissingCalls===1) still sees a
      // frozen `working`; only after the FRESH timeout sweep (findMissingCalls===2)
      // does the row reconcile to `missing`, so the timeout branch decides.
      statusFn: () =>
        ({ state: findMissingCalls.length >= 2 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // process verdict is authoritative; tmux never consulted
  })

  // b.ecw: at the TIMEOUT CALL AD reports a status error that still falls back
  // to the raw tmux probe (b.rmy invariant): ErrSpawnNotFound (no row to
  // reconcile, E18 owns it), the only one left. tmux gone → dead-session,
  // tmux alive → not-reconnected (b.f2b; 'ok' before). Any other read error,
  // a CONFIG answer included (b.jg5 SRJ-316), no longer reaches the probe
  // (b.jg5 SRJ-105, the cases after this one), and an UNUSABLE NAME answer
  // latches the persona instead (b.jg5 SRJ-512, the case after this one). The
  // poll loop stays `working` and exits on the deadline; only the timeout
  // status call throws (TTL=0 makes the timeout sweep bump findMissingCalls
  // to 2, which flips statusFn into its error branch).
  test.each([
    ['ErrSpawnNotFound', () => errSpawnNotFound(), false, 'dead-session'],
    ['ErrSpawnNotFound', () => errSpawnNotFound(), true, 'not-reconnected'],
  ] as const)(
    'timeout with %s + tmux %s → %s (tmux fallback)',
    async (_label, errorFactory, tmuxAlive, expected) => {
      _setWaitForWaitingTimeoutMs(30)
      _setFindMissingMemoTtlMs(0)
      const probed: string[] = []
      _setTmuxSessionProber(async (name) => { probed.push(name); return tmuxAlive })
      const findMissingCalls: import('agent-director').FindMissingParams[] = []
      installStub({
        findMissingCalls,
        findMissingResult: cannedFindMissing(),
        statusFn: () =>
          findMissingCalls.length >= 2
            ? errorFactory()
            : ({ state: 'working' } as import('agent-director').StatusResult),
      })
      const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
      const result = await waitForWaitingAndReconnect('C', cfg)
      expect(result).toBe(expected)
      expect(probed).toEqual(['slack_bot_C']) // fell back to tmux
    },
  )

  // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer at the TIMEOUT CALL
  // latches C (the state unreadable: the read that met it read none) and
  // ends the wait latched whatever tmux shows: never the tmux fallback, so
  // never 'dead-session' or 'not-reconnected'; nothing typed, no notice, no
  // further call, one UNUSABLE NAME line.
  test.each([true, false])('b.jg5 SRJ-105, SRJ-512: timeout with an UNUSABLE NAME answer + tmux alive=%p → latched (C latched, its state unreadable), tmux NOT probed, nothing typed, no notice, nothing called after the read', async (tmuxAlive) => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const latch = createConflictLatch({ log: () => {} })
    setConflictLatch(latch)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return tmuxAlive })
    const calls = makeStubCallLog()
    let statusAfterLatch = 0
    installStub({
      ...calls,
      findMissingResult: cannedFindMissing(),
      statusFn: () => {
        if (latch.isLatched('C')) statusAfterLatch++
        return calls.findMissingCalls.length >= 2 ? errUnusableName() : ({ state: 'working' } as import('agent-director').StatusResult)
      },
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe(WAIT_OUTCOME_LATCHED)
    expect(probed).toEqual([])
    expect(calls.sendKeysCalls).toEqual([])
    expect(calls.findMissingCalls).toHaveLength(2) // the deadline's read decided, not the poll
    expect(statusAfterLatch).toBe(0)
    expect(latch.record('C')).toMatchObject({ latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE })
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'waitForWaitingAndReconnect: timeout: status read for persona=C: ')).toHaveLength(1)
    expect(linesWith(errLog, ' — UNUSABLE NAME: the persona latched; ')).toHaveLength(1)
    expect(linesWith(errLog, 'refused for persona=C')).toEqual([])
    assertNoLeak({ errLog, notices })
  })

  // b.jg5 SRJ-105: any other read error at the TIMEOUT CALL (an UNCLASSIFIED
  // `ErrTimeout` here, an UNAVAILABLE one alike) is handled as UNAVAILABLE:
  // 'failed', whatever tmux shows. It never reaches the tmux probe, so it can
  // never give 'dead-session', and it types nothing and posts no notice.
  test.each([true, false])('b.jg5 SRJ-105: timeout with an UNCLASSIFIED status error (ErrTimeout) + tmux alive=%p → failed, tmux NOT probed, nothing typed, no notice', async (tmuxAlive) => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return tmuxAlive })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      findMissingCalls,
      sendKeysCalls,
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= 2
          ? errGeneric('status', 'ErrTimeout')
          : ({ state: 'working' } as import('agent-director').StatusResult),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('failed')
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(2)
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'waitForWaitingAndReconnect: timeout: status read refused for persona=C')).toHaveLength(1)
  })

  // b.jg5 SRJ-105's CONFIG row, SRJ-316: a CONFIG answer at the TIMEOUT CALL
  // is a refusal whatever tmux shows: 'failed' with one refusal line, never
  // the tmux fallback (so never 'dead-session' and never 'not-reconnected'),
  // nothing typed, no not-connected or spawn-failure notice, and C's
  // ad-config-malformed outage raised by the wrapper with one onset.
  test.each([true, false])('b.jg5 SRJ-105, SRJ-316: timeout with a CONFIG answer (ErrConfigMalformed) + tmux alive=%p → failed and refused (one refusal line), tmux NOT probed, nothing typed, no notice, one ad-config-malformed onset', async (tmuxAlive) => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return tmuxAlive })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const err = errConfigMalformed()
    installStub({
      findMissingCalls,
      sendKeysCalls,
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= 2 ? err : ({ state: 'working' } as import('agent-director').StatusResult),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('failed')
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(2) // the deadline's read decided, not the poll
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'waitForWaitingAndReconnect: timeout: status read refused for persona=C')).toHaveLength(1)
    expect([...getOutageFlags('C')]).toEqual(['ad-config-malformed'])
    expect(outageEmissions).toEqual([{ key: 'C', text: adConfigMalformedOnset(err) }])
  })

  // b.jg5 SRJ-105: ErrSystemInstallDisappeared at the TIMEOUT CALL takes the
  // poll loop's early 'failed' (one rule at both reads): never the tmux
  // fallback, never 'dead-session', and not a refusal. (ErrTmuxNotAvailable
  // is a refusal at both reads since b.jg5 SRJ-311: the cases below.)
  const TIMEOUT_EARLY_FAILED_ERRORS = [
    ['ErrSystemInstallDisappeared', () => new ErrSystemInstallDisappeared('status', '/usr/bin/agent-director')],
  ] as const

  /**
   * The ENVIRONMENT answers (`ErrTmuxNotAvailable`) at a `status` read, each
   * with the onset it raises: tmux cannot be run (today's onset), and the
   * different-server form (b.jg5 SRJ-1021's onset).
   */
  const WAIT_ENVIRONMENT_ERRORS = [
    ['ErrTmuxNotAvailable (tmux cannot be run)', () => errTmuxNotAvailable(undefined, 'status'), ONSET_TEMPLATES['tmux-unavailable']()],
    ['ErrTmuxNotAvailable (not the tmux server the agent was launched on)', () => errTmuxNotAvailableDifferentServer(undefined, 'status'), tmuxServerChangedOnset()],
  ] as const

  test.each(TIMEOUT_EARLY_FAILED_ERRORS)('b.jg5 SRJ-105: timeout with %s → failed, tmux NOT probed, nothing typed, not refused', async (_label, errorFactory) => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false }) // gone: the fallback would say dead-session
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      findMissingCalls,
      sendKeysCalls,
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= 2 ? errorFactory() : ({ state: 'working' } as import('agent-director').StatusResult),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('failed')
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(2) // the deadline's read decided, not the poll
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'status read refused for persona=C')).toEqual([])
  })

  // b.jg5 SRJ-311: ErrTmuxNotAvailable at the TIMEOUT CALL is a refusal:
  // 'failed' with one refusal line, never the tmux fallback (so never
  // 'dead-session'), nothing typed, no notice, and C's tmux-unavailable
  // outage raised with one onset.
  test.each(WAIT_ENVIRONMENT_ERRORS)('b.jg5 SRJ-311, SRJ-1021: timeout with %s → failed and refused (one refusal line), tmux NOT probed, nothing typed, no notice, one tmux-unavailable onset with the form\'s text', async (_label, errorFactory, onset) => {
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false }) // gone: the fallback would say dead-session
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      findMissingCalls,
      sendKeysCalls,
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= 2 ? errorFactory() : ({ state: 'working' } as import('agent-director').StatusResult),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('failed')
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(findMissingCalls).toHaveLength(2) // the deadline's read decided, not the poll
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'waitForWaitingAndReconnect: timeout: status read refused for persona=C')).toHaveLength(1)
    expect([...getOutageFlags('C')]).toEqual(['tmux-unavailable'])
    expect(outageEmissions).toEqual([{ key: 'C', text: onset }])
  })

  // The ladder's working branch treats both reads alike: 'failed', no
  // dead-session recovery (no kill, delete, resume or launch), no tmux probe,
  // not refused, and one `spawn-failed` "reconnect failed (state=working)"
  // entry at a startup launch.
  test.each(
    TIMEOUT_EARLY_FAILED_ERRORS.flatMap(([label, errorFactory]) =>
      (['poll', 'timeout'] as const).map((read) => [label, read, errorFactory] as const),
    ),
  )('b.jg5 SRJ-105: spawnForPersona working branch, %s at the wait\'s %s status read → failed, no probe, no kill/delete/resume/launch, one spawn-failed entry', async (_label, read, errorFactory) => {
    const readLog = captureStartupErrors()
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    // The poll read fails at once; the timeout read fails only after the
    // deadline's fresh sweep (this launch's second).
    const failsAt = read === 'poll' ? 1 : 2
    installStub({
      findMissingCalls,
      spawnCalls,
      killCalls,
      deleteCalls,
      resumeCalls,
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= failsAt ? errorFactory() : ({ state: 'working' } as import('agent-director').StatusResult),
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'failed' }) // no refusal marker
    expect(findMissingCalls).toHaveLength(failsAt)
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(killCalls).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    expect(spawnCalls).toHaveLength(1) // only the initial colliding spawn
    expect(onlyStartupEntry(readLog(), 'spawn-failed')).toEndWith(`] [spawn-failed] reconnect failed for ${renderPersonaRef('C', 'C')} (state=working)`)
  })

  // b.jg5 SRJ-311: ErrTmuxNotAvailable at either read is a refusal of the
  // launch: 'failed' with the refusal marker (the ENVIRONMENT cause armed C's
  // timer once), no dead-session recovery, no tmux probe, no notice, one
  // tmux-unavailable onset, and no `spawn-failed` entry (the E10 hatch note).
  test.each(
    WAIT_ENVIRONMENT_ERRORS.flatMap(([label, errorFactory, onset]) =>
      (['poll', 'timeout'] as const).map((read) => [label, read, errorFactory, onset] as const),
    ),
  )('b.jg5 SRJ-311, SRJ-1021: spawnForPersona working branch, %s at the wait\'s %s status read → failed and refused, no probe, no kill/delete/resume/launch, no notice, one tmux-unavailable onset with the form\'s text, no spawn-failed entry', async (_label, read, errorFactory, onset) => {
    const readLog = captureStartupErrors()
    const armed: Array<{ key: string; kind: string }> = []
    initOutageState({
      getClient,
      notify: (key, text) => { outageEmissions.push({ key, text }) },
      triggerSink: {
        arm: (key, cause) => {
          armed.push({ key, kind: cause.kind })
          return true
        },
      },
    })
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    // The poll read fails at once; the timeout read fails only after the
    // deadline's fresh sweep (this launch's second).
    const failsAt = read === 'poll' ? 1 : 2
    installStub({
      findMissingCalls,
      spawnCalls,
      killCalls,
      deleteCalls,
      resumeCalls,
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      findMissingResult: cannedFindMissing(),
      statusFn: () =>
        findMissingCalls.length >= failsAt ? errorFactory() : ({ state: 'working' } as import('agent-director').StatusResult),
    })

    let result: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'failed', refused: true })
    expect(armed).toEqual([{ key: 'C', kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT }])
    expect(findMissingCalls).toHaveLength(failsAt)
    expect(probed).toEqual([])
    expect(sendKeysCalls).toEqual([])
    expect(killCalls).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    expect(spawnCalls).toHaveLength(1) // only the initial colliding spawn
    expect(notices).toEqual([])
    expect(linesWith(errLog, `status read refused for ${renderPersonaRef('C', 'C')}: `)).toHaveLength(1)
    expect([...getOutageFlags('C')]).toEqual(['tmux-unavailable'])
    expect(outageEmissions).toEqual([{ key: 'C', text: onset }])
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
  })

  // b.ecw: the poll loop's ended/missing branch aborts early. `statusFn` flips to
  // `missing` on the FIRST poll after the up-front sweep (findMissingCalls >= 1),
  // so waitForWaitingAndReconnect returns dead-session from the loop branch WITHOUT
  // ever reaching the deadline — the timeout branch never runs. spawnForPersona then
  // drives the dead-session recovery (findMissing-before-resume → resume).
  test('spawnForPersona working branch: loop ended/missing early-abort → dead-session → resume recovery', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setWaitForWaitingTimeoutMs(30)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      // Up-front sweep reconciles the frozen row; the first poll then sees `missing`,
      // so the loop's ended/missing branch returns dead-session before the deadline.
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () =>
        ({ state: findMissingCalls.length >= 1 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
  })

  // b.f2b: the ladder reports the wait's real outcome — `reconnected` only
  // when `/mcp reconnect` was typed — and launchSession still counts it as a
  // launch that did not fail (SR-25.1 counting unchanged).
  test('spawnForPersona working branch: timeout + session alive → not-reconnected, nothing typed (no kill/resume/spawn); launchSession maps it to true', async () => {
    _setWaitForWaitingTimeoutMs(30)
    // The timeout live path decides on the fresh status call alone and never
    // consults tmux; capture the prober to prove it is not called.
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnCalls,
      killCalls,
      resumeCalls,
      sendKeysCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      statusResult: { state: 'working' } as import('agent-director').StatusResult,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result).toEqual({ key: 'C', action: 'not-reconnected' })
    expect(sendKeysCalls).toEqual([])
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(0)
    expect(spawnCalls).toHaveLength(1) // only the initial colliding spawn
    expect(probed).toEqual([]) // live timeout verdict never consults tmux

    // The restart path's launch over the same row.
    expect(await launchSession('C', cfg)).toBe(true)
    expect(sendKeysCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.4dk — findMissing-before-resume on the dead-session recovery path
//
// AD's resume verb requires a terminal (ended/missing) row. A dead-session
// verdict arrives with a LIVE-state row (waiting/working), so pre-fix resume
// was structurally guaranteed to throw ErrSpawnNotResumable → kill+delete+
// fresh, destroying the session_id resume needed. The fix runs one
// client.findMissing({}) BEFORE resume (only on the dead-session callers) so
// AD transitions the dead row to `missing` and resume can succeed.
//
// The `callLog` capture proves relative ordering; `findMissingCalls` proves
// the call count and that it carries an empty-params sweep ({}).
// ---------------------------------------------------------------------------

describe('b.4dk: findMissing-before-resume on dead-session recovery', () => {
  // Drive the WAITING-branch dead-session verdict: reconnectMcp send-keys fails
  // persistently even after the b.vub self-heal (tmux server ensurer no-op),
  // which is the 'dead-session' signal for a waiting row.
  test('waiting dead-session: findMissing runs exactly once BEFORE resume → resumed', async () => {
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(), // persistent → dead session
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    expect(resumeCalls).toHaveLength(1)
    // Ordering: findMissing must be the immediately-preceding verb before resume.
    expect(callLog.indexOf('findMissing')).toBeGreaterThanOrEqual(0)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // Drive the WORKING-branch dead-session verdict: waitForWaitingAndReconnect
  // times out and the timeout status reports the claude process gone (b.ecw —
  // the timeout branch now keys on the process via a fresh findMissing sweep +
  // status, not the raw tmux probe). TTL=0 makes the timeout sweep observable
  // and lets the reconciled `missing` verdict flip in.
  test('working dead-session: findMissing runs (sweep + reconcile) BEFORE resume → resumed', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setWaitForWaitingTimeoutMs(30)
    _setFindMissingMemoTtlMs(0)
    _setTmuxServerEnsurer(async () => {})
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      callLog,
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      // Poll loop stays `working`; only after the fresh timeout sweep does the
      // row reconcile to `missing` → dead-session → resume recovery.
      statusFn: () =>
        ({ state: findMissingCalls.length >= 2 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    // findMissing fires and precedes resume. (With TTL=0 the up-front sweep, the
    // timeout sweep, and resumeOrFreshSpawn's reconcileMissingFirst each sweep,
    // so the count is >1; the ordering assertion is what matters here.)
    expect(findMissingCalls.length).toBeGreaterThanOrEqual(1)
    expect(findMissingCalls[0]).toEqual({})
    expect(resumeCalls).toHaveLength(1)
    expect(callLog.indexOf('findMissing')).toBeGreaterThanOrEqual(0)
    expect(callLog.indexOf('findMissing')).toBeLessThan(callLog.indexOf('resume'))
  })

  // ended/missing caller (SR-1.4 collision resolved to a terminal row) does NOT
  // set reconcileMissingFirst — the row is already terminal, straight to resume.
  test('ended/missing path: resume called with NO findMissing call', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(1)
  })

  // findMissing rejects → still attempt resume anyway → on a still-live row AD
  // throws ErrSpawnNotResumable → existing defensive kill+delete+fresh preserved.
  // The rejection is one that is no refusal at `find-missing` (an UNUSABLE
  // NAME answer, b.jg5 SRJ-105); an UNAVAILABLE, ENVIRONMENT, CONFIG or
  // UNCLASSIFIED one stops the attempt there (the SRJ-105, SRJ-311, SRJ-316 and
  // SRJ-313 sweep cases below).
  test('waiting dead-session: findMissing rejects → resume attempted → ErrSpawnNotResumable → kill+delete+fresh', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      findMissingError: errUnusableName(),
      resumeError: errSpawnNotResumable(), // row still live-state → resume rejects
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1)
    expect(resumeCalls).toHaveLength(1) // resume still attempted despite findMissing failure
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
    expect(spawnCalls).toHaveLength(2)
  })

  // resume_enabled=false short-circuits BEFORE the findMissing block —
  // kill+delete+fresh as before, no findMissing, no resume.
  test('resume_enabled=false dead-session: no findMissing, no resume (kill+delete+fresh)', async () => {
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const killCalls: import('agent-director').KillParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: false })
    installStub({
      findMissingCalls,
      resumeCalls,
      killCalls,
      deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  // Regression guard for b.vub self-heal: an ErrTmuxSessionCreate on resume in
  // the dead-session path must still trigger the orphan-tmux-kill self-heal and
  // a fresh respawn — unchanged by the findMissing insertion.
  test('waiting dead-session: findMissing then resume ErrTmuxSessionCreate → b.vub self-heal respawn → spawned', async () => {
    _setTmuxServerEnsurer(async () => {})
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      findMissingCalls,
      resumeCalls,
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' } as import('agent-director').SpawnResult),
      ],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errTmuxSessionCreate('resume'),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('spawned')
    expect(findMissingCalls).toHaveLength(1) // findMissing still runs once, before resume
    expect(resumeCalls).toHaveLength(1) // resume attempted once, threw ErrTmuxSessionCreate
    expect(killedSessions).toHaveLength(1) // b.vub self-heal killed the orphan tmux session
    expect(spawnCalls).toHaveLength(2) // initial collision + self-heal fresh spawn
  })
})

// ---------------------------------------------------------------------------
// b.m4r — waitForWaitingAndReconnect probes tmux first via an up-front
// findMissing sweep, instead of spinning `status` for the full 10-minute window
//
// A bot killed mid-turn never fires SessionEnd, so its AD row freezes at
// `working`. Pre-fix, waitForWaitingAndReconnect polled `status` (which stays
// `working`) until WAIT_FOR_WAITING_TIMEOUT_MS (10 min) before the tmux probe
// finally decided. The fix runs ONE evidence-based findMissing sweep up front
// (t1.93m.hp): a genuinely-dead row reconciles to `missing`, so the FIRST
// status poll hits the ended/missing tmux-confirm branch and returns
// 'dead-session' in seconds. A genuinely-alive long-turn row is untouched by
// the sweep (empty result) and keeps today's polling behavior (b.rmy guard).
// ---------------------------------------------------------------------------

describe('b.m4r: waitForWaitingAndReconnect up-front findMissing sweep → fast dead-session', () => {
  // Fast path (ticket acceptance criterion): working-row collision, tmux gone.
  // Models the real frozen row — a bot killed mid-turn: AD reports `working`
  // on every status poll UNTIL the up-front findMissing sweep reconciles the
  // dead row to `missing`. Post-fix the sweep runs first, so the FIRST status
  // poll already sees `missing` → tmux-confirm (prober false) → 'dead-session'
  // after exactly ONE poll, NOT after the timeout window.
  //
  // REGRESSION GUARD (must FAIL pre-fix): without the up-front sweep the row
  // stays `working` forever, so the loop spins `status` until the timeout fires
  // — statusCalls balloons well past 1 (verified by stashing the src change).
  test('working row, tmux gone: up-front findMissing sweep reconciles → dead-session in exactly 1 status poll, sweep runs once before the poll', async () => {
    // A timeout large enough that, pre-fix, the poll loop would rack up many
    // status calls before giving up — the assertions below then fail loudly.
    _setWaitForWaitingTimeoutMs(2_000)
    _setTmuxSessionProber(async () => false) // tmux session is gone
    const callLog: string[] = []
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const statusCalls: import('agent-director').StatusParams[] = []
    // The dead row only becomes `missing` once findMissing has reconciled it;
    // until then AD keeps reporting the frozen `working` state.
    installStub({
      callLog,
      findMissingCalls,
      statusCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    const result = await waitForWaitingAndReconnect('C', cfg)

    expect(result).toBe('dead-session')
    // Post-fix: the sweep ran before the loop, so the very first status poll
    // already sees `missing`. Pre-fix: row stays `working` → many polls → fail.
    expect(statusCalls).toHaveLength(1)
    // The sweep runs exactly once, is a full evidence-based sweep ({}), and
    // precedes the first status poll (callLog instruments both verbs).
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    const firstFindMissing = callLog.indexOf('findMissing')
    const firstStatus = callLog.indexOf('status')
    expect(firstFindMissing).toBe(0)
    expect(firstStatus).toBeGreaterThan(firstFindMissing)
  })

  // findMissing rejects → logged, poll loop proceeds exactly as today. Here the
  // row then transitions working→waiting and reconnectMcp succeeds → 'ok'. No
  // crash, no behavior change from the sweep failure. The rejection is one
  // that is no refusal at `find-missing` (an UNUSABLE NAME answer, b.jg5
  // SRJ-105); a refused one stops the wait (the sweep cases below).
  test('findMissing rejects → poll loop proceeds → working→waiting → reconnect ok', async () => {
    _setWaitForWaitingTimeoutMs(60_000)
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingError: errUnusableName(),
      statusQueue: [
        cannedOk<import('agent-director').StatusResult>({ state: 'working' }),
        cannedOk<import('agent-director').StatusResult>({ state: 'waiting' }),
      ],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(1) // attempted once, rejected
    expect(result).toBe('ok') // reconnectMcp succeeded on the waiting transition
  })

  // -------------------------------------------------------------------------
  // Memo (single-flight + short-TTL) around reconcileMissingSweep (b.m4r).
  // The sweep is idempotent, so back-to-back callers within the TTL must share
  // ONE actual client.findMissing({}); past the TTL a caller re-sweeps; a failed
  // sweep is never memoized, so the next caller retries.
  // -------------------------------------------------------------------------

  // Two back-to-back callers within the TTL share one sweep. Each call reconciles
  // the dead row, so both return 'dead-session', but findMissing fires only once.
  test('memo: back-to-back callers within TTL share one findMissing sweep', async () => {
    _setWaitForWaitingTimeoutMs(2_000)
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    const first = await waitForWaitingAndReconnect('C', cfg)
    const second = await waitForWaitingAndReconnect('C', cfg)

    expect(first).toBe('dead-session')
    expect(second).toBe('dead-session')
    expect(findMissingCalls).toHaveLength(1) // second caller reused the memoized sweep
  })

  // TTL=0 disables reuse: the second caller re-sweeps.
  test('memo: second caller past the TTL re-sweeps', async () => {
    _setWaitForWaitingTimeoutMs(2_000)
    _setFindMissingMemoTtlMs(0)
    _setTmuxSessionProber(async () => false)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }),
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }) as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    await waitForWaitingAndReconnect('C', cfg)
    await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(2) // TTL=0 → no reuse, each caller sweeps
  })

  // A failed sweep is NOT memoized: the next caller retries. (The failure is
  // no refusal, as in the case above, so each wait goes on as before.)
  test('memo: a failed sweep is not memoized → next caller retries', async () => {
    _setWaitForWaitingTimeoutMs(60_000)
    _setTmuxServerEnsurer(async () => {})
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingError: errUnusableName(),
      statusQueue: [
        cannedOk<import('agent-director').StatusResult>({ state: 'working' }),
        cannedOk<import('agent-director').StatusResult>({ state: 'waiting' }),
      ],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })

    await waitForWaitingAndReconnect('C', cfg)
    await waitForWaitingAndReconnect('C', cfg)

    expect(findMissingCalls).toHaveLength(2) // failure not cached → both callers hit AD
  })
})

// ---------------------------------------------------------------------------
// t1.tkk.e4 / b.sv7 — sweepDeadTmuxChannel: the exported escalate-dead wrapper
//
// The wrapper bundles an UNCONDITIONAL operator log line (emitted before/outside
// the memoized helper — memo hits return silently, so the log must not live
// inside reconcileMissingSweep) plus a call into the still-private memoized
// reconcileMissingSweep (b.m4r). Exercised here through its exported surface.
//
// Coverage:
//   - Log content: the operator line names the channel id, the dead-tmux
//     verdict, and that reconciliation was triggered — emitted UNCONDITIONALLY,
//     including on a memo hit (Epic AC 3, I1).
//   - b.nk5 fleet shape: several distinct channel ids escalate concurrently in
//     one tick window → exactly ONE client.findMissing sweep (in-flight sharing),
//     all callers resolve; a caller past the TTL re-sweeps.
//   - b.m4r contract pins through the wrapper: one memoized TTL-guarded
//     in-flight-shared sweep; failures NOT memoized; never a second sweep pattern.
// ---------------------------------------------------------------------------

describe('t1.tkk.e4: sweepDeadTmuxChannel escalate-dead wrapper', () => {
  // Capture console.error to assert on the operator-visible log line. The
  // wrapper (and reconcileMissingSweep) log via console.error; we restore it in
  // afterEach so no capture leaks into later tests.
  let errLog: string[]
  let realError: typeof console.error

  beforeEach(() => {
    errLog = []
    realError = console.error
    console.error = (...args: unknown[]) => { errLog.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = realError
  })

  // The escalate-dead operator line names the channel, the dead-tmux verdict,
  // and that reconciliation was triggered — the recovery-no-longer-silently-
  // blocked signal an operator must see on every escalate-dead verdict.
  test('log: operator line names channel id, dead-tmux verdict, reconciliation triggered', async () => {
    installStub({ findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    await sweepDeadTmuxChannel('C', 'dead-session')

    const line = errLog.find((l) => l.includes('escalate-dead: persona=C'))
    expect(line).toBeDefined()
    expect(line).toContain('persona=C')
    expect(line).toContain('verdict=dead-session')
    expect(line!.toLowerCase()).toContain('reconciliation')
  })

  // The log is emitted UNCONDITIONALLY — before/outside the memoized helper —
  // so a memo HIT (which returns silently from reconcileMissingSweep, firing no
  // findMissing) still produces the operator line. This is the I1 contract: the
  // log lives in the wrapper, not the memoized sweep.
  test('log: emitted even on a memo hit (unconditional), no second findMissing', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    // First escalate primes the memo (one real sweep).
    await sweepDeadTmuxChannel('C', 'dead-session')
    expect(findMissingCalls).toHaveLength(1)

    errLog.length = 0 // isolate the memo-hit call's emissions
    // Second escalate within the (default, non-zero) TTL: memo hit → no sweep,
    // but the wrapper's operator line must still fire.
    await sweepDeadTmuxChannel('D', 'dead-session')

    expect(findMissingCalls).toHaveLength(1) // memo hit → NO second sweep
    const line = errLog.find((l) => l.includes('escalate-dead: persona=D'))
    expect(line).toBeDefined()
    expect(line).toContain('verdict=dead-session')
    expect(line!.toLowerCase()).toContain('reconciliation')
  })

  // b.nk5 post-reboot fleet shape: every channel's tmux session is dead, so the
  // health-check tick escalates them all in one window. The sweep is whole-store
  // and single-flight, so N concurrent wrapper calls must collapse to exactly
  // ONE client.findMissing({}) — the fleet is served by one in-flight-shared
  // sweep, not N. All callers resolve (the wrapper never throws).
  test('b.nk5: N channels escalating concurrently in one tick share ONE findMissing', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 3, ids: ['cscb_A', 'cscb_B', 'cscb_C'] }) })

    // Start all wrappers WITHOUT awaiting between them: the first synchronously
    // stakes the in-flight slot before any await resolves, so the rest reuse it.
    const settled = await Promise.allSettled([
      sweepDeadTmuxChannel('A', 'dead-session'),
      sweepDeadTmuxChannel('B', 'dead-session'),
      sweepDeadTmuxChannel('C', 'dead-session'),
      sweepDeadTmuxChannel('D', 'dead-session'),
    ])

    // All callers resolve (single in-flight-shared sweep, wrapper never throws).
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true)
    // Exactly one real sweep for the whole fleet (in-flight sharing).
    expect(findMissingCalls).toHaveLength(1)
    expect(findMissingCalls[0]).toEqual({})
    // Every escalating channel got its own unconditional operator line.
    for (const c of ['A', 'B', 'C', 'D']) {
      expect(errLog.some((l) => l.includes(`escalate-dead: persona=${c}`))).toBe(true)
    }
  })

  // Past the TTL, a later escalate re-sweeps — the memo is a short-TTL cache, not
  // a latch. TTL=0 defeats reuse so the second wrapper call issues a fresh sweep.
  test('b.nk5/b.m4r: a caller past the TTL re-sweeps', async () => {
    _setFindMissingMemoTtlMs(0)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingResult: cannedFindMissing({ count: 1, ids: ['cscb_C'] }) })

    await sweepDeadTmuxChannel('C', 'dead-session')
    await sweepDeadTmuxChannel('C', 'dead-session')

    expect(findMissingCalls).toHaveLength(2) // TTL=0 → no reuse, each escalate sweeps
  })

  // b.jdc (b.dup review): the line says what the verdict proves. Only a gone
  // tmux session is "provably dead"; a refused keystroke (ErrSpawnNotInteractive)
  // proves the row is no longer interactive, whatever its tmux session. REPRO
  // for `row-not-interactive`: the old line claimed a dead tmux session for
  // every verdict.
  test.each([
    ['dead-session', 'tmux session provably dead'],
    ['working-tmux-gone', 'tmux session provably dead'],
    ['prompt-row-tmux-gone', 'tmux session provably dead'],
    [
      'row-not-interactive',
      'row not interactive (agent-director refused the /mcp reconnect keystrokes: it ended the row or marked it missing, so its claude process is gone)',
    ],
  ] as const)('log: verdict=%s says "%s"', async (verdict, evidence) => {
    installStub({})

    await sweepDeadTmuxChannel('C', verdict)

    expect(errLog.filter((l) => l.startsWith('[slack] escalate-dead: persona='))).toEqual([
      `[slack] escalate-dead: persona=C verdict=${verdict} — ${evidence}, triggering internal findMissing reconciliation (the restart relaunches it once its row reads dead; ~/startup/find-missing-loop.sh is belt-and-braces)`,
    ])
  })

  // b.m4r contract pin through the wrapper: a FAILED sweep is not memoized, so
  // the next escalate retries. The wrapper still never throws on the failure.
  test('b.m4r pin: a failed sweep is not memoized → next escalate retries, wrapper never throws', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, findMissingError: errGeneric('find-missing', 'ErrProbeFailed') })

    await sweepDeadTmuxChannel('C', 'dead-session') // must not throw
    await sweepDeadTmuxChannel('C', 'dead-session') // must not throw

    expect(findMissingCalls).toHaveLength(2) // failure not cached → both hit AD
  })
})

// ---------------------------------------------------------------------------
// b.c3o — waitForWaitingAndReconnect early-abort liveness verdict
// ---------------------------------------------------------------------------

describe('b.c3o: waitForWaitingAndReconnect early-abort liveness verdict', () => {
  // b.ecw: the ended/missing loop branch now keys on the claude PROCESS. After
  // the up-front evidence-based sweep, `missing`/`ended` is a provably-gone
  // process → 'dead-session' DIRECTLY, with NO raw tmux probe. The tmux prober
  // is stubbed here to blow up if touched.
  test.each([
    ['missing'],
    ['ended'],
  ])('transition to %s → dead-session directly, tmux NOT probed', async (state) => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false })
    installStub({
      statusResult: { state } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // process verdict is authoritative — no tmux probe
  })

  // b.ecw REGRESSION GUARD — FAILS on main's old code, PASSES with the fix.
  // Pre-fix, an ended/missing row with a *live* tmux shell returned 'ok' (the
  // tmux probe overruled the DB row). Post-fix a dead claude process in a
  // lingering tmux shell is a dead bot: 'dead-session', and the tmux prober is
  // NEVER called in this branch.
  test('transition to missing + tmux ALIVE → dead-session (process gone overrules a lingering tmux shell)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    installStub({
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
    expect(probed).toEqual([]) // the ended/missing branch no longer probes tmux
  })

  // b.f2b: a live transient state ends the wait with the session left alive and
  // nothing typed into its prompt: 'not-reconnected' ('ok' before).
  test('transition to live transient state (ask_user) → not-reconnected without probing, recovery or typing (regression guard)', async () => {
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return false }) // even a "dead" probe must not matter
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusResult: { state: 'ask_user' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('not-reconnected')
    expect(sendKeysCalls).toEqual([])
    expect(probed).toEqual([]) // live transient states never reach the prober
  })

  test('transition to live transient state (check_permission) → not-reconnected, never dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({
      statusResult: { state: 'check_permission' } as import('agent-director').StatusResult,
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('not-reconnected')
  })

  test('ErrSpawnNotFound + tmux gone → dead-session', async () => {
    _setTmuxSessionProber(async () => false)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('dead-session')
  })

  test('ErrSpawnNotFound + tmux alive → not-reconnected (b.f2b; ok before)', async () => {
    _setTmuxSessionProber(async () => true)
    installStub({ statusError: errSpawnNotFound() })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('not-reconnected')
  })

  test('spawnForPersona working branch: transition to missing + dead tmux → resume recovery instead of misreported ok', async () => {
    captureStartupErrors() // the dialog approver records dev-channels-approve-spawn-died here
    _setTmuxSessionProber(async () => false)
    _setTmuxServerEnsurer(async () => {})
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1 })
    installStub({
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'working' }),
      statusResult: { state: 'missing' } as import('agent-director').StatusResult,
      resumeCalls,
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('resumed')
    expect(resumeCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// b.f2b — a stale `working` row must not strand a persona
//
// agent-director can leave a persona's row `working` after its turn ended
// (live Check 24). While the row reads `working`, the wait at a launch
// (`waitForWaitingAndReconnect`) and the restart path's reconnect attempts
// (`checkWorkingRowPane`) read the persona's evidence: its pane and, when the
// pane shows an idle screen, its transcript. The row is stale only on the
// positive-idle rule: across STALE_WORKING_WINDOW_MS (60 s), every read shows
// the same idle screen (no spinner, busy hint, API retry row, prompt or
// dialog) AND the same transcript, unchanged, ending with a completed turn. A
// live turn, an API retry or stall included, never ends its transcript that
// way, so it is never typed into, and neither is a prompt or dialog (b.rmy).
// A `waiting` row's pane is read once before a reconnect
// (`checkWaitingRowPane`). A wait that ends with the session alive and nothing
// typed returns 'not-reconnected' and says what happens next; with
// session_restart_delay 0 it raises the not-connected notice, once per
// episode, instead of claiming the health check will reconnect it. At any
// delay, deferrals on a `working` row that run for
// UNPROVEN_IDLE_NOTICE_AFTER_MS raise the unproven-idle notice. A teardown
// cancels a launch's wait (`cancelWorkingRowWait`). The start pass does not
// wait for a launch that waits on a `working` row.
//
// Cases marked REPRO fail on the code before the fix (the stale row was
// trusted for the full 10 minutes, every give-up returned 'ok' and logged
// "health-check will reconnect", and the start pass waited for every launch).
//
// Virtual time: the wait and the evidence read the session manager's clock
// seam, so these cases pass a fake clock's `now` (`useFakeNow`; the top-level
// afterEach resets the seam) and move it themselves: from the stub's status
// poll, one step per poll, or between reconnect attempts. Only the wait's
// poll interval runs in real time (1 ms here, or 60 s where a case shows a
// cancel wakes the wait at once). The start-pass cases that move no time run
// on the real clock.
// ---------------------------------------------------------------------------

/** A fake clock whose `now` the session manager's wait and evidence read (`_setNow`). */
function useFakeNow(): FakeClock {
  const clock = createFakeClock()
  _setNow(clock.now)
  return clock
}

/** One persona `C` whose wait polls every 1 ms; `overrides` go to the whole config. */
function waitConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
  return makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { agent_director_poll_interval_ms: 1, ...overrides })
}

/** A persona's transcript file and the agent-director row fields that name it. */
interface Transcript {
  path: string
  /** The row's persisted `jsonl_path` and its `claude_session_id`. */
  fields: { jsonl_path: string; claude_session_id: string }
}

/** Write `entries` (default: a finished turn) to `<fixtureDir>/transcripts/<session id>.jsonl`; the row fields name it. */
function transcriptOf(entries: TranscriptEntry[] = endedTurn()): Transcript {
  const path = join(fixtureSubdir('transcripts'), `${TRANSCRIPT_SESSION_ID}.jsonl`)
  writeTranscript(path, entries)
  return { path, fields: { jsonl_path: path, claude_session_id: TRANSCRIPT_SESSION_ID } }
}

/** What a persona's row reads at a status poll: a state, or an Error the poll rejects with. */
type RowReading = string | Error

/** What a pane read gives: the screen, or an Error the read rejects with. */
type PaneReading = string | Error

/** Make the stub's pane reads (every persona's) give `pane` from the next read on. */
function showPane(opts: StubClientOptions, pane: PaneReading): void {
  opts.readPaneError = pane instanceof Error ? pane : undefined
  opts.readPaneResults = pane instanceof Error ? undefined : [{ pane }]
}

/** The pane read of persona `key`'s own instance: its last 40 lines. */
function paneReadOf(key: string): import('agent-director').ReadPaneParams {
  return { claude_instance_id: `cscb_${key}`, n_lines: 40 }
}

/** Persona `C`'s agent-director row reading `working`, naming `transcript` (without one: no transcript). */
function workingRowOf(cfg: PersonaConfig, transcript?: Transcript): CannedGetResult {
  return personaRow(cfg, 'C', { state: 'working', ...transcript?.fields })
}

/** The collision fixture for a launch of `C` onto its `working` row. */
function workingCollision(cfg: PersonaConfig, transcript?: Transcript): StubClientOptions {
  return {
    spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
    getResult: workingRowOf(cfg, transcript),
  }
}

/** The stub behind a `working` row, and what was asked of it. */
interface WorkingRow {
  stub: StubClient
  /** The row's reading at each status poll, or a function of the row computing it then. */
  state: RowReading | ((row: WorkingRow) => RowReading)
  /** What the pane shows, set at each status poll: a reading, or a function of the clock's time giving it. */
  pane: PaneReading | ((now: number) => PaneReading)
  /** How far each status poll moves the fake clock, before it answers. */
  stepMs: number
  statusCalls: import('agent-director').StatusParams[]
  readPaneCalls: import('agent-director').ReadPaneParams[]
  getCalls: import('agent-director').GetParams[]
  sendKeysCalls: import('agent-director').SendKeysParams[]
  findMissingCalls: import('agent-director').FindMissingParams[]
  spawnCalls: import('agent-director').SpawnParams[]
}

/**
 * Install a stub client whose status poll moves `clock` by `row.stepMs`, then
 * shows `row.pane` and answers `row.state`. `opts` adds the row `get`
 * answers (`workingRowOf`; the stub's default row names no transcript) and,
 * for a launch, the ladder's collision fixture (`workingCollision`).
 */
function installWorkingRow(
  clock: FakeClock,
  init: Pick<WorkingRow, 'pane' | 'stepMs'> & Partial<Pick<WorkingRow, 'state'>>,
  opts: StubClientOptions = {},
): WorkingRow {
  const calls = {
    statusCalls: [] as WorkingRow['statusCalls'],
    readPaneCalls: [] as WorkingRow['readPaneCalls'],
    getCalls: [] as WorkingRow['getCalls'],
    sendKeysCalls: [] as WorkingRow['sendKeysCalls'],
    findMissingCalls: [] as WorkingRow['findMissingCalls'],
    spawnCalls: [] as WorkingRow['spawnCalls'],
  }
  const stubOpts: StubClientOptions = { ...opts, ...calls }
  const stub = installStub(stubOpts)
  const row: WorkingRow = { stub, state: init.state ?? 'working', pane: init.pane, stepMs: init.stepMs, ...calls }
  const show = (): void => showPane(stubOpts, typeof row.pane === 'function' ? row.pane(clock.now()) : row.pane)
  stubOpts.statusFn = () => {
    const reading = typeof row.state === 'function' ? row.state(row) : row.state
    return reading instanceof Error ? reading : ({ state: reading } as import('agent-director').StatusResult)
  }
  show()
  const answer = stub.status
  stub.status = async (params) => {
    await clock.advance(row.stepMs)
    show()
    return answer(params)
  }
  return row
}

/** The captured log's lines that contain `fragment`. */
function linesWith(log: string, fragment: string): string[] {
  return log.split('\n').filter((line) => line.includes(fragment))
}

const RECONNECT_TEXT = `/mcp reconnect ${MCP_SERVER_NAME}`

/** The blocked-on-prompt notice's follow-up with auto-restart on: true whichever path reconnects the persona (b.f2b). */
const PROMPT_NOTICE_AUTO_RESTART_ON = 'Once it is answered, CSCB reconnects it when it can tell the session is idle again'

/** What the unproven-idle notice says is wrong (b.f2b). */
const UNPROVEN_IDLE_CLAIM = 'its session reads working but CSCB can\'t prove it\'s idle, so it won\'t type into it'

/** A transcript's identity for the pure fold cases (no file behind it). */
const SNAPSHOT: TranscriptSnapshot = { path: `/t/${TRANSCRIPT_SESSION_ID}.jsonl`, dev: 1, ino: 7, size: 4_096, mtimeMs: 1_000 }

/** A transcript read that ended with a completed turn, its snapshot `SNAPSHOT` with `change`. */
function endedReading(change: Partial<TranscriptSnapshot> = {}): { kind: 'ended'; snapshot: TranscriptSnapshot } {
  return { kind: 'ended', snapshot: { ...SNAPSHOT, ...change } }
}

describe('b.f2b: reading a working row\'s pane (classifyWorkingPane, foldWorkingPaneRun)', () => {
  test.each<[string, WorkingPaneReading, string]>([
    ['a real Claude Code idle screen (the finished turn, its summary line, the empty prompt box)', 'idle', IDLE_PANE],
    ['a real Claude Code screen mid-turn (the spinner line: glyph, verb, ellipsis)', 'busy', SPINNER_PANE],
    ['a `*` spinner line (some terminals)', 'busy', withLastLine('* Pondering… (12s)')],
    ['a `●` spinner line (prefersReducedMotion)', 'busy', withLastLine('● Pondering… (12s · ↓ 1.2k tokens)')],
    ['a spinner line with no timer (screen-reader mode)', 'busy', withLastLine('✶ Pondering…')],
    ['a hyphenated verb (`Fiddle-faddling`)', 'busy', withLastLine('✢ Fiddle-faddling… (3s)')],
    ['a status of thinking only', 'busy', withLastLine('✽ Flambéing… (thinking)')],
    ['a custom spinner verb of several words (the spinnerVerbs setting), with its status', 'busy', CUSTOM_VERB_SPINNER_PANE],
    ['a custom spinner verb of several words, before its status shows', 'busy', linuxWithLastLine('· 🐝 Foraging for nectar…')],
    ['a task\'s activeForm as the message', 'busy', linuxWithLastLine('✶ Fixing the nightly build\'s flaky test… (1m 3s · ↑ 2.1k tokens · thought for 3s)')],
    ['a `●` spinner line with a single word and no status yet (prefersReducedMotion)', 'busy', linuxWithLastLine('● Harmonizing…')],
    ['a `●` spinner line with a custom verb and its status (prefersReducedMotion)', 'busy', linuxWithLastLine('● 🐝 Foraging for nectar… (12s · ↓ 1.2k tokens)')],
    ['REPRO: a real Linux idle screen: `●` before every reply and tool call, several with an ellipsis', 'idle', LINUX_IDLE_PANE],
    ['REPRO: a `●` reply that trails off with an ellipsis at the end of its line', 'idle', linuxWithLastLine('● Let me look at the failing job…')],
    ['REPRO: a `●` reply with an ellipsis before a parenthesis that is no status', 'idle', linuxWithLastLine('● Checked the build… (2 jobs left)')],
    ['REPRO: a `●` tool call whose arguments were cut with an ellipsis', 'idle', linuxWithLastLine('● Bash(gh run view 4121 --log-failed …)')],
    ['REPRO: a `●` tool call whose quoted text ends with an ellipsis', 'idle', linuxWithLastLine('● slack-channel-router - reply (MCP)(chat_id: "C0123456789", text: "Looking into it…")')],
    ['a glyph line whose first ellipsis is followed by more text, not the end or a status', 'idle', linuxWithLastLine('✻ Worked… then stopped…')],
    ['"esc to interrupt" (earlier Claude Code versions)', 'busy', withLastLine('  esc to interrupt')],
    ['a rebound interrupt key', 'busy', withLastLine('  ctrl+c to interrupt')],
    ['a turn paused on a usage limit', 'busy', withLastLine('  continuing automatically at 3pm · esc to cancel')],
    ['the no-response retry row', 'busy', withLastLine('  ⎿  No response from the API after 2m · retrying, waiting up to 5m')],
    ['the no-response retry row\'s second line alone', 'busy', withLastLine('     A proxy or gateway that buffers streaming responses can cause this.')],
    ['the rate-limit retry row', 'busy', withLastLine('  ⎿  Rate limit reached · Retrying in 7m (resets 3pm)')],
    ['the waiting-for-response retry row', 'busy', withLastLine('  ⎿  Waiting for API response · will retry in 30s')],
    ['a retry row\'s attempt counter', 'busy', withLastLine('  ⎿  API Error: 529 Overloaded · attempt 3/10')],
    ['a reply that mentions a rate limit, a retry and an attempt, with no `·` separator', 'idle', withLastLine('  The rate limit was reached; retrying in 7m would miss it (attempt 2/3 failed).')],
    ['the spinner text quoted, indented, in a reply', 'idle', withLastLine('  ✳ Harmonizing… (2m 42s)')],
    ['a tool-permission dialog (boxed, its question and deny option)', 'prompt', PERMISSION_PANE],
    ['the plan-approval dialog (only its question anchors it)', 'prompt', PLAN_APPROVAL_PANE],
    ['an AskUserQuestion select menu (only its "Enter to select" footer anchors it)', 'prompt', SELECT_MENU_PANE],
    ['the /model picker (its "Enter to confirm" footer; the cursor on option 2)', 'prompt', MODEL_PICKER_PANE],
    ['the folder trust dialog', 'prompt', TRUST_DIALOG_PANE],
    ['the development channels dialog', 'prompt', DEV_CHANNELS_DIALOG_PANE],
    ['the MCP server dialog (only its box anchors it)', 'prompt', MCP_SERVER_DIALOG_PANE],
    ['a dialog under a running turn\'s spinner (the prompt wins)', 'prompt', `${SPINNER_PANE}\n${PERMISSION_PANE}`],
    ['a reply that quotes a dialog\'s question and options, with no `❯` cursor', 'idle', QUOTED_DIALOG_PANE],
    ['a reply that quotes a menu with its cursor, but no question, footer or box', 'idle', QUOTED_MENU_PANE],
    ['a dialog answered long ago, scrolled above the bottom lines', 'idle', `${PERMISSION_PANE}\n${IDLE_PANE}`],
    ['an empty pane', 'blank', ''],
    ['only spaces and blank lines', 'blank', '   \n\n  \n'],
  ])('%s → %s', (_label, reading, pane) => {
    expect(classifyWorkingPane(pane)).toBe(reading)
  })

  test('an idle run lasts while the screen (trailing spaces and blank lines aside) and the ended transcript are unchanged; a changed screen starts a new run', () => {
    const run = foldWorkingPaneRun(undefined, IDLE_PANE, 1_000, endedReading())
    expect(run).toMatchObject({ reading: 'idle', since: 1_000, transcript: SNAPSHOT })
    const padded = `${IDLE_PANE.split('\n').map((line) => `${line}   `).join('\n')}\n\n`
    expect(foldWorkingPaneRun(run, padded, 5_000, endedReading())).toBe(run)
    expect(foldWorkingPaneRun(run, OTHER_IDLE_PANE, 9_000, endedReading())).toMatchObject({ reading: 'idle', since: 9_000 })
  })

  test.each<[string, Partial<TranscriptSnapshot>]>([
    ['it grew', { size: 5_000 }],
    ['it was written again', { mtimeMs: 2_000 }],
    ['another file took its path', { ino: 8 }],
  ])('an idle run whose transcript changed (%s) starts a new run, though the screen did not', (_label, change) => {
    const run = foldWorkingPaneRun(undefined, IDLE_PANE, 1_000, endedReading())
    const changed = endedReading(change)
    expect(foldWorkingPaneRun(run, IDLE_PANE, 5_000, changed)).toMatchObject({ reading: 'idle', since: 5_000, transcript: changed.snapshot })
  })

  test.each<[string, TranscriptReading | undefined]>([
    ['does not end with a completed turn', { kind: 'open', snapshot: SNAPSHOT }],
    ['can\'t be read', { kind: 'unreadable', reason: 'it is empty' }],
    ['was not read', undefined],
  ])('an idle pane whose transcript %s is no evidence: it ends the run and starts none', (_label, transcript) => {
    const run = foldWorkingPaneRun(undefined, IDLE_PANE, 1_000, endedReading())
    expect(foldWorkingPaneRun(run, IDLE_PANE, 5_000, transcript)).toBeUndefined()
    expect(foldWorkingPaneRun(undefined, IDLE_PANE, 5_000, transcript)).toBeUndefined()
  })

  test.each<[string, string | undefined]>([
    ['a failed read', undefined],
    ['a running turn', SPINNER_PANE],
    ['a blank pane', ''],
  ])('%s ends the run, whatever the transcript: no evidence', (_label, pane) => {
    const run = foldWorkingPaneRun(undefined, IDLE_PANE, 1_000, endedReading())
    expect(foldWorkingPaneRun(run, pane, 5_000, endedReading())).toBeUndefined()
  })

  test('a prompt run lasts across prompt screens that differ, with no transcript read; an idle run and a prompt run never continue each other', () => {
    const prompt: WorkingPaneRun | undefined = foldWorkingPaneRun(undefined, PERMISSION_PANE, 1_000)
    expect(prompt).toMatchObject({ reading: 'prompt', since: 1_000 })
    expect(foldWorkingPaneRun(prompt, SELECT_MENU_PANE, 5_000)).toBe(prompt)
    expect(foldWorkingPaneRun(prompt, IDLE_PANE, 9_000, endedReading())).toMatchObject({ reading: 'idle', since: 9_000 })
    const idle = foldWorkingPaneRun(undefined, IDLE_PANE, 1_000, endedReading())
    expect(foldWorkingPaneRun(idle, PERMISSION_PANE, 9_000, endedReading())).toMatchObject({ reading: 'prompt', since: 9_000 })
  })
})

describe('b.f2b: the restart path\'s evidence for a working row across reconnect attempts (checkWorkingRowPane)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = useFakeNow()
  })

  /**
   * A stub whose pane reads (every persona's) show `first` until `show`
   * changes it (an Error fails the read), and whose `get` answers a `working`
   * row with `fields` (default: naming a finished turn's transcript; null:
   * the stub's default row, which names no transcript).
   */
  function paneStub(first: PaneReading, fields: PersonaGetResultOverrides | null = transcriptOf().fields) {
    const opts: StubClientOptions = { sendKeysCalls: [], readPaneCalls: [], getCalls: [] }
    if (fields !== null) opts.getResult = cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working', ...fields })
    showPane(opts, first)
    installStub(opts)
    return {
      show: (pane: PaneReading) => showPane(opts, pane),
      sendKeysCalls: opts.sendKeysCalls!,
      readPaneCalls: opts.readPaneCalls!,
      getCalls: opts.getCalls!,
    }
  }

  test('the same idle screen and the same ended transcript on attempts spanning 60 s: defer until then, then reconnect; pending until it concludes, forgotten after; every attempt reads C\'s own pane and row; nothing typed, no notice', async () => {
    const stub = paneStub(IDLE_PANE)
    const verdicts: string[] = []
    const pending: boolean[] = []
    const attempt = async (): Promise<void> => {
      verdicts.push(await checkWorkingRowPane('C'))
      pending.push(hasPendingWorkingRowEvidence('C'))
    }
    await attempt()
    await clock.advance(30_000)
    await attempt()
    await clock.advance(STALE_WORKING_WINDOW_MS - 30_000 - 1)
    await attempt()
    await clock.advance(1)
    await attempt()
    // A later attempt starts afresh.
    await attempt()

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'reconnect', 'defer'])
    expect(pending).toEqual([true, true, true, false, true])
    expect(stub.readPaneCalls).toEqual(Array(5).fill(paneReadOf('C')))
    expect(stub.getCalls).toEqual(Array(5).fill({ claude_instance_id: 'cscb_C' }))
    expect(stub.sendKeysCalls).toEqual([])
    expect(notices).toEqual([])
  })

  test('a changed screen restarts the window', async () => {
    const stub = paneStub(IDLE_PANE)
    const verdicts = [await checkWorkingRowPane('C')]
    await clock.advance(40_000)
    stub.show(OTHER_IDLE_PANE)
    verdicts.push(await checkWorkingRowPane('C'))
    await clock.advance(30_000) // 70 s since the first read, 30 s of this screen
    verdicts.push(await checkWorkingRowPane('C'))
    await clock.advance(30_000)
    verdicts.push(await checkWorkingRowPane('C'))

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'reconnect'])
  })

  test('a transcript written to mid-window (the session ran another turn behind the same screen) restarts the window, though it ends with a completed turn again', async () => {
    const transcript = transcriptOf()
    paneStub(IDLE_PANE, transcript.fields)
    const verdicts = [await checkWorkingRowPane('C')]
    await clock.advance(30_000)
    appendTranscript(transcript.path, endedTurn())
    verdicts.push(await checkWorkingRowPane('C'))
    await clock.advance(30_000) // 60 s since the first read, 30 s of this transcript
    verdicts.push(await checkWorkingRowPane('C'))
    await clock.advance(30_000)
    verdicts.push(await checkWorkingRowPane('C'))

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'reconnect'])
  })

  test.each<[string, () => PaneReading]>([
    ['a running turn (its spinner line)', () => SPINNER_PANE],
    ['a blank pane', () => ''],
    ['a failed read', () => errGeneric('read-pane', 'ErrPaneRead', leakyMessage('pane read failed', 'evidence'))],
  ])('%s between idle reads ends the evidence: defer, nothing pending, and the window starts over', async (_label, interruption) => {
    const stub = paneStub(IDLE_PANE)
    const verdicts: string[] = []
    let pendingAfter: boolean | undefined
    const broken = interruption()
    const errLog = await withCapturedErr(async () => {
      verdicts.push(await checkWorkingRowPane('C'))
      await clock.advance(30_000)
      stub.show(broken)
      verdicts.push(await checkWorkingRowPane('C'))
      pendingAfter = hasPendingWorkingRowEvidence('C')
      await clock.advance(30_000) // 60 s since the first idle read: without the break, it would reconnect here
      stub.show(IDLE_PANE)
      verdicts.push(await checkWorkingRowPane('C'))
      await clock.advance(STALE_WORKING_WINDOW_MS)
      verdicts.push(await checkWorkingRowPane('C'))
    })

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'reconnect'])
    expect(pendingAfter).toBe(false)
    expect(stub.sendKeysCalls).toEqual([])
    // A failed read is logged by its errName and redacted message only.
    const failure = `persona=C is working and reading its pane failed: ErrPaneRead message=${JSON.stringify(redactedLeakyMessage('pane read failed'))}`
    expect(linesWith(errLog, failure)).toHaveLength(broken instanceof Error ? 1 : 0)
    assertNoLeak({ errLog })
  })

  test.each<[string, () => PersonaGetResultOverrides | null, string]>([
    ['the prompt, waiting on the API (a retry or a stall with no spinner)', () => transcriptOf([...endedTurn(), promptEntry('post it in #ops')]).fields, 'does not end with a completed turn'],
    ['a tool result, waiting on the API', () => transcriptOf([promptEntry(), toolUseEntry(), toolResultEntry()]).fields, 'does not end with a completed turn'],
    ['a tool call, waiting on its result', () => transcriptOf([promptEntry(), toolUseEntry()]).fields, 'does not end with a completed turn'],
    ['a prompt queued behind the turn', () => transcriptOf([...endedTurn(), queuedPromptEntry()]).fields, 'does not end with a completed turn'],
    ['nothing: the row names no transcript', () => null, 'its transcript can\'t be read: its agent-director row names no transcript for its session'],
    ['nothing: its file is gone', () => { const t = transcriptOf(); rmSync(t.path); return t.fields }, 'opening it failed (ENOENT)'],
  ])('b.rmy: the same still, idle screen for minutes while the transcript shows %s is no evidence: every attempt defers and logs why, nothing is pending or typed', async (_label, fields, why) => {
    const stub = paneStub(IDLE_PANE, fields())
    const verdicts: string[] = []
    const errLog = await withCapturedErr(async () => {
      for (let i = 0; i < 4; i++) {
        if (i > 0) await clock.advance(STALE_WORKING_WINDOW_MS)
        verdicts.push(await checkWorkingRowPane('C'))
      }
    })

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'defer'])
    expect(hasPendingWorkingRowEvidence('C')).toBe(false)
    expect(stub.sendKeysCalls).toEqual([])
    expect(linesWith(errLog, 'persona=C is working and its pane shows an idle screen, but').filter((line) => line.includes(why))).toHaveLength(4)
  })

  test('a fresh session\'s row (no persisted transcript path) is read through the transcript composed under the persona\'s claude_config_dir; without the persona nothing is found and the evidence ends', async () => {
    const configDir = fixtureSubdir('persona-claude')
    const cwd = '/work/nightly bot'
    const composed = resolveJsonlPath(cwd, TRANSCRIPT_SESSION_ID, configDir)
    mkdirSync(join(composed, '..'), { recursive: true })
    writeTranscript(composed, endedTurn())
    paneStub(IDLE_PANE, { claude_session_id: TRANSCRIPT_SESSION_ID, cwd })
    const persona = { claude_config_dir: configDir }

    const verdicts = [await checkWorkingRowPane('C', persona)]
    await clock.advance(STALE_WORKING_WINDOW_MS)
    verdicts.push(await checkWorkingRowPane('C', persona))
    verdicts.push(await checkWorkingRowPane('C'))

    expect(verdicts).toEqual(['defer', 'reconnect', 'defer'])
    expect(hasPendingWorkingRowEvidence('C')).toBe(false)
  })

  test('a prompt: every attempt defers and nothing is typed; once shown on attempts spanning 60 s, one blocked-on-prompt notice for the episode; never pending evidence', async () => {
    const stub = paneStub(PERMISSION_PANE)
    const verdicts = [await checkWorkingRowPane('C')]
    expect(notices).toEqual([])
    for (let i = 0; i < 3; i++) {
      await clock.advance(STALE_WORKING_WINDOW_MS)
      verdicts.push(await checkWorkingRowPane('C'))
    }

    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'defer'])
    expect(hasPendingWorkingRowEvidence('C')).toBe(false)
    expect(stub.sendKeysCalls).toEqual([])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
    expect(notices[0]!.text).toContain('`tmux attach -t =slack_bot_C`')
  })

  test('forgetNotConnectedEpisode(key) ends only that persona\'s episode: its evidence and notice latch go, another persona\'s stay', async () => {
    paneStub(IDLE_PANE)
    await checkWorkingRowPane('K')
    await checkWorkingRowPane('L')
    const notice = { reason: 'auto-restart-disabled', cause: 'a test cause' } as const
    expect([notifyPersonaNotConnected('K', notice), notifyPersonaNotConnected('L', notice)]).toEqual([true, true])

    forgetNotConnectedEpisode('K')

    expect([hasPendingWorkingRowEvidence('K'), hasPendingWorkingRowEvidence('L')]).toEqual([false, true])
    // K's next episode is reported again; L's is still the same one.
    expect([notifyPersonaNotConnected('K', notice), notifyPersonaNotConnected('L', notice)]).toEqual([true, false])
    expect(notices.map((n) => n.key)).toEqual(['K', 'L', 'K'])
  })

  test('any launch for the persona forgets its evidence: the session it brings up says nothing about the old row', async () => {
    const cfg = waitConfig()
    paneStub(IDLE_PANE)
    await checkWorkingRowPane('C')
    expect(hasPendingWorkingRowEvidence('C')).toBe(true)

    expect((await spawnForPersona(personaOf(cfg, 'C'), cfg, false)).action).toBe('spawned')

    expect(hasPendingWorkingRowEvidence('C')).toBe(false)
  })
})

describe('b.f2b: the restart path\'s check of a waiting row\'s pane before it reconnects (checkWaitingRowPane)', () => {
  /** A stub whose pane reads show `pane` (an Error fails the read). */
  function paneOnly(pane: PaneReading): StubClientOptions & { readPaneCalls: import('agent-director').ReadPaneParams[]; sendKeysCalls: import('agent-director').SendKeysParams[] } {
    const opts = { readPaneCalls: [], sendKeysCalls: [] } as StubClientOptions & { readPaneCalls: import('agent-director').ReadPaneParams[]; sendKeysCalls: import('agent-director').SendKeysParams[] }
    showPane(opts, pane)
    installStub(opts)
    return opts
  }

  test.each<[string, 'reconnect' | 'defer', () => PaneReading, string | undefined]>([
    ['an idle screen', 'reconnect', () => IDLE_PANE, undefined],
    ['REPRO: a Linux idle screen, `●` before its replies and tool calls, several with an ellipsis', 'reconnect', () => LINUX_IDLE_PANE, undefined],
    ['a blank pane', 'reconnect', () => '', undefined],
    ['a running turn (its spinner line)', 'defer', () => SPINNER_PANE, 'persona=C is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick'],
    ['a running turn with a custom spinner verb of several words', 'defer', () => CUSTOM_VERB_SPINNER_PANE, 'persona=C is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick'],
    ['an API retry row', 'defer', () => withLastLine('  ⎿  Waiting for API response · will retry in 30s'), 'persona=C is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick'],
    ['a failed read (the waiting row alone decides)', 'reconnect', () => errGeneric('read-pane', 'ErrPaneRead', leakyMessage('pane read failed', 'waiting')), `persona=C is waiting and reading its pane failed: ErrPaneRead message=${JSON.stringify(redactedLeakyMessage('pane read failed'))} — reconnecting on the waiting row alone`],
  ])('%s → %s: C\'s own pane read once, nothing typed here, no notice, one line unless it goes ahead plainly', async (_label, verdict, pane, line) => {
    const opts = paneOnly(pane())
    let got: string | undefined
    const errLog = await withCapturedErr(async () => {
      got = await checkWaitingRowPane('C')
    })

    expect(got).toBe(verdict)
    expect(opts.readPaneCalls).toEqual([paneReadOf('C')])
    expect(opts.sendKeysCalls).toEqual([])
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'persona=C is waiting')).toEqual(line === undefined ? [] : [expect.stringContaining(line)])
    assertNoLeak({ errLog })
  })

  test('a prompt or dialog → defer on every call and never typed into; one blocked-on-prompt notice for the episode, saying CSCB reconnects it once it can tell the session is idle again', async () => {
    const opts = paneOnly(PERMISSION_PANE)
    let verdicts: string[] = []
    const errLog = await withCapturedErr(async () => {
      verdicts = [await checkWaitingRowPane('C'), await checkWaitingRowPane('C')]
    })

    expect(verdicts).toEqual(['defer', 'defer'])
    expect(opts.sendKeysCalls).toEqual([])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
    expect(notices[0]!.text).toContain(PROMPT_NOTICE_AUTO_RESTART_ON)
    expect(notices[0]!.text).not.toContain('Once its turn ends it is reconnected')
    expect(linesWith(errLog, 'persona=C is waiting but its pane shows a prompt or dialog — not typing into it')).toHaveLength(2)
  })
})

describe('b.f2b: the not-connected notice, once per episode', () => {
  test.each<[string, NotConnectedNotice, string, string]>([
    ['blocked on a prompt, auto-restart on', { reason: 'blocked-on-prompt', autoRestartDisabled: false }, ':warning: *Waiting on a prompt*', PROMPT_NOTICE_AUTO_RESTART_ON],
    ['blocked on a prompt, session_restart_delay 0', { reason: 'blocked-on-prompt', autoRestartDisabled: true }, ':warning: *Waiting on a prompt*', 'Automatic restarts are disabled'],
    ['a working row whose idleness can\'t be proven, auto-restart on', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 12 * 60_000 }, ':warning: *Not connected*', `${UNPROVEN_IDLE_CLAIM}, and has held back for 12 min`],
    ['a working row whose idleness can\'t be proven, auto-restart on (what happens next)', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 12 * 60_000 }, ':warning: *Not connected*', 'CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle'],
    ['a working row whose idleness can\'t be proven, session_restart_delay 0', { reason: 'unproven-idle', autoRestartDisabled: true, heldMs: 10 * 60_000 }, ':warning: *Not connected*', 'Automatic restarts are disabled (`session_restart_delay` is 0), so nothing will reconnect it on its own'],
    ['disconnected, session_restart_delay 0', { reason: 'auto-restart-disabled', cause: 'a test cause' }, ':warning: *Not connected*', '(a test cause), and automatic restarts are disabled'],
    ['connected with its message stream gone, session_restart_delay 0', { reason: 'auto-restart-disabled', cause: 'a test cause', streamless: true }, ':warning: *Not receiving messages*', 'its message stream is gone (a test cause), and automatic restarts are disabled'],
  ])('%s: raised once, one log line; its first line says what is wrong, the second how to recover (attaching by the exact session name, b.1ix); a second call in the episode raises nothing', async (_label, notice, head, detail) => {
    let raised: boolean[] = []
    const errLog = await withCapturedErr(() => {
      raised = [notifyPersonaNotConnected('C', notice), notifyPersonaNotConnected('C', notice)]
    })

    expect(raised).toEqual([true, false])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    const [first, second, ...rest] = notices[0]!.text.split('\n')
    expect(rest).toEqual([])
    expect(first).toStartWith(head)
    expect(notices[0]!.text).toContain(detail)
    expect(second).toContain('`tmux attach -t =slack_bot_C`')
    // A bare target would attach to a prefix neighbour (`slack_bot_C_2`) once `slack_bot_C` is gone.
    expect(notices[0]!.text).not.toContain('attach -t slack_bot_')
    expect(second).toContain(`\`${RECONNECT_TEXT}\``)
    expect(linesWith(errLog, `persona=C is not connected (${notice.reason})`)).toHaveLength(1)
  })

  test.each<[UndeliverableCause | undefined, string, string]>([
    [undefined, ':warning: *Not connected*', '(its connection has been down on two health checks in a row)'],
    ['disconnected', ':warning: *Not connected*', '(its connection has been down on two health checks in a row)'],
    ['streamless', ':warning: *Not receiving messages*', 'its message stream is gone (found on two health checks in a row)'],
  ])('the health check\'s report (notifyDisconnectedWithAutoRestartDisabled) for cause %s: the notice worded for it, once per episode', (cause, head, detail) => {
    notifyDisconnectedWithAutoRestartDisabled('C', cause)
    notifyDisconnectedWithAutoRestartDisabled('C', cause)

    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(head)
    expect(notices[0]!.text).toContain(detail)
  })
})

// b.f2b: at any restart delay, CSCB holding back from a `working` row it can't
// prove idle is bounded: once its deferrals on the row have run for
// UNPROVEN_IDLE_NOTICE_AFTER_MS (10 min) from the first, the unproven-idle
// not-connected notice is raised, once per episode through the shared latch.
// Before it, a row whose idleness could never be proven (an unreadable
// transcript, a compaction summary, a screen that keeps changing) was held
// back from for good at a non-zero delay, and nothing reported it.
describe('b.f2b: a working row whose idleness can\'t be proven is reported (unproven-idle)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = useFakeNow()
  })

  /** Minutes on the fake clock. */
  const min = (n: number): number => n * 60_000

  /**
   * A stub for persona C's `working` row: its pane reads show `pane` until
   * `show` changes it (an Error fails the read), and its `get` names
   * `transcript` (without one, the row names no transcript).
   */
  function rowStub(pane: PaneReading, transcript?: Transcript) {
    const opts: StubClientOptions = { sendKeysCalls: [], readPaneCalls: [], getCalls: [] }
    opts.getResult = cannedGetResult({ claude_instance_id: 'cscb_C', state: 'working', ...transcript?.fields })
    showPane(opts, pane)
    installStub(opts)
    return { show: (next: PaneReading) => showPane(opts, next), sendKeysCalls: opts.sendKeysCalls! }
  }

  /** Restart-path attempts on C's row at each of `at` (minutes on the fake clock, ascending); the verdicts and the notices raised by each. */
  async function attemptsAt(at: number[], before?: (minute: number) => void): Promise<{ verdicts: string[]; noticesAfter: number[] }> {
    const verdicts: string[] = []
    const noticesAfter: number[] = []
    for (const minute of at) {
      await clock.advance(min(minute) - clock.now())
      before?.(minute)
      verdicts.push(await checkWorkingRowPane('C'))
      noticesAfter.push(notices.length)
    }
    return { verdicts, noticesAfter }
  }

  test('the run is measured from its first deferral: nothing 1 ms short of UNPROVEN_IDLE_NOTICE_AFTER_MS, the notice at it, then nothing more in the episode; ending the run starts a new one', async () => {
    const raised: boolean[] = []
    await clock.advance(5_000)
    raised.push(noteWorkingRowDeferral('C', false)) // the run starts at 5 s
    await clock.advance(UNPROVEN_IDLE_NOTICE_AFTER_MS - 1)
    raised.push(noteWorkingRowDeferral('C', false))
    await clock.advance(1)
    raised.push(noteWorkingRowDeferral('C', false))
    await clock.advance(min(5))
    raised.push(noteWorkingRowDeferral('C', false))
    // Another persona's run is its own.
    raised.push(noteWorkingRowDeferral('D', false))

    expect(UNPROVEN_IDLE_NOTICE_AFTER_MS).toBe(min(10))
    expect(raised).toEqual([false, false, true, false, false])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(':warning: *Not connected*')
    expect(notices[0]!.text).toContain(`${UNPROVEN_IDLE_CLAIM}, and has held back for 10 min`)

    // A new episode: a run ended and started again is measured afresh.
    forgetNotConnectedEpisode('C')
    expect(noteWorkingRowDeferral('C', true)).toBe(false)
    await clock.advance(min(9))
    endWorkingRowDeferral('C')
    expect(noteWorkingRowDeferral('C', true)).toBe(false)
    await clock.advance(min(9))
    expect(noteWorkingRowDeferral('C', true)).toBe(false)
    await clock.advance(min(1))
    expect(noteWorkingRowDeferral('C', true)).toBe(true)
    expect(notices.map((n) => n.key)).toEqual(['C', 'C'])
    expect(notices[1]!.text).toContain('Automatic restarts are disabled (`session_restart_delay` is 0), so nothing will reconnect it on its own')
  })

  test.each<[string, () => { pane: PaneReading | ((minute: number) => PaneReading); transcript?: Transcript }]>([
    ['REPRO: an idle screen whose row names no transcript (unreadable)', () => ({ pane: IDLE_PANE })],
    ['REPRO: an idle screen whose transcript ends with a compaction summary', () => ({
      pane: IDLE_PANE,
      transcript: transcriptOf([...endedTurn(), { ...promptEntry('This session is being continued from a previous conversation that ran out of context.'), isCompactSummary: true }]),
    })],
    ['REPRO: an idle screen that changes at every attempt, its transcript ended', () => ({
      pane: (minute) => (minute % 8 === 0 ? IDLE_PANE : OTHER_IDLE_PANE),
      transcript: transcriptOf(),
    })],
    ['a turn that keeps running (its spinner line)', () => ({ pane: SPINNER_PANE, transcript: transcriptOf() })],
    ['a pane that can\'t be read', () => ({ pane: errGeneric('read-pane', 'ErrPaneRead', 'pane read failed') })],
  ])('%s: restart-path attempts 4 min apart defer with nothing typed; the attempt 12 min after the first raises one unproven-idle notice, worded for auto-restart on; later attempts raise nothing more', async (_label, make) => {
    const { pane, transcript } = make()
    const stub = rowStub(typeof pane === 'function' ? pane(0) : pane, transcript)
    let result!: { verdicts: string[]; noticesAfter: number[] }
    const errLog = await withCapturedErr(async () => {
      result = await attemptsAt([0, 4, 8, 12, 16], (minute) => {
        if (typeof pane === 'function') stub.show(pane(minute))
      })
    })

    expect(result.verdicts).toEqual(Array(5).fill('defer'))
    expect(stub.sendKeysCalls).toEqual([])
    expect(result.noticesAfter).toEqual([0, 0, 0, 1, 1])
    expect(notices[0]!.key).toBe('C')
    expect(notices[0]!.text).toStartWith(':warning: *Not connected*')
    expect(notices[0]!.text).toContain(`${UNPROVEN_IDLE_CLAIM}, and has held back for 12 min`)
    expect(notices[0]!.text).toContain('CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle')
    const [, second] = notices[0]!.text.split('\n')
    expect(second).toContain('`tmux attach -t =slack_bot_C`')
    expect(second).toContain(`\`${RECONNECT_TEXT}\``)
    expect(linesWith(errLog, 'persona=C is not connected (unproven-idle) — raising a not-connected notice')).toHaveLength(1)
  })

  test('a reconnect on idle proof ends the run: deferrals after it are measured from their own first', async () => {
    const transcript = transcriptOf()
    rmSync(transcript.path) // unreadable at first
    rowStub(IDLE_PANE, transcript)
    const { verdicts, noticesAfter } = await attemptsAt([0, 3, 6, 9, 10, 11, 15, 19, 21], (minute) => {
      if (minute === 9) writeTranscript(transcript.path, endedTurn())
      if (minute === 11) rmSync(transcript.path)
    })

    // Proof from 9 min, held for the 60 s window at 10 min: the reconnect; the
    // run that follows starts at 11 min and is reported at 21 min.
    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'defer', 'reconnect', 'defer', 'defer', 'defer', 'defer'])
    expect(noticesAfter).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(notices[0]!.text).toContain('has held back for 10 min')
  })

  test('a prompt reported first holds the episode\'s one notice: the run passing 10 min raises nothing more', async () => {
    const stub = rowStub(PERMISSION_PANE)
    const { verdicts, noticesAfter } = await attemptsAt([0, 2, 6, 10, 14])

    expect(verdicts).toEqual(Array(5).fill('defer'))
    expect(stub.sendKeysCalls).toEqual([])
    expect(noticesAfter).toEqual([0, 1, 1, 1, 1])
    expect(notices[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
  })

  test('any launch for the persona starts a new run: deferrals before it don\'t count toward the notice', async () => {
    const cfg = waitConfig()
    rowStub(IDLE_PANE)
    await checkWorkingRowPane('C')
    await clock.advance(min(9))
    expect((await spawnForPersona(personaOf(cfg, 'C'), cfg, false)).action).toBe('spawned')

    const { noticesAfter } = await attemptsAt([10, 14, 18, 19, 20])

    expect(noticesAfter).toEqual([0, 0, 0, 0, 1])
  })

  test.each<[number, string]>([
    [60, 'CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle'],
    [0, 'Automatic restarts are disabled (`session_restart_delay` is 0), so nothing will reconnect it on its own'],
  ])('a launch wait (session_restart_delay %d) on a working row it can\'t prove idle reports it mid-wait once the run has lasted the bound (3 min here), goes on waiting, and raises nothing more at the deadline; nothing typed', async (delay, wording) => {
    _setUnprovenIdleNoticeAfterMs(min(3))
    const cfg = waitConfig({ session_restart_delay: delay })
    const row = installWorkingRow(clock, { pane: IDLE_PANE, stepMs: 30_000 }, { getResult: workingRowOf(cfg) })
    const raisedAt: number[] = []
    setSessionNotifier((key, text, options) => {
      notices.push({ key, text, options })
      raisedAt.push(clock.now())
    })

    let result: string | undefined
    await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('not-reconnected')
    expect(row.sendKeysCalls).toEqual([])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    // The first poll (30 s) starts the run; the poll at 3 min 30 s reports it.
    expect(raisedAt).toEqual([30_000 + min(3)])
    expect(clock.now()).toBeGreaterThanOrEqual(WAIT_FOR_WAITING_TIMEOUT_MS)
    expect(notices[0]!.text).toContain(`${UNPROVEN_IDLE_CLAIM}, and has held back for 3 min`)
    expect(notices[0]!.text).toContain(wording)
  })
})

describe('b.f2b: the wait for a working row at a launch (waitForWaitingAndReconnect)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = useFakeNow()
  })

  test.each([60, 0])('REPRO: a stale working row at startup, its pane showing the same idle screen and its transcript ending with a completed turn, both unchanged, is reconnected once that has held for 60 s, not after the 10-minute wait (session_restart_delay %d); every read is of C\'s own pane and row', async (delay) => {
    const cfg = waitConfig({ session_restart_delay: delay })
    const row = installWorkingRow(clock, { pane: IDLE_PANE, stepMs: 10_000 }, workingCollision(cfg, transcriptOf()))

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'reconnected' })
    expect(row.sendKeysCalls.map((c) => [c.claude_instance_id, c.text])).toEqual([['cscb_C', RECONNECT_TEXT]])
    expect(clock.now()).toBeGreaterThanOrEqual(STALE_WORKING_WINDOW_MS)
    expect(clock.now()).toBeLessThan(STALE_WORKING_WINDOW_MS + 30_000)
    expect(row.readPaneCalls.length).toBeGreaterThan(0)
    expect(row.readPaneCalls).toEqual(row.readPaneCalls.map(() => paneReadOf('C')))
    // The ladder's collision lookup, then one row read per idle pane for its transcript.
    expect(row.getCalls).toEqual(Array(row.readPaneCalls.length + 1).fill({ claude_instance_id: 'cscb_C' }))
    expect(notices).toEqual([])
    expect(linesWith(errLog, 'treating the row as stale and reconnecting')).toHaveLength(1)
  })

  test('the wait reads the evidence at most every 5 s, not on each status poll: polled every second, the stale row is reconnected at the read that completes the 60 s', async () => {
    const cfg = waitConfig()
    const row = installWorkingRow(clock, { pane: IDLE_PANE, stepMs: 1_000 }, { getResult: workingRowOf(cfg, transcriptOf()) })

    expect(await waitForWaitingAndReconnect('C', cfg)).toBe('ok')

    // Polls at 1 s, 2 s, …, 61 s; reads at 1 s, 6 s, …, 61 s: the run from 1 s concludes at 61 s.
    expect(clock.now()).toBe(61_000)
    expect(row.statusCalls).toHaveLength(61)
    expect(row.readPaneCalls).toHaveLength(13)
    expect(row.getCalls).toHaveLength(13)
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
  })

  test('the composed route: a fresh session\'s row (no persisted transcript path) is read through the transcript under the persona\'s claude_config_dir (its spawn home\'s .claude here), and reconnected', async () => {
    const cfg = waitConfig()
    const persona = personaOf(cfg, 'C')
    const configDir = join(ladderHome(), '.claude')
    const composed = resolveJsonlPath(persona.working_directory, TRANSCRIPT_SESSION_ID, configDir)
    mkdirSync(join(composed, '..'), { recursive: true })
    writeTranscript(composed, endedTurn())
    const row = installWorkingRow(clock, { pane: IDLE_PANE, stepMs: 10_000 }, {
      getResult: personaRow(cfg, 'C', { state: 'working', claude_session_id: TRANSCRIPT_SESSION_ID }),
    })

    expect(await waitForWaitingAndReconnect('C', cfg)).toBe('ok')
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
  })

  test('a running turn mid-window (idle → spinner → idle): nothing is typed until the idle evidence has held for a full window after it', async () => {
    const cfg = waitConfig()
    const row = installWorkingRow(clock, {
      pane: (now) => (now === 35_000 ? SPINNER_PANE : IDLE_PANE),
      stepMs: 5_000,
    }, { getResult: workingRowOf(cfg, transcriptOf()) })

    expect(await waitForWaitingAndReconnect('C', cfg)).toBe('ok')

    // Idle from 5 s, the spinner at 35 s, idle again from 40 s: typed at 100 s, not at 65 s.
    expect(clock.now()).toBe(40_000 + STALE_WORKING_WINDOW_MS)
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
  })

  test('b.rmy: a stalled turn (an API retry or stall drawn with no spinner) — the same still, idle screen for the whole 10 minutes, its transcript ending with the prompt — is never typed into: not-reconnected, and why is logged once', async () => {
    const cfg = waitConfig()
    const row = installWorkingRow(clock, { pane: IDLE_PANE, stepMs: 60_000 }, {
      getResult: workingRowOf(cfg, transcriptOf([...endedTurn(), promptEntry('post it in #ops')])),
    })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('not-reconnected')
    expect(row.sendKeysCalls).toEqual([])
    expect(clock.now()).toBeGreaterThanOrEqual(WAIT_FOR_WAITING_TIMEOUT_MS)
    expect(row.readPaneCalls.length).toBeGreaterThan(5)
    expect(linesWith(errLog, 'does not end with a completed turn — no idle evidence; still waiting for its working row')).toHaveLength(1)
  })

  test('REPRO: a row that reads waiting at the deadline is reconnected, not left to the health check', async () => {
    _setFindMissingMemoTtlMs(0) // the deadline's fresh sweep is the second findMissing
    const row = installWorkingRow(clock, {
      pane: SPINNER_PANE,
      stepMs: 60_000,
      state: (r) => (r.findMissingCalls.length >= 2 ? 'waiting' : 'working'),
    })

    const result = await waitForWaitingAndReconnect('C', waitConfig())

    expect(result).toBe('ok')
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
    expect(clock.now()).toBeGreaterThanOrEqual(WAIT_FOR_WAITING_TIMEOUT_MS)
  })

  /**
   * The wait's give-ups with the session alive (tmux alive, the suite's
   * default prober): how the stub makes each, the head and detail of the
   * notice at session_restart_delay 0, and the detail of the notice at
   * session_restart_delay 60, if any: only the deadline on a `working` row,
   * held back from for 10 min, raises one then (unproven-idle). The deadline's
   * status call fails only after the deadline's fresh sweep (memo TTL 0: two
   * sweeps per wait).
   */
  const GIVE_UPS: Array<[string, Pick<WorkingRow, 'pane' | 'stepMs' | 'state'>, string, string, string | undefined]> = [
    [
      'the deadline, with the row still working and its pane mid-turn',
      { state: 'working', pane: SPINNER_PANE, stepMs: 60_000 },
      ':warning: *Not connected*',
      `${UNPROVEN_IDLE_CLAIM}, and has held back for 10 min`,
      'CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle',
    ],
    ['the row moving to ask_user', { state: 'ask_user', pane: IDLE_PANE, stepMs: 1_000 }, ':warning: *Waiting on a prompt*', 'Automatic restarts are disabled (`session_restart_delay` is 0)', undefined],
    ['agent-director losing the row while its tmux session lives', { state: errSpawnNotFound(), pane: IDLE_PANE, stepMs: 1_000 }, ':warning: *Not connected*', '(agent-director has no record of its session, though its tmux session is alive)', undefined],
    [
      // Only ErrSpawnNotFound at the deadline still reaches the tmux fallback;
      // any other read error, a CONFIG answer included (b.jg5 SRJ-316), is a
      // refusal (b.jg5 SRJ-105, the case after these), and an UNUSABLE NAME
      // answer latches the persona (b.jg5 SRJ-512, the case after that).
      'the deadline\'s status call answering ErrSpawnNotFound while its tmux session lives (the tmux fallback)',
      { state: (r) => (r.findMissingCalls.length % 2 === 0 ? errSpawnNotFound() : 'working'), pane: SPINNER_PANE, stepMs: 60_000 },
      ':warning: *Not connected*',
      '(agent-director could not report its state when CSCB stopped waiting for it, 10 min after launching it)',
      undefined,
    ],
  ]

  test.each(GIVE_UPS)('REPRO: session_restart_delay 0 and %s → not-reconnected with nothing typed; the log says nothing will reconnect it, and one not-connected notice saying why is raised for the episode', async (_label, init, head, detail) => {
    _setFindMissingMemoTtlMs(0)
    const cfg = waitConfig({ session_restart_delay: 0 })
    const row = installWorkingRow(clock, init)

    const results: string[] = []
    const errLog = await withCapturedErr(async () => {
      results.push(await waitForWaitingAndReconnect('C', cfg))
      // A second give-up in the same episode raises nothing more.
      results.push(await waitForWaitingAndReconnect('C', cfg))
    })

    expect(results).toEqual(['not-reconnected', 'not-reconnected'])
    expect(row.sendKeysCalls).toEqual([])
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(head)
    expect(notices[0]!.text).toContain(detail)
    expect(linesWith(errLog, 'session_restart_delay is 0, so nothing will reconnect it — the not-connected notice reports it')).toHaveLength(2)
    expect(errLog).not.toContain('health-check will')
    expect(errLog).not.toMatch(/; the health check (recovers|reconnects|reads|schedules) /)
  })

  test.each(GIVE_UPS)('session_restart_delay 60 and %s → not-reconnected with nothing typed; the log says what the health check does next; a notice only for a working row held back from for 10 min (unproven-idle)', async (_label, init, head, _detail, delay60Detail) => {
    _setFindMissingMemoTtlMs(0)
    const cfg = waitConfig({ session_restart_delay: 60 })
    const row = installWorkingRow(clock, init)

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('not-reconnected')
    expect(row.sendKeysCalls).toEqual([])
    if (delay60Detail === undefined) {
      expect(notices).toEqual([])
    } else {
      expect(notices.map((n) => n.key)).toEqual(['C'])
      expect(notices[0]!.text).toStartWith(head)
      expect(notices[0]!.text).toContain(UNPROVEN_IDLE_CLAIM)
      expect(notices[0]!.text).toContain(delay60Detail)
      expect(notices[0]!.text).not.toContain('Automatic restarts are disabled')
      expect(linesWith(errLog, 'persona=C is not connected (unproven-idle) — raising a not-connected notice')).toHaveLength(1)
    }
    expect(errLog).not.toContain('nothing will reconnect it')
    expect(errLog).toMatch(/; the health check (recovers|reconnects|reads|schedules) /)
  })

  /**
   * The deadline's status errors that are a refusal, each with the outage it
   * raises for C: an UNCLASSIFIED error raises none; a CONFIG answer raises
   * `ad-config-malformed` (b.jg5 SRJ-316), once for the episode.
   */
  const DEADLINE_REFUSALS: ReadonlyArray<readonly [string, () => Error, OutageClass[]]> = [
    ['an UNCLASSIFIED error (ErrTimeout)', () => errGeneric('status', 'ErrTimeout'), []],
    ['a CONFIG answer (ErrConfigMalformed, b.jg5 SRJ-316)', () => errConfigMalformed(), ['ad-config-malformed']],
  ]

  test.each(DEADLINE_REFUSALS.flatMap(([what, make, flags]) => [0, 60].map((delay) => [delay, what, make, flags] as const)))('b.jg5 SRJ-105: session_restart_delay %d and the deadline\'s status call failing with %s while its tmux session lives → failed, never the tmux fallback: nothing typed, no notice for the deadline\'s read (only the poll\'s unproven-idle one, once), one refusal line per wait', async (delay, _what, make, flags) => {
    _setFindMissingMemoTtlMs(0)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const cfg = waitConfig({ session_restart_delay: delay })
    const err = make()
    const row = installWorkingRow(clock, {
      state: (r) => (r.findMissingCalls.length % 2 === 0 ? err : 'working'),
      pane: SPINNER_PANE,
      stepMs: 60_000,
    })

    const results: string[] = []
    const errLog = await withCapturedErr(async () => {
      results.push(await waitForWaitingAndReconnect('C', cfg))
      results.push(await waitForWaitingAndReconnect('C', cfg))
    })

    expect(results).toEqual(['failed', 'failed'])
    expect(row.sendKeysCalls).toEqual([])
    expect(probed).toEqual([])
    // The polls held back from the `working` row for 10 min, which raises the
    // unproven-idle notice once for the episode; the deadline's failed read
    // adds no notice (not the tmux fallback's "could not report its state").
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toContain(UNPROVEN_IDLE_CLAIM)
    expect(notices[0]!.text).not.toContain('could not report its state')
    expect(linesWith(errLog, 'waitForWaitingAndReconnect: timeout: status read refused for persona=C')).toHaveLength(2)
    expect(errLog).not.toContain('nothing will reconnect it')
    // The second wait's successful polls clear the outage the first raised
    // (b.jg5 SRJ-312), so each wait's CONFIG read posts its own onset, with
    // one all-clear listing the bare class between them.
    expect([...getOutageFlags('C')]).toEqual(flags)
    const allClear = ALL_CLEAR_TEMPLATE(new Map(flags.map((cls) => [cls, { detail: undefined }])))
    expect(outageEmissions).toEqual(
      flags.length === 0 ? [] : [adConfigMalformedOnset(err), allClear, adConfigMalformedOnset(err)].map((text) => ({ key: 'C', text })),
    )
  })

  // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer at the deadline's status
  // call latches C (unreadable) and ends the wait latched: never the tmux
  // fallback, nothing typed, and no notice for the deadline's read (only the
  // poll's unproven-idle one at delay 0, as for a refusal); nothing is called
  // after the read. A pane read answering UNUSABLE NAME on the first poll
  // latches C with the state the poll read (working) and ends the wait there,
  // though the next poll would read waiting: no further poll, nothing typed.
  test.each([0, 60])('b.jg5 SRJ-105, SRJ-512: session_restart_delay %d and the deadline\'s status call answering UNUSABLE NAME while its tmux session lives → latched, never the tmux fallback: C latched (unreadable), nothing typed, tmux not probed, no call after the read', async (delay) => {
    _setFindMissingMemoTtlMs(0)
    const latch = createConflictLatch({ log: () => {} })
    setConflictLatch(latch)
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })
    const row = installWorkingRow(clock, {
      state: (r) => (r.findMissingCalls.length % 2 === 0 ? errUnusableName('stored-differently') : 'working'),
      pane: SPINNER_PANE,
      stepMs: 60_000,
    })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', waitConfig({ session_restart_delay: delay }))
    })

    expect(result).toBe(WAIT_OUTCOME_LATCHED)
    expect(row.sendKeysCalls).toEqual([])
    expect(probed).toEqual([])
    expect(row.findMissingCalls).toHaveLength(2)
    const statusCallsAtLatch = row.statusCalls.length
    expect(latch.record('C')).toMatchObject({ latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME, rowState: LATCH_ROW_STATE_UNREADABLE })
    expect(notices.filter((n) => n.text.includes('could not report its state'))).toEqual([])
    expect(linesWith(errLog, ' — UNUSABLE NAME: the persona latched; ')).toHaveLength(1)
    expect(linesWith(errLog, 'refused for persona=C')).toEqual([])
    // A later wait for the latched persona makes no call at all.
    expect(await waitForWaitingAndReconnect('C', waitConfig({ session_restart_delay: delay }))).toBe(WAIT_OUTCOME_LATCHED)
    expect(row.statusCalls).toHaveLength(statusCallsAtLatch)
    expect(row.findMissingCalls).toHaveLength(2)
    assertNoLeak({ errLog, notices })
  })

  test('b.jg5 SRJ-117, SRJ-512: the first poll\'s pane read answering UNUSABLE NAME latches C with the state that poll read (working) and ends the wait latched: no second poll though the row would read waiting, no transcript get, nothing typed, no notice', async () => {
    const latch = createConflictLatch({ log: () => {} })
    setConflictLatch(latch)
    const row = installWorkingRow(clock, {
      state: (r) => (r.statusCalls.length > 1 ? 'waiting' : 'working'),
      pane: errUnusableName('control-character'),
      stepMs: 1_000,
    })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', waitConfig())
    })

    expect(result).toBe(WAIT_OUTCOME_LATCHED)
    expect(row.statusCalls).toHaveLength(1)
    expect(row.readPaneCalls).toEqual([paneReadOf('C')])
    expect(row.getCalls).toEqual([])
    expect(row.sendKeysCalls).toEqual([])
    expect(latch.record('C')).toMatchObject({ latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME, refusedOperation: REFUSED_OPERATION_NONE, rowState: latchRowStateRead('working') })
    expect(notices).toEqual([])
    expect(linesWith(errLog, '[slack] readWorkingPane: pane read refused for persona=C: ')).toHaveLength(1)
    expect(linesWith(errLog, 'reading the pane of persona=C failed')).toEqual([])
    assertNoLeak({ errLog, notices })
  })

  test.each<[number, string]>([
    [60, PROMPT_NOTICE_AUTO_RESTART_ON],
    [0, 'Automatic restarts are disabled'],
  ])('a prompt shown for 60 s while the row reads working is never typed into: one log line and one blocked-on-prompt notice (session_restart_delay %d); the wait goes on and reconnects once the row reads waiting', async (delay, wording) => {
    const cfg = waitConfig({ session_restart_delay: delay })
    const row = installWorkingRow(clock, {
      pane: PERMISSION_PANE,
      stepMs: 20_000,
      // Answered after 3 minutes: the turn ends and the row reads waiting.
      state: () => (clock.now() > 3 * 60_000 ? 'waiting' : 'working'),
    })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('ok')
    // Typed once, and only after the row read waiting.
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
    expect(clock.now()).toBeGreaterThan(3 * 60_000)
    expect(notices.map((n) => n.key)).toEqual(['C'])
    expect(notices[0]!.text).toStartWith(':warning: *Waiting on a prompt*')
    expect(notices[0]!.text).toContain(wording)
    expect(linesWith(errLog, 'its pane has shown a prompt or dialog')).toHaveLength(1)
  })

  test.each<[string, () => PaneReading]>([
    ['a running turn (its spinner line)', () => SPINNER_PANE],
    ['a blank pane', () => ''],
    ['an unreadable pane', () => errGeneric('read-pane', 'ErrPaneRead', leakyMessage('pane read failed', 'wait'))],
  ])('b.rmy: %s for the whole 10 minutes is never typed into, though the transcript ends with a completed turn — the wait gives up not-reconnected; a read failure is logged once, token-safe', async (_label, pane) => {
    const cfg = waitConfig()
    const row = installWorkingRow(clock, { pane: pane(), stepMs: 30_000 }, { getResult: workingRowOf(cfg, transcriptOf()) })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('not-reconnected')
    expect(row.sendKeysCalls).toEqual([])
    expect(clock.now()).toBeGreaterThanOrEqual(WAIT_FOR_WAITING_TIMEOUT_MS)
    // Only the wait's first failed read is logged, by its errName and redacted message.
    const failure = `reading the pane of persona=C failed: ErrPaneRead message=${JSON.stringify(redactedLeakyMessage('pane read failed'))}`
    expect(linesWith(errLog, 'reading the pane of persona=C failed')).toHaveLength(row.pane instanceof Error ? 1 : 0)
    expect(linesWith(errLog, failure)).toHaveLength(row.pane instanceof Error ? 1 : 0)
    assertNoLeak({ errLog })
  })
})

// ---------------------------------------------------------------------------
// b.dup — a findMissing sweep ends a row just before its /mcp reconnect lands
//
// agent-director's send-keys refuses an `ended` or `missing` row with
// ErrSpawnNotInteractive. Another persona's launch wait starts with a
// findMissing sweep (b.m4r), and that sweep can mark a persona's row
// `missing` after its ladder read the row `waiting` and before its
// `/mcp reconnect` keystrokes land (/ci-live run 5, Checks 24-teardown and
// 28: `find_missing.tick cscb_persona_a waiting→missing`, then
// `send_keys cscb_persona_a ErrSpawnNotInteractive` 11 ms later). Its claude
// process is gone, so reconnectMcp answers 'dead-session' and the caller
// recovers the persona. Before the fix it answered 'failed': a `[spawn-failed]`
// startup error and a spawn-failure notice, and the persona stayed down until
// the restart backoff relaunched it.
//
// Cases marked REPRO fail on the code before the fix.
// ---------------------------------------------------------------------------

describe('b.dup: a row a findMissing sweep ended just before /mcp reconnect landed (ErrSpawnNotInteractive)', () => {
  /** What reconnectMcp logs when agent-director refuses its keystrokes for a row that is no longer interactive. */
  const REFUSED = 'ErrSpawnNotInteractive message="spawn not interactive — not in pending/waiting state" — agent-director ended its row or marked it missing after its state was read (SessionEnd or a findMissing sweep), so its claude process is gone — dead session (b.dup)'

  /** Personas `A` and `B`, each launch polling every 1 ms. */
  function raceConfig(): PersonaConfig {
    return makeStandInPersonaConfig(
      { A: { working_directory: '/a' }, B: { working_directory: '/b' } },
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
  }

  /**
   * One stub agent-director that keeps each persona's row state. `A`'s row
   * reads `waiting` though its claude process is gone; `B`'s reads `working`.
   * Both launches collide. `findMissing` marks `A`'s row `missing` (and `B`'s
   * turn ends: its row reads `waiting`); `send-keys` refuses an `ended` or
   * `missing` row with ErrSpawnNotInteractive, as agent-director does; a
   * `resume` brings the row back `waiting`. `A`'s collision `get` reads its row
   * at once but answers only after a sweep: `B`'s wait sweeps between `A`'s
   * read and `A`'s keystrokes.
   */
  function installSweepRace(cfg: PersonaConfig): {
    sendKeysCalls: import('agent-director').SendKeysParams[]
    resumeCalls: import('agent-director').ResumeParams[]
  } {
    const rows = new Map<string, string>([['cscb_A', 'waiting'], ['cscb_B', 'working']])
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const resumeCalls: import('agent-director').ResumeParams[] = []
    let swept!: () => void
    const sweep = new Promise<void>((resolve) => { swept = resolve })
    const stub = installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
      ],
    })
    stub.get = async ({ claude_instance_id }) => {
      const key = claude_instance_id.slice(PERSONA_INSTANCE_ID_PREFIX.length)
      const row = personaRow(cfg, key, { state: rows.get(claude_instance_id) })
      if (key === 'A') await sweep
      return row
    }
    stub.findMissing = async () => {
      rows.set('cscb_A', 'missing')
      rows.set('cscb_B', 'waiting')
      swept()
      return cannedFindMissing({ count: 1, ids: ['cscb_A'] })
    }
    stub.status = async ({ claude_instance_id }) =>
      ({ state: rows.get(claude_instance_id) }) as import('agent-director').StatusResult
    stub.sendKeys = async (params) => {
      sendKeysCalls.push(params)
      const state = rows.get(params.claude_instance_id)
      if (state === 'ended' || state === 'missing') throw errSpawnNotInteractive('send-keys')
      return {}
    }
    stub.resume = async (params) => {
      resumeCalls.push(params)
      rows.set(params.claude_instance_id, 'waiting')
      return { claude_instance_id: params.claude_instance_id }
    }
    return { sendKeysCalls, resumeCalls }
  }

  test('REPRO (live Checks 24-teardown, 28): B\'s wait sweeps A\'s row to missing after A\'s ladder read it waiting and before A\'s /mcp reconnect lands → A is resumed, not failed: no [spawn-failed] entry, no spawn-failure notice; B reconnects', async () => {
    const readLog = captureStartupErrors()
    const cfg = raceConfig()
    const race = installSweepRace(cfg)

    let results: Array<Awaited<ReturnType<typeof spawnForPersona>>> = []
    const errLog = await withCapturedErr(async () => {
      results = await Promise.all([spawnForPersona(personaOf(cfg, 'A'), cfg), spawnForPersona(personaOf(cfg, 'B'), cfg)])
    })

    expect(results).toEqual([{ key: 'A', action: 'resumed' }, { key: 'B', action: 'reconnected' }])
    // A's keystrokes were refused once, with no tmux-server retry; B's landed.
    expect(race.sendKeysCalls.map((c) => c.claude_instance_id).sort()).toEqual(['cscb_A', 'cscb_B'])
    expect(race.resumeCalls).toEqual([{ claude_instance_id: 'cscb_A' }])
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] reconnectMcp: send-keys refused for "A" (key=A): ${REFUSED}`)).toHaveLength(1)
    expect(linesWith(errLog, '[slack] spawnForPersona: dead session for "A" (key=A) (state=waiting) — recovering via resume/fresh-spawn')).toHaveLength(1)
  })

  test('REPRO: reconnectMcp → dead-session on ErrSpawnNotInteractive: one send-keys, no tmux-server retry, no notice, one log line', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({ sendKeysCalls, sendKeysError: errSpawnNotInteractive('send-keys') })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await reconnectMcp('C')
    })

    expect(result).toBe('dead-session')
    expect(sendKeysCalls.map((c) => [c.claude_instance_id, c.text])).toEqual([['cscb_C', RECONNECT_TEXT]])
    expect(ensureCalls).toBe(0)
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] reconnectMcp: send-keys refused for persona=C: ${REFUSED}`)).toHaveLength(1)
  })

  test('REPRO: the tmux-server retry after ErrTmuxSendKeys refused with ErrSpawnNotInteractive (the row was ended meanwhile) → dead-session, no notice', async () => {
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let ensureCalls = 0
    _setTmuxServerEnsurer(async () => { ensureCalls++ })
    installStub({
      sendKeysCalls,
      sendKeysQueue: [
        cannedErr<import('agent-director').SendKeysResult>(errTmuxSendKeys()),
        cannedErr<import('agent-director').SendKeysResult>(errSpawnNotInteractive('send-keys')),
      ],
    })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await reconnectMcp('C')
    })

    expect(result).toBe('dead-session')
    expect(sendKeysCalls).toHaveLength(2)
    expect(ensureCalls).toBe(1)
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] reconnectMcp: send-keys refused for persona=C: ${REFUSED}`)).toHaveLength(1)
  })

  /**
   * The wait's three reconnects (b.f2b), each refused because the row was
   * ended just before: how the stub makes each (`installWorkingRow`), and the
   * row `get` answers.
   */
  const WAIT_RECONNECTS: Array<[string, (cfg: PersonaConfig) => { init: Parameters<typeof installWorkingRow>[1]; opts: StubClientOptions }]> = [
    ['the row reads waiting at a poll', () => ({ init: { state: 'waiting', pane: IDLE_PANE, stepMs: 1_000 }, opts: {} })],
    [
      'the positive-idle rule shows the working row stale',
      (cfg) => ({ init: { pane: IDLE_PANE, stepMs: 10_000 }, opts: { getResult: workingRowOf(cfg, transcriptOf()) } }),
    ],
    [
      'the row reads waiting at the deadline',
      () => ({
        init: { pane: SPINNER_PANE, stepMs: 60_000, state: (r: WorkingRow) => (r.findMissingCalls.length >= 2 ? 'waiting' : 'working') },
        opts: {},
      }),
    ],
  ]

  test.each(WAIT_RECONNECTS)('REPRO: the wait for a working row reconnects when %s, and the keystrokes are refused (ErrSpawnNotInteractive) → dead-session, no notice', async (_label, make) => {
    const clock = useFakeNow()
    _setFindMissingMemoTtlMs(0) // the deadline case: its fresh sweep is the second findMissing
    const cfg = waitConfig()
    const { init, opts } = make(cfg)
    const row = installWorkingRow(clock, init, { ...opts, sendKeysError: errSpawnNotInteractive('send-keys') })

    let result: string | undefined
    const errLog = await withCapturedErr(async () => {
      result = await waitForWaitingAndReconnect('C', cfg)
    })

    expect(result).toBe('dead-session')
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] reconnectMcp: send-keys refused for persona=C: ${REFUSED}`)).toHaveLength(1)
  })

  test('REPRO: the ladder\'s working branch recovers the refused reconnect through resume: resumed, no [spawn-failed] entry, no notice', async () => {
    const readLog = captureStartupErrors()
    const clock = useFakeNow()
    const cfg = waitConfig()
    const resumeCalls: import('agent-director').ResumeParams[] = []
    const row = installWorkingRow(clock, { state: 'waiting', pane: IDLE_PANE, stepMs: 1_000 }, {
      ...workingCollision(cfg),
      sendKeysError: errSpawnNotInteractive('send-keys'),
      resumeCalls,
    })

    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result).toEqual({ key: 'C', action: 'resumed' })
    expect(row.sendKeysCalls.map((c) => c.text)).toEqual([RECONNECT_TEXT])
    expect(resumeCalls).toEqual([{ claude_instance_id: 'cscb_C' }])
    expect(readLog()).toBe('')
    expect(notices).toEqual([])
  })

  // The dialog approver presses Enter through agent-director only, and a
  // refused send-keys is one log line, then the next lap. When the row was
  // ended between its status read and its Enter, the next lap reads it
  // `missing` and the approver stops there (b.jg5 SRJ-402): no pane read and
  // no tmux call; a start-pass launch writes the spawn-died entry once.
  test('the dialog approver\'s Enter refused because the row just left pending for missing: the next lap reads missing and stops the approver with no pane read and no tmux call; one refused-Enter line; no notice; the spawn-died entry once', async () => {
    const clock = useApproverClock()
    const tmux = recordTmuxCalls()
    const readLog = captureStartupErrors()
    const ref = renderPersonaRef('C', 'C')
    const refused = errSpawnNotInteractive('send-keys')
    const statusCalls: import('agent-director').StatusParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      statusCalls,
      readPaneCalls,
      sendKeysCalls,
      sendKeysError: refused,
      readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_PANE }],
      statusQueue: statusReads('pending', 'missing', 'waiting'),
    })

    let stop: ApproverStopReason | undefined
    const errLog = await withCapturedErr(async () => {
      stop = await runOnApproverClock(clock, approvePreSessionDialogs('C', true, ref))
    })

    expect(stop).toBe(APPROVER_STOP_FINISHED)
    // Stopped at the next lap: one sleep between the two reads, no third read.
    expect(statusCalls).toHaveLength(2)
    expect(clock.now()).toBe(DIALOG_POLL_INTERVAL_MS)
    expect(readPaneCalls).toHaveLength(1)
    expect(sendKeysCalls).toEqual([{ claude_instance_id: personaInstanceId('C'), text: '', allow_pending: true }])
    expect(tmux).toEqual([])
    expect(notices).toEqual([])
    expect(linesWith(errLog, approverLogLine(approverPaneCallFailedMessage(ref, 'send-keys', describeAgentDirectorFailure(refused))))).toHaveLength(1)
    expect(onlyStartupEntry(readLog(), STARTUP_ERROR_APPROVE_SPAWN_DIED)).toContain(approverFinishedMessage(ref, 'missing'))
  })
})

// ---------------------------------------------------------------------------
// b.jdc — a launch meets a row waiting on a prompt whose session is gone
//
// /ci-live run 6: persona A's session was killed while its row read
// `check_permission`. agent-director only refreshes a row at SessionEnd and
// leaves reaping to its findMissing sweep, so the row kept that state, and the
// next server start's ladder logged `spawnForPersona: no action —
// state=check_permission` and left A down. The ladder now probes the persona's
// own tmux session (exactly, `=slack_bot_<key>`) before doing nothing: gone →
// the memoized findMissing sweep, then the row is read again; `missing` or
// `ended` → a dead session, recovered through resume/fresh-spawn. A live tmux
// session (or a failed probe) is left alone as before: nothing is ever typed
// into a prompt (b.rmy).
//
// Cases marked REPRO fail on the code before the fix.
// ---------------------------------------------------------------------------

describe('b.jdc: a launch meets a row waiting on a prompt whose session may be gone', () => {
  /**
   * Persona `C`'s colliding spawn meets its row in `state`. Status reads
   * `state` until a findMissing sweep has run, then `afterSweep`, and
   * `waiting` once the row is resumed.
   */
  function installPromptRow(cfg: PersonaConfig, state: string, afterSweep: string): LadderCalls {
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state }),
      statusFn: () => ({
        state: calls.resumeCalls.length > 0 ? 'waiting' : calls.findMissingCalls.length > 0 ? afterSweep : state,
      }) as import('agent-director').StatusResult,
    })
    return calls
  }

  test.each(['check_permission', 'ask_user'])('REPRO: a %s row whose tmux session is gone (exact has-session target) → one findMissing sweep, the row reads missing → resumed; nothing typed, no notice, no "no action" line', async (state) => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const calls = installPromptRow(cfg, state, 'missing')
    // The real prober, over the tmux runner seam: `has-session` fails (gone).
    const tmuxCalls: string[][] = []
    _resetTmuxSessionProber()
    _setTmuxCommandRunner(async (args) => { tmuxCalls.push([...args]); return { code: 1, stdout: '' } })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'resumed' })
    expect(tmuxCalls.filter((args) => args[0] === 'has-session')).toEqual([['has-session', '-t', '=slack_bot_C']])
    expect(calls.findMissingCalls).toHaveLength(1)
    expect(calls.resumeCalls).toEqual([{ claude_instance_id: 'cscb_C' }])
    expect(calls.sendKeysCalls).toEqual([])
    expect(calls.killCalls).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(calls.spawnCalls).toHaveLength(1) // the colliding spawn only
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] spawnForPersona: "C" (key=C) reads ${state} but its tmux session "slack_bot_C" is gone — no prompt is waiting in it; reconciling its row before deciding (b.jdc)`)).toHaveLength(1)
    expect(linesWith(errLog, `[slack] spawnForPersona: dead session for "C" (key=C) (state=${state}) — recovering via resume/fresh-spawn`)).toHaveLength(1)
    expect(errLog).not.toContain('no action')
  })

  test.each(['check_permission', 'ask_user'])('a %s row whose tmux session lives → no-op after one probe of its own session: no sweep, resume or keystrokes', async (state) => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const calls = installPromptRow(cfg, state, 'missing')
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => { probed.push(name); return true })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'no-op' })
    expect(probed).toEqual(['slack_bot_C'])
    expect(calls.findMissingCalls).toEqual([])
    expect(calls.resumeCalls).toEqual([])
    expect(calls.sendKeysCalls).toEqual([])
    expect(notices).toEqual([])
    expect(linesWith(errLog, `[slack] spawnForPersona: no action — state=${state} for "C" (key=C)`)).toHaveLength(1)
  })

  test('a check_permission row whose tmux probe fails is taken as alive (b.rmy) → no-op, no sweep', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const calls = installPromptRow(cfg, 'check_permission', 'missing')
    _setTmuxSessionProber(async () => { throw new Error('tmux probe failed') })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'no-op' })
    expect(calls.findMissingCalls).toEqual([])
    expect(calls.resumeCalls).toEqual([])
    const [probe] = linesWith(errLog, 'its tmux session probe failed')
    expect(probe).toStartWith('[slack] spawnForPersona: "C" (key=C) reads check_permission and its tmux session probe failed: Error message="tmux probe failed" at ')
    expect(probe).toEndWith(' — taking the session as alive (b.jdc/b.rmy)')
    expect(linesWith(errLog, '[slack] spawnForPersona: no action — state=check_permission for "C" (key=C)')).toHaveLength(1)
  })

  test('a check_permission row whose tmux session is gone but that still reads check_permission after the sweep → no-op: nothing resumed, killed or deleted', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const calls = installPromptRow(cfg, 'check_permission', 'check_permission')
    _setTmuxSessionProber(async () => false)

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'no-op' })
    expect(calls.findMissingCalls).toHaveLength(1)
    expect(calls.resumeCalls).toEqual([])
    expect(calls.killCalls).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(calls.sendKeysCalls).toEqual([])
    expect(notices).toEqual([])
    expect(linesWith(errLog, '[slack] spawnForPersona: "C" (key=C): its tmux session is gone, but its row still reads check_permission after the findMissing sweep — no action; the health check\'s restart retries it (b.jdc)')).toHaveLength(1)
  })

  test('the same at session_restart_delay 0: the line says nothing retries it before the next server start', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { session_restart_delay: 0 })
    installPromptRow(cfg, 'ask_user', 'ask_user')
    _setTmuxSessionProber(async () => false)

    const errLog = await withCapturedErr(async () => {
      await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(linesWith(errLog, '[slack] spawnForPersona: "C" (key=C): its tmux session is gone, but its row still reads ask_user after the findMissing sweep — no action; session_restart_delay is 0, so nothing retries it before the next server start (b.jdc)')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// b.jdc — checkPromptRowDeferral: the restart path's run of deferrals on a
// row waiting on a prompt whose tmux session lives. From
// PROMPT_ROW_SWEEP_AFTER_MS (10 min) after the run's first deferral, each
// deferral runs the memoized findMissing sweep and reads the row again; a row
// that now reads `ended` or `missing` escalates. On a fake clock passed to
// `_setNow`; the memo is off so each call a tick apart sweeps.
// ---------------------------------------------------------------------------

describe('b.jdc: checkPromptRowDeferral', () => {
  const min = (n: number): number => n * 60_000
  let clock: FakeClock

  beforeEach(() => {
    clock = useFakeNow()
    _setFindMissingMemoTtlMs(0)
  })

  test('each persona\'s run starts at its first deferral; from 10 min on each deferral sweeps and reads its row again; a row read missing escalates once and ends the run; no notice of its own', async () => {
    const rows = new Map<string, string>([['cscb_C', 'check_permission'], ['cscb_D', 'ask_user']])
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    const statusCalls: import('agent-director').StatusParams[] = []
    installStub({
      findMissingCalls,
      statusCalls,
      statusFn: ({ claude_instance_id }) => ({ state: rows.get(claude_instance_id) }) as import('agent-director').StatusResult,
    })

    const verdicts: string[] = []
    await clock.advance(5_000)
    verdicts.push(await checkPromptRowDeferral('C', 'check_permission')) // the run starts at 5 s
    await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS - 1)
    verdicts.push(await checkPromptRowDeferral('C', 'check_permission'))
    expect(findMissingCalls).toEqual([])
    await clock.advance(1)
    verdicts.push(await checkPromptRowDeferral('C', 'check_permission')) // 10 min: sweeps; still check_permission
    // Another persona's run is its own.
    verdicts.push(await checkPromptRowDeferral('D', 'ask_user'))
    rows.set('cscb_C', 'missing')
    await clock.advance(min(3))
    verdicts.push(await checkPromptRowDeferral('C', 'check_permission'))
    // The escalation ended the run: the next deferral starts a new one.
    verdicts.push(await checkPromptRowDeferral('C', 'check_permission'))

    expect(PROMPT_ROW_SWEEP_AFTER_MS).toBe(min(10))
    expect(verdicts).toEqual(['defer', 'defer', 'defer', 'defer', 'escalate', 'defer'])
    expect(findMissingCalls).toHaveLength(2)
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C', 'cscb_C'])
    expect(notices).toEqual([])
  })

  test('a failed read after the sweep defers (no proof the process is gone), with one token-safe line', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, statusError: errGeneric('status', 'ErrStatusBroken', adDescription()) })

    let verdicts: string[] = []
    const errLog = await withCapturedErr(async () => {
      verdicts = [await checkPromptRowDeferral('C', 'ask_user')]
      await clock.advance(min(10))
      verdicts.push(await checkPromptRowDeferral('C', 'ask_user'))
    })

    expect(verdicts).toEqual(['defer', 'defer'])
    expect(findMissingCalls).toHaveLength(1)
    expect(linesWith(errLog, 'after the findMissing sweep failed')).toEqual([
      `[slack] reconnectSession: prompt row: reading the row of persona=C after the findMissing sweep failed: ErrStatusBroken message="${REDACTED_AD_DESCRIPTION}"`,
    ])
    expect(errLog).not.toContain(LEAK_SENTINEL)
  })

  test('a launch for the persona ends its run, and so does the end of its not-connected episode', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({ findMissingCalls, statusResult: { state: 'waiting' } as import('agent-director').StatusResult })

    expect(await checkPromptRowDeferral('C', 'check_permission')).toBe('defer') // the run starts at 0
    await clock.advance(min(9))
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    await clock.advance(min(2))
    expect(await checkPromptRowDeferral('C', 'check_permission')).toBe('defer') // a new run starts at 11 min
    await clock.advance(min(9))
    forgetNotConnectedEpisode('C')
    await clock.advance(min(2))
    expect(await checkPromptRowDeferral('C', 'check_permission')).toBe('defer') // a new run starts at 22 min

    expect(findMissingCalls).toEqual([])
  })
})

describe('b.f2b: a teardown cancels a launch\'s wait for a working row (cancelWorkingRowWait)', () => {
  let clock: FakeClock
  beforeEach(() => {
    clock = useFakeNow()
  })

  test('a running wait, asleep between 60 s polls: cancelled at once — it wakes, types nothing, polls no more, and its launch settles as not-reconnected; a second cancel does nothing', async () => {
    const cfg = waitConfig({ agent_director_poll_interval_ms: 60_000 })
    const row = installWorkingRow(clock, { pane: SPINNER_PANE, stepMs: 0 }, workingCollision(cfg))

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    let cancels: boolean[] = []
    const errLog = await withCapturedErr(async () => {
      const launch = spawnForPersona(personaOf(cfg, 'C'), cfg, false)
      await pollUntil(() => row.readPaneCalls.length === 1)
      cancels = [cancelWorkingRowWait('C'), cancelWorkingRowWait('C')]
      result = await launch
    })

    expect(cancels).toEqual([true, false])
    expect(result).toEqual({ key: 'C', action: 'not-reconnected' })
    expect(isLaunchInFlight('C')).toBe(false)
    expect(row.statusCalls).toHaveLength(1)
    expect(row.sendKeysCalls).toEqual([])
    expect(linesWith(errLog, 'persona=C — cancelling its launch\'s wait for its working row')).toHaveLength(1)
    expect(linesWith(errLog, `the wait for ${renderPersonaRef('C', 'C')} was cancelled (its persona is being torn down) — nothing typed`)).toHaveLength(1)
  })

  test('a launch in flight whose wait has not started: the wait it starts is cancelled from its first check (no sweep, poll or read, nothing typed), and the cancel ends with that launch', async () => {
    const cfg = waitConfig()
    const row = installWorkingRow(clock, { pane: SPINNER_PANE, stepMs: 0 }, { getResult: workingRowOf(cfg) })
    const held = holdSpawns(row.stub)

    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    let cancels: boolean[] = []
    const errLog = await withCapturedErr(async () => {
      const launch = spawnForPersona(personaOf(cfg, 'C'), cfg, false)
      await held.entered('cscb_C')
      cancels = [cancelWorkingRowWait('C'), cancelWorkingRowWait('C')]
      held.fail('cscb_C', errInstanceIdCollision())
      result = await launch
    })

    expect(cancels).toEqual([true, false])
    expect(result).toEqual({ key: 'C', action: 'not-reconnected' })
    expect([row.findMissingCalls, row.statusCalls, row.readPaneCalls, row.sendKeysCalls]).toEqual([[], [], [], []])
    expect(linesWith(errLog, 'persona=C — its launch in flight will not wait for a working row')).toHaveLength(1)
    expect(linesWith(errLog, `the wait for ${renderPersonaRef('C', 'C')} was cancelled`)).toHaveLength(1)
    // Nothing in flight now: nothing to cancel, and a later wait runs as usual.
    expect(cancelWorkingRowWait('C')).toBe(false)
    row.state = 'waiting'
    expect(await waitForWaitingAndReconnect('C', cfg)).toBe('ok')
  })

  test('no launch in flight: nothing to cancel, and nothing logged', async () => {
    installStub({})
    let cancelled: boolean | undefined
    const errLog = await withCapturedErr(() => {
      cancelled = cancelWorkingRowWait('C')
    })

    expect(cancelled).toBe(false)
    expect(errLog).toBe('')
  })
})

/** Rejections no handler took while a start-pass case ran (the listener is removed in its afterEach). */
let unhandledRejections: unknown[] = []
const recordUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason)
}

describe('b.f2b: one persona waiting for its working row does not hold up the start pass', () => {
  afterEach(() => {
    process.off('unhandledRejection', recordUnhandledRejection)
  })

  /** Personas A and B; only A's first spawn collides with its `working` row. A's row reads `aState()`, B's `waiting`. */
  function parkedA(pollMs: number, aState: () => RowReading) {
    const cfg = makeStandInPersonaConfig(
      { A: { working_directory: '/x/a' }, B: { working_directory: '/x/b' } },
      fixtureDir,
      { agent_director_poll_interval_ms: pollMs },
    )
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'A', { state: 'working' }),
      statusFn: (params) => {
        const reading = params.claude_instance_id === 'cscb_A' ? aState() : 'waiting'
        return reading instanceof Error ? reading : ({ state: reading } as import('agent-director').StatusResult)
      },
      readPaneResults: [{ pane: SPINNER_PANE }],
    })
    return { cfg, sendKeysCalls, ref: renderPersonaRef('A', 'A') }
  }

  test('REPRO: concurrency 1, A\'s working row stuck mid-turn — A\'s launch is parked (its slot freed, still in flight), B and C launch, and the pass returns counting A apart; A\'s outcome is logged when it settles', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig(
      { A: { working_directory: '/x/a' }, B: { working_directory: '/x/b' }, C: { working_directory: '/x/c' } },
      fixtureDir,
      { agent_director_poll_interval_ms: 1 },
    )
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    let aState = 'working'
    installStub({
      spawnCalls,
      sendKeysCalls,
      // Only A (launched first) collides; B and C spawn fresh.
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'A', { state: 'working' }),
      statusFn: (params) => ({ state: params.claude_instance_id === 'cscb_A' ? aState : 'waiting' }) as import('agent-director').StatusResult,
      readPaneResults: [{ pane: SPINNER_PANE }],
    })

    let result: Awaited<ReturnType<typeof startupSessionManager>> | undefined
    let returnedWhileAWaits = false
    let aInFlightAtReturn = false
    const errLog = await withCapturedErr(async () => {
      const start = startupSessionManager(cfg, { concurrency: 1 })
      void start.then((r) => { result = r })
      await pollUntil(() => result !== undefined)
      returnedWhileAWaits = result !== undefined
      aInFlightAtReturn = isLaunchInFlight('A')
      // A's turn ends: its row reads waiting, and its background launch reconnects it.
      aState = 'waiting'
      await start
      await whenLaunchSettled('A')
    })

    expect(returnedWhileAWaits).toBe(true)
    expect(aInFlightAtReturn).toBe(true)
    expect(isLaunchInFlight('A')).toBe(false)
    expect(spawnCalls.map((p) => p.claude_instance_id)).toEqual(['cscb_A', 'cscb_B', 'cscb_C'])
    expect(result!.perPersona).toEqual([
      { key: 'A', action: 'waiting-in-background' },
      { key: 'B', action: 'spawned' },
      { key: 'C', action: 'spawned' },
    ])
    expect(result!).toMatchObject({ waitingInBackground: 1, succeeded: 2, freshSpawned: 2, reconnected: 0, notReconnected: 0, failed: 0 })
    expect(sendKeysCalls.map((c) => [c.claude_instance_id, c.text])).toEqual([['cscb_A', RECONNECT_TEXT]])
    const ref = renderPersonaRef('A', 'A')
    expect(linesWith(errLog, `startupSessionManager: ${ref} is waiting for its working row to settle`)).toHaveLength(1)
    expect(errLog).toContain('0 reconnected, 0 no-op, 0 failed, 0 not brought up, 0 not reconnected')
    expect(errLog).toContain('startupSessionManager: 1 persona(s) still waiting in the background for a working row')
    const settled = `startupSessionManager: background launch for ${ref} settled: reconnected`
    expect(linesWith(errLog, settled)).toHaveLength(1)
    expect(errLog.indexOf(settled)).toBeGreaterThan(errLog.indexOf('still waiting in the background'))
  })

  test('a teardown of A while its start launch is parked cancels the wait, as the persona teardown does before it waits for the launch: the launch settles at once (its 60 s poll sleep cut short) as not-reconnected, typed nothing, and its outcome is logged', async () => {
    captureStartupErrors()
    const { cfg, sendKeysCalls, ref } = parkedA(60_000, () => 'working')

    let result: Awaited<ReturnType<typeof startupSessionManager>> | undefined
    let cancelled: boolean | undefined
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
      cancelled = cancelWorkingRowWait('A')
      await whenLaunchSettled('A')
      await settleNotices()
    })

    expect(result!.perPersona).toEqual([{ key: 'A', action: 'waiting-in-background' }, { key: 'B', action: 'spawned' }])
    expect(cancelled).toBe(true)
    expect(isLaunchInFlight('A')).toBe(false)
    expect(sendKeysCalls).toEqual([])
    expect(linesWith(errLog, `startupSessionManager: background launch for ${ref} settled: not-reconnected`)).toHaveLength(1)
  })

  test('a parked launch that rejects: one token-safe "unexpected error in the background launch" line and one spawn-failed startup error, no settled line and no unhandled rejection', async () => {
    const readLog = captureStartupErrors()
    let aState: RowReading = 'working'
    const { cfg, sendKeysCalls, ref } = parkedA(1, () => aState)
    // An injected tmux prober may reject (the default never does): here, once A's row is gone.
    const probeFailure = Object.assign(new Error(leakyMessage('tmux probe failed', 'parked')), { detail: LEAK_SENTINEL })
    _setTmuxSessionProber(async () => {
      throw probeFailure
    })
    unhandledRejections = []
    process.on('unhandledRejection', recordUnhandledRejection)

    let result: Awaited<ReturnType<typeof startupSessionManager>> | undefined
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
      aState = errSpawnNotFound()
      await whenLaunchSettled('A')
      await settleNotices()
    })

    expect(result!.perPersona).toEqual([{ key: 'A', action: 'waiting-in-background' }, { key: 'B', action: 'spawned' }])
    expect(isLaunchInFlight('A')).toBe(false)
    expect(sendKeysCalls).toEqual([])
    const lines = linesWith(errLog, 'unexpected error in the background launch')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(
      `[slack] startupSessionManager: unexpected error in the background launch for ${ref}: Error message=${JSON.stringify(redactedLeakyMessage('tmux probe failed'))}`,
    )
    expect(linesWith(errLog, `background launch for ${ref} settled`)).toEqual([])
    const entry = onlyStartupEntry(readLog(), 'spawn-failed')
    expect(entry).toContain(`unexpected error spawning ${ref}: Error message=${JSON.stringify(redactedLeakyMessage('tmux probe failed'))}`)
    expect(unhandledRejections).toEqual([])
    assertNoLeak({ errLog, startupErrors: writtenFile(join(fixtureDir, 'state', 'startup-errors.log')) })
  })

  test('a start launch that joins a launch already waiting on a working row waits with it; when that wait gives up with the session alive, both count it a launch that did not fail, and the summary ends ", 1 not reconnected"', async () => {
    captureStartupErrors()
    const clock = useFakeNow()
    const cfg = waitConfig()
    // The wait spins without moving time until the start pass has joined it.
    const row = installWorkingRow(clock, { pane: SPINNER_PANE, stepMs: 0 }, workingCollision(cfg))
    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    let restarted: LaunchSessionResult | undefined
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    try {
      const restart = launchSession('C', cfg)
      await pollUntil(() => isLaunchInFlight('C'))
      const start = startupSessionManager(cfg, { concurrency: 1 })
      await pollUntil(() => lines.some((l) => l.includes('launch already in flight for')))
      row.stepMs = 60_000 // now time runs out
      ;[restarted, result] = await Promise.all([restart, start])
    } finally {
      console.error = orig
    }
    const errLog = lines.join('\n')

    expect(restarted).toBe(true)
    expect(row.spawnCalls).toHaveLength(1) // one launch, joined
    expect(row.sendKeysCalls).toEqual([])
    expect(result.perPersona).toEqual([{ key: 'C', action: 'not-reconnected' }])
    expect(result).toMatchObject({ notReconnected: 1, succeeded: 1, reconnected: 0, waitingInBackground: 0, failed: 0 })
    expect(errLog).toContain('0 reconnected, 0 no-op, 0 failed, 0 not brought up, 1 not reconnected')
    expect(errLog).not.toContain('still waiting in the background')
  })
})

// ---------------------------------------------------------------------------
// SR-8.6 invariant: live state set + instance-id helper
// ---------------------------------------------------------------------------

describe('SR-8.6 invariants', () => {
  test('AGENT_DIRECTOR_LIVE_STATES covers all expected SR-11 live states', () => {
    expect(AGENT_DIRECTOR_LIVE_STATES.has('pending')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('waiting')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('working')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ask_user')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('check_permission')).toBe(true)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('ended')).toBe(false)
    expect(AGENT_DIRECTOR_LIVE_STATES.has('missing')).toBe(false)
  })

  test('every spawn call site emits relay_mode=on', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      resumeError: errNoSessionId(),
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    await spawnForPersona(personaOf(cfg, 'C'), cfg)
    // Both spawns (initial + retry-after-delete) must carry relay_mode='on'.
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    for (const p of spawnCalls) {
      expect(p.relay_mode).toBe('on')
    }
  })
})

// ---------------------------------------------------------------------------
// b.4ie — merged approvePreSessionDialogs (dev-channels + trust needle),
// through agent-director only (b.jg5 SRJ-402)
//
// Each lap reads the persona's row with `status`; on `pending` with a launch
// start it reads the pane once (`readPane`, 40 lines, `allow_pending`) and,
// when a needle shows, presses Enter once (`sendKeys`, empty text,
// `allow_pending`); a live state stops it; `ended` or `missing` stops it at
// that lap with no pane read, and a start-pass launch writes the spawn-died
// entry. A launch, fresh or resumed, reads `pending` until it reports in
// (HO C5), so the server runs no tmux command for it. A launch that returns
// success starts the approver on its own after the launch call (b.jg5
// SRJ-401), so a case settles the launch, then runs its approver to its stop
// (`launchThenRunApprover`). Every approver case runs it on a fake clock
// (`useApproverClock`, `runOnApproverClock`) and installs `pending` answers
// through the stub's canned builder, so each carries a launch start.
// ---------------------------------------------------------------------------

describe('approvePreSessionDialogs (b.4ie)', () => {
  const DEV_CHANNELS_PANE = readFileSync(
    join(import.meta.dir, 'fixtures', 'dev-channels-pane-2.1.120.txt'),
    'utf-8',
  )
  const WELCOME_PANE = 'Listening for channel messages from: server:slack-channel-router'
  const C_ID = personaInstanceId('C')
  const C_REF = renderPersonaRef('C', 'C')
  /** The one pane read a lap makes. */
  const PANE_READ: import('agent-director').ReadPaneParams = { claude_instance_id: C_ID, n_lines: APPROVER_PANE_LINES, allow_pending: true }
  /** The one Enter a lap presses on a dialog. */
  const ENTER: import('agent-director').SendKeysParams = { claude_instance_id: C_ID, text: '', allow_pending: true }

  /** Capture lists for the approver's verbs and the ladder's resume. */
  function approverCalls() {
    return {
      statusCalls: [] as import('agent-director').StatusParams[],
      readPaneCalls: [] as import('agent-director').ReadPaneParams[],
      sendKeysCalls: [] as import('agent-director').SendKeysParams[],
      resumeCalls: [] as import('agent-director').ResumeParams[],
    }
  }

  // -------------------------------------------------------------------------
  // Happy path: dialog detected → Enter sent (via spawnForPersona, the SR-1.1
  // fresh-spawn path that calls approvePreSessionDialogs).
  // -------------------------------------------------------------------------

  test('happy path: a fresh spawn reading pending with the dialog: one readPane and one Enter (allow_pending, cscb_<key>), then the next lap reads waiting; no tmux call', async () => {
    const clock = useApproverClock()
    const tmux = recordTmuxCalls()
    const calls = approverCalls()
    installStub({
      ...calls,
      statusQueue: statusReads('pending', 'waiting'),
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }, { pane: WELCOME_PANE }],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    const result = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(calls.statusCalls).toEqual([{ claude_instance_id: C_ID }, { claude_instance_id: C_ID }])
    expect(calls.readPaneCalls).toEqual([PANE_READ])
    expect(calls.sendKeysCalls).toEqual([ENTER])
    expect(tmux).toEqual([])
    expect(clock.now()).toBe(DIALOG_POLL_INTERVAL_MS)
  })

  // -------------------------------------------------------------------------
  // needle lock-in constant test
  // -------------------------------------------------------------------------

  test('needle lock-in: matches the verified Claude Code 2.1.120 label', () => {
    expect(DEV_CHANNELS_DIALOG_NEEDLE).toBe('I am using this for local development')
    expect(DEV_CHANNELS_PANE).toContain(DEV_CHANNELS_DIALOG_NEEDLE)
  })

  // -------------------------------------------------------------------------
  // The collision ladder
  // -------------------------------------------------------------------------

  test('collision-resume path: the approver stops at its first lap when the resumed row already reads a live state (no readPane)', async () => {
    const clock = useApproverClock()
    const calls = approverCalls()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      ...calls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      statusResult: cannedStatusResult({ state: 'waiting' }),
    })

    const result = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    expect(result).toEqual({ key: 'C', action: 'resumed' })
    expect(calls.statusCalls).toHaveLength(1)
    expect(calls.readPaneCalls).toHaveLength(0)
    expect(clock.firedCount()).toBe(0)
  })

  test('skipped on collision-reconnect path (waiting state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'waiting' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('reconnected')
    expect(readPaneCalls).toHaveLength(0)
  })

  test('skipped on collision-noop path (pending state → no readPane)', async () => {
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      readPaneCalls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'pending' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('no-op')
    expect(readPaneCalls).toHaveLength(0)
  })

  // AC 34, AC 48: a resumed launch reads `pending` until it reports in, like a
  // fresh one, so its dialog is cleared through agent-director, never raw tmux.
  test.each([
    ['the development channels dialog', DEV_CHANNELS_DIALOG_PANE],
    ['the folder trust dialog', TRUST_DIALOG_PANE],
  ])('AC 34, AC 48: a collision on an ended row is resumed and the resumed row reads pending with %s: one readPane (40 lines, allow_pending) and one Enter (empty text, allow_pending) on P\'s instance only clear it, the next lap reads waiting; the recording tmux runner records no call', async (_label, pane) => {
    const clock = useApproverClock()
    const tmux = recordTmuxCalls()
    const calls = approverCalls()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      ...calls,
      spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      statusQueue: statusReads('pending', 'waiting'),
      readPaneResults: [{ pane }, { pane: WELCOME_PANE }],
    })

    const result = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    expect(result).toEqual({ key: 'C', action: 'resumed' })
    expect(calls.resumeCalls).toEqual([{ claude_instance_id: C_ID }])
    expect(calls.statusCalls).toEqual([{ claude_instance_id: C_ID }, { claude_instance_id: C_ID }])
    expect(calls.readPaneCalls).toEqual([PANE_READ])
    expect(calls.sendKeysCalls).toEqual([ENTER])
    expect(tmux).toEqual([])
  })

  /** A launch of `C` whose approver then runs: the stub knobs that reach it and the result the launch answers. */
  const LADDER_LAUNCHES: Array<[string, (cfg: PersonaConfig) => StubClientOptions, SpawnPersonaResult]> = [
    ['a fresh spawn', () => ({}), { key: 'C', action: 'spawned' }],
    [
      'a resume at the collision ladder (its row read ended)',
      (cfg) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'ended' }),
      }),
      { key: 'C', action: 'resumed' },
    ],
  ]
  const FINISHED_CROSS = (['ended', 'missing'] as const).flatMap((state) =>
    LADDER_LAUNCHES.flatMap(([launch, knobs, result]) =>
      ([['a start-pass launch', true], ['a restart-path launch', false]] as const).map(
        ([pass, isStartup]) => [state, launch, pass, knobs, result, isStartup] as const,
      ),
    ),
  )

  // b.jg5 SRJ-402: `ended` or `missing` means the launch is over: the approver
  // stops at that lap, at once (no streak, no sleep), with no pane read, and
  // the restart path decides.
  test.each(FINISHED_CROSS)('the row reads %s at the first lap after %s, during %s: the approver stops there at once with no pane read, no Enter, no further status and no tmux call; the spawn-died entry once for a start pass only; the launch result unchanged', async (state, _launch, _pass, knobs, result, isStartup) => {
    const clock = useApproverClock()
    const tmux = recordTmuxCalls()
    const readLog = captureStartupErrors()
    const calls = approverCalls()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      ...calls,
      ...knobs(cfg),
      statusQueue: statusReads(state, 'pending', 'waiting'),
      readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_PANE }],
    })

    let launched: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      launched = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg, isStartup))
    })

    expect(launched).toStrictEqual(result)
    expect(calls.statusCalls).toEqual([{ claude_instance_id: C_ID }])
    expect(calls.readPaneCalls).toEqual([])
    expect(calls.sendKeysCalls).toEqual([])
    expect(tmux).toEqual([])
    // At once: no timer fired and no virtual time passed.
    expect(clock.firedCount()).toBe(0)
    expect(clock.now()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
    const finished = approverFinishedMessage(C_REF, state)
    expect(linesWith(errLog, approverLogLine(finished))).toHaveLength(1)
    const log = readLog()
    if (isStartup) {
      expect(onlyStartupEntry(log, STARTUP_ERROR_APPROVE_SPAWN_DIED)).toContain(finished)
    } else {
      expect(countStartupEntries(log, STARTUP_ERROR_APPROVE_SPAWN_DIED)).toBe(0)
    }
    expect(countStartupEntries(log, STARTUP_ERROR_APPROVE_NOT_READY)).toBe(0)
    expect(notices).toEqual([])
  })

  // -------------------------------------------------------------------------
  // isStartup=false path: no startup error recorded on cap hit
  // -------------------------------------------------------------------------

  test('launchSession (restart path, isStartup=false): does not record startup error on cap hit', async () => {
    const clock = useApproverClock()
    const capMs = 4 * DIALOG_POLL_INTERVAL_MS
    _setDialogReadyTimeoutMs(capMs)
    installStub({
      statusResult: cannedStatusResult({ state: 'pending' }),
      readPaneResults: [{ pane: 'unrelated' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    let result: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg, false))
    })

    expect(result).toEqual({ key: 'C', action: 'spawned' })
    expect(clock.now()).toBe(capMs)
    expect(linesWith(errLog, approverLogLine(approverCapMessage(C_REF, capMs)))).toHaveLength(1)
    expect(readLog()).toBe('')
  })

  // -------------------------------------------------------------------------
  // b.98w regression: readPane/sendKeys must pass allow_pending:true
  // -------------------------------------------------------------------------

  test('b.98w / allow_pending: Enter pressed with allow_pending:true while spawn is pending', async () => {
    const clock = useApproverClock()
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []

    // Install a baseline stub, then override readPane and sendKeys to simulate
    // the agent-director rejecting calls that lack allow_pending:true.
    const stub = installStub({ sendKeysCalls, readPaneCalls })

    stub.readPane = async (params: import('agent-director').ReadPaneParams): Promise<import('agent-director').ReadPaneResult> => {
      readPaneCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('read-pane')
      }
      // Return the dialog needle on the first detection call, then clear it.
      const callIdx = readPaneCalls.length
      if (callIdx === 1) return { pane: DEV_CHANNELS_PANE }
      return { pane: WELCOME_PANE }
    }

    stub.sendKeys = async (params: import('agent-director').SendKeysParams): Promise<import('agent-director').SendKeysResult> => {
      sendKeysCalls.push(params)
      if (!params.allow_pending) {
        throw errSpawnNotInteractive('send-keys')
      }
      return {}
    }

    // pending (with a launch start) → (readPane+sendKeys fire) → waiting → exit
    stub.status = async (_params: import('agent-director').StatusParams): Promise<Phase1StatusResult> =>
      cannedStatusResult({ state: sendKeysCalls.length >= 1 ? 'waiting' : 'pending' })

    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    // If allow_pending is present everywhere the spawn must complete cleanly.
    expect(result.action).toBe('spawned')
    // Exactly one sendKeys (the Enter key that dismisses the dialog).
    expect(sendKeysCalls).toEqual([ENTER])
    expect(readPaneCalls).toEqual([PANE_READ])
  })

  // -------------------------------------------------------------------------
  // b.ben regression: the approver addresses the persona's cscb_<key>, derived
  // from the key and never from the name (the two differ here).
  // -------------------------------------------------------------------------

  test('b.ben: dialog approval addresses cscb_<key> for a persona whose key differs from its name', async () => {
    const clock = useApproverClock()
    const calls = approverCalls()
    installStub({
      ...calls,
      statusQueue: statusReads('pending', 'waiting'),
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }, { pane: WELCOME_PANE }],
    })
    const key = personaKey('My Chan')
    expect(key).not.toBe('My Chan')
    const cfg = makeMultiPersonaConfig([{ name: 'My Chan', working_directory: '/x' }], fixtureDir)
    const result = await launchThenRunApprover(clock, key, spawnForPersona(personaOf(cfg, key), cfg))

    expect(result.action).toBe('spawned')
    const id = personaInstanceId(key)
    expect(calls.statusCalls).toEqual([{ claude_instance_id: id }, { claude_instance_id: id }])
    expect(calls.readPaneCalls).toEqual([{ ...PANE_READ, claude_instance_id: id }])
    expect(calls.sendKeysCalls).toEqual([{ ...ENTER, claude_instance_id: id }])
  })

  // -------------------------------------------------------------------------
  // New behavior tests for merged approver (b.4ie)
  // -------------------------------------------------------------------------

  test('cap hit: sticky pending + unrecognized pane → one lap per 500 ms until the cap, the not-ready startup entry once, no sendKeys, posts a spawn-failure notice to the persona destination (isStartup=true)', async () => {
    const clock = useApproverClock()
    const capMs = 4 * DIALOG_POLL_INTERVAL_MS
    _setDialogReadyTimeoutMs(capMs)
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    const readPaneCalls: import('agent-director').ReadPaneParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      // sticky pending: never becomes live
      statusResult: cannedStatusResult({ state: 'pending' }),
      readPaneResults: [{ pane: 'unrelated pane text' }],
    })
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)
    await launchThenRunApprover(clock, NOTICE_KEY, spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg))
    await settleNotices()

    expect(sendKeysCalls).toHaveLength(0)
    // One lap at each 500 ms step before the cap, measured from the approver's start.
    expect(readPaneCalls).toHaveLength(capMs / DIALOG_POLL_INTERVAL_MS)
    expect(clock.now()).toBe(capMs)
    expect(onlyStartupEntry(readLog(), STARTUP_ERROR_APPROVE_NOT_READY)).toContain(
      approverCapMessage(renderPersonaRef(NOTICE_NAME, NOTICE_KEY), capMs),
    )
    // cap path must also raise the spawn-failure notice (core requirement of b.4ie)
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `DialogApprovalTimeout`')
  })

  test('already-live: the first lap reads waiting → no readPane, no sendKeys, no startup error', async () => {
    const clock = useApproverClock()
    const calls = approverCalls()
    installStub({ ...calls, statusQueue: statusReads('waiting') })
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    expect(calls.statusCalls).toHaveLength(1)
    expect(calls.readPaneCalls).toHaveLength(0)
    expect(calls.sendKeysCalls).toHaveLength(0)
    expect(readLog()).toBe('')
  })

  test('approvePreSessionDialogs answers live when the row leaves pending for a live state', async () => {
    const clock = useApproverClock()
    installStub({ statusQueue: statusReads('pending', 'working') })

    expect(await runOnApproverClock(clock, approvePreSessionDialogs('C', true, C_REF))).toBe(APPROVER_STOP_LIVE)
  })

  test('self-heal: pending, pending, waiting + sticky dialog → Enter pressed once per pending lap', async () => {
    const clock = useApproverClock()
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({
      sendKeysCalls,
      statusQueue: statusReads('pending', 'pending', 'waiting'),
      // sticky: every readPane returns the dialog needle
      readPaneResults: [{ pane: DEV_CHANNELS_PANE }],
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    await launchThenRunApprover(clock, 'C', spawnForPersona(personaOf(cfg, 'C'), cfg))

    // Enter pressed each time the pane shows the needle while pending
    expect(sendKeysCalls).toEqual([ENTER, ENTER])
    expect(clock.now()).toBe(2 * DIALOG_POLL_INTERVAL_MS)
  })

  // -------------------------------------------------------------------------
  // b.vub — ErrTmuxSessionCreate self-heal (kill orphan tmux + retry once)
  // -------------------------------------------------------------------------

  test('b.vub: ErrTmuxSessionCreate on resume → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    installStub({
      spawnCalls,
      // 1st spawn: instance-id collision → get=missing → resume throws tmux-create
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        // 2nd spawn (the self-heal retry) succeeds
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      getResult: personaRow(cfg, 'C', { state: 'missing' }),
      resumeError: errTmuxSessionCreate('resume'),
      // approver on the retry-spawn: already live → returns immediately
      statusResult: { state: 'waiting' },
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('spawned')
    // Orphan tmux killed by its deterministic per-channel name.
    expect(killedSessions).toEqual(['slack_bot_C'])
    // Exactly one retry spawn after the collision spawn (2 spawn calls total).
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate on fresh spawn → kill orphan tmux by name + retry spawn once', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installStub({
      spawnCalls,
      // 1st fresh spawn throws tmux-create (no instance-id collision) → self-heal
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C' }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual(['slack_bot_C'])
    expect(spawnCalls).toHaveLength(2)
  })

  test('b.vub: ErrTmuxSessionCreate self-heal kills slack_bot_<key> for a persona whose key differs from its name', async () => {
    const killedSessions: string[] = []
    _setTmuxSessionKiller(async (name) => { killedSessions.push(name) })
    const key = personaKey('my chan')
    expect(key).not.toBe('my chan')
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${key}` }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeMultiPersonaConfig([{ name: 'my chan', working_directory: '/x' }], fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, key), cfg)

    expect(result.action).toBe('spawned')
    expect(killedSessions).toEqual([`slack_bot_${key}`])
  })

  test('b.vub: ErrTmuxSessionCreate self-heal that fails on retry → spawn-failure notice to the persona destination', async () => {
    _setTmuxSessionKiller(async () => { /* orphan killed but retry still fails */ })
    const readLog = captureStartupErrors()
    installStub({
      // fresh spawn throws tmux-create; retry spawn also throws (generic)
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
      ],
    })
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()

    expect(result.action).toBe('failed')
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain(`Error: \`${errTmuxSessionCreate('spawn').errName}\``)
    expect(readLog()).toContain('[spawn-failed]')
  })

  // -------------------------------------------------------------------------
  // AC 20 (b.av2 SR-10.3): the approver's status and readPane/sendKeys error
  // lines log describeAgentDirectorFailure of the error (type, safe code or
  // errName, redacted message, frames), never the error or its raw message.
  // Each error carries fake tokens in its message and properties; every
  // console.error argument is kept unformatted (errors whole).
  // -------------------------------------------------------------------------

  /** An error at `site` whose message and properties carry fake tokens, with a safe code. */
  const tokenError = (site: string): Error =>
    Object.assign(new Error(leakyMessage(`${site} refused`, site)), {
      code: 'ECONNRESET',
      detail: fakeToken(APP_TOKEN_PREFIX, site),
      note: LEAK_SENTINEL,
    })

  test.each<[string, () => { err: Error; opts: StubClientOptions }, (failure: string) => string, string]>([
    [
      'status',
      () => {
        const err = tokenError('status')
        return { err, opts: { statusQueue: [cannedErr(err), ...statusReads('waiting')] } }
      },
      (failure) => approverStatusRefusedMessage(C_REF, failure),
      `Error code=ECONNRESET message=${JSON.stringify(redactedLeakyMessage('status refused'))}`,
    ],
    [
      'readPane (pending row)',
      () => {
        const err = tokenError('readpane')
        return { err, opts: { statusQueue: statusReads('pending', 'waiting'), readPaneError: err } }
      },
      (failure) => approverPaneCallFailedMessage(C_REF, 'read-pane', failure),
      `Error code=ECONNRESET message=${JSON.stringify(redactedLeakyMessage('readpane refused'))}`,
    ],
    [
      'sendKeys (pending row, needle on screen)',
      () => {
        const err = errGeneric('send-keys', 'ErrSendKeysBroken', leakyMessage('refused', 'sendkeys'))
        return {
          err,
          opts: { statusQueue: statusReads('pending', 'waiting'), readPaneResults: [{ pane: DEV_CHANNELS_PANE }], sendKeysError: err },
        }
      },
      (failure) => approverPaneCallFailedMessage(C_REF, 'send-keys', failure),
      `ErrSendKeysBroken message=${JSON.stringify(redactedLeakyMessage('refused'))}`,
    ],
  ])('AC 20: a %s error carrying fake tokens — one approver line naming the error with its redacted message; the approver goes on to the ready state; nothing logged leaks', async (_label, arrange, message, shown) => {
    const clock = useApproverClock()
    const { err, opts } = arrange()
    installStub(opts)
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    let stop: ApproverStopReason | undefined
    try {
      stop = await runOnApproverClock(clock, approvePreSessionDialogs('C', false, C_REF))
    } finally {
      console.error = orig
    }

    expect(stop).toBe(APPROVER_STOP_LIVE)
    const lines = errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.startsWith(APPROVER_LOG_PREFIX))
    expect(lines).toEqual([approverLogLine(message(describeAgentDirectorFailure(err)))])
    expect(lines[0]).toContain(`failed: ${shown}`)
    assertNoLeak({ errArgs })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-401 — the approver after every launch that returns success,
// outside the launch call
//
// Every spawn or `resume` of the collision ladder that returns success starts
// the persona's dialog approver on its own; `spawnForPersona` returns the
// launch's result as soon as the launch call returns, and the approver's
// first call comes once the launch has settled, so `isLaunchInFlight` is
// false while only the approver runs. No other branch, result or dry run
// starts one, and a stop made while the launch is in flight cancels the
// approver that launch would start. Each case runs the approver on a fake
// clock (`useApproverClock`): a launch settles with that clock held
// (`settleOffApproverClock`), so a launch that waited for its approver would
// fail the case, and the approver then runs to its stop
// (`runOnApproverClock` over `_whenDialogApproverStopped`). Every
// agent-director call is recorded with whether a launch of the persona was
// in flight when it was made (`recordCallsWithInFlight`).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-401: the approver runs after every launch that returns success, outside the launch call', () => {
  const KEY = 'C'
  const ID = personaInstanceId(KEY)
  const REF = renderPersonaRef(KEY, KEY)
  /** The launch start the approver's `pending` read shows. */
  const LAUNCH_START = SAMPLE_LAUNCH_START_WHOLE

  /** One agent-director call: its verb, the instance it names and whether a launch of the persona was in flight when it was made. */
  interface CallInFlight {
    readonly verb: string
    readonly id: string
    readonly inFlight: boolean
  }

  /** The verbs a launch or its approver can call. */
  const RECORDED_VERBS = ['spawn', 'resume', 'status', 'get', 'readPane', 'sendKeys', 'kill', 'delete', 'findMissing'] as const

  /** Record each call of `RECORDED_VERBS` through `stub` from now on, in order, with `isLaunchInFlight(key)` at the call. */
  function recordCallsWithInFlight(stub: StubClient, key: string): CallInFlight[] {
    const calls: CallInFlight[] = []
    const client = stub as unknown as Record<string, (params: { claude_instance_id?: unknown }) => Promise<unknown>>
    for (const verb of RECORDED_VERBS) {
      const original = client[verb]!
      client[verb] = (params) => {
        calls.push({ verb, id: String(params.claude_instance_id), inFlight: isLaunchInFlight(key) })
        return original.call(stub, params)
      }
    }
    return calls
  }

  /**
   * The `status` answers for persona `key`: `waiting` while its launch is in
   * flight (the ladder's own reads), and after it the approver's laps:
   * `pending` with `LAUNCH_START`, then `waiting`.
   */
  function approverReadsPendingThenLive(key: string): () => Phase1StatusResult {
    let laps = 0
    return () => {
      if (isLaunchInFlight(key)) return cannedStatusResult({ state: 'waiting' })
      laps++
      return laps === 1 ? cannedStatusResult({ state: 'pending', launch_started_at: LAUNCH_START }) : cannedStatusResult({ state: 'waiting' })
    }
  }

  /** The approver's calls for one launch that reads `pending`, then live: a lap with its pane read, then a lap that stops it. */
  const APPROVER_LAPS: readonly CallInFlight[] = ['status', 'readPane', 'status'].map((verb) => ({ verb, id: ID, inFlight: false }))

  /** Persona `C` in a real working directory; `overrides` go to the whole config. */
  function launchConfig(overrides: Partial<Omit<PersonaConfig, 'personas'>> = {}): PersonaConfig {
    return makeStandInPersonaConfig({ [KEY]: { working_directory: fixtureSubdir('work') } }, fixtureDir, overrides)
  }

  type SpawnResultOf = import('agent-director').SpawnResult
  const collision = () => cannedErr<SpawnResultOf>(errInstanceIdCollision())
  const spawnOk = () => cannedOk<SpawnResultOf>({ claude_instance_id: ID })

  /** A success site of the ladder: the stub answers that reach it, the config it needs, the launch call's verb and the launch's result. */
  interface SuccessSite {
    readonly script: (cfg: PersonaConfig) => StubClientOptions
    readonly config?: Partial<Omit<PersonaConfig, 'personas'>>
    readonly launchVerb: 'spawn' | 'resume'
    readonly action: SpawnPersonaResult['action']
  }

  /** The persona's row reading `ended`, its labels its current ones. */
  const endedRow = (cfg: PersonaConfig) => personaRow(cfg, KEY, { state: 'ended' })
  /** A collision on the persona's `ended` row whose `resume` answers `err`, then a fresh spawn that succeeds. */
  const resumeAnswers = (err: Error) => (cfg: PersonaConfig): StubClientOptions => ({
    spawnQueue: [collision(), spawnOk()],
    getResult: endedRow(cfg),
    resumeError: err,
  })

  const SUCCESS_SITES: ReadonlyArray<readonly [string, SuccessSite]> = [
    ['the first spawn', { script: () => ({}), launchVerb: 'spawn', action: 'spawned' }],
    [
      'the retry spawn after the collision get answers ErrSpawnNotFound',
      { script: () => ({ spawnQueue: [collision(), spawnOk()], getError: errSpawnNotFound() }), launchVerb: 'spawn', action: 'spawned' },
    ],
    [
      'the self-heal spawn after ErrTmuxSessionCreate on the first spawn',
      { script: () => ({ spawnQueue: [cannedErr<SpawnResultOf>(errTmuxSessionCreate('spawn')), spawnOk()] }), launchVerb: 'spawn', action: 'spawned' },
    ],
    ['the self-heal spawn after ErrTmuxSessionCreate on resume', { script: resumeAnswers(errTmuxSessionCreate('resume')), launchVerb: 'spawn', action: 'spawned' }],
    [
      'the self-heal spawn after ErrTmuxSessionCreate on a replacement\'s fresh spawn',
      {
        script: (cfg) => ({ spawnQueue: [collision(), cannedErr<SpawnResultOf>(errTmuxSessionCreate('spawn')), spawnOk()], getResult: endedRow(cfg) }),
        config: { resume_enabled: false },
        launchVerb: 'spawn',
        action: 'spawned',
      },
    ],
    [
      'the fresh spawn of a replacement of a row in another directory (kill, delete, spawn)',
      {
        script: (cfg) => ({ spawnQueue: [collision(), spawnOk()], getResult: personaRow(cfg, KEY, { state: 'waiting', cwd: fixtureSubdir('elsewhere') }) }),
        launchVerb: 'spawn',
        action: 'spawned',
      },
    ],
    [
      'the fresh spawn of a replacement of a row whose config_dir label changed (delete, spawn)',
      {
        script: (cfg) => {
          const labels = { ...endedRow(cfg).labels, config_dir: personaConfigDirLabelValue(fixtureSubdir('earlier-config'), ladderHome()) }
          return { spawnQueue: [collision(), spawnOk()], getResult: personaRow(cfg, KEY, { state: 'ended', labels }) }
        },
        launchVerb: 'spawn',
        action: 'spawned',
      },
    ],
    [
      'the fresh spawn of a replacement with resume_enabled false (kill, delete, spawn)',
      { script: (cfg) => ({ spawnQueue: [collision(), spawnOk()], getResult: endedRow(cfg) }), config: { resume_enabled: false }, launchVerb: 'spawn', action: 'spawned' },
    ],
    ['the amnesia spawn after resume\'s ErrNoSessionId', { script: resumeAnswers(errNoSessionId()), launchVerb: 'spawn', action: 'spawned' }],
    ['the amnesia spawn after resume\'s ErrJsonlMissing', { script: resumeAnswers(errJsonlMissing()), launchVerb: 'spawn', action: 'fresh-after-inconclusive-amnesia' }],
    ['the amnesia spawn after resume\'s ErrJsonlNeverWritten', { script: resumeAnswers(errJsonlNeverWritten()), launchVerb: 'spawn', action: 'spawned' }],
    ['the spawn after resume\'s ErrSpawnNotResumable (kill, delete, spawn)', { script: resumeAnswers(errSpawnNotResumable()), launchVerb: 'spawn', action: 'spawned' }],
    ['the spawn after resume\'s ErrSpawnNotFound', { script: resumeAnswers(errSpawnNotFound()), launchVerb: 'spawn', action: 'spawned' }],
    [
      'the resume of an ended row',
      { script: (cfg) => ({ spawnQueue: [collision()], getResult: endedRow(cfg) }), launchVerb: 'resume', action: 'resumed' },
    ],
    [
      'the resume of a missing row',
      { script: (cfg) => ({ spawnQueue: [collision()], getResult: personaRow(cfg, KEY, { state: 'missing' }) }), launchVerb: 'resume', action: 'resumed' },
    ],
  ]

  /**
   * Assert `calls`: the launch's last call is its launch call `launchVerb` on
   * P's instance (the approver makes no spawn or `resume`), and every call
   * after it is the approver's, on P's instance with no launch in flight,
   * exactly `APPROVER_LAPS`. Every launch call but the ladder's very first is
   * made with the launch in flight; that one is issued as the launch starts.
   */
  function expectLaunchThenApprover(calls: readonly CallInFlight[], launchVerb: string): void {
    let launchCall = calls.length - 1
    while (launchCall >= 0 && calls[launchCall]!.verb !== 'spawn' && calls[launchCall]!.verb !== 'resume') launchCall--
    expect(launchCall).toBeGreaterThanOrEqual(0)
    expect(calls[launchCall]).toMatchObject({ verb: launchVerb, id: ID })
    expect(calls.slice(1, launchCall + 1).every((c) => c.inFlight)).toBe(true)
    expect(calls.slice(launchCall + 1)).toEqual([...APPROVER_LAPS])
  }

  test.each(SUCCESS_SITES)('%s: spawnForPersona returns the launch\'s own result while the approver still runs, with no launch in flight and the launch settled; then P\'s status and read-pane follow the launch call on P\'s row, until a live read stops the approver', async (_name, site) => {
    const clock = useApproverClock()
    _setTmuxSessionKiller(async () => {})
    const cfg = launchConfig(site.config)
    const stub = installStub({ ...site.script(cfg), statusFn: approverReadsPendingThenLive(KEY) })
    const calls = recordCallsWithInFlight(stub, KEY)

    let result: SpawnPersonaResult | undefined
    let outcome: ApproverOutcome | undefined
    let runningAtReturn: boolean | undefined
    let inFlightAtReturn: boolean | undefined
    const errLog = await withCapturedErr(async () => {
      result = await settleOffApproverClock(spawnForPersona(personaOf(cfg, KEY), cfg))
      runningAtReturn = isDialogApproverRunning(KEY)
      inFlightAtReturn = isLaunchInFlight(KEY)
      await settleOffApproverClock(whenLaunchSettled(KEY))
      outcome = await runOnApproverClock(clock, _whenDialogApproverStopped(KEY))
    })

    expect(result).toStrictEqual({ key: KEY, action: site.action })
    // Returned while its approver runs: the approver is outside the launch call.
    expect(runningAtReturn).toBe(true)
    expect(inFlightAtReturn).toBe(false)
    expectLaunchThenApprover(calls, site.launchVerb)
    expect(outcome).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: Date.parse(LAUNCH_START) })
    expect(isDialogApproverRunning(KEY)).toBe(false)
    expect(clock.now()).toBe(DIALOG_POLL_INTERVAL_MS)
    assertNoLeak({ errLog })
  })

  test('a launchSession launch (the restart path, isStartup false) runs it too: launchSession answers true while the approver still runs, and P\'s status and read-pane follow the spawn; no startup entry', async () => {
    const clock = useApproverClock()
    const readLog = captureStartupErrors()
    const cfg = launchConfig()
    const stub = installStub({ statusFn: approverReadsPendingThenLive(KEY) })
    const calls = recordCallsWithInFlight(stub, KEY)

    let launched: Awaited<ReturnType<typeof launchSession>> | undefined
    let runningAtReturn: boolean | undefined
    const errLog = await withCapturedErr(async () => {
      launched = await settleOffApproverClock(launchSession(KEY, cfg))
      runningAtReturn = isDialogApproverRunning(KEY)
      await runOnApproverClock(clock, _whenDialogApproverStopped(KEY))
    })

    expect(launched).toBe(true)
    expect(runningAtReturn).toBe(true)
    expect(isLaunchInFlight(KEY)).toBe(false)
    expectLaunchThenApprover(calls, 'spawn')
    expect(await _whenDialogApproverStopped(KEY)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: Date.parse(LAUNCH_START) })
    expect(readLog()).toBe('')
    assertNoLeak({ errLog })
  })

  /** A launch that returns no success: what reaches it and its result. */
  interface NoLaunchPath {
    readonly arrange: (cfg: PersonaConfig) => { cfg?: PersonaConfig; opts: StubClientOptions }
    readonly config?: Partial<Omit<PersonaConfig, 'personas'>>
    readonly action: SpawnPersonaResult['action']
    readonly refused?: true
  }

  const NO_LAUNCH_PATHS: ReadonlyArray<readonly [string, NoLaunchPath]> = [
    [
      'a collision on a waiting row (reconnected)',
      {
        arrange: (cfg) => {
          _setTmuxServerEnsurer(async () => {})
          return { opts: { spawnQueue: [collision()], getResult: personaRow(cfg, KEY, { state: 'waiting' }) } }
        },
        action: 'reconnected',
      },
    ],
    [
      'a collision on a working row (the wait reads waiting and reconnects)',
      {
        arrange: (cfg) => {
          _setTmuxServerEnsurer(async () => {})
          return { opts: { spawnQueue: [collision()], getResult: personaRow(cfg, KEY, { state: 'working' }) } }
        },
        config: { agent_director_poll_interval_ms: 1 },
        action: 'reconnected',
      },
    ],
    [
      'a collision on a row waiting on a prompt whose tmux session lives (no-op)',
      { arrange: (cfg) => ({ opts: { spawnQueue: [collision()], getResult: personaRow(cfg, KEY, { state: 'ask_user' }), statusResult: cannedStatusResult({ state: 'ask_user' }) } }), action: 'no-op' },
    ],
    [
      'a collision on a pending row (no-op)',
      { arrange: (cfg) => ({ opts: { spawnQueue: [collision()], getResult: personaRow(cfg, KEY, { state: 'pending' }) } }), action: 'no-op' },
    ],
    [
      'a latched persona (latched)',
      {
        arrange: () => {
          const latch: SessionConflictLatch = {
            isLatched: () => true,
            record: () => undefined,
            set: () => {
              throw new Error('no latch is set here')
            },
            setFromConflict: () => {
              throw new Error('no latch is set here')
            },
          }
          setConflictLatch(latch)
          return { opts: {} }
        },
        action: 'latched',
      },
    ],
    [
      'a spawn that fails (ErrCwdNotFound: failed)',
      { arrange: (cfg) => ({ opts: { spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${personaOf(cfg, KEY).working_directory} does not exist`) } }), action: 'failed' },
    ],
    [
      'a spawn that is refused (an UNAVAILABLE answer: failed, refused)',
      {
        arrange: () => {
          // As `main()` wires it: the trigger sink arms P's timer, so the attempt is refused.
          initOutageState({ getClient, notify: () => {}, triggerSink: { arm: () => true } })
          return { opts: { spawnError: unavailableForms('ErrCallTimeout')[0]![1]('spawn') } }
        },
        action: 'failed',
        refused: true,
      },
    ],
    [
      'a launch deferred on an unresolvable claude_config_dir (deferred)',
      {
        arrange: () => {
          const configDir = fixtureSubdir('claude-config')
          const cfg = makeStandInPersonaConfig({ [KEY]: { working_directory: fixtureSubdir('deferred-work'), claude_config_dir: configDir } }, fixtureDir)
          setConfigDirUnresolvableHook(() => false)
          _setConfigDirFs({ realpath: realpathFailingUnder(configDir, () => true) })
          return { cfg, opts: {} }
        },
        action: 'deferred',
      },
    ],
    [
      'a dry run (no-op)',
      {
        arrange: () => {
          process.env['SLACK_DRY_RUN'] = '1'
          return { opts: {} }
        },
        action: 'no-op',
      },
    ],
  ]

  test.each(NO_LAUNCH_PATHS)('no approver without a launch that returns success: %s starts none — no approver running or stopped for P, no approver line, no call after the launch', async (_name, path) => {
    useApproverClock()
    const base = launchConfig(path.config)
    const { cfg = base, opts } = path.arrange(base)
    const stub = installStub(opts)
    const calls = recordCallsWithInFlight(stub, KEY)

    let result: SpawnPersonaResult | undefined
    let callsAtReturn = 0
    const errLog = await withCapturedErr(async () => {
      result = await settleOffApproverClock(spawnForPersona(personaOf(cfg, KEY), cfg))
      callsAtReturn = calls.length
      // Turns enough for an approver the launch had started to make its first call.
      await settleOffApproverClock(new Promise<void>((resolve) => setTimeout(resolve, 0)))
    })

    expect(result?.action).toBe(path.action)
    expect(result?.refused).toBe(path.refused)
    expect(isDialogApproverRunning(KEY)).toBe(false)
    // An approver that had started would still run (its stub reads `waiting`
    // stop it at its first lap) or have left its outcome.
    expect(await _whenDialogApproverStopped(KEY)).toBeUndefined()
    expect(calls.slice(callsAtReturn)).toEqual([])
    // No call but the ladder's first was made with no launch in flight.
    expect(calls.slice(1).filter((c) => !c.inFlight)).toEqual([])
    expect(linesWith(errLog, APPROVER_LOG_PREFIX)).toEqual([])
    assertNoLeak({ errLog })
  })

  test('a stop made while P\'s launch is held in flight cancels the approver that launch would start: the launch still returns spawned, its approver makes no call (one not-started line); the next launch\'s approver runs', async () => {
    const clock = useApproverClock()
    const cfg = launchConfig()
    const stub = installStub({ statusFn: approverReadsPendingThenLive(KEY) })
    let first = true
    const hold = holdSpawns(stub, () => {
      const held = first
      first = false
      return held
    })
    const calls = recordCallsWithInFlight(stub, KEY)

    let heldResult: SpawnPersonaResult | undefined
    let stopped: boolean | undefined
    let inFlightAtStop: boolean | undefined
    const errLog = await withCapturedErr(async () => {
      const launching = spawnForPersona(personaOf(cfg, KEY), cfg)
      await hold.entered(ID)
      inFlightAtStop = isLaunchInFlight(KEY)
      stopped = await stopDialogApprover(KEY, APPROVER_STOP_TEARDOWN)
      hold.release(ID)
      heldResult = await settleOffApproverClock(launching)
      await settleOffApproverClock(new Promise<void>((resolve) => setTimeout(resolve, 0)))
    })

    expect(inFlightAtStop).toBe(true)
    // No approver ran when the stop was made.
    expect(stopped).toBe(false)
    expect(heldResult).toStrictEqual({ key: KEY, action: 'spawned' })
    expect(isDialogApproverRunning(KEY)).toBe(false)
    expect(await _whenDialogApproverStopped(KEY)).toBeUndefined()
    // Only the held spawn: no approver call followed it.
    expect(calls.map((c) => [c.verb, c.id])).toEqual([['spawn', ID]])
    expect(linesWith(errLog, APPROVER_LOG_PREFIX)).toEqual([approverLogLine(approverNotStartedMessage(REF, APPROVER_STOP_TEARDOWN))])

    // The stop ended with that launch: the next launch's approver runs.
    const next = await launchThenRunApprover(clock, KEY, spawnForPersona(personaOf(cfg, KEY), cfg))
    expect(next).toStrictEqual({ key: KEY, action: 'spawned' })
    expect(await _whenDialogApproverStopped(KEY)).toEqual({ reason: APPROVER_STOP_LIVE, launchStartMs: Date.parse(LAUNCH_START) })
    expectLaunchThenApprover(calls.slice(1), 'spawn')
    expect(calls.slice(1).map((c) => c.verb)).toEqual(['spawn', ...APPROVER_LAPS.map((c) => c.verb)])
    assertNoLeak({ errLog })
  })
})

// ---------------------------------------------------------------------------
// b.en2 Epic 4 — wrapper-migration assertions
// ---------------------------------------------------------------------------

// Shared constants for wrapper tests
const BIN = '/usr/bin/agent-director'
const CWD = '/test/cwd'

// ---------------------------------------------------------------------------
// Group A: 13 non-dialog wrapped catch sites
// Each asserts: outage-class typed error raises the matching flag AND
// no spawn-failure notice is raised.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// b.1ix — raw tmux calls address the persona's own session exactly
// ---------------------------------------------------------------------------

describe('b.1ix: raw tmux calls target the persona’s own session exactly, never a prefix neighbour', () => {
  /**
   * A tmux server behind the runner seam: live sessions by name. It resolves
   * a session target as tmux 3.2a does (checked in the `/ci` image):
   * `=<name>` is only that exact session; a bare name is the exact session,
   * else the one session it prefixes (the hazard).
   */
  function fakeTmuxServer(sessions: string[]) {
    const alive = new Set(sessions)
    const argvs: string[][] = []
    const resolve = (target: string): string | undefined => {
      if (target.startsWith('=')) return alive.has(target.slice(1)) ? target.slice(1) : undefined
      if (alive.has(target)) return target
      const prefixed = [...alive].filter((s) => s.startsWith(target))
      return prefixed.length === 1 ? prefixed[0] : undefined
    }
    const runner: TmuxCommandRunner = async (args) => {
      argvs.push([...args])
      const session = resolve(args[args.indexOf('-t') + 1]!)
      if (session === undefined) return { code: 1, stdout: '' }
      if (args[0] === 'kill-session') alive.delete(session)
      return { code: 0, stdout: '' }
    }
    return { runner, alive, argvs }
  }

  const NEIGHBOUR_ONLY = ['slack_bot_dev_2']
  const BOTH = ['slack_bot_dev', 'slack_bot_dev_2']

  test.each([
    ['only its prefix neighbour slack_bot_dev_2 exists', NEIGHBOUR_ONLY],
    ['it and slack_bot_dev_2 both exist', BOTH],
  ])('the b.vub self-heal kill for persona dev, when %s: kill-session -t =slack_bot_dev, and slack_bot_dev_2 survives', async (_label, sessions) => {
    const tmux = fakeTmuxServer(sessions)
    _setTmuxCommandRunner(tmux.runner)
    _resetTmuxSessionKiller()
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errTmuxSessionCreate('spawn')),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_dev' }),
      ],
      statusResult: { state: 'waiting' },
    })
    const cfg = makeMultiPersonaConfig([{ name: 'dev', working_directory: '/x' }], fixtureDir)

    expect((await spawnForPersona(personaOf(cfg, 'dev'), cfg)).action).toBe('spawned')

    expect(tmux.argvs).toEqual([['kill-session', '-t', '=slack_bot_dev']])
    expect([...tmux.alive]).toEqual(['slack_bot_dev_2'])
  })

  test.each([
    ['only its prefix neighbour slack_bot_dev_2 exists', false, NEIGHBOUR_ONLY],
    ['it and slack_bot_dev_2 both exist', true, BOTH],
  ])('the liveness probe for persona dev, when %s: has-session -t =slack_bot_dev reads alive=%p', async (_label, alive, sessions) => {
    const tmux = fakeTmuxServer(sessions)
    _setTmuxCommandRunner(tmux.runner)
    _resetTmuxSessionProber()

    expect(await hasPersonaTmuxSession('dev')).toBe(alive)
    expect(tmux.argvs).toEqual([['has-session', '-t', '=slack_bot_dev']])
  })

  test('src/ starts tmux in one place only, the runner, so no raw call can skip its exact targets', () => {
    const srcDir = join(import.meta.dir, '..', 'src')
    const tmuxLaunch = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]tmux['"`]|\bBun\.spawn(?:Sync)?\(\s*\[\s*['"`]tmux['"`]|\$`tmux\b/g
    const sites = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...stripComments(readFileSync(join(srcDir, f), 'utf-8')).matchAll(tmuxLaunch)].map(() => f))
    expect(sites).toEqual(['session-manager.ts'])
  })
})

describe('wrapper-migration: non-dialog outage cases (Group A)', () => {
  // -------------------------------------------------------------------------
  // Site #1 — reconnectMcp → sendKeys
  // -------------------------------------------------------------------------

  test('site #1: reconnectMcp ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({ sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN) })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  test('site #1b: reconnectMcp ErrTmuxNotAvailable → tmux-unavailable, no spawn-failure notice', async () => {
    installStub({ sendKeysError: new ErrTmuxNotAvailable('send-keys', 'ErrTmuxNotAvailable', 'tmux not available') })
    const result = await reconnectMcp('C')
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('tmux-unavailable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #8 — waitForWaitingAndReconnect → status
  // -------------------------------------------------------------------------

  test('site #8: waitForWaitingAndReconnect ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    _setWaitForWaitingTimeoutMs(50)
    installStub({ statusError: new ErrSystemInstallDisappeared('status', BIN) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await waitForWaitingAndReconnect('C', cfg)
    expect(result).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #9 — tryKill → kill (tested via spawnForPersona collision path)
  // ErrSystemInstallDisappeared is UNCLASSIFIED (b.jg5 SRJ-104): at the kill
  // it is a refusal (SRJ-105's UNCLASSIFIED row, SRJ-313), so nothing is
  // deleted or launched after it, and the wrapper still raises the outage
  // flag.
  // -------------------------------------------------------------------------

  test('site #9: tryKill kill ErrSystemInstallDisappeared → ad-unreachable, refused (b.jg5 SRJ-105, SRJ-313): no delete or launch after it, no spawn-failure notice', async () => {
    // collision → get=ended → resume_enabled=false → kill throws (flag set, refused)
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    const calls = newLadderCalls()
    installStub({
      ...calls,
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      killError: new ErrSystemInstallDisappeared('kill', BIN),
    })
    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })
    expect(result.action).toBe('failed')
    expect(calls.killCalls).toHaveLength(1)
    expect(calls.deleteCalls).toHaveLength(0)
    expect(calls.spawnCalls).toHaveLength(1) // the colliding spawn only: the refused kill stops the chain
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
    expect(errLog.split('\n').filter((l) => l.startsWith(`[slack] spawnForPersona: kill refused for ${renderPersonaRef('C', 'C')}: `))).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Site #10 — tryDelete → delete
  // -------------------------------------------------------------------------

  test('site #10: tryDelete delete ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      // kill succeeds; delete fails with typed outage error
      deleteError: new ErrSystemInstallDisappeared('delete', BIN),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #11 — spawnForPersona initial spawn (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #11: initial spawn ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({ spawnError: new ErrSystemInstallDisappeared('spawn', BIN) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  test('site #11b: initial spawn ErrCwdNotFound → cwd-unreachable with the persona working_directory as detail, no spawn-failure notice', async () => {
    installStub({ spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    // The detail is the persona's working_directory (withSpawnDetection's
    // workingDirectory arg), in an onset notice for the persona key
    expect(outageEmissions.some(e => e.key === 'C' && e.text.includes(CWD))).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #12 — spawnForPersona collision-get (withOutageDetection)
  // -------------------------------------------------------------------------

  test('site #12: collision-get ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getError: new ErrSystemInstallDisappeared('get', BIN),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #13 — spawnForPersona retry-spawn after ErrSpawnNotFound
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #14 — spawnForPersona fresh-spawn after kill+delete (resume_enabled=false)
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete ErrCwdNotFound → cwd-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #15 — spawnForPersona resume (withSpawnDetection)
  // -------------------------------------------------------------------------

  test('site #15: resume ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: new ErrSystemInstallDisappeared('resume', BIN),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #16 — spawnForPersona spawn after ErrNoSessionId → delete → spawn
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete ErrCwdNotFound → cwd-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrCwdNotFound('spawn', 'ErrCwdNotFound', `cwd ${CWD} does not exist`)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('cwd-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Site #17 — spawnForPersona spawn after ErrSpawnNotResumable → kill+delete → spawn
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete ErrSystemInstallDisappeared → ad-unreachable, no spawn-failure notice', async () => {
    const cfg = makeStandInPersonaConfig({ C: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedErr(new ErrSystemInstallDisappeared('spawn', BIN)),
      ],
      getResult: personaRow(cfg, 'C', { state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    expect(result.action).toBe('failed')
    expect(getOutageFlags('C').has('ad-unreachable')).toBe(true)
    expect(notices).toHaveLength(0)
  })

})

// ---------------------------------------------------------------------------
// Group B: the dialog approver's wrapped catch sites
// Each asserts: (a) the approver resolves with its stop reason, (b)
// ad-unreachable flag is raised, (c) binaryPath detail is captured in the
// onset emission. Runs on the approver's fake clock (`useApproverClock`).
// ---------------------------------------------------------------------------

describe('wrapper-migration: dialog outage cases (Group B)', () => {
  const CH = 'C_DIALOG'
  const errSID = () => new ErrSystemInstallDisappeared('read-pane', BIN)

  // -------------------------------------------------------------------------
  // Merged approvePreSessionDialogs — 3 wrapped call sites: status, readPane,
  // sendKeys. Each exercises an AD-outage error at one site, asserting the
  // outage flag is raised and the approver polls on to its cap, on a fake
  // clock (`useApproverClock`), and answers `cap`.
  // -------------------------------------------------------------------------

  /** A short cap: four laps at the approver's pace. */
  const CAP_MS = 4 * DIALOG_POLL_INTERVAL_MS

  test.each<[string, () => StubClientOptions]>([
    ['status outage: status always throws ErrSystemInstallDisappeared', () => ({ statusError: errSID() })],
    [
      'readPane outage: status=pending, readPane throws ErrSystemInstallDisappeared',
      () => ({ statusResult: cannedStatusResult({ state: 'pending' }), readPaneError: errSID() }),
    ],
    [
      // readPane returns the dialog needle so sendKeys is reached; sendKeys throws
      'sendKeys outage: status=pending + dialog pane, sendKeys throws ErrSystemInstallDisappeared',
      () => ({
        statusResult: cannedStatusResult({ state: 'pending' }),
        readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_PANE }],
        sendKeysError: new ErrSystemInstallDisappeared('send-keys', BIN),
      }),
    ],
  ])('%s → ad-unreachable, polls on and resolves cap at the cap', async (_label, opts) => {
    const clock = useApproverClock()
    _setDialogReadyTimeoutMs(CAP_MS)
    const statusCalls: import('agent-director').StatusParams[] = []
    installStub({ ...opts(), statusCalls })

    expect(await runOnApproverClock(clock, approvePreSessionDialogs(CH, false))).toBe(APPROVER_STOP_CAP)

    expect(clock.now()).toBe(CAP_MS)
    expect(statusCalls).toHaveLength(CAP_MS / DIALOG_POLL_INTERVAL_MS)
    expect(getOutageFlags(CH).has('ad-unreachable')).toBe(true)
    expect(outageEmissions.some(e => e.key === CH && e.text.includes(BIN))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group C: spawn/resume success-clear (sites #11, #13, #14, #15, #16, #17)
// Each pre-sets all three outage flags then exercises a spawn/resume success
// path, asserting flags are empty and exactly one all-clear was emitted
// naming all three classes.
// ---------------------------------------------------------------------------

describe('wrapper-migration: spawn/resume success-clear (Group C)', () => {
  const CH = 'C_CLEAR'

  function setupFlags(): void {
    preSetAllFlags(CH)
    outageEmissions = [] // reset after pre-set; only capture all-clear from success path
  }

  function assertAllClear(): void {
    expect(getOutageFlags(CH).size).toBe(0)
    const allClear = outageEmissions.filter(e => e.key === CH && e.text.includes('All clear'))
    expect(allClear).toHaveLength(1)
    expect(allClear[0].text).toContain('ad-unreachable')
    expect(allClear[0].text).toContain('cwd-unreachable')
    expect(allClear[0].text).toContain('tmux-unavailable')
  }

  // -------------------------------------------------------------------------
  // Site #11 — initial spawn success
  // -------------------------------------------------------------------------

  test('site #11: initial spawn success clears all three flags + emits all-clear', async () => {
    setupFlags()
    installStub({})
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #13 — retry-spawn after ErrSpawnNotFound success
  // -------------------------------------------------------------------------

  test('site #13: retry-spawn after ErrSpawnNotFound success clears all three flags', async () => {
    setupFlags()
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getError: errSpawnNotFound(),
    })
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #14 — fresh-spawn after kill+delete (resume_enabled=false) success
  // -------------------------------------------------------------------------

  test('site #14: fresh-spawn after kill+delete (resume_enabled=false) clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { resume_enabled: false })
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #15 — resume success
  // -------------------------------------------------------------------------

  test('site #15: resume success clears all three flags + emits all-clear', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('resumed')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #16 — fresh-spawn after ErrNoSessionId → delete → spawn success
  // -------------------------------------------------------------------------

  test('site #16: spawn after ErrNoSessionId-delete success clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })

  // -------------------------------------------------------------------------
  // Site #17 — fresh-spawn after ErrSpawnNotResumable → kill+delete → spawn success
  // -------------------------------------------------------------------------

  test('site #17: spawn after ErrSpawnNotResumable kill+delete success clears all three flags', async () => {
    setupFlags()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errSpawnNotResumable(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, false)
    expect(result.action).toBe('spawned')
    assertAllClear()
  })
})

// ---------------------------------------------------------------------------
// b.wrb — ErrJsonlMissing amnesia: legible diagnostic + honest startup counters
//
// When resume throws ErrJsonlMissing, CSCB still delete+fresh-spawns (policy
// unchanged), but must now: (1) log which transcript path(s) were tried and
// their source; (2) classify never-created (quiet, lossless) vs lost
// (operator-visible) vs unknown (row fetch failed); (3) count the fresh-spawn
// as its own 'fresh-after-amnesia' bucket instead of folding it into "ok".
// ---------------------------------------------------------------------------

describe('b.wrb: ErrJsonlMissing amnesia diagnostic + honest counters', () => {
  const CH = 'C_WRB'
  const CWD = '/repo/wrb'

  // Cleanup handles for temp archive dirs built during this suite (drained in afterEach).
  const archiveCleanups: Array<() => void> = []

  afterEach(() => {
    while (archiveCleanups.length > 0) archiveCleanups.pop()!()
  })

  /** Build a temp archive DB holding `count` post-spawn messages for CH. */
  function makeArchiveWithMessagesSince(startedAt: string, count: number): string {
    const built = messagesSince(startedAt, CH, count)
    archiveCleanups.push(built.cleanup)
    return built.dbPath
  }

  /**
   * Install a stub that drives the ErrJsonlMissing amnesia path: a colliding
   * spawn resolves to an `ended` row, resume rejects with ErrJsonlMissing, then
   * delete + a fresh spawn succeeds. `getResult` is returned for both the
   * collision-recovery get and the diagnostic get.
   */
  function installAmnesia(opts: {
    /** The applied configuration; the row is `personaRow(cfg, key, …)`. */
    cfg: PersonaConfig
    jsonlDescription?: string
    getResult?: PersonaGetResultOverrides
    getError?: Error
    /** The resume's rejection; default `errJsonlMissing(jsonlDescription)`. */
    resumeError?: Error
    spawnCalls?: import('agent-director').SpawnParams[]
    deleteCalls?: import('agent-director').DeleteParams[]
    /** Persona key the row belongs to; default the stand-in CH. */
    key?: string
  }) {
    const key = opts.key ?? CH
    return installStub({
      spawnCalls: opts.spawnCalls,
      deleteCalls: opts.deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${key}` }),
      ],
      resumeError: opts.resumeError ?? errJsonlMissing(opts.jsonlDescription),
      getResult: opts.getError
        ? undefined
        : personaRow(opts.cfg, key, { state: 'ended', ...opts.getResult }),
      getError: opts.getError,
    })
  }

  // --- Regression requirement (designated) --------------------------------
  // Pre-fix: ErrJsonlMissing → action 'spawned', folded into succeeded/"ok",
  // and StartupSessionManagerResult had no freshAfterAmnesia field. This test
  // asserts the dedicated 'fresh-after-amnesia' action AND the separate
  // freshAfterAmnesia counter — both undefined/wrong pre-fix, so it FAILS pre-fix
  // and PASSES post-fix. (Verified by inspecting HEAD:src/session-manager.ts,
  // whose ErrJsonlMissing branch returns { action: 'spawned' } and whose result
  // shape is { succeeded, failed, perChannel } only.)
  // b.fwu: this config sets NO message_archive_db, so makeDefaultArchiveCount
  // yields null and the diagnosis is INCONCLUSIVE (case c-config: no archive is
  // configured, so there is no evidence source to consult). It must land in the
  // dedicated freshAfterInconclusiveAmnesia bucket — never folded into the
  // known-cause freshAfterAmnesia. Pre-fix (no 'inconclusive' classification,
  // no separate counter, no 'fresh-after-inconclusive-amnesia' action) this
  // FAILS; post-fix it PASSES.
  test('REGRESSION: ErrJsonlMissing fresh-spawn with no archive configured is counted as fresh-after-inconclusive-amnesia, not fresh-after-amnesia', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installAmnesia({
      cfg,
      getResult: { jsonl_path: '/data/proj/sess-1.jsonl', claude_session_id: 'sess-1', cwd: CWD },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshSpawned).toBe(0)
    expect(result.resumed).toBe(0)
    expect(result.failed).toBe(0)
    // Still counted toward liveness, but distinctly bucketed.
    expect(result.succeeded).toBe(1)
    expect(result.perPersona).toEqual([
      { key: CH, action: 'fresh-after-inconclusive-amnesia' },
    ])
  })

  // --- Honest counters tallied separately ---------------------------------
  test('startup counters: resumed / fresh-spawned / fresh-after-amnesia / failed are tallied separately', async () => {
    captureStartupErrors()
    let getIdx = 0
    const stub = installStub({
      // C1 fresh (clean spawn), C2 collision→resumed, C3 collision→ErrJsonlMissing
      // amnesia, C4 spawn throws → failed.
      spawnQueue: [
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C1' }),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: 'cscb_C3' }),
        cannedErr<import('agent-director').SpawnResult>(errGeneric('spawn', 'ErrSpawnBroken')),
      ],
    })
    // C2 resumes cleanly; C3 resume throws ErrJsonlMissing.
    stub.resume = async (params) => {
      if (params.claude_instance_id === 'cscb_C3') throw errJsonlMissing()
      return { claude_instance_id: params.claude_instance_id }
    }
    const cfg = makeStandInPersonaConfig(
      {
        C1: { working_directory: '/x1' },
        C2: { working_directory: '/x2' },
        C3: { working_directory: '/x3' },
        C4: { working_directory: '/x4' },
      },
      fixtureDir,
    )
    // Both collision gets return an `ended` row for their own persona.
    const personaGet = personaRowsGet(cfg, { state: 'ended' })
    stub.get = async (params) => {
      getIdx++
      return personaGet(params)
    }
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.freshSpawned).toBe(1) // C1
    expect(result.resumed).toBe(1) // C2
    // C3: ErrJsonlMissing with no message_archive_db configured → the diagnosis
    // is inconclusive (c-config), so it lands in the dedicated inconclusive
    // bucket, not freshAfterAmnesia.
    expect(result.freshAfterInconclusiveAmnesia).toBe(1) // C3
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.failed).toBe(1) // C4
    expect(result.succeeded).toBe(3)
    // C2's collision recovery does one get(); C3's collision recovery plus its
    // ErrJsonlMissing diagnostic each do one → 3 get() calls total.
    expect(getIdx).toBe(3)

    // AC 3: the honest summary line reports every bucket separately (never
    // folding amnesia into a generic "ok"), splitting diagnosed
    // (fresh-after-amnesia) from undiagnosable (fresh-after-inconclusive-amnesia).
    expect(errLog).toContain(
      'startupSessionManager: complete — 4 persona(s): 1 resumed, 1 fresh-spawned, ' +
        '0 fresh-after-amnesia, 1 fresh-after-inconclusive-amnesia, ' +
        '0 reconnected, 0 no-op, 1 failed, 0 not brought up',
    )
    // Because freshAfterInconclusiveAmnesia > 0, its loud grep-friendly
    // follow-up line fires (the freshAfterAmnesia line does not — count is 0).
    expect(errLog).toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing WITHOUT a conclusive diagnosis',
    )
    expect(errLog).not.toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing (transcript could not be resumed)',
    )
  })

  // --- Message-shape coverage: all three AD source tokens (b.hcq) ---------
  // AD v0.10.0's formatJsonlAttempts stamps three source tokens — persisted,
  // fallback and history. Pre-fix the parser anchored on persisted|fallback
  // only, so every `history` candidate (the archived-session evidence that
  // distinguishes "lost" from "never written") was silently dropped.

  /** Render one AD attempt the way formatJsonlAttempts does. */
  function adAttempt(source: string, path: string): string {
    return `${source} ${path} (no such file or directory)`
  }

  /** Drive the amnesia diagnostic with `desc` and return the captured log. */
  async function logForDescription(desc: string): Promise<string> {
    return withCapturedErr(async () => {
      const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
      installAmnesia({
        cfg,
        jsonlDescription: desc,
        getResult: { jsonl_path: '/data/proj/sess-1.jsonl', claude_session_id: 'sess-1', cwd: CWD },
      })
      await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })
  }

  test('REGRESSION: all three AD source tokens are parsed, in the order AD reported them', async () => {
    captureStartupErrors()
    const attempts = [
      adAttempt('persisted', '/data/proj/sess-1.jsonl'),
      adAttempt('fallback', '/home/u/.claude/projects/-repo-wrb/sess-1.jsonl'),
      adAttempt('history', '/home/u/.claude/projects/-old-repo/sess-0.jsonl'),
    ]
    const log = await logForDescription(`no transcript found: ${attempts.join('; ')}`)
    // Exactly the three AD candidates, joined in AD's order — nothing dropped,
    // nothing reordered, no locally-computed padding.
    expect(log).toContain(
      `Transcript candidates tried (paths+sources reported by agent-director): ${attempts.join('; ')}.`,
    )
    expect(log).not.toContain('locally-computed')
  })

  test('history-only description yields exactly that one candidate', async () => {
    captureStartupErrors()
    const attempt = adAttempt('history', '/home/u/.claude/projects/-old-repo/sess-0.jsonl')
    const log = await logForDescription(`no transcript found: ${attempt}`)
    expect(log).toContain(
      `Transcript candidates tried (paths+sources reported by agent-director): ${attempt}.`,
    )
    // A single AD candidate still counts as AD detail: no local reconstruction.
    expect(log).not.toContain('locally-computed')
    expect(log).not.toContain('agent-director gave no path detail')
  })

  test.each([
    ['history: /p/sess.jsonl - missing', 'source token not followed by a path + parens'],
    ['archived /p/sess.jsonl (no such file or directory)', 'unknown source token'],
    ['history(/p/sess.jsonl)', 'no whitespace-separated path'],
  ])('malformed description (%s) parses to no AD candidates without throwing', async (desc) => {
    captureStartupErrors()
    const log = await logForDescription(desc)
    // Non-throwing: the diagnostic still ran and degraded honestly to locally
    // computed candidates rather than claiming AD reported none.
    expect(log).toContain('agent-director gave no path detail')
    expect(log).toContain('locally-computed(persisted-column) /data/proj/sess-1.jsonl')
    expect(log).not.toContain('paths+sources reported by agent-director')
  })

  // --- Message-shape coverage: plain non-enumerated format ----------------
  // A pre-b.1ba AD's ErrJsonlMissing carries no per-candidate enumeration. The
  // diagnostic must degrade to locally-computed candidates, label them
  // honestly, and never throw (spawnForPersona still completes the amnesia
  // fresh-spawn).
  test('plain non-enumerated ErrJsonlMissing message: degrades to honest locally-computed candidates, no throw', async () => {
    captureStartupErrors()
    const log = await withCapturedErr(async () => {
      const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
      installAmnesia({
        cfg,
        jsonlDescription: 'jsonl missing', // no <source> <path> (<err>) enumeration
        getResult: { jsonl_path: '/data/proj/sess-2.jsonl', claude_session_id: 'sess-2', cwd: CWD },
      })
      const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
      // Never throws — the fresh-spawn still happens. No message_archive_db is
      // configured here, so the diagnosis is inconclusive (c-config).
      expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    })
    // Honest provenance clause + locally-computed labels for both persisted
    // column and config-dir fallback.
    expect(log).toContain('agent-director gave no path detail')
    expect(log).toContain('locally-computed(persisted-column) /data/proj/sess-2.jsonl')
    expect(log).toContain('locally-computed(config-dir fallback)')
  })

  // --- Classification triad: never-created (quiet) ------------------------
  // No archived messages since spawn → lossless. Quiet: no startup-error, no
  // persona notice; action still fresh-after-amnesia.
  test('never-created: 0 archived messages since spawn → quiet (no startup-error, no persona notice)', async () => {
    const readLog = captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 0)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-3.jsonl',
        claude_session_id: 'sess-3',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    // b.fwu: evidence-based never-created is the DIAGNOSED-lossless case — it
    // stays quiet and is bucketed as the ordinary fresh-after-amnesia action,
    // NOT the undiagnosable fresh-after-inconclusive-amnesia.
    expect(result.action).toBe('fresh-after-amnesia')
    expect(notices).toHaveLength(0) // no persona notice at all
    const log = readLog()
    expect(log).not.toContain('jsonl-transcript-lost-on-resume') // quiet
    expect(log).not.toContain('jsonl-diagnosis-inconclusive') // not inconclusive
  })

  // --- Classification triad: lost (loud) ----------------------------------
  // Archived messages > 0 since spawn → real context destroyed. Loud:
  // recordStartupError('jsonl-transcript-lost-on-resume') + a persona notice to
  // the persona's destination (b.av2 SR-7.2). The startup error is recorded
  // only when isStartup=true, so this drives that.
  test('lost: archived messages since spawn > 0 → startup-error recorded + persona notice to the destination', async () => {
    const readLog = captureStartupErrors()
    // Four post-spawn messages under its destination, its only `delivery: all`
    // channel (what is counted, b.av2 SR-7.4), and four under the persona key,
    // which is not a channel of the persona and is not counted: the count is 4.
    const startedAt = '2026-09-20T05:00:00Z'
    const boundary = Date.parse(startedAt) / 1000
    const rows = [1, 2, 3, 4].flatMap((i) => [
      { ts: boundary + i, channel: NOTICE_KEY },
      { ts: boundary + i, channel: NOTICE_DEST },
    ])
    const archive = buildTempArchiveDb(rows, NOTICE_KEY)
    archiveCleanups.push(archive.cleanup)
    const cfg = makeNoticeConfig({ message_archive_db: archive.dbPath })
    installAmnesia({
      cfg,
      key: NOTICE_KEY,
      getResult: {
        jsonl_path: '/data/proj/sess-4.jsonl',
        claude_session_id: 'sess-4',
        // cwd: the notice persona's own working directory (personaRow).
        started_at: startedAt,
      },
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg, true)
    await settleNotices()

    expect(result.action).toBe('fresh-after-amnesia')
    // Operator-visible: startup-error entry embedding the archived count.
    const log = readLog()
    expect(log).toContain('jsonl-transcript-lost-on-resume')
    expect(log).toContain('4 message(s)')
    // And a persona notice to the persona's destination only.
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('message archive shows 4 message(s) since I started')
    expect(text).toContain('my conversation memory has been lost')
    expect(text).not.toContain('could not determine whether my prior')
  })

  // --- Classification triad: inconclusive (row fetch finds no row) --------
  // b.fwu case (a): the diagnostic get() finds no row → the row cannot be
  // consulted, so we cannot classify loss vs never-created. Must not throw;
  // the amnesia fresh-spawn still completes, now bucketed as the dedicated
  // 'fresh-after-inconclusive-amnesia' action. b.jg5 SRJ-105, SRJ-114: only
  // `ErrSpawnNotFound` (the row is absent) reaches it; every other error at
  // that get, a CONFIG answer included (b.jg5 SRJ-316), is a refusal, and an
  // UNUSABLE NAME answer latches the persona (b.jg5 SRJ-512; the AC 20 case
  // below).
  test('inconclusive (a): the diagnostic row fetch finds no row (ErrSpawnNotFound) → no throw, fresh-after-inconclusive-amnesia', async () => {
    captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    // First get() (collision recovery) returns ended; second get() (diagnostic)
    // finds no row.
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    let getCalls = 0
    installDiagnosisGetFailure(cfg, () => {
      getCalls++
      return errSpawnNotFound()
    }, { spawnCalls, deleteCalls })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    expect(deleteCalls).toHaveLength(1) // delete+fresh policy unchanged
    expect(spawnCalls).toHaveLength(2)
    expect(getCalls).toBe(1) // the diagnostic get, after the collision get
  })

  // ==========================================================================
  // b.fwu requirement 6: for EACH of the three inconclusive conditions —
  // (a) row-fetch failure, (b) unparseable/absent started_at, (c) archive
  // unavailable — assert BOTH the startup counter (freshAfterInconclusiveAmnesia
  // increments, freshAfterAmnesia does not) AND the startup-error record
  // (jsonl-diagnosis-inconclusive with a condition-specific detail).
  // ==========================================================================

  // (a) row-fetch finds no row, driven through startupSessionManager so the
  // counter is observable. The diagnostic get() (second get) answers
  // ErrSpawnNotFound; the collision recovery get() (first) succeeds so the
  // amnesia path is reached at all.
  test('inconclusive (a) via startup: the row fetch finds no row (ErrSpawnNotFound) → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installDiagnosisGetFailure(cfg, () => errSpawnNotFound(), { spawnCalls: [], deleteCalls: [] })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const entry = onlyStartupEntry(readLog(), 'jsonl-diagnosis-inconclusive')
    // Detail names WHICH condition: the row is absent.
    expect(entry).toContain('the agent-director row is absent (ErrSpawnNotFound)')
  })

  // b.jg5 SRJ-105's CONFIG row, SRJ-114, SRJ-316: a CONFIG answer at the
  // diagnostic get is a refusal, not an inconclusive diagnosis: the start pass
  // counts the persona failed and in neither amnesia counter, writes no
  // jsonl-diagnosis-inconclusive or spawn-failed entry, deletes nothing and
  // spawns nothing fresh, posts no notice, and the wrapper raises CH's
  // ad-config-malformed outage with one onset.
  test('b.jg5 SRJ-105, SRJ-316: inconclusive (a) via startup with a CONFIG answer at the row fetch → refused: no amnesia counter, no jsonl-diagnosis-inconclusive record, no delete or fresh spawn, no notice, one ad-config-malformed onset', async () => {
    const readLog = captureStartupErrors()
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const err = errConfigMalformed()
    installDiagnosisGetFailure(cfg, () => err, { spawnCalls, deleteCalls })

    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.perPersona).toEqual([{ key: CH, action: 'failed' }])
    expect(result.failed).toBe(1)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toHaveLength(1) // the colliding optimistic spawn only
    const log = readLog()
    expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(0)
    expect(countStartupEntries(log, 'spawn-failed')).toBe(0)
    expect(notices).toEqual([])
    expect([...getOutageFlags(CH)]).toEqual(['ad-config-malformed'])
    expect(outageEmissions).toEqual([{ key: CH, text: adConfigMalformedOnset(err) }])
  })

  /**
   * Stub an ErrJsonlMissing launch of CH: the collision get (the first get)
   * reads an `ended` row, the resume answers ErrJsonlMissing(`jsonlDescription`)
   * and the diagnostic get (every later get) throws `makeErr()`. Records the
   * spawns and deletes in `calls`.
   */
  function installDiagnosisGetFailure(
    cfg: PersonaConfig,
    makeErr: () => unknown,
    calls: { spawnCalls: import('agent-director').SpawnParams[]; deleteCalls: import('agent-director').DeleteParams[] },
    jsonlDescription?: string,
  ): void {
    const stub = installStub({
      spawnCalls: calls.spawnCalls,
      deleteCalls: calls.deleteCalls,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      resumeError: errJsonlMissing(jsonlDescription),
    })
    let getCalls = 0
    stub.get = async (params) => {
      getCalls++
      if (getCalls >= 2) throw makeErr()
      return personaRowsGet(cfg, { state: 'ended' })(params)
    }
  }

  /** Run `fn` with console.error captured as argument lists; restores it after. */
  async function withErrArgs(fn: () => Promise<void>): Promise<unknown[][]> {
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    try {
      await fn()
    } finally {
      console.error = orig
    }
    return errArgs
  }

  const quoted = (text: string): string => `message=${JSON.stringify(text)}`
  /**
   * How describeAgentDirectorFailure names an `ErrUnknownErrorName` (the form
   * a CONFIG or UNUSABLE NAME answer takes): its errName and the client's own
   * description; the envelope's description is not shown.
   */
  const unknownNameShown = (err: { errName: string; errDescription: string }): string =>
    `${err.errName} ${quoted(err.errDescription)}`

  // AC 20 (b.av2 SR-10.3) with b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME
  // answer at the row fetch is no read error and reaches no inconclusive
  // report: it latches the persona, so no diagnosis is reported (no
  // inconclusive line, record or notice) and nothing is deleted or spawned.
  // Its one UNUSABLE NAME line names it by describeAgentDirectorFailure — an
  // agent-director error's errName and redacted description when the errName
  // is a short identifier — and the latch's record holds the classification's
  // redacted description; never the thrown value's raw message, description
  // or envelope, which carry fake tokens here.
  const leakyConfig = (): unknown => errUnknownErrorName('ErrConfigMalformed', adDescription())
  const leakyUnusableName = (): unknown => errInternal(`${UNUSABLE_RECORDED_NAME_PHRASE} is empty; ${adDescription()}`)
  test('AC 20, b.jg5 SRJ-512: row fetch answers UNUSABLE NAME whose envelope description holds a URL and a fake token → latched, no diagnosis reported: its one UNUSABLE NAME line names it redacted, the latch record holds the redacted description; no delete, spawn, notice or startup entry; nothing leaks', async () => {
    const readLog = captureStartupErrors()
    const latchLines: string[] = []
    const latch = createConflictLatch({ log: (line) => latchLines.push(line) })
    setConflictLatch(latch)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installDiagnosisGetFailure(cfg, leakyUnusableName, { spawnCalls, deleteCalls })
    const shown = unknownNameShown(leakyUnusableName() as { errName: string; errDescription: string })
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errArgs = await withErrArgs(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    expect(result).toStrictEqual({ key: CH, action: 'latched' })
    const prefix = `[slack] spawnForPersona: ErrJsonlMissing diagnosis get for ${renderPersonaRef(personaOf(cfg, CH).name, CH)}: `
    const lines = errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.startsWith(prefix))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
    expect(lines[0]!.slice(prefix.length).split(' — UNUSABLE NAME: ')[0]!.split(' at ')[0]).toBe(shown)
    expect(lines[0]).toEndWith(' — UNUSABLE NAME: the persona latched; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)')
    const record = latch.record(CH)
    expect(record).toMatchObject({ latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE })
    expect(record?.description).toContain(REDACTED_URL_PLACEHOLDER)
    expect(record?.description).toContain(REDACTED_TOKEN_PLACEHOLDER)
    expect(errArgs.flat().map(String).filter((l) => l.includes('ErrJsonlMissing diagnosis get failed for '))).toEqual([])
    expect(spawnCalls).toHaveLength(1) // the colliding optimistic spawn only
    expect(deleteCalls).toEqual([])
    expect(notices).toEqual([])
    expect(readLog()).toBe('')
    assertNoLeak({ errArgs, startupErrorsLog: readLog(), notices, latchLines, record })
  })

  // AC 20 with b.jg5 SRJ-114: `ErrSpawnNotFound` at the diagnosis get reads
  // the row as absent. The inconclusive report names the absence by the error
  // name alone, never the thrown value's message (which carries a fake token
  // here), in the log line, startup-errors.log and the persona notice.
  test('AC 20, b.jg5 SRJ-114: row fetch answers a typed ErrSpawnNotFound whose message holds a fake token → the row is read as absent: the line, startup-errors.log and notice name ErrSpawnNotFound, never its message; nothing leaks', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installDiagnosisGetFailure(cfg, () => new ErrSpawnNotFound('get', 'ErrSpawnNotFound', leakyMessage('gone', 'sub')), { spawnCalls: [], deleteCalls: [] })
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errArgs = await withErrArgs(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    expect(result?.action).toBe('fresh-after-inconclusive-amnesia')
    const reports = [
      ...errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.startsWith('[slack] ErrJsonlMissing diagnostic: ')),
      onlyStartupEntry(readLog(), 'jsonl-diagnosis-inconclusive'),
      ...notices.map((n) => n.text),
    ]
    expect(reports).toHaveLength(3)
    for (const report of reports) {
      expect(report).toContain(ErrSpawnNotFound.name)
      expect(report).not.toContain(redactedLeakyMessage('gone'))
    }
    assertNoLeak({ errArgs, startupErrorsLog: readLog(), notices })
  })

  // AC 20 with b.jg5 SRJ-105: every other row-fetch failure is a read error,
  // and a CONFIG answer has its own refusal row (SRJ-316), so the diagnostic
  // get is refused. The refusal line names each shape by
  // describeAgentDirectorFailure (redacted, on one line: a two-line errName
  // cannot inject a line), and nothing is posted: no inconclusive notice, no
  // jsonl-diagnosis-inconclusive or spawn-failed entry, no delete, no spawn.
  // Only the CONFIG answer raises an outage: its onset, which quotes the
  // description redacted, is leak-checked with the rest.
  test.each<[string, () => unknown, string]>([
    [
      'a CONFIG answer whose envelope description holds a URL and a fake token (b.jg5 SRJ-316)',
      leakyConfig,
      unknownNameShown(leakyConfig() as { errName: string; errDescription: string }),
    ],
    [
      'a base AgentDirectorError',
      () => errGeneric('get', 'ErrSpawnGone', leakyMessage('gone', 'desc')),
      `ErrSpawnGone ${quoted(redactedLeakyMessage('gone'))}`,
    ],
    [
      // The error's message is `<errName>: <description>`; the token-shaped
      // errName is redacted there like any token.
      'an AgentDirectorError whose errName is token-shaped',
      () => errGeneric('get', fakeToken(BOT_TOKEN_PREFIX, 'errname'), leakyMessage('gone', 'desc')),
      `AgentDirectorError ${quoted(`${REDACTED_TOKEN_PLACEHOLDER} ${redactedLeakyMessage('gone')}`)}`,
    ],
    [
      'an AgentDirectorError whose errName spans two lines',
      () => errGeneric('get', `ErrSpawnGone\n${fakeToken(BOT_TOKEN_PREFIX, 'line2')}`),
      `AgentDirectorError ${quoted(`ErrSpawnGone ${REDACTED_TOKEN_PLACEHOLDER} oops`)}`,
    ],
    [
      'a plain Error with a safe code',
      () => Object.assign(new Error(leakyMessage('socket', 'msg')), { code: 'ECONNRESET', note: LEAK_SENTINEL }),
      `Error code=ECONNRESET ${quoted(redactedLeakyMessage('socket'))}`,
    ],
    ['a rejected string', () => leakyMessage('down', 'str'), `string ${quoted(redactedLeakyMessage('down'))}`],
  ])('AC 20 (b.jg5 SRJ-105): row fetch refused with %s → the refusal line names it redacted on one line; no notice, no startup entry, no delete, no spawn', async (_label, makeErr, shown) => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    const persona = personaOf(cfg, CH)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    installDiagnosisGetFailure(cfg, makeErr, { spawnCalls, deleteCalls })
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errArgs = await withErrArgs(async () => {
      result = await spawnForPersona(persona, cfg, true)
    })

    expect(result).toStrictEqual({ key: persona.key, action: 'failed' })
    const prefix = `[slack] spawnForPersona: ErrJsonlMissing diagnosis get refused for ${renderPersonaRef(persona.name, persona.key)}: `
    const suffix = ' — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)'
    const lines = errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.startsWith(prefix))
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line).not.toContain('\n')
    expect(line.endsWith(suffix)).toBe(true)
    expect(line.slice(prefix.length, -suffix.length).split(' at ')[0]).toBe(shown)
    expect(notices).toEqual([])
    const log = readLog()
    expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(0)
    expect(countStartupEntries(log, 'spawn-failed')).toBe(0)
    expect(errArgs.flat().map(String).filter((l) => l.includes('ErrJsonlMissing diagnosis get failed for '))).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toHaveLength(1) // the colliding optimistic spawn only
    expect(outageEmissions.map((e) => e.key)).toEqual(makeErr === leakyConfig ? [CH] : [])
    assertNoLeak({ errArgs, startupErrorsLog: log, notices, outageEmissions })
  })

  // AC 20 (E13 Director decision 16): when the row fetch finds no row (the
  // inconclusive path's one answer, ErrSpawnNotFound) and ErrJsonlMissing
  // gave no enumerated paths, its description is echoed as "AD reported: …"
  // only after redactSlackLogText, in the log line, the
  // jsonl-diagnosis-inconclusive record and the persona notice; the record's
  // cause is describeAgentDirectorFailure: the error's name and the same
  // redacted description as `message="…"`.
  test('AC 20: the row fetch finds no row and ErrJsonlMissing\'s description holds a URL and a fake token → "AD reported:" carries it redacted in the line, the record and the notice; nothing leaks', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installDiagnosisGetFailure(cfg, () => errSpawnNotFound(), { spawnCalls: [], deleteCalls: [] }, adDescription())
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    expect(result?.action).toBe('fresh-after-inconclusive-amnesia')
    const reported = `the agent-director row is absent (ErrSpawnNotFound); AD reported: ${REDACTED_AD_DESCRIPTION}`
    expect(errLog.split('\n').filter((l) => l.includes(reported))).toHaveLength(1)
    const entry = onlyStartupEntry(readLog(), 'jsonl-diagnosis-inconclusive')
    expect(entry).toContain(reported)
    expect(entry.endsWith(` — ErrJsonlMissing message=${JSON.stringify(REDACTED_AD_DESCRIPTION)}`)).toBe(true)
    expect(notices.map((n) => n.text).filter((t) => t.includes(reported))).toHaveLength(1)
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })

  // AC 20 (E13 Director decision 16, Task 0 decision B1): the lost record's
  // cause is describeAgentDirectorFailure(err): an errName that fails
  // isSafeIdentifier is replaced by describeThrownValue (type, the message
  // `<errName>: <errDescription>` redacted, frames); never the error itself.
  test('AC 20: lost, with an ErrJsonlMissing whose errName is token-shaped and whose description holds a URL and a fake token → the jsonl-transcript-lost-on-resume record names its type and the redacted description; nothing leaks', async () => {
    const readLog = captureStartupErrors()
    const startedAt = '2026-09-20T05:00:00Z'
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, {
      message_archive_db: makeArchiveWithMessagesSince(startedAt, 2),
    })
    installAmnesia({
      cfg,
      resumeError: new ErrJsonlMissing('resume', tokenErrName(), adDescription()),
      getResult: { jsonl_path: '/data/proj/sess-5.jsonl', claude_session_id: 'sess-5', cwd: CWD, started_at: startedAt },
    })
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    expect(result?.action).toBe('fresh-after-amnesia')
    const entry = onlyStartupEntry(readLog(), 'jsonl-transcript-lost-on-resume')
    expect(entry).toContain('2 message(s) since spawn')
    const cause = entry.slice(entry.lastIndexOf(' — ') + ' — '.length)
    expect(cause.startsWith('ErrJsonlMissing message="')).toBe(true)
    expect(cause).toContain(`${REDACTED_AD_DESCRIPTION}"`)
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })

  // (b) unparseable/absent started_at — the archive is even configured (a real
  // db), proving the short-circuit is on started_at, not on archive absence.
  test('inconclusive (b) via startup: unparseable started_at → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 3)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-b.jsonl',
        claude_session_id: 'sess-b',
        cwd: CWD,
        started_at: 'not-a-timestamp',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    // Detail names WHICH condition: started_at could not be parsed. Because it
    // is unparseable, the archive must NOT have been consulted (no lost record).
    expect(log).toContain("started_at is absent or unparseable")
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
  })

  // (c-config) archive unavailable because none is configured. Distinguished
  // from (c-other) by the actionable "no message archive is configured" hint.
  test('inconclusive (c-config) via startup: no message_archive_db → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir) // no message_archive_db
    installAmnesia({
      cfg,
      getResult: { jsonl_path: '/data/proj/sess-c1.jsonl', claude_session_id: 'sess-c1', cwd: CWD },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    expect(log).toContain('no message archive is configured')
  })

  // (c-other) archive IS configured but the file is missing / unreadable.
  // Distinguished from (c-config) by naming the configured path in the detail.
  test('inconclusive (c-other) via startup: configured archive file missing → counter + jsonl-diagnosis-inconclusive record', async () => {
    const readLog = captureStartupErrors()
    const missingDb = join(tmpdir(), `cscb-wrb-missing-${Date.now()}.db`)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: missingDb })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-c2.jsonl',
        claude_session_id: 'sess-c2',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterInconclusiveAmnesia).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    const log = readLog()
    expect(log).toContain('jsonl-diagnosis-inconclusive')
    // c-other wording names the configured (but unusable) archive path, and is
    // distinct from the c-config "no message archive is configured" hint.
    expect(log).toContain(`the message archive (${missingDb})`)
    expect(log).not.toContain('no message archive is configured')
  })

  // --- Conclusive amnesia through startup: freshAfterAmnesia counter ---------
  // b.fwu review gap: no test drove freshAfterAmnesia > 0 through
  // startupSessionManager — the diagnosed 'fresh-after-amnesia' switch case and
  // its loud follow-up line ("transcript could not be resumed") were asserted
  // only in the negative. These two cover the two conclusive flavors.

  // (lost) archive has post-spawn messages → real context destroyed. Diagnosis
  // is CONCLUSIVE, so it lands in freshAfterAmnesia (not the inconclusive
  // bucket), and the loud diagnosed follow-up line fires.
  test('conclusive lost via startup: post-spawn archived messages → freshAfterAmnesia counter + diagnosed follow-up line', async () => {
    captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 4)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-lost.jsonl',
        claude_session_id: 'sess-lost',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    let result!: Awaited<ReturnType<typeof startupSessionManager>>
    const errLog = await withCapturedErr(async () => {
      result = await startupSessionManager(cfg, { concurrency: 1 })
    })

    expect(result.freshAfterAmnesia).toBe(1)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.succeeded).toBe(1)
    // Summary line reports the conclusive bucket, not the inconclusive one.
    expect(errLog).toContain(
      'startupSessionManager: complete — 1 persona(s): 0 resumed, 0 fresh-spawned, ' +
        '1 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, ' +
        '0 reconnected, 0 no-op, 0 failed, 0 not brought up',
    )
    // The diagnosed follow-up line fires; the inconclusive one does not.
    expect(errLog).toContain(
      '1 persona(s) were fresh-spawned after ErrJsonlMissing (transcript could not be resumed)',
    )
    expect(errLog).not.toContain(
      'fresh-spawned after ErrJsonlMissing WITHOUT a conclusive diagnosis',
    )
  })

  // (never-created) 0 post-spawn messages → lossless but still CONCLUSIVE, so it
  // is bucketed as freshAfterAmnesia (quiet: the diagnosed follow-up line still
  // fires because freshAfterAmnesia > 0, but no per-channel 'lost' record).
  test('conclusive never-created via startup: 0 post-spawn messages → freshAfterAmnesia counter, not inconclusive', async () => {
    captureStartupErrors()
    const dbPath = makeArchiveWithMessagesSince('2026-09-20T05:00:00Z', 0)
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir, { message_archive_db: dbPath })
    installAmnesia({
      cfg,
      getResult: {
        jsonl_path: '/data/proj/sess-nc.jsonl',
        claude_session_id: 'sess-nc',
        cwd: CWD,
        started_at: '2026-09-20T05:00:00Z',
      },
    })
    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshAfterAmnesia).toBe(1)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.succeeded).toBe(1)
  })

  // Notice wording for an inconclusive case must be UNCERTAINTY-shaped,
  // never the 'lost' "destroyed"/"memory has been lost" wording — a false
  // "your history was destroyed" is its own harm.
  test('inconclusive persona notice is worded as uncertainty, not the lost "destroyed" wording', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig() // no message_archive_db: c-config → inconclusive
    installAmnesia({
      cfg,
      key: NOTICE_KEY,
      // The row's cwd is the notice persona's own working directory (personaRow).
      getResult: { jsonl_path: '/data/proj/sess-u.jsonl', claude_session_id: 'sess-u' },
    })
    const h = installNoticeNotifier(cfg)
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg, true)
    await settleNotices()

    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    expect(readLog()).toContain('jsonl-diagnosis-inconclusive')
    const text = expectOneNoticeToDestination(h)
    // Uncertainty wording present.
    expect(text).toContain('on restart I was started fresh;')
    expect(text).toContain('could not determine whether my prior')
    // 'lost'-branch wording absent.
    expect(text).not.toContain('has been lost')
    expect(text).not.toContain('message archive shows')
  })

  // --- b.av2 SR-7.4: archive evidence follows the persona's channels -------
  // Only the persona's `delivery: all` channels are counted, and a zero count
  // proves idleness only when the archive sees all of the persona's traffic:
  // with a `mentions` channel or DMs on, zero is inconclusive. Each case drives
  // the real resume → ErrJsonlMissing → diagnosis path over a real temp
  // archive; the row is the persona's own (`personaRow`), so the ladder
  // resumes it instead of meeting the cwd / config_dir guard.

  const SR74_STARTED_AT = '2026-09-20T05:00:00Z'
  const SR74_NAME = 'Archive Bot'
  const SR74_KEY = personaKey(SR74_NAME)
  const ALL_1 = 'C0ALL0001'
  const ALL_2 = 'C0ALL0002'
  const MENTIONS = 'C0MENT003'
  /** A channel of no persona: never counted. */
  const ELSEWHERE = 'C0ELSE004'

  interface Sr74Case {
    channels: Persona['channels']
    dmEnabled: boolean
    /** Post-spawn archived messages by channel ID (the persona key included, to prove it is not counted). */
    rows: Record<string, number>
    outcome: 'never-created' | 'inconclusive' | 'lost'
    /** For 'lost': the count the record and notice name. */
    lostCount?: number
  }

  const SR74_CASES: Array<[string, Sr74Case]> = [
    ['only `all` channels, no rows in them since spawn → never-created', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: ALL_2, delivery: 'all' }],
      dmEnabled: false,
      rows: { [ELSEWHERE]: 3, [SR74_KEY]: 3 },
      outcome: 'never-created',
    }],
    ['an `all` and a `mentions` channel, rows only in the `mentions` channel → inconclusive', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: MENTIONS, delivery: 'mentions' }],
      dmEnabled: false,
      rows: { [MENTIONS]: 5 },
      outcome: 'inconclusive',
    }],
    ['DMs on, an `all` channel with no rows since spawn → inconclusive', {
      channels: [{ id: ALL_1, delivery: 'all' }],
      dmEnabled: true,
      rows: { [ELSEWHERE]: 2 },
      outcome: 'inconclusive',
    }],
    ['DMs on and no channels → inconclusive', {
      channels: [],
      dmEnabled: true,
      rows: { [ELSEWHERE]: 2, [SR74_KEY]: 2 },
      outcome: 'inconclusive',
    }],
    ['an `all` and a `mentions` channel, rows in the `all` channel → lost (only the `all` rows counted)', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: MENTIONS, delivery: 'mentions' }],
      dmEnabled: false,
      rows: { [ALL_1]: 3, [MENTIONS]: 2, [ELSEWHERE]: 7 },
      outcome: 'lost',
      lostCount: 3,
    }],
    ['rows only in the persona’s second `all` channel → lost', {
      channels: [{ id: ALL_1, delivery: 'all' }, { id: ALL_2, delivery: 'all' }],
      dmEnabled: false,
      rows: { [ALL_2]: 2 },
      outcome: 'lost',
      lostCount: 2,
    }],
    ['DMs on, rows in the `all` channel → lost', {
      channels: [{ id: ALL_1, delivery: 'all' }],
      dmEnabled: true,
      rows: { [ALL_1]: 4 },
      outcome: 'lost',
      lostCount: 4,
    }],
  ]

  test.each(SR74_CASES)('SR-7.4: %s', async (_label, c) => {
    const readLog = captureStartupErrors()
    const boundary = Date.parse(SR74_STARTED_AT) / 1000
    // Each channel's rows land strictly after started_at; one row per channel
    // before it proves the "since spawn" bound still applies.
    const rows = Object.entries(c.rows).flatMap(([channel, n]) => [
      { ts: boundary - 10, channel },
      ...Array.from({ length: n }, (_, i) => ({ ts: boundary + 1 + i, channel })),
    ])
    rows.push({ ts: boundary - 10, channel: ALL_1 })
    const archive = buildTempArchiveDb(rows, ELSEWHERE)
    archiveCleanups.push(archive.cleanup)
    const cfg = makeMultiPersonaConfig(
      [{
        name: SR74_NAME,
        channels: c.channels,
        dm: c.dmEnabled ? { enabled: true, contact: 'U0CONTACT1' } : { enabled: false },
        permission_prompts: c.channels.find((ch) => ch.delivery === 'all')?.id ?? 'dm',
      }],
      fixtureDir,
      { message_archive_db: archive.dbPath },
    )
    installAmnesia({
      cfg,
      key: SR74_KEY,
      getResult: { jsonl_path: '/data/proj/sess-sr74.jsonl', claude_session_id: 'sess-sr74', started_at: SR74_STARTED_AT },
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, SR74_KEY), cfg, true)
    })
    const log = readLog()

    if (c.outcome === 'never-created') {
      // Conclusive and quiet: no record, no notice.
      expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-amnesia' })
      expect(log).not.toContain('jsonl-transcript-lost-on-resume')
      expect(log).not.toContain('jsonl-diagnosis-inconclusive')
      expect(notices).toHaveLength(0)
      expect(errLog).toContain('transcript never created (archive consulted: 0 archived messages since spawn)')
      return
    }

    expect(notices).toHaveLength(1)
    expect(notices[0]!.key).toBe(SR74_KEY)
    const text = notices[0]!.text

    if (c.outcome === 'lost') {
      expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-amnesia' })
      expect(countStartupEntries(log, 'jsonl-transcript-lost-on-resume')).toBe(1)
      expect(log).not.toContain('jsonl-diagnosis-inconclusive')
      expect(log).toContain(`the message archive holds ${c.lostCount} message(s) since spawn`)
      expect(text).toContain(`message archive shows ${c.lostCount} message(s) since I started`)
      expect(text).toContain('my conversation memory has been lost')
      expect(text).not.toContain('could not determine whether my prior')
      return
    }

    // Inconclusive, for the new cause: an unattributable zero.
    expect(result).toEqual({ key: SR74_KEY, action: 'fresh-after-inconclusive-amnesia' })
    expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(1)
    expect(log).not.toContain('jsonl-transcript-lost-on-resume')
    expect(errLog).not.toContain('transcript never created')
    expect(text).toContain('could not determine whether my prior')
    expect(text).not.toContain('has been lost')
    expect(text).not.toContain('message archive shows')
    // The recorded cause is the new one, distinct from the existing reasons.
    expect(log).toContain(UNATTRIBUTABLE_ZERO_REASON)
    expect(log).not.toContain('no message archive is configured')
    expect(log).not.toContain('could not be consulted')
    expect(log).not.toContain('started_at is absent or unparseable')
  })

  // Carried from E3 Task 1 review: the locally computed fallback transcript
  // path is built from the persona's effective claude_config_dir. A persona
  // that overrides the top-level directory is looked up under its own.
  test('a persona overriding the top-level claude_config_dir: the fallback transcript candidate is under the persona’s directory', async () => {
    captureStartupErrors()
    const topLevel = fixtureSubdir('top-level-config')
    const own = fixtureSubdir('persona-config')
    const cfg = makeStandInPersonaConfig(
      { [CH]: { working_directory: CWD, claude_config_dir: own } },
      fixtureDir,
      { claude_config_dir: topLevel },
    )
    expect(personaOf(cfg, CH).claude_config_dir).toBe(own)
    const spawnCalls: import('agent-director').SpawnParams[] = []
    installAmnesia({
      cfg,
      spawnCalls,
      // No enumerated AD detail, so the diagnosis computes the candidates itself.
      jsonlDescription: 'jsonl missing',
      getResult: { jsonl_path: '/data/proj/sess-own.jsonl', claude_session_id: 'sess-own', cwd: CWD },
    })

    let result!: Awaited<ReturnType<typeof spawnForPersona>>
    const log = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    })

    // The resume path was reached (the row's label matched the persona's own directory).
    expect(result.action).toBe('fresh-after-inconclusive-amnesia')
    const expected = resolveJsonlPath(CWD, 'sess-own', own)
    expect(expected.startsWith(`${own}/projects/`)).toBe(true)
    expect(log).toContain(`locally-computed(config-dir fallback) ${expected}`)
    expect(log).not.toContain(resolveJsonlPath(CWD, 'sess-own', topLevel))
    expect(log).not.toContain(`${topLevel}/projects`)
    // The fresh spawn after the delete runs under the persona's directory too.
    expect(spawnCalls[1]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(own)
  })

  // --- ErrNoSessionId sibling still 'spawned' (not amnesia) ---------------
  // Guard: only ErrJsonlMissing routes to fresh-after-amnesia. The ErrNoSessionId
  // sibling in the same branch keeps the plain 'spawned' action.
  test('ErrNoSessionId sibling keeps action=spawned (only ErrJsonlMissing is amnesia)', async () => {
    captureStartupErrors()
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installStub({
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      getResult: personaRow(cfg, CH, { state: 'ended' }),
      resumeError: errNoSessionId(),
    })
    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)
    expect(result.action).toBe('spawned')
  })
})

// ---------------------------------------------------------------------------
// b.jgf — ErrJsonlNeverWritten: lossless delete + fresh spawn
//
// AD 0.10.0 split the old "resume can't find a transcript" condition into
// ErrJsonlMissing (a transcript path was recorded but is gone now — ambiguous,
// keeps the b.wrb diagnosis ceremony) and ErrJsonlNeverWritten (the session
// never wrote one — provably nothing to lose). Pre-fix the new name matched no
// branch in the resume ladder, so it hit the generic tail: action 'failed', a
// spawn-failure notice, and restart.ts retrying the same impossible resume with
// a doubling backoff forever.
// ---------------------------------------------------------------------------

describe('b.jgf: ErrJsonlNeverWritten → lossless delete + fresh spawn', () => {
  const CH = 'C_JGF'
  const CWD = '/repo/jgf'

  beforeEach(() => {
    // startupSessionManager writes startup-errors.log; keep it in the per-test dir.
    captureStartupErrors()
  })

  /**
   * Drive the wedge: colliding spawn resolves to an `ended` row, resume rejects
   * with ErrJsonlNeverWritten, then delete + fresh spawn succeeds.
   */
  function installNeverWritten(cfg: PersonaConfig, opts?: {
    spawnCalls?: import('agent-director').SpawnParams[]
    deleteCalls?: import('agent-director').DeleteParams[]
    getCalls?: import('agent-director').GetParams[]
  }) {
    return installStub({
      ...opts,
      spawnQueue: [
        cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision()),
        cannedOk<import('agent-director').SpawnResult>({ claude_instance_id: `cscb_${CH}` }),
      ],
      resumeError: errJsonlNeverWritten(),
      getResult: personaRow(cfg, CH, {
        state: 'ended',
        jsonl_path: '/data/proj/sess-jgf.jsonl',
        claude_session_id: 'sess-jgf',
        cwd: CWD,
      }),
    })
  }

  // --- Regression requirement (designated) --------------------------------
  // Pre-fix this same test FAILS on every assertion that matters: the resume
  // rejection fell through to the generic tail, so action was 'failed', the
  // row was never deleted, no fresh spawn was issued (spawnCalls === 1) and
  // a spawn-failure notice was posted into the channel. Verified against
  // main:src/session-manager.ts, whose branch condition is
  // `err instanceof ErrNoSessionId || err instanceof ErrJsonlMissing`.
  test('REGRESSION: resume ErrJsonlNeverWritten → delete + fresh spawn, action=spawned, no spawn-failure notice, no diagnosis get', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const deleteCalls: import('agent-director').DeleteParams[] = []
    const getCalls: import('agent-director').GetParams[] = []
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg, { spawnCalls, deleteCalls, getCalls })

    const result = await spawnForPersona(personaOf(cfg, CH), cfg, true)

    // AC-2/AC-3: plain success action — not 'failed', and not borrowed from the
    // amnesia vocabulary, because nothing was lost.
    expect(result).toEqual({ key: CH, action: 'spawned' })
    // Row deleted, then re-spawned with the original params.
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].claude_instance_id).toEqual([`cscb_${CH}`])
    expect(spawnCalls).toHaveLength(2)
    expect(spawnCalls[1].claude_instance_id).toBe(`cscb_${CH}`)
    // AC-4: no spawn-failure notice.
    expect(notices).toHaveLength(0)
    // AC-3: only the collision-recovery get ran. diagnoseJsonlMissing fetches
    // the row a second time, so a single get proves the diagnosis was skipped.
    expect(getCalls).toHaveLength(1)
  })

  // AC-5 (no retry): restart.ts reschedules with doubling backoff whenever its
  // launchSession adapter returns false. The wedge was that loop, so assert at
  // the adapter boundary rather than replicating restart.ts's timer.
  test('launchSession adapter returns true → restart.ts records success, schedules no retry', async () => {
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg)

    expect(await launchSession(CH, cfg)).toBe(true)
  })

  // The restart path's adapter looks the key up among the applied personas; an
  // unknown key reports failure and never reaches agent-director.
  test('launchSession: unknown key → false, no agent-director call', async () => {
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const stub = installStub({ spawnCalls })
    // Record every client verb, not just the ones the stub captures.
    const verbs: string[] = []
    const record = stub as unknown as Record<string, unknown>
    for (const name of Object.keys(record)) {
      const fn = record[name]
      if (typeof fn !== 'function') continue
      record[name] = (...args: unknown[]) => { verbs.push(name); return (fn as (...a: unknown[]) => unknown)(...args) }
    }
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)

    expect(await launchSession('C_UNKNOWN', cfg)).toBe(false)

    expect(spawnCalls).toHaveLength(0)
    expect(verbs).toEqual([])
    expect(notices).toHaveLength(0)
  })

  // AC-3: the startup summary must stay honest — a never-written transcript is
  // an ordinary fresh spawn, not amnesia and not an undiagnosable one.
  test('startup counters: bucketed as freshSpawned, not amnesia and not failed', async () => {
    const cfg = makeStandInPersonaConfig({ [CH]: { working_directory: CWD } }, fixtureDir)
    installNeverWritten(cfg)

    const result = await startupSessionManager(cfg, { concurrency: 1 })

    expect(result.freshSpawned).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.perPersona).toEqual([{ key: CH, action: 'spawned' }])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-7.2 — persona notices: hold until validated, restart cap,
// spawn-failure-post startup error, and the notifier seam
// ---------------------------------------------------------------------------

describe('persona notices (b.av2 SR-7.2)', () => {
  /**
   * A startup spawn whose every spawn call fails with a LAUNCH FAILURE
   * (`ErrTmuxSessionCreate`): the first spawn's self-heal kills the orphan
   * session (a no-op here) and respawns once, which fails the same way, so
   * the spawn-failure notice names it.
   */
  function installLaunchFailure(): void {
    _setTmuxSessionKiller(async () => {})
    installStub({ spawnError: launchFailure })
  }

  /** The LAUNCH FAILURE every spawn of `installLaunchFailure` answers. */
  const launchFailure = errTmuxSessionCreate('spawn')

  test('held: a startup spawn failure raised before the persona client is validated posts nothing until the flush, then exactly once', async () => {
    captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false })

    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    await settleNotices()
    expect(result.action).toBe('failed')
    // Held: nothing posted on either persona's client.
    expect(h.posts(NOTICE_KEY)).toHaveLength(0)
    expect(h.posts(OTHER_KEY)).toHaveLength(0)

    // A flush while the client is still unvalidated keeps holding it.
    await h.notifier.flush(NOTICE_KEY)
    expect(h.posts(NOTICE_KEY)).toHaveLength(0)

    // Validate the persona, then flush: exactly one notice, to its destination.
    h.validate(NOTICE_KEY)
    await h.notifier.flush(NOTICE_KEY)
    await h.notifier.flush(OTHER_KEY)
    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain(`Error: \`${launchFailure.errName}\``)

    // A second flush posts nothing more.
    await h.notifier.flush(NOTICE_KEY)
    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
  })

  // --- dm destination (b.av2 SR-7.1 DM part, SR-7.2 DM destination) --------

  test('held (mixed destinations): notices raised before validation make no Slack call, even on a flush; once validated each persona\'s held notices flush to its own destination on its own client, once each, with one DM open', async () => {
    captureStartupErrors()
    installLaunchFailure()
    const cfg = makeDmNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false })
    h.stub(NOTICE_KEY).script.open.push(openedDm(NOTICE_DM))

    // Raised by the session manager in this order: the dm persona's spawn failure and restart cap, then the channel persona's cap.
    const result = await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
    notifyRestartCapReached(NOTICE_KEY)
    notifyRestartCapReached(OTHER_KEY)
    await settleNotices()
    expect(result.action).toBe('failed')
    // Held: no open and no post, on any client of either persona.
    expect(h.stub(NOTICE_KEY).callLog).toEqual([])
    expect(h.stub(OTHER_KEY).callLog).toEqual([])

    // A flush while the clients are still unvalidated keeps holding them (the DM is never opened before validation).
    await Promise.all([h.notifier.flush(NOTICE_KEY), h.notifier.flush(OTHER_KEY)])
    await settleNotices()
    expect(h.stub(NOTICE_KEY).callLog).toEqual([])
    expect(h.stub(OTHER_KEY).callLog).toEqual([])

    h.validate(NOTICE_KEY)
    h.validate(OTHER_KEY)
    await Promise.all([h.notifier.flush(NOTICE_KEY), h.notifier.flush(OTHER_KEY)])
    await settleNotices()

    // The dm persona: one open with its contact, then its two notices in the DM, on its client only.
    expect(webMethods(h, NOTICE_KEY)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
    expect(h.stub(NOTICE_KEY).callLog).toHaveLength(3)
    expect(h.stub(NOTICE_KEY).calls.conversationsOpen).toEqual([{ users: NOTICE_CONTACT }])
    const dmPosts = h.posts(NOTICE_KEY)
    expect(dmPosts.map((p) => p.channel)).toEqual([NOTICE_DM, NOTICE_DM])
    expect(dmPosts[0]!.text).toContain(`Error: \`${launchFailure.errName}\``)
    expect(dmPosts[1]!.text).toContain('Error: `SpawnCapReached`')
    // Posted to the returned D… conversation, never to the contact's user ID; top-level, no identity override.
    for (const post of dmPosts) {
      expect(Object.keys(post).sort()).toEqual(['channel', 'text'])
      expect(post.text.startsWith(`Persona ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)}: `)).toBe(true)
      expect(post.text).not.toContain(NOTICE_CONTACT)
    }

    // The channel persona: unchanged, one post to its channel, no open, on its client only.
    expect(webMethods(h, OTHER_KEY)).toEqual(['chat.postMessage'])
    expect(h.stub(OTHER_KEY).callLog).toHaveLength(1)
    const [otherPost] = h.posts(OTHER_KEY)
    expect(otherPost!.channel).toBe(OTHER_DEST)
    expect(Object.keys(otherPost!).sort()).toEqual(['channel', 'text'])
    expect(otherPost!.text.startsWith(`Persona ${renderPersonaRef(OTHER_NAME, OTHER_KEY)}: `)).toBe(true)
    expect(otherPost!.text).toContain('Error: `SpawnCapReached`')
    expect(otherPost!.text).not.toContain(NOTICE_NAME)

    // No cross-persona call: nothing of either persona's reached the other's client.
    expect(h.totalPosts()).toBe(3)
    expect(h.stub(OTHER_KEY).calls.conversationsOpen).toHaveLength(0)
    expect(dmPosts.every((p) => !p.text.includes(OTHER_NAME))).toBe(true)

    // A second flush of either persona posts nothing more.
    await Promise.all([h.notifier.flush(NOTICE_KEY), h.notifier.flush(OTHER_KEY)])
    await settleNotices()
    expect(h.stub(NOTICE_KEY).callLog).toHaveLength(3)
    expect(h.stub(OTHER_KEY).callLog).toHaveLength(1)
  })

  // --- a failed flush is held and retried (b.av2 SR-7.1 failure part) ------

  test('held then failed (dm): notices held before validation whose flushed DM open fails missing_scope are held under one episode line naming im:write, retried on backoff and posted once each, in raised order, after the cause clears', async () => {
    const readLog = captureStartupErrors()
    installLaunchFailure()
    const cfg = makeDmNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false, leakMarker: LEAK_SENTINEL })
    const dmStub = h.stub(NOTICE_KEY)
    // Sticky: every open fails with missing_scope (the app lacks im:write) until the test clears it.
    dmStub.script.open.push(...Array<WebApiOutcome>(1000).fill({ kind: 'platform', error: 'missing_scope' }))
    const episodeLine =
      `${NOTICE_DIAG_PREFIX}conversations.open failed for destination=dm with error missing_scope — ` +
      'the Slack app lacks the im:write scope: re-install the app with im:write to grant it; ' +
      'holding its permission prompts and notices and retrying with backoff'
    const clearedLine =
      `${NOTICE_DIAG_PREFIX}cleared: destination=dm accepts posts again ` +
      '(was conversations.open error missing_scope); delivering what was held'

    const errLog = await withCapturedErr(async () => {
      // Raised before validation: the dm persona's spawn failure (startup) and restart cap (not startup), then the channel persona's cap.
      expect((await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)).action).toBe('failed')
      notifyRestartCapReached(NOTICE_KEY)
      notifyRestartCapReached(OTHER_KEY)
      await settleNotices()
      // The pre-validation hold: no open and no post on either client.
      expect(dmStub.callLog).toEqual([])
      expect(h.stub(OTHER_KEY).callLog).toEqual([])

      // Validated and flushed: the two notices share one open, which fails; nothing is posted.
      h.validate(NOTICE_KEY)
      h.validate(OTHER_KEY)
      await Promise.all([h.notifier.flush(NOTICE_KEY), h.notifier.flush(OTHER_KEY)])
      await settleNotices()
      expect(webMethods(h, NOTICE_KEY)).toEqual(['conversations.open'])
      expect(dmStub.calls.conversationsOpen).toEqual([{ users: NOTICE_CONTACT }])
      expect(h.posts(NOTICE_KEY)).toHaveLength(0)
      // One episode line for both notices, naming the persona and im:write; both held, in raised order, for a 5 s retry.
      expect(destinationFailedLines(h)).toEqual([episodeLine])
      expect(h.hold.view(NOTICE_KEY)).toEqual({ held: true, heldNotices: 2, nextDueAt: 5_000 })
      expect(h.clock.pending().map((t) => t.delayMs)).toEqual([5_000])
      // Each notice's failure callback ran once: one startup record for the spawn failure.
      expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
      expect(readLog()).toContain(
        `[spawn-failure-post] failed to post spawn failure for persona=${NOTICE_KEY} — conversations.open code=missing_scope: `,
      )

      // The channel persona's flush is unchanged: one post to its channel, no open, no episode of its own.
      expect(webMethods(h, OTHER_KEY)).toEqual(['chat.postMessage'])
      expect(h.posts(OTHER_KEY).map((p) => p.channel)).toEqual([OTHER_DEST])
      expect(h.posts(OTHER_KEY)[0]!.text).toContain('Error: `SpawnCapReached`')
      expect(h.hold.view(OTHER_KEY)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })

      // A notice raised while the episode is open joins the held ones: no Slack call, no line.
      notifySpawnFailure(NOTICE_KEY, errGeneric('spawn', 'ErrLateNotice'), false)
      await settleNotices()
      expect(dmStub.callLog).toHaveLength(1)
      expect(h.hold.view(NOTICE_KEY).heldNotices).toBe(3)

      // Nothing is retried before the retry is due.
      await h.clock.advance(4_999)
      expect(dmStub.callLog).toHaveLength(1)

      // The first retry fails too: one more open, no post, no line, no second record; the wait doubles.
      expect(await h.clock.runNext()).toBe(1)
      expect(webMethods(h, NOTICE_KEY)).toEqual(['conversations.open', 'conversations.open'])
      expect(destinationFailedLines(h)).toEqual([episodeLine])
      expect(h.hold.view(NOTICE_KEY)).toEqual({ held: true, heldNotices: 3, nextDueAt: 15_000 })
      expect(h.clock.pending().map((t) => t.delayMs)).toEqual([10_000])
      expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)

      // The cause clears (the app is re-installed with im:write): the next retry opens the DM and posts every held notice once, in raised order.
      dmStub.script.open.length = 0
      dmStub.script.open.push(openedDm(NOTICE_DM))
      expect(await h.clock.runNext()).toBe(1)
    })

    expect(webMethods(h, NOTICE_KEY)).toEqual([
      'conversations.open', 'conversations.open', 'conversations.open',
      'chat.postMessage', 'chat.postMessage', 'chat.postMessage',
    ])
    const dmPosts = h.posts(NOTICE_KEY)
    expect(dmPosts.map((p) => p.channel)).toEqual([NOTICE_DM, NOTICE_DM, NOTICE_DM])
    expect(dmPosts[0]!.text).toContain(`Error: \`${launchFailure.errName}\``)
    expect(dmPosts[1]!.text).toContain('Error: `SpawnCapReached`')
    expect(dmPosts[2]!.text).toContain('Error: `ErrLateNotice`')
    for (const post of dmPosts) {
      expect(Object.keys(post).sort()).toEqual(['channel', 'text'])
      expect(post.text.startsWith(`Persona ${renderPersonaRef(NOTICE_NAME, NOTICE_KEY)}: `)).toBe(true)
    }
    // One cleared line; nothing left held and no timer.
    expect(destinationFailedLines(h)).toEqual([episodeLine, clearedLine])
    expect(h.hold.view(NOTICE_KEY)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(h.clock.pendingCount()).toBe(0)
    // Each failure callback ran once, at its notice's first failed attempt: one record, one stderr line (the restart cap's).
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
    const stderrLines = errLog.split('\n').filter((line) => line.startsWith('[slack] spawn-failure-post: '))
    expect(stderrLines).toHaveLength(1)
    expect(stderrLines[0]).toContain(`for persona=${NOTICE_KEY}: conversations.open code=missing_scope: `)
    // No per-notice drop line: nothing was dropped.
    expect(h.logs.filter((l) => l.includes('failed to post notice') || l.includes('dropped'))).toEqual([])

    // Neither hold posts anything twice: more flushes and a long wait change nothing.
    await Promise.all([h.notifier.flush(NOTICE_KEY), h.notifier.flush(OTHER_KEY)])
    await h.clock.advance(600_000)
    await settleNotices()
    expect(h.posts(NOTICE_KEY)).toHaveLength(3)
    expect(dmStub.callLog).toHaveLength(6)
    expect(h.stub(OTHER_KEY).callLog).toHaveLength(1)

    // Once cleared a new notice posts at once, to the cached DM, with no open.
    notifyRestartCapReached(NOTICE_KEY)
    await settleNotices()
    expect(webMethods(h, NOTICE_KEY).slice(6)).toEqual(['chat.postMessage'])
    expect(h.posts(NOTICE_KEY)[3]!.channel).toBe(NOTICE_DM)
    expect(destinationFailedLines(h)).toHaveLength(2)
    assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, 'held then failed dm flush')
  })

  test('restart cap: notifyRestartCapReached posts one SpawnCapReached notice to the persona destination', async () => {
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg)

    notifyRestartCapReached(NOTICE_KEY)
    await settleNotices()

    const text = expectOneNoticeToDestination(h)
    expect(text).toContain('Spawn failure:\n')
    expect(text).toContain('Error: `SpawnCapReached`')
    expect(text).toContain(`${RESTART_FAILURE_CAP} consecutive session-launch failures`)
    expect(text).toContain('automatic restarts are suspended for this persona')
  })

  // --- spawn-failure-post (b.av2 SR-11, startup-errors.log classes) --------

  // Every scripted post failure carries LEAK_SENTINEL (message, original,
  // headers, data). recordStartupError writes the same line to stderr (fd 2,
  // not console.error) and to startup-errors.log, so the log file stands for
  // the stderr line; console.error output and the notifier's lines are
  // captured and checked too.
  //
  // One destination failure (a platform refusal) through the whole cycle: the
  // hold's episode line, retries and cleared line alongside the session
  // manager's one record. The hold's own schedule is proven in
  // persona-destination-hold.test.ts, so the rows after it assert only what
  // the session manager owns.
  test('spawn-failure-post: a rejected (platform) startup spawn-failure post records exactly one token-free entry; the notice is held, retried on backoff and posted once the destination accepts it', async () => {
    const outcome: WebApiOutcome = { kind: 'platform', error: 'not_in_channel' }
    const readLog = captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()
    // The first attempt and the first retry fail; the second retry is posted.
    const h = installNoticeNotifier(cfg, { post: [outcome, outcome], leakMarker: LEAK_SENTINEL })

    let action: string | undefined
    const errLog = await withCapturedErr(async () => {
      action = (await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)).action
      await settleNotices()
    })

    expect(action).toBe('failed')
    expect(h.posts(NOTICE_KEY)).toHaveLength(1)
    const log = readLog()
    expect(countStartupEntries(log, 'spawn-failure-post')).toBe(1)
    // The cause is the describer's type, code and message, the message
    // redacted (the stub plants the marker in a token and a URL there).
    expect(log).toContain(`failed to post spawn failure for persona=${NOTICE_KEY} — Error code=slack_webapi_platform_error message="`)
    expect(log).toContain(`(${REDACTED_SENTINEL_TAIL})"`)
    // A destination failure: no per-notice drop line; one episode line instead, and the notice is held for a 5 s retry.
    expect(h.logs.filter((l) => l.includes('failed to post notice'))).toEqual([])
    expect(destinationFailedLines(h)).toEqual([
      `${NOTICE_DIAG_PREFIX}chat.postMessage failed for destination=${NOTICE_DEST} with error not_in_channel; ` +
        'holding its permission prompts and notices and retrying with backoff',
    ])
    expect(h.hold.view(NOTICE_KEY)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5_000 })
    expect(h.clock.pending().map((t) => t.delayMs)).toEqual([5_000])

    // The first retry fails too: no post lands, no line, no second record; the wait doubles.
    const retryErrLog = await withCapturedErr(async () => {
      expect(await h.clock.runNext()).toBe(1)
    })
    expect(h.posts(NOTICE_KEY)).toHaveLength(2)
    expect(destinationFailedLines(h)).toHaveLength(1)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
    expect(retryErrLog).not.toContain('spawn-failure-post')
    expect(h.clock.pending().map((t) => t.delayMs)).toEqual([10_000])
    expect(h.hold.view(NOTICE_KEY)).toEqual({ held: true, heldNotices: 1, nextDueAt: 15_000 })

    // The second retry is posted: the same notice to the same destination, one cleared line, nothing left held.
    await withCapturedErr(async () => {
      expect(await h.clock.runNext()).toBe(1)
    })
    const posts = h.posts(NOTICE_KEY)
    expect(posts).toHaveLength(3)
    expect(posts.map((p) => p.channel)).toEqual([NOTICE_DEST, NOTICE_DEST, NOTICE_DEST])
    expect(new Set(posts.map((p) => p.text)).size).toBe(1)
    expect(posts[0]!.text).toContain(`Error: \`${launchFailure.errName}\``)
    expect(destinationFailedLines(h)).toEqual([
      expect.stringContaining('holding its permission prompts and notices'),
      `${NOTICE_DIAG_PREFIX}cleared: destination=${NOTICE_DEST} accepts posts again ` +
        '(was chat.postMessage error not_in_channel); delivering what was held',
    ])
    expect(h.hold.view(NOTICE_KEY)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(h.clock.pendingCount()).toBe(0)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
    expect(h.posts(OTHER_KEY)).toHaveLength(0)
    assertNoLeak({ startupErrorsLog: readLog(), errLog: `${errLog}\n${retryErrLog}`, logs: h.logs }, 'spawn-failure-post platform')
  })

  // [label, the post's failure, its Web API error code]
  const LEAKY_POST_FAILURES: [string, WebApiOutcome, string][] = [
    ['network', { kind: 'network' }, 'slack_webapi_request_error'],
    ['http 503', { kind: 'http', status: 503 }, 'slack_webapi_http_error'],
  ]

  test.each(LEAKY_POST_FAILURES)(
    'spawn-failure-post: a rejected (%s) startup spawn-failure post records exactly one token-free entry, not another after a failed retry',
    async (_label, outcome, code) => {
      const readLog = captureStartupErrors()
      installLaunchFailure()
      const cfg = makeNoticeConfig()
      const h = installNoticeNotifier(cfg, { post: [outcome, outcome], leakMarker: LEAK_SENTINEL })

      const errLog = await withCapturedErr(async () => {
        await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
        await settleNotices()
        expect(await h.clock.runNext()).toBe(1)
      })

      expect(h.posts(NOTICE_KEY)).toHaveLength(2)
      const log = readLog()
      expect(countStartupEntries(log, 'spawn-failure-post')).toBe(1)
      // The cause is the describer's type, code and redacted message.
      expect(log).toContain(`failed to post spawn failure for persona=${NOTICE_KEY} — Error code=${code} message="`)
      expect(log).toContain(`(${REDACTED_SENTINEL_TAIL})"`)
      assertNoLeak({ startupErrorsLog: log, errLog, logs: h.logs }, `spawn-failure-post ${_label}`)
    },
  )

  test('spawn-failure-post: a held startup notice whose flushed post is rejected records no entry before the flush and exactly one token-free entry after it, not another after a failed retry', async () => {
    const readLog = captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { validated: false, post: [{ kind: 'network' }, { kind: 'network' }], leakMarker: LEAK_SENTINEL })

    const errLog = await withCapturedErr(async () => {
      await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
      await settleNotices()
      expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(0)

      h.validate(NOTICE_KEY)
      await h.notifier.flush(NOTICE_KEY)
      await settleNotices()
      expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)

      expect(await h.clock.runNext()).toBe(1)
    })

    expect(h.posts(NOTICE_KEY)).toHaveLength(2)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(1)
    assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, 'held spawn-failure-post')
  })

  test('spawn-failure-post: a rejected restart-cap notice post records none and logs one token-free line, not another after a failed retry', async () => {
    const readLog = captureStartupErrors()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { post: [{ kind: 'network' }, { kind: 'network' }], leakMarker: LEAK_SENTINEL })

    const errLog = await withCapturedErr(async () => {
      notifyRestartCapReached(NOTICE_KEY)
      await settleNotices()
      expect(await h.clock.runNext()).toBe(1)
    })

    expect(h.posts(NOTICE_KEY)).toHaveLength(2)
    expect(countStartupEntries(readLog(), 'spawn-failure-post')).toBe(0)
    // Outside startup the failure is logged instead, once.
    const lines = errLog.split('\n').filter((line) => line.startsWith('[slack] spawn-failure-post: '))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`[slack] spawn-failure-post: failed to post spawn failure for persona=${NOTICE_KEY}`)
    assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, 'restart-cap spawn-failure-post')
  })

  test('spawn-failure-post: a rejected restart-path (launchSession) notice post records none and logs one token-free line, not another after a failed retry', async () => {
    const readLog = captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { post: [{ kind: 'network' }, { kind: 'network' }], leakMarker: LEAK_SENTINEL })

    let launched: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      launched = await launchSession(NOTICE_KEY, cfg)
      await settleNotices()
      expect(await h.clock.runNext()).toBe(1)
    })

    expect(launched).toBe(false)
    expect(h.posts(NOTICE_KEY).map((p) => p.channel)).toEqual([NOTICE_DEST, NOTICE_DEST])
    expect(h.posts(OTHER_KEY)).toHaveLength(0)
    // Non-startup: no startup-errors.log entry of any class.
    expect(readLog()).toBe('')
    const lines = errLog.split('\n').filter((line) => line.startsWith('[slack] spawn-failure-post: '))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`[slack] spawn-failure-post: failed to post spawn failure for persona=${NOTICE_KEY}`)
    assertNoLeak({ errLog, logs: h.logs }, 'launchSession spawn-failure-post')
  })

  // The cause names what failed. Known thrown values (the sentinel inside a
  // fake token and a URL in the message, bare in `data`) make the expected
  // cause exact: a failed post keeps the cause it had before DM destinations
  // (`describeThrownValue` of the rejection, SR-11 byte-for-byte); a failed
  // DM open names the step and its code.
  const postErr = Object.assign(new Error(leakyMessage('An API error occurred: not_in_channel', 'post')), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'not_in_channel', provided: LEAK_SENTINEL },
  })
  const openErr = Object.assign(new Error(leakyMessage('An API error occurred: missing_scope', 'open')), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'missing_scope', provided: LEAK_SENTINEL },
  })
  const CAUSES: [string, () => PersonaConfig, (h: NotifierHarness) => void, string[], () => string][] = [
    [
      'channel destination, post rejected',
      makeNoticeConfig,
      (h) => h.stub(NOTICE_KEY).script.post.push({ kind: 'reject', value: postErr }),
      ['chat.postMessage'],
      () => describeThrownValue(postErr),
    ],
    [
      'dm destination, open rejected (missing_scope)',
      makeDmNoticeConfig,
      (h) => h.stub(NOTICE_KEY).script.open.push({ kind: 'reject', value: openErr }),
      ['conversations.open'],
      () => `conversations.open code=missing_scope: ${describeThrownValue(openErr)}`,
    ],
    [
      'dm destination, open returned no conversation ID',
      makeDmNoticeConfig,
      (h) => h.stub(NOTICE_KEY).script.open.push({ kind: 'ok', result: { channel: undefined } }),
      ['conversations.open'],
      () => 'conversations.open code=no_conversation_id',
    ],
    [
      'dm destination, post to the opened DM rejected',
      makeDmNoticeConfig,
      (h) => h.stub(NOTICE_KEY).script.post.push({ kind: 'reject', value: postErr }),
      ['conversations.open', 'chat.postMessage'],
      () => describeThrownValue(postErr),
    ],
  ]

  test.each(CAUSES)(
    'spawn-failure-post cause (%s): the startup record is exactly "<message> — <cause>"',
    async (_label, makeCfg, script, methods, cause) => {
      const readLog = captureStartupErrors()
      installLaunchFailure()
      const cfg = makeCfg()
      const h = installNoticeNotifier(cfg, { leakMarker: LEAK_SENTINEL })
      script(h)

      const errLog = await withCapturedErr(async () => {
        await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)
        await settleNotices()
      })

      expect(webMethods(h, NOTICE_KEY)).toEqual(methods)
      const entries = readLog().split('\n').filter((line) => line.includes('] [spawn-failure-post] '))
      expect(entries).toHaveLength(1)
      expect(entries[0]!.replace(/^\[[^\]]+\] /, '')).toBe(
        `[spawn-failure-post] failed to post spawn failure for persona=${NOTICE_KEY} — ${cause()}`,
      )
      assertNoLeak({ startupErrorsLog: readLog(), errLog, logs: h.logs }, `spawn-failure-post cause ${_label}`)
    },
  )

  test.each(CAUSES)(
    'spawn-failure-post cause (%s): the restart-path (launchSession) stderr line is exactly "<message>: <cause>" and nothing is recorded',
    async (_label, makeCfg, script, methods, cause) => {
      const readLog = captureStartupErrors()
      installLaunchFailure()
      const cfg = makeCfg()
      const h = installNoticeNotifier(cfg, { leakMarker: LEAK_SENTINEL })
      script(h)

      const errLog = await withCapturedErr(async () => {
        expect(await launchSession(NOTICE_KEY, cfg)).toBe(false)
        await settleNotices()
      })

      expect(webMethods(h, NOTICE_KEY)).toEqual(methods)
      expect(readLog()).toBe('')
      const lines = errLog.split('\n').filter((line) => line.startsWith('[slack] spawn-failure-post: '))
      expect(lines).toEqual([`[slack] spawn-failure-post: failed to post spawn failure for persona=${NOTICE_KEY}: ${cause()}`])
      assertNoLeak({ errLog, logs: h.logs }, `launchSession spawn-failure-post cause ${_label}`)
    },
  )

  // --- The setSessionNotifier seam ----------------------------------------

  test('no notifier installed: a notice is logged by its first line, never thrown', async () => {
    setSessionNotifier(undefined)
    const errLog = await withCapturedErr(() => {
      notifySpawnFailure(NOTICE_KEY, errGeneric('spawn', 'ErrSpawnBroken'))
    })
    expect(errLog).toContain(
      `[slack] session-manager: no notifier installed — notice for persona=${NOTICE_KEY} not posted: Spawn failure:`,
    )
    // Only the first line of the notice is logged.
    expect(errLog).not.toContain('ErrSpawnBroken')
  })

  // AC 20 (b.av2 SR-10.3): the sink's error carries fake tokens in its
  // message and properties; the line names it by description only (type,
  // code, redacted message).
  const sinkError = (): Error =>
    Object.assign(new Error(leakyMessage('sink exploded', 'sink')), { code: 'ECONNRESET', detail: LEAK_SENTINEL })

  test.each([
    ['throws', () => { throw sinkError() }],
    ['rejects', () => Promise.reject(sinkError())],
  ] as const)('a notifier that %s is contained: the spawn still reports failed and the error is logged by description (AC 20: nothing logged leaks)', async (_label, sink) => {
    const readLog = captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()
    setSessionNotifier(sink)

    let action: string | undefined
    const errLog = await withCapturedErr(async () => {
      action = (await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)).action
      await settleNotices()
    })

    expect(action).toBe('failed')
    expect(
      errLog.split('\n').filter((l) => l.includes('notifier failed')).map((l) => l.split(' at ')[0]),
    ).toEqual([
      `[slack] session-manager: notifier failed for persona=${NOTICE_KEY}: Error code=ECONNRESET message=${JSON.stringify(redactedLeakyMessage('sink exploded'))}`,
    ])
    assertNoLeak({ errLog, startupErrorsLog: readLog() })
  })

  test('the bare capture records the notice under the persona key with its body only', async () => {
    captureStartupErrors()
    installLaunchFailure()
    const cfg = makeNoticeConfig()

    await spawnForPersona(personaOf(cfg, NOTICE_KEY), cfg)

    expect(notices).toHaveLength(1)
    expect(notices[0].key).toBe(NOTICE_KEY)
    // The session manager passes the body; the notifier adds the persona reference.
    expect(notices[0].text.startsWith('Spawn failure:\n')).toBe(true)
    expect(notices[0].text).not.toContain(NOTICE_NAME)
    expect(typeof notices[0].options?.onPostFailure).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// The persona teardown's quiet kill and delete (b.av2 SR-6.5)
//
// `killPersonaInstance(key)` / `deletePersonaInstance(key)` touch only
// `cscb_<key>`, through `withOutageDetection` (its flags move as for any other
// call), and are quiet: no log line, no startup error, no persona notice.
// A row already gone (`ErrSpawnNotFound`) resolves false; every other error is
// rethrown for the teardown to log. `tryKill` / `tryDelete` keep their own
// behaviour (the collision ladder and start sweep cases above stay green).
// ---------------------------------------------------------------------------

describe('killPersonaInstance / deletePersonaInstance: the persona teardown\'s quiet kill and delete (b.av2 SR-6.5)', () => {
  const B = 'B'
  const A = 'A'

  /** Run `fn` with the startup-errors log and console captured; returns what it resolved or rejected with, and everything captured. */
  async function runQuietly<T>(fn: () => Promise<T>): Promise<{ outcome: { ok: T } | { err: unknown }; errLog: string; startupLog: string }> {
    const readStartupLog = captureStartupErrors()
    let outcome!: { ok: T } | { err: unknown }
    const errLog = await withCapturedErr(async () => {
      try {
        outcome = { ok: await fn() }
      } catch (err) {
        outcome = { err }
      }
      await settleNotices()
    })
    return { outcome, errLog, startupLog: readStartupLog() }
  }

  test('a present row: kill addresses only cscb_B and resolves true, delete addresses only cscb_B and resolves true; no other verb, no line, no startup error, no notice', async () => {
    const calls = makeStubCallLog()
    installStub(calls)

    const kill = await runQuietly(() => killPersonaInstance(B))
    const del = await runQuietly(() => deletePersonaInstance(B))

    expect(kill.outcome).toEqual({ ok: true })
    expect(del.outcome).toEqual({ ok: true })
    expect(calls.killCalls).toEqual([{ claude_instance_id: 'cscb_B' }])
    expect(calls.deleteCalls).toEqual([{ claude_instance_id: ['cscb_B'] }])
    expect(stubCallCount(calls)).toBe(2)
    for (const r of [kill, del]) {
      expect(r.errLog).toBe('')
      expect(r.startupLog).toBe('')
    }
    expect(notices).toEqual([])
    expect(outageEmissions).toEqual([])
  })

  test.each([
    ['kill', () => killPersonaInstance(B)],
    ['delete', () => deletePersonaInstance(B)],
  ] as const)('%s: a row already gone (ErrSpawnNotFound) resolves false, quietly', async (verb, call) => {
    installStub(verb === 'kill' ? { killError: errSpawnNotFound() } : { deleteError: errSpawnNotFound() })

    const r = await runQuietly(call)

    expect(r.outcome).toEqual({ ok: false })
    expect(r.errLog).toBe('')
    expect(r.startupLog).toBe('')
    expect(notices).toEqual([])
    expect(outageEmissions).toEqual([])
  })

  test.each([
    ['kill', () => killPersonaInstance(B)],
    ['delete', () => deletePersonaInstance(B)],
  ] as const)('%s: any other error is rethrown unchanged, with no line, startup error or notice of its own', async (verb, call) => {
    const err = errGeneric(verb, 'ErrBroken')
    installStub(verb === 'kill' ? { killError: err } : { deleteError: err })

    const r = await runQuietly(call)

    expect(r.outcome).toEqual({ err })
    expect(r.errLog).toBe('')
    expect(r.startupLog).toBe('')
    expect(notices).toEqual([])
    expect(outageEmissions).toEqual([])
  })

  test.each([
    ['kill', () => killPersonaInstance(B)],
    ['delete', () => deletePersonaInstance(B)],
  ] as const)('%s goes through the outage wrapper: agent-director unreachable raises B\'s ad-unreachable flag (and rethrows); a later success clears it with B\'s all-clear; A\'s flag is untouched', async (verb, call) => {
    const BIN = '/opt/ad/bin/agent-director'
    setOutageFlag(A, 'ad-unreachable', BIN)
    outageEmissions = []
    const unreachable = new ErrSystemInstallDisappeared(verb, BIN)
    installStub(verb === 'kill' ? { killError: unreachable } : { deleteError: unreachable })

    const failed = await runQuietly(call)

    expect(failed.outcome).toEqual({ err: unreachable })
    expect([...getOutageFlags(B)]).toEqual(['ad-unreachable'])
    expect(outageEmissions.map((e) => e.key)).toEqual([B])

    installStub({})
    const ok = await runQuietly(call)

    expect(ok.outcome).toEqual({ ok: true })
    expect([...getOutageFlags(B)]).toEqual([])
    expect(outageEmissions.map((e) => e.key)).toEqual([B, B])
    expect(outageEmissions[1]!.text).toContain('All clear')
    expect([...getOutageFlags(A)]).toEqual(['ad-unreachable'])
    expect(ok.errLog).toBe('')
    expect(notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-303, SRJ-115: the UNAVAILABLE retry timer's row read
//
// `readPersonaRowState(key)` makes one `status` call for `cscb_<key>` through
// `withOutageDetection` (no findMissing sweep, no other call) and logs
// nothing. It answers `{ state }`: the row's state as agent-director reports
// it, `pending` included, or `UNAVAILABLE_RETRY_ROW_ABSENT` for
// `ErrSpawnNotFound` (by name). On a `pending` row only it also answers the
// launch start the result shows (`launchStartedAt`, raw); a missing, `null`
// or empty one, or one on another state, gives no `launchStartedAt` key (the
// cases compare with `toStrictEqual`, so an `undefined` key fails them). Any
// other error reaches the caller as the
// same value. Being wrapped, its flags move as for any wrapped `status`, and
// inside a recovery attempt for the persona its error is reported to the
// installed trigger sink with the arming predicate's cause.
// ---------------------------------------------------------------------------

describe('readPersonaRowState: the retry timer\'s row read, one status call through the outage wrapper (b.jg5 SRJ-303, SRJ-115)', () => {
  const B = 'B'
  const A = 'A'

  /** Every arm the recording sink received: persona key and cause kind. */
  let armed: Array<{ key: string; kind: string }>

  beforeEach(() => {
    armed = []
    // b.jg5 SRJ-513, SRJ-408: B is a key no configured persona uses, so a
    // pending row with no launch start latches no one here (under a
    // configured persona's key it latches the persona instead: the SRJ-513
    // describes). The file's `afterEach` removes the query.
    setConfiguredPersonaQuery(() => false)
  })

  /** Re-wire the outage state as the top-level `beforeEach` does, with a sink recording each arm in `armed` and answering true, as the real controller's `arm` does. */
  function installRecordingSink(): void {
    initOutageState({
      getClient,
      notify: (key, text) => { outageEmissions.push({ key, text }) },
      triggerSink: {
        arm: (key, cause) => {
          armed.push({ key, kind: cause.kind })
          return true
        },
      },
    })
  }

  /** Run the read for B with the startup-errors log and console captured; returns what it resolved or rejected with, and everything captured. */
  async function readQuietly(read: () => Promise<UnavailableRetryRowRead> = () => readPersonaRowState(B)): Promise<{ outcome: { ok: UnavailableRetryRowRead } | { err: unknown }; errLog: string; startupLog: string }> {
    const readStartupLog = captureStartupErrors()
    let outcome!: { ok: UnavailableRetryRowRead } | { err: unknown }
    const errLog = await withCapturedErr(async () => {
      try {
        outcome = { ok: await read() }
      } catch (err) {
        outcome = { err }
      }
      await settleNotices()
    })
    return { outcome, errLog, startupLog: readStartupLog() }
  }

  /** Nothing was logged, recorded as a startup error or raised as a notice. */
  function expectQuiet(r: { errLog: string; startupLog: string }): void {
    expect(r.errLog).toBe('')
    expect(r.startupLog).toBe('')
    expect(notices).toEqual([])
  }

  /** Every row state agent-director reports: the live ones (`pending` included) and the dead ones. */
  const EVERY_ROW_STATE: string[] = [...AGENT_DIRECTOR_LIVE_STATES, ...AGENT_DIRECTOR_DEAD_STATES]
  /** Every row state but `pending`. */
  const NON_PENDING_ROW_STATES: string[] = EVERY_ROW_STATE.filter((s) => s !== AGENT_DIRECTOR_PENDING_STATE)

  test.each(EVERY_ROW_STATE)('a row reading %s with no launch start, under a key no configured persona uses → { state } as is (no launchStartedAt key), from exactly one status call for cscb_B and no other call; quiet', async (state) => {
    const calls = makeStubCallLog()
    installStub({ ...calls, statusResult: cannedStatusResult({ state, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })

    const r = await readQuietly()

    expect(r.outcome).toStrictEqual({ ok: { state } })
    expect(calls.statusCalls).toEqual([{ claude_instance_id: `${PERSONA_INSTANCE_ID_PREFIX}${B}` }])
    expect(stubCallCount(calls)).toBe(1)
    expectQuiet(r)
    expect(outageEmissions).toEqual([])
  })

  test.each<[string, string]>([
    ['with fractional seconds', SAMPLE_LAUNCH_START_FRACTIONAL],
    ['without fractional seconds', SAMPLE_LAUNCH_START_WHOLE],
  ])('a pending row showing a launch start %s → { state: pending, launchStartedAt } with the launch start raw, from one status call; quiet', async (_label, launchStart) => {
    const calls = makeStubCallLog()
    installStub({ ...calls, statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: launchStart }) })

    const r = await readQuietly()

    expect(r.outcome).toStrictEqual({ ok: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: launchStart } })
    expect(stubCallCount(calls)).toBe(1)
    expectQuiet(r)
  })

  test.each<[string, string | null | undefined]>([
    ['no launch_started_at key', SAMPLE_LAUNCH_START_NONE],
    ['a null launch_started_at', null],
    ['an empty launch_started_at', ''],
  ])('a pending row with %s, under a key no configured persona uses → { state: pending } and no launchStartedAt key; quiet', async (_label, launchStart) => {
    installStub({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: launchStart }) })

    const r = await readQuietly()

    expect(r.outcome).toStrictEqual({ ok: { state: AGENT_DIRECTOR_PENDING_STATE } })
    expectQuiet(r)
  })

  test.each(NON_PENDING_ROW_STATES)('a row reading %s that carries a launch start anyway → { state } only: the launch start is ignored for any state but pending', async (state) => {
    installStub({ statusResult: cannedStatusResult({ state, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }) })

    const r = await readQuietly()

    expect(r.outcome).toStrictEqual({ ok: { state } })
    expectQuiet(r)
  })

  test.each<[string, () => Error]>([
    ['the client\'s ErrSpawnNotFound', () => new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'spawn not found')],
    ['a base AgentDirectorError named ErrSpawnNotFound', () => errGeneric('status', 'ErrSpawnNotFound', 'spawn not found')],
  ])('no row (%s) → { state: absent }, not an error, after one status call; quiet', async (_label, build) => {
    const calls = makeStubCallLog()
    installStub({ ...calls, statusError: build() })

    const r = await readQuietly()

    expect(r.outcome).toStrictEqual({ ok: { state: UNAVAILABLE_RETRY_ROW_ABSENT } })
    expect(stubCallCount(calls)).toBe(1)
    expectQuiet(r)
  })

  test.each<[string, () => Error]>([
    ['an UNAVAILABLE error (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('status')],
    ['an UNCLASSIFIED error (ErrInternal)', () => errInternal()],
    ['a base AgentDirectorError whose description carries a fake token', () => errGeneric('status', 'ErrBroken', `status refused (${sentinelInMessage('status')})`)],
    ['a plain Error', () => new Error(`boom (${sentinelInMessage('plain')})`)],
  ])('%s propagates to the caller as the same value, with no line, startup error or notice of its own', async (_label, build) => {
    const err = build()
    installStub({ statusError: err })

    const r = await readQuietly()

    expect('err' in r.outcome && r.outcome.err).toBe(err)
    expectQuiet(r)
    assertNoLeak({ errLog: r.errLog, startupLog: r.startupLog, notices, outageEmissions })
  })

  test.each<[string, () => Error, OutageClass]>([
    ['agent-director unreachable', () => new ErrSystemInstallDisappeared('status', '/opt/ad/bin/agent-director'), 'ad-unreachable'],
  ])('goes through the outage wrapper: %s raises B\'s %s flag (and rethrows); a later read clears it with B\'s all-clear; A\'s flag is untouched', async (_label, build, flag) => {
    setOutageFlag(A, 'ad-unreachable', '/opt/ad/bin/agent-director')
    outageEmissions = []
    const failure = build()
    installStub({ statusError: failure })

    const failed = await readQuietly()

    expect('err' in failed.outcome && failed.outcome.err).toBe(failure)
    expect([...getOutageFlags(B)]).toEqual([flag])
    expect(outageEmissions.map((e) => e.key)).toEqual([B])

    installStub({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }) })
    const ok = await readQuietly()

    expect(ok.outcome).toStrictEqual({ ok: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL } })
    expect([...getOutageFlags(B)]).toEqual([])
    expect(outageEmissions.map((e) => e.key)).toEqual([B, B])
    expect(outageEmissions[1]!.text).toContain('All clear')
    expect([...getOutageFlags(A)]).toEqual(['ad-unreachable'])
    expectQuiet(ok)
  })

  // b.jg5 SRJ-312: a successful `status` is no tmux answer, so the row read
  // leaves tmux-unavailable raised; a tmux-touching success for B (its
  // `/mcp reconnect` keystrokes) clears it with B's one all-clear.
  test.each<[string, () => Error, string]>([
    ['tmux cannot be run', () => new ErrTmuxNotAvailable('status', 'ErrTmuxNotAvailable', 'tmux not available'), ONSET_TEMPLATES['tmux-unavailable']()],
    ['the different-server form', () => errTmuxNotAvailableDifferentServer(undefined, 'status'), tmuxServerChangedOnset()],
  ])('b.jg5 SRJ-312, SRJ-1021: goes through the outage wrapper: ErrTmuxNotAvailable (%s) raises B\'s tmux-unavailable flag with the form\'s onset (and rethrows); a later successful read leaves it raised with no all-clear; a tmux-touching success for B clears it with B\'s all-clear; A\'s flag is untouched', async (_label, build, onset) => {
    setOutageFlag(A, 'ad-unreachable', '/opt/ad/bin/agent-director')
    outageEmissions = []
    const failure = build()
    installStub({ statusError: failure })

    const failed = await readQuietly()

    expect('err' in failed.outcome && failed.outcome.err).toBe(failure)
    expect([...getOutageFlags(B)]).toEqual(['tmux-unavailable'])
    expect(outageEmissions).toEqual([{ key: B, text: onset }])

    installStub({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }) })
    const ok = await readQuietly()

    expect(ok.outcome).toStrictEqual({ ok: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL } })
    expect([...getOutageFlags(B)]).toEqual(['tmux-unavailable'])
    expect(outageEmissions.map((e) => e.key)).toEqual([B])
    expectQuiet(ok)

    // tmux answers: B's keystrokes succeed.
    const sendKeysCalls: import('agent-director').SendKeysParams[] = []
    installStub({ sendKeysCalls })
    let outcome: string | undefined
    await withCapturedErr(async () => {
      outcome = await reconnectMcp(B)
    })

    expect(outcome).toBe('ok')
    expect(sendKeysCalls).toHaveLength(1)
    expect([...getOutageFlags(B)]).toEqual([])
    expect(outageEmissions).toEqual([
      { key: B, text: onset },
      { key: B, text: ALL_CLEAR_TEMPLATE(new Map([['tmux-unavailable', { detail: undefined }]])) },
    ])
    expect([...getOutageFlags(A)]).toEqual(['ad-unreachable'])
  })

  // b.jg5 SRJ-311: ENVIRONMENT from any verb for B arms B's timer in any
  // context; inside B's attempt it is also B's last error, so a launch it
  // ended would be refused.
  test.each<[string, () => Error, string]>([
    ['tmux cannot be run', () => errTmuxNotAvailable(undefined, 'status'), ONSET_TEMPLATES['tmux-unavailable']()],
    ['the different-server form', () => errTmuxNotAvailableDifferentServer(undefined, 'status'), tmuxServerChangedOnset()],
  ])('b.jg5 SRJ-311: ErrTmuxNotAvailable (%s) from the row read is reported to the sink with the ENVIRONMENT cause in every context (outside any attempt, inside A\'s, inside B\'s), always under B; it still propagates', async (_label, build, onset) => {
    installRecordingSink()
    const err = build()
    installStub({ statusError: err })

    const outside = await readQuietly()
    const otherAttempt = await readQuietly(() => runInAttempt(A, 'recovery', () => readPersonaRowState(B)))
    let attempt: AttemptView | undefined
    const inside = await readQuietly(() => runInAttempt(B, 'recovery', (view) => {
      attempt = view
      return readPersonaRowState(B)
    }))

    for (const r of [outside, otherAttempt, inside]) {
      expect('err' in r.outcome && r.outcome.err).toBe(err)
      expectQuiet(r)
    }
    expect(armed).toEqual([
      { key: B, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT },
      { key: B, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT },
      { key: B, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT },
    ])
    expect(attempt!.lastError).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, armed: true })
    // One onset for B's bad stretch, the form's (b.jg5 SRJ-1021): the repeats dedupe.
    expect(outageEmissions).toEqual([{ key: B, text: onset }])
  })

  test.each<[string, () => Error, string]>([
    ['an UNAVAILABLE error (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['an UNCLASSIFIED error (ErrInternal)', () => errInternal(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
  ])('inside a recovery attempt for B, %s is reported once to the installed sink with its cause (B only) and still propagates; outside any attempt, or inside one for A, nothing is reported', async (_label, build, cause) => {
    installRecordingSink()
    const err = build()
    installStub({ statusError: err })

    // Outside any attempt, and inside an attempt for another persona.
    const outside = await readQuietly()
    const otherAttempt = await readQuietly(() => runInAttempt(A, 'recovery', () => readPersonaRowState(B)))
    expect(armed).toEqual([])

    let attempt: AttemptView | undefined
    const inside = await readQuietly(() => runInAttempt(B, 'recovery', (view) => {
      attempt = view
      return readPersonaRowState(B)
    }))

    for (const r of [outside, otherAttempt, inside]) expect('err' in r.outcome && r.outcome.err).toBe(err)
    expect(armed).toEqual([{ key: B, kind: cause }])
    expect(attempt!.lastError).toEqual({ verb: 'status', causeKind: cause, armed: true })
    expectQuiet(inside)
  })

  test('inside a recovery attempt for B, no row (ErrSpawnNotFound) → absent, and nothing is reported to the sink', async () => {
    installRecordingSink()
    installStub({ statusError: new ErrSpawnNotFound('status', 'ErrSpawnNotFound', 'spawn not found') })

    const r = await readQuietly(() => runInAttempt(B, 'recovery', () => readPersonaRowState(B)))

    expect(r.outcome).toStrictEqual({ ok: { state: UNAVAILABLE_RETRY_ROW_ABSENT } })
    expect(armed).toEqual([])
    expectQuiet(r)
  })

  test('inside a recovery attempt for B, a row read that succeeds reports nothing', async () => {
    installRecordingSink()
    installStub({ statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }) })

    const r = await readQuietly(() => runInAttempt(B, 'recovery', () => readPersonaRowState(B)))

    expect(r.outcome).toStrictEqual({ ok: { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL } })
    expect(armed).toEqual([])
    expectQuiet(r)
  })
})

// ---------------------------------------------------------------------------
// whenLaunchSettled (b.av2 SR-6.6): a teardown waits for a launch still in
// flight for its key (the start pass's, which runs outside the serializer).
// ---------------------------------------------------------------------------

describe('whenLaunchSettled: waits for the key\'s launch in flight, never rejects, starts nothing (b.av2 SR-6.6)', () => {
  /** Whether `p` settled (either way) once pending continuations ran. */
  async function settledNow(p: Promise<unknown>): Promise<boolean> {
    let done = false
    p.then(() => { done = true }, () => { done = true })
    await settleNotices()
    return done
  }

  test('no launch in flight: resolves at once and makes no agent-director call', async () => {
    const calls = makeStubCallLog()
    installStub(calls)

    expect(await settledNow(whenLaunchSettled('K'))).toBe(true)
    expect(stubCallCount(calls)).toBe(0)
    expect(isLaunchInFlight('K')).toBe(false)
  })

  test('K\'s launch held open: K\'s wait stays pending until the spawn is released, L\'s resolves at once; one spawn in total', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' } }, fixtureDir)
    const held = holdSpawns(installStub({}))

    const launch = spawnForPersona(personaOf(cfg, 'K'), cfg)
    await held.entered('cscb_K')
    const waitK = whenLaunchSettled('K')

    expect(await settledNow(waitK)).toBe(false)
    expect(await settledNow(whenLaunchSettled('L'))).toBe(true)

    held.release('cscb_K')
    await waitK
    expect(await launch).toEqual({ key: 'K', action: 'spawned' })
    expect(held.calls).toHaveLength(1)
  })

  test('a launch whose promise rejects: the wait still resolves (never rejects), and a failed spawn settles it too', async () => {
    const cfg = makeStandInPersonaConfig({ K: { working_directory: '/x/k' } }, fixtureDir)
    captureStartupErrors()
    const held = holdSpawns(installStub({}))
    // A config whose spawn parameters cannot be built: the ladder itself rejects.
    const broken = Object.defineProperty({ ...cfg }, 'cron_table_path', { get: () => { throw new Error('unreadable') } })

    await withCapturedErr(async () => {
      const rejected = spawnForPersona(personaOf(cfg, 'K'), broken).catch((err: unknown) => err)
      await expect(whenLaunchSettled('K')).resolves.toBeUndefined()
      expect(await rejected).toBeInstanceOf(Error)

      const failing = spawnForPersona(personaOf(cfg, 'K'), cfg)
      await held.entered('cscb_K')
      const waitK = whenLaunchSettled('K')
      expect(await settledNow(waitK)).toBe(false)
      held.fail('cscb_K', errGeneric('spawn', 'ErrSpawnBroken'))
      await expect(waitK).resolves.toBeUndefined()
      expect((await failing).action).toBe('failed')
      await settleNotices()
    })
    expect(isLaunchInFlight('K')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC 20 (b.av2 SR-10.3, E13 Director decision 16): an agent-director error's
// text in the spawn and orphan-cleanup startup records and in the
// spawn-failure notice posted to Slack
// ---------------------------------------------------------------------------

describe('AC 20: agent-director failure text in startup records and the spawn-failure notice', () => {
  /** Persona `alpha` in a real temp working directory, the seam home installed. */
  function orphanConfig(): { cfg: PersonaConfig; home: string } {
    const home = useSpawnHome()
    return { cfg: makeMultiPersonaConfig([{ name: 'alpha', working_directory: fixtureSubdir('alpha-work') }], fixtureDir), home }
  }

  /** Stub alpha's sweep: one row with a wrong instance ID (swept: kill, then delete), `failing` the verb that rejects. */
  function installOrphan(failing: 'killError' | 'deleteError', err: Error): PersonaConfig {
    const { cfg, home } = orphanConfig()
    installStub({
      listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_alpha_old' }, personaOf(cfg, 'alpha'), home)] },
      [failing]: err,
    })
    return cfg
  }

  // Each site records `<what> failed …: <describeAgentDirectorFailure(err)>`
  // and no ` — <cause>` tail: the errName and the redacted description as
  // `message="…"` when the errName is a short identifier, else
  // describeThrownValue (the type, the redacted message `<errName>:
  // <description>`, frames). The description appears once.
  // (A spawn whose error has a token-shaped errName is UNCLASSIFIED, b.jg5
  // SRJ-313: refused with no spawn-failed record; its case follows this table.)
  test.each<[string, string, string, (err: Error) => Promise<void>]>([
    ['a failed orphan kill', 'orphan-cleanup', 'kill', async (err) => {
      expect(await reconcileOrphans(installOrphan('killError', err))).toEqual({ found: 1, killed: 1, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } })
    }],
    ['a failed orphan delete', 'orphan-cleanup', 'delete', async (err) => {
      expect(await reconcileOrphans(installOrphan('deleteError', err))).toEqual({ found: 1, killed: 0, failed: 1, prePersona: { kept: 0, live: 0, killFailed: 0 } })
    }],
    ['a failed orphan list', 'orphan-cleanup-list-failed', 'list', async (err) => {
      installStub({ listError: err })
      expect(await reconcileOrphans(orphanConfig().cfg)).toEqual({ found: 0, killed: 0, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } })
    }],
  ])('%s with a base AgentDirectorError whose errName is token-shaped and whose description holds a URL and a fake token → the %s record names its type and the redacted description once; nothing leaks', async (_label, classLabel, verb, run) => {
    const readLog = captureStartupErrors()
    const errLog = await withCapturedErr(() => run(new AgentDirectorError(verb, tokenErrName(), adDescription())))

    const entry = onlyStartupEntry(readLog(), classLabel)
    expect(entry).toContain(': AgentDirectorError message="')
    expect(entry).toContain(`${REDACTED_AD_DESCRIPTION}"`)
    // Once: no cause tail repeating the description.
    expect(entry).not.toContain(' — ')
    expect(entry.split(REDACTED_URL_PLACEHOLDER)).toHaveLength(2)
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })

  test('b.jg5 SRJ-313: a spawn failing with a base AgentDirectorError whose errName is token-shaped (UNCLASSIFIED) and whose description holds a URL and a fake token is refused: no spawn-failed record and no notice; its one refusal line names its type and the redacted description once; nothing leaks', async () => {
    const readLog = captureStartupErrors()
    installStub({ spawnError: new AgentDirectorError('spawn', tokenErrName(), adDescription()) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    expect(result).toEqual({ key: 'C', action: 'failed' })
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
    expect(notices).toEqual([])
    const refused = errLog.split('\n').filter((l) => l.startsWith(`[slack] spawnForPersona: spawn refused for ${renderPersonaRef('C', 'C')}: `))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain(': AgentDirectorError message="')
    expect(refused[0]).toContain(`${REDACTED_AD_DESCRIPTION}"`)
    expect(refused[0]!.split(REDACTED_URL_PLACEHOLDER)).toHaveLength(2)
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })

  // A LAUNCH FAILURE answer named by name (the base class, so the plain
  // spawn's handling, with no self-heal): the record's text is the point.
  test('a failed spawn with a safe errName → the spawn-failed record ends in `<errName> message="<redacted description>"`, with no cause tail', async () => {
    const readLog = captureStartupErrors()
    const launchFailureName = errTmuxSessionCreate('spawn').errName
    installStub({ spawnError: errGeneric('spawn', launchFailureName, adDescription()) })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const errLog = await withCapturedErr(async () => {
      await spawnForPersona(personaOf(cfg, 'C'), cfg)
    })

    const entry = onlyStartupEntry(readLog(), 'spawn-failed')
    expect(entry.endsWith(`] [spawn-failed] spawn failed for ${renderPersonaRef('C', 'C')}: ${launchFailureName} message=${JSON.stringify(REDACTED_AD_DESCRIPTION)}`)).toBe(true)
    assertNoLeak({ errLog, startupErrorsLog: readLog(), notices })
  })

  // notifySpawnFailure (E13 carry): the notice's Error line is
  // "`<label>` — <description>". The label is the errName when it is a short
  // identifier, else the describer's type and frames without its message (so
  // neither the unchecked errName nor a second copy of the description shows);
  // the description is redacted first and then cut to 300 characters, so text
  // past character 300 of the raw description shows when a long URL shrinks
  // to its placeholder. The description appears once in the posted text.
  test.each<[string, () => string, (label: string) => void]>([
    ['a token-shaped errName is named by its type', tokenErrName, (label) => expect(label.startsWith('AgentDirectorError ')).toBe(true)],
    ['a safe errName is named as is', () => 'ErrSpawnBroken', (label) => expect(label).toBe('ErrSpawnBroken')],
  ])('the spawn-failure notice posted to Slack: %s; its description (a fake token and a ?ticket= URL) is redacted, then capped at 300 characters, and shown once; nothing leaks', async (_label, errName, checkLabel) => {
    captureStartupErrors()
    const cfg = makeNoticeConfig()
    const h = installNoticeNotifier(cfg, { leakMarker: LEAK_SENTINEL })
    const description =
      `wss://wss-stub.invalid/link/${'u'.repeat(380)}/?ticket=${LEAK_SENTINEL} ${fakeToken(BOT_TOKEN_PREFIX, 'notice')} ${'y'.repeat(400)} end`

    notifySpawnFailure(NOTICE_KEY, new AgentDirectorError('spawn', errName(), description), false)
    await settleNotices()

    const text = expectOneNoticeToDestination(h)
    const errorLine = text.split('\n').filter((l) => l.startsWith('  Error: `'))
    expect(errorLine).toHaveLength(1)
    const [, label, shown] = /^ {2}Error: `(.*)` — (.*)$/.exec(errorLine[0]!) ?? []
    checkLabel(label!)
    expect(shown).toBe(`${REDACTED_URL_PLACEHOLDER} ${REDACTED_TOKEN_PLACEHOLDER} ${'y'.repeat(400)} end`.slice(0, 300))
    // Once: the label carries no copy of the description.
    expect(text.split(REDACTED_URL_PLACEHOLDER)).toHaveLength(2)
    expect(text.split(REDACTED_TOKEN_PLACEHOLDER)).toHaveLength(2)
    assertNoLeak({ text, logs: h.logs, notices })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105: UNAVAILABLE and read errors in the collision ladder (AC 25)
//
// Every case runs on `makeRecoveryHarness` (both settings 0): the real retry
// controller is the trigger sink, so a refusal arms P's timer and the failed
// launch carries the refusal marker, and the `tmux-unresponsive` condition is
// installed as `main()` installs it. Launches go through the real
// `spawnForPersona` as the start pass makes them (`h.launch`, so a
// `spawn-failed` startup-errors entry would be written), then once more
// through `launchSession`. Errors come from E4's by-name stub builders.
//
// At every site the refused call is the last launch or destructive call: the
// stub's `spawn`, `resume`, `kill`, `delete` and `send-keys` counts are
// exact, so a kill, delete or launch after the refusal (or a dead-session
// resume) fails the case. Each case also asserts no session-manager notice (a
// spawn-failure notice), no outage notice, no `spawn-failed` entry, one
// refusal line, a `{ failed, refused }` result, `launchSession` answering
// `'refused'`, a failure count left at 0, and persona B launching as before.
// After every case, nothing the harness captured leaks a secret
// (`assertNoLeak`, in each describe's `afterEach`).
// ---------------------------------------------------------------------------

/** E4's UNAVAILABLE forms of agent-director's own errors but `ErrTmuxKillFailed`, each built for the verb that meets it (by name). */
const SRJ105_UNAVAILABLE = unavailableForms('ErrUnknownErrorName', 'ErrCallTimeout', 'a wrapped UnknownError', 'ErrTmuxUnresponsive')

/** `ErrTmuxKillFailed`, the UNAVAILABLE form only a kill answers. */
const SRJ105_KILL_FAILED = unavailableForms('ErrTmuxKillFailed')[0]!

/** The launch and destructive calls a launch made, by verb. */
interface LaunchVerbCalls {
  spawn: number
  resume: number
  kill: number
  delete: number
  sendKeys: number
}

/** `LaunchVerbCalls` with every verb 0 but those in `calls`. */
function ladderCallsOf(calls: Partial<LaunchVerbCalls>): LaunchVerbCalls {
  return { spawn: 0, resume: 0, kill: 0, delete: 0, sendKeys: 0, ...calls }
}

/** The launch and destructive calls the harness's stub received. */
function ladderCallsMade(h: RecoveryHarness): LaunchVerbCalls {
  const c = h.stub.calls
  return {
    spawn: c.spawnCalls.length,
    resume: c.resumeCalls.length,
    kill: c.killCalls.length,
    delete: c.deleteCalls.length,
    sendKeys: c.sendKeysCalls.length,
  }
}

/** A site of the collision ladder where the launch of `persona` meets `err`. */
interface LadderSite {
  readonly name: string
  /** The verb of the refused call. */
  readonly verb: string
  /** Stub answers that make one launch meet `err` here; called before each launch. */
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
  /** Configuration or seams the site needs, set once before the first launch. */
  setup?(h: RecoveryHarness): void
  /** Every launch and destructive call one such launch makes, the refused one included. */
  readonly calls: LaunchVerbCalls
}

/** A row for `persona` in its own directory with its current labels (`cannedGetResult` in persona form), with `overrides`. */
function harnessRow(h: RecoveryHarness, persona: Persona, overrides: PersonaGetResultOverrides): CannedGetResult {
  return cannedGetResult(overrides, persona, h.home)
}

/** `persona`'s row reading `waiting` whose `config_dir` label is missing (b.av2 SR-6.2: never resumed). */
function unlabelledWaitingRow(h: RecoveryHarness, persona: Persona): PersonaGetResultOverrides {
  const labels: Record<string, string> = { ...harnessRow(h, persona, { state: 'waiting' }).labels }
  delete labels['config_dir']
  return { state: 'waiting', labels }
}

/** A row in another directory (the harness home), reading `state`. */
function elsewhere(h: RecoveryHarness, state: string): PersonaGetResultOverrides {
  return { cwd: h.home, state }
}

/** The working-row wait polls every 1 ms. */
function fastPolls(h: RecoveryHarness): void {
  h.config.agent_director_poll_interval_ms = 1
}

/** The working-row wait gives up after 30 ms and re-sweeps at its deadline (memo TTL 0), polling every 1 ms. */
function shortWait(h: RecoveryHarness): void {
  fastPolls(h)
  _setWaitForWaitingTimeoutMs(30)
  _setFindMissingMemoTtlMs(0)
}

/** `resume_enabled: false`: every row found is replaced (kill, delete, fresh spawn). */
function noResume(h: RecoveryHarness): void {
  h.config.resume_enabled = false
}

/** Every persona's tmux session is gone (the prober answers false; the file's `afterEach` restores it). */
function tmuxSessionsGone(): void {
  _setTmuxSessionProber(async () => false)
}

/**
 * Each spawn and resume the ladder makes, as the site where the launch meets
 * the error (the verb's own call is the last one).
 */
const SPAWN_AND_RESUME_SITES: readonly LadderSite[] = [
  { name: 'the first spawn', verb: 'spawn', script: (_h, _p, err) => ({ spawnError: err }), calls: ladderCallsOf({ spawn: 1 }) },
  {
    name: 'the self-heal retry spawn after the first spawn\'s ErrTmuxSessionCreate',
    verb: 'spawn',
    script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errTmuxSessionCreate('spawn')), cannedErr(err)] }),
    calls: ladderCallsOf({ spawn: 2 }),
  },
  {
    name: 'the retry spawn after the collision get\'s ErrSpawnNotFound',
    verb: 'spawn',
    script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(err)], getError: errSpawnNotFound() }),
    calls: ladderCallsOf({ spawn: 2 }),
  },
  { name: 'the resume of an ended row', verb: 'resume', script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }), calls: ladderCallsOf({ spawn: 1, resume: 1 }) },
  { name: 'the resume of a missing row', verb: 'resume', script: (h, p, err) => ({ ...collided(h, p, { state: 'missing' }), resumeError: err }), calls: ladderCallsOf({ spawn: 1, resume: 1 }) },
  {
    name: 'the self-heal spawn after the resume\'s ErrTmuxSessionCreate',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errTmuxSessionCreate('resume') }),
    calls: ladderCallsOf({ spawn: 2, resume: 1 }),
  },
  {
    name: 'the fresh spawn after the resume\'s ErrNoSessionId and its delete',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errNoSessionId() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }),
  },
  {
    name: 'the fresh spawn after the resume\'s ErrSpawnNotResumable, its kill and its delete',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errSpawnNotResumable() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, kill: 1, delete: 1 }),
  },
  {
    name: 'the fresh spawn after the resume\'s ErrSpawnNotFound',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errSpawnNotFound() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1 }),
  },
  {
    name: 'the fresh spawn of a replacement (resume_enabled false), after its kill and delete',
    verb: 'spawn',
    setup: noResume,
    script: (h, p, err) => collided(h, p, { state: 'ended' }, err),
    calls: ladderCallsOf({ spawn: 2, kill: 1, delete: 1 }),
  },
  {
    name: 'the fresh spawn of a replacement (a row in another directory), after its kill and delete',
    verb: 'spawn',
    script: (h, p, err) => collided(h, p, elsewhere(h, 'ended'), err),
    calls: ladderCallsOf({ spawn: 2, kill: 1, delete: 1 }),
  },
  {
    name: 'the self-heal spawn of a replacement after its fresh spawn\'s ErrTmuxSessionCreate',
    verb: 'spawn',
    script: (h, p, err) => collided(h, p, elsewhere(h, 'ended'), errTmuxSessionCreate('spawn'), err),
    calls: ladderCallsOf({ spawn: 3, kill: 1, delete: 1 }),
  },
]

/** The kill before each replacement: nothing is deleted or launched after it. */
const KILL_SITES: readonly LadderSite[] = [
  {
    name: 'the kill of a replacement (resume_enabled false)',
    verb: 'kill',
    setup: noResume,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
  },
  {
    name: 'the kill of a replacement (a row in another directory, read waiting)',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'waiting')), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
  },
  {
    name: 'the kill of a replacement (a row in another directory, read ended)',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'ended')), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
  },
  {
    name: 'the kill of a replacement (a missing config_dir label, after a dead-session verdict on a waiting row)',
    verb: 'kill',
    script: (h, p, err) => ({
      ...collided(h, p, unlabelledWaitingRow(h, p)),
      sendKeysError: errSpawnNotInteractive('send-keys'),
      killError: err,
    }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1, kill: 1 }),
  },
  {
    name: 'the kill after the resume\'s ErrSpawnNotResumable',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errSpawnNotResumable(), killError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, kill: 1 }),
  },
]

/** The delete in each replacement: nothing is launched after it. */
const DELETE_SITES: readonly LadderSite[] = [
  {
    name: 'the delete of a replacement (resume_enabled false)',
    verb: 'delete',
    setup: noResume,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1, delete: 1 }),
  },
  {
    name: 'the delete of a replacement (a row in another directory)',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'waiting')), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1, delete: 1 }),
  },
  {
    name: 'the delete after the resume\'s ErrSpawnNotResumable',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errSpawnNotResumable(), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, kill: 1, delete: 1 }),
  },
  {
    name: 'the delete after the resume\'s ErrNoSessionId',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errNoSessionId(), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, delete: 1 }),
  },
]

/** The reconnect's keystrokes, first try and the retry after ErrTmuxSendKeys: never 'dead-session' (no resume). */
const RECONNECT_SITES: readonly LadderSite[] = [
  {
    name: 'the reconnect of a waiting row',
    verb: 'send-keys',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: err }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1 }),
  },
  {
    name: 'the reconnect retry after ErrTmuxSendKeys on a waiting row',
    verb: 'send-keys',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysQueue: [cannedErr(errTmuxSendKeys()), cannedErr(err)] }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 2 }),
  },
  {
    name: 'the reconnect of a working row once its wait reads it waiting',
    verb: 'send-keys',
    setup: fastPolls,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusResult: cannedStatusResult({ state: 'waiting' }), sendKeysError: err }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1 }),
  },
  {
    name: 'the reconnect retry after ErrTmuxSendKeys on a working row its wait reads waiting',
    verb: 'send-keys',
    setup: fastPolls,
    script: (h, p, err) => ({
      ...collided(h, p, { state: 'working' }),
      statusResult: cannedStatusResult({ state: 'waiting' }),
      sendKeysQueue: [cannedErr(errTmuxSendKeys()), cannedErr(err)],
    }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 2 }),
  },
]

/** Every action site of the ladder: each spawn and resume, kill, delete and reconnect site above. */
const ACTION_SITES: readonly LadderSite[] = [...SPAWN_AND_RESUME_SITES, ...KILL_SITES, ...DELETE_SITES, ...RECONNECT_SITES]

/**
 * The reads of the ladder (b.jg5 SRJ-105's read-error row): the collision
 * `get`, the working-row wait's poll and timeout `status`, and the
 * ErrJsonlMissing diagnosis `get` (SRJ-114), made after the resume and before
 * its delete and fresh spawn.
 */
const READ_SITES: readonly LadderSite[] = [
  {
    name: 'the collision get',
    verb: 'get',
    script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the working-row wait\'s poll status',
    verb: 'status',
    setup: fastPolls,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the working-row wait\'s timeout status',
    verb: 'status',
    setup: shortWait,
    script: (h, p, err) => {
      // The row reads working at every poll; the status after the deadline's
      // fresh sweep (this launch's second) fails.
      const sweepsBefore = h.stub.calls.findMissingCalls.length
      return {
        ...collided(h, p, { state: 'working' }),
        statusFn: () =>
          h.stub.calls.findMissingCalls.length >= sweepsBefore + 2 ? err : cannedStatusResult({ state: 'working' }),
      }
    },
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the ErrJsonlMissing diagnosis get',
    verb: 'get',
    script: (h, p, err) => jsonlMissingDiagnosisGets(h, p, cannedErr(err)),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
  },
]

/** A findMissing sweep of the ladder, with the log prefix of its refusal line. */
interface SweepSite extends LadderSite {
  readonly logPrefix: string
}

/**
 * The ladder's findMissing sweeps (b.jg5 SRJ-105): an UNAVAILABLE sweep stops
 * the attempt there. The before-resume sweep of a dead session
 * (`resumeOrFreshSpawn`), the working-row wait's up-front and timeout sweeps,
 * and the sweep of a prompt row whose tmux session is gone
 * (`launchOnPromptRow`).
 */
const SWEEP_SITES: readonly SweepSite[] = [
  {
    name: 'the before-resume sweep of a waiting row\'s dead session (resumeOrFreshSpawn)',
    verb: 'find-missing',
    logPrefix: 'spawnForPersona: before resume',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: errSpawnNotInteractive('send-keys'), findMissingError: err }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1 }),
  },
  {
    name: 'the working-row wait\'s up-front sweep',
    verb: 'find-missing',
    logPrefix: 'waitForWaitingAndReconnect',
    setup: fastPolls,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), findMissingError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the working-row wait\'s timeout sweep',
    verb: 'find-missing',
    logPrefix: 'waitForWaitingAndReconnect: timeout',
    setup: shortWait,
    // The up-front sweep succeeds and the row reads working at every poll;
    // the sweep at the deadline fails.
    script: (h, p, err) => ({
      ...collided(h, p, { state: 'working' }),
      statusResult: cannedStatusResult({ state: 'working' }),
      findMissingQueue: [cannedOk(cannedFindMissing())],
      findMissingError: err,
    }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the sweep of a check_permission row whose tmux session is gone (launchOnPromptRow)',
    verb: 'find-missing',
    logPrefix: 'spawnForPersona: prompt row',
    setup: tmuxSessionsGone,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'check_permission' }), findMissingError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
]

/**
 * The optimistic spawn collides, the collision `get` reads an `ended` row, its
 * resume answers ErrJsonlMissing, and the diagnosis `get` answers `diagnosis`.
 */
function jsonlMissingDiagnosisGets(
  h: RecoveryHarness,
  persona: Persona,
  diagnosis: CannedResponse<CannedGetResult>,
): RecoveryStubScript {
  return {
    spawnQueue: [cannedErr(errInstanceIdCollision())],
    getQueue: [cannedOk(harnessRow(h, persona, { state: 'ended' })), diagnosis],
    resumeError: errJsonlMissing(),
  }
}

/** Every knob `script` set, cleared: the stub's defaults again. */
function clearedScript(script: RecoveryStubScript): RecoveryStubScript {
  return Object.fromEntries(Object.keys(script).map((knob) => [knob, undefined]))
}

/** The refusal lines `refusalAt` logged for persona `key`. */
function refusalLines(h: RecoveryHarness, key: string): string[] {
  return h.errors.filter((line) => line.includes(` refused for ${renderPersonaRef(key, key)}: `) && line.endsWith('nothing more is called (b.jg5 SRJ-105)'))
}

let srj105Harness: RecoveryHarness | undefined

/** A recovery harness over two personas, P and B, cleaned up after the case. */
function srj105Build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string } {
  const h = (srj105Harness = makeRecoveryHarness(options))
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** Each SRJ-105 describe's `afterEach`: nothing the case's harness captured leaks a secret, then the harness is cleaned up. */
function srj105AfterEach(): void {
  const h = srj105Harness
  srj105Harness = undefined
  if (h === undefined) return
  try {
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

/**
 * Launch P as the start pass does, with `site` meeting `err`; assert the
 * refusal's outcome (see the section comment); then launch it again through
 * `launchSession`, and launch B over the stub's defaults. Without `onsetText`
 * the outage state posts nothing. With it, P's `outageClass` flag is raised by
 * the first launch with one onset reading exactly `onsetText`, and is still
 * raised at the end, B's never: an
 * ENVIRONMENT answer raises `tmux-unavailable` (b.jg5 SRJ-311; the onset the
 * raising error's form picks, SRJ-1021), a CONFIG answer
 * `ad-config-malformed` (SRJ-316, SRJ-1018).
 */
async function expectRefusedAt(
  site: LadderSite,
  err: Error,
  triggerKind: string,
  onsetText?: string,
  outageClass: OutageClass = 'tmux-unavailable',
): Promise<{ h: RecoveryHarness; p: string }> {
  const { h, p, b } = srj105Build()
  const persona = harnessPersona(h, p)
  site.setup?.(h)
  const script = site.script(h, persona, err)
  h.script(script)

  const result = await h.launch(p)

  expect(result).toStrictEqual({ key: p, action: 'failed', refused: true })
  expect(ladderCallsMade(h)).toEqual(site.calls)
  expect(h.notices).toEqual([])
  if (onsetText === undefined) {
    expect(h.outageNotices).toEqual([])
  } else {
    expect(h.outageNotices.map((n) => n.key)).toEqual([p])
    expect(h.outageNotices[0]!.text).toBe(onsetText)
    expect(getOutageFlags(p).has(outageClass)).toBe(true)
  }
  expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
  expect(refusalLines(h, p)).toHaveLength(1)
  expect(h.triggers).toEqual([{ key: p, kind: triggerKind }])
  expect(h.controller.isArmed(p)).toBe(true)
  expect(getFailureCount(p)).toBe(0)

  // The restart path's launch meets the same refusal: 'refused', never counted.
  h.script(site.script(h, persona, err))
  expect(await launchSession(p, h.config)).toBe('refused')
  expect(getFailureCount(p)).toBe(0)
  expect(h.notices).toEqual([])
  expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)

  // B's launch is unaffected.
  h.script(clearedScript(script))
  expect(await h.launch(b)).toEqual({ key: b, action: 'spawned' })
  expect(h.controller.isArmed(b)).toBe(false)
  expect(h.triggers.filter((t) => t.key === b)).toEqual([])
  expect(h.notices).toEqual([])
  if (onsetText !== undefined) {
    expect(getOutageFlags(p).has(outageClass)).toBe(true)
    expect(getOutageFlags(b).has(outageClass)).toBe(false)
  }
  return { h, p }
}

/**
 * Launch P, then B, as the start pass does, both meeting a prompt row whose
 * tmux session is gone, so each reaches the prompt-row findMissing sweep.
 * P's sweep is held in flight until B has joined it, then answers `answer`
 * (fails with it when it is an error): P started the one sweep and B joined
 * it. Each row's first `get` (its collision get) reads it `check_permission`;
 * a later `get` of it (a post-run get) answers its entry in
 * `postRunGetErrors`, or the row again, and so does every `status` read.
 * Answers both launches' results.
 */
async function launchBothThroughOneSweep(
  h: RecoveryHarness,
  p: string,
  b: string,
  answer: Error | import('agent-director').FindMissingResult,
  postRunGetErrors: ReadonlyMap<string, Error> = new Map(),
): Promise<[SpawnPersonaResult, SpawnPersonaResult]> {
  const rows = new Map(
    [p, b].map((key) => {
      const row = harnessRow(h, harnessPersona(h, key), { state: 'check_permission' })
      return [row.claude_instance_id, [key, row] as const] as const
    }),
  )
  const read = new Set<string>()
  h.script({
    spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(errInstanceIdCollision())],
    getFn: (params) => {
      const entry = rows.get(params.claude_instance_id)
      if (entry === undefined) return errSpawnNotFound()
      const [key, row] = entry
      if (!read.has(key)) {
        read.add(key)
        return row
      }
      return postRunGetErrors.get(key) ?? row
    },
    statusResult: cannedStatusResult({ state: 'check_permission' }),
  })
  // Both tmux sessions are gone; B's probe is the second.
  let bProbed!: () => void
  const bReachedProbe = new Promise<void>((resolve) => (bProbed = resolve))
  let probes = 0
  _setTmuxSessionProber(async () => {
    if (++probes === 2) bProbed()
    return false
  })
  // P's sweep is held in flight until B has joined it.
  let sweepStarted!: () => void
  const pSwept = new Promise<void>((resolve) => (sweepStarted = resolve))
  let settleSweep!: { resolve(result: import('agent-director').FindMissingResult): void; reject(err: Error): void }
  const held = new Promise<import('agent-director').FindMissingResult>((resolve, reject) => (settleSweep = { resolve, reject }))
  h.stub.client.findMissing = async (params) => {
    h.stub.calls.findMissingCalls.push(params)
    sweepStarted()
    return held
  }

  const pLaunch = h.launch(p)
  await pSwept
  const bLaunch = h.launch(b)
  await bReachedProbe
  // A macrotask turn: B's launch runs on, over resolved stubs only, to the shared sweep.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (answer instanceof Error) settleSweep.reject(answer)
  else settleSweep.resolve(answer)
  return [await pLaunch, await bLaunch]
}

describe('b.jg5 SRJ-105: UNAVAILABLE is never destructive', () => {
  afterEach(srj105AfterEach)

  const spawnCross = SRJ105_UNAVAILABLE.flatMap(([what, make]) =>
    [...SPAWN_AND_RESUME_SITES, ...RECONNECT_SITES].map((site) => [what, site.name, make, site] as const),
  )
  test.each(spawnCross)('%s at %s: no kill, delete or launch after it, never dead-session, no notice or spawn-failed entry, refused and never counted; B launches', async (_what, _site, make, site) => {
    await expectRefusedAt(site, make(site.verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  const killCross = [...SRJ105_UNAVAILABLE, SRJ105_KILL_FAILED].flatMap(([what, make]) =>
    [...KILL_SITES, ...DELETE_SITES].map((site) => [what, site.name, make, site] as const),
  )
  test.each(killCross)('%s at %s: no delete or launch after it, no notice or spawn-failed entry, refused and never counted; B launches', async (what, _site, make, site) => {
    const kind = what === SRJ105_KILL_FAILED[0] ? UNAVAILABLE_RETRY_CAUSE_KILL_FAILED : UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE
    const { h, p } = await expectRefusedAt(site, make(site.verb), kind)
    // AC 64's half: ErrTmuxKillFailed never starts the condition.
    if (what === SRJ105_KILL_FAILED[0]) {
      expect(h.tmuxUnresponsive.holds(p)).toBe(false)
      expect(conditionStartedLines(h, p)).toEqual([])
    }
  })

  // An UNCLASSIFIED kill answer (an ErrInternal, an unhandled name such as
  // ErrKillBroken) is a refusal too: b.jg5 SRJ-313's describe below.

  test.each(SRJ105_UNAVAILABLE)('the kill after the resume\'s ErrSpawnNotResumable is declared a kill of a row read live: %s there starts P\'s condition (tmux-touching), where the same answer to a kill of a row in another directory read ended starts nothing', async (_what, make) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    h.script({ ...collided(h, persona, { state: 'ended' }), resumeError: errSpawnNotResumable(), killError: make('kill') })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'failed', refused: true })

    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    const started = conditionStartedLines(h, p)
    expect(started).toHaveLength(1)
    expect(started[0]).toContain(' — kill failed: ')

    assertNoLeak(h.captured())
    h.cleanup()
    srj105Harness = undefined
    const other = srj105Build()
    other.h.script({ ...collided(other.h, harnessPersona(other.h, other.p), elsewhere(other.h, 'ended')), killError: make('kill') })
    expect(await other.h.launch(other.p)).toStrictEqual({ key: other.p, action: 'failed', refused: true })
    expect(other.h.tmuxUnresponsive.holds(other.p)).toBe(false)
    expect(conditionStartedLines(other.h, other.p)).toEqual([])
  })

  test.each([...SRJ105_UNAVAILABLE, SRJ105_KILL_FAILED])('regression: the persona teardown\'s kill (killPersonaInstance, which the ladder\'s kill wraps) answering %s still rethrows it unchanged, quietly: no line, delete, notice, startup-errors entry or trigger', async (_what, make) => {
    const { h, p } = srj105Build()
    const err = make('kill')
    h.script({ killError: err })

    await expect(killPersonaInstance(p)).rejects.toBe(err)

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ kill: 1 }))
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.triggers).toEqual([])
  })

  /** A call whose UNAVAILABLE answer is logged and the launch goes on (no refusal), with the launch's outcome and its keystrokes. */
  interface PassThroughSite {
    readonly name: string
    readonly verb: string
    script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
    setup?(h: RecoveryHarness): void
    readonly action: SpawnPersonaResult['action']
    readonly sendKeys: number
  }

  // The dialog approver's pane read and Enter left this table: the approver
  // runs after its launch call returned, outside P's attempt (b.jg5 SRJ-401),
  // and its rows are the describe "the dialog approver's calls are outside
  // P's launch attempt" below.
  const PASS_THROUGH_SITES: readonly PassThroughSite[] = [
    {
      name: 'the working-row wait\'s pane read',
      verb: 'read-pane',
      script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusResult: cannedStatusResult({ state: 'working' }), readPaneError: err }),
      setup: (h) => {
        shortWait(h)
        // At a restart delay the wait's give-up raises no not-connected notice.
        h.config.session_restart_delay = 60
      },
      action: 'not-reconnected',
      sendKeys: 0,
    },
  ]

  const passThroughCross = PASS_THROUGH_SITES.flatMap((site) => SRJ105_UNAVAILABLE.map(([what, make]) => [site.name, what, make, site] as const))
  test.each(passThroughCross)('regression: %s answering %s keeps its outcome: logged, the launch goes on, no kill, delete, resume or notice, no spawn-failed entry', async (_site, _what, make, site) => {
    const { h, p } = srj105Build()
    site.setup?.(h)
    h.script(site.script(h, harnessPersona(h, p), make(site.verb)))

    expect(await h.launch(p)).toEqual({ key: p, action: site.action })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: site.sendKeys }))
    expect(h.stub.calls.readPaneCalls.length).toBeGreaterThan(0)
    expect(h.notices).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(refusalLines(h, p)).toEqual([])
    expect(getFailureCount(p)).toBe(0)
  })
})

describe('b.jg5 SRJ-105: a read error at the collision get, the working-row wait or the ErrJsonlMissing diagnosis get is handled as UNAVAILABLE, and an UNAVAILABLE findMissing sweep stops the attempt', () => {
  afterEach(srj105AfterEach)

  /** The UNAVAILABLE forms, then an UNCLASSIFIED read error and a store that cannot be opened (UNCLASSIFIED too). */
  const READ_ERRORS: ReadonlyArray<readonly [string, (verb: string) => Error, string]> = [
    ...SRJ105_UNAVAILABLE,
    ['an UNCLASSIFIED read error (ErrTimeout)', (verb) => errGeneric(verb, 'ErrTimeout'), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a store that cannot be opened (ErrSchemaMismatch)', () => errSchemaMismatch(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
  ]

  const cross = READ_ERRORS.flatMap(([what, make, kind]) => READ_SITES.map((site) => [what, site.name, make, kind, site] as const))
  test.each(cross)('%s at %s: no delete, kill, launch, notice, inconclusive entry or dead-session, refused and never counted, P\'s condition is not started and nothing latches; B launches', async (_what, _site, make, kind, site) => {
    const { h, p } = await expectRefusedAt(site, make(site.verb), kind)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(0)
    // b.jg5 SRJ-114: a read error at a get site latches no one.
    expect(h.latchEvents).toEqual([])
  })

  // b.jg5 SRJ-114: the diagnosis get fed the kill-failure form too (E10's
  // fifth builder) is refused the same way, with its own cause.
  test('b.jg5 SRJ-114: ErrTmuxKillFailed at the ErrJsonlMissing diagnosis get: no delete, kill, launch, notice or inconclusive entry, refused and never counted, P\'s condition is not started and nothing latches; B launches', async () => {
    const site = READ_SITES.find((s) => s.name === 'the ErrJsonlMissing diagnosis get')!
    const { h, p } = await expectRefusedAt(site, SRJ105_KILL_FAILED[1](site.verb), SRJ105_KILL_FAILED[2])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(0)
    expect(h.latchEvents).toEqual([])
  })

  // b.jg5 SRJ-114: readPersonaTranscript's get, reached from the restart
  // path's check of a working row with an idle pane. A read error there is
  // no evidence: the check defers, so the restart path types nothing, kills
  // and launches nothing, and nothing is counted or started.
  test.each([...READ_ERRORS, SRJ105_KILL_FAILED])('b.jg5 SRJ-114: %s at the transcript get of the restart path\'s working-row check (checkWorkingRowPane): unreadable, no evidence: defer, nothing typed, killed or launched, nothing counted, P\'s condition not started, nothing latched', async (_what, make) => {
    const { h, p } = srj105Build()
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getError: make('get') })

    expect(await checkWorkingRowPane(p, harnessPersona(h, p))).toBe('defer')

    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p)])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expect(getFailureCount(p)).toBe(0)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(h.latchEvents).toEqual([])
    expect(h.notices).toEqual([])
    const unreadable = h.errors.filter((line) => line.includes(`persona=${p} is working and its pane shows an idle screen, but`))
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toContain('reading its agent-director row failed: ')
  })

  test('regression: ErrSpawnNotFound at the transcript get of checkWorkingRowPane reads the row as absent: unreadable, defer, one line naming ErrSpawnNotFound; nothing latches', async () => {
    const { h, p } = srj105Build()
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getError: errSpawnNotFound() })

    expect(await checkWorkingRowPane(p, harnessPersona(h, p))).toBe('defer')

    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expect(h.latchEvents).toEqual([])
    const unreadable = h.errors.filter((line) => line.includes(`persona=${p} is working and its pane shows an idle screen, but`))
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toContain(ErrSpawnNotFound.name)
    expect(unreadable[0]).not.toContain('reading its agent-director row failed: ')
  })

  // A sweep is no read verb: of READ_ERRORS the UNAVAILABLE forms are a
  // refusal there with the UNAVAILABLE cause; the UNCLASSIFIED ones are a
  // refusal with the UNCLASSIFIED cause (b.jg5 SRJ-313's describe below).
  const sweepCross = SRJ105_UNAVAILABLE.flatMap(([what, make, kind]) => SWEEP_SITES.map((site) => [what, site.name, make, kind, site] as const))
  test.each(sweepCross)('%s at %s: the attempt stops there: no resume, kill, delete, launch, notice or spawn-failed entry, refused and never counted, and P\'s condition is not started; B launches', async (_what, _site, make, kind, site) => {
    const { h, p } = await expectRefusedAt(site, make(site.verb), kind)
    // Both launches (the start pass's and launchSession's) were refused at this sweep.
    const refusedAt = `[slack] ${site.logPrefix}: findMissing sweep refused for ${renderPersonaRef(p, p)}: `
    expect(refusalLines(h, p).map((line) => line.startsWith(refusedAt))).toEqual([true, true])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
  })

  // The UNCLASSIFIED read errors at this sweep are refused (b.jg5 SRJ-313's
  // describe below); an UNUSABLE NAME answer is still no refusal there, and,
  // the sweep being no verb on P's own row, latches no one (b.jg5 SRJ-512).
  test('contrast: an UNUSABLE NAME answer at the before-resume sweep is no refusal and latches no one: logged, and the resume goes on', async () => {
    const { h, p } = srj105Build()
    h.script({ ...SWEEP_SITES[0]!.script(h, harnessPersona(h, p), errUnusableName()) })

    expect(await h.launch(p)).toEqual({ key: p, action: 'resumed' })

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: 1, resume: 1 }))
    expect(h.errors.filter((line) => line.startsWith(`[slack] spawnForPersona: before resume: findMissing sweep failed for ${renderPersonaRef(p, p)}: `) && line.endsWith(' — proceeding'))).toHaveLength(1)
    expect(refusalLines(h, p)).toEqual([])
    expect(h.triggers).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
    expect(h.latch.isLatched(p)).toBe(false)
    expect(h.latchEvents).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript, ((h: RecoveryHarness) => void) | undefined, SpawnPersonaResult['action'], Partial<LaunchVerbCalls>]>([
    ['the collision get (the row went away: one retry spawn)', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errSpawnNotFound() }), undefined, 'spawned', { spawn: 2 }],
    ['the working-row wait\'s poll status (its tmux session alive: not reconnected)', (h, p) => ({ ...collided(h, p, { state: 'working' }), statusError: errSpawnNotFound() }), fastPolls, 'not-reconnected', { spawn: 1 }],
    [
      'the working-row wait\'s timeout status (the tmux fallback, alive: not reconnected)',
      (h, p) => {
        const sweepsBefore = h.stub.calls.findMissingCalls.length
        return {
          ...collided(h, p, { state: 'working' }),
          statusFn: () => (h.stub.calls.findMissingCalls.length >= sweepsBefore + 2 ? errSpawnNotFound() : cannedStatusResult({ state: 'working' })),
        }
      },
      shortWait,
      'not-reconnected',
      { spawn: 1 },
    ],
    [
      'the ErrJsonlMissing diagnosis get (the row went away: inconclusive, delete and fresh spawn)',
      (h, p) => jsonlMissingDiagnosisGets(h, p, cannedErr(errSpawnNotFound())),
      undefined,
      'fresh-after-inconclusive-amnesia',
      { spawn: 2, resume: 1, delete: 1 },
    ],
  ])('regression: ErrSpawnNotFound at %s keeps its meaning; nothing is refused', async (_site, script, setup, action, calls) => {
    const { h, p } = srj105Build()
    setup?.(h)
    h.script(script(h, harnessPersona(h, p)))

    expect(await h.launch(p)).toEqual({ key: p, action })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf(calls))
    expect(refusalLines(h, p)).toEqual([])
    expect(h.triggers).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
  })

  // The refusal cases' "no notice, no inconclusive entry" is only evidence if
  // the harness captures that notice and entry: ErrSpawnNotFound at the
  // diagnosis get (the row read as absent, b.jg5 SRJ-114) still posts the one
  // inconclusive notice and writes the one jsonl-diagnosis-inconclusive
  // entry, both naming ErrSpawnNotFound, and latches nothing.
  test('regression: ErrSpawnNotFound at the ErrJsonlMissing diagnosis get still posts the inconclusive notice and writes the jsonl-diagnosis-inconclusive entry the harness captures, both naming the absent row\'s ErrSpawnNotFound; nothing latches', async () => {
    const { h, p } = srj105Build()
    h.script(jsonlMissingDiagnosisGets(h, harnessPersona(h, p), cannedErr(errSpawnNotFound())))

    expect(await h.launch(p)).toEqual({ key: p, action: 'fresh-after-inconclusive-amnesia' })

    expect(h.notices.filter((n) => n.key === p && n.text.includes(ErrSpawnNotFound.name))).toHaveLength(1)
    expect(onlyStartupEntry(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toContain(ErrSpawnNotFound.name)
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(h.latchEvents).toEqual([])
  })
})

describe('b.jg5 SRJ-105 with E8\'s refusal marker: a refused kill on a replace path is followed by no delete and no launch, answers \'refused\' and is never counted', () => {
  afterEach(srj105AfterEach)

  /** Each replace path, as the stub answers for the launch after the collision; its kill is its first kill. */
  const REPLACE_PATHS: ReadonlyArray<readonly [string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript, ((h: RecoveryHarness) => void) | undefined, Partial<LaunchVerbCalls>]> = [
    ['resume_enabled false', (h, p) => collided(h, p, { state: 'ended' }), noResume, { spawn: 1, kill: 1 }],
    ['a row in another directory', (h, p) => collided(h, p, elsewhere(h, 'ended')), undefined, { spawn: 1, kill: 1 }],
    ['the resume\'s ErrSpawnNotResumable', (h, p) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errSpawnNotResumable() }), undefined, { spawn: 1, resume: 1, kill: 1 }],
  ]

  /** The kill refusals: the UNAVAILABLE forms, and a CONFIG answer (b.jg5 SRJ-105's CONFIG row, SRJ-110, SRJ-316). */
  const KILL_REFUSALS: ReadonlyArray<readonly [string, (verb: string) => Error, string]> = [
    ...unavailableForms('ErrTmuxUnresponsive', 'ErrTmuxKillFailed'),
    ['a CONFIG answer (ErrConfigMalformed, b.jg5 SRJ-316)', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
    // AC 69: an injected ErrInternal is never counted (b.jg5 SRJ-313).
    ['an UNCLASSIFIED ErrInternal (b.jg5 SRJ-313)', () => errInternal(), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
    ['an UNCLASSIFIED unhandled name (ErrKillBroken, b.jg5 SRJ-313)', (verb) => errGeneric(verb, 'ErrKillBroken'), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
  ]

  const cross = REPLACE_PATHS.flatMap(([path, script, setup, calls]) => KILL_REFUSALS.map(([what, make]) => [path, what, script, setup, calls, make] as const))

  test.each(cross)('%s, its kill answering %s: { failed, refused } from spawnForPersona, \'refused\' from launchSession, and the restart path\'s retry answers refused with the failure count still 0', async (_path, _what, script, setup, calls, make) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    setup?.(h)
    h.script({ ...script(h, persona), killError: make('kill') })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'failed', refused: true })
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf(calls))

    h.script({ ...script(h, persona), killError: make('kill') })
    expect(await launchSession(p, h.config)).toBe('refused')
    expect(h.stub.calls.deleteCalls).toEqual([])

    // The restart path: its liveness read finds the row dead, its own kill
    // succeeds, and the launch's replacement kill is refused.
    h.script({ ...script(h, persona), killError: undefined, killQueue: [cannedOk({}), cannedErr(make('kill'))], statusResult: cannedStatusResult({ state: 'ended' }) })
    expect(await runRestartRetry(p, persona.working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)

    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expect(h.notices).toEqual([])
    expect(h.capReached).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-311: ENVIRONMENT (`ErrTmuxNotAvailable`) at the collision ladder,
// the reconnect and the working-row wait (SRJ-105's ENVIRONMENT row)
//
// Every site of the SRJ-105 cases above, fed each ENVIRONMENT form, is a
// refusal through `expectRefusedAt`: the stub's call counts are exact (no
// kill, delete, resume or launch after it, never dead-session), no
// spawn-failure notice, no `spawn-failed` entry, one refusal line, P's timer
// armed with the ENVIRONMENT cause, `launchSession` answering 'refused', the
// failure count left at 0, and B launching. On top of that, P's
// `tmux-unavailable` outage is raised with one onset and stays raised, and
// ENVIRONMENT never starts P's `tmux-unresponsive` condition (SRJ-307).
// ---------------------------------------------------------------------------

/**
 * The ENVIRONMENT answers, each built for the verb that meets it (by name),
 * with the onset it raises: tmux cannot be run, with today's onset text, and
 * the different-server form, with b.jg5 SRJ-1021's.
 */
const SRJ311_ENVIRONMENT: ReadonlyArray<readonly [string, (verb: string) => Error, string]> = [
  ['ErrTmuxNotAvailable (tmux cannot be run)', (verb) => errTmuxNotAvailable(undefined, verb), ONSET_TEMPLATES['tmux-unavailable']()],
  ['ErrTmuxNotAvailable (not the tmux server the agent was launched on)', (verb) => errTmuxNotAvailableDifferentServer(undefined, verb), tmuxServerChangedOnset()],
]

describe('b.jg5 SRJ-311: ENVIRONMENT (ErrTmuxNotAvailable) at the collision ladder, the reconnect and the working-row wait is a refusal: never destructive, never counted, one tmux-unavailable onset', () => {
  afterEach(srj105AfterEach)

  const destructiveCross = SRJ311_ENVIRONMENT.flatMap(([what, make, text]) =>
    ACTION_SITES.map((site) => [what, site.name, make, text, site] as const),
  )
  test.each(destructiveCross)('b.jg5 SRJ-311: %s at %s: nothing destructive after it, never dead-session, no notice or spawn-failed entry, refused and never counted, one tmux-unavailable onset, P\'s condition not started; B launches', async (_what, _site, make, text, site) => {
    const { h, p } = await expectRefusedAt(site, make(site.verb), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, text)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
  })

  const readCross = SRJ311_ENVIRONMENT.flatMap(([what, make, text]) => READ_SITES.map((site) => [what, site.name, make, text, site] as const))
  test.each(readCross)('b.jg5 SRJ-311: %s at %s: no tmux probe, no delete, kill, launch, notice, inconclusive entry or dead-session, refused and never counted, one tmux-unavailable onset, P\'s condition not started; B launches', async (_what, _site, make, text, site) => {
    // Every tmux session reads gone: a tmux fallback would give dead-session
    // and a resume, which the exact call counts would catch.
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => {
      probed.push(name)
      return false
    })
    const { h, p } = await expectRefusedAt(site, make(site.verb), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, text)
    expect(probed).toEqual([])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(0)
  })

  const sweepCross = SRJ311_ENVIRONMENT.flatMap(([what, make, text]) => SWEEP_SITES.map((site) => [what, site.name, make, text, site] as const))
  test.each(sweepCross)('b.jg5 SRJ-311: %s at %s: the sweep is refused and the attempt stops there: no resume, kill, delete, launch, notice or spawn-failed entry, refused and never counted, one tmux-unavailable onset; B launches', async (_what, _site, make, text, site) => {
    const { h, p } = await expectRefusedAt(site, make(site.verb), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, text)
    // Both launches (the start pass's and launchSession's) were refused at this sweep.
    const refusedAt = `[slack] ${site.logPrefix}: findMissing sweep refused for ${renderPersonaRef(p, p)}: `
    expect(refusalLines(h, p).map((line) => line.startsWith(refusedAt))).toEqual([true, true])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105's CONFIG row, SRJ-316: a CONFIG answer (`ErrConfigMalformed`)
// at the collision ladder, the reconnect, the working-row wait and the
// findMissing sweeps
//
// "No action, nothing counted, never 'dead'; the retry timer is armed." Every
// site of the SRJ-105 cases above, fed the stub's CONFIG answer, is a refusal
// through `expectRefusedAt`: the stub's call counts are exact (no kill, delete,
// resume or launch after it, never a dead-session resume), no spawn-failure
// notice, no `spawn-failed` entry, one refusal line, P's timer armed with the
// CONFIG cause, `launchSession` answering 'refused', the failure count left at
// 0, and B launching. On top of that, P's `ad-config-malformed` outage is
// raised by the wrapper with one onset (SRJ-1018's, built by `src/` from the
// thrown value) and one raise line per onset, and CONFIG never starts P's
// `tmux-unresponsive` condition (SRJ-307). A read site never reaches the tmux
// fallback, and the ErrJsonlMissing diagnosis get writes no inconclusive entry.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-105, SRJ-316: a CONFIG answer (ErrConfigMalformed) at the collision ladder, the reconnect, the working-row wait and the findMissing sweeps is a refusal: no action, never counted, never dead, P\'s timer armed with the CONFIG cause, one ad-config-malformed onset', () => {
  afterEach(srj105AfterEach)

  /**
   * What every CONFIG refusal adds to `expectRefusedAt`'s checks: P holds the
   * `ad-config-malformed` flag only, its condition was never started, every
   * outage notice was P's onset (one per raise, each with its raise line; a
   * later launch's successful wrapped call may clear the flag and post the
   * all-clear before its own CONFIG raises it again), and B holds no flag.
   */
  function expectConfigOutageOnly(h: RecoveryHarness, p: string, onset: string): void {
    const [, b] = h.keys as [string, string]
    expect([...getOutageFlags(p)]).toEqual(['ad-config-malformed'])
    expect([...getOutageFlags(b)]).toEqual([])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(h.outageNotices.every((n) => n.key === p)).toBe(true)
    const onsets = h.outageNotices.filter((n) => n.text === onset)
    expect(onsets.length).toBeGreaterThanOrEqual(1)
    expect(adConfigMalformedRaiseLines(h, p)).toHaveLength(onsets.length)
    expect(adConfigMalformedRaiseLines(h, b)).toEqual([])
  }

  test.each(ACTION_SITES.map((site) => [site.name, site] as const))('b.jg5 SRJ-105, SRJ-316: CONFIG at %s: nothing destructive after it, never dead-session, no notice or spawn-failed entry, refused and never counted, P armed with the CONFIG cause, one ad-config-malformed onset, P\'s condition not started; B launches', async (_name, site) => {
    const err = errConfigMalformed()
    const onset = adConfigMalformedOnset(err)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_CONFIG, onset, 'ad-config-malformed')
    expectConfigOutageOnly(h, p, onset)
  })

  test.each(READ_SITES.map((site) => [site.name, site] as const))('b.jg5 SRJ-105, SRJ-114, SRJ-115, SRJ-316: CONFIG at %s: no tmux probe, no delete, kill, launch, notice, inconclusive entry or dead-session, refused and never counted, P armed with the CONFIG cause, one ad-config-malformed onset; B launches', async (_name, site) => {
    // Every tmux session reads gone: a tmux fallback would give dead-session
    // and a resume, which the exact call counts would catch.
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => {
      probed.push(name)
      return false
    })
    const err = errConfigMalformed()
    const onset = adConfigMalformedOnset(err)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_CONFIG, onset, 'ad-config-malformed')
    expect(probed).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(0)
    expectConfigOutageOnly(h, p, onset)
  })

  test.each(SWEEP_SITES.map((site) => [site.name, site] as const))('b.jg5 SRJ-105, SRJ-316: CONFIG at %s: the sweep is refused and the attempt stops there: no resume, kill, delete, launch, notice or spawn-failed entry, refused and never counted, P armed with the CONFIG cause, one ad-config-malformed onset; B launches', async (_name, site) => {
    const err = errConfigMalformed()
    const onset = adConfigMalformedOnset(err)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_CONFIG, onset, 'ad-config-malformed')
    // Both launches (the start pass's and launchSession's) were refused at this sweep.
    const refusedAt = `[slack] ${site.logPrefix}: findMissing sweep refused for ${renderPersonaRef(p, p)}: `
    expect(refusalLines(h, p).map((line) => line.startsWith(refusedAt))).toEqual([true, true])
    expectConfigOutageOnly(h, p, onset)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105's UNCLASSIFIED row, SRJ-313: an UNCLASSIFIED outcome at the
// collision ladder, the reconnect, the working-row wait and the findMissing
// sweeps
//
// "No step follows" (SRJ-110, SRJ-111, SRJ-113). Every site of the SRJ-105
// cases above, fed an UNCLASSIFIED answer (an `ErrInternal` whose description
// does not carry the unusable recorded name, a name CSCB gives no handling,
// and at every action site `ErrSystemInstallDisappeared`), is a refusal
// through `expectRefusedAt`: the stub's call counts are exact (no kill,
// delete, resume or launch after it, never a dead-session resume), no
// spawn-failure notice, no `spawn-failed` entry, one refusal line, P's timer
// armed with the UNCLASSIFIED cause (a read keeps E10's read-error cause),
// `launchSession` answering 'refused', the failure count left at 0, and B
// launching. On top of that, P's `tmux-unresponsive` condition is never
// started (SRJ-307), the outcome is reported to P's unclassified-error
// episode (one started line across both launches, quoting the classifier's
// rendering; the episode open; no alert at the same instant), B's episode
// stays closed, and `ErrSystemInstallDisappeared` still raises P's
// `ad-unreachable` with one onset (SRJ-104, Q-3). The exact-once report and
// the arming are pinned over recording sinks at the end.
// ---------------------------------------------------------------------------

/** The UNCLASSIFIED answers fed to every site, each built for the verb that meets it (by name). */
const SRJ313_UNCLASSIFIED: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ['an ErrInternal (its description not the unusable recorded name)', () => errInternal()],
  ['a name CSCB gives no handling (ErrNotHandled)', (verb) => errGeneric(verb, 'ErrNotHandled')],
]

/**
 * At a findMissing sweep (not a read verb) every UNCLASSIFIED answer is a
 * refusal (b.jg5 SRJ-105, SRJ-313), the read errors of the SRJ-105 read
 * describe included.
 */
const SRJ313_SWEEP_UNCLASSIFIED: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ...SRJ313_UNCLASSIFIED,
  ['an UNCLASSIFIED read error (ErrTimeout)', (verb) => errGeneric(verb, 'ErrTimeout')],
  ['a store that cannot be opened (ErrSchemaMismatch)', () => errSchemaMismatch()],
]

describe('b.jg5 SRJ-105, SRJ-313: an UNCLASSIFIED outcome at the collision ladder, the reconnect, the working-row wait and the findMissing sweeps is a refusal: no step follows, never counted, never dead, P\'s timer armed, reported once to P\'s unclassified-error episode', () => {
  afterEach(srj105AfterEach)

  /**
   * What every UNCLASSIFIED refusal adds to `expectRefusedAt`'s checks: P's
   * condition was never started; `err` was reported to P's unclassified-error
   * episode (one started line, quoting the classifier's rendering of it, for
   * both launches) and the episode is open with no alert posted; B's episode
   * never began.
   */
  function expectReportedToEpisode(h: RecoveryHarness, p: string, err: unknown): void {
    const [, b] = h.keys as [string, string]
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(unclassifiedStartedLines(h, p)).toEqual([unclassifiedStartedLine(p, err)])
    expect(h.unclassifiedErrorOpen(p)).toBe(true)
    expect(h.unclassifiedErrorOpen(b)).toBe(false)
    expect(unclassifiedStartedLines(h, b)).toEqual([])
    expect(h.episodeNotices).toEqual([])
  }

  const actionCross = SRJ313_UNCLASSIFIED.flatMap(([what, make]) => ACTION_SITES.map((site) => [what, site.name, make, site] as const))
  test.each(actionCross)('b.jg5 SRJ-313: %s at %s: no kill, delete or launch after it, never dead-session, no notice or spawn-failed entry, refused and never counted, P armed with the UNCLASSIFIED cause, reported once to P\'s episode, P\'s condition not started; B launches', async (_what, _site, make, site) => {
    const err = make(site.verb)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED)
    expectReportedToEpisode(h, p, err)
  })

  test.each(ACTION_SITES.map((site) => [site.name, site] as const))('b.jg5 SRJ-104, SRJ-313: ErrSystemInstallDisappeared at %s: refused as any UNCLASSIFIED outcome (nothing after it, never counted, P armed with the UNCLASSIFIED cause, reported once to P\'s episode), and P\'s ad-unreachable is raised with one onset; B launches', async (_name, site) => {
    const err = errSystemInstallDisappeared(site.verb)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, ONSET_TEMPLATES['ad-unreachable'](err.binaryPath), 'ad-unreachable')
    expectReportedToEpisode(h, p, err)
  })

  test.each(READ_SITES.map((site) => [site.name, site] as const))('b.jg5 SRJ-105, SRJ-313: an ErrInternal at %s keeps the read-error outcome (no tmux probe, no delete, kill, launch, notice, inconclusive entry or dead-session, refused and never counted, P armed with the read-error cause) and is reported once to P\'s episode; B launches', async (_name, site) => {
    // Every tmux session reads gone: a tmux fallback would give dead-session
    // and a resume, which the exact call counts would catch.
    const probed: string[] = []
    _setTmuxSessionProber(async (name) => {
      probed.push(name)
      return false
    })
    const err = errInternal()
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_READ_ERROR)
    expect(probed).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(0)
    expectReportedToEpisode(h, p, err)
  })

  const sweepCross = SRJ313_SWEEP_UNCLASSIFIED.flatMap(([what, make]) => SWEEP_SITES.map((site) => [what, site.name, make, site] as const))
  test.each(sweepCross)('b.jg5 SRJ-105, SRJ-313: %s at %s: the sweep is refused and the attempt stops there: no resume, kill, delete, launch, notice or spawn-failed entry, refused and never counted, P armed with the UNCLASSIFIED cause, reported once to P\'s episode; B launches', async (_what, _site, make, site) => {
    const err = make(site.verb)
    const { h, p } = await expectRefusedAt(site, err, UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED)
    // Both launches (the start pass's and launchSession's) were refused at this sweep.
    const refusedAt = `[slack] ${site.logPrefix}: findMissing sweep refused for ${renderPersonaRef(p, p)}: `
    expect(refusalLines(h, p).map((line) => line.startsWith(refusedAt))).toEqual([true, true])
    expectReportedToEpisode(h, p, err)
  })

  test.each(SRJ105_UNAVAILABLE)('contrast: an UNAVAILABLE outcome (%s) at the first spawn is refused but never reported to P\'s unclassified-error episode', async (_what, make, kind) => {
    const { h, p } = await expectRefusedAt(SPAWN_AND_RESUME_SITES[0]!, make('spawn'), kind)
    expect(unclassifiedStartedLines(h, p)).toEqual([])
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
  })

  test('outside a launch or recovery attempt nothing is reported or armed: the persona teardown\'s kill (killPersonaInstance) answering an ErrInternal rethrows it unchanged, quietly, and begins no episode', async () => {
    const { h, p } = srj105Build()
    const err = errInternal()
    h.script({ killError: err })

    await expect(killPersonaInstance(p)).rejects.toBe(err)

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ kill: 1 }))
    expect(h.errors).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.triggers).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(unclassifiedStartedLines(h, p)).toEqual([])
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
  })

  // The exact count, over recording sinks installed as `main()` installs the
  // real ones (`initOutageState`'s trigger and unclassified sinks): each
  // UNCLASSIFIED outcome in a launch is handed to the unclassified sink once
  // (by the reporting point, which leaves the classification to the sink) and
  // arms the timer once.
  describe('each UNCLASSIFIED outcome in a launch is reported once and arms once (recording sinks)', () => {
    /** Each site, the cause it arms, whether resume is enabled, and the stub answers that make C's launch meet `err` there. */
    const ONCE_SITES: ReadonlyArray<readonly [string, string, boolean, (cfg: PersonaConfig, err: Error) => StubClientOptions]> = [
      ['the first spawn', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true, (_cfg, err) => ({ spawnError: err })],
      ['the resume of an ended row', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true, (cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'ended' }),
        resumeError: err,
      })],
      ['the kill of a replacement (resume_enabled false)', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, false, (cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'ended' }),
        killError: err,
      })],
      ['the delete of a replacement (resume_enabled false)', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, false, (cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'ended' }),
        deleteError: err,
      })],
      ['the reconnect of a waiting row', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true, (cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'waiting' }),
        sendKeysError: err,
      })],
      ['the before-resume sweep of a waiting row\'s dead session', UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true, (cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getResult: personaRow(cfg, 'C', { state: 'waiting' }),
        sendKeysError: errSpawnNotInteractive('send-keys'),
        findMissingError: err,
      })],
      ['the collision get (a read: the read-error cause)', UNAVAILABLE_RETRY_CAUSE_READ_ERROR, true, (_cfg, err) => ({
        spawnQueue: [cannedErr<import('agent-director').SpawnResult>(errInstanceIdCollision())],
        getError: err,
      })],
    ]

    test.each(ONCE_SITES)('b.jg5 SRJ-313: an ErrInternal at %s is handed to the unclassified sink exactly once, as thrown, and arms C once (%s); the launch is refused with no notice', async (_site, kind, resumeEnabled, script) => {
      captureStartupErrors()
      const reports: Array<{ key: string; error: unknown; classification: unknown }> = []
      const armed: Array<{ key: string; kind: string }> = []
      initOutageState({
        getClient,
        notify: (key, text) => { outageEmissions.push({ key, text }) },
        triggerSink: { arm: (key, cause) => { armed.push({ key, kind: cause.kind }); return true } },
        unclassifiedSink: { report: (key, error, classification) => { reports.push({ key, error, classification }) } },
      })
      const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir, { resume_enabled: resumeEnabled })
      const err = errInternal()
      installStub(script(cfg, err))

      let result: Awaited<ReturnType<typeof spawnForPersona>> | undefined
      await withCapturedErr(async () => {
        result = await spawnForPersona(personaOf(cfg, 'C'), cfg)
      })

      expect(result).toStrictEqual({ key: 'C', action: 'failed', refused: true })
      expect(reports).toEqual([{ key: 'C', error: err, classification: undefined }])
      expect(armed).toEqual([{ key: 'C', kind }])
      expect(notices).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-301, SRJ-105: a persona that joins another's in-flight shared
// findMissing sweep gets its own refusal, for every outcome class
//
// A joiner's sweep failure is its own (SRJ-301): P starts the one prompt-row
// sweep, B joins it, and the sweep's answer refuses both under their own keys,
// each armed once with the answer's cause and nothing destructive after it for
// either. The outage each class raises is raised by each persona's own site:
// ENVIRONMENT raises `tmux-unavailable` (the error's form picks the onset,
// SRJ-1021, so B's text is checked as well as P's) and CONFIG raises
// `ad-config-malformed` (one onset and one raise line each, SRJ-316); the
// UNAVAILABLE forms raise nothing. An UNCLASSIFIED answer begins each
// persona's own unclassified-error episode once (SRJ-313); no other class
// begins one.
// ---------------------------------------------------------------------------

/** The outage a joined sweep's answer raises for each persona: its class and the onset text for the thrown value. */
type JoinedSweepOutage = readonly [OutageClass, (err: Error) => string]

/** Each answer of the joined sweep, built for `find-missing` (by name), with the cause it arms and the outage it raises (none for `undefined`). */
const JOINED_SWEEP_ANSWERS: ReadonlyArray<readonly [string, (verb: string) => Error, string, JoinedSweepOutage | undefined]> = [
  ...SRJ105_UNAVAILABLE.map(([what, make, kind]) => [`${what} (UNAVAILABLE)`, make, kind, undefined] as const),
  // The re-bound (different-server) row pins wiring only: today's agent-director never returns this error from `find-missing`; it proves the joiner's site hands its error to `raiseTmuxUnavailable`.
  ...SRJ311_ENVIRONMENT.map(([what, make, text]) => [what, make, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, ['tmux-unavailable', () => text] as const] as const),
  ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG, ['ad-config-malformed', (err) => adConfigMalformedOnset(err)]],
  ...SRJ313_SWEEP_UNCLASSIFIED.map(([what, make]) => [what, make, UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, undefined] as const),
]

describe('b.jg5 SRJ-301, SRJ-105: a persona that joins another\'s in-flight shared sweep gets its own refusal, for every outcome class', () => {
  afterEach(srj105AfterEach)

  test.each(JOINED_SWEEP_ANSWERS)('%s at P\'s prompt-row sweep, which B joined: one findMissing call; each persona is refused under its own key at the prompt-row sweep, armed once with the cause, never counted, raises its own outage only for ENVIRONMENT or CONFIG and begins its own unclassified-error episode only for UNCLASSIFIED; no resume, kill, delete, launch, notice or spawn-failed entry for either', async (_what, make, kind, outage) => {
    const { h, p, b } = srj105Build()
    const err = make('find-missing')
    const [pResult, bResult] = await launchBothThroughOneSweep(h, p, b, err)

    expect(pResult).toStrictEqual({ key: p, action: 'failed', refused: true })
    expect(bResult).toStrictEqual({ key: b, action: 'failed', refused: true })
    // One call: B joined P's sweep (a later start would have made a second).
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    // Nothing destructive after the collisions: no resume, kill, delete or launch.
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 2 }))
    const episode = kind === UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED
    for (const key of [p, b]) {
      expect(refusalLines(h, key)).toHaveLength(1)
      expect(refusalLines(h, key)[0]).toStartWith(`[slack] spawnForPersona: prompt row: findMissing sweep refused for ${renderPersonaRef(key, key)}: `)
      expect(h.triggers.filter((t) => t.key === key)).toEqual([{ key, kind }])
      expect(h.controller.isArmed(key)).toBe(true)
      expect(getFailureCount(key)).toBe(0)
      expect(h.tmuxUnresponsive.holds(key)).toBe(false)
      expect(conditionStartedLines(h, key)).toEqual([])
      expect([...getOutageFlags(key)]).toEqual(outage === undefined ? [] : [outage[0]])
      expect(h.outageNotices.filter((n) => n.key === key).map((n) => n.text)).toEqual(outage === undefined ? [] : [outage[1](err)])
      expect(adConfigMalformedRaiseLines(h, key)).toHaveLength(outage?.[0] === 'ad-config-malformed' ? 1 : 0)
      expect(unclassifiedStartedLines(h, key)).toEqual(episode ? [unclassifiedStartedLine(key, err)] : [])
      expect(h.unclassifiedErrorOpen(key)).toBe(episode)
    }
    expect(h.outageNotices).toHaveLength(outage === undefined ? 0 : 2)
    expect(h.notices).toEqual([])
    expect(h.episodeNotices).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-401 (hatch A2; SRJ-301, SRJ-307, SRJ-311, SRJ-313, SRJ-316): the
// dialog approver's calls are outside P's launch attempt
//
// The approver runs after its launch call returned, on its own, so none of
// its calls is part of P's launch or recovery attempt. E10's SRJ-105
// regression rows for its `read-pane` and `send-keys` ran it inside the
// attempt; they are here, with its `status`. An UNAVAILABLE or UNCLASSIFIED
// answer to any of the three is logged once per lap and the approver polls
// on: the launch result is the launch's own, nothing destructive follows,
// nothing is counted or refused, and no retry timer is armed, no
// `tmux-unresponsive` condition is started and no unclassified-error episode
// is opened (an UNAVAILABLE answer's `tmux-unresponsive` start and arming,
// and an UNCLASSIFIED answer's arming and episode, belong to an attempt). Its
// ENVIRONMENT and CONFIG answers still raise their outages and arm P's retry
// timer with their cause, as from any verb. The approver runs on the
// recovery harness's clock: `settle()` lets its first lap's calls be made,
// and `advance(DIALOG_POLL_INTERVAL_MS)` its second, under a cap above both.
// ---------------------------------------------------------------------------

/** A call of the dialog approver: its verb, the stub answers that make every lap meet `err` there, and the pane reads and Enters one lap makes. */
interface ApproverCallSite {
  readonly name: string
  readonly verb: 'status' | 'read-pane' | 'send-keys'
  script(err: Error): RecoveryStubScript
  readonly paneReadsPerLap: number
  readonly entersPerLap: number
  /** The line the approver logs for `err` there, for persona ref `ref`. */
  line(ref: string, err: Error): string
}

const APPROVER_CALL_SITES: readonly ApproverCallSite[] = [
  {
    name: 'the dialog approver\'s status read',
    verb: 'status',
    script: (err) => ({ statusError: err }),
    paneReadsPerLap: 0,
    entersPerLap: 0,
    line: (ref, err) => approverLogLine(approverStatusRefusedMessage(ref, describeAgentDirectorFailure(err))),
  },
  {
    name: 'the dialog approver\'s pane read',
    verb: 'read-pane',
    script: (err) => ({ statusResult: cannedStatusResult({ state: 'pending' }), readPaneError: err }),
    paneReadsPerLap: 1,
    entersPerLap: 0,
    line: (ref, err) => approverLogLine(approverPaneCallFailedMessage(ref, 'read-pane', describeAgentDirectorFailure(err))),
  },
  {
    name: 'the dialog approver\'s Enter on a dialog',
    verb: 'send-keys',
    script: (err) => ({ statusResult: cannedStatusResult({ state: 'pending' }), readPaneResults: [{ pane: DEV_CHANNELS_DIALOG_PANE }], sendKeysError: err }),
    paneReadsPerLap: 1,
    entersPerLap: 1,
    line: (ref, err) => approverLogLine(approverPaneCallFailedMessage(ref, 'send-keys', describeAgentDirectorFailure(err))),
  },
]

/** The answers that arm nothing outside an attempt: E4's UNAVAILABLE forms (`ErrTmuxUnresponsive` included) and the UNCLASSIFIED ones. */
const APPROVER_UNARMED_ANSWERS: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ...SRJ105_UNAVAILABLE.map(([what, make]) => [`${what} (UNAVAILABLE)`, make] as const),
  ...SRJ313_UNCLASSIFIED.map(([what, make]) => [`${what} (UNCLASSIFIED)`, make] as const),
  ['an UNCLASSIFIED read error (ErrTimeout)', (verb) => errGeneric(verb, 'ErrTimeout')],
]

/** The answers raised and armed from any verb: ENVIRONMENT and CONFIG, with the cause they arm, the outage they raise and its onset. */
const APPROVER_RAISED_ANSWERS: ReadonlyArray<readonly [string, (verb: string) => Error, string, OutageClass, (err: Error) => string]> = [
  ...SRJ311_ENVIRONMENT.map(([what, make, text]) => [what, make, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, 'tmux-unavailable' as OutageClass, () => text] as const),
  ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG, 'ad-config-malformed', (err) => adConfigMalformedOnset(err)],
]

describe('b.jg5 SRJ-401, SRJ-105, SRJ-311, SRJ-313, SRJ-316: the dialog approver\'s calls are outside P\'s launch attempt', () => {
  afterEach(srj105AfterEach)

  const unarmedCross = APPROVER_UNARMED_ANSWERS.flatMap(([what, make]) => APPROVER_CALL_SITES.map((site) => [site.name, what, make, site] as const))
  test.each(unarmedCross)('%s answering %s keeps the launch\'s outcome (spawned), logged once per lap while the approver polls on; no kill, delete, resume, notice or spawn-failed entry, never refused or counted; no trigger or retry timer, no tmux-unresponsive condition, no unclassified-error episode', async (_site, _what, make, site) => {
    const { h, p, b } = srj105Build({ approverCapMs: 4 * DIALOG_POLL_INTERVAL_MS })
    const err = make(site.verb)
    h.script(site.script(err))

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'spawned' })
    // The approver's first lap, then its second on the harness clock.
    await h.settle()
    await h.advance(DIALOG_POLL_INTERVAL_MS)

    expect(h.approverRunning(p)).toBe(true)
    expect(h.stub.calls.statusCalls).toHaveLength(2)
    expect(h.stub.calls.readPaneCalls).toHaveLength(2 * site.paneReadsPerLap)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: 2 * site.entersPerLap }))
    expect(h.errors.filter((line) => line === site.line(renderPersonaRef(p, p), err))).toHaveLength(2)
    expect(h.notices).toEqual([])
    expect(h.outageNotices).toEqual([])
    expect([...getOutageFlags(p)]).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(refusalLines(h, p)).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    // Outside the attempt: nothing armed, started or opened.
    expect(h.triggers).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(unclassifiedStartedLines(h, p)).toEqual([])
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
    expect(h.episodeNotices).toEqual([])
    expect(h.latchEvents).toEqual([])
    expect(h.approverRunning(b)).toBe(false)
  })

  const raisedCross = APPROVER_RAISED_ANSWERS.flatMap(([what, make, kind, outage, onset]) =>
    APPROVER_CALL_SITES.map((site) => [site.name, what, make, kind, outage, onset, site] as const),
  )
  test.each(raisedCross)('%s answering %s raises it as from any verb: P\'s outage raised with one onset and P\'s timer armed once with its cause; the launch keeps its outcome (spawned), never refused or counted; no kill, delete, resume or notice; no tmux-unresponsive condition, no unclassified-error episode', async (_site, _what, make, kind, outage, onset, site) => {
    const { h, p, b } = srj105Build()
    const err = make(site.verb)
    h.script(site.script(err))

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'spawned' })
    // The approver's first lap only.
    await h.settle()

    expect(h.stub.calls.statusCalls).toHaveLength(1)
    expect(h.stub.calls.readPaneCalls).toHaveLength(site.paneReadsPerLap)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: site.entersPerLap }))
    expect(h.errors.filter((line) => line === site.line(renderPersonaRef(p, p), err))).toHaveLength(1)
    expect([...getOutageFlags(p)]).toEqual([outage])
    expect(h.outageNotices).toEqual([{ key: p, text: onset(err) }])
    expect(adConfigMalformedRaiseLines(h, p)).toHaveLength(outage === 'ad-config-malformed' ? 1 : 0)
    expect(h.triggers).toEqual([{ key: p, kind }])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(getFailureCount(p)).toBe(0)
    expect(refusalLines(h, p)).toEqual([])
    expect(h.notices).toEqual([])
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(unclassifiedStartedLines(h, p)).toEqual([])
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
    expect([...getOutageFlags(b)]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105's CONFLICT row, SRJ-501, SRJ-502, SRJ-111, SRJ-113, SRJ-1015:
// a CONFLICT at every spawn and resume of the collision ladder latches the
// persona, and a latched persona is launched by no path (AC 7's unit half,
// AC 46's automated half for the launch paths)
//
// Every case runs on `makeRecoveryHarness`, whose one latch is composed as
// `main()` composes it (installed in the session manager; the holds, then the
// CONFLICT notice over the episodes). The ladder sites are each spawn and
// resume the ladder makes today, each fed every row of the case table
// (`tests/test-helpers/conflict-cases.ts`) for its verb: the errors come from
// the stub's `errTmuxSessionConflict` through the row, so no case word,
// description or notice text is written here.
//
// At each site: the launch answers `latched`; P is latched with the row's case
// and quoted session, the site's refused operation (today every ladder spawn
// is a plain spawn) and the row state the path last read before the refused
// call: the collision `get`'s state, no row after the collision `get`'s
// `ErrSpawnNotFound`, the `ErrJsonlMissing` diagnosis `get`'s state, the
// working-row wait's last `status`, or the prompt row's re-read after its
// sweep. Where the path read nothing (the first spawn and its self-heal
// spawn), exactly one latch-time `status` read gives it: no row when the read
// answers `ErrSpawnNotFound` (after the pre-spawn scan's refusal), `ended`
// after "duplicate session". Where the path already read the row, no `status`
// read is added. The stub's calls are exact and the refused call is the last
// one (the latch-time read alone may follow it): no kill, delete, second
// launch or further read. The set, the three holds and then one CONFLICT
// notice to P; no spawn-failure notice, no `spawn-failed` entry, no counted
// failure, P's timer not armed. Then every launch path of a latched P (the
// start pass's, the bring-up's and the restart path's `spawnForPersona`, and
// `launchSession`) answers `latched` / `'skipped'` with no agent-director
// call, and B launches as before.
//
// The recorded state follows SRJ-501's words ("the state that the path which
// met the condition last read"): a write the path made after its last read (a
// kill, a delete, a findMissing sweep) is not followed by a re-read, so a row
// in another directory read `waiting`, then killed and deleted, records
// `waiting`.
// ---------------------------------------------------------------------------

/** The stub's `status` answer that makes a read give `state`. */
function statusAnswering(state: LatchRowState): RecoveryStubScript {
  if (state.kind === LATCH_ROW_STATE_KIND_NO_ROW) return { statusError: errSpawnNotFound() }
  if (state.kind === LATCH_ROW_STATE_KIND_READ) return { statusResult: cannedStatusResult({ state: state.state as RecoveryRowState }) }
  return { statusError: errTmuxUnresponsive('status') }
}

/** `persona`'s row in its own directory reading `state`, with no `config_dir` label (b.av2 SR-6.2: never resumed). */
function unlabelledRow(h: RecoveryHarness, persona: Persona, state: RecoveryRowState): PersonaGetResultOverrides {
  const labels: Record<string, string> = { ...harnessRow(h, persona, { state }).labels }
  delete labels['config_dir']
  return { state, labels }
}

/** A spawn or resume of the ladder where P's launch meets a CONFLICT. */
interface LatchSite {
  readonly name: string
  /** The verb of the refused call. */
  readonly verb: 'spawn' | 'resume'
  /** Configuration or seams the site needs, set before the launch. */
  setup?(h: RecoveryHarness): void
  /** Stub answers that make P's launch meet `err` here; a site that reads nothing answers the latch-time read with `row`'s state. */
  script(h: RecoveryHarness, persona: Persona, err: Error, row: Pick<ConflictCaseRow, 'rowState'>): RecoveryStubScript
  /** Every launch and destructive call the launch makes, the refused one included. */
  readonly calls: LaunchVerbCalls
  /** The `get` and `status` reads the path makes before the refused call. */
  readonly reads: { readonly get: number; readonly status: number }
  /** The state the path last read before the refused call; `undefined` when it read nothing (one latch-time `status` read). */
  readonly lastRead: LatchRowState | undefined
  /** Notices the path posts before the refused call (the ErrJsonlMissing diagnosis's report); none by default. */
  readonly noticesBefore?: number
}

const ENDED_READ = latchRowStateRead('ended')
const MISSING_READ = latchRowStateRead('missing')
const WAITING_READ = latchRowStateRead('waiting')

/** Each spawn the collision ladder makes today. */
const LATCH_SPAWN_SITES: readonly LatchSite[] = [
  {
    name: 'the first spawn',
    verb: 'spawn',
    script: (_h, _p, err, row) => ({ spawnError: err, ...statusAnswering(row.rowState) }),
    calls: ladderCallsOf({ spawn: 1 }),
    reads: { get: 0, status: 0 },
    lastRead: undefined,
  },
  {
    name: 'the self-heal spawn after the first spawn\'s ErrTmuxSessionCreate',
    verb: 'spawn',
    script: (_h, _p, err, row) => ({ spawnQueue: [cannedErr(errTmuxSessionCreate('spawn')), cannedErr(err)], ...statusAnswering(row.rowState) }),
    calls: ladderCallsOf({ spawn: 2 }),
    reads: { get: 0, status: 0 },
    lastRead: undefined,
  },
  {
    name: 'the retry spawn after the collision get\'s ErrSpawnNotFound',
    verb: 'spawn',
    script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(err)], getError: errSpawnNotFound() }),
    calls: ladderCallsOf({ spawn: 2 }),
    reads: { get: 1, status: 0 },
    lastRead: LATCH_ROW_STATE_NO_ROW,
  },
  {
    name: 'the self-heal spawn after the resume\'s ErrTmuxSessionCreate (an ended row)',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errTmuxSessionCreate('resume') }),
    calls: ladderCallsOf({ spawn: 2, resume: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn after the resume\'s ErrNoSessionId and its delete (an ended row)',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errNoSessionId() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn after the resume\'s ErrJsonlNeverWritten and its delete (a missing row)',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'missing' }, err), resumeError: errJsonlNeverWritten() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: MISSING_READ,
  },
  {
    name: 'the fresh spawn after the resume\'s ErrJsonlMissing, its diagnosis get (reading missing after the collision get read ended) and its delete',
    verb: 'spawn',
    script: (h, p, err) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(err)],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'ended' })), cannedOk(harnessRow(h, p, { state: 'missing' }))],
      resumeError: errJsonlMissing(),
    }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }),
    reads: { get: 2, status: 0 },
    lastRead: MISSING_READ,
    // The inconclusive diagnosis (no message archive) reports before the delete.
    noticesBefore: 1,
  },
  {
    name: 'the fresh spawn after the resume\'s ErrSpawnNotResumable, its kill and its delete (an ended row)',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }, err), resumeError: errSpawnNotResumable() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn after the resume\'s ErrSpawnNotFound (a missing row)',
    verb: 'spawn',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'missing' }, err), resumeError: errSpawnNotFound() }),
    calls: ladderCallsOf({ spawn: 2, resume: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: MISSING_READ,
  },
  {
    name: 'the fresh spawn of a replacement (resume_enabled false, an ended row), after its kill and delete',
    verb: 'spawn',
    setup: noResume,
    script: (h, p, err) => collided(h, p, { state: 'ended' }, err),
    calls: ladderCallsOf({ spawn: 2, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn of a replacement (a row in another directory read waiting), after its kill and delete',
    verb: 'spawn',
    script: (h, p, err) => collided(h, p, elsewhere(h, 'waiting'), err),
    calls: ladderCallsOf({ spawn: 2, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
  {
    name: 'the self-heal spawn of a replacement (a row in another directory read ended) after its fresh spawn\'s ErrTmuxSessionCreate',
    verb: 'spawn',
    script: (h, p, err) => collided(h, p, elsewhere(h, 'ended'), errTmuxSessionCreate('spawn'), err),
    calls: ladderCallsOf({ spawn: 3, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn of a replacement (an ended row with no config_dir label), after its delete',
    verb: 'spawn',
    script: (h, p, err) => collided(h, p, unlabelledRow(h, p, 'ended'), err),
    calls: ladderCallsOf({ spawn: 2, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the fresh spawn after a waiting row\'s dead session, its resume\'s ErrNoSessionId and its delete',
    verb: 'spawn',
    script: (h, p, err) => ({
      ...collided(h, p, { state: 'waiting' }, err),
      sendKeysError: errSpawnNotInteractive('send-keys'),
      resumeError: errNoSessionId(),
    }),
    calls: ladderCallsOf({ spawn: 2, sendKeys: 1, resume: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
]

/** Each resume the collision ladder makes today. */
const LATCH_RESUME_SITES: readonly LatchSite[] = [
  {
    name: 'the resume of an ended row',
    verb: 'resume',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the resume of a missing row',
    verb: 'resume',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'missing' }), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: MISSING_READ,
  },
  {
    name: 'the resume after a waiting row\'s dead session (its reconnect\'s ErrSpawnNotInteractive) and its sweep',
    verb: 'resume',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: errSpawnNotInteractive('send-keys'), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1, resume: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
  {
    name: 'the resume after a working row\'s wait read it missing',
    verb: 'resume',
    setup: fastPolls,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusResult: cannedStatusResult({ state: 'missing' }), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 1, status: 1 },
    lastRead: MISSING_READ,
  },
  {
    name: 'the resume after a working row\'s wait read no row (ErrSpawnNotFound) with its tmux session gone',
    verb: 'resume',
    setup: (h) => {
      fastPolls(h)
      tmuxSessionsGone()
    },
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusError: errSpawnNotFound(), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 1, status: 1 },
    lastRead: LATCH_ROW_STATE_NO_ROW,
  },
  {
    name: 'the resume after a check_permission row whose tmux session is gone was swept and re-read ended',
    verb: 'resume',
    setup: tmuxSessionsGone,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'check_permission' }), statusResult: cannedStatusResult({ state: 'ended' }), resumeError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 1, status: 1 },
    lastRead: ENDED_READ,
  },
]

/** The refused operation a site's verb records today (E22 relabels the sites it turns into reuse spawns). */
function refusedOperationAt(site: LatchSite): RefusedOperation {
  return site.verb === 'resume' ? REFUSED_OPERATION_RESUME : REFUSED_OPERATION_PLAIN_SPAWN
}

/** Every case-table row for `verb`. */
function conflictRowsFor(verb: string): readonly ConflictCaseRow[] {
  return CONFLICT_CASE_ROWS.filter((row) => row.verb === verb)
}

/** Each site crossed with every case-table row for its verb. */
const LATCH_CROSS = [...LATCH_SPAWN_SITES, ...LATCH_RESUME_SITES].flatMap((site) =>
  conflictRowsFor(site.verb).map((row) => [site.name, row.name, site, row] as const),
)

/** The session manager's CONFLICT lines in `text`'s lines for persona `key` (`conflictAt`: one per CONFLICT it met). */
function conflictLinesIn(lines: readonly string[], key: string): string[] {
  return lines.filter(
    (line) => line.includes(` refused for ${renderPersonaRef(key, key)}: `) && line.includes(' — CONFLICT: ') && line.endsWith('nothing more is called (b.jg5 SRJ-105, SRJ-501)'),
  )
}

/** The latch steps P's one latch makes, in order: the set, the three holds, then the CONFLICT notice. */
const ONE_LATCH_STEPS = ['set', 'hold', 'hold', 'hold', 'notice'] as const

/** What P's one latch shows: the record it holds, the notice it posts, and its one session-manager line. */
interface ExpectedLatch {
  /** The whole record the latch holds for P, from the helper's builders (`tests/test-helpers/conflict-cases.ts`). */
  readonly record: ConflictLatchRecord
  /** The one notice body the latch posts to P (the CONFLICT, SRJ-1019 or SRJ-1020 notice). */
  readonly notice: string
  /** The session manager's lines of this latch's kind for persona `key`: one per latch of that kind it logged. */
  readonly lines: (h: RecoveryHarness, key: string) => string[]
  /** What that one line says once the latch is set. */
  readonly says: string
}

/** A CONFLICT latch from `row` at a site refusing `operation`, with the state the path last read. */
function conflictLatch(p: string, row: ConflictCaseRow, operation: RefusedOperation, rowState: LatchRowState): ExpectedLatch {
  return {
    record: expectedLatchRecord(p, {
      latchCase: row.latchCase,
      refusedOperation: operation,
      rowState,
      sessionName: row.sessionName,
      description: row.build().errDescription,
    }),
    notice: row.notice.text,
    lines: (h, key) => conflictLinesIn(h.errors, key),
    says: ' — CONFLICT: the persona latched; ',
  }
}

/** An "unusable recorded name" latch from `row`, with the state the path last read (the row's own by default). */
function unusableNameLatch(p: string, row: UnusableNameCaseRow, rowState: LatchRowState = row.rowState): ExpectedLatch {
  return {
    record: { ...row.record(p), rowState },
    notice: row.notice(p),
    lines: unusableNameLinesOf,
    says: ' — UNUSABLE NAME: the persona latched; ',
  }
}

/** A "launch start not recorded" latch from `row` (the state `pending`). */
function launchStartLatch(p: string, row: LaunchStartCaseRow): ExpectedLatch {
  return {
    record: row.record(p),
    notice: row.notice(p),
    lines: launchStartLinesOf,
    says: ' — the persona latched; ',
  }
}

/**
 * P latched once, as `expected` says: its whole record, the set and the
 * three holds in order before the one notice, one line of the latch's kind
 * saying it latched, and nothing counted, posted as a spawn failure (only the
 * `noticesBefore` the path posted before the latching call: each an
 * inconclusive ErrJsonlMissing diagnosis), recorded `spawn-failed` or as any
 * other diagnosis entry, armed, triggered, refused, started as
 * `tmux-unresponsive` or reported to the unclassified-error episode.
 */
function expectLatchedOnce(h: RecoveryHarness, p: string, expected: ExpectedLatch, noticesBefore = 0): void {
  expect(h.latch.isLatched(p)).toBe(true)
  expect(h.latch.record(p)).toStrictEqual(expected.record)
  expect(h.latchEvents.map((event) => [event.step, event.key])).toEqual(ONE_LATCH_STEPS.map((step) => [step, p]))
  expect(h.latchEvents[0]).toMatchObject({ step: 'set', key: p, outcome: CONFLICT_LATCH_SET_LATCHED })
  expect(h.episodeNotices).toEqual([{ key: p, text: expected.notice }])
  // No spawn-failure notice: only what the path posted before the latching call.
  expect(h.notices.map((n) => n.key)).toEqual(Array.from({ length: noticesBefore }, () => p))
  const log = h.startupErrors().join('\n')
  expect(countStartupEntries(log, 'spawn-failed')).toBe(0)
  expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(noticesBefore)
  expect(countStartupEntries(log, 'jsonl-transcript-lost-on-resume')).toBe(0)
  expect(getFailureCount(p)).toBe(0)
  expect(h.controller.isArmed(p)).toBe(false)
  expect(h.triggers).toEqual([])
  expect(refusalLines(h, p)).toEqual([])
  expect(h.tmuxUnresponsive.holds(p)).toBe(false)
  expect(conditionStartedLines(h, p)).toEqual([])
  expect(unclassifiedStartedLines(h, p)).toEqual([])
  expect(h.unclassifiedErrorOpen(p)).toBe(false)
  // One line of the latch's kind, written once the latch is set.
  const lines = expected.lines(h, p)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(expected.says)
}

/**
 * With P latched, every launch path answers `latched` (`launchSession`
 * `'skipped'`) with no agent-director call and nothing counted, set or
 * posted; then B launches over the stub's defaults and is not latched.
 */
async function expectLaunchedByNoPath(h: RecoveryHarness, p: string, b: string, script: RecoveryStubScript): Promise<void> {
  const persona = harnessPersona(h, p)
  const callsBefore = h.stub.callCount()
  const eventsBefore = h.latchEvents.length
  const noticesBefore = h.notices.length
  const latched: SpawnPersonaResult = { key: p, action: 'latched' }
  // The start pass's launch, the bring-up's and the restart path's (isStartup false), and launchSession.
  expect(await h.launch(p)).toStrictEqual(latched)
  expect(await spawnForPersona(persona, h.config, false)).toStrictEqual(latched)
  expect(await launchSession(p, h.config)).toBe('skipped')
  expect(h.stub.callCount()).toBe(callsBefore)
  expect(h.latchEvents).toHaveLength(eventsBefore)
  expect(h.episodeNotices.filter((n) => n.key === p)).toHaveLength(1)
  expect(h.notices).toHaveLength(noticesBefore)
  expect(getFailureCount(p)).toBe(0)
  expect(h.controller.isArmed(p)).toBe(false)
  expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)

  h.script(clearedScript(script))
  expect(await h.launch(b)).toEqual({ key: b, action: 'spawned' })
  expect(h.latch.isLatched(b)).toBe(false)
  expect(h.latchEvents.filter((event) => event.key === b)).toEqual([])
  expect(h.controller.isArmed(b)).toBe(false)
}

describe('b.jg5 SRJ-105, SRJ-501, SRJ-502: a CONFLICT at any spawn or resume of the collision ladder latches the persona; nothing else is done for it', () => {
  afterEach(srj105AfterEach)

  // Covers SRJ-111 (AC 7's unit half: the first spawn's plain-spawn rows read no
  // row after the scan's refusal, ended after "duplicate session"; latched with
  // plain spawn, never counted, never a kill) and SRJ-113 (a resume latches with
  // "resume" and the collision get's state; never a kill, delete or fresh spawn).
  test.each(LATCH_CROSS)('b.jg5 SRJ-111, SRJ-113: %s answering %s: latched with the row\'s case and session, the site\'s refused operation and the state the path last read; the refused call is the last; one CONFLICT notice after the holds; nothing counted or posted as a spawn failure; then no launch path reaches agent-director; B launches', async (_site, _row, site, row) => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    site.setup?.(h)
    const script = site.script(h, persona, row.build(), row)
    h.script(script)
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    // Exact calls: nothing destructive, launched or read after the refused call
    // but the one latch-time status read where the path had read nothing.
    const latchTimeReads = site.lastRead === undefined ? 1 : 0
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(h.stub.calls.getCalls).toHaveLength(site.reads.get)
    expect(h.stub.calls.statusCalls.map((c) => c.claude_instance_id)).toEqual(
      Array(site.reads.status + latchTimeReads).fill(`${PERSONA_INSTANCE_ID_PREFIX}${p}`),
    )
    expect(order.slice(order.lastIndexOf(site.verb))).toEqual([site.verb, ...(latchTimeReads === 1 ? ['status'] : [])])

    expectLatchedOnce(h, p, conflictLatch(p, row, refusedOperationAt(site), site.lastRead ?? row.rowState), site.noticesBefore)

    await expectLaunchedByNoPath(h, p, b, script)
  })

  // SRJ-1015 (hatch A3): launchSession answers 'skipped' for a launch that
  // latches, as for one already latched; nothing is recorded. The mapping does
  // not depend on the site: one spawn site and one resume site.
  test.each([LATCH_SPAWN_SITES[0]!, LATCH_RESUME_SITES[0]!].map((site) => [site.name, site] as const))('b.jg5 SRJ-1015: launchSession whose launch meets a CONFLICT at %s answers \'skipped\': P latched, nothing counted, no spawn-failure notice', async (_name, site) => {
    const { h, p } = srj105Build()
    const row = conflictRowsFor(site.verb)[0]!
    site.setup?.(h)
    h.script(site.script(h, harnessPersona(h, p), row.build(), row))

    expect(await launchSession(p, h.config)).toBe('skipped')

    expect(h.latch.isLatched(p)).toBe(true)
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(getFailureCount(p)).toBe(0)
    expect(h.notices).toHaveLength(site.noticesBefore ?? 0)
    expect(h.episodeNotices.filter((n) => n.key === p)).toHaveLength(1)
  })

  test('b.jg5 SRJ-501: the ErrJsonlMissing diagnosis get answering ErrSpawnNotFound is the last read: the spawn after its delete latches P with no row, and no status read is added', async () => {
    const { h, p, b } = srj105Build()
    const row = conflictRowsFor('spawn')[0]!
    const script: RecoveryStubScript = {
      spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(row.build())],
      getQueue: [cannedOk(harnessRow(h, harnessPersona(h, p), { state: 'ended' })), cannedErr(errSpawnNotFound())],
      resumeError: errJsonlMissing(),
    }
    h.script(script)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(h.latch.record(p)?.rowState).toEqual(LATCH_ROW_STATE_NO_ROW)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }))
    expect(h.stub.calls.statusCalls).toEqual([])
    // The inconclusive diagnosis keeps its own report; no spawn failure is posted or recorded.
    expect(countStartupEntries(h.startupErrors().join('\n'), 'jsonl-diagnosis-inconclusive')).toBe(1)
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(h.notices.every((n) => n.key === p)).toBe(true)
    const inconclusiveNotices = h.notices.length
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(getFailureCount(p)).toBe(0)

    h.script(clearedScript(script))
    expect(await launchSession(p, h.config)).toBe('skipped')
    expect(h.notices).toHaveLength(inconclusiveNotices)
    expect(await h.launch(b)).toEqual({ key: b, action: 'spawned' })
  })

  test('b.jg5 SRJ-502: a latched persona\'s launch runs no pre-launch step: no trust patch and no agent-director call, while B\'s launch patches and spawns', async () => {
    const { h, p, b } = srj105Build()
    const row = conflictRowsFor('spawn')[0]!
    h.script({ spawnError: row.build(), ...statusAnswering(row.rowState) })
    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })
    h.script({ spawnError: undefined, statusError: undefined })

    const patched: string[] = []
    setPreLaunchTrustPatcher((persona) => {
      patched.push(persona.key)
    })
    const callsBefore = h.stub.callCount()
    expect(await spawnForPersona(harnessPersona(h, p), h.config, false)).toStrictEqual({ key: p, action: 'latched' })
    expect(patched).toEqual([])
    expect(h.stub.callCount()).toBe(callsBefore)

    expect(await h.launch(b)).toEqual({ key: b, action: 'spawned' })
    expect(patched).toEqual([b])
  })

  test('b.jg5 SRJ-502, SRJ-1015: a persona latched during the start pass records no spawn-failed entry and is counted neither failed nor succeeded; B is counted; a second start pass makes no call for P', async () => {
    const { h, p, b } = srj105Build()
    const row = conflictRowsFor('spawn')[0]!
    const pId = `${PERSONA_INSTANCE_ID_PREFIX}${p}`
    h.script({
      spawnQueue: [cannedErr(row.build())],
      statusFn: (params) => (params.claude_instance_id === pId ? errSpawnNotFound() : cannedStatusResult()),
    })

    const first = await startupSessionManager(h.config, { concurrency: 1 })

    expect(first.perPersona).toEqual([
      { key: p, action: 'latched' },
      { key: b, action: 'spawned' },
    ])
    expect(first.failed).toBe(0)
    expect(first.succeeded).toBe(1)
    expect(first.freshSpawned).toBe(1)
    expect(countStartupEntries(h.startupErrors().join('\n'), 'spawn-failed')).toBe(0)
    expect(h.notices).toEqual([])
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(h.latch.record(p)?.rowState).toEqual(LATCH_ROW_STATE_NO_ROW)
    expect(getFailureCount(p)).toBe(0)

    const pSpawns = (): number => h.stub.calls.spawnCalls.filter((c) => c.claude_instance_id === pId).length
    expect(pSpawns()).toBe(1)
    const second = await startupSessionManager(h.config, { concurrency: 1 })
    expect(second.perPersona.find((o) => o.key === p)).toEqual({ key: p, action: 'latched' })
    expect(second.failed).toBe(0)
    expect(pSpawns()).toBe(1)
    expect(h.stub.calls.statusCalls.filter((c) => c.claude_instance_id === pId)).toHaveLength(1)
    expect(h.stub.calls.killCalls.filter((c) => c.claude_instance_id === pId)).toEqual([])
    expect(h.episodeNotices).toHaveLength(1)
  })
})

describe('b.jg5 SRJ-501, SRJ-502: the session manager\'s latch install', () => {
  test('with no latch installed a CONFLICT at the first spawn answers latched with no latch-time read, no notice and no spawn-failed entry, and holds nothing back: the next launch spawns again', async () => {
    const readLog = captureStartupErrors()
    setConflictLatch(undefined)
    const row = conflictRowsFor('spawn')[0]!
    const spawnCalls: import('agent-director').SpawnParams[] = []
    const statusCalls: import('agent-director').StatusParams[] = []
    installStub({ spawnQueue: [cannedErr(row.build())], spawnCalls, statusCalls })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    let result: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg, true)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'latched' })
    const conflictLines = conflictLinesIn(errLog.split('\n'), 'C')
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).toContain(' — CONFLICT: no latch is installed, so nothing is latched; ')
    expect(statusCalls).toEqual([])
    expect(spawnCalls).toHaveLength(1)
    expect(notices).toEqual([])
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
    expect(getFailureCount('C')).toBe(0)
    assertNoLeak({ errLog, notices })

    const secondErrLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg, true)
    })
    expect(result).toStrictEqual({ key: 'C', action: 'spawned' })
    expect(spawnCalls).toHaveLength(2)
    assertNoLeak({ errLog: secondErrLog, notices })
  })

  test('an installed latch whose set throws: the launch still answers latched, its one CONFLICT line naming the failure; no spawn-failure notice, no spawn-failed entry, never counted', async () => {
    const readLog = captureStartupErrors()
    const row = conflictRowsFor('spawn')[0]!
    const sets: string[] = []
    const latch: SessionConflictLatch = {
      isLatched: () => false,
      record: () => undefined,
      set: (key) => {
        sets.push(key)
        throw new Error('latch store broken')
      },
      setFromConflict: (key) => {
        sets.push(key)
        throw new Error('latch store broken')
      },
    }
    setConflictLatch(latch)
    installStub({ spawnError: row.build(), statusError: errSpawnNotFound() })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    let result: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg, true)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'latched' })
    expect(sets).toEqual(['C'])
    // The one CONFLICT line says the latch failed (no separate line).
    const conflictLines = conflictLinesIn(errLog.split('\n'), 'C')
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).toContain(' — CONFLICT: latching the persona failed: ')
    expect(conflictLines[0]).toContain('latch store broken')
    expect(notices).toEqual([])
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
    expect(getFailureCount('C')).toBe(0)
  })

  // b.jg5 SRJ-114: a provenance_conflict note on P's own row (the
  // configured-persona query installed) takes the same fallbacks as the
  // CONFLICT row: with no latch, or a set that throws, the read still answers
  // latched and the launch calls nothing after the collision get.
  test.each<[string, (sets: string[]) => SessionConflictLatch | undefined, string]>([
    ['no latch is installed', () => undefined, ' — no latch is installed, so nothing is latched; nothing more is called for it '],
    [
      'an installed latch whose set throws',
      (sets) => ({
        isLatched: () => false,
        record: () => undefined,
        set: (key) => {
          sets.push(key)
          throw new Error('latch store broken')
        },
        setFromConflict: () => undefined,
      }),
      ' — latching the persona failed: ',
    ],
  ])('a provenance_conflict note on C\'s own row at the collision get when %s: the launch still answers latched, with nothing called after the get, one note line naming the outcome, no notice and no spawn-failed entry, never counted', async (_label, latchOf, outcome) => {
    const readLog = captureStartupErrors()
    const sets: string[] = []
    const latch = latchOf(sets)
    setConflictLatch(latch)
    setConfiguredPersonaQuery((key) => key === 'C')
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)
    const calls = makeStubCallLog()
    installStub({ ...calls, spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: personaRow(cfg, 'C', { state: 'ended', liveness_note: provenanceNote }) })

    let result: SpawnPersonaResult | undefined
    const errLog = await withCapturedErr(async () => {
      result = await spawnForPersona(personaOf(cfg, 'C'), cfg, true)
    })

    expect(result).toStrictEqual({ key: 'C', action: 'latched' })
    expect(calls.spawnCalls).toHaveLength(1)
    expect(calls.getCalls).toHaveLength(1)
    expect(stubCallCount(calls)).toBe(2)
    expect(sets).toEqual(latch === undefined ? [] : ['C'])
    const noteLines = errLog.split('\n').filter((line) => line.includes(': its row carries the liveness note provenance_conflict (state=ended)'))
    expect(noteLines).toHaveLength(1)
    expect(noteLines[0]).toContain(outcome)
    expect(notices).toEqual([])
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
    expect(getFailureCount('C')).toBe(0)
    assertNoLeak({ errLog, notices })
  })

  // Fail safe (b.jg5 SRJ-502): a latch the gate cannot read holds the launch back.
  test.each<[string, SessionConflictLatch, string]>([
    [
      'its latched query throws',
      { isLatched: () => { throw new Error('latch query broken') }, record: () => undefined, set: () => CONFLICT_LATCH_SET_LATCHED, setFromConflict: () => undefined },
      'latch query broken',
    ],
    [
      'it answers latched and its record read throws',
      { isLatched: () => true, record: () => { throw new Error('latch record broken') }, set: () => CONFLICT_LATCH_SET_LATCHED, setFromConflict: () => undefined },
      'latch record broken',
    ],
    [
      'it answers latched and its record read comes back empty',
      { isLatched: () => true, record: () => undefined, set: () => CONFLICT_LATCH_SET_LATCHED, setFromConflict: () => undefined },
      'case=unknown',
    ],
  ])('an installed latch that %s is taken as latched: the launch answers latched with one gate line and no agent-director call, no trust patch, notice or spawn-failed entry; launchSession answers \'skipped\'', async (_what, latch, logged) => {
    const readLog = captureStartupErrors()
    setConflictLatch(latch)
    const calls = makeStubCallLog()
    installStub(calls)
    const patched: string[] = []
    setPreLaunchTrustPatcher((persona) => {
      patched.push(persona.key)
    })
    const cfg = makeStandInPersonaConfig({ C: { working_directory: '/x' } }, fixtureDir)

    let started: SpawnPersonaResult | undefined
    let restarted: SpawnPersonaResult | undefined
    let session: LaunchSessionResult | undefined
    const errLog = await withCapturedErr(async () => {
      started = await spawnForPersona(personaOf(cfg, 'C'), cfg, true)
      restarted = await spawnForPersona(personaOf(cfg, 'C'), cfg, false)
      session = await launchSession('C', cfg)
    })

    expect(started).toStrictEqual({ key: 'C', action: 'latched' })
    expect(restarted).toStrictEqual({ key: 'C', action: 'latched' })
    expect(session).toBe('skipped')
    expect(stubCallCount(calls)).toBe(0)
    expect(patched).toEqual([])
    const gateLines = errLog.split('\n').filter((line) => line.startsWith(`[slack] spawnForPersona: not launching ${renderPersonaRef('C', 'C')} — `))
    expect(gateLines).toHaveLength(3)
    expect(gateLines.every((line) => line.includes(logged) && line.includes('case=unknown'))).toBe(true)
    expect(notices).toEqual([])
    expect(countStartupEntries(readLog(), 'spawn-failed')).toBe(0)
    expect(getFailureCount('C')).toBe(0)
    assertNoLeak({ errLog, notices })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-114 (with SRJ-501, SRJ-502): the note rules at the session
// manager's get sites
//
// At each get site that exists today (the collision `get`, the
// ErrJsonlMissing diagnosis `get`, and `readPersonaTranscript`'s `get`,
// reached through the working-row wait and through the restart path's
// working-row check), a configured persona's own row whose `liveness_note`
// is `provenanceNote` latches P with the case "conflicting labels", the
// refused operation "P's bring-up", the state that `get` read and the session
// `slack_bot_<key>`; its one CONFLICT notice has no "agent-director said"
// line. Nothing more is called for P after that `get` (no `status` read, no
// kill, delete, resume, spawn or keystrokes), the launch answers `latched`,
// nothing is counted, posted as a spawn failure or recorded, and every later
// launch path makes no call for P. Every other note (`nonLatchingNotes`), an
// unknown one (`unknownNote`) and no note leave today's step for the row; so
// does `provenanceNote` on a row that is not a configured persona's own (P
// outside the applied configuration, no configured-persona query installed,
// one that throws, or another caller's row). Every case runs on `makeRecoveryHarness`, which
// installs the latch and the configured-persona query as `main()` does, and
// `srj105AfterEach` runs `assertNoLeak` over what it captured.
// ---------------------------------------------------------------------------

const WORKING_READ = latchRowStateRead('working')

/** A get site of SRJ-114 that P's launch reaches. */
interface NoteSite {
  readonly name: string
  /** Configuration or seams the site needs, set before the launch. */
  setup?(h: RecoveryHarness): void
  /** Stub answers for a launch of `persona` whose site `get` reads its own row with `noted` (the note, or another id) on it. */
  script(h: RecoveryHarness, persona: Persona, noted: PersonaGetResultOverrides): RecoveryStubScript
  /** The launch when the row's note latches no one: today's outcome and calls. */
  readonly plain: { readonly action: SpawnPersonaResult['action']; readonly calls: LaunchVerbCalls }
  /** The launch when the note latches P: its calls, its `get` and `status` reads (the latching `get` is the last call), and the state P's record holds. */
  readonly latched: { readonly calls: LaunchVerbCalls; readonly gets: number; readonly statusReads: number; readonly rowState: LatchRowState }
}

const NOTE_SITES: readonly NoteSite[] = [
  {
    name: 'the collision get (an ended row)',
    script: (h, p, noted) => collided(h, p, { state: 'ended', ...noted }),
    plain: { action: 'resumed', calls: ladderCallsOf({ spawn: 1, resume: 1 }) },
    latched: { calls: ladderCallsOf({ spawn: 1 }), gets: 1, statusReads: 0, rowState: ENDED_READ },
  },
  {
    name: 'the ErrJsonlMissing diagnosis get (an ended row)',
    script: (h, p, noted) => jsonlMissingDiagnosisGets(h, p, cannedOk(harnessRow(h, p, { state: 'ended', ...noted }))),
    plain: { action: 'fresh-after-inconclusive-amnesia', calls: ladderCallsOf({ spawn: 2, resume: 1, delete: 1 }) },
    latched: { calls: ladderCallsOf({ spawn: 1, resume: 1 }), gets: 2, statusReads: 0, rowState: ENDED_READ },
  },
  {
    // The wait's first poll reads working and its pane idle, so it reads the
    // transcript; every later poll reads waiting.
    name: 'the transcript get of the working-row wait (an idle pane; the next status reads waiting)',
    setup: fastPolls,
    script: (h, p, noted) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'working' })), cannedOk(harnessRow(h, p, { state: 'working', ...noted }))],
      statusQueue: [cannedOk(cannedStatusResult({ state: 'working' }))],
      statusResult: cannedStatusResult({ state: 'waiting' }),
      readPaneResults: [{ pane: IDLE_PANE }],
    }),
    plain: { action: 'reconnected', calls: ladderCallsOf({ spawn: 1, sendKeys: 1 }) },
    latched: { calls: ladderCallsOf({ spawn: 1 }), gets: 2, statusReads: 1, rowState: WORKING_READ },
  },
]

/** The CONFLICT notice a note latch posts for persona `key`: "conflicting labels", the session `slack_bot_<key>`, no description line. */
function noteLatchNotice(key: string): string {
  return expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(key) }).text
}

/**
 * P latched once from a note: its record, the set and the three holds before
 * the one CONFLICT notice, and nothing counted, posted as a spawn failure,
 * recorded, armed or refused.
 */
function expectNoteLatchedOnce(h: RecoveryHarness, p: string, rowState: LatchRowState): void {
  expect(h.latch.record(p)).toStrictEqual({
    sessionName: personaTmuxSessionName(p),
    latchCase: LATCH_CASE_CONFLICTING_LABELS,
    refusedOperation: REFUSED_OPERATION_BRING_UP,
    rowState,
  })
  expect(h.latchEvents.map((event) => [event.step, event.key])).toEqual(ONE_LATCH_STEPS.map((step) => [step, p]))
  expect(h.latchEvents[0]).toMatchObject({ step: 'set', outcome: CONFLICT_LATCH_SET_LATCHED })
  expect(h.episodeNotices).toEqual([{ key: p, text: noteLatchNotice(p) }])
  expect(h.notices).toEqual([])
  const log = h.startupErrors().join('\n')
  expect(countStartupEntries(log, 'spawn-failed')).toBe(0)
  expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(0)
  expect(getFailureCount(p)).toBe(0)
  expect(h.controller.isArmed(p)).toBe(false)
  expect(h.triggers).toEqual([])
  expect(refusalLines(h, p)).toEqual([])
}

/** No persona of the harness is latched, and nothing was set or posted for a latch. */
function expectNoNoteLatch(h: RecoveryHarness): void {
  expect(h.keys.filter((key) => h.latch.isLatched(key))).toEqual([])
  expect(h.latchEvents).toEqual([])
  expect(h.episodeNotices).toEqual([])
}

/** No note, every note that never latches, and a note CSCB does not know. */
const PLAIN_NOTES: ReadonlyArray<readonly [string, string | undefined]> = [
  ['no note', undefined],
  ...[...nonLatchingNotes, unknownNote].map((note) => [`the note ${note}`, note] as const),
]

/**
 * `PLAIN_NOTES` sampled: no note, one note that never latches and the unknown
 * one. The full list runs at the collision get and the post-run gets; every
 * other site shares the one note rule, so it takes the sample.
 */
const SAMPLE_PLAIN_NOTES = PLAIN_NOTES.filter(([, note]) => note === undefined || note === nonLatchingNotes[0] || note === unknownNote)

/** A row id that is no persona's: another caller's. */
const ANOTHER_CALLERS_ROW = 'adhoc_caller_1'

/** The reads of `provenanceNote` that are not of a configured persona's own row, each set up on the harness. */
const NOT_A_CONFIGURED_OWN_ROW: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => PersonaGetResultOverrides]> = [
  [
    'P is not in the applied configuration (an absent persona\'s own row)',
    (h, p) => {
      h.remove(p)
      return {}
    },
  ],
  [
    'no configured-persona query is installed',
    () => {
      _resetConfiguredPersonaQuery()
      return {}
    },
  ],
  ['the row is another caller\'s (its id is no persona\'s)', () => ({ claude_instance_id: ANOTHER_CALLERS_ROW })],
  [
    'the configured-persona query throws (taken as not configured)',
    () => {
      setConfiguredPersonaQuery(() => {
        throw new Error('configured-persona query broken')
      })
      return {}
    },
  ],
]

/**
 * The working-row wait's calls, in order, for a row that reads `working`
 * with an idle pane: the up-front findMissing sweep, the status poll, the
 * pane read and the transcript `get`. The launch reaches the wait through
 * the collision ladder (`spawn`, then the collision `get`).
 */
const WAIT_CALLS = ['findMissing', 'status', 'readPane', 'get'] as const
const LADDER_CALLS_BEFORE_WAIT = ['spawn', 'get'] as const

/** Each of the wait's calls by name, with its place in `WAIT_CALLS`. */
const WAIT_CALL_KINDS: ReadonlyArray<readonly [string, number]> = [
  ['the up-front findMissing sweep', 0],
  ['the status poll', 1],
  ['the pane read', 2],
  ['the transcript get', 3],
]

/** How the wait is entered: directly, or through the launch's collision ladder. */
const WAIT_ENTRIES: ReadonlyArray<readonly [string, typeof LADDER_CALLS_BEFORE_WAIT | readonly []]> = [
  ['waitForWaitingAndReconnect', []],
  ['the collision ladder\'s launch', LADDER_CALLS_BEFORE_WAIT],
]

/** The record a latch set elsewhere gives P: a case, P's bring-up and the working row. */
const LATCHED_ELSEWHERE: ConflictLatchSetInput = {
  latchCase: LATCH_CASE_CONFLICTING_LABELS,
  refusedOperation: REFUSED_OPERATION_BRING_UP,
  rowState: WORKING_READ,
}

/** The wait's own lines for a wait that ends because its persona is latched. */
function waitLatchedLines(h: RecoveryHarness): string[] {
  return h.errors.filter((line) => line.startsWith('[slack] waitForWaitingAndReconnect: ') && line.includes(' is latched — the wait ends'))
}

describe('b.jg5 SRJ-114, SRJ-501, SRJ-502: a provenance_conflict note on a configured persona\'s own row latches it at each get site; no other note, and no row that is not a configured persona\'s own, latches anyone', () => {
  afterEach(srj105AfterEach)

  // Demo: a provenance_conflict note on the persona's row latches it once.
  test.each(NOTE_SITES.map((site) => [site.name, site] as const))('a provenance_conflict note on P\'s own row at %s latches P once with the note\'s case, P\'s bring-up and the state read; nothing is called after that get; the launch answers latched; one CONFLICT notice; nothing counted or posted as a failure; then no launch path reaches agent-director; B launches', async (_name, site) => {
    const { h, p, b } = srj105Build()
    site.setup?.(h)
    const script = site.script(h, harnessPersona(h, p), { liveness_note: provenanceNote })
    h.script(script)
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(ladderCallsMade(h)).toEqual(site.latched.calls)
    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toEqual(Array(site.latched.gets).fill(personaInstanceId(p)))
    expect(h.stub.calls.statusCalls).toHaveLength(site.latched.statusReads)
    expect(order.slice(order.lastIndexOf('get'))).toEqual(['get'])
    expectNoteLatchedOnce(h, p, site.latched.rowState)

    await expectLaunchedByNoPath(h, p, b, script)
  })

  // The note decides before the cwd and config_dir guards and the state
  // branches: whatever the row reads, in every row state, the collision get
  // latches P and ends the ladder there (no kill, delete, wait, sweep,
  // reconnect or launch). A prompt row (ask_user, check_permission) never
  // reaches launchOnPromptRow: its tmux session is not probed, no pane is
  // read and nothing is typed.
  test.each<[string, (h: RecoveryHarness, persona: Persona) => PersonaGetResultOverrides, LatchRowState]>([
    ['a pending row', () => ({ state: 'pending' }), latchRowStateRead('pending')],
    ['an ended row', () => ({ state: 'ended' }), ENDED_READ],
    ['a missing row', () => ({ state: 'missing' }), MISSING_READ],
    ['a waiting row (a live state)', () => ({ state: 'waiting' }), WAITING_READ],
    ['a working row', () => ({ state: 'working' }), WORKING_READ],
    ['an ask_user row (a prompt row)', () => ({ state: 'ask_user' }), latchRowStateRead('ask_user')],
    ['a check_permission row (a prompt row)', () => ({ state: 'check_permission' }), latchRowStateRead('check_permission')],
    ['a row in another directory (the cwd guard)', (h) => elsewhere(h, 'ended'), ENDED_READ],
    ['a waiting row with no config_dir label (the config_dir guard)', (h, persona) => unlabelledRow(h, persona, 'waiting'), WAITING_READ],
  ])('the note on P\'s own row at the collision get, %s: P latched with that state, before any guard or state branch: one spawn and one get, no status read, no tmux probe, pane read or keystroke; latched', async (_row, row, rowState) => {
    const { h, p, b } = srj105Build()
    fastPolls(h)
    // Every raw tmux call a prompt row (or anything else) reaches is recorded.
    const tmux = recordTmuxCalls()
    const persona = harnessPersona(h, p)
    const script = collided(h, persona, { ...row(h, persona), liveness_note: provenanceNote })
    h.script(script)
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1 }))
    expect(h.stub.calls.statusCalls).toEqual([])
    expect(h.stub.calls.findMissingCalls).toEqual([])
    expect(h.stub.calls.readPaneCalls).toEqual([])
    expect(order).toEqual(['spawn', 'get'])
    expect(tmux).toEqual([])
    expectNoteLatchedOnce(h, p, rowState)

    await expectLaunchedByNoPath(h, p, b, script)
  })

  // Demo: tmux_server_changed and process_not_seen_session_present (with
  // every other note, an unknown one and none) latch no one. Every note runs
  // at the collision get (NOTE_SITES[0]); the other sites take the sample.
  const plainCross = NOTE_SITES.flatMap((site) =>
    (site === NOTE_SITES[0] ? PLAIN_NOTES : SAMPLE_PLAIN_NOTES).map(([label, note]) => [site.name, label, note, site] as const),
  )
  test.each(plainCross)('at %s, %s on P\'s own row latches no one: the launch takes today\'s step for the row and nothing is posted', async (_site, _label, note, site) => {
    const { h, p } = srj105Build()
    site.setup?.(h)
    h.script(site.script(h, harnessPersona(h, p), { liveness_note: note }))

    expect(await h.launch(p)).toEqual({ key: p, action: site.plain.action })

    expect(ladderCallsMade(h)).toEqual(site.plain.calls)
    expectNoNoteLatch(h)
  })

  // Demo: a provenance_conflict note on another caller's row latches no one.
  const notOwnCross = NOTE_SITES.flatMap((site) => NOT_A_CONFIGURED_OWN_ROW.map(([label, setup]) => [site.name, label, setup, site] as const))
  test.each(notOwnCross)('at %s, a provenance_conflict note on a row that is not a configured persona\'s own (%s) latches no one and changes nothing: today\'s step for the row', async (_site, _label, setup, site) => {
    const { h, p } = srj105Build()
    site.setup?.(h)
    const noted = setup(h, p)
    h.script(site.script(h, harnessPersona(h, p), { ...noted, liveness_note: provenanceNote }))

    expect(await h.launch(p)).toEqual({ key: p, action: site.plain.action })

    expect(ladderCallsMade(h)).toEqual(site.plain.calls)
    expectNoNoteLatch(h)
  })

  test('regression: ErrSpawnNotFound at the collision get still retries the plain spawn once, and latches no one', async () => {
    const { h, p } = srj105Build()
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errSpawnNotFound() })

    expect(await h.launch(p)).toEqual({ key: p, action: 'spawned' })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 2 }))
    expect(h.stub.calls.getCalls).toHaveLength(1)
    expectNoNoteLatch(h)
  })

  test('the start pass: P latched at its ErrJsonlMissing diagnosis get is listed latched and counted in neither amnesia counter, failed nor succeeded; no diagnosis entry or notice; B is counted', async () => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    const pId = personaInstanceId(p)
    let pGets = 0
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getFn: (params) =>
        params.claude_instance_id !== pId
          ? errSpawnNotFound()
          : harnessRow(h, persona, { state: 'ended', ...(++pGets === 2 ? { liveness_note: provenanceNote } : {}) }),
      resumeError: errJsonlMissing(),
    })

    const result = await startupSessionManager(h.config, { concurrency: 1 })

    expect(result.perPersona).toEqual([
      { key: p, action: 'latched' },
      { key: b, action: 'spawned' },
    ])
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.spawnCalls.filter((c) => c.claude_instance_id === pId)).toHaveLength(1)
    expectNoteLatchedOnce(h, p, ENDED_READ)
  })

  test('the restart path\'s working-row check (checkWorkingRowPane) whose transcript get reads the note on P\'s own row answers defer: P latched once with the row read working; nothing typed, pending or posted but the one CONFLICT notice; a second check makes no get and posts nothing', async () => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getResult: harnessRow(h, persona, { state: 'working', liveness_note: provenanceNote }) })

    expect(await checkWorkingRowPane(p, persona)).toBe('defer')

    expect(h.stub.calls.getCalls).toHaveLength(1)
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expectNoteLatchedOnce(h, p, WORKING_READ)

    expect(await checkWorkingRowPane(p, persona)).toBe('defer')
    expect(h.stub.calls.getCalls).toHaveLength(1)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expect(h.latchEvents).toHaveLength(ONE_LATCH_STEPS.length)
    expect(h.episodeNotices).toHaveLength(1)
    expect(h.notices).toEqual([])
  })

  test.each(SAMPLE_PLAIN_NOTES)('the restart path\'s working-row check, %s on P\'s own row: today\'s reading (an idle screen and an ended transcript start the evidence: defer, pending); nothing latched', async (_label, note) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getResult: harnessRow(h, persona, { state: 'working', ...transcriptOf().fields, liveness_note: note }) })

    expect(await checkWorkingRowPane(p, persona)).toBe('defer')

    expect(hasPendingWorkingRowEvidence(p)).toBe(true)
    expectNoNoteLatch(h)
  })

  // b.jg5 SRJ-502: the wait asks after each of its agent-director calls
  // whether P is latched, so a persona latched elsewhere while it waits (no
  // note on any row it reads) ends the wait there. The harness's latch is
  // read-only, so the case installs a latch of its own, as main() installs
  // one, and sets P on it from the stub during one of the wait's calls, as
  // another path would.
  const waitCross = WAIT_ENTRIES.flatMap(([entry, before]) => WAIT_CALL_KINDS.map(([kind, at]) => [entry, kind, before, at] as const))
  test.each(waitCross)('%s: P latched elsewhere during %s of the working-row wait (no note on the row) ends the wait latched: no further call, nothing typed, no not-connected notice; the latch keeps the record set elsewhere', async (_entry, _kind, before, at) => {
    const { h, p } = srj105Build()
    fastPolls(h)
    const persona = harnessPersona(h, p)
    const elsewhere = createConflictLatch({ log: () => {} })
    setConflictLatch(elsewhere)
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: harnessRow(h, persona, { state: 'working' }),
      statusResult: cannedStatusResult({ state: 'working' }),
      readPaneResults: [{ pane: IDLE_PANE }],
    })
    const latchedAt = before.length + at
    const order = recordCallOrder(h, {
      at: latchedAt,
      run: () => {
        elsewhere.set(p, LATCHED_ELSEWHERE)
      },
    })

    if (before.length === 0) {
      expect(await waitForWaitingAndReconnect(p, h.config)).toBe(WAIT_OUTCOME_LATCHED)
    } else {
      expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })
    }

    // The call during which P latched is the last call made.
    expect(order).toEqual([...before, ...WAIT_CALLS.slice(0, at + 1)])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: before.length === 0 ? 0 : 1 }))
    expect(h.notices).toEqual([])
    expect(waitLatchedLines(h)).toHaveLength(1)
    expect(elsewhere.record(p)).toStrictEqual({ ...LATCHED_ELSEWHERE, sessionName: personaTmuxSessionName(p) })
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(getFailureCount(p)).toBe(0)
    expect(h.controller.isArmed(p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-114: the "latches no one" line for a non-latching note on a
// persona's own row is logged once per note for that persona, and again only
// when the note changes. A read with no note, or with the latching note
// (applied or not), forgets the logged note, so its return logs again. The
// memory is per persona, forgotten with its not-connected episode
// (`forgetNotConnectedEpisode`) and by `_resetNotConnectedEpisodes` (the
// file's afterEach), and shared by every get site. Lines are matched by
// their stable fragment, `its row carries the liveness note "<note>", which
// latches no one`, and read back as [head, note].
// ---------------------------------------------------------------------------

const NON_LATCHING_LINE = /^\[slack\] (.+): its row carries the liveness note "(.*)", which latches no one — going on \(b\.jg5 SRJ-114\)$/

/** The "latches no one" lines the harness captured, in order, each as [`<site>: <what> for <ref>`, note]. */
function nonLatchingNoteLines(h: RecoveryHarness): Array<[string, string]> {
  return h.errors.flatMap((line) => {
    const m = NON_LATCHING_LINE.exec(line)
    return m === null ? [] : [[m[1]!, m[2]!] as [string, string]]
  })
}

/** A direct own-row read's site, and the head its lines carry for persona `key` (no ref given: `persona=<key>`). */
const DEDUP_SITE: OwnRowReadSite = { site: 'readPersonaOwnRow', what: 'a test get' }
function dedupHead(key: string, at: OwnRowReadSite = DEDUP_SITE): string {
  return `${at.site}: ${at.what} for persona=${key}`
}

/**
 * Script the harness's `get` to answer, for each persona, the row its entry in
 * `notes` describes (an ended row in its own directory carrying that note, or
 * none). Change an entry between reads to change what the next read sees.
 */
function scriptNotedRows(h: RecoveryHarness, notes: Map<string, PersonaGetResultOverrides>): void {
  h.script({
    getFn: (params) => {
      const key = h.keys.find((candidate) => personaInstanceId(candidate) === params.claude_instance_id)
      if (key === undefined) return errSpawnNotFound()
      return harnessRow(h, harnessPersona(h, key), { state: 'ended', ...(notes.get(key) ?? {}) })
    },
  })
}

/** Read persona `key`'s own row once at `at`; the read must answer a row. */
async function readOwnRowOnce(key: string, at: OwnRowReadSite = DEDUP_SITE): Promise<void> {
  const read = await readPersonaOwnRow(key, at)
  expect(read.kind).toBe(OWN_ROW_READ_ROW)
}

describe('b.jg5 SRJ-114: the "latches no one" line for a non-latching note on a persona\'s own row is logged once per note, again only when the note changes', () => {
  afterEach(srj105AfterEach)

  test.each([nonLatchingNotes[0]!, unknownNote])('the note %s read twice on P\'s own row logs one line; nothing latched', async (note) => {
    const { h, p } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: note }]]))

    await readOwnRowOnce(p)
    await readOwnRowOnce(p)

    expect(h.stub.calls.getCalls).toHaveLength(2)
    expect(nonLatchingNoteLines(h)).toEqual([[dedupHead(p), note]])
    expectNoNoteLatch(h)
  })

  test('a changed note logs again: A, A, B, B, A logs A, B, A', async () => {
    const { h, p } = srj105Build()
    const [a, b] = nonLatchingNotes as [string, string]
    const notes = new Map<string, PersonaGetResultOverrides>()
    scriptNotedRows(h, notes)

    for (const note of [a, a, b, b, a]) {
      notes.set(p, { liveness_note: note })
      await readOwnRowOnce(p)
    }

    expect(nonLatchingNoteLines(h)).toEqual([
      [dedupHead(p), a],
      [dedupHead(p), b],
      [dedupHead(p), a],
    ])
  })

  // A read that carries no note, or the latching note (whether it latches P or
  // is not applied), forgets the logged note: A's return logs again.
  test.each<[string, (h: RecoveryHarness, p: string) => PersonaGetResultOverrides]>([
    ['no note', () => ({})],
    ['an empty note', () => ({ liveness_note: '' })],
    ['provenance_conflict with no configured-persona query installed (not applied)', () => {
      _resetConfiguredPersonaQuery()
      return { liveness_note: provenanceNote }
    }],
    ['provenance_conflict on another caller\'s row (not applied)', () => ({ liveness_note: provenanceNote, claude_instance_id: ANOTHER_CALLERS_ROW })],
    ['provenance_conflict on P\'s own row (P latches)', () => ({ liveness_note: provenanceNote })],
  ])('note A, then a read with %s, then note A again logs A twice', async (_label, between) => {
    const { h, p } = srj105Build()
    const [a] = nonLatchingNotes as [string]
    const notes = new Map<string, PersonaGetResultOverrides>([[p, { liveness_note: a }]])
    scriptNotedRows(h, notes)

    await readOwnRowOnce(p)
    notes.set(p, between(h, p))
    await readOwnRowOnce(p)
    notes.set(p, { liveness_note: a })
    await readOwnRowOnce(p)

    expect(h.stub.calls.getCalls).toHaveLength(3)
    expect(nonLatchingNoteLines(h)).toEqual([
      [dedupHead(p), a],
      [dedupHead(p), a],
    ])
  })

  test('forgetNotConnectedEpisode(P) forgets P\'s logged note, so P\'s next read of it logs again; Q\'s logged note is untouched', async () => {
    const { h, p, b: q } = srj105Build()
    const [a] = nonLatchingNotes as [string]
    scriptNotedRows(h, new Map([[p, { liveness_note: a }], [q, { liveness_note: a }]]))

    await readOwnRowOnce(p)
    await readOwnRowOnce(q)
    forgetNotConnectedEpisode(p)
    await readOwnRowOnce(p)
    await readOwnRowOnce(q)

    expect(nonLatchingNoteLines(h)).toEqual([
      [dedupHead(p), a],
      [dedupHead(q), a],
      [dedupHead(p), a],
    ])
  })

  test('the same note read for P at a second site logs nothing more: the line names the first site only', async () => {
    const { h, p } = srj105Build()
    const [a] = nonLatchingNotes as [string]
    scriptNotedRows(h, new Map([[p, { liveness_note: a }]]))
    const collisionGet: OwnRowReadSite = { site: 'spawnForPersona', what: 'collision get' }
    const transcriptGet: OwnRowReadSite = { site: 'readPersonaTranscript', what: 'transcript get' }

    await readOwnRowOnce(p, collisionGet)
    await readOwnRowOnce(p, transcriptGet)

    expect(nonLatchingNoteLines(h)).toEqual([[dedupHead(p, collisionGet), a]])
  })

  test('a launch whose collision get and ErrJsonlMissing diagnosis get both read the same note on P\'s own row logs one line, at the collision get; the launch goes on as without the note', async () => {
    const { h, p } = srj105Build()
    const [a] = nonLatchingNotes as [string]
    const persona = harnessPersona(h, p)
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: harnessRow(h, persona, { state: 'ended', liveness_note: a }),
      resumeError: errJsonlMissing(),
    })

    expect(await h.launch(p)).toEqual({ key: p, action: 'fresh-after-inconclusive-amnesia' })

    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p), personaInstanceId(p)])
    const lines = nonLatchingNoteLines(h)
    expect(lines).toHaveLength(1)
    expect(lines[0]![0]).toStartWith('spawnForPersona: collision get for ')
    expect(lines[0]![1]).toBe(a)
    expectNoNoteLatch(h)
  })
})

describe('b.jg5 SRJ-114, SRJ-122 (hatch A2): the gets SRJ-114 leaves alone latch no one and keep their behaviour', () => {
  afterEach(() => {
    stopPermissionPoller()
    _resetPollerState()
    srj105AfterEach()
  })

  test('the permission poller\'s get of P\'s own check_permission row carrying the note: its prompt is posted as without the note; nothing latched, no CONFLICT notice', async () => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    const slack = makeStubSlack()
    const trail = makeTrailCapture()
    // The poller reads through the harness's client, the session manager's too.
    h.script({
      listResult: { spawns: [cannedListRow({ state: 'check_permission', liveness_note: provenanceNote }, persona, h.home)] },
      getResult: harnessRow(h, persona, { state: 'check_permission', liveness_note: provenanceNote, permission_requests: [cannedPermissionRequest()] }),
    })
    const ivl = startManualPoller({
      getClient: () => h.stub.client as unknown as ReturnType<PollerDeps['getClient']>,
      clientFor: makePersonaClients((key) => (key === p ? slack : undefined)).clientFor,
      getPersona: (key) => h.config.personas.find((candidate) => candidate.key === key),
      emitTrail: trail.emit,
    })

    await ivl.tick()

    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p)])
    expect(posts(slack)).toHaveLength(1)
    expectNoNoteLatch(h)
    assertNoLeak({ posts: posts(slack), trail: trail.events })
  })

  test('the JSONL persistence safeguard\'s get of P\'s own row carrying the note: its lost-transcript notice is made as without the note; nothing latched, no CONFLICT notice', async () => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    const pId = personaInstanceId(p)
    h.script({
      getFn: (params) =>
        params.claude_instance_id === pId
          ? harnessRow(h, persona, { state: 'ended', liveness_note: provenanceNote, claude_session_id: TRANSCRIPT_SESSION_ID, jsonl_path: join(h.home, 'gone.jsonl') })
          : errSpawnNotFound(),
    })
    const posted: Array<{ key: string; text: string }> = []

    await runJsonlPersistenceSafeguard(h.config, (key, text) => {
      posted.push({ key, text })
    }, {
      readMountinfo: () => '',
      statFn: () => false,
      archiveCountSince: () => 2,
      recordStartupError: () => {},
      home: h.home,
    })

    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toContain(pId)
    expect(posted.map((n) => n.key)).toEqual([p])
    expectNoNoteLatch(h)
    assertNoLeak({ posted })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-120: findMissing run kinds, the memo window, and the not-judged
// reading
//
// Every findMissing caller today is an ordinary run: inside the memo window
// (`FIND_MISSING_MEMO_TTL_MS`, measured on the session manager's clock
// `_now`, a fake clock here) it reuses the memoized result, and while a run is
// in flight it joins that run. A bypassing run (`bypassingFindMissingSweep`,
// the one entry of the later Epics' bypassing callers) always makes a new
// call, becomes the run in flight that ordinary callers join, and is memoized
// for them. The memo keeps the result of the most recently started run that
// succeeded: an older run resolving later never overwrites it nor clears the
// newer run's in-flight slot. A failure is logged, never memoized, and leaves
// the earlier result in place.
//
// Which result an ordinary caller got is read from the start sweep's
// post-kill outcome line (`reconcileOrphans`, an ordinary run that acts for no
// persona): the one live pre-persona row it kills (`SWEPT_OLD_ID`) is in
// `missing` when the result marks it missing, and in `still-live` when the
// result leaves it in `unverified_ids`.
// ---------------------------------------------------------------------------

/** The one live pre-persona row (no `persona` label) the observing start sweep kills. */
const SWEPT_OLD_ID = prePersonaRow('waiting').claude_instance_id

/** A result that marks the swept row missing. */
const OLD_MARKED_MISSING = cannedFindMissing({ rows: { [SWEPT_OLD_ID]: 'ids' } })
/** A result that judges the swept row and leaves it live. */
const OLD_LEFT_LIVE = cannedFindMissing({ rows: { [SWEPT_OLD_ID]: 'unverified_ids' } })

/** The start sweep's post-kill outcome line's buckets. */
const POST_KILL_OUTCOME = /: findMissing after the kills of \d+ live pre-persona row\(s\): missing=\d+ \[([^\]]*)\] still-live=\d+ \[([^\]]*)\] not-judged=\d+ \[([^\]]*)\]/

/** For each post-kill outcome line in `lines`, in order, the bucket holding row `id` (`none` when no bucket does). */
function sweptRowBuckets(lines: readonly string[], id = SWEPT_OLD_ID): string[] {
  return lines.flatMap((line) => {
    const m = POST_KILL_OUTCOME.exec(line)
    if (m === null) return []
    const buckets = (['missing', 'still-live', 'not-judged'] as const).filter((_, i) => m[i + 1]!.split(',').includes(id))
    return [buckets.join('+') || 'none']
  })
}

/** One held findMissing call, settled by the case. */
interface HeldFindMissing {
  resolve(result: import('agent-director').FindMissingResult): void
  reject(err: Error): void
}

/**
 * Replace `client`'s findMissing so its first `count` calls wait until the
 * case settles each (`held[i]`, in call order); every later call answers the
 * empty result at once. `calls()` counts every call.
 */
function holdFindMissing(client: Pick<StubClient, 'findMissing'>, count: number): { held: HeldFindMissing[]; calls: () => number } {
  const held: HeldFindMissing[] = []
  let calls = 0
  client.findMissing = async () => {
    calls++
    if (held.length >= count) return cannedFindMissing()
    return new Promise((resolve, reject) => {
      held.push({ resolve, reject })
    })
  }
  return { held, calls: () => calls }
}

/** Let every caller in progress run on to its next held call (the clock's microtask flushes; time does not move). */
async function settleTurns(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 4; i++) await clock.flush()
}

/** The log site of the bypassing runs these cases make. */
const BYPASS_SITE = 'bypassing test caller'

describe('b.jg5 SRJ-120: bypassing findMissing runs, the memo window on the session manager\'s clock, joiners and the memo winner', () => {
  const C = 'C'
  let clock: FakeClock
  let lines: string[]
  let realError: typeof console.error
  let cfg: PersonaConfig

  beforeEach(() => {
    _resetFindMissingMemo()
    clock = useFakeNow()
    lines = []
    realError = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    cfg = makeStandInPersonaConfig({ [C]: { working_directory: '/x' } }, fixtureDir)
  })

  afterEach(() => {
    console.error = realError
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak({ lines })
  })

  // Demo (E14, AC 85's note half): a bypassing run inside the 10 s window
  // makes a new findMissing call; an ordinary one reuses the memo.
  test('demo: a bypassing run inside the 10 s window makes a new findMissing call, and an ordinary one reuses the memo: an ordinary run primes it; a bypassing run inside FIND_MISSING_MEMO_TTL_MS calls again and is memoized; an ordinary caller after it makes no call and gets its result; at the window\'s end an ordinary caller calls again', async () => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingQueue: [cannedOk(OLD_LEFT_LIVE), cannedOk(OLD_MARKED_MISSING), cannedOk(OLD_LEFT_LIVE)],
      listResult: { spawns: [prePersonaRow('waiting')] },
    })
    expect(FIND_MISSING_MEMO_TTL_MS).toBe(10_000)

    await reconcileOrphans(cfg)
    expect(findMissingCalls).toHaveLength(1)
    await clock.advance(1_000)
    await sweepDeadTmuxChannel(C, 'dead-session')
    expect(findMissingCalls).toHaveLength(1)

    expect(await bypassingFindMissingSweep(C, BYPASS_SITE)).toEqual(OLD_MARKED_MISSING)
    expect(findMissingCalls).toHaveLength(2)

    // The window runs from when the bypassing run's call resolved.
    await clock.advance(FIND_MISSING_MEMO_TTL_MS - 1)
    await reconcileOrphans(cfg)
    expect(findMissingCalls).toHaveLength(2)
    await clock.advance(1)
    await sweepDeadTmuxChannel(C, 'dead-session')
    expect(findMissingCalls).toHaveLength(3)

    expect(sweptRowBuckets(lines)).toEqual(['still-live', 'missing'])
    expect(lines.filter((line) => line.startsWith(`[slack] ${BYPASS_SITE}: bypassing findMissing sweep for persona=${C} — `))).toHaveLength(1)
  })

  test('a bypassing run started while an ordinary run is in flight makes its own call; an ordinary caller arriving during it joins it, and the older run settling first leaves the bypassing run in flight: a caller arriving after that joins the bypassing run, not the older result', async () => {
    const stub = installStub({ listResult: { spawns: [prePersonaRow('waiting')] } })
    const { held, calls } = holdFindMissing(stub, 2)

    const ordinary = sweepDeadTmuxChannel(C, 'dead-session')
    await settleTurns(clock)
    expect(calls()).toBe(1)
    const bypass = bypassingFindMissingSweep(C, BYPASS_SITE)
    await settleTurns(clock)
    expect(calls()).toBe(2)
    const joiner = reconcileOrphans(cfg)
    await settleTurns(clock)
    expect(calls()).toBe(2)

    held[0]!.resolve(OLD_LEFT_LIVE)
    await ordinary
    // The older run has settled; the bypassing run is still in flight.
    const lateJoiner = reconcileOrphans(cfg)
    await settleTurns(clock)
    expect(calls()).toBe(2)
    held[1]!.resolve(OLD_MARKED_MISSING)
    expect(await bypass).toEqual(OLD_MARKED_MISSING)
    await joiner
    await lateJoiner

    expect(calls()).toBe(2)
    // Both ordinary callers got the bypassing run's result, never the older run's still-live.
    expect(sweptRowBuckets(lines)).toEqual(['missing', 'missing'])
  })

  test('an older run resolving after a newer one leaves the newer result: each bypassing caller gets its own run\'s result, and a later ordinary caller reuses the newer one', async () => {
    const stub = installStub({ listResult: { spawns: [prePersonaRow('waiting')] } })
    const { held, calls } = holdFindMissing(stub, 2)

    const older = bypassingFindMissingSweep(C, BYPASS_SITE)
    await settleTurns(clock)
    const newer = bypassingFindMissingSweep(C, BYPASS_SITE)
    await settleTurns(clock)
    expect(calls()).toBe(2)
    held[1]!.resolve(OLD_MARKED_MISSING)
    expect(await newer).toEqual(OLD_MARKED_MISSING)
    held[0]!.resolve(OLD_LEFT_LIVE)
    expect(await older).toEqual(OLD_LEFT_LIVE)

    await reconcileOrphans(cfg)
    expect(calls()).toBe(2)
    expect(sweptRowBuckets(lines)).toEqual(['missing'])
  })

  // b.jg5 SRJ-120 says the caller goes on after a failure; the E12 refusal is
  // kept (b.jg5 SRJ-105): a refused bypassing run stops its caller.
  test.each<[string, () => Error, typeof FIND_MISSING_REFUSED | undefined, string]>([
    ['an UNUSABLE NAME answer: the caller gets undefined and goes on', () => errUnusableName(), undefined, 'bypassing findMissing sweep failed for'],
    [
      'an UNAVAILABLE answer: refused, the caller stops (b.jg5 SRJ-105)',
      () => unavailableForms('ErrCallTimeout')[0]![1]('find-missing'),
      FIND_MISSING_REFUSED,
      'bypassing findMissing sweep refused for',
    ],
  ])('a failed bypassing run (%s) logs one line, is not memoized and leaves the earlier result for later ordinary callers', async (_label, err, answer, words) => {
    const findMissingCalls: import('agent-director').FindMissingParams[] = []
    installStub({
      findMissingCalls,
      findMissingQueue: [cannedOk(OLD_MARKED_MISSING), cannedErr(err())],
      findMissingResult: OLD_LEFT_LIVE,
      listResult: { spawns: [prePersonaRow('waiting')] },
    })

    await reconcileOrphans(cfg)
    expect(await bypassingFindMissingSweep(C, BYPASS_SITE)).toBe(answer)
    expect(findMissingCalls).toHaveLength(2)
    await reconcileOrphans(cfg)

    expect(findMissingCalls).toHaveLength(2)
    expect(sweptRowBuckets(lines)).toEqual(['missing', 'missing'])
    expect(lines.filter((line) => line.startsWith(`[slack] ${BYPASS_SITE}: ${words} persona=${C}: `))).toHaveLength(1)
  })
})

describe('b.jg5 SRJ-120: a pending row a findMissing run put in neither list was not judged (readFindMissingRow)', () => {
  const ROW = personaInstanceId('C')

  test.each<[string, FindMissingRowPlacement, string, FindMissingRowReading]>([
    ['in ids, read pending before the run', 'ids', AGENT_DIRECTOR_PENDING_STATE, FIND_MISSING_ROW_MARKED_MISSING],
    ['in ids, read waiting before the run', 'ids', 'waiting', FIND_MISSING_ROW_MARKED_MISSING],
    ['in unverified_ids, read pending before the run', 'unverified_ids', AGENT_DIRECTOR_PENDING_STATE, FIND_MISSING_ROW_LEFT_LIVE],
    ['in unverified_ids, read working before the run', 'unverified_ids', 'working', FIND_MISSING_ROW_LEFT_LIVE],
    ['in neither list, read pending before the run', 'neither', AGENT_DIRECTOR_PENDING_STATE, FIND_MISSING_ROW_NOT_JUDGED],
    ['in neither list, read waiting before the run', 'neither', 'waiting', FIND_MISSING_ROW_JUDGED_ALIVE],
    ['in neither list, read working before the run', 'neither', 'working', FIND_MISSING_ROW_JUDGED_ALIVE],
  ])('a row %s reads %s', (_label, placement, stateBefore, reading) => {
    const result = cannedFindMissing({ rows: { [ROW]: placement, [personaInstanceId('D')]: 'ids', [personaInstanceId('E')]: 'unverified_ids' } })

    expect(readFindMissingRow(result, ROW, stateBefore)).toBe(reading)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-120 with SRJ-114, SRJ-501 and SRJ-502: the get after
// unverified_ids, and the callers' stop
//
// After a run the server makes (never a memo reuse), each configured
// persona's own row (`cscb_<key>`, the key in the applied set) listed in
// `unverified_ids` is read with one `get` before any caller awaiting the run
// goes on, except the row of the starter's next-step key; a
// `provenance_conflict` note there latches that persona (SRJ-114). Another
// caller's row, the row of a key the applied set does not hold, and a row in
// `ids` or in neither list get no `get`. A persona already latched when the
// run is done (a latched query that throws counts as latched) is skipped: no
// `get`, no relatch and no post, and the run's line lists it as skipped in
// its place; an already-latched caller still gets `FIND_MISSING_LATCHED`.
// The `get`s are made all at once,
// and their line lists the personas in `unverified_ids` order. A failed `get`
// of the caller's own row refuses the caller (the describe after these);
// another persona's failed `get` is only logged. A persona latched by such a
// `get` stops its caller's path: the b.4dk sweep before `resume` answers `latched`,
// `checkPromptRowDeferral` answers `latched` with no `status` read, and the
// working-row wait ends `latched` with nothing typed. Every case runs on
// `makeRecoveryHarness` (the real latch, the configured-persona query over
// the live applied set and the recording notice sinks, installed as `main()`
// installs them), and `srj105AfterEach` runs `assertNoLeak` over what it
// captured.
// ---------------------------------------------------------------------------

/** A findMissing result listing each of `keys`' own rows in `unverified_ids`. */
function unverifiedRowsOf(...keys: string[]): import('agent-director').FindMissingResult {
  return cannedFindMissing({ rows: Object.fromEntries(keys.map((key) => [personaInstanceId(key), 'unverified_ids' as const])) })
}

/** The instance IDs the harness's stub was asked to `get`, in call order. */
function getIds(h: RecoveryHarness): string[] {
  return h.stub.calls.getCalls.map((c) => c.claude_instance_id)
}

/** What the one line of a run's post-run gets lists: `persona=<key> <read|latched|absent|refused (…)|skipped (latched)>, …`. */
function postRunReadsOf(h: RecoveryHarness): string {
  const marker = ' — one get of each configured persona\'s own row in unverified_ids: '
  const lines = h.errors.filter((line) => line.includes(marker) && line.endsWith(' (b.jg5 SRJ-120)'))
  expect(lines).toHaveLength(1)
  return lines[0]!.slice(lines[0]!.indexOf(marker) + marker.length, -' (b.jg5 SRJ-120)'.length)
}

/** The refusal lines of a failed post-run get of the caller's own row, logged at `logPrefix` for `ref`. */
function postRunGetRefusalLines(h: RecoveryHarness, logPrefix: string, ref: string): string[] {
  return h.errors.filter((line) => line.startsWith(`[slack] ${logPrefix}: post-sweep get refused for ${ref}: `) && line.endsWith(' — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)'))
}

/** Every refusal line (b.jg5 SRJ-105) the harness captured, at any site, for any persona. */
function everyRefusalLine(h: RecoveryHarness): string[] {
  return h.errors.filter((line) => line.endsWith(' — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)'))
}

/** The CONFLICT case-table row a launch meets to latch a persona before a run; its case is not the note's. */
const PRE_RUN_LATCH_ROW = conflictRowsFor('spawn')[0]!

/** What the harness's latch and notice sinks hold, and how many `get`s were made, at one point of a case. */
interface LatchSnapshot {
  readonly records: ReadonlyMap<string, ReturnType<RecoveryHarness['latch']['record']>>
  readonly latchEvents: RecoveryHarness['latchEvents']
  readonly episodeNotices: RecoveryHarness['episodeNotices']
  readonly notices: RecoveryHarness['notices']
  readonly gets: number
}

/**
 * Latch each of `keys` before a run, as a CONFLICT at its launch latches it
 * (`PRE_RUN_LATCH_ROW`), and answer what the harness then holds.
 */
async function latchBeforeRun(h: RecoveryHarness, ...keys: string[]): Promise<LatchSnapshot> {
  for (const key of keys) {
    h.script({ spawnQueue: [cannedErr(PRE_RUN_LATCH_ROW.build())] })
    expect(await h.launch(key)).toStrictEqual({ key, action: 'latched' })
    expect(h.latch.record(key)?.latchCase).toBe(PRE_RUN_LATCH_ROW.latchCase)
  }
  return {
    records: new Map(keys.map((key) => [key, h.latch.record(key)])),
    latchEvents: [...h.latchEvents],
    episodeNotices: [...h.episodeNotices],
    notices: [...h.notices],
    gets: getIds(h).length,
  }
}

/** Since `before`, no latched persona was relatched or posted to: each record, the latch events and every notice are as they were. */
function expectNoRelatch(h: RecoveryHarness, before: LatchSnapshot): void {
  for (const [key, record] of before.records) {
    expect(h.latch.isLatched(key)).toBe(true)
    expect(h.latch.record(key)).toStrictEqual(record)
  }
  expect(h.latchEvents).toEqual([...before.latchEvents])
  expect(h.episodeNotices).toEqual([...before.episodeNotices])
  expect(h.notices).toEqual([...before.notices])
}

/** The two callers of the demo: an ordinary run (no answer) and a bypassing run (`FIND_MISSING_LATCHED` once P latched). */
const P_ROW_CALLERS: ReadonlyArray<readonly [string, (p: string) => Promise<unknown>, unknown]> = [
  ['sweepDeadTmuxChannel (an ordinary run)', (p) => sweepDeadTmuxChannel(p, 'dead-session'), undefined],
  ['bypassingFindMissingSweep (a bypassing run), which answers FIND_MISSING_LATCHED', (p) => bypassingFindMissingSweep(p, BYPASS_SITE), FIND_MISSING_LATCHED],
]

describe('b.jg5 SRJ-120, SRJ-114: after a run the server makes, one get of each configured persona\'s own row in unverified_ids; only a provenance_conflict note there latches, and only that persona', () => {
  beforeEach(() => {
    _resetFindMissingMemo()
  })
  afterEach(srj105AfterEach)

  // Demo (E14, AC 85's note half): P's row in unverified_ids leads to one get,
  // and a note there latches P.
  test.each(P_ROW_CALLERS)('demo: P\'s row in unverified_ids leads to one get, and a provenance_conflict note there latches P — through %s: findMissing, then exactly one get of P\'s own row before the caller goes on; P latched once with one CONFLICT notice', async (_caller, call, answer) => {
    const { h, p } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({ findMissingResult: unverifiedRowsOf(p) })
    const order = recordCallOrder(h)

    expect(await call(p)).toBe(answer)

    expect(order).toEqual(['findMissing', 'get'])
    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expectNoteLatchedOnce(h, p, ENDED_READ)
  })

  test.each(PLAIN_NOTES)('%s on P\'s own row in unverified_ids: one get, nothing latched or posted, and the caller gets the run\'s result', async (_label, note) => {
    const { h, p } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: note }]]))
    const result = unverifiedRowsOf(p)
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expectNoNoteLatch(h)
    expect(h.notices).toEqual([])
  })

  test('checkPromptRowDeferral past PROMPT_ROW_SWEEP_AFTER_MS, P\'s own row in unverified_ids with a non-latching note: the calls read findMissing, get, status; nothing latched; the check defers', async () => {
    const { h, p } = srj105Build()
    const clock = useFakeNow()
    scriptNotedRows(h, new Map([[p, { liveness_note: nonLatchingNotes[0] }]]))
    h.script({ findMissingResult: unverifiedRowsOf(p), statusResult: cannedStatusResult({ state: 'check_permission' }) })
    const order = recordCallOrder(h)

    expect(await checkPromptRowDeferral(p, 'check_permission')).toBe('defer')
    await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS)
    expect(await checkPromptRowDeferral(p, 'check_permission')).toBe('defer')

    expect(order).toEqual(['findMissing', 'get', 'status'])
    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expectNoNoteLatch(h)
    expect(clock.pendingCount()).toBe(0)
  })

  test('a run made for P that lists another configured persona\'s own row (B\'s) with the note: one get of B\'s row; B latches once, P does not, and P\'s caller gets the run\'s result', async () => {
    const { h, p, b } = srj105Build()
    scriptNotedRows(h, new Map([[b, { liveness_note: provenanceNote }]]))
    const result = unverifiedRowsOf(b)
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect(getIds(h)).toEqual([personaInstanceId(b)])
    expectNoteLatchedOnce(h, b, ENDED_READ)
    expect(h.latch.isLatched(p)).toBe(false)
  })

  // Demo (E14, AC 85's note half): another caller's row leads to no get and no latch.
  test.each<[string, (h: RecoveryHarness, p: string, b: string) => import('agent-director').FindMissingResult]>([
    ['demo: another caller\'s row in unverified_ids leads to no get and no latch (its id is no persona\'s)', () => cannedFindMissing({ rows: { [ANOTHER_CALLERS_ROW]: 'unverified_ids' } })],
    [
      'the row of a key the applied set does not hold (B removed) in unverified_ids',
      (h, _p, b) => {
        h.remove(b)
        return unverifiedRowsOf(b)
      },
    ],
    ['P\'s own row only in ids', (_h, p) => cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } })],
    ['P\'s own row in neither list', (_h, p) => cannedFindMissing({ rows: { [personaInstanceId(p)]: 'neither', [ANOTHER_CALLERS_ROW]: 'ids' } })],
  ])('%s: no get, no latch and no post, though every persona\'s row carries the note; the caller gets the run\'s result', async (_label, build) => {
    const { h, p, b } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }], [b, { liveness_note: provenanceNote }]]))
    const result = build(h, p, b)
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(getIds(h)).toEqual([])
    expectNoNoteLatch(h)
    expect(h.notices).toEqual([])
  })

  test('a memo reuse makes no get: a second caller inside the window gets the memoized result with no findMissing call and no get, though the listed rows now carry the note', async () => {
    const { h, p, b } = srj105Build()
    const clock = useFakeNow()
    const notes = new Map<string, PersonaGetResultOverrides>()
    scriptNotedRows(h, notes)
    h.script({ findMissingResult: unverifiedRowsOf(p, b) })

    await sweepDeadTmuxChannel(p, 'dead-session')
    expect([...getIds(h)].sort()).toEqual([personaInstanceId(p), personaInstanceId(b)].sort())
    notes.set(p, { liveness_note: provenanceNote })
    notes.set(b, { liveness_note: provenanceNote })
    await clock.advance(FIND_MISSING_MEMO_TTL_MS - 1)
    await sweepDeadTmuxChannel(b, 'dead-session')

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(getIds(h)).toHaveLength(2)
    expectNoNoteLatch(h)
    expect(clock.pendingCount()).toBe(0)
  })

  test('callers sharing one run make one get per listed configured row: B starts the run, B and P\'s prompt-row check join it; P latches once with one post, and P\'s joining check answers latched with no status read', async () => {
    const { h, p, b } = srj105Build()
    const clock = useFakeNow()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({ statusResult: cannedStatusResult({ state: 'check_permission' }) })
    expect(await checkPromptRowDeferral(p, 'check_permission')).toBe('defer')
    await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS)
    const { held, calls } = holdFindMissing(h.stub.client, 1)

    const starter = sweepDeadTmuxChannel(b, 'dead-session')
    await settleTurns(clock)
    const joiners = [sweepDeadTmuxChannel(b, 'dead-session'), checkPromptRowDeferral(p, 'check_permission')]
    await settleTurns(clock)
    expect(calls()).toBe(1)
    held[0]!.resolve(unverifiedRowsOf(p, b))
    await starter
    const [, pCheck] = await Promise.all(joiners)

    expect(pCheck).toBe('latched')
    expect(calls()).toBe(1)
    expect([...getIds(h)].sort()).toEqual([personaInstanceId(p), personaInstanceId(b)].sort())
    expect(h.stub.calls.statusCalls).toEqual([])
    expectNoteLatchedOnce(h, p, ENDED_READ)
    expect(clock.pendingCount()).toBe(0)
  })

  test('the next-step option: a bypassing run whose caller\'s next step is a get of P\'s row makes no get of it, while B\'s listed row gets its own and its note latches B', async () => {
    const { h, p, b } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }], [b, { liveness_note: provenanceNote }]]))
    const result = unverifiedRowsOf(p, b)
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE, p)).toEqual(result)

    expect(getIds(h)).toEqual([personaInstanceId(b)])
    expectNoteLatchedOnce(h, b, ENDED_READ)
    expect(h.latch.isLatched(p)).toBe(false)
  })

  test('an already-latched persona is skipped: B, latched by a CONFLICT at its launch, has its own row with the note listed before P\'s in a run made for P: no get of B\'s row, B\'s latch record and case unchanged and nothing posted; P\'s listed row still gets its get; the run\'s line lists B as skipped in its place', async () => {
    const { h, p, b } = srj105Build()
    const before = await latchBeforeRun(h, b)
    scriptNotedRows(h, new Map([[b, { liveness_note: provenanceNote }]]))
    const result: import('agent-director').FindMissingResult = { count: 0, ids: [], unverified: 2, unverified_ids: [personaInstanceId(b), personaInstanceId(p)] }
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect(getIds(h).slice(before.gets)).toEqual([personaInstanceId(p)])
    expectNoRelatch(h, before)
    expect(h.latch.isLatched(p)).toBe(false)
    expect(postRunReadsOf(h)).toBe(`persona=${b} skipped (latched), persona=${p} read`)
  })

  test('a latched query that throws for B counts as latched: B\'s listed row with the note gets no get and no latch call; P\'s listed row still gets its get, and P\'s caller gets the run\'s result', async () => {
    const { h, p, b } = srj105Build()
    // The harness's latch is read-only, so the case installs one of its own
    // whose latched query throws for B, as main() installs the server's latch.
    const own = createConflictLatch({ log: () => {} })
    const sets: string[] = []
    setConflictLatch({
      isLatched: (key) => {
        if (key === b) throw new Error('latch query broken')
        return own.isLatched(key)
      },
      record: (key) => own.record(key),
      set: (key, input) => {
        sets.push(key)
        return own.set(key, input)
      },
      setFromConflict: (key, value, fields) => {
        sets.push(key)
        return own.setFromConflict(key, value, fields)
      },
    })
    scriptNotedRows(h, new Map([[b, { liveness_note: provenanceNote }]]))
    const result = unverifiedRowsOf(p, b)
    h.script({ findMissingResult: result })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expect(sets).toEqual([])
    expect(own.record(b)).toBeUndefined()
    expect(postRunReadsOf(h)).toBe(`persona=${p} read, persona=${b} skipped (latched)`)
    expect(h.notices).toEqual([])
  })

  test('every listed configured persona already latched (P and B, by CONFLICTs at their launches), each own row with the note: the run makes no get at all, relatches and posts nothing, and its line still lists each as skipped; P\'s caller gets FIND_MISSING_LATCHED', async () => {
    const { h, p, b } = srj105Build()
    const before = await latchBeforeRun(h, p, b)
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }], [b, { liveness_note: provenanceNote }]]))
    h.script({ findMissingResult: unverifiedRowsOf(p, b) })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(FIND_MISSING_LATCHED)

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(getIds(h).slice(before.gets)).toEqual([])
    expectNoRelatch(h, before)
    expect(postRunReadsOf(h)).toBe(`persona=${p} skipped (latched), persona=${b} skipped (latched)`)
  })

  test('an already-latched caller (P, latched by a CONFLICT at its launch) whose own row is listed: no get of P\'s row and the caller gets FIND_MISSING_LATCHED; B\'s listed row still gets its get', async () => {
    const { h, p, b } = srj105Build()
    const before = await latchBeforeRun(h, p)
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({ findMissingResult: unverifiedRowsOf(p, b) })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(FIND_MISSING_LATCHED)

    expect(getIds(h).slice(before.gets)).toEqual([personaInstanceId(b)])
    expectNoRelatch(h, before)
    expect(h.latch.isLatched(b)).toBe(false)
    expect(postRunReadsOf(h)).toBe(`persona=${p} skipped (latched), persona=${b} read`)
  })

  // b.jg5 SRJ-114, SRJ-105: the post-run get of the caller's own row is a get
  // site; any error but ErrSpawnNotFound (and UNUSABLE NAME, below) refuses
  // the caller. The other listed row is read all the same, and the run's
  // result is memoized either way.
  test.each<[string, () => Error, boolean]>([
    ['ErrSpawnNotFound (the row is absent): the caller gets the run\'s result', () => errSpawnNotFound(), false],
    ...SRJ105_UNAVAILABLE.map(([label, build]) => [`${label} (UNAVAILABLE): the caller is refused (FIND_MISSING_REFUSED) with one refusal line`, () => build('get'), true] as [string, () => Error, boolean]),
  ])('the post-run get of the caller\'s (P\'s) own row answering %s; B\'s listed row is still read and its note latches B; P latches nothing and starts no tmux-unresponsive condition; the result is memoized, so an ordinary caller inside the window makes no second findMissing call', async (_label, err, refused) => {
    const { h, p, b } = srj105Build()
    const pId = personaInstanceId(p)
    const result = unverifiedRowsOf(p, b)
    h.script({
      findMissingResult: result,
      getFn: (params) => (params.claude_instance_id === pId ? err() : harnessRow(h, harnessPersona(h, b), { state: 'ended', liveness_note: provenanceNote })),
    })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(refused ? FIND_MISSING_REFUSED : result)

    expect([...getIds(h)].sort()).toEqual([pId, personaInstanceId(b)].sort())
    expectNoteLatchedOnce(h, b, ENDED_READ)
    expect(h.latch.isLatched(p)).toBe(false)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionStartedLines(h, p)).toEqual([])
    expect(postRunGetRefusalLines(h, BYPASS_SITE, `persona=${p}`)).toHaveLength(refused ? 1 : 0)
    expect(everyRefusalLine(h)).toHaveLength(refused ? 1 : 0)

    await sweepDeadTmuxChannel(p, 'dead-session')
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(getIds(h)).toHaveLength(2)
  })

  // b.jg5 SRJ-512 (E14's hatch note): an UNUSABLE NAME answer at the post-run
  // get of the caller's own row is no refusal: it latches P, the run's line
  // lists P latched, and P's caller stops (FIND_MISSING_LATCHED); B's listed
  // row is read all the same and B latches nothing.
  test.each(unusableNameRowsAt('get').map((row) => [row.name, row] as const))('the post-run get of the caller\'s (P\'s) own row answering UNUSABLE NAME (%s): P latched (unreadable) with one post, the caller gets FIND_MISSING_LATCHED, no refusal line; B\'s listed row is still read and B is not latched', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const pId = personaInstanceId(p)
    h.script({
      findMissingResult: unverifiedRowsOf(p, b),
      getFn: (params) => (params.claude_instance_id === pId ? row.build() : harnessRow(h, harnessPersona(h, b), { state: 'ended' })),
    })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(FIND_MISSING_LATCHED)

    expect([...getIds(h)].sort()).toEqual([pId, personaInstanceId(b)].sort())
    expect(postRunReadsOf(h)).toBe(`persona=${p} latched, persona=${b} read`)
    expect(everyRefusalLine(h)).toEqual([])
    expect(unusableNameLinesOf(h, p)).toHaveLength(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))
    expect(h.latch.isLatched(b)).toBe(false)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
  })

  // The read's own answer stops the caller, not only the latch's query: with
  // no latch installed nothing is latched, and the caller still stops.
  test('with no latch installed, the post-run get of the caller\'s (P\'s) own row answering UNUSABLE NAME still stops the caller (FIND_MISSING_LATCHED), latching nothing; its line says no latch is installed', async () => {
    const { h, p } = srj105Build()
    setConflictLatch(undefined)
    const pId = personaInstanceId(p)
    h.script({ findMissingResult: unverifiedRowsOf(p), getFn: (params) => (params.claude_instance_id === pId ? errUnusableName() : errSpawnNotFound()) })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(FIND_MISSING_LATCHED)

    expect(getIds(h)).toEqual([pId])
    expect(postRunReadsOf(h)).toBe(`persona=${p} latched`)
    expect(everyRefusalLine(h)).toEqual([])
    const lines = unusableNameLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(' — UNUSABLE NAME: no latch is installed, so nothing is latched; ')
    expectNoNoteLatch(h)
  })

  test('the post-run get of another persona\'s (B\'s) own row failing (UNAVAILABLE) is only logged: P\'s caller gets the run\'s result; no refusal line for either persona; the run\'s line lists B refused', async () => {
    const { h, p, b } = srj105Build()
    const bId = personaInstanceId(b)
    const [, unavailable] = SRJ105_UNAVAILABLE.find(([label]) => label.includes('ErrCallTimeout'))!
    const result = unverifiedRowsOf(p, b)
    h.script({
      findMissingResult: result,
      getFn: (params) => (params.claude_instance_id === bId ? unavailable('get') : harnessRow(h, harnessPersona(h, p), { state: 'ended' })),
    })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toEqual(result)

    expect([...getIds(h)].sort()).toEqual([personaInstanceId(p), bId].sort())
    expect(everyRefusalLine(h)).toEqual([])
    expect(postRunReadsOf(h)).toContain(`persona=${b} refused (`)
    expectNoNoteLatch(h)
  })

  test('the post-run gets run at once: with two listed rows whose gets are held, both gets are made before either answers, and the run\'s line lists the personas in unverified_ids order, not in the order their gets answered', async () => {
    const { h, p, b } = srj105Build()
    // unverified_ids lists B's row before P's.
    const result: import('agent-director').FindMissingResult = { count: 0, ids: [], unverified: 2, unverified_ids: [personaInstanceId(b), personaInstanceId(p)] }
    h.script({ findMissingResult: result })
    const gets = new Map<string, (row: CannedGetResult) => void>()
    h.stub.client.get = (params) =>
      new Promise((resolve) => {
        gets.set(params.claude_instance_id, (row) => resolve(row as Awaited<ReturnType<typeof h.stub.client.get>>))
      })

    const caller = bypassingFindMissingSweep(p, BYPASS_SITE)
    await settleTurns(h.clock)
    expect([...gets.keys()]).toEqual([personaInstanceId(b), personaInstanceId(p)])
    // P's get answers first.
    gets.get(personaInstanceId(p))!(harnessRow(h, harnessPersona(h, p), { state: 'ended' }))
    await settleTurns(h.clock)
    gets.get(personaInstanceId(b))!(harnessRow(h, harnessPersona(h, b), { state: 'ended' }))

    expect(await caller).toEqual(result)
    expect(postRunReadsOf(h)).toBe(`persona=${b} read, persona=${p} read`)
  })

  test('a failed run makes no get: an UNUSABLE NAME findMissing answer reads no row', async () => {
    const { h, p } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({ findMissingError: errUnusableName() })

    await sweepDeadTmuxChannel(p, 'dead-session')

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(getIds(h)).toEqual([])
    expectNoNoteLatch(h)
  })

  test('the start sweep\'s post-kill run (reconcileOrphans) listing a configured persona\'s own row with the note makes one get of it and latches that persona; its kill decisions are unchanged', async () => {
    const { h, p } = srj105Build()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({
      listResult: { spawns: [prePersonaRow('waiting')] },
      findMissingResult: cannedFindMissing({ rows: { [SWEPT_OLD_ID]: 'ids', [personaInstanceId(p)]: 'unverified_ids' } }),
    })
    const order = recordCallOrder(h)

    await reconcileOrphans(h.config)

    expect(order).toEqual(['list', 'kill', 'findMissing', 'get'])
    expect(h.stub.calls.killCalls.map((k) => k.claude_instance_id)).toEqual([SWEPT_OLD_ID])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expectNoteLatchedOnce(h, p, ENDED_READ)
    expect(sweptRowBuckets(h.errors)).toEqual(['missing'])
  })

  // b.jg5 SRJ-512, SRJ-1002: the start sweep acts for no persona, so an
  // UNUSABLE NAME answer to its post-run get is routed to the server log and
  // latches no one; the row-read rule still latches there (the control).
  test.each(unusableNameRowsAt('get').map((row) => [row.fault, row] as const))('the start sweep\'s post-kill run (reconcileOrphans) whose get of a configured persona\'s own row answers UNUSABLE NAME (%s): one routed line, nothing latched or posted, no refusal; the run\'s line lists that persona refused; its kill decisions are unchanged', async (_fault, row) => {
    const { h, p } = srj105Build()
    const err = row.build()
    h.script({
      listResult: { spawns: [prePersonaRow('waiting')] },
      findMissingResult: cannedFindMissing({ rows: { [SWEPT_OLD_ID]: 'ids', [personaInstanceId(p)]: 'unverified_ids' } }),
      getError: err,
    })
    const order = recordCallOrder(h)

    await reconcileOrphans(h.config)

    expect(order).toEqual(['list', 'kill', 'findMissing', 'get'])
    expect(getIds(h)).toEqual([personaInstanceId(p)])
    const failure = describeAgentDirectorFailure(err)
    expect(h.errors.filter((line) => line.includes(' — UNUSABLE NAME met in '))).toEqual([
      `[slack] reconcileOrphans: post-sweep get for persona=${p}: ${failure} — UNUSABLE NAME met in the start sweep: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)`,
    ])
    expect(postRunReadsOf(h)).toBe(`persona=${p} refused (${failure})`)
    expectNoNoteLatch(h)
    expect(unusableNameLinesOf(h, p)).toEqual([])
    expect(h.notices).toEqual([])
    expect(everyRefusalLine(h)).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(sweptRowBuckets(h.errors)).toEqual(['missing'])
  })

  test('the control: the start sweep\'s post-kill run whose get reads a configured persona\'s own pending row with no launch start still latches that persona with "launch start not recorded" (one post); the run\'s line lists it latched', async () => {
    const { h, p } = srj105Build()
    const row = launchStartCurrentLifeOf('get')[0]!
    h.script({
      listResult: { spawns: [prePersonaRow('waiting')] },
      findMissingResult: cannedFindMissing({ rows: { [SWEPT_OLD_ID]: 'ids', [personaInstanceId(p)]: 'unverified_ids' } }),
      getResult: row.build(harnessPersona(h, p), h.home),
    })

    await reconcileOrphans(h.config)

    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expect(postRunReadsOf(h)).toBe(`persona=${p} latched`)
    expectLatchedOnce(h, p, launchStartLatch(p, row))
    expect(sweptRowBuckets(h.errors)).toEqual(['missing'])
  })
})

describe('b.jg5 SRJ-120, SRJ-502: a persona latched by a run\'s get stops its caller\'s path', () => {
  beforeEach(() => {
    _resetFindMissingMemo()
  })
  afterEach(srj105AfterEach)

  test('the b.4dk path (the sweep before resume of a waiting row whose reconnect found a dead session): the run lists P\'s own row and its get reads the note: P latches, the launch answers latched, and no resume, kill, delete or spawn follows', async () => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [
        cannedOk(harnessRow(h, persona, { state: 'waiting' })),
        cannedOk(harnessRow(h, persona, { state: 'waiting', liveness_note: provenanceNote })),
      ],
      sendKeysError: errTmuxSendKeys(),
      findMissingResult: unverifiedRowsOf(p),
    })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order.slice(order.indexOf('findMissing'))).toEqual(['findMissing', 'get'])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: 2 }))
    expect(getIds(h)).toEqual([personaInstanceId(p), personaInstanceId(p)])
    expectNoteLatchedOnce(h, p, WAITING_READ)
  })

  test('launchOnPromptRow (a check_permission row whose tmux session is gone): the sweep lists P\'s own row and its get reads the note: P latches and the launch answers latched, with no status read, resume, kill, delete or second spawn after the get', async () => {
    const { h, p } = srj105Build()
    tmuxSessionsGone()
    const persona = harnessPersona(h, p)
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [
        cannedOk(harnessRow(h, persona, { state: 'check_permission' })),
        cannedOk(harnessRow(h, persona, { state: 'check_permission', liveness_note: provenanceNote })),
      ],
      findMissingResult: unverifiedRowsOf(p),
    })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order.slice(order.indexOf('findMissing'))).toEqual(['findMissing', 'get'])
    expect(h.stub.calls.statusCalls).toEqual([])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1 }))
    expectNoteLatchedOnce(h, p, latchRowStateRead('check_permission'))
  })

  test('checkPromptRowDeferral past PROMPT_ROW_SWEEP_AFTER_MS: the run lists P\'s own row and its get reads the note: P latches and the check answers latched, with no status read after the get', async () => {
    const { h, p } = srj105Build()
    const clock = useFakeNow()
    scriptNotedRows(h, new Map([[p, { liveness_note: provenanceNote }]]))
    h.script({ findMissingResult: unverifiedRowsOf(p), statusResult: cannedStatusResult({ state: 'check_permission' }) })
    const order = recordCallOrder(h)

    expect(await checkPromptRowDeferral(p, 'check_permission')).toBe('defer')
    await clock.advance(PROMPT_ROW_SWEEP_AFTER_MS)
    expect(await checkPromptRowDeferral(p, 'check_permission')).toBe('latched')

    expect(order).toEqual(['findMissing', 'get'])
    expectNoteLatchedOnce(h, p, ENDED_READ)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each(WAIT_ENTRIES)('the working-row wait entered by %s: its up-front run lists P\'s own row and the get reads the note: the wait ends latched with nothing typed, no status read and no not-connected notice', async (_entry, before) => {
    const { h, p } = srj105Build()
    fastPolls(h)
    const persona = harnessPersona(h, p)
    const noted = cannedOk(harnessRow(h, persona, { state: 'working', liveness_note: provenanceNote }))
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: before.length === 0 ? [noted] : [cannedOk(harnessRow(h, persona, { state: 'working' })), noted],
      statusResult: cannedStatusResult({ state: 'working' }),
      readPaneResults: [{ pane: IDLE_PANE }],
      findMissingResult: unverifiedRowsOf(p),
    })
    const order = recordCallOrder(h)

    if (before.length === 0) {
      expect(await waitForWaitingAndReconnect(p, h.config)).toBe(WAIT_OUTCOME_LATCHED)
    } else {
      expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })
    }

    expect(order).toEqual([...before, 'findMissing', 'get'])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: before.length === 0 ? 0 : 1 }))
    expect(waitLatchedLines(h)).toHaveLength(1)
    expectNoteLatchedOnce(h, p, WORKING_READ)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-114 with SRJ-105: the post-run get of the caller's own row is one
// of SRJ-114's get sites, so its failure follows SRJ-105's get rule. When it
// fails with an error other than ErrSpawnNotFound and UNUSABLE NAME, the
// persona's caller, the run's starter or a joiner, is refused
// (`FIND_MISSING_REFUSED`): one refusal line, its retry timer armed with the
// cause, nothing counted, and no resume, kill, delete or launch. A joiner's
// attempt sees the error under its own key (b.jg5 SRJ-301), since the get
// ran in the starter's. An UNUSABLE NAME answer is no failed read: it latches
// the persona (b.jg5 SRJ-512, unreadable), whose caller then stops
// (`FIND_MISSING_LATCHED`): no refusal line, nothing armed or counted, and
// no resume, kill, delete or launch. Another persona's failed get only shows
// in the run's line (above).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-114, SRJ-105: a failed post-run get of the caller\'s own row stops the caller\'s attempt', () => {
  beforeEach(() => {
    _resetFindMissingMemo()
  })
  afterEach(srj105AfterEach)

  const [callTimeoutLabel, callTimeout, callTimeoutKind] = SRJ105_UNAVAILABLE.find(([label]) => label.includes('ErrCallTimeout'))!

  // The b.4dk path: a waiting row whose reconnect found its session dead runs
  // the sweep before `resume`; its run lists P's own row, and the post-run
  // get of that row fails.
  /** The b.4dk path's stub answers: a waiting row whose reconnect finds its session dead, its run listing P's own row, and P's post-run get answering `err`. */
  function b4dkPostRunGet(h: RecoveryHarness, p: string, err: Error): RecoveryStubScript {
    return {
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, harnessPersona(h, p), { state: 'waiting' })), cannedErr(err)],
      sendKeysError: errTmuxSendKeys(),
      findMissingResult: unverifiedRowsOf(p),
    }
  }

  test(`the b.4dk path (the sweep before resume), P's own post-run get answering ${callTimeoutLabel} (UNAVAILABLE): refused, no resume, kill, delete or spawn`, async () => {
    const { h, p } = srj105Build()
    h.script(b4dkPostRunGet(h, p, callTimeout('get')))
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'failed', refused: true })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: 2 }))
    expect(order.slice(order.indexOf('findMissing'))).toEqual(['findMissing', 'get'])
    expect(postRunGetRefusalLines(h, 'spawnForPersona: before resume', renderPersonaRef(p, p))).toHaveLength(1)
    expect(everyRefusalLine(h)).toHaveLength(1)
    expect(h.triggers).toEqual([{ key: p, kind: callTimeoutKind }])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(getFailureCount(p)).toBe(0)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.notices).toEqual([])
    expectNoNoteLatch(h)
  })

  // b.jg5 SRJ-512 at E14's get after unverified_ids: the UNUSABLE NAME row is
  // a latch, not a refusal, and the resume does not go on.
  test.each(unusableNameRowsAt('get').map((row) => [row.name, row] as const))('the b.4dk path (the sweep before resume), P\'s own post-run get answering UNUSABLE NAME (%s): P latched (unreadable), the launch answers latched with no resume, kill, delete or spawn after the get; no refusal line, nothing armed or counted; one post', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const script = b4dkPostRunGet(h, p, row.build())
    h.script(script)
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, sendKeys: 2 }))
    expect(order.slice(order.indexOf('findMissing'))).toEqual(['findMissing', 'get'])
    expect(postRunGetRefusalLines(h, 'spawnForPersona: before resume', renderPersonaRef(p, p))).toEqual([])
    expect(everyRefusalLine(h)).toEqual([])
    expect(h.triggers).toEqual([])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(unusableNameLinesOf(h, p)).toHaveLength(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test(`a joiner (B) whose own post-run get answers ${callTimeoutLabel} (UNAVAILABLE): P started the prompt-row sweep and B joined it; one findMissing call; B is refused under its own key (its attempt sees the error: armed once with the cause, never counted, no tmux-unresponsive condition) with no resume, kill, delete or launch; P, whose own get read its row, goes on (no-op: its row still reads check_permission)`, async () => {
    const { h, p, b } = srj105Build()
    const err = callTimeout('get')

    const [pResult, bResult] = await launchBothThroughOneSweep(h, p, b, unverifiedRowsOf(p, b), new Map([[b, err]]))

    expect(pResult).toStrictEqual({ key: p, action: 'no-op' })
    expect(bResult).toStrictEqual({ key: b, action: 'failed', refused: true })
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 2 }))
    expect(postRunGetRefusalLines(h, 'spawnForPersona: prompt row', renderPersonaRef(b, b))).toHaveLength(1)
    expect(everyRefusalLine(h)).toHaveLength(1)
    expect(h.triggers).toEqual([{ key: b, kind: callTimeoutKind }])
    expect(h.controller.isArmed(b)).toBe(true)
    expect(h.controller.isArmed(p)).toBe(false)
    expect(getFailureCount(b)).toBe(0)
    expect(h.tmuxUnresponsive.holds(b)).toBe(false)
    expect(conditionStartedLines(h, b)).toEqual([])
    expect(h.notices).toEqual([])
    expectNoNoteLatch(h)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105's UNUSABLE NAME row, SRJ-512, SRJ-501, SRJ-502 (E16): an
// UNUSABLE NAME answer (an `ErrInternal` naming "the recorded tmux session
// name") from a verb on P's own row latches P with "unusable recorded name",
// the refused operation "none" and the row state its path last read (a
// `status` or `get` that itself answered records unreadable; a path that read
// nothing makes the one latch-time `status` read). At every site the session
// manager wires: the collision ladder's spawns and `resume` and its kill and
// delete in a delete-then-spawn chain, the working-pane read (the launch
// wait's evidence read, `checkWorkingRowPane`, `checkWaitingRowPane`), the
// shared own-row `status` read and its sites (the wait's poll and timeout
// reads, `reconcileAndReadRowState`, the retry timer's row read, the
// latch-time read) and E14's shared own-row `get` read at its callers (the
// collision `get`, the ErrJsonlMissing diagnosis `get`, the transcript `get`
// and the post-run `get` after `unverified_ids`, the last in the find-missing
// describes above). Nothing is called after the answer: no delete, kill,
// spawn, `resume`, pane read, keystroke or raw tmux call; no spawn-failure
// notice, `spawn-failed` entry or counted failure; no `tmux-unresponsive`
// onset and no unclassified-error episode; one SRJ-1019 post after the holds.
// Each case takes `UNUSABLE_NAME_CASE_ROWS` for its site kind
// (`tests/test-helpers/conflict-cases.ts`): every fault at each read site,
// and at the ladder's sites one fault per site, in turn, so every fault the
// stub builds is met at some site of each kind (a fault changes only the
// description, checked per fault in `tests/conflict-latch.test.ts`).
// Controls: a phrase-less `ErrInternal` keeps E12's
// UNCLASSIFIED handling, the persona teardown's kill and delete still rethrow
// and latch nothing, and B launches beside a latched P. Every case runs on
// `makeRecoveryHarness` (its latch and configured-persona query installed as
// `main()` installs them); `srj105AfterEach` runs `assertNoLeak` over what it
// captured, and the file's `afterEach` clears the session notifier, the latch
// install and the configured-persona query.
// ---------------------------------------------------------------------------

/** The case-table rows of one site kind: one per fault the stub builds. */
function unusableNameRowsAt(site: UnusableNameSite): readonly UnusableNameCaseRow[] {
  return UNUSABLE_NAME_CASE_ROWS.filter((row) => row.site === site)
}

/** The session manager's UNUSABLE NAME lines for persona `key` (one per answer it met), at a launch (`"P" (key=P)`) or a check (`persona=P`). */
function unusableNameLinesOf(h: RecoveryHarness, key: string): string[] {
  return h.errors.filter(
    (line) =>
      line.includes(' — UNUSABLE NAME: ') &&
      (line.includes(` for ${renderPersonaRef(key, key)}: `) || line.includes(` for persona=${key}: `)) &&
      line.endsWith('(b.jg5 SRJ-105, SRJ-512)'),
  )
}

/**
 * Record every raw tmux call into `order` (the call order `recordCallOrder`
 * keeps), as `tmux <what>`: the b.vub session kill, the server ensurer, the
 * session probe (answering `alive`), and any other command through the
 * runner seam as `tmux <command>` (failing, as the file's stand-in does; the
 * startup-dialog approver makes none). The file's `afterEach` puts every
 * seam back.
 */
function recordRawTmux(order: string[], alive: boolean): void {
  _setTmuxSessionKiller(async () => {
    order.push('tmux kill-session')
  })
  _setTmuxServerEnsurer(async () => {
    order.push('tmux ensure-server')
  })
  _setTmuxSessionProber(async () => {
    order.push('tmux has-session')
    return alive
  })
  _setTmuxCommandRunner(async (args) => {
    order.push(`tmux ${args[0]}`)
    return { code: 1, stdout: '' }
  })
}

/**
 * Every agent-director and raw tmux call from now on, in call order: the
 * stub's verbs (`recordCallOrder`) and the raw tmux seams (`recordRawTmux`),
 * the session probe answering as the one in place does for P now.
 */
async function recordEveryCall(h: RecoveryHarness, p: string): Promise<string[]> {
  const alive = await hasPersonaTmuxSession(p)
  const order = recordCallOrder(h)
  recordRawTmux(order, alive)
  return order
}

/** A spawn, `resume`, kill or delete of the collision ladder where P's launch meets an UNUSABLE NAME answer. */
interface UnusableLadderSite extends Omit<LatchSite, 'verb'> {
  /** The site kind of `UNUSABLE_NAME_CASE_ROWS` whose rows it meets. */
  readonly kind: UnusableNameSite
  /** The stub client's method for the refused call. */
  readonly verb: 'spawn' | 'resume' | 'kill' | 'delete'
}

/** The kill of each delete-then-spawn chain: nothing is deleted or launched after it. */
const UNUSABLE_KILL_SITES: readonly UnusableLadderSite[] = [
  {
    name: 'the kill of a replacement (resume_enabled false, an ended row)',
    kind: 'ladder kill',
    verb: 'kill',
    setup: noResume,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the kill of a replacement (a row in another directory read waiting)',
    kind: 'ladder kill',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'waiting')), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
  {
    name: 'the kill of a replacement (a row in another directory read ended)',
    kind: 'ladder kill',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'ended')), killError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the kill of a replacement (a waiting row with no config_dir label, after its reconnect\'s dead-session verdict)',
    kind: 'ladder kill',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, unlabelledWaitingRow(h, p)), sendKeysError: errSpawnNotInteractive('send-keys'), killError: err }),
    calls: ladderCallsOf({ spawn: 1, sendKeys: 1, kill: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
  {
    name: 'the kill after the resume\'s ErrSpawnNotResumable (an ended row)',
    kind: 'ladder kill',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errSpawnNotResumable(), killError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, kill: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
]

/** The delete of each delete-then-spawn chain: nothing is launched after it. */
const UNUSABLE_DELETE_SITES: readonly UnusableLadderSite[] = [
  {
    name: 'the delete of a replacement (resume_enabled false, an ended row), after its kill',
    kind: 'ladder delete',
    verb: 'delete',
    setup: noResume,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the delete of a replacement (a row in another directory read waiting), after its kill',
    kind: 'ladder delete',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, elsewhere(h, 'waiting')), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: WAITING_READ,
  },
  {
    name: 'the delete of a replacement (an ended row with no config_dir label)',
    kind: 'ladder delete',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, unlabelledRow(h, p, 'ended')), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the delete after the resume\'s ErrSpawnNotResumable and its kill (an ended row)',
    kind: 'ladder delete',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errSpawnNotResumable(), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, kill: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the delete after the resume\'s ErrNoSessionId (an ended row)',
    kind: 'ladder delete',
    verb: 'delete',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errNoSessionId(), deleteError: err }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, delete: 1 }),
    reads: { get: 1, status: 0 },
    lastRead: ENDED_READ,
  },
  {
    name: 'the delete after the resume\'s ErrJsonlMissing and its diagnosis get (reading missing after the collision get read ended)',
    kind: 'ladder delete',
    verb: 'delete',
    script: (h, p, err) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'ended' })), cannedOk(harnessRow(h, p, { state: 'missing' }))],
      resumeError: errJsonlMissing(),
      deleteError: err,
    }),
    calls: ladderCallsOf({ spawn: 1, resume: 1, delete: 1 }),
    reads: { get: 2, status: 0 },
    lastRead: MISSING_READ,
    // The inconclusive diagnosis (no message archive) reports before the delete.
    noticesBefore: 1,
  },
]

/** Every ladder site: each spawn (`plain spawn`) and `resume` of E13's CONFLICT sites, and each kill and delete above. */
const UNUSABLE_LADDER_SITES: readonly UnusableLadderSite[] = [
  ...LATCH_SPAWN_SITES.map((site) => ({ ...site, kind: 'plain spawn' as const })),
  ...LATCH_RESUME_SITES.map((site) => ({ ...site, kind: 'resume' as const })),
  ...UNUSABLE_KILL_SITES,
  ...UNUSABLE_DELETE_SITES,
]

/**
 * Each ladder site with one row of its site kind, the faults taken in turn
 * across the sites, so every fault is met at some site of each kind. A fault
 * changes only the description the record and the notice carry, and each one
 * is checked at every set-input and notice builder in
 * `tests/conflict-latch.test.ts` and at the adapters.
 */
const UNUSABLE_LADDER_CROSS = UNUSABLE_LADDER_SITES.map((site, i) => {
  const rows = unusableNameRowsAt(site.kind)
  const row = rows[i % rows.length]!
  return [site.name, row.fault, site, row] as const
})

describe('b.jg5 SRJ-105, SRJ-512, SRJ-501, SRJ-502: an UNUSABLE NAME answer at a spawn, resume, kill or delete of the collision ladder latches the persona; nothing else is done for it', () => {
  afterEach(srj105AfterEach)

  test.each(UNUSABLE_LADDER_CROSS)('%s answering UNUSABLE NAME (%s): latched with "unusable recorded name", "none" and the state the path last read (one latch-time status read only where it read nothing); the refused call is the last, raw tmux included; one post after the holds; nothing counted, posted as a spawn failure, armed or started; then no launch path reaches agent-director; B launches', async (_site, _fault, site, row) => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    site.setup?.(h)
    const script = site.script(h, persona, row.build(), row)
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    const latchTimeReads = site.lastRead === undefined ? 1 : 0
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(h.stub.calls.getCalls).toHaveLength(site.reads.get)
    expect(h.stub.calls.statusCalls.map((c) => c.claude_instance_id)).toEqual(Array(site.reads.status + latchTimeReads).fill(personaInstanceId(p)))
    expect(order.slice(order.lastIndexOf(site.verb))).toEqual([site.verb, ...(latchTimeReads === 1 ? ['status'] : [])])
    expectLatchedOnce(h, p, unusableNameLatch(p, row, site.lastRead ?? row.rowState), site.noticesBefore)

    await expectLaunchedByNoPath(h, p, b, script)
  })

  // SRJ-1015: launchSession answers 'skipped' for a launch that latches on an
  // UNUSABLE NAME answer, as for a CONFLICT: never counted, no spawn-failure
  // notice. One site of each kind.
  test.each(UNUSABLE_LADDER_SITES.filter((site, i, all) => all.findIndex((s) => s.kind === site.kind) === i).map((site) => [site.kind, site] as const))('b.jg5 SRJ-1015: launchSession whose launch meets UNUSABLE NAME at the first %s site answers \'skipped\': P latched, nothing counted, no spawn-failure notice, one post', async (_kind, site) => {
    const { h, p } = srj105Build()
    const row = unusableNameRowsAt(site.kind)[0]!
    site.setup?.(h)
    h.script(site.script(h, harnessPersona(h, p), row.build(), row))

    expect(await launchSession(p, h.config)).toBe('skipped')

    expect(h.latch.record(p)?.latchCase).toBe(row.latchCase)
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(getFailureCount(p)).toBe(0)
    expect(h.notices).toHaveLength(site.noticesBefore ?? 0)
    expect(h.episodeNotices.filter((n) => n.key === p)).toEqual([{ key: p, text: row.notice(p) }])
  })

  test('b.jg5 SRJ-502, SRJ-1015: a persona latched on an UNUSABLE NAME answer during the start pass is listed latched and counted neither failed nor succeeded, with no spawn-failed entry; B is counted', async () => {
    const { h, p, b } = srj105Build()
    const row = unusableNameRowsAt('plain spawn')[0]!
    const pId = personaInstanceId(p)
    h.script({
      spawnQueue: [cannedErr(row.build())],
      statusFn: (params) => (params.claude_instance_id === pId ? errSpawnNotFound() : cannedStatusResult()),
    })

    const result = await startupSessionManager(h.config, { concurrency: 1 })

    expect(result.perPersona).toEqual([
      { key: p, action: 'latched' },
      { key: b, action: 'spawned' },
    ])
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_NO_ROW))
  })
})

/** How the working-row wait's evidence read is reached: directly, or through the launch's collision ladder. */
const PANE_WAIT_CROSS = WAIT_ENTRIES.flatMap(([entry, before]) => unusableNameRowsAt('read-pane').map((row) => [entry, row.fault, before, row] as const))

describe('b.jg5 SRJ-117, SRJ-512, SRJ-502: an UNUSABLE NAME answer at a working-pane read latches the persona with the state its caller last read; nothing is typed', () => {
  afterEach(srj105AfterEach)

  test.each(PANE_WAIT_CROSS)('the working-row wait entered by %s, its evidence pane read answering UNUSABLE NAME (%s): P latched with the state its poll read (working); the wait ends latched with no further call, though the next poll would read waiting; nothing typed, no not-connected notice', async (_entry, _fault, before, row) => {
    const { h, p, b } = srj105Build()
    fastPolls(h)
    const script: RecoveryStubScript = {
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getResult: harnessRow(h, harnessPersona(h, p), { state: 'working' }),
      statusQueue: [cannedOk(cannedStatusResult({ state: 'working' }))],
      statusResult: cannedStatusResult({ state: 'waiting' }),
      readPaneError: row.build(),
    }
    h.script(script)
    const order = await recordEveryCall(h, p)

    if (before.length === 0) {
      expect(await waitForWaitingAndReconnect(p, h.config)).toBe(WAIT_OUTCOME_LATCHED)
    } else {
      expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })
    }

    expect(order).toEqual([...before, 'findMissing', 'status', 'readPane'])
    expect(h.stub.calls.readPaneCalls).toEqual([{ claude_instance_id: personaInstanceId(p), n_lines: 40 }])
    expect(waitLatchedLines(h)).toHaveLength(1)
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, WORKING_READ))

    if (before.length > 0) await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(unusableNameRowsAt('read-pane').map((row) => [row.fault, row] as const))('the restart path\'s working-row check (checkWorkingRowPane), its pane read answering UNUSABLE NAME (%s): defer, P latched with the row read working; no transcript get, nothing typed, no evidence pending, no notice', async (_fault, row) => {
    const { h, p } = srj105Build()
    h.script({ readPaneError: row.build() })
    const order = await recordEveryCall(h, p)

    expect(await checkWorkingRowPane(p, harnessPersona(h, p))).toBe('defer')

    expect(order).toEqual(['readPane'])
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(h.errors.filter((line) => line.startsWith(`[slack] reconnectSession: persona=${p} is working and is latched — deferring; `))).toHaveLength(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, WORKING_READ))
  })

  test.each(unusableNameRowsAt('get').map((row) => [row.fault, row] as const))('the restart path\'s working-row check (checkWorkingRowPane), its transcript get after an idle pane answering UNUSABLE NAME (%s): defer, P latched with the state unreadable; nothing typed, no evidence pending, no notice', async (_fault, row) => {
    const { h, p } = srj105Build()
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getError: row.build() })
    const order = await recordEveryCall(h, p)

    expect(await checkWorkingRowPane(p, harnessPersona(h, p))).toBe('defer')

    expect(order).toEqual(['readPane', 'get'])
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))
  })

  test.each(unusableNameRowsAt('read-pane').map((row) => [row.fault, row] as const))('the restart path\'s waiting-row check (checkWaitingRowPane), its pane read answering UNUSABLE NAME (%s): defer, never reconnect; P latched with the row read waiting; nothing typed, no notice', async (_fault, row) => {
    const { h, p } = srj105Build()
    h.script({ readPaneError: row.build() })
    const order = await recordEveryCall(h, p)

    expect(await checkWaitingRowPane(p)).toBe('defer')

    expect(order).toEqual(['readPane'])
    expect(h.errors.filter((line) => line.startsWith(`[slack] reconnectSession: persona=${p} is waiting and is latched — deferring; nothing typed`))).toHaveLength(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, WAITING_READ))
  })
})

/** Who reads, for the shared `status` read's direct cases. */
const STATUS_READ_SITE: OwnRowReadSite = { site: 'test', what: 'own-row status read' }

/** A `status` site of the session manager where P's launch meets the answer, its stub answers and the calls it makes. */
interface StatusSite {
  readonly name: string
  setup?(h: RecoveryHarness): void
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
  readonly calls: LaunchVerbCalls
}

const UNUSABLE_STATUS_SITES: readonly StatusSite[] = [
  {
    name: 'the working-row wait\'s poll status',
    setup: fastPolls,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the working-row wait\'s timeout status (every poll read working)',
    setup: shortWait,
    script: (h, p, err) => {
      const sweepsBefore = h.stub.calls.findMissingCalls.length
      return {
        ...collided(h, p, { state: 'working' }),
        readPaneResults: [{ pane: SPINNER_PANE }],
        statusFn: () => (h.stub.calls.findMissingCalls.length >= sweepsBefore + 2 ? err : cannedStatusResult({ state: 'working' })),
      }
    },
    calls: ladderCallsOf({ spawn: 1 }),
  },
  {
    name: 'the re-read after the sweep of a check_permission row whose tmux session is gone (reconcileAndReadRowState)',
    setup: tmuxSessionsGone,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'check_permission' }), statusError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
  },
]

describe('b.jg5 SRJ-115, SRJ-105, SRJ-512: the shared own-row status read, and an UNUSABLE NAME answer at each of its sites', () => {
  afterEach(srj105AfterEach)

  test.each<[string, RecoveryStubScript, Awaited<ReturnType<typeof readPersonaOwnRowStatus>>]>([
    [
      'a pending row showing its launch start: state, with the launch start raw',
      { statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }) },
      { kind: OWN_ROW_STATUS_STATE, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL },
    ],
    ['a waiting row: state, with no launch start key', { statusResult: cannedStatusResult({ state: 'waiting' }) }, { kind: OWN_ROW_STATUS_STATE, state: 'waiting' }],
    ['no row (ErrSpawnNotFound): absent', { statusError: errSpawnNotFound() }, { kind: OWN_ROW_STATUS_ABSENT }],
  ])('%s, from one status call of P\'s own row; nothing latched or posted', async (_label, script, expected) => {
    const { h, p } = srj105Build()
    h.script(script)

    expect(await readPersonaOwnRowStatus(p, STATUS_READ_SITE)).toStrictEqual(expected)

    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.callCount()).toBe(1)
    expectNoNoteLatch(h)
  })

  test('any other error (UNAVAILABLE ErrTmuxUnresponsive): refused, carrying the same value; nothing latched or posted', async () => {
    const { h, p } = srj105Build()
    const err = errTmuxUnresponsive('status')
    h.script({ statusError: err })

    const read = await readPersonaOwnRowStatus(p, STATUS_READ_SITE)

    expect(read.kind).toBe(OWN_ROW_STATUS_REFUSED)
    expect(read.kind === OWN_ROW_STATUS_REFUSED && read.error).toBe(err)
    expect(h.stub.callCount()).toBe(1)
    expectNoNoteLatch(h)
  })

  test.each(unusableNameRowsAt('status').map((row) => [row.fault, row] as const))('an UNUSABLE NAME answer (%s): latched, with the state unreadable; P latched once from that one call, one post', async (_fault, row) => {
    const { h, p } = srj105Build()
    h.script({ statusError: row.build() })

    expect(await readPersonaOwnRowStatus(p, STATUS_READ_SITE)).toStrictEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE })

    expect(h.stub.callCount()).toBe(1)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))
  })

  const statusCross = UNUSABLE_STATUS_SITES.flatMap((site) => unusableNameRowsAt('status').map((row) => [site.name, row.fault, site, row] as const))
  test.each(statusCross)('a launch whose %s answers UNUSABLE NAME (%s): latched, P latched with the state unreadable; that read is the last call, raw tmux included: no tmux fallback, no resume, nothing typed; then no launch path reaches agent-director; B launches', async (_site, _fault, site, row) => {
    const { h, p, b } = srj105Build()
    site.setup?.(h)
    const script = site.script(h, harnessPersona(h, p), row.build())
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order.at(-1)).toBe('status')
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(unusableNameRowsAt('status').map((row) => [row.fault, row] as const))('the retry timer\'s row read (readPersonaRowState) answering UNUSABLE NAME (%s): the state as the latch recorded it (unreadable), P latched; a pending-only retry makes that one call and stops with the latch\'s reason, handing nothing on', async (_fault, row) => {
    const { h, p } = srj105Build()
    h.script({ statusError: row.build() })
    h.controller.armPendingOnly(p)

    await retryNow(h, p)

    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.callCount()).toBe(1)
    expect(h.stops.filter((stop) => stop.key === p).map((stop) => stop.reason)).toEqual([UNAVAILABLE_RETRY_STOP_LATCHED])
    expect(h.restartAsks).toEqual([])
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))

    // The read itself answers the recorded state, with no further call.
    expect(await readPersonaRowState(p)).toStrictEqual({ state: describeLatchRowState(LATCH_ROW_STATE_UNREADABLE) })
    expect(h.stub.callCount()).toBe(2)
    expect(h.latch.record(p)?.rowState).toEqual(LATCH_ROW_STATE_UNREADABLE)
    expect(h.episodeNotices).toHaveLength(1)
  })

  // The latch-time read (b.jg5 SRJ-501) answering UNUSABLE NAME records
  // unreadable and makes no second read: that answer's own latch stands, so a
  // CONFLICT that asked for it posts no CONFLICT notice, and a spawn's
  // UNUSABLE NAME that asked for it sets nothing more.
  test.each(unusableNameRowsAt('status').map((row) => [row.fault, row] as const))('a CONFLICT at the first spawn whose latch-time read answers UNUSABLE NAME (%s): one status read; P latched with "unusable recorded name", unreadable, and only the SRJ-1019 post; the CONFLICT line says the read\'s latch stands', async (_fault, row) => {
    const { h, p, b } = srj105Build()
    const script: RecoveryStubScript = { spawnError: conflictRowsFor('spawn')[0]!.build(), statusError: row.build() }
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'status'])
    const conflictLines = conflictLinesIn(h.errors, p)
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).toContain(' — CONFLICT: the latch-time status read latched the persona, so that latch stands; ')
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(unusableNameRowsAt('status').map((row) => [row.fault, row] as const))('an UNUSABLE NAME at the first spawn whose latch-time read answers UNUSABLE NAME too (%s): one status read; the read\'s latch (unreadable, its own description) stands and nothing more is set; one post', async (_fault, row) => {
    const { h, p, b } = srj105Build()
    const spawnRow = unusableNameRowsAt('plain spawn').find((r) => r.fault !== row.fault)!
    const script: RecoveryStubScript = { spawnError: spawnRow.build(), statusError: row.build() }
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'status'])
    const lines = unusableNameLinesOf(h, p)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(' — UNUSABLE NAME: the latch-time status read latched the persona, so that latch stands; ')
    // The status row's record: the state unreadable, its own description.
    expect(h.latch.record(p)).toStrictEqual(row.record(p))
    expect(h.latchEvents.map((event) => event.step)).toEqual([...ONE_LATCH_STEPS])
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])
    expect(getFailureCount(p)).toBe(0)

    await expectLaunchedByNoPath(h, p, b, script)
  })
})

/** A `get` of P's own row through E14's shared read, where P's launch meets the answer. */
interface GetSite {
  readonly name: string
  setup?(h: RecoveryHarness): void
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
  readonly calls: LaunchVerbCalls
  readonly reads: { readonly get: number; readonly status: number }
}

const UNUSABLE_GET_SITES: readonly GetSite[] = [
  {
    name: 'the collision get',
    script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: err }),
    calls: ladderCallsOf({ spawn: 1 }),
    reads: { get: 1, status: 0 },
  },
  {
    name: 'the ErrJsonlMissing diagnosis get (no diagnosis is reported)',
    script: (h, p, err) => jsonlMissingDiagnosisGets(h, p, cannedErr(err)),
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    reads: { get: 2, status: 0 },
  },
  {
    // The wait's first poll reads working and its pane idle, so it reads the
    // transcript; every later poll would read waiting.
    name: 'the transcript get of the working-row wait (an idle pane)',
    setup: fastPolls,
    script: (h, p, err) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'working' })), cannedErr(err)],
      statusQueue: [cannedOk(cannedStatusResult({ state: 'working' }))],
      statusResult: cannedStatusResult({ state: 'waiting' }),
      readPaneResults: [{ pane: IDLE_PANE }],
    }),
    calls: ladderCallsOf({ spawn: 1 }),
    reads: { get: 2, status: 1 },
  },
]

describe('b.jg5 SRJ-114, SRJ-105, SRJ-512: an UNUSABLE NAME answer at E14\'s shared own-row get read latches the persona and its caller stops', () => {
  afterEach(srj105AfterEach)

  const getCross = UNUSABLE_GET_SITES.flatMap((site) => unusableNameRowsAt('get').map((row) => [site.name, row.fault, site, row] as const))
  test.each(getCross)('%s answering UNUSABLE NAME (%s): latched, P latched with the state unreadable; that get is the last call, raw tmux included; no diagnosis, spawn-failure notice or startup entry; then no launch path reaches agent-director; B launches', async (_site, _fault, site, row) => {
    const { h, p, b } = srj105Build()
    site.setup?.(h)
    const script = site.script(h, harnessPersona(h, p), row.build())
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order.at(-1)).toBe('get')
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(h.stub.calls.getCalls.map((c) => c.claude_instance_id)).toEqual(Array(site.reads.get).fill(personaInstanceId(p)))
    expect(h.stub.calls.statusCalls).toHaveLength(site.reads.status)
    const log = h.startupErrors().join('\n')
    expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(0)
    expect(h.errors.filter((line) => line.includes('ErrJsonlMissing diagnosis get failed for ') || line.includes('collision get failed for '))).toEqual([])
    expectLatchedOnce(h, p, unusableNameLatch(p, row, LATCH_ROW_STATE_UNREADABLE))

    await expectLaunchedByNoPath(h, p, b, script)
  })
})

describe('b.jg5 SRJ-313, SRJ-1002, SRJ-512: the controls — a phrase-less ErrInternal keeps E12\'s UNCLASSIFIED handling, and the persona teardown latches nothing', () => {
  afterEach(srj105AfterEach)

  test('a phrase-less ErrInternal at the resume of an ended row: refused as UNCLASSIFIED (one refusal line, P armed with the UNCLASSIFIED cause, reported to P\'s unclassified-error episode), never latched; B launches', async () => {
    const site = SPAWN_AND_RESUME_SITES.find((s) => s.name === 'the resume of an ended row')!
    const { h, p } = await expectRefusedAt(site, errInternal(), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED)

    expect(h.latch.isLatched(p)).toBe(false)
    expect(h.latchEvents).toEqual([])
    expect(unusableNameLinesOf(h, p)).toEqual([])
    expect(h.unclassifiedErrorOpen(p)).toBe(true)
  })

  test('a phrase-less ErrInternal at the shared own-row status read: refused, carrying the same value; never latched', async () => {
    const { h, p } = srj105Build()
    const err = errInternal()
    h.script({ statusError: err })

    const read = await readPersonaOwnRowStatus(p, STATUS_READ_SITE)

    expect(read.kind === OWN_ROW_STATUS_REFUSED && read.error).toBe(err)
    expectNoNoteLatch(h)
    expect(unusableNameLinesOf(h, p)).toEqual([])
  })

  test('a phrase-less ErrInternal at the waiting-row check\'s pane read: reconnect on the waiting row alone, as for any failed read; never latched', async () => {
    const { h, p } = srj105Build()
    h.script({ readPaneError: errInternal() })

    expect(await checkWaitingRowPane(p)).toBe('reconnect')

    expectNoNoteLatch(h)
    expect(unusableNameLinesOf(h, p)).toEqual([])
  })

  test.each<[string, UnusableNameSite, (key: string) => Promise<boolean>, keyof RecoveryStubScript]>([
    ['killPersonaInstance', 'ladder kill', (key) => killPersonaInstance(key), 'killError'],
    ['deletePersonaInstance', 'ladder delete', (key) => deletePersonaInstance(key), 'deleteError'],
  ])('the persona teardown\'s %s answering UNUSABLE NAME still rethrows the same value and latches nothing: no set, no post, no UNUSABLE NAME line', async (_name, kind, call, knob) => {
    const { h, p } = srj105Build()
    const err = unusableNameRowsAt(kind)[0]!.build()
    h.script({ [knob]: err })

    let thrown: unknown
    try {
      await call(p)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBe(err)
    expectNoNoteLatch(h)
    expect(unusableNameLinesOf(h, p)).toEqual([])
    expect(h.notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-502 (with SRJ-315): a persona latched elsewhere while one of its
// own-row reads is awaited (the health tick reads even while a launch is in
// flight) gets nothing more called for it, whatever the read gave. The
// collision get, the ErrJsonlMissing diagnosis get and the prompt row's
// status read after the findMissing sweep (`reconcileAndReadRowState`) each
// log one line and the launch answers latched: no retry spawn, resume, kill,
// delete, wait, diagnosis or launch follows. At the latch-time status read of
// a CONFLICT or an UNUSABLE NAME refusal the latch set elsewhere stands: no
// second set (so no second post), and the refusal's line says so. The
// harness's latch is read-only, so each case installs a latch of its own, as
// main() installs one, records every set made on it, and sets P on it from
// the stub during the read (`recordCallOrder`), as another path would; the
// file's `afterEach` removes that install.
// ---------------------------------------------------------------------------

/** A latch of the case's own, installed in the session manager as main() installs one, and every set made on it (`<key> <outcome>`), in order. */
function installLatchElsewhere(): { latch: ConflictLatch; sets: string[] } {
  const latch = createConflictLatch({ log: () => {} })
  const sets: string[] = []
  latch.addSetObserver(({ key, outcome }) => {
    sets.push(`${key} ${outcome}`)
  })
  setConflictLatch(latch)
  return { latch, sets }
}

/** Every line of a read after which P was found latched (`latchedAfterOwnRowRead`). */
function latchedAfterReadLines(h: RecoveryHarness): string[] {
  return h.errors.filter((line) => line.includes(' is latched after its '))
}

/**
 * P latched elsewhere once, and nothing else done for it: the one set made
 * elsewhere, with its record; no spawn-failure notice, `spawn-failed` or
 * diagnosis entry, counted failure, refusal or armed timer.
 */
function expectLatchedElsewhereOnly(h: RecoveryHarness, p: string, elsewhere: { latch: ConflictLatch; sets: string[] }): void {
  expect(elsewhere.sets).toEqual([`${p} ${CONFLICT_LATCH_SET_LATCHED}`])
  expect(elsewhere.latch.record(p)).toStrictEqual(expectedLatchRecord(p, LATCHED_ELSEWHERE))
  expect(h.notices).toEqual([])
  const log = h.startupErrors().join('\n')
  expect(countStartupEntries(log, 'spawn-failed')).toBe(0)
  expect(countStartupEntries(log, 'jsonl-diagnosis-inconclusive')).toBe(0)
  expect(countStartupEntries(log, 'jsonl-transcript-lost-on-resume')).toBe(0)
  expect(getFailureCount(p)).toBe(0)
  expect(refusalLines(h, p)).toEqual([])
  expect(h.controller.isArmed(p)).toBe(false)
}

describe('b.jg5 SRJ-502: a persona latched elsewhere while one of its own-row reads is awaited gets nothing more called for it', () => {
  afterEach(srj105AfterEach)

  test.each<[string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript]>([
    ['an ended row (a resume would follow)', (h, persona) => collided(h, persona, { state: 'ended' })],
    ['a waiting row (a reconnect would follow)', (h, persona) => collided(h, persona, { state: 'waiting' })],
    ['no row, ErrSpawnNotFound (a retry spawn would follow)', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errSpawnNotFound() })],
  ])('P latched elsewhere during the collision get, which reads %s: the launch answers latched, that get is the last call; one line; the latch set elsewhere stands alone', async (_label, script) => {
    const { h, p } = srj105Build()
    const elsewhere = installLatchElsewhere()
    h.script(script(h, harnessPersona(h, p)))
    const order = recordCallOrder(h, { at: 1, run: () => elsewhere.latch.set(p, LATCHED_ELSEWHERE) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'get'])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1 }))
    expect(latchedAfterReadLines(h)).toEqual([
      `[slack] spawnForPersona: ${renderPersonaRef(p, p)} is latched after its collision get — nothing more is called for it (b.jg5 SRJ-502)`,
    ])
    expectLatchedElsewhereOnly(h, p, elsewhere)
  })

  test.each<[string, (h: RecoveryHarness, persona: Persona) => CannedResponse<CannedGetResult>]>([
    ['a missing row', (h, persona) => cannedOk(harnessRow(h, persona, { state: 'missing' }))],
    ['no row, ErrSpawnNotFound (an inconclusive diagnosis would follow)', () => cannedErr(errSpawnNotFound())],
  ])('P latched elsewhere during the ErrJsonlMissing diagnosis get, which reads %s: the launch answers latched, that get is the last call; no diagnosis, delete or spawn; one line; the latch set elsewhere stands alone', async (_label, diagnosis) => {
    const { h, p } = srj105Build()
    const elsewhere = installLatchElsewhere()
    const persona = harnessPersona(h, p)
    h.script(jsonlMissingDiagnosisGets(h, persona, diagnosis(h, persona)))
    const order = recordCallOrder(h, { at: 3, run: () => elsewhere.latch.set(p, LATCHED_ELSEWHERE) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'get', 'resume', 'get'])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1, resume: 1 }))
    expect(latchedAfterReadLines(h)).toEqual([
      `[slack] spawnForPersona: ${renderPersonaRef(p, p)} is latched after its ErrJsonlMissing diagnosis get — nothing more is called for it (b.jg5 SRJ-502)`,
    ])
    expectLatchedElsewhereOnly(h, p, elsewhere)
  })

  test.each<[string, Partial<RecoveryStubScript>]>([
    ['an ended row (a resume would follow)', { statusResult: cannedStatusResult({ state: 'ended' }) }],
    ['no row, ErrSpawnNotFound', { statusError: errSpawnNotFound() }],
  ])('a check_permission row whose tmux session is gone, P latched elsewhere during its status read after the findMissing sweep, which reads %s: FIND_MISSING_LATCHED, so the launch answers latched with no resume or fresh spawn; that read is the last call; one line; the latch set elsewhere stands alone', async (_label, read) => {
    const { h, p } = srj105Build()
    tmuxSessionsGone()
    const elsewhere = installLatchElsewhere()
    h.script({ ...collided(h, harnessPersona(h, p), { state: 'check_permission' }), ...read })
    const order = recordCallOrder(h, { at: 3, run: () => elsewhere.latch.set(p, LATCHED_ELSEWHERE) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'get', 'findMissing', 'status'])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1 }))
    expect(latchedAfterReadLines(h)).toEqual([
      `[slack] spawnForPersona: prompt row: ${renderPersonaRef(p, p)} is latched after its status read after the findMissing sweep — nothing more is called for it (b.jg5 SRJ-502)`,
    ])
    expectLatchedElsewhereOnly(h, p, elsewhere)
  })

  const refusals: ReadonlyArray<readonly [string, () => Error, (h: RecoveryHarness, key: string) => string[], string]> = [
    ['a CONFLICT', () => conflictRowsFor('spawn')[0]!.build(), (h, key) => conflictLinesIn(h.errors, key), ' — CONFLICT: '],
    ['an UNUSABLE NAME', () => unusableNameRowsAt('plain spawn')[0]!.build(), unusableNameLinesOf, ' — UNUSABLE NAME: '],
  ]
  const reads: ReadonlyArray<readonly [string, Partial<RecoveryStubScript>]> = [
    ['a waiting row', { statusResult: cannedStatusResult({ state: 'waiting' }) }],
    ['no row (ErrSpawnNotFound)', { statusError: errSpawnNotFound() }],
  ]
  const latchTimeCross = refusals.flatMap(([refusal, build, lines, kind]) => reads.map(([read, answer]) => [refusal, read, build, lines, kind, answer] as const))
  test.each(latchTimeCross)('%s at the first spawn whose latch-time status read reads %s while P is latched elsewhere: the launch answers latched after that one read; the latch set elsewhere stands, with no second set and so no second post; the refusal\'s one line says so', async (_refusal, _read, build, lines, kind, answer) => {
    const { h, p } = srj105Build()
    const elsewhere = installLatchElsewhere()
    h.script({ spawnError: build(), ...answer })
    const order = recordCallOrder(h, { at: 1, run: () => elsewhere.latch.set(p, LATCHED_ELSEWHERE) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'status'])
    const refusalLine = lines(h, p)
    expect(refusalLine).toHaveLength(1)
    expect(refusalLine[0]).toContain(`${kind}the persona was latched elsewhere during the latch-time status read, so that latch stands; `)
    expect(latchedAfterReadLines(h)).toEqual([])
    expectLatchedElsewhereOnly(h, p, elsewhere)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-513, SRJ-1020 (E16 T2), with SRJ-114's Test clause "a pending row
// with no launch start latches P" (AC 86) at E14's four `get` sites and
// SRJ-115's `status` sites: a configured persona's own row that reads
// `pending` with no launch start (absent, `null` or unparseable; P's current
// life, another `cwd` or another `config_dir` label: the helper's
// `LAUNCH_START_CASE_ROWS`) latches P with "launch start not recorded", the
// refused operation "none" and the state `pending`, the session
// `slack_bot_<key>` and no description, with one SRJ-1020 post after the
// holds. At the collision `get` it decides before the `cwd` and `config_dir`
// guards and the state branches, with no extra `status` read. Nothing is
// called for P after the latching read, raw tmux included (no reconnect,
// wait, `find-missing`, `resume`, kill, delete, spawn or `send-keys`), no
// diagnosis is reported, nothing is counted, and no launch path reaches
// agent-director for P afterwards while B launches. At the latch-time read,
// that latch stands alone: a CONFLICT or an UNUSABLE NAME answer that asked
// for it sets nothing more and posts no SRJ-1004 or SRJ-1019 notice
// (SRJ-513; hatch A2). Controls: the same row with a launch start keeps
// today's `pending` branch, a key the configured-persona query does not hold
// latches no one, and the permission poller's and the JSONL persistence
// safeguard's `get`s (SRJ-122) latch and post nothing and keep their
// behaviour. Every case runs on `makeRecoveryHarness` (its latch and
// configured-persona query installed as `main()` installs them);
// `srj105AfterEach` runs `assertNoLeak` over the lines, notices and entries
// it captured, and the file's `afterEach` clears the notifier, the latch
// install and the configured-persona query.
// ---------------------------------------------------------------------------

/** The latching launch-start rows of read shape `shape`. */
function launchStartRowsOf<S extends LaunchStartReadShape>(shape: S): readonly LaunchStartCaseRowOf<S>[] {
  return LAUNCH_START_CASE_ROWS.filter((row) => row.shape === shape) as readonly LaunchStartCaseRow[] as unknown as readonly LaunchStartCaseRowOf<S>[]
}

/** P's current-life rows of `shape`, one per form of "no launch start". */
function launchStartCurrentLifeOf<S extends LaunchStartReadShape>(shape: S): readonly LaunchStartCaseRowOf<S>[] {
  return launchStartRowsOf(shape).filter((row) => row.variant === 'current life')
}

/**
 * A sample of `shape`'s rows: each variant once and each form once (current
 * life with none, another `cwd` with `null`, another `config_dir` with an
 * unparseable launch start). Every row runs at the collision `get`, where the
 * guards are; the other sites share the one decision and take the sample.
 */
function launchStartSampleOf<S extends LaunchStartReadShape>(shape: S): readonly LaunchStartCaseRowOf<S>[] {
  return launchStartRowsOf(shape).filter(
    (row) =>
      (row.variant === 'current life' && row.form === 'absent') ||
      (row.variant === 'other cwd' && row.form === 'null') ||
      (row.variant === 'other config_dir' && row.form === 'unparseable'),
  )
}

/** `rows` as `test.each` cases, named by each row's name. */
function byName<R extends { readonly name: string }>(rows: readonly R[]): Array<readonly [string, R]> {
  return rows.map((row) => [row.name, row] as const)
}

/**
 * The session manager's launch-start latch lines for persona `key`, at a
 * launch (`"P" (key=P)`) or a check (`persona=P`): the shared `get` read's
 * (b.jg5 SRJ-114, SRJ-513) and the own-row `status` step's (b.jg5 SRJ-115,
 * SRJ-501).
 */
function launchStartLinesOf(h: RecoveryHarness, key: string): string[] {
  const pending = describeLatchRowState(latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE))
  return h.errors.filter(
    (line) =>
      (line.includes(` for ${renderPersonaRef(key, key)}: `) || line.includes(` for persona=${key}: `)) &&
      ((line.includes(`: its row reads pending with no launch start (state=${pending}) — `) && line.endsWith('; nothing more is called for it (b.jg5 SRJ-114, SRJ-513)')) ||
        (line.includes(`: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${pending}) — `) &&
          line.endsWith('; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)'))),
  )
}

/** A `get` of P's own row through E14's shared read, reached by P's launch. */
interface LaunchStartGetSite {
  readonly name: string
  setup?(h: RecoveryHarness): void
  /** Stub answers for a launch of `persona` whose site `get` reads `row`. */
  script(h: RecoveryHarness, persona: Persona, row: CannedGetResult): RecoveryStubScript
  /** Every call the launch makes, raw tmux included, the latching `get` last (`whole`), or the calls that end it. */
  readonly order: readonly string[]
  readonly whole: boolean
  readonly calls: LaunchVerbCalls
  readonly gets: number
}

const LAUNCH_START_GET_SITES: readonly LaunchStartGetSite[] = [
  {
    name: 'the collision get',
    script: (_h, _p, row) => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: row }),
    order: ['spawn', 'get'],
    whole: true,
    calls: ladderCallsOf({ spawn: 1 }),
    gets: 1,
  },
  {
    name: 'the ErrJsonlMissing diagnosis get (the collision get read ended)',
    script: (h, p, row) => jsonlMissingDiagnosisGets(h, p, cannedOk(row)),
    order: ['spawn', 'get', 'resume', 'get'],
    whole: true,
    calls: ladderCallsOf({ spawn: 1, resume: 1 }),
    gets: 2,
  },
  {
    // The wait's first poll reads working and its pane idle, so it reads the
    // transcript; every later poll would read waiting.
    name: 'readPersonaTranscript\'s get in the working-row wait (an idle pane)',
    setup: fastPolls,
    script: (h, p, row) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'working' })), cannedOk(row)],
      statusQueue: [cannedOk(cannedStatusResult({ state: 'working' }))],
      statusResult: cannedStatusResult({ state: 'waiting' }),
      readPaneResults: [{ pane: IDLE_PANE }],
    }),
    order: ['spawn', 'get', 'findMissing', 'status', 'readPane', 'get'],
    whole: true,
    calls: ladderCallsOf({ spawn: 1 }),
    gets: 2,
  },
  {
    // b.4dk: a waiting row whose reconnect found its session dead runs the
    // sweep before resume; the run lists P's own row in unverified_ids.
    name: 'the get after unverified_ids (the b.4dk sweep before resume)',
    script: (h, p, row) => ({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(harnessRow(h, p, { state: 'waiting' })), cannedOk(row)],
      sendKeysError: errTmuxSendKeys(),
      findMissingResult: unverifiedRowsOf(p.key),
    }),
    order: ['findMissing', 'get'],
    whole: false,
    calls: ladderCallsOf({ spawn: 1, sendKeys: 2 }),
    gets: 2,
  },
]

/** Each get site crossed with its rows: every `get` row at the collision get, the sample elsewhere. */
const LAUNCH_START_GET_CROSS = LAUNCH_START_GET_SITES.flatMap((site) =>
  (site === LAUNCH_START_GET_SITES[0] ? launchStartRowsOf('get') : launchStartSampleOf('get')).map((row) => [site.name, row.name, site, row] as const),
)

describe('b.jg5 SRJ-513, SRJ-114, SRJ-1020: a configured persona\'s own pending row with no launch start latches it at each of E14\'s get sites, and its caller stops', () => {
  beforeEach(() => {
    _resetFindMissingMemo()
  })
  afterEach(srj105AfterEach)

  // Demo (AC 86): a pending row with no launch start latches P.
  test.each(LAUNCH_START_GET_CROSS)('%s reading %s: P latched with "launch start not recorded", "none" and pending; that get is the last call, raw tmux included; one SRJ-1020 post; nothing counted, diagnosed or posted as a failure; the launch answers latched; then no launch path reaches agent-director; B launches', async (_site, _row, site, row) => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    site.setup?.(h)
    const script = site.script(h, persona, row.build(persona, h.home))
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(site.whole ? order : order.slice(-site.order.length)).toEqual([...site.order])
    expect(ladderCallsMade(h)).toEqual(site.calls)
    expect(getIds(h)).toEqual(Array(site.gets).fill(personaInstanceId(p)))
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  // SRJ-513's precedence (hatch A2): a row that also carries the note latches
  // with "launch start not recorded" only, with one post (no CONFLICT notice).
  test('the collision get reading P\'s own pending row with no launch start that also carries provenance_conflict: one latch, "launch start not recorded" only, one SRJ-1020 post and no CONFLICT notice', async () => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    const row = LAUNCH_START_AND_NOTE_ROW
    const script: RecoveryStubScript = { spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: row.build(persona, h.home) }
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'get'])
    expect(h.errors.filter((line) => line.includes(`: its row carries the liveness note ${provenanceNote}`))).toEqual([])
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(byName(launchStartSampleOf('get')))('the start pass: P latched at its ErrJsonlMissing diagnosis get (%s) is listed latched and counted in neither amnesia counter, failed nor succeeded; no delete, diagnosis entry or notice; B is counted', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    const pId = personaInstanceId(p)
    let pGets = 0
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getFn: (params) =>
        params.claude_instance_id !== pId ? errSpawnNotFound() : ++pGets === 2 ? row.build(persona, h.home) : harnessRow(h, persona, { state: 'ended' }),
      resumeError: errJsonlMissing(),
    })

    const result = await startupSessionManager(h.config, { concurrency: 1 })

    expect(result.perPersona).toEqual([
      { key: p, action: 'latched' },
      { key: b, action: 'spawned' },
    ])
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(result.freshAfterAmnesia).toBe(0)
    expect(result.freshAfterInconclusiveAmnesia).toBe(0)
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.spawnCalls.filter((c) => c.claude_instance_id === pId)).toHaveLength(1)
    expectLatchedOnce(h, p, launchStartLatch(p, row))
  })

  test.each(byName(launchStartSampleOf('get')))('the restart path\'s working-row check (checkWorkingRowPane) whose transcript get after an idle pane reads %s answers defer: P latched with pending; no evidence pending, nothing typed; a second check makes no get and posts nothing', async (_name, row) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    h.script({ readPaneResults: [{ pane: IDLE_PANE }], getResult: row.build(persona, h.home) })
    const order = await recordEveryCall(h, p)

    expect(await checkWorkingRowPane(p, persona)).toBe('defer')

    expect(order).toEqual(['readPane', 'get'])
    expect(hasPendingWorkingRowEvidence(p)).toBe(false)
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    expect(await checkWorkingRowPane(p, persona)).toBe('defer')
    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({}))
    expect(h.latchEvents).toHaveLength(ONE_LATCH_STEPS.length)
    expect(h.episodeNotices).toHaveLength(1)
  })

  test.each(byName(launchStartSampleOf('get')))('a bypassing run listing P\'s and B\'s own rows in unverified_ids, P\'s get reading %s: P latched and the caller gets FIND_MISSING_LATCHED; B\'s row is still read and B latches nothing', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const pId = personaInstanceId(p)
    h.script({
      findMissingResult: unverifiedRowsOf(p, b),
      getFn: (params) => (params.claude_instance_id === pId ? row.build(harnessPersona(h, p), h.home) : harnessRow(h, harnessPersona(h, b), { state: 'ended' })),
    })

    expect(await bypassingFindMissingSweep(p, BYPASS_SITE)).toBe(FIND_MISSING_LATCHED)

    expect([...getIds(h)].sort()).toEqual([pId, personaInstanceId(b)].sort())
    expect(postRunReadsOf(h)).toBe(`persona=${p} latched, persona=${b} read`)
    expect(h.latch.isLatched(b)).toBe(false)
    expectLatchedOnce(h, p, launchStartLatch(p, row))
  })
})

describe('b.jg5 SRJ-513, SRJ-114, SRJ-408: the controls at the collision get — a launch start recorded, or a key the configured-persona query does not hold, latches no one', () => {
  afterEach(srj105AfterEach)

  const recorded = LAUNCH_START_NON_LATCHING_ROWS.filter(
    (row): row is LaunchStartNonLatchingRowOf<'get'> => row.shape === 'get' && row.kind === 'launch start recorded',
  )
  test.each(byName(recorded))('P\'s own row %s keeps today\'s pending branch: no-op after one spawn and one get, no status read; nothing latched or posted', async (_name, row) => {
    const { h, p } = srj105Build()
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: row.build(harnessPersona(h, p), h.home) })
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'no-op' })

    expect(order).toEqual(['spawn', 'get'])
    expect(h.errors).toContain(`[slack] spawnForPersona: no action — state=${AGENT_DIRECTOR_PENDING_STATE} for ${renderPersonaRef(p, p)}`)
    expectNoNoteLatch(h)
    expect(launchStartLinesOf(h, p)).toEqual([])
  })

  test.each(byName(launchStartCurrentLifeOf('get')))('the configured-persona query does not hold P, its own row %s: today\'s pending branch (no-op); nothing latched or posted', async (_name, row) => {
    const { h, p, b } = srj105Build()
    setConfiguredPersonaQuery((key) => key === b)
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getResult: row.build(harnessPersona(h, p), h.home) })
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'no-op' })

    expect(order).toEqual(['spawn', 'get'])
    expectNoNoteLatch(h)
    expect(launchStartLinesOf(h, p)).toEqual([])
  })
})

/** A `status` site of the session manager reached by P's launch, its stub answers and the calls the launch makes. */
interface LaunchStartStatusSite {
  readonly name: string
  setup?(h: RecoveryHarness): void
  script(h: RecoveryHarness, persona: Persona, result: Phase1StatusResult): RecoveryStubScript
  /** Whether the site is the working-row wait's (which logs its latched end). */
  readonly wait: boolean
}

const LAUNCH_START_STATUS_SITES: readonly LaunchStartStatusSite[] = [
  {
    name: 'the working-row wait\'s poll status',
    setup: fastPolls,
    script: (h, p, result) => ({ ...collided(h, p, { state: 'working' }), statusResult: result }),
    wait: true,
  },
  {
    name: 'the working-row wait\'s timeout status (every poll read working)',
    setup: shortWait,
    script: (h, p, result) => {
      const sweepsBefore = h.stub.calls.findMissingCalls.length
      return {
        ...collided(h, p, { state: 'working' }),
        readPaneResults: [{ pane: SPINNER_PANE }],
        statusFn: () => (h.stub.calls.findMissingCalls.length >= sweepsBefore + 2 ? result : cannedStatusResult({ state: 'working' })),
      }
    },
    wait: true,
  },
  {
    name: 'the re-read after the sweep of a check_permission row whose tmux session is gone (reconcileAndReadRowState)',
    setup: tmuxSessionsGone,
    script: (h, p, result) => ({ ...collided(h, p, { state: 'check_permission' }), statusResult: result }),
    wait: false,
  },
]

describe('b.jg5 SRJ-513, SRJ-115, SRJ-1020: a configured persona\'s own pending row with no launch start latches it at each of the session manager\'s status sites', () => {
  afterEach(srj105AfterEach)

  test.each(byName(launchStartRowsOf('status')))('the shared own-row status read, %s: latched with pending, from one status call; P latched once, one post', async (_name, row) => {
    const { h, p } = srj105Build()
    h.script({ statusResult: row.build(harnessPersona(h, p), h.home) })

    expect(await readPersonaOwnRowStatus(p, STATUS_READ_SITE)).toStrictEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: row.rowState })

    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.callCount()).toBe(1)
    expectLatchedOnce(h, p, launchStartLatch(p, row))
  })

  test.each(byName(launchStartCurrentLifeOf('status')))('the shared own-row status read with the configured-persona query not holding P, %s: the state pending, nothing latched or posted', async (_name, row) => {
    const { h, p, b } = srj105Build()
    setConfiguredPersonaQuery((key) => key === b)
    h.script({ statusResult: row.build(harnessPersona(h, p), h.home) })

    const read = await readPersonaOwnRowStatus(p, STATUS_READ_SITE)

    expect(read.kind === OWN_ROW_STATUS_STATE && read.state).toBe(AGENT_DIRECTOR_PENDING_STATE)
    expectNoNoteLatch(h)
    expect(launchStartLinesOf(h, p)).toEqual([])
  })

  const statusCross = LAUNCH_START_STATUS_SITES.flatMap((site) => launchStartCurrentLifeOf('status').map((row) => [site.name, row.form, site, row] as const))
  test.each(statusCross)('a launch whose %s reads pending with launch start %s: latched, P latched with pending; that read is the last call, raw tmux included: no send-keys, find-missing, tmux fallback or dead-session verdict, no resume or launch; then no launch path reaches agent-director; B launches', async (_site, _form, site, row) => {
    const { h, p, b } = srj105Build()
    const persona = harnessPersona(h, p)
    site.setup?.(h)
    const script = site.script(h, persona, row.build(persona, h.home))
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order.at(-1)).toBe('status')
    expect(ladderCallsMade(h)).toEqual(ladderCallsOf({ spawn: 1 }))
    expect(waitLatchedLines(h)).toHaveLength(site.wait ? 1 : 0)
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(byName(launchStartCurrentLifeOf('status')))('the retry timer\'s row read (readPersonaRowState), %s: P latched with pending; a pending-only retry makes that one call and stops with the latch\'s reason, handing nothing to the restart path', async (_name, row) => {
    const { h, p } = srj105Build()
    h.script({ statusResult: row.build(harnessPersona(h, p), h.home) })
    h.controller.armPendingOnly(p)

    await retryNow(h, p)

    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.callCount()).toBe(1)
    expect(h.stops.filter((stop) => stop.key === p).map((stop) => stop.reason)).toEqual([UNAVAILABLE_RETRY_STOP_LATCHED])
    expect(h.restartAsks).toEqual([])
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    // The read itself answers the state the latch recorded (pending), with no second post.
    expect(await readPersonaRowState(p)).toStrictEqual({ state: describeLatchRowState(row.rowState) })
    expect(h.episodeNotices).toHaveLength(1)
  })

  // SRJ-513's precedence at E13's latch-time read: the read's own latch
  // stands alone, so the CONFLICT or the UNUSABLE NAME that asked for it sets
  // nothing on top and posts nothing of its own.
  test.each(byName(launchStartCurrentLifeOf('status')))('a CONFLICT at the first spawn whose latch-time status read reads %s: one status read; one latch, "launch start not recorded", with one SRJ-1020 post and no SRJ-1004 post; the CONFLICT line says the read\'s latch stands', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const script: RecoveryStubScript = { spawnError: conflictRowsFor('spawn')[0]!.build(), statusResult: row.build(harnessPersona(h, p), h.home) }
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'status'])
    const conflictLines = conflictLinesIn(h.errors, p)
    expect(conflictLines).toHaveLength(1)
    expect(conflictLines[0]).toContain(' — CONFLICT: the latch-time status read latched the persona, so that latch stands; ')
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    await expectLaunchedByNoPath(h, p, b, script)
  })

  test.each(byName(launchStartCurrentLifeOf('status')))('an UNUSABLE NAME at the first spawn whose latch-time status read reads %s: one status read; one latch, "launch start not recorded", with one SRJ-1020 post and no SRJ-1019 post; the UNUSABLE NAME line says the read\'s latch stands', async (_name, row) => {
    const { h, p, b } = srj105Build()
    const script: RecoveryStubScript = { spawnError: unusableNameRowsAt('plain spawn')[0]!.build(), statusResult: row.build(harnessPersona(h, p), h.home) }
    h.script(script)
    const order = await recordEveryCall(h, p)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'status'])
    const lines = unusableNameLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(' — UNUSABLE NAME: the latch-time status read latched the persona, so that latch stands; ')
    expectLatchedOnce(h, p, launchStartLatch(p, row))

    await expectLaunchedByNoPath(h, p, b, script)
  })
})

describe('b.jg5 SRJ-122, SRJ-513 (hatch A2): the gets SRJ-122 leaves alone latch no one on a pending row with no launch start and keep their behaviour', () => {
  afterEach(() => {
    stopPermissionPoller()
    _resetPollerState()
    srj105AfterEach()
  })

  test.each(byName(launchStartCurrentLifeOf('get')))('the permission poller\'s get of P\'s own row reading %s, with a permission request: its prompt is posted as for any row; nothing latched, nothing posted to the latch', async (_name, row) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    const slack = makeStubSlack()
    const trail = makeTrailCapture()
    const requested: CannedGetResult = { ...row.build(persona, h.home), permission_requests: [cannedPermissionRequest()] }
    // The poller reads through the harness's client, the session manager's too.
    h.script({
      listResult: { spawns: [cannedListRow({ state: 'check_permission' }, persona, h.home)] },
      getResult: requested,
    })
    const ivl = startManualPoller({
      getClient: () => h.stub.client as unknown as ReturnType<PollerDeps['getClient']>,
      clientFor: makePersonaClients((key) => (key === p ? slack : undefined)).clientFor,
      getPersona: (key) => h.config.personas.find((candidate) => candidate.key === key),
      emitTrail: trail.emit,
    })

    await ivl.tick()

    expect(getIds(h)).toEqual([personaInstanceId(p)])
    expect(posts(slack)).toHaveLength(1)
    expectNoNoteLatch(h)
    expect(launchStartLinesOf(h, p)).toEqual([])
    assertNoLeak({ posts: posts(slack), trail: trail.events })
  })

  test.each(byName(launchStartCurrentLifeOf('get')))('the JSONL persistence safeguard\'s get of P\'s own row reading %s: its lost-transcript notice is made as for any row; nothing latched, nothing posted to the latch', async (_name, row) => {
    const { h, p } = srj105Build()
    const persona = harnessPersona(h, p)
    const pId = personaInstanceId(p)
    h.script({
      getFn: (params) =>
        params.claude_instance_id === pId
          ? { ...row.build(persona, h.home), claude_session_id: TRANSCRIPT_SESSION_ID, jsonl_path: join(h.home, 'gone.jsonl') }
          : errSpawnNotFound(),
    })
    const posted: Array<{ key: string; text: string }> = []

    await runJsonlPersistenceSafeguard(h.config, (key, text) => {
      posted.push({ key, text })
    }, {
      readMountinfo: () => '',
      statFn: () => false,
      archiveCountSince: () => 2,
      recordStartupError: () => {},
      home: h.home,
    })

    expect(getIds(h)).toContain(pId)
    expect(posted.map((n) => n.key)).toEqual([p])
    expectNoNoteLatch(h)
    expect(launchStartLinesOf(h, p)).toEqual([])
    assertNoLeak({ posted })
  })
})
