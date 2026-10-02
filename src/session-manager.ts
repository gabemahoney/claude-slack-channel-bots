/**
 * session-manager.ts — Library-backed startup orchestration for CSCB.
 *
 * The previous tmux-direct implementation has been replaced with calls to the
 * agent-director TypeScript library `Client` singleton (SR-1). Spawns are
 * keyed by persona (b.av2 SR-2.2): instance ID `cscb_<key>`, tmux session
 * `slack_bot_<key>`, `relay_mode='on'`, and the labels `service=cscb`,
 * `persona=<key>` and `config_dir=<12 hex of the real effective
 * claude_config_dir>`, and no other label. Per-persona reconciliation uses
 * the SR-1.4 collision-then-act dispatch:
 *
 *   1. Try `client.spawn(...)` directly: a plain first spawn from
 *      `buildSpawnParams`, with no reuse flag (b.jg5 SRJ-711), so a row that
 *      is already there collides and step 2 keeps its conversation.
 *   2. On `ErrInstanceIdCollision`, call `client.get(...)` through the shared
 *      own-row read (`readPersonaOwnRow`, b.jg5 SRJ-114). A read that latched
 *      the persona (a configured persona's own row reading `pending` with no
 *      launch start, or carrying a `provenance_conflict` note, or an UNUSABLE
 *      NAME answer) ends the ladder with `latched` before anything below,
 *      the `cwd` and `config_dir` guards included. A row whose `cwd`
 *      differs from the persona's working directory by real path is replaced
 *      whatever its state, with no row deleted (b.av2 SR-6.2 as amended,
 *      b.jg5 SRJ-1503). Otherwise branch on the observed state (ended/missing
 *      → resume, or the replacement when `resume_enabled` is false; waiting
 *      → /mcp reconnect via sendKeys; working →
 *      wait for waiting (or, b.f2b, for positive evidence that the row is
 *      stale and the session idle: the same idle pane and the same transcript,
 *      ended with a completed turn, across a window) then reconnect;
 *      check_permission/ask_user → one one-line `read-pane` of the row:
 *      no-op on a pane or a read that could not answer, and a findMissing
 *      sweep, then resume or spawn once its row reads dead, when
 *      agent-director finds no pane of its launch or no row (b.jdc, b.jg5
 *      SRJ-607); pending → no-op, or the replacement when its `config_dir`
 *      label is missing or differs, b.jg5 SRJ-411). Nothing is ever typed
 *      into a prompt. Before any resume, a row whose `config_dir` label is
 *      missing or differs from the persona's current effective
 *      claude_config_dir is replaced instead (a resume keeps the old config
 *      dir; b.av2 SR-6.2 as amended, b.jg5 SRJ-1504). Every replacement goes
 *      through one replace step (`replacePersonaRow`, b.jg5 SRJ-707), which
 *      decides on the row state the path last read: a finished row (`ended`,
 *      `missing` or no row) gets a reuse spawn of the same id
 *      (`reuseSpawnForPersona`, SRJ-112), whose collision re-runs this
 *      get-then-act once (a second collision arms the reuse-collision cause
 *      and answers the uncounted refused result); a live row (`pending`
 *      included) starts the live-row sequence (SRJ-705), which ends in that
 *      reuse spawn, and the ladder answers `sequence-waiting` with no other
 *      call. No ladder path deletes a row or kills one, and none launches
 *      over a live row. A resume's `ErrSpawnNotResumable` is a lost race
 *      (b.jg5 SRJ-710): nothing is killed, deleted or launched, the retry
 *      timer is armed with the lost-race cause, and the ladder answers the
 *      uncounted refused result.
 *   3. Any other error raises a spawn-failure notice for the persona via
 *      `notifySpawnFailure` (through the per-persona notifier) and is logged,
 *      except a refusal (b.jg5 SRJ-105, `refusalAt`): an UNAVAILABLE,
 *      ENVIRONMENT (`ErrTmuxNotAvailable`, SRJ-311), CONFIG
 *      (`ErrConfigMalformed`, SRJ-316: the wrapper has raised the
 *      `ad-config-malformed` outage) or UNCLASSIFIED (SRJ-313: an
 *      `ErrInternal` other than an unusable recorded name, a store-open
 *      name, `ErrSystemInstallDisappeared`, any name CSCB gives no handling,
 *      and a resume's `ErrInvalidFlags` after its re-check) outcome at any
 *      spawn or resume, or a read error (an
 *      ENVIRONMENT, CONFIG or UNCLASSIFIED answer included) at the collision
 *      `get`. It is logged once and stops the ladder with `failed`: no
 *      notice, no `spawn-failed` entry, no `dead-session` verdict, and no
 *      further launch. An `ErrTmuxSessionCreate` (LAUNCH
 *      FAILURE, decided by name) at any spawn or resume the ladder makes is
 *      one counted launch failure (b.jg5 SRJ-602, SRJ-111, SRJ-113): one
 *      line, the notice, a `spawn-failed` entry at start and `failed`;
 *      nothing is killed because of it and no spawn is made in its place,
 *      and the persona's retry timer is armed at once in pending-only mode,
 *      so that the retry's read of the row decides (`launchFailureResult`;
 *      SRJ-301, SRJ-409). An UNCLASSIFIED outcome has also been
 *      reported to the persona's unclassified-error episode
 *      (`src/persona-episodes.ts`). A `status` error in the working-row wait
 *      is no refusal: the wait goes on, or at its timeout ends
 *      `not-reconnected` (b.jg5 SRJ-605, `waitForWaitingAndReconnect`). The
 *      reconnect keystroke is one `send-keys`, never retried, decided by
 *      b.jg5 SRJ-118's reconnect row (`reconnectMcpWithCause`): it never
 *      raises a spawn-failure notice, and its `transient` answer ends the
 *      ladder `latched` for a latched persona and otherwise `failed` with the
 *      refusal marker, uncounted.
 *   4. A CONFLICT (`ErrTmuxSessionConflict`, b.jg5 SRJ-105, SRJ-501) at any
 *      spawn or resume the ladder makes (the first spawn, the retry spawn
 *      after the collision `get` found no row, the spawn after `resume`
 *      found none, the resume, and every reuse spawn of the same id: the
 *      replace step's and the one after resume's no-transcript answer) takes the
 *      CONFLICT row (`conflictAt`): the persona latches
 *      through the installed latch (`setConflictLatch`) with the refused
 *      operation "plain spawn", "reuse spawn" or "resume" and the row state the path last
 *      read before the call (one latch-time `status` read when it read
 *      nothing), and the ladder answers `latched`: no notice from here, no
 *      `spawn-failed` entry, nothing counted, and no further
 *      launch. A latched persona is not launched at all: `spawnForPersona`
 *      answers `latched` with no agent-director call (b.jg5 SRJ-502).
 *   5. An UNUSABLE NAME answer (an `ErrInternal` naming "the recorded tmux
 *      session name", b.jg5 SRJ-105, SRJ-512) at any of those spawns or the
 *      resume takes the UNUSABLE NAME row (`unusableNameAt`): the persona
 *      latches with the case "unusable recorded name", the refused operation
 *      "none" and the row state the path last read (one latch-time `status`
 *      read when it read nothing), and the ladder answers `latched`, as at
 *      the CONFLICT row: no notice from here, no `spawn-failed` entry,
 *      nothing counted, and no further launch or reuse, so no
 *      tmux-touching call follows it. Every other `ErrInternal` stays
 *      UNCLASSIFIED (step 3). The persona teardown's kill and delete
 *      (`killPersonaInstance`, `deletePersonaInstance`) latch nothing.
 *   6. Every kill is a checked kill (`src/checked-kill.ts`; b.jg5 SRJ-110,
 *      SRJ-701): `killPersonaInstance` answers its outcome, `kill_sent`
 *      included, and never throws; its context (`KILL_CONTEXT_ATTEMPT` or
 *      `KILL_CONTEXT_TEARDOWN`) is required. The collision ladder makes no
 *      kill: a live row's kills are the live-row sequence's, which run
 *      through the bounded retry (`retryPersonaKill`, `src/kill-retry.ts`;
 *      b.jg5 SRJ-702) as the restart path's kill does, and raise the retry's
 *      kill-failure alert decision (`raisePersonaKillFailureAlert`, through
 *      the installed kill-failure alerts; b.jg5 SRJ-704).
 *
 * Own-row reads (b.jg5 SRJ-114, SRJ-115): every `get` of a persona's own row
 * at SRJ-114's sites goes through `readPersonaOwnRow`, and every own-row
 * `status` the session manager makes, the dialog approver's included, through
 * `readPersonaOwnRowStatus`, which applies the own-row `status` step
 * (`applyOwnRowStatusStep`; the liveness and reconnect adapters in
 * `src/server.ts` apply it after their own calls). Both apply the row-read
 * rule (`decideOwnRowRead`, `src/row-read-rules.ts`) to every row or result
 * they read: a configured persona's own row that reads `pending` with no
 * launch start latches the persona with the case "launch start not
 * recorded" (b.jg5 SRJ-513), whether or not it is the persona's current
 * life, and a `get` row carrying the `provenance_conflict` note latches it
 * with "conflicting labels" (a row with both latches with the first only).
 * An UNUSABLE NAME answer to either read latches the persona with the state
 * unreadable. A read that latched answers `latched`, and the caller calls
 * nothing more for the persona: no `send-keys`, kill, delete or launch, and
 * no hand-off to the `pending` deferral or the pending-only retry. A row
 * either read reads `ended` or `missing`, or an `ErrSpawnNotFound` answer,
 * ends the persona's kill-failure episode silently (b.jg5 SRJ-704,
 * SRJ-1016). Every
 * `read-pane` of a persona's own row outside the dialog approver goes
 * through the shared read-pane (`readPersonaOwnPane`, b.jg5 SRJ-117; the
 * outcome and its class in `src/pane-read.ts`). Its uses (the launch wait's
 * evidence read and the restart path's `waiting`-row check through
 * `readWorkingPane`, the `working`-row verdict in `src/server.ts`, whose
 * pane `checkWorkingRowPane` folds, and b.jdc's one-line reads of an
 * `ask_user` or `check_permission` row: the prompt-row verdict
 * `promptRowReconnectVerdict` in `src/server.ts` and the ladder's
 * `launchOnPromptRow`) latch on a CONFLICT answer,
 * with the refused operation "P's next check or recovery", and on an
 * UNUSABLE NAME answer, each with the state its caller last read; a latched
 * persona is not read, and its caller ends with nothing typed. A pane that
 * any of them reads, or the dialog approver reads, may be a single
 * leftover's (b.jg5 SRJ-613), so none acts on a pane alone: the `send-keys`
 * that follows is the backstop (the reconnect's CONFLICT "not this launch's
 * session" latches P with nothing typed; the approver's
 * `ErrSpawnNotInteractive` on a `pending` row stops it with nothing typed
 * and no kill; see `src/pane-read.ts`).
 *
 * Both row checks go through `compareRowToPersona`. At most one launch per
 * persona is in flight (b.av2 SR-6.3): a concurrent call for the same key
 * joins the running ladder. A launch that returned success starts the
 * persona's dialog approver after its launch call, outside the launch and
 * its attempt, in a registry holding at most one approver per persona
 * (`startDialogApprover`, b.jg5 SRJ-401); a teardown or shutdown stops it
 * (`stopDialogApprover`, `stopAllDialogApprovers`, SRJ-404), and so does a
 * latch of the persona set by any site (the set observer the latch installer
 * registers, `setConflictLatch`, SRJ-502). The approver paces its laps
 * (SRJ-403), stops at B from the launch start with no post (SRJ-404,
 * SRJ-405) and classifies every answer by class (SRJ-117, SRJ-118). Every launch
 * first resolves the persona's claude_config_dir to a real path with no
 * lexical fallback (bug b.g57,
 * `checkLaunchConfigDir`); when it cannot be resolved the launch makes no
 * agent-director call, keeps the row, hands the persona to the installed
 * hook (`setConfigDirUnresolvableHook`: the bring-up controller holds it
 * `retrying` and re-checks) and returns `deferred`. Every ladder run first
 * calls the installed pre-launch trust patcher (`setPreLaunchTrustPatcher`,
 * b.av2 SR-6.2), so the persona's `.claude.json` trust flags are set before
 * any spawn or resume.
 * Immediately before each `client.spawn` / `client.resume` it calls the
 * installed pre-launch reply guard (`setPreLaunchReplyGuard`, b.av2 SR-9.4):
 * the persona's reply-guard record, launched-with dir and managed Stop hook.
 * A path that only reconnects to a live instance or does nothing runs no
 * reply-guard step (the optimistic spawn's steps are undone on a collision).
 *
 * The start sweep (`reconcileOrphans`, b.av2 SR-6.3) lists every
 * `service=cscb` spawn and kills any with a persona absent from the
 * applied configuration, an instance ID other than `cscb_<key>`, or a `cwd`
 * other than its persona's working directory, deleting it only after a kill
 * that succeeded (each kill a checked kill, b.jg5 SRJ-110, SRJ-701, run
 * through the bounded retry with one pass budget, SRJ-702; it latches
 * nothing and arms no retry timer). A pre-persona row (no `persona`
 * label) is never deleted: it is kept, and killed only when live, with one
 * findMissing sweep after the kills so a killed row reads `missing` once its
 * session is gone and isn't killed again at the next start (b.1ix). While a
 * persona's working directory cannot be resolved to a real path, neither the
 * sweep nor the collision ladder acts on `cwd` grounds on a row whose `cwd`
 * has no real path either (b.av2 SR-6.4): the sweep defers the check to the
 * launch, and the ladder keeps the row and fails the launch instead. A row
 * whose `cwd` resolves to an existing directory is still a `cwd` mismatch.
 *
 * At start, `startupSessionManager` brings each applied persona up through
 * the b.av2 SR-6.1 procedure (`persona-start.ts`, driven by the bring-up
 * controller in `persona-bringup-controller.ts`): the local credentials and
 * working-directory checks, Slack validation and connection (every persona at
 * once), then the launch through `spawnForPersona` (at most `concurrency` at
 * a time) for each persona that is up. A launch that starts waiting for a
 * `working` row is left to finish in the background, still in flight, so the
 * pass does not wait for it (b.f2b). A restart (`launchSession`) runs the
 * launch only, and only while the caller's gate says the persona is up.
 * Every collision ladder runs as a launch attempt for its persona (b.jg5
 * SRJ-301): an UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED outcome, or a
 * `status`, `get` or `list` error, inside it arms the persona's retry timer, and a `failed`
 * launch whose last agent-director error armed it is refused
 * (`SpawnPersonaResult.refused`), which the restart path never counts.
 *
 * The live-row sequence (`src/live-row-sequence.ts`, b.jg5 SRJ-705) runs
 * through the dependencies `buildLiveRowSequenceDeps` binds to the shared
 * entries here, and makes its final launch through one launch call,
 * `launchForLiveRowSequence`: a `resume` whose no-transcript answers go on to
 * the no-transcript step (`noTranscriptReuse`, b.jg5 SRJ-707, SRJ-712: after
 * `ErrJsonlMissing` the lost-transcript diagnosis, then the reuse spawn; the
 * collision ladder's `resume` uses the same step), or the reuse spawn
 * (`reuseSpawnForPersona`, b.jg5
 * SRJ-112, SRJ-708: `buildSpawnParams` with the reuse flag, its outcomes
 * classified by name), whose collision ends the sequence without its launch;
 * the entry counts its launch's result once. Sequences run in the
 * server's one registry (`setLiveRowSequenceRegistry`, b.jg5 SRJ-706),
 * reached through the start entry (`startLiveRowSequence`) and the running
 * query (`isLiveRowSequenceRunning`); a latch of the persona stops its
 * sequence (the set observer the installers register). While a sequence runs
 * for a persona, every launch path for it answers `sequence-waiting` with no
 * agent-director call (the gate in `spawnForPersona`, which `launchSession`
 * answers as the uncounted `'refused'`); the sequence's own launch,
 * `launchForLiveRowSequence`, is exempt, and makes no call once the sequence
 * is stopped. Its production starters are the collision ladder's
 * replacement sites, through the replace step (`replacePersonaRow`, b.jg5
 * SRJ-707): a live row there (`pending` included) starts a sequence with the
 * conversation not kept and alert context `recovery`, and the launch answers
 * `sequence-waiting`. The sequence's launch is never part of the start pass:
 * it passes the start flag false, so it writes no startup-errors entry.
 *
 * No tmux process-tree walks, no JSONL existence checks for resume eligibility:
 * the library encapsulates both.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Client, ListRow, SpawnParams, FindMissingResult, GetResult } from 'agent-director'

import type {
  Phase1GetResult,
  Phase1ResumeResult,
  Phase1SpawnParams,
  Phase1SpawnResult,
  Phase1StatusResult,
  PreTrust,
} from './ad-phase1-types.ts'

import { checkCozempicAvailable, resolveJsonlPath } from './cozempic.ts'
import {
  type Persona,
  type PersonaConfig,
  type StrictRealPathFs,
  MCP_SERVER_NAME,
  resolveRealPathStrict,
  tryResolveRealPath,
} from './config.ts'
import { checkPersonaConfigDir, type ConfigDirCheckResult } from './persona-bringup.ts'
import type { PersonaCheckFailure } from './persona-diagnostics.ts'
import {
  CONFIG_DIR_LABEL_PREFIX,
  PERSONA_INSTANCE_ID_PREFIX,
  PERSONA_LABEL_KEY,
  PERSONA_LABEL_PREFIX,
  SERVICE_LABEL,
  configDirLabelValue,
  personaInstanceId,
  personaSpawnEnv,
  personaTmuxSessionName,
  renderPersonaRef,
  resolveClaudeConfigDir,
} from './persona-identity.ts'
import { getClient } from './agent-director-client.ts'
import {
  armPendingOnlyAfterLaunchFailure,
  getOutageFlags,
  raiseAdConfigMalformed,
  raiseTmuxUnavailable,
  reportAgentDirectorError,
  reportDeferredUnavailable,
  reportLostRaceAtSite,
  reportReuseCollisionAtSite,
  reportUnclassifiedAtSite,
  setOutageFlag,
  withOutageDetection,
  withSpawnDetection,
} from './outage-state.ts'
import {
  AgentDirectorError,
  ErrInstanceIdCollision,
  ErrSpawnNotFound,
  ErrSpawnCapReached,
  ERR_INSTANCE_ID_COLLISION_NAME,
  ERR_JSONL_MISSING_NAME,
  ERR_JSONL_NEVER_WRITTEN_NAME,
  ERR_NO_SESSION_ID_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_SPAWN_NOT_INTERACTIVE_NAME,
  ERR_SPAWN_NOT_RESUMABLE_NAME,
} from './agent-director-errors.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  adKillCall,
  type AdErrorClass,
  type AdKillCall,
  type AdVerb,
  classifyAdError,
  classifyWithInvalidFlagsRecheck,
  conflictDescriptionOf,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  hasAdErrorName,
  isInvalidFlagsError,
  unclassifiedClassificationOf,
  type InvalidFlagsError,
} from './ad-error-class.ts'
import { RECHECK_OUTCOME_STOP } from './ad-version-gate.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  checkedKill,
  describeKillOutcome,
  killLetsNextStepRun,
  killOutcomeStopsServer,
  type KillOutcome,
} from './checked-kill.ts'
import {
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  ORPHAN_CLEANUP_LABEL,
  describeKillFailureDescriptions,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
  selectKillFailureAlertRoute,
  type KillFailureAlertContext,
} from './kill-failure-alert.ts'
import {
  KILL_FAILURE_END_ROW_FINISHED,
  KILL_FAILURE_END_ROW_GONE,
  type KillFailureAlerts,
  type KillFailureEndReason,
} from './persona-episodes.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_END_READ_LATCHED,
  KILL_RETRY_END_STOPPED,
  KILL_RETRY_READ_FAILED,
  KILL_RETRY_READ_LATCHED,
  KILL_RETRY_READ_NO_ROW,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SEED_NOT_LIVE_VALUE,
  KILL_RETRY_SYSTEM_CLOCK,
  createKillRetryPassBudget,
  killRetrySeedOfState,
  killRetryStopped,
  runKillRetry,
  type KillRetryAlert,
  type KillRetryPassBudget,
  type KillRetryRead,
  type KillRetryResult,
  type KillRetrySeed,
  type KillRetryWait,
} from './kill-retry.ts'
import {
  FULL_PANE_READ_LINES,
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_CONFLICT,
  PANE_READ_ENVIRONMENT,
  PANE_READ_GONE,
  PANE_READ_LATCHED,
  PANE_READ_NOT_READ_LATCHED,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  PANE_READ_UNUSABLE_NAME,
  paneReadClassNote,
  PROBE_PANE_READ_LINES,
  paneReadFailureOf,
  type PaneReadConflict,
  type PaneReadFailure,
  type PaneReadOutcome,
  type PaneReadUnclassified,
  type PaneReadUnusableName,
} from './pane-read.ts'
import {
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_KIND_READ,
  LATCH_ROW_STATE_KIND_UNREADABLE,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  describeLatchRowState,
  isUnusableNameError,
  latchRowStateRead,
  launchStartNotRecordedSetInput,
  recogniseConflictCase,
  unusableNameSetInput,
  type ConflictLatch,
  type ConflictLatchCase,
  type ConflictLatchRecord,
  type ConflictLatchSetEvent,
  type ConflictLatchSetOutcome,
  type LatchRowState,
  type RefusedOperation,
} from './conflict-latch.ts'
import {
  LATCHING_LIVENESS_NOTE,
  decideOwnRowRead,
  isLatchingLivenessNote,
  isPersonaOwnRow,
  type RowReadLatchDecision,
} from './row-read-rules.ts'
import {
  runInAttempt,
  runOutsideAttempts,
  unavailableRetryCauseFor,
  UNAVAILABLE_RETRY_CAUSE_LOST_RACE,
  UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  type AttemptView,
  type UnavailableRetryRowRead,
  type UnavailableRetryTriggerSink,
} from './unavailable-retry.ts'
import {
  LIVE_ROW_ARM_ENDED,
  LIVE_ROW_ARM_NOT_JUDGED,
  LIVE_ROW_ARM_REUSE_COLLISION,
  LIVE_ROW_LAUNCH_ANSWER_LAUNCHED,
  LIVE_ROW_LAUNCH_REUSE,
  LIVE_ROW_LAUNCH_SUCCESS_ACTIONS,
  LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE,
  LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION,
  LIVE_ROW_NOT_LAUNCHED_STOPPED,
  LIVE_ROW_OUTCOME_NOT_LAUNCHED,
  LIVE_ROW_READ_ABSENT,
  LIVE_ROW_READ_LATCHED,
  LIVE_ROW_READ_REFUSED,
  LIVE_ROW_READ_ROW,
  LIVE_ROW_RUN_FAILED,
  LIVE_ROW_RUN_JUDGED_ALIVE,
  LIVE_ROW_RUN_LATCHED,
  LIVE_ROW_RUN_LEFT_LIVE,
  LIVE_ROW_RUN_MARKED_MISSING,
  LIVE_ROW_RUN_NOT_JUDGED,
  LIVE_ROW_RUN_REFUSED,
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_SEQUENCE_LOG_PREFIX,
  LIVE_ROW_SEQUENCE_NO_ROW,
  LIVE_ROW_SEQUENCE_SITE,
  LIVE_ROW_STOP_LATCHED,
  type LiveRowSequenceArmCause,
  type LiveRowSequenceDeps,
  type LiveRowSequenceLastRead,
  type LiveRowSequenceLaunchKind,
  type LiveRowSequenceNotLaunchedReason,
  type LiveRowSequenceRead,
  type LiveRowSequenceRegistry,
  type LiveRowSequenceRequest,
  type LiveRowSequenceRunPlacement,
  type LiveRowSequenceStartAnswer,
  type LiveRowSequenceStopReason,
  type LiveRowSequenceStopSignal,
} from './live-row-sequence.ts'
import { recordStartupError } from './startup-errors.ts'
import {
  locateTranscript,
  readTranscriptTurnState,
  sameTranscriptSnapshot,
  type TranscriptReading,
  type TranscriptSnapshot,
} from './session-transcript.ts'
import type { ReplyGuardUndo } from './stop-hook-bootstrap.ts'
import { firstNoticeLine, notifySafely, type PersonaNoticeOptions, type PersonaNotify } from './persona-notifier.ts'
import type { PersonaBringUpFailure } from './persona-start.ts'
import type { PersonaBringUpController, PersonaBringUpOutcome } from './persona-bringup-controller.ts'
import {
  describeLogMessage,
  describeThrownValue,
  isSafeIdentifier,
  MAX_LOGGED_MESSAGE_LENGTH,
  renderLogMessageText,
} from './persona-connection-errors.ts'
import { describeDestinationFailureCause } from './persona-destination.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { RESTART_FAILURE_CAP, recordLaunchResultOutsideRestartWork } from './restart.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_NO_ROW,
  deadRowReadOf,
  pendingLaunchStartOf,
  type LivenessReading,
} from './liveness-reading.ts'
import { parseLaunchStart } from './pending-row.ts'
import { isDryRun } from './tokens.ts'
import {
  DIALOG_READY_TIMEOUT_MS,
  adGraceMsInEffect,
  adLaunchBoundMsInEffect,
  armNeverEarlyWait,
  type NeverEarlyWaitClock,
} from './ad-settings.ts'
// Import cycle with jsonl-persistence-check.ts: use these imports only inside functions, never at module top level.
import {
  UNATTRIBUTABLE_ZERO_REASON,
  makeDefaultArchiveCount,
  personaArchiveEvidenceScope,
  rfc3339ToEpochSeconds,
} from './jsonl-persistence-check.ts'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Live states per SR-11 (agent-director Spawn state machine), kept in
 * `src/liveness-reading.ts` beside the liveness readings (b.jg5 SRJ-314) and
 * re-exported here.
 */
export { AGENT_DIRECTOR_LIVE_STATES }

/** B's floor (`src/ad-settings.ts`, b.jg5 SRJ-210), re-exported for the approver's readers. */
export { DIALOG_READY_TIMEOUT_MS }

/** The CSCB-shipped template name (mirrors agent-director-client). */
const TEMPLATE_NAME = 'slack-channel-bot'

/**
 * Persona reference for log lines and startup-error messages (b.av2 SR-2.2):
 * the name JSON-quoted with the key beside it.
 */
function personaRef(persona: Pick<Persona, 'name' | 'key'>): string {
  return renderPersonaRef(persona.name, persona.key)
}

/** Log reference for a persona when only its key is in scope. */
function keyRef(key: string): string {
  return `persona=${key}`
}

/**
 * Thrown by `personaConfigDirLabelValue` for a claude_config_dir that cannot
 * be resolved to a real path (bug b.g57): there is no lexical fallback, so
 * such a directory has no `config_dir` label. Carries the configured
 * directory (tilde-expanded, absolute) and the errno code; never a token.
 */
export class ConfigDirUnresolvableError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`claude_config_dir ${JSON.stringify(path)} cannot be resolved to a real path (${code})`)
    this.name = 'ConfigDirUnresolvableError'
  }
}

/**
 * A persona's `config_dir` label value, or why there is none: the configured
 * directory and the errno code when it cannot be resolved to a real path.
 */
function strictConfigDirLabel(
  configDir: string | undefined,
  home: string,
  fs: Partial<StrictRealPathFs> | undefined,
): { label: string } | { path: string; code: string } {
  const path = resolveClaudeConfigDir(configDir, home)
  const resolution = resolveRealPathStrict(path, fs)
  return resolution.resolved ? { label: configDirLabelValue(resolution.path, home) } : { path, code: resolution.code }
}

/**
 * Value of a persona's `config_dir` label: the 12-hex hash of the REAL path
 * of its effective claude_config_dir (b.av2 SR-1.5, SR-2.2). An absent
 * directory means `<home>/.claude`. The directory is tilde-expanded and
 * resolved against `home`, then real-pathed with `resolveRealPathStrict`, so
 * a symlink and its target give the same label, and a directory not created
 * yet gives the label of the real path it will have (its nearest existing
 * ancestor's real path plus the rest). There is no lexical fallback (bug
 * b.g57): a directory that cannot be resolved (a symlink on its path pointing
 * to nothing, an unmounted drive, a dropped mount) throws
 * `ConfigDirUnresolvableError`. E1's `configDirLabelValue` alone hashes
 * lexically; this is the one derivation spawns and later label comparisons
 * use (the launch checks the directory first, `checkLaunchConfigDir`, and
 * `compareRowToPersona` reports it as unresolved rather than throwing).
 *
 * @param configDir  The persona's effective claude_config_dir, as configured.
 * @param home       Home directory; defaults to the OS home, read at call time.
 * @param fs         Realpath and lstat overrides; default the real file system.
 */
export function personaConfigDirLabelValue(
  configDir?: string,
  home: string = homedir(),
  fs?: Partial<StrictRealPathFs>,
): string {
  const result = strictConfigDirLabel(configDir, home, fs)
  if ('label' in result) return result.label
  throw new ConfigDirUnresolvableError(result.path, result.code)
}

/** Label-map key of the `config_dir=<hash>` label (`config_dir`). */
const CONFIG_DIR_LABEL_KEY = CONFIG_DIR_LABEL_PREFIX.slice(0, -1)

/** How an agent-director row compares with a persona (b.av2 SR-6.2, SR-6.3). */
export interface RowPersonaComparison {
  /** The row's `cwd` and the persona's working_directory have the same real path. */
  cwdMatches: boolean
  /**
   * The persona's working_directory resolved to a real path. When it did not
   * (missing, not searchable, a dangling symlink), `cwdMatches` is only the
   * lexical comparison.
   */
  workingDirectoryResolved: boolean
  /**
   * The `cwd` condition cannot be evaluated now (b.av2 SR-6.4): the persona's
   * working_directory has no real path AND the row's `cwd` has none either
   * (absent, missing, a dangling symlink's old target) or equals the
   * configured working_directory lexically. The start sweep and the collision
   * ladder never act on such a row on `cwd` grounds. A row whose `cwd`
   * resolves to an existing directory elsewhere is not deferred: it is a
   * `cwd` mismatch even while the working directory is missing, so a persona
   * never adopts a directory another persona may now own.
   */
  cwdCheckDeferred: boolean
  /**
   * The persona's effective claude_config_dir resolved to a real path (or to
   * the one it will have once created; `resolveRealPathStrict`). When it did
   * not (bug b.g57), there is no `config_dir` verdict: `configDirMatches` and
   * `expectedConfigDirLabel` are undefined, and a caller keeps the row rather
   * than treat it as a mismatch.
   */
  configDirResolved: boolean
  /**
   * The row carries a `config_dir` label equal to `expectedConfigDirLabel`;
   * undefined (no verdict) when the directory is unresolvable. Check
   * `configDirResolved` before acting on it.
   */
  configDirMatches: boolean | undefined
  /** The row's `config_dir` label value; undefined when the label is absent. */
  configDirLabel: string | undefined
  /**
   * The `config_dir` label a spawn of the persona carries now
   * (`personaConfigDirLabelValue`); undefined when the directory is
   * unresolvable, since no label is ever derived from its lexical path.
   */
  expectedConfigDirLabel: string | undefined
}

/**
 * Compare an agent-director row with a persona (b.av2 SR-6.2, SR-6.3). The
 * one place a row's `cwd` is compared with a persona's working directory and
 * a row's `config_dir` label with the persona's current effective
 * claude_config_dir; the collision ladder's `cwd` guard, its pre-resume
 * `config_dir` guard and the start sweep's `cwd` condition all use it.
 * Side-effect free.
 *
 * - `cwdMatches`: `resolveRealPath` on both sides (a symlink to the working
 *   directory matches). A row with no `cwd` never matches.
 * - `workingDirectoryResolved`: the persona's working directory has a real
 *   path (`tryResolveRealPath`).
 * - `cwdCheckDeferred`: the working directory has no real path and the row's
 *   `cwd` has none either or equals the configured path lexically. Callers
 *   skip the `cwd` condition for such a row rather than act on the lexical
 *   comparison (b.av2 SR-6.4); a row whose `cwd` resolves to an existing
 *   directory is compared as usual and so mismatches.
 * - `configDirResolved`: the persona's effective claude_config_dir has a real
 *   path (`resolveRealPathStrict`, no lexical fallback; bug b.g57).
 * - `configDirMatches`: the row's `config_dir` label is present and equals
 *   `personaConfigDirLabelValue(persona.claude_config_dir, home, configDirFs)`,
 *   the value the spawn writes; undefined when the directory is unresolvable.
 *
 * @param row          The row's `cwd` and `labels` (from `get` or `list`).
 * @param persona      The resolved persona.
 * @param home         Home directory for an unset claude_config_dir; defaults
 *   to the OS home, read at call time.
 * @param realpath     Realpath function; defaults to `fs.realpathSync`.
 * @param configDirFs  Realpath and lstat for the claude_config_dir; default
 *   `realpath` and the real `lstat`.
 */
export function compareRowToPersona(
  row: { cwd?: string; labels?: Record<string, string> },
  persona: Pick<Persona, 'working_directory' | 'claude_config_dir'>,
  home: string = homedir(),
  realpath: (path: string) => string = realpathSync,
  configDirFs: Partial<StrictRealPathFs> = { realpath },
): RowPersonaComparison {
  const workingDirectory = tryResolveRealPath(persona.working_directory, realpath)
  const configuredLexical = resolvePath(persona.working_directory)
  const rowCwdReal = row.cwd ? tryResolveRealPath(row.cwd, realpath) : undefined
  const cwdMatches = !!row.cwd && (rowCwdReal ?? resolvePath(row.cwd)) === (workingDirectory ?? configuredLexical)
  const cwdCheckDeferred =
    workingDirectory === undefined &&
    (rowCwdReal === undefined || resolvePath(row.cwd!) === configuredLexical)
  const configDirLabel = row.labels?.[CONFIG_DIR_LABEL_KEY]
  const expected = strictConfigDirLabel(persona.claude_config_dir, home, configDirFs)
  const expectedConfigDirLabel = 'label' in expected ? expected.label : undefined
  return {
    cwdMatches,
    workingDirectoryResolved: workingDirectory !== undefined,
    cwdCheckDeferred,
    configDirResolved: expectedConfigDirLabel !== undefined,
    configDirMatches:
      expectedConfigDirLabel === undefined ? undefined : configDirLabel !== undefined && configDirLabel === expectedConfigDirLabel,
    configDirLabel,
    expectedConfigDirLabel,
  }
}

// ---------------------------------------------------------------------------
// Persona notices — spawn failure, restart cap, transcript loss (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

/**
 * The one sink every session-manager notice goes through. Production installs
 * the per-persona notifier's `notify` (`src/persona-notifier.ts`), which
 * posts to the persona's destination under its identity, adds the persona
 * reference, holds a notice until the persona's client is validated, and
 * logs instead of posting in dry run.
 */
let noticeSink: PersonaNotify | undefined

/**
 * Install the notice sink, or clear it by passing undefined. With no sink
 * installed (unit tests, the integration driver) a notice is logged, never
 * posted, and never throws.
 */
export function setSessionNotifier(notify: PersonaNotify | undefined): void {
  noticeSink = notify
}

/** Send one notice body for persona `key` through the installed sink. Never throws. */
function sendPersonaNotice(key: string, text: string, options?: PersonaNoticeOptions): void {
  if (!noticeSink) {
    console.error(`[slack] session-manager: no notifier installed — notice for ${keyRef(key)} not posted: ${firstNoticeLine(text)}`)
    return
  }
  notifySafely(noticeSink, key, text, options, (err) => {
    console.error(`[slack] session-manager: notifier failed for ${keyRef(key)}: ${describeThrownValue(err)}`)
  })
}

/**
 * The error label of a spawn-failure notice: the typed error's `errName` when
 * it is a short identifier, else `describeThrownValue` of the error without
 * its `message="…"` field (which holds the description, prefixed by the
 * unchecked `errName`). The notice shows the description itself, once,
 * after the label.
 */
function spawnFailureLabel(error: AgentDirectorError): string {
  if (isSafeIdentifier(error.errName)) return error.errName
  const described = describeThrownValue(error)
  const message = describeLogMessage(error.message)
  return message === '' ? described : described.replace(` ${message}`, '')
}

/**
 * Raise a spawn-failure notice for persona `key`: the error name, the
 * description (through `redactSlackLogText`, cut to
 * `MAX_LOGGED_MESSAGE_LENGTH` characters) and a remediation hint. When a
 * startup notice's post fails, the `spawn-failure-post` startup error is
 * recorded; outside startup the failure is logged.
 */
export function notifySpawnFailure(key: string, error: AgentDirectorError, isStartup = true): void {
  const ref = keyRef(key)
  const text =
    `Spawn failure:\n` +
    `  Error: \`${spawnFailureLabel(error)}\` — ${redactSlackLogText(error.errDescription ?? '').slice(0, MAX_LOGGED_MESSAGE_LENGTH)}\n` +
    `  Remediation: ${remediationHint(error)}`
  sendPersonaNotice(key, text, {
    onPostFailure: (failure) => {
      // Token-safe cause: a Slack rejection can carry secrets, so only the
      // describer's output (type, code, redacted message, frames) reaches
      // stderr and the log file.
      // A failed DM open names the step and its code.
      const cause = describeDestinationFailureCause(failure)
      if (isStartup) {
        recordStartupError('spawn-failure-post', `failed to post spawn failure for ${ref}`, cause)
      } else {
        console.error(`[slack] spawn-failure-post: failed to post spawn failure for ${ref}: ${cause}`)
      }
    },
  })
}

/**
 * Raise the restart-cap notice for persona `key` (restart.ts `onCapReached`):
 * a non-startup spawn-failure notice carrying `ErrSpawnCapReached`, whose
 * remediation says automatic restarts are suspended for this persona.
 */
export function notifyRestartCapReached(key: string): void {
  const err = new ErrSpawnCapReached(
    `${RESTART_FAILURE_CAP} consecutive session-launch failures — automatic restarts suspended`,
  )
  notifySpawnFailure(key, err, false)
}

/** The result a launch or recovery site answers for a refusal: `failed`, which `markRefusal` marks refused when the timer was armed. */
type RefusedSiteResult = { key: string; action: 'failed' }

/** A site's latched result (b.jg5 SRJ-502): the persona latched, and nothing more is called for it. */
type LatchedSiteResult = { key: string; action: 'latched' }

/**
 * b.jg5 SRJ-105, SRJ-311, SRJ-313, SRJ-316: the one handling of a refusal at
 * the launch and recovery sites. `err` was thrown by an agent-director call
 * made with `verb` for persona `key`. It is a refusal when the arming
 * predicate (`unavailableRetryCauseFor`, which classifies by name through
 * `src/ad-error-class.ts`) answers a cause for it: UNAVAILABLE from any verb
 * (`ErrTmuxKillFailed` included), ENVIRONMENT (`ErrTmuxNotAvailable`) from
 * any verb (`kill` included: nothing is killed, deleted or respawned because
 * of it), CONFIG (`ErrConfigMalformed`) from any verb (SRJ-105's CONFIG row:
 * no action, nothing counted, never 'dead'; the wrapper has already raised
 * the `ad-config-malformed` outage), UNCLASSIFIED from any verb (SRJ-105's
 * UNCLASSIFIED row and SRJ-110, SRJ-111, SRJ-113: "No step follows"; an
 * `ErrInternal` other than an unusable recorded name, a store-open name,
 * `ErrSystemInstallDisappeared`, whose wrapper has raised `ad-unreachable`,
 * or any name CSCB gives no handling; the reporting point has reported it to
 * the persona's unclassified-error episode), and from a `status`, `get` or
 * `list` any error but `ErrSpawnNotFound` and an UNUSABLE NAME answer.
 * The same rule arms the retry timer, so the site's decision and the arming
 * decision cannot drift apart.
 *
 * For a refusal it logs one line (`site` is the log prefix, `what` names the
 * call) and answers `{ key, action: 'failed' }`: no spawn-failure notice, no
 * `spawn-failed` startup-errors entry, and the caller calls nothing more.
 * The refusal marker is left to `markRefusal`, which adds it only when the
 * attempt's last error armed a timer. Answers `undefined` for any other
 * value, which the site handles as before. Never throws.
 */
function refusalAt(
  key: string,
  err: unknown,
  verb: AdVerb,
  site: string,
  what: string,
  ref: string,
): RefusedSiteResult | undefined {
  if (unavailableRetryCauseFor(err, verb) === undefined) return undefined
  logRefusal(site, what, ref, describeAgentDirectorFailure(err))
  return { key, action: 'failed' }
}

/** The one refusal line (b.jg5 SRJ-105): `described` is a redacting describer's output, never the error. */
function logRefusal(site: string, what: string, ref: string, described: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${described} — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`,
  )
}

// ---------------------------------------------------------------------------
// The latch (b.jg5 SRJ-501, SRJ-502)
// ---------------------------------------------------------------------------

/**
 * What the session manager uses of the server's one latch
 * (`src/conflict-latch.ts`): `set` for a latching own-row read
 * (`readPersonaOwnRow`, `applyOwnRowStatusStep`; a launch start not recorded
 * with `launchStartNotRecordedSetInput`'s input) and for an UNUSABLE NAME
 * answer (with `unusableNameSetInput`'s input, `latchOnUnusableName`),
 * `setFromConflict` for a CONFLICT answer; and, when the latch has it,
 * `addSetObserver`, through which the installer stops a latched persona's
 * running dialog approver (`setConflictLatch`, b.jg5 SRJ-502).
 */
export type SessionConflictLatch = Pick<ConflictLatch, 'isLatched' | 'record' | 'set' | 'setFromConflict'> &
  Partial<Pick<ConflictLatch, 'addSetObserver'>>

/**
 * The installed latch. Production installs the server's one latch
 * (`createConflictLatch`, built in `main()`) before the start pass. With none
 * installed (unit tests, the integration driver) no persona is latched, so no
 * launch is held back, and a CONFLICT at a ladder spawn or resume still takes
 * the CONFLICT row's no-action path and answers `latched` (`conflictAt`), as
 * does a CONFLICT at the shared read-pane (`readPersonaOwnPane`), an
 * UNUSABLE NAME answer at any site that latches on it
 * (`unusableNameAt`, `readPersonaOwnRow`, `applyOwnRowStatusStep`,
 * `readPersonaOwnPane`), and a latch decision of the row-read rule at an
 * own-row read (`readPersonaOwnRow`, `applyOwnRowStatusStep`: a `pending`
 * row with no launch start, or a latching note) when a configured-persona
 * query counts the key.
 */
let conflictLatch: SessionConflictLatch | undefined

/** Removes the approver-stop set observer from the installed latch; undefined while none is registered. */
let removeApproverLatchObserver: (() => void) | undefined

/**
 * Install the server's latch (production: `main()`; the recovery harness
 * installs its own the same way), or remove it with undefined. The installer
 * registers one set observer on a latch that has `addSetObserver`
 * (`stopApproverOnLatch`, b.jg5 SRJ-502): every set of a persona, a relatch
 * and a same-case set included, stops that persona's running dialog approver
 * with the reason `latched`. The observer registered on a latch installed
 * before is removed first, so exactly one is registered, on the installed
 * latch only. When a live-row sequence registry is installed too
 * (`setLiveRowSequenceRegistry`), a second set observer stops the persona's
 * running live-row sequence with the latch reason (`stopSequenceOnLatch`,
 * SRJ-502, SRJ-706), registered once on the installed latch, whichever of
 * the two is installed second.
 */
export function setConflictLatch(latch: SessionConflictLatch | undefined): void {
  removeApproverLatchObserver?.()
  removeApproverLatchObserver = undefined
  conflictLatch = latch
  if (latch?.addSetObserver !== undefined) removeApproverLatchObserver = latch.addSetObserver(stopApproverOnLatch)
  syncSequenceLatchObserver()
}

/**
 * The latch's set observer the installer registers (`setConflictLatch`,
 * b.jg5 SRJ-502): stops persona `event.key`'s running dialog approver with
 * the reason `latched` through the stop entry (`stopDialogApprover`). The
 * approver is marked stopped synchronously, inside this call, so no approver
 * call for the persona starts after the latch's `set` returns, whatever order
 * the observers run in; a call already in progress returns first, and the
 * approver makes none after it. Does nothing when no approver runs for the
 * persona, and nothing more when its approver was already stopping (its own
 * CONFLICT or UNUSABLE NAME answer marks it before it latches). Returns
 * nothing to await; never throws.
 */
function stopApproverOnLatch(event: ConflictLatchSetEvent): void {
  void stopDialogApprover(event.key, APPROVER_STOP_LATCHED)
}

/** The case the latched gate logs when it cannot read the persona's latch record. */
const LATCH_CASE_UNKNOWN = 'unknown'

/**
 * What the latched gate (`spawnForPersona`, b.jg5 SRJ-502) read of persona
 * `key`'s latch: `undefined` when no latch is installed or the latch answers
 * not latched; otherwise the case to log (the record's, or
 * `LATCH_CASE_UNKNOWN` when the record cannot be read) and, when a latch
 * query threw, `describeThrownValue` of what it threw.
 */
interface LatchGateReading {
  readonly latchCase: string
  readonly failure?: string
}

/**
 * Read persona `key`'s latch for the latched gate (`LatchGateReading`). Fails
 * safe: an `isLatched` that throws counts as latched (case unknown), and so
 * does a latched persona whose `record` throws or answers nothing. Logs
 * nothing (the gate logs one line); never throws.
 */
function latchGateReadingOf(key: string): LatchGateReading | undefined {
  const latch = conflictLatch
  if (latch === undefined) return undefined
  let latched: boolean
  try {
    latched = latch.isLatched(key) === true
  } catch (err) {
    return { latchCase: LATCH_CASE_UNKNOWN, failure: `the latched query failed: ${describeThrownValue(err)}` }
  }
  if (!latched) return undefined
  try {
    const record: ConflictLatchRecord | undefined = latch.record(key)
    return { latchCase: record?.latchCase ?? LATCH_CASE_UNKNOWN }
  } catch (err) {
    return { latchCase: LATCH_CASE_UNKNOWN, failure: `its latch record could not be read: ${describeThrownValue(err)}` }
  }
}

/**
 * The row state a launch site last read before its refused call (b.jg5
 * SRJ-501): the state read, or no row (the read answered `ErrSpawnNotFound`).
 * `NOTHING_READ` when the path read nothing before it (the first spawn):
 * the CONFLICT row then makes the one latch-time
 * `status` read (`latchTimeRowState`). A state is never re-read after a
 * write the path made since (a delete, a kill, a sweep): only the last read
 * counts.
 */
type LastRowRead = LatchRowState | typeof NOTHING_READ

/** The path read nothing of the row before its refused call (`LastRowRead`). */
const NOTHING_READ = undefined

/**
 * What the latch-time `status` read gave (`latchTimeRowState`): the row
 * state to record, or `latched` when the persona is latched once the read is
 * done (the read itself latched it, or it latched elsewhere meanwhile), with
 * the latch line's outcome text saying which.
 */
type LatchTimeRead = { readonly rowState: LatchRowState } | { readonly latched: true; readonly outcome: string }

/**
 * The latch-time `status` read (b.jg5 SRJ-501), for a CONFLICT or an
 * UNUSABLE NAME at a site whose path read nothing before the refused call:
 * one read of persona `key`'s row through the shared own-row `status` read
 * (`readPersonaOwnRowStatus`), inside the launch attempt (so its UNAVAILABLE
 * or read error arms the persona's retry timer and its UNCLASSIFIED answer
 * opens the unclassified-error episode, which the latch's holds then stop
 * and end). The state read; no row for `ErrSpawnNotFound`; unreadable for
 * any other error, which counts as live. A read that itself latched the
 * persona (its own UNUSABLE NAME answer, recorded unreadable, or its own
 * row-read rule: the persona's own row reading `pending` with no launch
 * start, b.jg5 SRJ-513) answers `latched`: that latch stands alone, the
 * caller sets nothing more (no CONFLICT or UNUSABLE NAME case on top, so
 * the persona gets that latch's one post, SRJ-1020's for a launch start not
 * recorded), and no further read is made. A persona latched elsewhere while
 * the read was awaited (`personaLatchedNow`, b.jg5 SRJ-502: the health
 * tick reads even while a launch is in flight, SRJ-315) answers `latched`
 * the same way, whatever the read gave: that latch stands, and no second
 * case or post is set on top of it. `site` names the path that met the
 * refusal in the read's own lines. Logs nothing of its own; never throws.
 */
async function latchTimeRowState(key: string, site: string): Promise<LatchTimeRead> {
  const read = await readPersonaOwnRowStatus(key, { site, what: 'latch-time status read' })
  if (read.kind === OWN_ROW_STATUS_LATCHED) return { latched: true, outcome: LATCH_TIME_READ_LATCHED }
  if (personaLatchedNow(key)) return { latched: true, outcome: LATCH_TIME_READ_LATCHED_ELSEWHERE }
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return { rowState: latchRowStateRead(read.state) }
    case OWN_ROW_STATUS_ABSENT:
      return { rowState: LATCH_ROW_STATE_NO_ROW }
    case OWN_ROW_STATUS_REFUSED:
      return { rowState: LATCH_ROW_STATE_UNREADABLE }
  }
}

/**
 * The row state to record for a latch met by a call whose path last read
 * `lastRead`: `lastRead` itself, or, when the path read nothing
 * (`NOTHING_READ`), the one latch-time `status` read (`latchTimeRowState`),
 * its lines prefixed `site`.
 */
async function recordedRowState(key: string, lastRead: LastRowRead, site: string): Promise<LatchTimeRead> {
  return lastRead === NOTHING_READ ? latchTimeRowState(key, site) : { rowState: lastRead }
}

/** The latch line's outcome when the latch-time `status` read latched the persona itself. */
const LATCH_TIME_READ_LATCHED = 'the latch-time status read latched the persona, so that latch stands'

/** The latch line's outcome when the persona latched elsewhere while the latch-time `status` read was awaited. */
const LATCH_TIME_READ_LATCHED_ELSEWHERE =
  'the persona was latched elsewhere during the latch-time status read, so that latch stands'

/**
 * b.jg5 SRJ-105, SRJ-501, SRJ-111, SRJ-113: the CONFLICT row of the ladder's
 * refusal handling, at every spawn and `resume` the collision ladder makes
 * and at the reuse spawn (SRJ-112). `err` was thrown by that call for persona `key`. It is the row's only when
 * the classifier (`classifyAdError`, by name) answers CONFLICT
 * (`ErrTmuxSessionConflict`); for any other value it answers `undefined`
 * and the site goes on as before.
 *
 * For a CONFLICT it latches the persona through the installed latch's
 * `setFromConflict` with
 * `operation` (a plain spawn, a `resume` or the reuse spawn) and the row
 * state: `lastRead`,
 * the state the path last read before the refused call, or, when it read
 * nothing (`NOTHING_READ`), exactly one latch-time `status` read
 * (`latchTimeRowState`; when that read latched the persona itself, its latch
 * stands and nothing more is set). The latch's set observers then run, holds
 * before the notice (`main()`). Then it logs one line (`what` names the
 * call) saying the persona latched, or, when `setFromConflict` threw, that
 * latching it failed and what it threw. It answers `latched`: no
 * spawn-failure notice, no `spawn-failed` entry, nothing counted, and the
 * caller kills, deletes and launches nothing more. With no latch installed
 * it makes no read, sets nothing, logs the one line saying so, and still
 * answers `latched`. `site` is the line's prefix (default `spawnForPersona`).
 * Never throws.
 */
async function conflictAt(
  key: string,
  err: unknown,
  operation: RefusedOperation,
  lastRead: LastRowRead,
  what: string,
  ref: string,
  site = 'spawnForPersona',
): Promise<SpawnPersonaResult | undefined> {
  if (classifyAdError(err).errorClass !== AD_ERROR_CLASS_CONFLICT) return undefined
  const latch = conflictLatch
  if (latch === undefined) {
    logConflict(site, what, ref, err, LATCH_OUTCOME_NO_LATCH)
    return { key, action: 'latched' }
  }
  const recorded = await recordedRowState(key, lastRead, site)
  if ('latched' in recorded) {
    logConflict(site, what, ref, err, recorded.outcome)
    return { key, action: 'latched' }
  }
  const { rowState } = recorded
  try {
    latch.setFromConflict(key, err, { refusedOperation: operation, rowState })
  } catch (setErr) {
    logConflict(site, what, ref, err, `latching the persona failed: ${describeThrownValue(setErr)}`)
    return { key, action: 'latched' }
  }
  logConflict(site, what, ref, err, 'the persona latched')
  return { key, action: 'latched' }
}

/**
 * `conflictAt`'s one line for a CONFLICT at `what` for `ref`, with `outcome`
 * (what became of the latch), logged once the latch is set or has failed.
 */
function logConflict(site: string, what: string, ref: string, err: unknown, outcome: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${describeAgentDirectorFailure(err)} — CONFLICT: ${outcome}; ` +
      `no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)`,
  )
}

/** The latch line's outcome with no latch installed. */
const LATCH_OUTCOME_NO_LATCH = 'no latch is installed, so nothing is latched'

/**
 * Latch persona `key` on the thrown UNUSABLE NAME `err` (b.jg5 SRJ-501,
 * SRJ-512): the installed latch's `set` with `unusableNameSetInput`'s input
 * (the case "unusable recorded name", the refused operation "none",
 * `rowState`, the classification's message as the description and the
 * session quoted in it). The latch's set observers then run, holds before
 * the notice (`main()`), and the notice reaction posts SRJ-1019 once per
 * episode. Answers the latch line's outcome text: the set's outcome
 * (`LATCH_SET_OUTCOME_TEXT`), `LATCH_OUTCOME_NO_LATCH` with no latch
 * installed, or that latching failed and what it threw. Logs nothing; never
 * throws.
 */
function latchOnUnusableName(key: string, err: unknown, rowState: LatchRowState): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    const input = unusableNameSetInput(key, err, rowState)
    // Not reached: every caller has checked `isUnusableNameError`.
    if (input === undefined) return 'nothing is latched (the answer is not UNUSABLE NAME)'
    return LATCH_SET_OUTCOME_TEXT[latch.set(key, input)] ?? 'the persona latched'
  } catch (setErr) {
    return `latching the persona failed: ${describeThrownValue(setErr)}`
  }
}

/**
 * The one line for an UNUSABLE NAME answer at `what` for `ref` (b.jg5
 * SRJ-105, SRJ-512), with `outcome` (what became of the latch). The answer
 * is rendered by the redacting describer, never raw.
 */
function logUnusableName(site: string, what: string, ref: string, err: unknown, outcome: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME: ${outcome}; ` +
      `no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-512)`,
  )
}

/**
 * b.jg5 SRJ-105, SRJ-501, SRJ-512: the UNUSABLE NAME row of the ladder's
 * refusal handling, at every spawn and `resume` the collision ladder makes
 * (its reuse spawns included) and at a kill of the restart path or the
 * live-row sequence (`latchOnKillOutcomeAt`). `err` was thrown
 * by that call for persona `key`. It is the row's only when
 * `isUnusableNameError` (the classifier, by name) answers true; for any
 * other value it answers `undefined` and the site goes on as before (every
 * other `ErrInternal` is UNCLASSIFIED, SRJ-313).
 *
 * For an UNUSABLE NAME it latches the persona (`latchOnUnusableName`) with
 * the row state `lastRead`, the state the path last read before the call,
 * or, when it read nothing (`NOTHING_READ`), exactly one latch-time `status`
 * read (`latchTimeRowState`; when that read latched the persona itself, its
 * latch stands and nothing more is set). It logs one line (`site` and
 * `what` name the call) and answers `latched`: no spawn-failure notice, no
 * `spawn-failed` entry, nothing counted (the answer arms no retry timer), and
 * the caller kills, deletes, launches and reuses nothing more, so no
 * tmux-touching call follows (SRJ-502). With no latch installed it makes no
 * read, sets nothing, logs the one line saying so, and still answers
 * `latched`. Never throws.
 */
async function unusableNameAt(
  key: string,
  err: unknown,
  lastRead: LastRowRead,
  site: string,
  what: string,
  ref: string,
): Promise<LatchedSiteResult | undefined> {
  if (!isUnusableNameError(err)) return undefined
  if (conflictLatch === undefined) {
    logUnusableName(site, what, ref, err, LATCH_OUTCOME_NO_LATCH)
    return { key, action: 'latched' }
  }
  const recorded = await recordedRowState(key, lastRead, site)
  logUnusableName(
    site,
    what,
    ref,
    err,
    'latched' in recorded ? recorded.outcome : latchOnUnusableName(key, err, recorded.rowState),
  )
  return { key, action: 'latched' }
}

/**
 * The refusal handling of a spawn or `resume` the collision ladder makes
 * (b.jg5 SRJ-105): the CONFLICT row first (`conflictAt`, which latches the
 * persona and answers `latched`, with the refused operation "plain spawn"
 * for a spawn and "resume" for a resume, and `lastRead` as its row state),
 * then the UNUSABLE NAME row (`unusableNameAt`, which latches it with the
 * refused operation "none" and answers `latched`), then the refusal rows
 * (`refusalAt`, which answers `failed`). `undefined` for any other value,
 * which the site handles as before. Never throws.
 */
async function launchRefusalAt(
  key: string,
  err: unknown,
  verb: 'spawn' | 'resume',
  what: string,
  ref: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult | undefined> {
  const operation = verb === 'resume' ? REFUSED_OPERATION_RESUME : REFUSED_OPERATION_PLAIN_SPAWN
  return (
    (await conflictAt(key, err, operation, lastRead, what, ref)) ??
    (await unusableNameAt(key, err, lastRead, 'spawnForPersona', what, ref)) ??
    refusalAt(key, err, verb, 'spawnForPersona', what, ref)
  )
}

// ---------------------------------------------------------------------------
// Reads of a persona's own row (b.jg5 SRJ-114)
// ---------------------------------------------------------------------------

/** Whether a key is a persona of the applied configuration now. */
export type ConfiguredPersonaQuery = (key: string) => boolean

/**
 * The installed configured-persona query. Production installs one in
 * `main()` that reads the applied configuration at each call, so a persona an
 * apply adds or removes counts, or stops counting, at once. With none
 * installed (unit tests, the integration driver) no key counts as
 * configured, so no row read latches anyone by the row-read rule
 * (`readPersonaOwnRow`, `applyOwnRowStatusStep`).
 */
let configuredPersonaQuery: ConfiguredPersonaQuery | undefined

/** Install the configured-persona query (production: `main()`), or remove it with undefined. */
export function setConfiguredPersonaQuery(query: ConfiguredPersonaQuery | undefined): void {
  configuredPersonaQuery = query
}

/** Test-only seam: remove any installed configured-persona query. */
export function _resetConfiguredPersonaQuery(): void {
  configuredPersonaQuery = undefined
}

/**
 * The installed kill-failure alerts (b.jg5 SRJ-704, SRJ-1016;
 * `createKillFailureAlerts`, `src/persona-episodes.ts`). Production installs
 * `main()`'s, built over its notice episodes. The persona kills' alert
 * (`raisePersonaKillFailureAlert`) raises through it, and every own-row read
 * that reads the row `ended` or `missing`, or finds it gone, ends the
 * persona's kill-failure episode through it (`endKillFailureEpisodeOnRead`):
 * on the replacing path these are the collision ladder's `get` and the
 * live-row sequence's `get`s and between-try `status` reads, so a row seen
 * gone there ends the episode. With none installed (unit tests, the
 * integration driver) an alert is written as one log line only, and no
 * episode is ended.
 */
let killFailureAlerts: KillFailureAlerts | undefined

/** Install the kill-failure alerts (production: `main()`), or remove them with undefined. */
export function setKillFailureAlerts(alerts: KillFailureAlerts | undefined): void {
  killFailureAlerts = alerts
}

/** End persona `key`'s kill-failure episode for `reason` through the installed alerts. Never throws. */
function endKillFailureEpisode(key: string, reason: KillFailureEndReason): void {
  try {
    killFailureAlerts?.end(key, reason)
  } catch (err) {
    console.error(`[slack] kill-failure episode end for ${keyRef(key)} failed: ${describeThrownValue(err)}`)
  }
}

/**
 * The kill-failure episode's end at a read of persona `key`'s own row
 * (b.jg5 SRJ-704, SRJ-1016): a row read `ended` or `missing`
 * (`AGENT_DIRECTOR_DEAD_STATES`), or an answer of `ErrSpawnNotFound` (by
 * name: the row is gone), ends the persona's open episode silently. No other
 * answer ends it: not a live state, not `ErrSystemInstallDisappeared` (which
 * reads no row), and no kill's success. Never throws.
 */
function endKillFailureEpisodeOnRead(key: string, answer: { readonly state: unknown } | { readonly thrown: unknown }): void {
  if ('thrown' in answer) {
    if (hasAdErrorName(answer.thrown, ERR_SPAWN_NOT_FOUND_NAME)) endKillFailureEpisode(key, KILL_FAILURE_END_ROW_GONE)
    return
  }
  if (typeof answer.state === 'string' && AGENT_DIRECTOR_DEAD_STATES.has(answer.state)) {
    endKillFailureEpisode(key, KILL_FAILURE_END_ROW_FINISHED)
  }
}

/** `readPersonaOwnRow` read the row: `latched` is true when this read latched the persona. */
export const OWN_ROW_READ_ROW = 'row'
/** `readPersonaOwnRow`'s `get` answered `ErrSpawnNotFound`: the row is absent. */
export const OWN_ROW_READ_ABSENT = 'absent'
/** `readPersonaOwnRow`'s `get` failed with any other error but UNUSABLE NAME, carried unchanged. */
export const OWN_ROW_READ_REFUSED = 'refused'
/** `readPersonaOwnRow`'s `get` answered UNUSABLE NAME: the persona latched (b.jg5 SRJ-512), and there is no row to act on. */
export const OWN_ROW_READ_LATCHED = 'latched'

/** What one read of a persona's own row answers (`readPersonaOwnRow`). */
export type OwnRowRead =
  | { readonly kind: typeof OWN_ROW_READ_ROW; readonly row: GetResult; readonly latched: boolean }
  | { readonly kind: typeof OWN_ROW_READ_ABSENT }
  | { readonly kind: typeof OWN_ROW_READ_REFUSED; readonly error: unknown }
  | { readonly kind: typeof OWN_ROW_READ_LATCHED }

/** Who reads, for `readPersonaOwnRow`'s log lines: `[slack] <site>: <what> for <ref>: …`. */
export interface OwnRowReadSite {
  readonly site: string
  readonly what: string
  /** The persona's reference; `persona=<key>` when absent. */
  readonly ref?: string
  /**
   * Set for a `get` made in a context that routes an UNUSABLE NAME answer
   * per SRJ-1002 instead of latching (b.jg5 SRJ-512): the start sweep's
   * post-run `get`s. Names the context in the routed line
   * (`readPersonaOwnRow`). The row-read rule still applies to a row read.
   */
  readonly unusableNameRoutedIn?: string
}

/**
 * The one read of persona `key`'s own row (`cscb_<key>`) at SRJ-114's sites
 * (b.jg5 SRJ-114): one `get` through `withOutageDetection`, then the
 * row-read rule (`decideOwnRowRead`, `src/row-read-rules.ts`). Answers:
 *
 *   - `row`, with `latched` true when this read latched the persona: the row
 *     is `key`'s own, `key` is configured (the installed
 *     `ConfiguredPersonaQuery`), and either
 *       - the row reads `pending` with no launch start (b.jg5 SRJ-513;
 *         absent, `null` or unparseable, `src/pending-row.ts`), whatever its
 *         `cwd`, `config_dir` or note: the persona latches with the case
 *         "launch start not recorded", the refused operation "none", the
 *         state `pending`, the session `slack_bot_<key>` and no description
 *         (`launchStartNotRecordedSetInput`), and the notice reaction posts
 *         SRJ-1020 once per episode; or
 *       - the row's `liveness_note` is exactly `provenance_conflict`: the
 *         persona latches with the case "conflicting labels", the refused
 *         operation "P's bring-up", the row's state as this `get` read it,
 *         the session `slack_bot_<key>` and no description (b.jg5 SRJ-501),
 *         and the notice reaction posts the CONFLICT notice once per episode
 *         (b.jg5 SRJ-1004).
 *     The latch's set observers stop its timers and post, and nothing else
 *     is posted here. The caller then calls nothing more for the persona
 *     (b.jg5 SRJ-502). With no latch installed, or a `set` that throws,
 *     nothing is latched and `latched` is still true, as at the CONFLICT row
 *     (`conflictAt`). Every other note, an unknown note, no note, a `pending`
 *     row with a launch start, or either on a row that is not a configured
 *     persona's own changes nothing (C14, C24; b.jg5 SRJ-408);
 *   - `absent` for `ErrSpawnNotFound` (recognised by name);
 *   - `latched` for an UNUSABLE NAME answer (b.jg5 SRJ-105, SRJ-512): the
 *     persona latches with the case "unusable recorded name", the refused
 *     operation "none" and the state unreadable, since this read, the
 *     path's last, read none (`latchOnUnusableName`; no further read), and
 *     the caller calls nothing more for it, as after a read that latched;
 *     with no latch installed nothing is latched and the answer is the same.
 *     Where the answer is routed per SRJ-1002 (`at.unusableNameRoutedIn`:
 *     the start sweep's post-run `get`s) nothing latches: the routed line
 *     is logged and the answer is `refused`, carrying the error;
 *   - `refused` for any other error, carried unchanged for the caller's
 *     refusal handling (`refusalAt`, b.jg5 SRJ-105) or its own row.
 *
 * A row read `ended` or `missing`, or `ErrSpawnNotFound`, also ends the
 * persona's kill-failure episode silently (`endKillFailureEpisodeOnRead`;
 * b.jg5 SRJ-704, SRJ-1016).
 *
 * Log lines (no line carries a token: the note and the instance id are
 * agent-director's text, rendered by `renderLogMessageText`, and an
 * UNUSABLE NAME answer by the redacting describer):
 *
 *   [slack] <site>: <what> for <ref>: its row reads pending with no launch start (state=pending) — <outcome>; nothing more is called for it (b.jg5 SRJ-114, SRJ-513)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note provenance_conflict (state=<state>) — <outcome>; nothing more is called for it (b.jg5 SRJ-114, SRJ-501)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME met in <context>: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note provenance_conflict, but <why> — the note is not applied (b.jg5 SRJ-114)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note "<note>", which latches no one — going on (b.jg5 SRJ-114)
 *
 * where `<outcome>` is `the persona latched`, `the persona relatched`, `the
 * persona was already latched with this case`, `no latch is installed, so
 * nothing is latched` or `latching the persona failed: <error>`, and `<why>`
 * is `no configured-persona query is installed`, `the configured-persona
 * query failed: <error>`, `persona=<key> is not a persona of the applied
 * configuration` or `the row is not the persona's own
 * (claude_instance_id="<id>")`. A row with no note logs nothing. The
 * "latches no one" line is logged once per note for a persona and again only
 * when the note on its row changes (`nonLatchingNoteLogged`). Never throws.
 */
export async function readPersonaOwnRow(key: string, at: OwnRowReadSite): Promise<OwnRowRead> {
  let row: GetResult
  try {
    row = await withOutageDetection(key, undefined, 'get', (client) =>
      client.get({ claude_instance_id: personaInstanceId(key) }),
    )
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      // b.jg5 SRJ-704, SRJ-1016: the row is gone; the kill-failure episode ends.
      endKillFailureEpisodeOnRead(key, { thrown: err })
      return { kind: OWN_ROW_READ_ABSENT }
    }
    if (at.unusableNameRoutedIn !== undefined) {
      // b.jg5 SRJ-512, SRJ-1002: routed, so nothing latches; carried as a failed read.
      if (isUnusableNameError(err)) logUnusableNameRouted(key, at, at.unusableNameRoutedIn, err)
      return { kind: OWN_ROW_READ_REFUSED, error: err }
    }
    if (latchOnUnusableNameRead(key, err, at)) return { kind: OWN_ROW_READ_LATCHED }
    return { kind: OWN_ROW_READ_REFUSED, error: err }
  }
  // b.jg5 SRJ-704, SRJ-1016: a row read `ended` or `missing` ends the kill-failure episode.
  endKillFailureEpisodeOnRead(key, { state: row.state })
  try {
    return { kind: OWN_ROW_READ_ROW, row, latched: applyOwnRowRules(key, row, at) }
  } catch (err) {
    // Not reached (every step below is guarded); a throw reads the row with no latch.
    console.error(`${ownRowReadHead(key, at)}: applying the note rule failed: ${describeThrownValue(err)} (b.jg5 SRJ-114)`)
    return { kind: OWN_ROW_READ_ROW, row, latched: false }
  }
}

/**
 * The one line for an UNUSABLE NAME answer to a `get` made where it is
 * routed per SRJ-1002 (`OwnRowReadSite.unusableNameRoutedIn`, `context`):
 * a server-log line, nothing latched or posted (b.jg5 SRJ-512, SRJ-1002).
 * The answer through the redacting describer.
 *
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME met in <context>: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)
 */
function logUnusableNameRouted(key: string, at: OwnRowReadSite, context: string, err: unknown): void {
  console.error(
    `${ownRowReadHead(key, at)}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME met in ${context}: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)`,
  )
}

/** `[slack] <site>: <what> for <ref>`. */
function ownRowReadHead(key: string, at: OwnRowReadSite): string {
  return `[slack] ${at.site}: ${at.what} for ${at.ref ?? keyRef(key)}`
}

/**
 * The last non-latching liveness note logged for each persona's own row
 * (`applyOwnRowRules`): the "latches no one" line is logged once per note and
 * again only when the note on the persona's row changes. A read of the row
 * with no note or the latching note forgets it, so the note's return is
 * logged again. Forgotten with the persona's not-connected episode
 * (`forgetNotConnectedEpisode`, run when it is torn down) and by
 * `_resetNotConnectedEpisodes`.
 */
const nonLatchingNoteLogged = new Map<string, string>()

/**
 * The row-read rule on `row`, read for persona `key` (b.jg5 SRJ-114,
 * SRJ-513): asks `decideOwnRowRead` for every row read, latches the persona
 * on a latch decision (`latchFromRowRead`) with the line naming why
 * (`rowReadLatchReason`), and otherwise
 * logs the read's note line, if any (a non-latching note's line once per
 * note, `nonLatchingNoteLogged`). True when the read latched the persona (or
 * would have, with no latch installed or a `set` that threw). Never throws.
 */
function applyOwnRowRules(key: string, row: GetResult, at: OwnRowReadSite): boolean {
  const configured = configuredReadingOf(key)
  const decision = decideOwnRowRead({ key, row, configured: configured.configured })
  const note: unknown = row.liveness_note
  const hasNote = note !== undefined && note !== null && note !== ''
  if (!hasNote || isLatchingLivenessNote(note)) nonLatchingNoteLogged.delete(key)
  if (decision.latch !== undefined) {
    const outcome = latchFromRowRead(key, decision.latch)
    console.error(
      `${ownRowReadHead(key, at)}: ${rowReadLatchReason(decision.latch)} (state=${describeLatchRowState(decision.latch.rowState)}) — ${outcome}; nothing more is called for it (${rowReadLatchSrjs(decision.latch)})`,
    )
    return true
  }
  if (!hasNote) return false
  if (!isLatchingLivenessNote(note)) {
    const noteText = String(note)
    if (nonLatchingNoteLogged.get(key) !== noteText) {
      nonLatchingNoteLogged.set(key, noteText)
      console.error(
        `${ownRowReadHead(key, at)}: its row carries the liveness note ${JSON.stringify(renderLogMessageText(note))}, which latches no one — going on (b.jg5 SRJ-114)`,
      )
    }
    return false
  }
  const why = !isPersonaOwnRow(row, key)
    ? `the row is not the persona's own (claude_instance_id=${JSON.stringify(renderLogMessageText(row.claude_instance_id))})`
    : configured.why
  console.error(
    `${ownRowReadHead(key, at)}: its row carries the liveness note ${LATCHING_LIVENESS_NOTE}, but ${why} — the note is not applied (b.jg5 SRJ-114)`,
  )
  return false
}

/** Why a row read latched, for the shared `get` read's latch line. */
function rowReadLatchReason(latch: RowReadLatchDecision): string {
  return latch.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED
    ? 'its row reads pending with no launch start'
    : `its row carries the liveness note ${LATCHING_LIVENESS_NOTE}`
}

/** The requirements the shared `get` read's latch line names. */
function rowReadLatchSrjs(latch: RowReadLatchDecision): string {
  return latch.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED ? 'b.jg5 SRJ-114, SRJ-513' : 'b.jg5 SRJ-114, SRJ-501'
}

/**
 * Whether persona `key` counts as configured for the row-read rule, and, when
 * it does not, why (for the not-applied line). No query installed, or one
 * that throws, counts as not configured. Never throws.
 */
function configuredReadingOf(key: string): { configured: boolean; why: string } {
  const query = configuredPersonaQuery
  if (query === undefined) return { configured: false, why: 'no configured-persona query is installed' }
  try {
    return query(key) === true
      ? { configured: true, why: '' }
      : { configured: false, why: `${keyRef(key)} is not a persona of the applied configuration` }
  } catch (err) {
    return { configured: false, why: `the configured-persona query failed: ${describeThrownValue(err)}` }
  }
}

/** The latch line's outcome text for each set outcome. */
const LATCH_SET_OUTCOME_TEXT: Readonly<Record<ConflictLatchSetOutcome, string>> = Object.freeze({
  [CONFLICT_LATCH_SET_LATCHED]: 'the persona latched',
  [CONFLICT_LATCH_SET_RELATCHED]: 'the persona relatched',
  [CONFLICT_LATCH_SET_SAME_CASE]: 'the persona was already latched with this case',
})

/**
 * Latch persona `key` from a latch decision over one of its own row reads
 * (b.jg5 SRJ-501): the installed latch's `set`. For "launch start not
 * recorded" (b.jg5 SRJ-513) its input is the latch's own
 * (`launchStartNotRecordedSetInput`, with the decision's row state); for a
 * `provenance_conflict` note it is `decision`'s case, refused operation and
 * row state. Either way the session is `slack_bot_<key>` and there is no
 * description, so a CONFLICT notice has no "agent-director said" line
 * (b.jg5 SRJ-1004). A persona latched with another case relatches with this
 * one, and the notice reaction posts its one new post. Answers the latch
 * line's outcome text. Never throws.
 */
function latchFromRowRead(key: string, decision: RowReadLatchDecision): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    const outcome = latch.set(
      key,
      decision.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED
        ? launchStartNotRecordedSetInput(key, decision.rowState)
        : {
            latchCase: decision.latchCase,
            refusedOperation: decision.refusedOperation,
            rowState: decision.rowState,
            sessionName: personaTmuxSessionName(key),
          },
    )
    return LATCH_SET_OUTCOME_TEXT[outcome] ?? 'the persona latched'
  } catch (err) {
    return `latching the persona failed: ${describeThrownValue(err)}`
  }
}

/**
 * An own-row read's (`get` or `status`) thrown `err` for persona `key`
 * (b.jg5 SRJ-105, SRJ-512): when it is UNUSABLE NAME, latch the persona
 * (`latchOnUnusableName`) with the state unreadable, since the read that met
 * it read no state and no further read is made, log one line, and answer
 * true; false for any other value, with nothing done. Never throws.
 *
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 */
function latchOnUnusableNameRead(key: string, err: unknown, at: OwnRowReadSite): boolean {
  if (!isUnusableNameError(err)) return false
  logUnusableNameRead(key, at, err, latchOnUnusableName(key, err, LATCH_ROW_STATE_UNREADABLE))
  return true
}

/** `latchOnUnusableNameRead`'s one line, with `outcome` (what became of the latch); the answer through the redacting describer. */
function logUnusableNameRead(key: string, at: OwnRowReadSite, err: unknown, outcome: string): void {
  console.error(
    `${ownRowReadHead(key, at)}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME: ${outcome}; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)`,
  )
}

// ---------------------------------------------------------------------------
// The own-row `status` step and the shared own-row `status` read (b.jg5 SRJ-115)
// ---------------------------------------------------------------------------

/**
 * One `status` answer from persona P's own row, for the own-row `status`
 * step: the result it returned, or the value it threw. The result is the
 * one the client returned, passed whole: its `launch_started_at` (raw,
 * `src/ad-phase1-types.ts`) is what the launch-start decision reads, so a
 * caller that rebuilt the result from its `state` alone would make a
 * `pending` row with a launch start read as one with none.
 */
export type OwnRowStatusAnswer =
  | { readonly result: Phase1StatusResult }
  | { readonly thrown: unknown }

/**
 * The own-row `status` step (b.jg5 SRJ-105, SRJ-115, SRJ-512): the own-row
 * rules applied to one `status` answer from persona `key`'s own row
 * (`cscb_<key>`), whoever made the call (the shared own-row `status` read,
 * or an adapter's own call in `src/server.ts`). Answers whether it latched
 * the persona; never throws.
 *
 *   - A returned result: the row-read rule (`decideOwnRowRead`,
 *     `src/row-read-rules.ts`) over the result, as the persona's own row,
 *     with the installed configured-persona query (with none installed no
 *     decision latches). A latch decision latches the persona with the
 *     decision's case, refused operation and row state (`latchFromRowRead`)
 *     and logs one line. A configured persona's own row that reads
 *     `pending` with no launch start latches it with "launch start not
 *     recorded" and the state `pending` (b.jg5 SRJ-513; SRJ-1020 is posted
 *     once per episode), relatching a persona latched with another case. A
 *     `status` result carries no liveness note, so the note decision never
 *     latches here; every decision the rule gains applies here unchanged.
 *   - A thrown value: an UNUSABLE NAME answer (`isUnusableNameError`, by
 *     name) latches the persona with the state unreadable
 *     (`latchOnUnusableNameRead`: one line, no further read). Any other
 *     value, `ErrSpawnNotFound` included, is left to the caller.
 *   - Either way, first: a result reading `ended` or `missing`, or an
 *     `ErrSpawnNotFound` answer (the row is gone), ends the persona's
 *     kill-failure episode silently (`endKillFailureEpisodeOnRead`; b.jg5
 *     SRJ-704, SRJ-1016).
 *
 * With no latch installed a latching answer still answers true, with
 * nothing latched, as at the CONFLICT row. Log lines:
 *
 *   [slack] <site>: <what> for <ref>: its row read latches the persona (case=<case>, state=<state>) — <outcome>; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 */
export function applyOwnRowStatusStep(key: string, answer: OwnRowStatusAnswer, at: OwnRowReadSite): boolean {
  try {
    // b.jg5 SRJ-704, SRJ-1016: a row read `ended` or `missing`, or gone, ends
    // the persona's kill-failure episode, whoever made the call.
    endKillFailureEpisodeOnRead(key, 'thrown' in answer ? { thrown: answer.thrown } : { state: answer.result.state })
    if ('thrown' in answer) return latchOnUnusableNameRead(key, answer.thrown, at)
    const row = { ...answer.result, claude_instance_id: personaInstanceId(key) }
    const decision = decideOwnRowRead({ key, row, configured: configuredReadingOf(key).configured })
    if (decision.latch === undefined) return false
    const outcome = latchFromRowRead(key, decision.latch)
    console.error(
      `${ownRowReadHead(key, at)}: its row read latches the persona (case=${decision.latch.latchCase}, state=${describeLatchRowState(decision.latch.rowState)}) — ${outcome}; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
    )
    return true
  } catch (err) {
    // Not reached (every step above is guarded); a throw latches nothing.
    console.error(`${ownRowReadHead(key, at)}: applying the own-row rules failed: ${describeThrownValue(err)} (b.jg5 SRJ-115)`)
    return false
  }
}

/** `readPersonaOwnRowStatus` read a state. */
export const OWN_ROW_STATUS_STATE = 'state'
/** `readPersonaOwnRowStatus`'s `status` answered `ErrSpawnNotFound`: the row is absent. */
export const OWN_ROW_STATUS_ABSENT = 'absent'
/** `readPersonaOwnRowStatus`'s `status` failed with any other error that latched nothing, carried unchanged. */
export const OWN_ROW_STATUS_REFUSED = 'refused'
/** `readPersonaOwnRowStatus`'s answer latched the persona (`applyOwnRowStatusStep`). */
export const OWN_ROW_STATUS_LATCHED = 'latched'

/** What one shared own-row `status` read answers (`readPersonaOwnRowStatus`). */
export type OwnRowStatusRead =
  | { readonly kind: typeof OWN_ROW_STATUS_STATE; readonly state: string; readonly launchStartedAt?: string }
  | { readonly kind: typeof OWN_ROW_STATUS_ABSENT }
  | { readonly kind: typeof OWN_ROW_STATUS_REFUSED; readonly error: unknown }
  /** `rowState`: what the read gave, as a latch records it (unreadable for a thrown answer). */
  | { readonly kind: typeof OWN_ROW_STATUS_LATCHED; readonly rowState: LatchRowState }

/**
 * The shared own-row `status` read (b.jg5 SRJ-115): one `status` of persona
 * `key`'s own row (`cscb_<key>`) through `withOutageDetection` (so a
 * failure raises its outage flags and, inside a launch or recovery attempt,
 * arms the persona's retry timer), then the own-row `status` step
 * (`applyOwnRowStatusStep`). Answers:
 *
 *   - `latched` when the step latched the persona (an UNUSABLE NAME answer,
 *     recorded unreadable, or a latch decision of the row-read rule: the
 *     persona's own row reading `pending` with no launch start, recorded
 *     `pending`, b.jg5 SRJ-513), with the state as a latch records it; the
 *     caller calls nothing more for the persona (b.jg5 SRJ-502);
 *   - `state`, with the raw launch start a `pending` result shows
 *     (`pendingLaunchStartOf`; absent when not shown);
 *   - `absent` for `ErrSpawnNotFound` (recognised by name);
 *   - `refused` for any other error, carried unchanged for the site's own
 *     handling (`refusalAt`, b.jg5 SRJ-105, or its own rule).
 *
 * The session manager's own-row `status` sites read through it: the launch
 * wait's poll and timeout reads, the prompt rows' re-read after a sweep
 * (`reconcileAndReadRowState`), the retry timer's row read
 * (`readPersonaRowState`), the latch-time read (`latchTimeRowState`) and
 * the dialog approver's lap (`approvePreSessionDialogs`). Never throws.
 */
export async function readPersonaOwnRowStatus(key: string, at: OwnRowReadSite): Promise<OwnRowStatusRead> {
  // The result whole, so the step reads its launch start (b.jg5 SRJ-513).
  let result: Phase1StatusResult
  try {
    result = await withOutageDetection(key, undefined, 'status', (client) =>
      client.status({ claude_instance_id: personaInstanceId(key) }),
    )
  } catch (err) {
    if (applyOwnRowStatusStep(key, { thrown: err }, at)) return { kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE }
    return hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)
      ? { kind: OWN_ROW_STATUS_ABSENT }
      : { kind: OWN_ROW_STATUS_REFUSED, error: err }
  }
  if (applyOwnRowStatusStep(key, { result }, at)) {
    return { kind: OWN_ROW_STATUS_LATCHED, rowState: latchRowStateRead(result.state) }
  }
  const launchStartedAt = pendingLaunchStartOf(result)
  return launchStartedAt === undefined
    ? { kind: OWN_ROW_STATUS_STATE, state: result.state }
    : { kind: OWN_ROW_STATUS_STATE, state: result.state, launchStartedAt }
}

// ---------------------------------------------------------------------------
// The shared read-pane of a persona's own row (b.jg5 SRJ-117)
// ---------------------------------------------------------------------------

/** What `readPersonaOwnPane` is asked to read, and for whom. */
export interface PersonaPaneReadRequest {
  /** Trailing pane lines to read (`FULL_PANE_READ_LINES` at a full read). */
  readonly nLines: number
  /**
   * The row state the calling path last read (b.jg5 SRJ-501), which a latch
   * set on the read's CONFLICT or UNUSABLE NAME answer records.
   */
  readonly lastRead: LatchRowState
  /** A short site label, the head of the reader's latch line. */
  readonly site: string
}

/**
 * What `readPersonaOwnPane` answers: a pane-read outcome other than CONFLICT
 * or UNUSABLE NAME, which the reader always answers as `PANE_READ_LATCHED`
 * with the failure as its `cause`.
 */
export type OwnPaneReadOutcome = Exclude<PaneReadOutcome, PaneReadConflict | PaneReadUnusableName>

/**
 * The shared read-pane of persona `key`'s own row (`cscb_<key>`, b.jg5
 * SRJ-117): one `readPane` through `withOutageDetection`, declaring the
 * `read-pane` verb (tmux-touching: inside an attempt an UNAVAILABLE starts
 * `tmux-unresponsive` and a pane or GONE ends it, and ENVIRONMENT and CONFIG
 * raise their outages, all in the wrapper), with `claude_instance_id` and
 * `n_lines` only. Answers the read's outcome (`src/pane-read.ts`):
 *
 *   - a persona already latched (`personaLatchedNow`, b.jg5 SRJ-502) gets no
 *     call and answers latched with no cause;
 *   - a CONFLICT latches the persona through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and `request.lastRead` (b.jg5 SRJ-501), and answers latched
 *     with the CONFLICT as its cause;
 *   - an UNUSABLE NAME latches it through the unusable-name entry
 *     (`latchOnUnusableName`: refused operation "none", `request.lastRead`,
 *     b.jg5 SRJ-512), and answers latched with it as its cause;
 *   - an `ErrInvalidFlags`, to which `read-pane` gives no meaning, gets
 *     exactly one immediate version re-check (`classifyWithInvalidFlagsRecheck`,
 *     b.jg5 SRJ-104, SRJ-204) and then answers UNCLASSIFIED
 *     (`paneReadInvalidFlagsFailure`), carrying the stop mark
 *     `stopping: true` when the re-check decided that the server stops
 *     (b.jg5 SRJ-205; the caller then types nothing and calls nothing more
 *     for the persona);
 *   - every other outcome (a pane, GONE, absent, CONFIG, ENVIRONMENT,
 *     UNAVAILABLE, UNCLASSIFIED) is returned unchanged for the caller to
 *     handle.
 *
 * A pane it answers may be a single leftover's: with no session of the
 * row's current launch there and exactly one leftover of the persona,
 * agent-director answers the leftover's pane (b.jg5 SRJ-117, SRJ-613). The
 * reader treats it as no proof that the worker's own session is there, and
 * no caller acts on it alone: a pane leads at most to a deferral, no action,
 * a positive-idle fold or the reconnect. The backstop is the reconnect's
 * one `send-keys` (`reconnectMcpWithCause`), which on a live row that is not
 * `pending` answers CONFLICT "not this launch's session": CSCB then latches
 * P (b.jg5 SRJ-501) with nothing typed and never retries the refused
 * `send-keys` (SRJ-118, SRJ-505).
 *
 * With no latch installed a CONFLICT or UNUSABLE NAME still answers latched
 * with nothing latched, as the latch's entries do elsewhere (`conflictAt`,
 * `unusableNameAt`). The reader posts nothing and counts nothing, and makes
 * no further call after a latch. One line per latch it sets (no token: the
 * answer through the redacting describer):
 *
 *   [slack] <site>: pane read refused for persona=<key>: <failure> — CONFLICT: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-501)
 *   [slack] <site>: pane read refused for persona=<key>: <failure> — UNUSABLE NAME: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 *
 * Never throws.
 */
export async function readPersonaOwnPane(key: string, request: PersonaPaneReadRequest): Promise<OwnPaneReadOutcome> {
  if (personaLatchedNow(key)) return PANE_READ_NOT_READ_LATCHED
  let failure: PaneReadFailure
  try {
    const result = await withOutageDetection(key, undefined, 'read-pane', (client) =>
      client.readPane({ claude_instance_id: personaInstanceId(key), n_lines: request.nLines }),
    )
    return { kind: PANE_READ_PANE, pane: result.pane }
  } catch (err) {
    failure = isInvalidFlagsError(err) ? await paneReadInvalidFlagsFailure(key, request, err) : paneReadFailureOf(err)
  }
  if (failure.kind === PANE_READ_CONFLICT) {
    logPaneReadLatch(key, request, failure, latchOnConflict(key, failure.error, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, request.lastRead))
    return { kind: PANE_READ_LATCHED, cause: failure }
  }
  if (failure.kind === PANE_READ_UNUSABLE_NAME) {
    logPaneReadLatch(key, request, failure, latchOnUnusableName(key, failure.error, request.lastRead))
    return { kind: PANE_READ_LATCHED, cause: failure }
  }
  return failure
}

/**
 * `readPersonaOwnPane`'s answer for an `ErrInvalidFlags` (b.jg5 SRJ-104:
 * `read-pane` gives it no meaning): exactly one immediate version re-check
 * through the `ErrInvalidFlags` step (`classifyWithInvalidFlagsRecheck`,
 * b.jg5 SRJ-204; a stop it decides ends the process as the re-check
 * defines), then the UNCLASSIFIED outcome with the step's class and the
 * error's redacted description. When the re-check decided the stop, the
 * outcome carries the stop mark `stopping: true` (b.jg5 SRJ-205) and nothing
 * is reported. Otherwise the outcome takes SRJ-105's UNCLASSIFIED row through
 * the outage state's site entry (`reportUnclassifiedAtSite`: inside a launch
 * or recovery attempt for the persona it arms the retry timer with the
 * UNCLASSIFIED cause and reports the persona's unclassified-error episode;
 * outside one it does nothing), since the wrapper's own report took the
 * value as STATE and reported nothing. One line, built from the
 * classification's rendered fields:
 *
 *   [slack] <site>: pane read for persona=<key> answered <classification> — UNCLASSIFIED after one immediate agent-director version re-check: <answer> (b.jg5 SRJ-104, SRJ-204)
 *
 * Never throws.
 */
async function paneReadInvalidFlagsFailure(
  key: string,
  request: PersonaPaneReadRequest,
  err: InvalidFlagsError,
): Promise<PaneReadUnclassified> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const stopping = step.recheck.kind === RECHECK_OUTCOME_STOP
  if (!stopping) reportUnclassifiedAtSite(key, err, 'read-pane', step.classification)
  console.error(
    `[slack] ${request.site}: pane read for ${keyRef(key)} answered ${describeAdErrorClassification(step.classification)} — UNCLASSIFIED after one immediate agent-director version re-check: ${step.recheck.kind} (b.jg5 SRJ-104, SRJ-204)`,
  )
  const outcome: PaneReadUnclassified = {
    kind: PANE_READ_UNCLASSIFIED,
    errorClass: step.classification.errorClass,
    description: describeAgentDirectorFailure(err),
  }
  return stopping ? { ...outcome, stopping: true } : outcome
}

/** `readPersonaOwnPane`'s one line for a latch it set (`outcome`: what became of the latch). */
function logPaneReadLatch(
  key: string,
  request: PersonaPaneReadRequest,
  cause: PaneReadConflict | PaneReadUnusableName,
  outcome: string,
): void {
  const [label, srj] = cause.kind === PANE_READ_CONFLICT ? ['CONFLICT', 'SRJ-501'] : ['UNUSABLE NAME', 'SRJ-512']
  console.error(
    `[slack] ${request.site}: pane read refused for ${keyRef(key)}: ${cause.description} — ${label}: ${outcome}; ` +
      `nothing is typed and nothing more is called for it (b.jg5 SRJ-105, ${srj})`,
  )
}

/**
 * Latch persona `key` on the thrown CONFLICT `err` through the installed
 * latch's CONFLICT entry (`setFromConflict`, b.jg5 SRJ-501) with `operation`
 * and `rowState`. Answers the latch line's outcome text: the set's outcome,
 * that no latch is installed, or that latching failed and what it threw.
 * Logs nothing; never throws.
 */
function latchOnConflict(key: string, err: unknown, operation: RefusedOperation, rowState: LatchRowState): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    return conflictSetOutcomeText(latch.setFromConflict(key, err, { refusedOperation: operation, rowState }))
  } catch (setErr) {
    return `latching the persona failed: ${describeThrownValue(setErr)}`
  }
}

/**
 * Why a persona is reported not connected (b.f2b), and what the notice says:
 * - `blocked-on-prompt`: its session shows a prompt or dialog that no one
 *   answered, and CSCB never types into one, so it won't reconnect the
 *   persona while the prompt is up: its `working` row's pane has shown one
 *   for `STALE_WORKING_WINDOW_MS`, its `waiting` row's pane shows one, or its
 *   row reads `ask_user` or `check_permission` (the restart path, or a launch
 *   wait that ended there). With `autoRestartDisabled` the notice also says
 *   nothing will reconnect it once the prompt is answered.
 * - `auto-restart-disabled`: its session runs but messages can't reach it
 *   (`cause`, fixed token-free text): its MCP connection is down, or, with
 *   `streamless`, it is connected but its message stream is gone. With
 *   `session_restart_delay` 0 nothing will reconnect it.
 * - `unproven-idle`: its row reads `working` and CSCB has held back from it,
 *   typing nothing, for `heldMs` (at least `UNPROVEN_IDLE_NOTICE_AFTER_MS`,
 *   `noteWorkingRowDeferral`, or a launch wait that gave up on the row at
 *   `session_restart_delay` 0), because it can't prove the session idle. With
 *   `autoRestartDisabled` the notice says nothing will reconnect it on its
 *   own; otherwise that CSCB reconnects it once it can tell it is idle.
 */
export type NotConnectedNotice =
  | { reason: 'blocked-on-prompt'; autoRestartDisabled: boolean }
  | { reason: 'auto-restart-disabled'; cause: string; streamless?: boolean }
  | { reason: 'unproven-idle'; autoRestartDisabled: boolean; heldMs: number }

/**
 * Why the health check finds an alive persona undeliverable (b.f2b): its MCP
 * session is not connected, or it is connected but has no message stream
 * (b.9cj).
 */
export type UndeliverableCause = 'disconnected' | 'streamless'

/**
 * Personas whose not-connected notice was raised in the current episode
 * (b.f2b). The episode ends when the persona's MCP session registers again,
 * when the health check finds it deliverable again, or when the persona is
 * torn down (`forgetNotConnectedEpisode`).
 */
const notConnectedNoticeRaised = new Set<string>()

/**
 * Raise the not-connected notice for persona `key` (b.f2b), at most once per
 * episode, through the persona notifier: its session runs, but it is not
 * connected to this server and CSCB will not reconnect it on its own. The
 * notice says why and what to do. Logs one line when it raises the notice and
 * returns whether it did; a second call in the same episode does nothing.
 */
export function notifyPersonaNotConnected(key: string, notice: NotConnectedNotice): boolean {
  if (notConnectedNoticeRaised.has(key)) return false
  notConnectedNoticeRaised.add(key)
  console.error(`[slack] session-manager: ${keyRef(key)} is not connected (${notice.reason}) — raising a not-connected notice (b.f2b)`)
  sendPersonaNotice(key, buildNotConnectedNotice(key, notice))
  return true
}

/**
 * The health check's report for an alive persona it would reconnect while
 * auto-restart is disabled (b.f2b): the `auto-restart-disabled` notice, once
 * per episode (`notifyPersonaNotConnected`), worded for why it is
 * undeliverable: its MCP connection is down (`disconnected`, the default), or
 * it is connected but its message stream is gone (`streamless`).
 */
export function notifyDisconnectedWithAutoRestartDisabled(key: string, cause: UndeliverableCause = 'disconnected'): void {
  notifyPersonaNotConnected(
    key,
    cause === 'streamless'
      ? {
          reason: 'auto-restart-disabled',
          cause: 'found on two health checks in a row',
          streamless: true,
        }
      : { reason: 'auto-restart-disabled', cause: 'its connection has been down on two health checks in a row' },
  )
}

/**
 * End persona `key`'s not-connected episode (b.f2b): its MCP session
 * registered again, the health check found it deliverable again, or it was
 * torn down. Its notice latch is cleared, so a later episode is reported
 * again, and so are the idle evidence the restart path gathered for its
 * `working` row (`checkWorkingRowPane`), its run of deferrals on that row
 * (`noteWorkingRowDeferral`), its run of deferrals on a row waiting on a
 * prompt (`checkPromptRowDeferral`, b.jdc) and the last non-latching
 * liveness note logged for its own row (`nonLatchingNoteLogged`, b.jg5
 * SRJ-114). Silent; other personas are untouched.
 */
export function forgetNotConnectedEpisode(key: string): void {
  notConnectedNoticeRaised.delete(key)
  workingRowPaneRuns.delete(key)
  workingRowDeferredSince.delete(key)
  promptRowDeferredSince.delete(key)
  nonLatchingNoteLogged.delete(key)
}

/** Test-only seam: end every persona's not-connected episode (notice latches, idle evidence, deferral runs and logged liveness notes). */
export function _resetNotConnectedEpisodes(): void {
  notConnectedNoticeRaised.clear()
  workingRowPaneRuns.clear()
  workingRowDeferredSince.clear()
  promptRowDeferredSince.clear()
  nonLatchingNoteLogged.clear()
}

/**
 * The not-connected notice body (b.f2b). The first line says what is wrong,
 * so a dry-run log line (which carries only the first line) keeps it; the
 * second says what to do. The notifier adds the persona reference. The attach
 * command names the session exactly (`=slack_bot_<key>`, b.1ix): a bare name
 * would attach to a prefix neighbour's session (`slack_bot_dev_2` for
 * `slack_bot_dev`) once the persona's own is gone.
 */
function buildNotConnectedNotice(key: string, notice: NotConnectedNotice): string {
  const attach = `\`tmux attach -t ${tmuxExactSessionTarget(personaTmuxSessionName(key))}\``
  const reconnect = `\`/mcp reconnect ${MCP_SERVER_NAME}\``
  if (notice.reason === 'blocked-on-prompt') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0): if it is still not connected once its turn ends, type ${reconnect} there or restart the server.`
      : `Once it is answered, CSCB reconnects it when it can tell the session is idle again (its row reads waiting, or its screen and transcript prove it idle); if it stays disconnected, type ${reconnect} there.`
    return (
      `:warning: *Waiting on a prompt* — this persona is not connected to this server, and its session shows a prompt or dialog in its terminal that no one has answered. CSCB never types into a prompt, so it won't reconnect the persona while the prompt is up; messages sent to it until then are lost.\n` +
      `Attach with ${attach} and answer it. ${after}`
    )
  }
  if (notice.reason === 'unproven-idle') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it on its own; if it stays disconnected, restart the server.`
      : `Otherwise CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle.`
    return (
      `:warning: *Not connected* — this persona is not connected to this server: its session reads working but CSCB can't prove it's idle, so it won't type into it, and has held back for ${describeWaitSpan(notice.heldMs)}. Messages sent to it until it reconnects are lost.\n` +
      `Check it with ${attach}: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type ${reconnect} there. ${after}`
    )
  }
  if (notice.streamless === true) {
    return (
      `:warning: *Not receiving messages* — this persona's session is running and connected to this server, but its message stream is gone (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will restore it; messages sent to it are lost.\n` +
      `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
    )
  }
  return (
    `:warning: *Not connected* — this persona's session is running but is not connected to this server (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it; messages sent to it are lost.\n` +
    `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
  )
}

function remediationHint(error: AgentDirectorError): string {
  if (error instanceof ErrInstanceIdCollision) return 'spawn dispatcher bug — please report'
  if (error instanceof ErrSpawnNotFound) return 'transient — restarting the server should resolve'
  if (error instanceof ErrSpawnCapReached) return 'restart the server to retry — automatic restarts are suspended for this persona'
  return 'Check server.log for details.'
}

// ---------------------------------------------------------------------------
// Raw tmux calls — one runner, exact targets only (b.1ix)
// ---------------------------------------------------------------------------

/** One `tmux` run: its exit code (`null` when it could not run) and its stdout. */
export interface TmuxRunResult {
  code: number | null
  stdout: string
}

/**
 * Runs `tmux <args>` and never rejects. No server path makes a raw tmux call
 * through it: CSCB reaches tmux only through agent-director. The runner and
 * its seams stay so a unit test can install a recording runner, see that no
 * argv reaches it, and never reach a real tmux server.
 */
export type TmuxCommandRunner = (args: readonly string[]) => Promise<TmuxRunResult>

const defaultRunTmux: TmuxCommandRunner = async (args) => {
  const { spawn } = await import('child_process')
  return new Promise<TmuxRunResult>((resolve) => {
    try {
      const child = spawn('tmux', [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.on('error', () => resolve({ code: null, stdout: '' })) // tmux missing
      child.on('close', (code) => resolve({ code, stdout }))
    } catch {
      resolve({ code: null, stdout: '' })
    }
  })
}

let _runTmux: TmuxCommandRunner = defaultRunTmux

/** Test-only seam: override the tmux command runner. */
export function _setTmuxCommandRunner(fn: TmuxCommandRunner): void {
  _runTmux = fn
}

/** Test-only seam: restore the default tmux command runner. */
export function _resetTmuxCommandRunner(): void {
  _runTmux = defaultRunTmux
}

/**
 * tmux resolves a bare `-t <name>` to the session with that exact name when
 * there is one, and otherwise to the one session whose name starts with it.
 * Persona keys can prefix one another (`dev`, `dev_2`), so a bare
 * `slack_bot_dev` reaches `slack_bot_dev_2` whenever `slack_bot_dev` is gone:
 * an operator's `attach` would reach the neighbour's bot. A `=` prefix accepts only
 * the exact name (b.1ix). Verified against tmux 3.2a, the version in the
 * `/ci` image.
 *
 * The `attach` command the not-connected notices give an operator names
 * its session target as `=<name>`.
 */
function tmuxExactSessionTarget(sessionName: string): string {
  return `=${sessionName}`
}

// ---------------------------------------------------------------------------
// reconnectMcp — send `/mcp reconnect <server-name>` via library sendKeys
// ---------------------------------------------------------------------------

/**
 * The reconnect's outcome (`reconnectMcpWithCause`, b.jg5 SRJ-118's
 * reconnect row, SRJ-609):
 *   - `ok`: `/mcp reconnect` was typed;
 *   - `dead-session`: the caller recovers the persona (the ladder through its
 *     find-missing run and resume/fresh-spawn, the restart adapter by
 *     sweeping and escalating it). Its cause (`DeadSessionCause`) says what
 *     agent-director answered. `waitForWaitingAndReconnect` also answers it
 *     for a row it read `ended` or `missing`, or found absent
 *     (`ErrSpawnNotFound`), with no tmux probe (b.ecw, b.jg5 SRJ-605). A
 *     `dead-session` from a row read or from a refusal as not interactive
 *     proves nothing about the worker's process (b.jg5 SRJ-609, SRJ-611); the
 *     recovery's resume or spawn decides what holds the persona's name
 *     (agent-director classifies any leftover session, and a CONFLICT there
 *     latches the persona, SRJ-501);
 *   - `transient`: nothing was typed and nothing is concluded about the
 *     session: the persona latched at the reconnect (CONFLICT, UNUSABLE
 *     NAME) or was latched already, or agent-director could not act on the
 *     keystrokes (UNAVAILABLE, timeouts included, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED). It is never counted toward the restart cap, never a
 *     spawn-failure notice and never a `spawn-failed` entry: the ladder maps
 *     it to `latched` for a latched persona and otherwise to its uncounted
 *     refused result, and the restart adapter to `transient`.
 */
export type ReconnectOutcome = 'ok' | 'dead-session' | 'transient'

/**
 * `waitForWaitingAndReconnect`'s outcome (b.f2b): a reconnect outcome (`ok`
 * only when `/mcp reconnect` was typed; `dead-session` as `ReconnectOutcome`
 * says, never for a `status` error other than `ErrSpawnNotFound`;
 * `transient` for the wait's reconnect's own `transient`, for a refused
 * findMissing sweep, and for a server stop decided at the evidence read's
 * version re-check, never for a `status` error, b.jg5 SRJ-605: nothing was
 * typed and nothing is counted); `not-reconnected`: the wait ended with the
 * persona's session alive, or its state unknown, but typed nothing (the row
 * moved to a live transient state, the timeout found it still live, or the
 * timeout `status` read failed), and has logged what happens next for the
 * restart delay in effect (`reportWaitEndedDisconnected`); or `cancelled`:
 * the persona's teardown cancelled the wait (`cancelWorkingRowWait`), and
 * nothing was typed; or `latched`: the persona is latched after one of the
 * wait's agent-director calls (b.jg5 SRJ-502, SRJ-608: an UNUSABLE NAME
 * answer or a `pending` row with no launch start at a `status` read, a
 * CONFLICT or UNUSABLE NAME at the evidence read's pane read, a note its
 * transcript `get` read, or a latch set elsewhere), the wait called nothing
 * more, typed nothing and raised no not-connected notice, and the ladder
 * answers `latched`.
 */
export type WaitReconnectOutcome = ReconnectOutcome | 'not-reconnected' | 'cancelled' | typeof WAIT_OUTCOME_LATCHED

/** The wait's outcome for a persona that is latched (`WaitReconnectOutcome`). */
export const WAIT_OUTCOME_LATCHED = 'latched'

/** `DeadSessionCause`: the reconnect's `send-keys` answered GONE (`ErrTmuxSendKeys`). */
export const DEAD_SESSION_CAUSE_TMUX_GONE = 'tmux-gone'

/** `DeadSessionCause`: agent-director refused the keystrokes as not interactive (`ErrSpawnNotInteractive`). */
export const DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE = 'row-not-interactive'

/** `DeadSessionCause`: no row has the persona's instance id (`ErrSpawnNotFound`), a row read. */
export const DEAD_SESSION_CAUSE_ROW_ABSENT = 'row-absent'

/**
 * What agent-director answered when `reconnectMcpWithCause` answered
 * `dead-session` (b.jdc; b.jg5 SRJ-118, SRJ-609):
 *   - `tmux-gone`: the `send-keys` answered GONE (`ErrTmuxSendKeys`):
 *     agent-director found no session of the row's launch. Answered at once,
 *     with no tmux server start and no second try;
 *   - `row-not-interactive`: agent-director refused the keystrokes as not
 *     interactive (`ErrSpawnNotInteractive`, b.dup): the row finished
 *     (`ended` or `missing`) after the caller read it, or it reads `pending`
 *     and the session holding the persona's name may be another launch's
 *     (b.jg5 SRJ-613). A finished row is not proof that the worker is gone,
 *     so this is only a route into the restart path's decision: the restart
 *     adapter answers `RECONNECT_ESCALATE_DEAD_NO_KILL`, and the restart work
 *     kills nothing because of it (SRJ-609);
 *   - `row-absent`: no row has the persona's instance id (`ErrSpawnNotFound`):
 *     a row read, not a GONE.
 */
export type DeadSessionCause =
  | typeof DEAD_SESSION_CAUSE_TMUX_GONE
  | typeof DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE
  | typeof DEAD_SESSION_CAUSE_ROW_ABSENT

/** `reconnectMcpWithCause`'s answer: the outcome, with what goes with it. */
export interface ReconnectResult {
  outcome: ReconnectOutcome
  /** Set on a `dead-session` outcome only: what agent-director answered. */
  deadCause?: DeadSessionCause
  /**
   * Set on a `transient` outcome only: the persona is latched (the
   * reconnect's CONFLICT or UNUSABLE NAME answer latched it, or it was
   * latched already and no `send-keys` was made), so the ladder answers
   * `latched` for it.
   */
  latched?: true
  /**
   * Set on a `transient` outcome only: the keystrokes answered
   * `ErrInvalidFlags` and the immediate version re-check decided that the
   * server stops (b.jg5 SRJ-104, SRJ-205); the ladder answers a `failed`
   * result marked `stopping`.
   */
  stopping?: true
}

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to persona `key`'s row and answer
 * its outcome alone (`reconnectMcpWithCause`). `lastRead` is the row state
 * the caller last read (b.jg5 SRJ-501), `waiting` when not given: every
 * reconnect is made on a row read `waiting`, or a stale `working` row.
 *
 * @param key  Persona key: addresses `cscb_<key>` and keys outage flags and notices.
 * @param lastRead  The row state the caller last read, for a latch the reconnect sets.
 * @param ref  Log reference; defaults to the key alone.
 */
export async function reconnectMcp(
  key: string,
  lastRead: LatchRowState = latchRowStateRead('waiting'),
  ref: string = keyRef(key),
): Promise<ReconnectOutcome> {
  return (await reconnectMcpWithCause(key, lastRead, ref)).outcome
}

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to persona `key`'s row: exactly one
 * `sendKeys` through `withOutageDetection`, declaring the `send-keys` verb
 * (tmux-touching), with the library appending Enter. It never retries, never
 * starts a tmux server and makes no tmux call of its own (b.jg5 SRJ-609, HO
 * C20). Each answer is decided by class and name through
 * `src/ad-error-class.ts`, never by `instanceof` (b.jg5 SRJ-118's reconnect
 * row):
 *
 *   - a persona already latched (`personaLatchedNow`, b.jg5 SRJ-502): no
 *     `send-keys`; `transient` (latched);
 *   - success: `ok`;
 *   - GONE (`ErrTmuxSendKeys`): `dead-session` with cause `tmux-gone`, at once;
 *   - `ErrSpawnNotInteractive`: `dead-session` with cause
 *     `row-not-interactive`, a route into the restart path's decision only;
 *     it claims nothing about the worker's process;
 *   - `ErrSpawnNotFound`: `dead-session` with cause `row-absent` (a row read,
 *     not a GONE);
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and `lastRead` (b.jg5 SRJ-501); `transient` (latched). On a
 *     live row that is not `pending`, "not this launch's session" means a
 *     leftover of an earlier launch holds the persona's session (SRJ-613),
 *     and its line says so. The refused `send-keys` is never retried
 *     (SRJ-505);
 *
 *     This CONFLICT is the backstop for every pane read that leads here
 *     (b.jg5 SRJ-613). A pane may be a single leftover's, so the waiting-row
 *     check's pane (`checkWaitingRowPane`), the working-row verdict's fold
 *     (`workingReconnectVerdict`, `checkWorkingRowPane`) and the launch
 *     wait's evidence read (`staleWorkingRowIsIdle`) never prove that the
 *     worker's own session is there; this `send-keys` is answered by the
 *     row's current launch, and when a leftover holds the persona's session
 *     it types nothing and P latches (its CONFLICT notice posted once,
 *     SRJ-508), held for a human (SRJ-502);
 *   - UNUSABLE NAME: the persona latches through the unusable-name entry
 *     (`latchOnUnusableName`: refused operation "none", `lastRead`, b.jg5
 *     SRJ-512); `transient` (latched);
 *   - `ErrInvalidFlags`, to which `send-keys` gives no meaning: one immediate
 *     version re-check, then UNCLASSIFIED (b.jg5 SRJ-104, SRJ-204):
 *     `transient`, carrying `stopping` when the re-check decided the stop;
 *   - UNAVAILABLE (timeouts included), ENVIRONMENT, CONFIG and UNCLASSIFIED
 *     (`ErrSendKeysWhileRelayed` and `ErrSystemInstallDisappeared`
 *     included), and any STATE, LAUNCH FAILURE or DIRECTORY name SRJ-118
 *     gives no column: `transient`. The wrapper has already done what their
 *     class asks (b.jg5 SRJ-105, SRJ-301, SRJ-311, SRJ-313, SRJ-316): it
 *     raised the `tmux-unavailable`, `ad-config-malformed` or
 *     `ad-unreachable` outage, armed the persona's retry timer inside an
 *     attempt and reported an UNCLASSIFIED answer to the persona's
 *     unclassified-error episode; a CONFIG answer is otherwise taken as the
 *     UNAVAILABLE column.
 *
 * No path posts a spawn-failure notice, records a `spawn-failed` entry or
 * counts anything. Nothing is typed on any path but success. One line per
 * call, from an exported builder (`reconnectStartLine`, then one of
 * `reconnectLatchedLine`, `reconnectGoneLine`, `reconnectNotInteractiveLine`,
 * `reconnectRowAbsentLine`, `reconnectConflictLine`,
 * `reconnectUnusableNameLine`, `reconnectInvalidFlagsLine` and
 * `reconnectTransientLine` for a failure). Never throws.
 *
 * @param key  Persona key: addresses `cscb_<key>` and keys outage flags and notices.
 * @param lastRead  The row state the caller last read (b.jg5 SRJ-501): the
 *   ladder's `waiting` branch `waiting`; the launch wait `waiting`, or
 *   `working` for a stale `working` row; the restart adapter the state its
 *   `status` read gave.
 * @param ref  Log reference; defaults to the key alone.
 */
export async function reconnectMcpWithCause(
  key: string,
  lastRead: LatchRowState,
  ref: string = keyRef(key),
): Promise<ReconnectResult> {
  if (personaLatchedNow(key)) {
    console.error(reconnectLatchedLine(ref))
    return { outcome: 'transient', latched: true }
  }
  console.error(reconnectStartLine(ref))
  try {
    await withOutageDetection(key, undefined, 'send-keys', (client) =>
      client.sendKeys({
        claude_instance_id: personaInstanceId(key),
        text: `/mcp reconnect ${MCP_SERVER_NAME}`,
      }),
    )
    return { outcome: 'ok' }
  } catch (err) {
    return reconnectAnswerTo(key, lastRead, ref, err)
  }
}

/**
 * `reconnectMcpWithCause`'s answer to a refused `send-keys` (`err`), by
 * class and name (b.jg5 SRJ-118's reconnect row; see `reconnectMcpWithCause`
 * for the table). Logs its one line. Never throws.
 */
async function reconnectAnswerTo(key: string, lastRead: LatchRowState, ref: string, err: unknown): Promise<ReconnectResult> {
  if (isInvalidFlagsError(err)) return reconnectInvalidFlagsAnswer(key, ref, err)
  const { errorClass } = classifyAdError(err)
  const failure = describeAgentDirectorFailure(err)
  if (errorClass === AD_ERROR_CLASS_GONE) {
    console.error(reconnectGoneLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_TMUX_GONE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_INTERACTIVE_NAME)) {
    console.error(reconnectNotInteractiveLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
    console.error(reconnectRowAbsentLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_ABSENT }
  }
  if (errorClass === AD_ERROR_CLASS_CONFLICT) {
    // The latch is set first; its line then carries what became of it. The
    // line's builder takes only the redacted description, the case and the
    // latch's own outcome text.
    logReconnectLine(
      reconnectConflictLine(
        ref,
        failure,
        recogniseConflictCase(conflictDescriptionOf(err)),
        latchOnConflict(key, err, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, lastRead),
      ),
    )
    return { outcome: 'transient', latched: true }
  }
  if (errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    logReconnectLine(reconnectUnusableNameLine(ref, failure, latchOnUnusableName(key, err, lastRead)))
    return { outcome: 'transient', latched: true }
  }
  console.error(reconnectTransientLine(ref, failure, errorClass))
  return { outcome: 'transient' }
}

/**
 * `reconnectMcpWithCause`'s answer to an `ErrInvalidFlags` (b.jg5 SRJ-104:
 * `send-keys` gives it no meaning): exactly one immediate version re-check
 * (`classifyWithInvalidFlagsRecheck`, b.jg5 SRJ-204; a stop it decides ends
 * the process as the re-check defines), then UNCLASSIFIED: `transient`,
 * carrying `stopping` when the re-check decided the stop (b.jg5 SRJ-205), in
 * which case nothing is reported. Otherwise the answer takes SRJ-105's
 * UNCLASSIFIED row through the outage state's site entry
 * (`reportUnclassifiedAtSite`), since the wrapper took the value as STATE.
 * One line (`reconnectInvalidFlagsLine`). Never throws.
 */
async function reconnectInvalidFlagsAnswer(key: string, ref: string, err: InvalidFlagsError): Promise<ReconnectResult> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const stopping = step.recheck.kind === RECHECK_OUTCOME_STOP
  if (!stopping) reportUnclassifiedAtSite(key, err, 'send-keys', step.classification)
  console.error(reconnectInvalidFlagsLine(ref, describeAdErrorClassification(step.classification), step.recheck.kind))
  return stopping ? { outcome: 'transient', stopping: true } : { outcome: 'transient' }
}

/**
 * One reconnect line to the server log; `line` comes from one of the
 * reconnect's exported builders. The two latching lines go through it, as
 * `logApproverLine` and `logPaneReadLatch` do, because their arguments hand
 * the thrown value to the latch call, which a direct log call may not.
 */
function logReconnectLine(line: string): void {
  console.error(line)
}

/** The reconnect's first line, before its one `send-keys` (`reconnectMcpWithCause`). */
export function reconnectStartLine(ref: string): string {
  return `[slack] reconnecting MCP server "${MCP_SERVER_NAME}": ${ref}`
}

/** The reconnect's line for a persona already latched: no `send-keys` is made (b.jg5 SRJ-502). */
export function reconnectLatchedLine(ref: string): string {
  return `[slack] reconnectMcp: ${ref} is latched — no send-keys; transient, nothing typed (b.jg5 SRJ-118, SRJ-502)`
}

/**
 * The reconnect's line for a GONE answer (`ErrTmuxSendKeys`; `failure` is the
 * redacting describer's output): `dead-session` with cause `tmux-gone`, at
 * once, with no tmux server start and no second try (b.jg5 SRJ-118, SRJ-609).
 */
export function reconnectGoneLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys answered GONE for ${ref}: ${failure} — agent-director found no session of the row's launch; dead session (${DEAD_SESSION_CAUSE_TMUX_GONE}), with no tmux server start and no second try (b.jg5 SRJ-118, SRJ-609)`
}

/**
 * The reconnect's line for `ErrSpawnNotInteractive` (`failure` is the
 * redacting describer's output): `dead-session` with cause
 * `row-not-interactive`, a route into the restart path's decision only. It
 * claims nothing about the worker's process (b.jg5 SRJ-609).
 */
export function reconnectNotInteractiveLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — agent-director refused the keystrokes as not interactive (the row finished after it was read, or a pending row's session may be another launch's), which does not prove the worker gone; dead session (${DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE}), a route into the restart path's decision only (b.jg5 SRJ-118, SRJ-609)`
}

/**
 * The reconnect's line for `ErrSpawnNotFound` (`failure` is the redacting
 * describer's output): `dead-session` with cause `row-absent`, a row read and
 * not a GONE (b.jg5 SRJ-118).
 */
export function reconnectRowAbsentLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys found no row for ${ref}: ${failure} — no row has the persona's instance id (a row read, not a GONE); dead session (${DEAD_SESSION_CAUSE_ROW_ABSENT}) (b.jg5 SRJ-118)`
}

/**
 * What `reconnectConflictLine` adds for the CONFLICT case "not this launch's
 * session": on a live row that is not `pending`, a leftover of an earlier
 * launch holds the persona's session (b.jg5 SRJ-118, SRJ-613).
 */
export const RECONNECT_NOT_THIS_LAUNCH_NOTE = "a leftover of an earlier launch may hold the persona's session (b.jg5 SRJ-613)"

/**
 * The reconnect's line for a CONFLICT answer (`failure` is the redacting
 * describer's output, `latchCase` the case its description's words give,
 * `outcome` what became of the latch): nothing was typed, the persona
 * latched, and the refused `send-keys` is never retried (b.jg5 SRJ-118,
 * SRJ-501, SRJ-505). The case "not this launch's session" also carries
 * `RECONNECT_NOT_THIS_LAUNCH_NOTE`.
 */
export function reconnectConflictLine(ref: string, failure: string, latchCase: ConflictLatchCase, outcome: string): string {
  const note = latchCase === LATCH_CASE_NOT_THIS_LAUNCH ? ` (${RECONNECT_NOT_THIS_LAUNCH_NOTE})` : ''
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — CONFLICT case=${latchCase}${note}: ${outcome}; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-501)`
}

/**
 * The reconnect's line for an UNUSABLE NAME answer (`failure` is the
 * redacting describer's output, `outcome` what became of the latch): nothing
 * was typed and the persona latched (b.jg5 SRJ-118, SRJ-512).
 */
export function reconnectUnusableNameLine(ref: string, failure: string, outcome: string): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — UNUSABLE NAME: ${outcome}; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-512)`
}

/**
 * The reconnect's line for an `ErrInvalidFlags` answer after its one version
 * re-check (`classification` rendered by `describeAdErrorClassification`,
 * `recheck` the re-check's answer kind): UNCLASSIFIED, `transient`, nothing
 * typed (b.jg5 SRJ-104, SRJ-204).
 */
export function reconnectInvalidFlagsLine(ref: string, classification: string, recheck: string): string {
  return `[slack] reconnectMcp: send-keys for ${ref} answered ${classification} — UNCLASSIFIED after one immediate agent-director version re-check: ${recheck}; transient, nothing typed (b.jg5 SRJ-104, SRJ-204)`
}

/**
 * The reconnect's line for every other refused `send-keys` (`failure` is the
 * redacting describer's output, `errorClass` its class): UNAVAILABLE,
 * ENVIRONMENT, CONFIG, UNCLASSIFIED, or a STATE, LAUNCH FAILURE or DIRECTORY
 * name SRJ-118 gives no column. `transient`: nothing was typed, no
 * spawn-failure notice, nothing counted (b.jg5 SRJ-118, SRJ-105).
 */
export function reconnectTransientLine(ref: string, failure: string, errorClass: AdErrorClass): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — ${errorClass}: transient; nothing was typed, no spawn-failure notice, nothing counted (b.jg5 SRJ-118, SRJ-105)`
}

// ---------------------------------------------------------------------------
// approvePreSessionDialogs — auto-approve pre-SessionStart dialogs on spawn
// ---------------------------------------------------------------------------

/**
 * Verified against Claude Code 2.1.120 (2026-05-27). If this stops matching,
 * the dev-channels dialog has drifted — see b.yy6. Match the option label
 * (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const DEV_CHANNELS_DIALOG_NEEDLE = 'I am using this for local development'

/**
 * Verified against Claude Code 2.1.120 (2026-06-02). If this stops matching,
 * the folder-trust dialog has drifted — see b.k54 / b.uhv. Match the option
 * label (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const TRUST_DIALOG_NEEDLE = 'Yes, I trust this folder'

/**
 * The approver's pace (b.jg5 SRJ-403): at most one pane read a second. The
 * lap after one that read the pane starts at least this long after that
 * `read-pane` call, on the approver's clock (`_setApproverClock`), so two
 * `read-pane` calls are never closer than the pace in effect, however long
 * either lap's `status` read takes. The lap after one that read no pane
 * starts at least this long after that lap's start.
 */
export const DIALOG_POLL_INTERVAL_MS = 1_000

/**
 * The approver's slow pace (b.jg5 SRJ-403, SRJ-404): at most one pane read
 * every 5 s, measured as `DIALOG_POLL_INTERVAL_MS` is. The next lap waits it
 * once G (`adGraceMsInEffect`, read at the lap)
 * has passed since the launch start the lap's `status` read carried, and
 * after a lap that met an UNAVAILABLE or CONFIG answer (backing off).
 */
export const DIALOG_SLOW_POLL_INTERVAL_MS = 5_000

/**
 * The approver's test cap (b.jg5 SRJ-404, SRJ-1303): unset by default. While
 * it is set, the approver stops that many milliseconds after its own start,
 * on the approver's clock, in place of B; no other wait reads it.
 */
let _dialogReadyTimeoutMs: number | undefined

/** Test-only seam: cap the approver at `ms` from its own start, in place of B. */
export function _setDialogReadyTimeoutMs(ms: number): void {
  _dialogReadyTimeoutMs = ms
}

/** Test-only seam: unset the cap, so the approver stops at B. */
export function _resetDialogReadyTimeoutMs(): void {
  _dialogReadyTimeoutMs = undefined
}

/**
 * The time to wait from one lap's pane read (or, for a lap that read no
 * pane, its start) to the next lap's start (b.jg5 SRJ-403, SRJ-404):
 * `DIALOG_SLOW_POLL_INTERVAL_MS` after a lap that backed off (an
 * UNAVAILABLE or CONFIG answer), or once `graceMs` (G in effect) has passed
 * at `nowMs` since `launchStartMs`, the launch start the lap's `status` read
 * carried, by a plain comparison; otherwise `DIALOG_POLL_INTERVAL_MS`. A lap
 * with no launch start, and a G of `AD_WAIT_NEVER_ENDS`, keep the 1 s pace.
 * Pure.
 */
export function approverPaceMs(
  backOff: boolean,
  launchStartMs: number | undefined,
  nowMs: number,
  graceMs: number,
): number {
  if (backOff) return DIALOG_SLOW_POLL_INTERVAL_MS
  if (launchStartMs !== undefined && nowMs - launchStartMs >= graceMs) return DIALOG_SLOW_POLL_INTERVAL_MS
  return DIALOG_POLL_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// The approver's clock, stop reasons, startup-errors labels and log lines
// ---------------------------------------------------------------------------

/**
 * The approver's clock and timers: the timer subset of the persona clock type
 * (`NeverEarlyWaitClock`, `src/ad-settings.ts`). The approver's B (or cap)
 * timer and its sleeps between laps run on this clock only, so a suite drives
 * them all with `createFakeClock` and never waits on real time.
 */
export type ApproverClock = NeverEarlyWaitClock

/** The real clock, the approver's default. */
const SYSTEM_APPROVER_CLOCK: ApproverClock = Object.freeze({
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

let _approverClock: ApproverClock = SYSTEM_APPROVER_CLOCK

/** Test-only seam: run the approver's B (or cap) timer and sleeps on `clock` (a suite passes `createFakeClock()`). */
export function _setApproverClock(clock: ApproverClock): void {
  _approverClock = clock
}

/** Test-only seam: restore the real clock for the approver. */
export function _resetApproverClock(): void {
  _approverClock = SYSTEM_APPROVER_CLOCK
}

/** The approver stopped because the row left `pending` for a live state: the dialog is gone. */
export const APPROVER_STOP_LIVE = 'live'
/** The approver stopped because the row read `ended` or `missing`: the launch is over (b.jg5 SRJ-402). */
export const APPROVER_STOP_FINISHED = 'finished'
/** The approver stopped because `status` answered `ErrSpawnNotFound`: the row is absent. */
export const APPROVER_STOP_ABSENT = 'absent'
/**
 * The approver stopped because the persona latched (b.jg5 SRJ-502, SRJ-512,
 * SRJ-513): its `status` read latched it (the own-row `status` step), its
 * own CONFLICT or UNUSABLE NAME answer latched it, it was latched before a
 * lap or while a call was awaited, or a latch set by any other site stopped
 * it (the latch's set observer, `setConflictLatch`).
 */
export const APPROVER_STOP_LATCHED = 'latched'
/**
 * The approver stopped because the row read `pending` with no launch start
 * and the read latched nothing (b.jg5 SRJ-401, SRJ-513). For a configured
 * persona the own-row `status` step (`applyOwnRowStatusStep`) latches such a
 * row with "launch start not recorded", answering latched even with no latch
 * installed, so the approver stops `latched` instead. This stop is reached
 * only when no configured-persona query is installed, or the query does not
 * answer that `key` is a configured persona's (it answers otherwise or
 * throws; e.g. a persona removed while its launch's approver runs).
 */
export const APPROVER_STOP_NO_LAUNCH_START = 'no-launch-start'
/**
 * The approver stopped at B (`adLaunchBoundMsInEffect`, b.jg5 SRJ-210,
 * SRJ-404), measured from the launch start its first `pending` lap kept, or
 * from its own start while no lap had read one.
 */
export const APPROVER_STOP_BOUND = 'bound'
/** The approver stopped at its test cap (`_setDialogReadyTimeoutMs`, measured from its own start), set in place of B. */
export const APPROVER_STOP_CAP = 'cap'
/**
 * The approver stopped on GONE (`ErrTmuxCaptureFailed`, `ErrTmuxSendKeys`)
 * from any of its calls, or on `ErrSpawnNotFound` from `read-pane` or
 * `send-keys` (b.jg5 SRJ-117, SRJ-118, SRJ-404).
 */
export const APPROVER_STOP_GONE = 'gone'
/**
 * The approver stopped on `ErrSpawnNotInteractive` with nothing typed (b.jg5
 * SRJ-118, SRJ-404): the session holding the name is not this launch's, by
 * its label's token, or the row has no launch start.
 */
export const APPROVER_STOP_NOT_INTERACTIVE = 'not-interactive'
/**
 * The approver stopped on ENVIRONMENT (`ErrTmuxNotAvailable`, b.jg5 SRJ-311,
 * SRJ-404); the wrapper raised the persona's `tmux-unavailable` outage, and
 * nothing is counted.
 */
export const APPROVER_STOP_TMUX_UNAVAILABLE = 'tmux-unavailable'
/**
 * The approver was stopped by the one-approver rule (b.jg5 SRJ-401; hatch
 * A2): a later launch of the persona started its own approver
 * (`startDialogApprover`), or a lap read a launch start other than the one
 * the approver kept. Either way the row belongs to a newer launch.
 */
export const APPROVER_STOP_SUPERSEDED = 'superseded'
/** The persona's teardown stopped the approver (b.jg5 SRJ-404, SRJ-715). */
export const APPROVER_STOP_TEARDOWN = 'teardown'
/** Shutdown stopped the approver (b.jg5 SRJ-404). */
export const APPROVER_STOP_SHUTDOWN = 'shutdown'
/** The approver's loop threw (not reached: every step is guarded); the throw was logged and nothing more was called. */
export const APPROVER_STOP_FAILED = 'failed'

/**
 * Why the approver stopped: what `approvePreSessionDialogs` resolves with,
 * and the reason in an {@link ApproverOutcome}. Each kind of stop has its own
 * member, so a reader of the outcome tells which stops leave a `pending` row
 * to the pending-row rule (b.jg5 SRJ-404: B or the cap, GONE, not
 * interactive, tmux unavailable, superseded) from those that do not
 * (shutdown, latched, teardown).
 */
export type ApproverStopReason =
  | typeof APPROVER_STOP_LIVE
  | typeof APPROVER_STOP_FINISHED
  | typeof APPROVER_STOP_ABSENT
  | typeof APPROVER_STOP_LATCHED
  | typeof APPROVER_STOP_NO_LAUNCH_START
  | typeof APPROVER_STOP_BOUND
  | typeof APPROVER_STOP_CAP
  | typeof APPROVER_STOP_GONE
  | typeof APPROVER_STOP_NOT_INTERACTIVE
  | typeof APPROVER_STOP_TMUX_UNAVAILABLE
  | typeof APPROVER_STOP_SUPERSEDED
  | typeof APPROVER_STOP_TEARDOWN
  | typeof APPROVER_STOP_SHUTDOWN
  | typeof APPROVER_STOP_FAILED

/**
 * The reasons a caller stops a persona's approver with (`stopDialogApprover`):
 * each is also the stopped approver's {@link ApproverStopReason}. One member
 * per kind of stop, so a later stop (a key recorded as retired, the abort of
 * the persona's own stuck launch) is one more member here, and a reader of
 * the outcome tells which stops leave the row to the pending-row rule.
 */
export type ApproverStopRequestReason =
  | typeof APPROVER_STOP_SUPERSEDED
  | typeof APPROVER_STOP_TEARDOWN
  | typeof APPROVER_STOP_SHUTDOWN
  | typeof APPROVER_STOP_LATCHED

/** The approver's two time limits: B, or the test cap set in place of it. */
type ApproverLimitReason = typeof APPROVER_STOP_BOUND | typeof APPROVER_STOP_CAP

/** How one approver ended: why, and the launch start it kept (absent when no lap read the row `pending` with a launch start). */
export interface ApproverOutcome {
  readonly reason: ApproverStopReason
  /** Epoch ms of the launch start the approver's first lap whose `status` read the row `pending` with a launch start read. */
  readonly launchStartMs: number | undefined
}

/** The startup-errors class the approver writes, during a start-pass launch, when the row reads `ended` or `missing` (b.jg5 SRJ-402, SRJ-1013). */
export const STARTUP_ERROR_APPROVE_SPAWN_DIED = 'dev-channels-approve-spawn-died'
/** The startup-errors class the approver writes, during a start-pass launch, at B or its cap (b.jg5 SRJ-405). */
export const STARTUP_ERROR_APPROVE_NOT_READY = 'dev-channels-approve-not-ready'

/** The approver's site name, in its own log lines and in the own-row `status` read's lines. */
export const APPROVER_LOG_SITE = 'approvePreSessionDialogs'
/** What the approver's own-row `status` read is called in that read's lines (`OwnRowReadSite.what`). */
export const APPROVER_STATUS_READ_WHAT = 'readiness status read'
/** The head of every log line the approver writes itself. */
export const APPROVER_LOG_PREFIX = `[slack] ${APPROVER_LOG_SITE}: `
/** The pane lines one approver `read-pane` asks for (b.jg5 SRJ-402). */
export const APPROVER_PANE_LINES = 40

/** The agent-director verbs the approver calls. */
export type ApproverVerb = 'status' | 'read-pane' | 'send-keys'

/** B was measured from the launch start a lap kept. */
export const APPROVER_BOUND_FROM_LAUNCH_START = 'the launch start'
/** B was measured from the approver's own start: no lap had read a launch start. */
export const APPROVER_BOUND_FROM_APPROVER_START = "the approver's start"

/** Where B was measured from, in the at-B line ({@link approverBoundMessage}). */
export type ApproverBoundFrom = typeof APPROVER_BOUND_FROM_LAUNCH_START | typeof APPROVER_BOUND_FROM_APPROVER_START

/** One approver log line: {@link APPROVER_LOG_PREFIX} and `message`. */
export function approverLogLine(message: string): string {
  return `${APPROVER_LOG_PREFIX}${message}`
}

/** The message (log line and start-pass entry) for a row that read `ended` or `missing`. */
export function approverFinishedMessage(ref: string, state: string): string {
  return `${ref} reads ${renderLogMessageText(state)}: the launch is over, so the approver stops with no pane read and the restart path decides (b.jg5 SRJ-402)`
}

/** The message for an absent row (`ErrSpawnNotFound`); no startup-errors entry is written for it. */
export function approverAbsentMessage(ref: string): string {
  return `${ref} has no row (ErrSpawnNotFound): the approver stops; nothing is read or typed (b.jg5 SRJ-402)`
}

/** The message for a `pending` row with no launch start that latched nothing. */
export function approverNoLaunchStartMessage(ref: string): string {
  return `${ref} reads pending with no launch start: the approver stops; nothing is read or typed (b.jg5 SRJ-401, SRJ-513)`
}

/** The message for a state that is neither `pending`, live nor finished: nothing is read or typed this lap. */
export function approverUnknownStateMessage(ref: string, state: string): string {
  return `${ref} reads the state ${JSON.stringify(renderLogMessageText(state))}, which is neither pending, live nor finished — nothing read or typed; polling on within the bound`
}

/**
 * The message for a refused `status` whose class keeps the approver polling
 * (UNAVAILABLE, CONFIG, UNCLASSIFIED or a STATE name the approver gives no
 * meaning; b.jg5 SRJ-404). `failure` is the error already described by the
 * caller through `describeAgentDirectorFailure` (redacted); the builder never
 * sees the raw error.
 */
export function approverStatusRefusedMessage(ref: string, failure: string): string {
  return `status of ${ref} failed: ${failure} — polling on within the bound`
}

/**
 * The message for a failed `read-pane` or `send-keys` whose class keeps the
 * approver polling (UNAVAILABLE, CONFIG, UNCLASSIFIED, `ErrSendKeysWhileRelayed`
 * included, or a STATE name the approver gives no meaning; b.jg5 SRJ-117,
 * SRJ-118). `failure` is the error already described by the caller through
 * `describeAgentDirectorFailure` (redacted); the builder never sees the raw
 * error.
 */
export function approverPaneCallFailedMessage(ref: string, verb: 'read-pane' | 'send-keys', failure: string): string {
  return `${verb} of ${ref} failed: ${failure} — polling on within the bound`
}

/** The message for a GONE answer, or `ErrSpawnNotFound` from a pane verb: the approver stops. `failure` is already described (redacted). */
export function approverGoneMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return `${verb} of ${ref} answered that the session is gone: ${failure} — the approver stops; nothing typed (b.jg5 SRJ-117, SRJ-118, SRJ-404)`
}

/**
 * The one line for `ErrSpawnNotInteractive` (b.jg5 SRJ-118, SRJ-404), naming
 * both possible causes. `failure` is already described (redacted).
 */
export function approverNotInteractiveMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return (
    `${verb} of ${ref} answered that the row is not interactive: ${failure} — the session holding the name is not this ` +
    `launch's (by its label's token), or the row has no launch start; the approver stops with nothing typed and nothing killed (b.jg5 SRJ-118, SRJ-404)`
  )
}

/** The message for ENVIRONMENT (`ErrTmuxNotAvailable`): the approver stops. `failure` is already described (redacted). */
export function approverTmuxUnavailableMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return `${verb} of ${ref} answered that tmux is not available: ${failure} — the approver stops; the tmux-unavailable outage is raised and nothing is counted (b.jg5 SRJ-311, SRJ-404)`
}

/**
 * The message for a CONFLICT answer: the persona latched (refused operation
 * "P's next check or recovery") and the approver stops. `failure` is already
 * described (redacted); `outcome` says what became of the latch.
 */
export function approverConflictMessage(ref: string, verb: ApproverVerb, failure: string, outcome: string): string {
  return `${verb} of ${ref} refused: ${failure} — CONFLICT: ${outcome}; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-501)`
}

/**
 * The message for an UNUSABLE NAME answer: the persona latched (refused
 * operation none) and the approver stops. `failure` is already described
 * (redacted); `outcome` says what became of the latch.
 */
export function approverUnusableNameMessage(ref: string, verb: ApproverVerb, failure: string, outcome: string): string {
  return `${verb} of ${ref} refused: ${failure} — UNUSABLE NAME: ${outcome}; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-512)`
}

/** The message for a persona found latched before a lap or after an awaited call: the approver stops with no further call. */
export function approverLatchedMessage(ref: string): string {
  return `${ref} is latched — the approver stops; nothing more is read or typed (b.jg5 SRJ-502)`
}

/** The message (log line and start-pass entry) at B: nothing is posted (b.jg5 SRJ-405). */
export function approverBoundMessage(ref: string, boundMs: number, measuredFrom: ApproverBoundFrom): string {
  return (
    `spawn never reached a live state within B (${boundMs}ms from ${measuredFrom}) for ${ref} — dialog unrecognized or session hung ` +
    `(dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}'); the approver stops and nothing is posted (b.jg5 SRJ-404, SRJ-405)`
  )
}

/** The message (log line and start-pass entry) at the test cap: nothing is posted (b.jg5 SRJ-405). */
export function approverCapMessage(ref: string, capMs: number): string {
  return (
    `spawn never reached a live state within ${capMs}ms for ${ref} — dialog unrecognized or session hung ` +
    `(dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}'); the approver stops at its cap and nothing is posted (b.jg5 SRJ-404, SRJ-405)`
  )
}

/** The message for a lap that read a launch start other than the one the approver kept: it stops with nothing typed. */
export function approverLaunchStartChangedMessage(ref: string): string {
  return `${ref} reads pending with a launch start other than the one this approver kept: the row belongs to a newer launch, whose own approver works on it — this approver stops; nothing read or typed (b.jg5 SRJ-401)`
}

/**
 * Why each requested stop happened, in {@link approverStopRequestedMessage}'s
 * line. Keyed by every {@link ApproverStopRequestReason}, so a new reason does
 * not compile without its text.
 */
const APPROVER_STOP_REQUEST_WHY: Readonly<Record<ApproverStopRequestReason, string>> = {
  [APPROVER_STOP_SUPERSEDED]: 'a later launch started its own approver',
  [APPROVER_STOP_TEARDOWN]: 'its teardown began',
  [APPROVER_STOP_SHUTDOWN]: 'the server is shutting down',
  [APPROVER_STOP_LATCHED]: 'the persona latched',
}

/** The message for a stop of a running approver (`stopDialogApprover`, `startDialogApprover` superseding one, the latch's set observer). */
export function approverStopRequestedMessage(ref: string, reason: ApproverStopRequestReason): string {
  return `stopping the approver for ${ref} (${reason}): ${APPROVER_STOP_REQUEST_WHY[reason]}; it makes no further call (b.jg5 SRJ-401, SRJ-404)`
}

/** The message for an approver not started because its persona was stopped while its launch was in flight, or after shutdown. */
export function approverNotStartedMessage(ref: string, reason: ApproverStopRequestReason): string {
  return `not starting the approver for ${ref} (${reason}): it was stopped before its launch returned; nothing read or typed (b.jg5 SRJ-404)`
}

/** The message for an approver whose loop threw. `failure` is already described (`describeThrownValue`). */
export function approverFailedMessage(ref: string, failure: string): string {
  return `the approver for ${ref} failed: ${failure} — it stops; nothing more is called`
}

/** Every pre-SessionStart dialog the approver answers (option 1 pre-selected; Enter accepts). Both kept: a folder-trust prompt can follow a `pre_trust` of `skipped` or `failed`. */
const PRE_SESSION_DIALOG_NEEDLES = [TRUST_DIALOG_NEEDLE, DEV_CHANNELS_DIALOG_NEEDLE]

/**
 * One armed time limit of an approver (B, or the cap): its reason, the start
 * it is measured from, the wait (B's accessor itself, so a value raised while
 * armed never ends it early), where B was measured from, and the cancel of
 * its never-early timer.
 */
interface ApproverLimit {
  readonly reason: ApproverLimitReason
  readonly fromMs: number
  readonly waitMs: () => number
  readonly measuredFrom: ApproverBoundFrom
  readonly cancel: () => void
}

/**
 * One approver's state, shared by its loop and its stops. The registry
 * (`startDialogApprover`) keeps one per running approver; a direct
 * `approvePreSessionDialogs` call makes its own.
 */
interface ApproverRun {
  /**
   * Set by the first stop asked of this approver (`stopDialogApprover`, a
   * later start, the latch's set observer, the reset seam): its reason. The
   * approver sets `latched` itself right before it latches the persona on
   * its own CONFLICT or UNUSABLE NAME answer, so the set observer finds it
   * already stopping.
   */
  stopRequested: ApproverStopRequestReason | undefined
  /** Set when B (or the cap) has passed: the approver stops before its next call. */
  limitReached: ApproverLimitReason | undefined
  /** The armed limit, while the loop runs. */
  limit: ApproverLimit | undefined
  /** Wakes the approver's sleep between laps, while it sleeps. */
  wake: (() => void) | undefined
  /**
   * The launch start (epoch ms) the first lap whose `status` read the row
   * `pending` with a launch start read (b.jg5 SRJ-401; hatch A2). A lap whose
   * `status` failed sets nothing.
   */
  launchStartMs: number | undefined
}

/** A fresh approver state: no stop asked, no limit armed, no launch start kept. */
function newApproverRun(): ApproverRun {
  return { stopRequested: undefined, limitReached: undefined, limit: undefined, wake: undefined, launchStartMs: undefined }
}

/** What one approver loop works with: the persona, its run and the clock it took at its start. */
interface ApproverContext {
  readonly key: string
  readonly isStartup: boolean
  readonly ref: string
  readonly at: OwnRowReadSite
  readonly run: ApproverRun
  readonly clock: ApproverClock
}

/**
 * Arm `run`'s time limit (`reason`, measured from `fromMs` with `waitMs`)
 * with `armNeverEarlyWait` on `clock`, replacing (and cancelling) any limit
 * armed before. The timer marks the limit reached and wakes any sleep.
 * `fromMs` is always a finite time here.
 */
function armApproverLimit(
  clock: ApproverClock,
  run: ApproverRun,
  reason: ApproverLimitReason,
  fromMs: number,
  waitMs: () => number,
  measuredFrom: ApproverBoundFrom,
): void {
  run.limit?.cancel()
  const cancel = armNeverEarlyWait(clock, fromMs, waitMs, () => markApproverLimit(run, reason))
  run.limit = { reason, fromMs, waitMs, measuredFrom, cancel }
}

/** Mark `run`'s limit reached (the first mark is kept) and wake its sleep. */
function markApproverLimit(run: ApproverRun, reason: ApproverLimitReason): void {
  if (run.limitReached !== undefined) return
  run.limitReached = reason
  run.wake?.()
}

/**
 * Why the approver must stop now, before its next call, or `undefined`: a
 * stop asked of it first, then its limit, checked with the timer's mark and
 * by a plain `elapsed >= wait` comparison against the wait in effect now (a
 * wait that cannot be read is not reached).
 */
function approverStopMark(ctx: ApproverContext): ApproverStopReason | undefined {
  const { run } = ctx
  if (run.stopRequested !== undefined) return run.stopRequested
  const limit = run.limit
  if (run.limitReached === undefined && limit !== undefined) {
    let waitMs: number
    try {
      waitMs = limit.waitMs()
    } catch {
      waitMs = Number.NaN
    }
    if (ctx.clock.now() - limit.fromMs >= waitMs) markApproverLimit(run, limit.reason)
  }
  return run.limitReached
}

/**
 * The stop mark (`approverStopMark`), else `latched` when the persona is
 * latched now (`personaLatchedNow`), after one line: a persona latched
 * before a lap, or while a call was awaited, gets no further call (b.jg5
 * SRJ-502). `undefined` to go on.
 */
function approverStopOrLatched(ctx: ApproverContext): ApproverStopReason | undefined {
  const mark = approverStopMark(ctx)
  if (mark !== undefined) return mark
  if (!personaLatchedNow(ctx.key)) return undefined
  console.error(approverLogLine(approverLatchedMessage(ctx.ref)))
  return APPROVER_STOP_LATCHED
}

/**
 * Drive a launched bot past its pre-SessionStart dialogs (folder-trust and
 * dev-channels) through agent-director only (b.jg5 SRJ-402). A launch,
 * fresh or resumed, reads `pending` until its session reports in (HO C5),
 * so every lap works on the `pending` row:
 *
 *   - before the lap, a persona already latched stops it with no call
 *     (`latched`, b.jg5 SRJ-502);
 *   - one own-row `status` read (`readPersonaOwnRowStatus`, which applies
 *     the own-row `status` step): a read that latched the persona stops the
 *     approver with nothing read or typed (`latched`); `ErrSpawnNotFound`
 *     stops it with one line and no startup-errors entry (`absent`); any
 *     other refusal takes the class rules below;
 *   - a live state other than `pending` stops it (`live`);
 *   - `ended` or `missing` stops it at once with no pane read and one line,
 *     and a start-pass launch writes `dev-channels-approve-spawn-died`
 *     (`finished`); the restart path decides what follows;
 *   - `pending` with no launch start (`isPendingWithNoLaunchStart`) that the
 *     read did not latch stops it with one line and nothing read or typed
 *     (`no-launch-start`); a configured persona's such row is latched by the
 *     read (`latched`), so this stop is reached only with no configured-persona
 *     query installed or one that does not answer `key` as configured;
 *   - `pending` with a launch start: the first such lap keeps that launch
 *     start, and B is re-armed from it; a later lap that reads another one
 *     stops the approver with one line and nothing read or typed
 *     (`superseded`, b.jg5 SRJ-401; hatch A2: the row belongs to a newer
 *     launch). Otherwise one `read-pane` (40 lines, `allow_pending`), and
 *     when the pane shows a needle of `PRE_SESSION_DIALOG_NEEDLES`, one
 *     `send-keys` with an empty text and `allow_pending`, which presses
 *     Enter.
 *
 * Each refused call is classified by class and name through
 * `src/ad-error-class.ts` (b.jg5 SRJ-117, SRJ-118, SRJ-404), with one line:
 *
 *   - GONE, or `ErrSpawnNotFound` from `read-pane` or `send-keys`: stop
 *     (`gone`);
 *   - `ErrSpawnNotInteractive`: stop with nothing typed and nothing killed
 *     (`not-interactive`);
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and the recorded state `pending` (unreadable for a `status`
 *     answer, which read none); stop (`latched`);
 *   - UNUSABLE NAME: the persona latches with the case "unusable recorded
 *     name" and the refused operation none (`latchOnUnusableName`), recorded
 *     `pending`; stop with nothing typed (`latched`);
 *   - ENVIRONMENT (`ErrTmuxNotAvailable`): stop (`tmux-unavailable`); the
 *     wrapper raised the outage, and nothing is counted;
 *   - UNAVAILABLE and CONFIG: poll on within B, the next lap at the slow
 *     pace (backing off; the wrapper raised `ad-config-malformed` for
 *     CONFIG and armed the persona's retry timer as from any verb);
 *   - anything else (UNCLASSIFIED, `ErrSendKeysWhileRelayed` included, or a
 *     STATE name the approver gives no meaning): poll on within B at the pace
 *     in effect.
 *
 * Every call names only the persona's `claude_instance_id`, and the server
 * runs no tmux command here; agent-director answers each call by the row's
 * current launch (HO rev 17). The pane a lap reads may be a single
 * leftover's: with no session of this launch there and exactly one leftover
 * of the persona, `read-pane` answers the leftover's pane (b.jg5 SRJ-117,
 * SRJ-613), so a needle on it is no proof that this launch's session shows
 * the dialog. The lap acts on it only through its Enter `send-keys`, which is
 * the backstop: on a `pending` row whose session is not this launch's (by its
 * label's token), it answers `ErrSpawnNotInteractive`, and the approver stops
 * with nothing typed, no kill and one log line (`not-interactive`, b.jg5
 * SRJ-404); a CONFLICT there latches the persona and stops it.
 *
 * Pace (b.jg5 SRJ-403): each lap starts at least `DIALOG_POLL_INTERVAL_MS`
 * after the previous lap's `read-pane` call (or, when the previous lap read
 * no pane, after its start), and `DIALOG_SLOW_POLL_INTERVAL_MS` after it
 * once G has passed since the launch start that lap's `status` read carried,
 * or after a lap that backed off (`approverPaceMs`). Two `read-pane` calls
 * are so never closer than the pace in effect, whatever the `status` reads
 * between them take.
 *
 * B (b.jg5 SRJ-210, SRJ-404): armed never-early (`armNeverEarlyWait` with
 * `adLaunchBoundMsInEffect` itself) from the approver's own start until a
 * lap keeps a launch start, then re-armed from that launch start; also
 * checked by a plain comparison before each call. While the test cap
 * (`_setDialogReadyTimeoutMs`) is set, the cap is armed from the approver's
 * own start in place of B. All of it runs on the approver's clock
 * (`_setApproverClock`). At B or the cap it logs one line and, for a
 * start-pass launch, writes `dev-channels-approve-not-ready`; nothing is
 * posted to any notifier (b.jg5 SRJ-405). Resolves with why it stopped;
 * never rejects.
 *
 * Production starts an approver only through the registry
 * (`startDialogApprover`), which runs it outside every launch or recovery
 * attempt and stops it on request; direct calls are for tests. A direct
 * call runs one approver outside the registry, so nothing can stop it but
 * its own rules, and outside every launch or recovery attempt
 * (`runOutsideAttempts`), whatever attempt the caller runs in.
 */
export async function approvePreSessionDialogs(
  key: string,
  isStartup: boolean,
  ref: string = keyRef(key),
): Promise<ApproverStopReason> {
  return runOutsideAttempts(() => runApproverLoop(key, isStartup, ref, newApproverRun()))
}

/**
 * The approver's loop (`approvePreSessionDialogs`) over `run`: a stop asked
 * of `run`, or its limit, wakes its sleep at once and is checked before each
 * agent-director call, so no call follows a stop; the approver then resolves
 * with the stop's reason. Never rejects.
 */
async function runApproverLoop(key: string, isStartup: boolean, ref: string, run: ApproverRun): Promise<ApproverStopReason> {
  const clock = _approverClock
  const capMs = _dialogReadyTimeoutMs
  const ctx: ApproverContext = {
    key,
    isStartup,
    ref,
    at: { site: APPROVER_LOG_SITE, what: APPROVER_STATUS_READ_WHAT, ref },
    run,
    clock,
  }
  const startMs = clock.now()
  if (capMs !== undefined) {
    armApproverLimit(clock, run, APPROVER_STOP_CAP, startMs, () => capMs, APPROVER_BOUND_FROM_APPROVER_START)
  } else {
    // b.jg5 E17 ruling: before any launch start is read, B runs from the approver's own start.
    armApproverLimit(clock, run, APPROVER_STOP_BOUND, startMs, adLaunchBoundMsInEffect, APPROVER_BOUND_FROM_APPROVER_START)
  }
  let reason: ApproverStopReason
  try {
    for (;;) {
      const lapStartMs = clock.now()
      const lap = await approverLap(ctx)
      if (typeof lap === 'string') {
        reason = lap
        break
      }
      const mark = approverStopMark(ctx)
      if (mark !== undefined) {
        reason = mark
        break
      }
      const paceMs = approverPaceMs(lap.backOff, lap.launchStartMs, clock.now(), adGraceMsInEffect())
      // b.jg5 SRJ-403: the pace runs from the lap's pane read, so the next
      // read (after the next lap's `status` read) is never closer than it.
      const paceFromMs = lap.paneReadAtMs ?? lapStartMs
      if (clock.now() - paceFromMs < paceMs) await sleepUntilNextLap(ctx, paceFromMs, paceMs)
    }
  } finally {
    run.wake = undefined
    run.limit?.cancel()
  }
  if (reason === APPROVER_STOP_BOUND || reason === APPROVER_STOP_CAP) approverLimitReached(ctx, reason, capMs)
  return reason
}

/**
 * Sleep from `fromMs` (the lap's pane read, or its start when it read no
 * pane) until `paceMs` has passed on the approver's clock (never early:
 * `armNeverEarlyWait`), or until a stop or the limit wakes it.
 */
function sleepUntilNextLap(ctx: ApproverContext, fromMs: number, paceMs: number): Promise<void> {
  const { run, clock } = ctx
  return new Promise<void>((resolve) => {
    const done = (): void => {
      run.wake = undefined
      resolve()
    }
    const cancel = armNeverEarlyWait(clock, fromMs, paceMs, done)
    run.wake = () => {
      cancel()
      done()
    }
  })
}

/**
 * At B or the cap (b.jg5 SRJ-405): one server-log line and, for a start-pass
 * launch, the `dev-channels-approve-not-ready` entry. Nothing is posted to
 * Slack.
 */
function approverLimitReached(ctx: ApproverContext, reason: ApproverLimitReason, capMs: number | undefined): void {
  const msg =
    reason === APPROVER_STOP_CAP && capMs !== undefined
      ? approverCapMessage(ctx.ref, capMs)
      : approverBoundMessage(
          ctx.ref,
          adLaunchBoundMsInEffect(),
          ctx.run.limit?.measuredFrom ?? APPROVER_BOUND_FROM_APPROVER_START,
        )
  console.error(approverLogLine(msg))
  if (ctx.isStartup) recordStartupError(STARTUP_ERROR_APPROVE_NOT_READY, msg)
}

/**
 * Keep `launchStartMs`, the first launch start a lap read (b.jg5 SRJ-401),
 * and re-arm B from it (b.jg5 E17 ruling: B runs from the approver's own
 * start only until a lap reads a launch start). The approver's start is
 * never earlier than the launch start, so the bound armed first was never
 * early. With the test cap set nothing is re-armed. `launchStartMs` is a
 * finite time (`parseLaunchStart`); a value that is not is never armed.
 */
function keepApproverLaunchStart(ctx: ApproverContext, launchStartMs: number): void {
  const { run } = ctx
  run.launchStartMs = launchStartMs
  if (!Number.isFinite(launchStartMs)) return
  if (run.limit === undefined || run.limit.reason !== APPROVER_STOP_BOUND) return
  armApproverLimit(ctx.clock, run, APPROVER_STOP_BOUND, launchStartMs, adLaunchBoundMsInEffect, APPROVER_BOUND_FROM_LAUNCH_START)
}

/**
 * How a lap that stops nothing ended: whether it backed off, the launch
 * start its `status` read carried, and when (on the approver's clock) it
 * made its `read-pane` call, `undefined` when it made none (b.jg5 SRJ-403:
 * the pace runs from it).
 */
interface ApproverLapGoesOn {
  readonly backOff: boolean
  readonly launchStartMs: number | undefined
  readonly paneReadAtMs: number | undefined
}

/** What the approver does with one refused call: stop with a reason, or poll on (backing off or not). */
type ApproverAnswer = { readonly stop: ApproverStopReason } | { readonly backOff: boolean }

/**
 * One approver lap (`approvePreSessionDialogs`): answers the stop reason, or
 * how the lap ended to poll on. A stop asked of the approver during a call
 * is answered as soon as that call returns, before anything else, except
 * that a pane call's CONFLICT or UNUSABLE NAME answer still latches the
 * persona first (`approverStoppedDuringCall`). Never throws.
 */
async function approverLap(ctx: ApproverContext): Promise<ApproverStopReason | ApproverLapGoesOn> {
  const { key, isStartup, ref, at, run } = ctx
  const before = approverStopOrLatched(ctx)
  if (before !== undefined) return before

  const read = await readPersonaOwnRowStatus(key, at)
  if (run.stopRequested !== undefined) return run.stopRequested
  if (read.kind === OWN_ROW_STATUS_LATCHED) return APPROVER_STOP_LATCHED // the step logged its line
  if (personaLatchedNow(key)) {
    console.error(approverLogLine(approverLatchedMessage(ref)))
    return APPROVER_STOP_LATCHED
  }
  if (read.kind === OWN_ROW_STATUS_ABSENT) {
    console.error(approverLogLine(approverAbsentMessage(ref)))
    return APPROVER_STOP_ABSENT
  }
  if (read.kind === OWN_ROW_STATUS_REFUSED) {
    // A failed read keeps no launch start (b.jg5 SRJ-401; hatch A2).
    const answer = approverAnswerTo(ctx, 'status', read.error)
    return 'stop' in answer ? answer.stop : { backOff: answer.backOff, launchStartMs: undefined, paneReadAtMs: undefined }
  }

  const state = read.state
  if (AGENT_DIRECTOR_DEAD_STATES.has(state)) {
    const msg = approverFinishedMessage(ref, state)
    console.error(approverLogLine(msg))
    if (isStartup) recordStartupError(STARTUP_ERROR_APPROVE_SPAWN_DIED, msg)
    return APPROVER_STOP_FINISHED
  }
  if (state !== AGENT_DIRECTOR_PENDING_STATE) {
    if (AGENT_DIRECTOR_LIVE_STATES.has(state)) return APPROVER_STOP_LIVE
    console.error(approverLogLine(approverUnknownStateMessage(ref, state)))
    return { backOff: false, launchStartMs: undefined, paneReadAtMs: undefined }
  }
  const launchStartMs = parseLaunchStart(read.launchStartedAt)
  if (launchStartMs === undefined) {
    // `pending` with no launch start, or one that does not parse (as `isPendingWithNoLaunchStart` reads it).
    console.error(approverLogLine(approverNoLaunchStartMessage(ref)))
    return APPROVER_STOP_NO_LAUNCH_START
  }
  // b.jg5 SRJ-401 (hatch A2): the first lap that reads a launch start keeps
  // it; a later one that reads another belongs to a newer launch.
  if (run.launchStartMs === undefined) {
    keepApproverLaunchStart(ctx, launchStartMs)
  } else if (run.launchStartMs !== launchStartMs) {
    console.error(approverLogLine(approverLaunchStartChangedMessage(ref)))
    return APPROVER_STOP_SUPERSEDED
  }
  const beforePane = approverStopMark(ctx)
  if (beforePane !== undefined) return beforePane

  const claude_instance_id = personaInstanceId(key)
  // b.jg5 SRJ-403: the next lap is paced from this pane read.
  const goesOn: ApproverLapGoesOn = { backOff: false, launchStartMs, paneReadAtMs: ctx.clock.now() }
  let pane: string
  try {
    const result = await withOutageDetection(key, undefined, 'read-pane', (client) =>
      client.readPane({ claude_instance_id, n_lines: APPROVER_PANE_LINES, allow_pending: true }),
    )
    pane = result.pane
  } catch (err) {
    if (run.stopRequested !== undefined) return approverStoppedDuringCall(ctx, 'read-pane', err, run.stopRequested)
    const answer = approverAnswerTo(ctx, 'read-pane', err)
    return 'stop' in answer ? answer.stop : { ...goesOn, backOff: answer.backOff }
  }
  const afterPane = approverStopOrLatched(ctx)
  if (afterPane !== undefined) return afterPane
  if (!PRE_SESSION_DIALOG_NEEDLES.some((n) => pane.includes(n))) return goesOn
  try {
    // An empty text presses Enter. The pane may be a single leftover's
    // (b.jg5 SRJ-613): this `send-keys` is the backstop, and its
    // `ErrSpawnNotInteractive` stops the approver with nothing typed and no
    // kill (SRJ-404).
    await withOutageDetection(key, undefined, 'send-keys', (client) =>
      client.sendKeys({ claude_instance_id, text: '', allow_pending: true }),
    )
  } catch (err) {
    if (run.stopRequested !== undefined) return approverStoppedDuringCall(ctx, 'send-keys', err, run.stopRequested)
    const answer = approverAnswerTo(ctx, 'send-keys', err)
    return 'stop' in answer ? answer.stop : { ...goesOn, backOff: answer.backOff }
  }
  if (run.stopRequested !== undefined) return run.stopRequested
  return goesOn
}

/**
 * The approver's one classification of a refused call (b.jg5 SRJ-117,
 * SRJ-118, SRJ-404), by class and name through `src/ad-error-class.ts`
 * (never `instanceof`), with one line from an exported builder carrying the
 * persona reference and the redacted description: see
 * `approvePreSessionDialogs` for the table. A `status` read's
 * `ErrSpawnNotFound` and UNUSABLE NAME answers never reach here (the shared
 * read answers absent and latched). Never throws.
 */
function approverAnswerTo(ctx: ApproverContext, verb: ApproverVerb, err: unknown): ApproverAnswer {
  const { ref } = ctx
  const { errorClass } = classifyAdError(err)
  const failure = describeAgentDirectorFailure(err)
  if (errorClass === AD_ERROR_CLASS_GONE || (verb !== 'status' && hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME))) {
    console.error(approverLogLine(approverGoneMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_GONE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_INTERACTIVE_NAME)) {
    console.error(approverLogLine(approverNotInteractiveMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_NOT_INTERACTIVE }
  }
  if (approverLatchOn(ctx, verb, err, errorClass, failure)) return { stop: APPROVER_STOP_LATCHED }
  if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
    console.error(approverLogLine(approverTmuxUnavailableMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_TMUX_UNAVAILABLE }
  }
  const message =
    verb === 'status' ? approverStatusRefusedMessage(ref, failure) : approverPaneCallFailedMessage(ref, verb, failure)
  console.error(approverLogLine(message))
  // CONFIG is taken as the UNAVAILABLE column (b.jg5 SRJ-117, SRJ-118): both back off.
  return { backOff: errorClass === AD_ERROR_CLASS_UNAVAILABLE || errorClass === AD_ERROR_CLASS_CONFIG }
}

/**
 * The two classes that latch at the approver (b.jg5 SRJ-117, SRJ-118):
 * for a CONFLICT or UNUSABLE NAME answer `err` to `verb` (`errorClass`, with
 * `failure` its redacted description), latch the persona through the
 * installed latch's entry for the class and log one line carrying what
 * became of the latch. The approver is marked stopping (`latched`) first
 * unless a stop was already asked, so the latch's set observer finds it
 * stopping. Answers whether `err` was of either class; for any other class
 * it does nothing. Never throws.
 */
function approverLatchOn(
  ctx: ApproverContext,
  verb: ApproverVerb,
  err: unknown,
  errorClass: AdErrorClass,
  failure: string,
): boolean {
  const { ref } = ctx
  if (errorClass === AD_ERROR_CLASS_CONFLICT) {
    // The latch is set first; its line then carries what became of it.
    logApproverLine(approverConflictMessage(ref, verb, failure, approverLatchOnConflict(ctx, verb, err)))
    return true
  }
  if (errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    ctx.run.stopRequested ??= APPROVER_STOP_LATCHED // the latch's set observer then finds it stopping
    logApproverLine(approverUnusableNameMessage(ref, verb, failure, latchOnUnusableName(ctx.key, err, approverLatchRowState(verb))))
    return true
  }
  return false
}

/**
 * A pane call (`verb`) refused with `err` after a stop was asked of the
 * approver (`requested`: superseded, latched, teardown or shutdown) while
 * the call was in progress. A CONFLICT or UNUSABLE NAME answer still latches
 * the persona with its one line (`approverLatchOn`; a persona already
 * latched answers as the latch's entry does for a same-case set); every
 * other answer is dropped with no line. Either way the approver honours the
 * stop already asked, answering its reason, and types nothing more. Never
 * throws.
 */
function approverStoppedDuringCall(
  ctx: ApproverContext,
  verb: ApproverVerb,
  err: unknown,
  requested: ApproverStopRequestReason,
): ApproverStopReason {
  const { errorClass } = classifyAdError(err)
  if (errorClass === AD_ERROR_CLASS_CONFLICT || errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    approverLatchOn(ctx, verb, err, errorClass, describeAgentDirectorFailure(err))
  }
  return requested
}

/** One approver line (`approverLogLine`) to the server log; `message` comes from an exported builder. */
function logApproverLine(message: string): void {
  console.error(approverLogLine(message))
}

/** The latch line's outcome text for what `setFromConflict` answered (`undefined`: the value was not CONFLICT, so nothing latched). */
function conflictSetOutcomeText(outcome: ConflictLatchSetOutcome | undefined): string {
  return outcome === undefined ? 'nothing is latched (the answer is not CONFLICT)' : LATCH_SET_OUTCOME_TEXT[outcome]
}

/**
 * The row state a latch records for the approver's answer to `verb` (b.jg5
 * SRJ-501): `pending`, which the lap's `status` read before a pane verb;
 * unreadable for a `status` answer, which read no state.
 */
function approverLatchRowState(verb: ApproverVerb): LatchRowState {
  return verb === 'status' ? LATCH_ROW_STATE_UNREADABLE : latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
}

/**
 * Latch the persona on the approver's CONFLICT answer `err` to `verb`
 * (b.jg5 SRJ-501): the installed latch's CONFLICT entry (`setFromConflict`)
 * with the refused operation "P's next check or recovery" and the recorded
 * state (`approverLatchRowState`). The approver is marked stopping
 * (`latched`) first, so the latch's set observer finds it already stopping.
 * Answers the latch line's outcome text: the set's outcome, that no latch is
 * installed, or that latching failed and what it threw. Logs nothing; never
 * throws.
 */
function approverLatchOnConflict(ctx: ApproverContext, verb: ApproverVerb, err: unknown): string {
  ctx.run.stopRequested ??= APPROVER_STOP_LATCHED
  return latchOnConflict(ctx.key, err, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, approverLatchRowState(verb))
}

// ---------------------------------------------------------------------------
// waitForWaitingAndReconnect — used when a colliding spawn is in `working`
// ---------------------------------------------------------------------------

/** Hard cap on the wait-for-waiting poller (10 minutes). Test-only override below. */
export const WAIT_FOR_WAITING_TIMEOUT_MS = 10 * 60 * 1000

let _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS

/** Test-only seam: override the wait-for-waiting timeout. */
export function _setWaitForWaitingTimeoutMs(ms: number): void {
  _waitForWaitingTimeoutMs = ms
}

/** Test-only seam: restore the default. */
export function _resetWaitForWaitingTimeoutMs(): void {
  _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS
}

/**
 * The clock of the `working`-row wait and evidence (b.f2b):
 * `waitForWaitingAndReconnect`'s deadline and loop, the launch wait's
 * evidence reads (`staleWorkingRowIsIdle`) and the restart path's fold
 * (`checkWorkingRowPane`), pane and transcript alike, and the findMissing
 * memo's window (`sharedFindMissingSweep`, `FIND_MISSING_MEMO_TTL_MS`).
 * Test-only override below.
 */
let _now: () => number = () => Date.now()

/** Test-only seam: override the clock of the `working`-row wait and evidence and of the findMissing memo (a suite passes `createFakeClock().now`). */
export function _setNow(now: () => number): void {
  _now = now
}

/** Test-only seam: restore the real clock. */
export function _resetNow(): void {
  _now = () => Date.now()
}

// ---------------------------------------------------------------------------
// Stale `working` rows (b.f2b) — evidence from the persona's pane and transcript
// ---------------------------------------------------------------------------

/**
 * How long a `working` row's idle evidence must hold, or its pane keep showing
 * a prompt, before `waitForWaitingAndReconnect` at a launch, or the restart
 * path's reconnect adapter across its attempts (`checkWorkingRowPane`), acts
 * on it (b.f2b): it reconnects the stale row, or reports the prompt. Idle
 * evidence is the positive-idle rule of `foldWorkingPaneRun`: at every read
 * across the window, the pane shows the same idle screen AND the session's
 * transcript ends with a completed turn, unchanged. Test-only override below.
 */
export const STALE_WORKING_WINDOW_MS = 60_000

let _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS

/** Test-only seam: override the stale-`working` evidence window. */
export function _setStaleWorkingWindowMs(ms: number): void {
  _staleWorkingWindowMs = ms
}

/** Test-only seam: restore the default stale-`working` evidence window. */
export function _resetStaleWorkingWindowMs(): void {
  _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS
}

/**
 * How often the launch wait reads a `working` row's evidence (b.f2b): its
 * pane and, when that shows an idle screen, its agent-director row and
 * transcript. Every agent-director call goes through its one queue, shared by
 * every persona, so the wait reads at this cadence rather than on each status
 * poll. Test-only override below.
 */
export const WORKING_ROW_READ_INTERVAL_MS = 5_000

let _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS

/** Test-only seam: override how often the launch wait reads a `working` row's evidence. */
export function _setWorkingRowReadIntervalMs(ms: number): void {
  _workingRowReadIntervalMs = ms
}

/** Test-only seam: restore the default evidence read interval. */
export function _resetWorkingRowReadIntervalMs(): void {
  _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS
}

/**
 * How long CSCB holds back from a persona whose row reads `working`, typing
 * nothing because it can't prove the session idle, before it reports the
 * persona through the `unproven-idle` not-connected notice (b.f2b), whatever
 * `session_restart_delay` is: measured from the first deferral of the run
 * (`noteWorkingRowDeferral`). Without it, a row whose idleness can't be proven
 * (an unreadable transcript, a compaction summary, a screen that keeps
 * changing) would be held back from for good, silently. Test-only override
 * below.
 */
export const UNPROVEN_IDLE_NOTICE_AFTER_MS = 10 * 60 * 1000

let _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS

/** Test-only seam: override how long deferrals on a `working` row run before the `unproven-idle` notice. */
export function _setUnprovenIdleNoticeAfterMs(ms: number): void {
  _unprovenIdleNoticeAfterMs = ms
}

/** Test-only seam: restore the default. */
export function _resetUnprovenIdleNoticeAfterMs(): void {
  _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS
}

/** The pane's last lines with text: Claude Code's prompt box, footer and any dialog are drawn there. */
const WORKING_PANE_BOTTOM_LINES = 12

/**
 * Claude Code's spinner line while a turn runs (2.1.280), matched only in its
 * own shape: at column 0 a spinner glyph, a space, the spinner's message, an
 * ellipsis, then the end of the line or ` (` and the turn's status (elapsed
 * time, tokens, thinking), e.g. `✳ Harmonizing… (2m 42s · ↓ 10.1k tokens)`.
 * The message holds no ellipsis and is short: a verb from Claude Code's list
 * (`Harmonizing`, `Fiddle-faddling`), a custom one from the `spinnerVerbs`
 * setting, which can be several words (`🐝 Buzzing about the hive`), or the
 * current task's `activeForm`. The status is left out at first, and in
 * screen-reader mode. The animated glyphs (`·` `✢` `✳` `✶` `✻` `✽`, and `*`
 * on some terminals) start no other line with an ellipsis: a finished turn's
 * line (`✻ Baked for 4m 11s`) has none, and text quoted in a reply is
 * indented.
 * `●` (U+25CF) is the glyph with prefersReducedMotion, but on Linux Claude
 * Code also draws it at column 0 before every reply and tool call (macOS draws
 * `⏺` there), and those lines can hold an ellipsis. So a `●` line counts only
 * as a single word and an ellipsis ending the line, or as any message whose
 * ellipsis is followed by ` (` and a status that starts with an elapsed time,
 * a token arrow or `thinking`/`thought for`; `● Let me check the logs…`,
 * `● Checked the build… (see the thread)` and `● Bash(ls …)` do not. Verified
 * (2026-09-26) against the 2.1.280 binary and live panes, which show custom
 * verbs of an emoji and three words with their status, and `●` reply and tool
 * lines. 2.1.280 no longer prints "esc to interrupt" while a turn runs.
 */
const BUSY_SPINNER_LINE_RE =
  /^(?:[·✢✳✶✻✽*] [^\s…][^…\n]{0,79}…(?: \(.*)?|● [\p{L}\p{M}'’-]{1,40}…|● [^\s…][^…\n]{0,79}… \((?:\d+(?:\.\d+)?[smhd]\b|[↓↑] |thinking|thought for ).*)$/mu

/**
 * Busy hints in the pane's bottom lines, matched case-insensitively: the
 * "esc to interrupt" hint of earlier Claude Code versions and of the
 * capacity-retry line ("to interrupt" also covers a rebound key), and a turn
 * paused on a usage limit ("continuing automatically at … · esc to cancel").
 */
const BUSY_PANE_NEEDLES = ['to interrupt', 'esc to cancel']

/**
 * The static rows Claude Code 2.1.280 draws instead of the spinner while a
 * turn waits on the API, with no glyph, no timer and no interrupt hint,
 * matched case-insensitively in the pane's bottom lines (b.f2b): "No response
 * from the API after 2m · retrying, waiting up to 5m · attempt 2/10" and its
 * fixed second line "A proxy or gateway that buffers…", "Rate limit reached ·
 * Retrying in 7m (resets …) · attempt n/m" (the countdown shows whole minutes
 * from 5 m up, so the row can stay the same for a minute or more), and
 * "Waiting for API response · will retry in …". Each is anchored on Claude
 * Code's own `·` separator or fixed wording, so a reply that mentions a retry
 * does not read busy.
 */
const BUSY_API_RETRY_ROWS: readonly RegExp[] = [
  /no response from the api after [^\n]*·\s*retrying/i,
  /a proxy or gateway that buffers/i,
  /rate limit reached\s*·\s*retrying in/i,
  /waiting for api response\s*·\s*will retry in/i,
  /·\s*attempt \d+\/\d+/i,
]

/**
 * A numbered option line of a Claude Code dialog (2.1.280), its box side
 * (`│`) dropped: an optional `❯` selection cursor, the option's number, a
 * period and its label, e.g. `❯ 1. Yes` or `2. No, and tell Claude what to do
 * differently (esc)`. Group 2 is the number.
 */
const DIALOG_OPTION_LINE_RE = /^(❯\s*)?(\d+)\.\s+\S/

/**
 * Option labels and footers that mark a Claude Code dialog (2.1.280), matched
 * case-insensitively on its option list and the lines below it: the deny
 * option of every tool-permission dialog, the select-menu footers
 * (AskUserQuestion and other pickers) and the pre-session dialogs' options.
 */
const DIALOG_NEEDLES = [
  'tell Claude what to do differently',
  'Enter to select',
  'Enter to confirm',
  ...PRE_SESSION_DIALOG_NEEDLES,
].map((needle) => needle.toLowerCase())

/** What a pane read from a `working` row shows (b.f2b). */
export type WorkingPaneReading = 'prompt' | 'busy' | 'idle' | 'blank'

/** The pane's lines without trailing spaces, and without the blank lines after its last text. */
function paneLines(pane: string): string[] {
  const lines = pane.split('\n').map((line) => line.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A pane line's text with a dialog box's sides (`│`) dropped, and whether it had a left side. */
function dialogRow(line: string): { text: string; boxed: boolean } {
  const trimmed = line.trim()
  const boxed = trimmed.startsWith('│')
  const text = (boxed ? trimmed.slice(1) : trimmed).replace(/│$/, '').trim()
  return { text, boxed }
}

/**
 * Whether the pane's bottom lines show a Claude Code dialog (b.f2b), anchored
 * to its layout, so an idle screen whose last reply merely quotes a dialog's
 * wording does not count: a numbered option list (an option `1.` and, below
 * it, an option `2.`; description lines may sit between them) with the `❯`
 * selection cursor on one of its options, and, to anchor it, a question line
 * (ending in `?`) above the list, a dialog option or footer
 * (`DIALOG_NEEDLES`) on or below it, or its options drawn inside the dialog's
 * box (`│`).
 */
function paneShowsDialog(bottom: readonly string[]): boolean {
  const rows = bottom.map(dialogRow)
  const optionNumber = (text: string): string | undefined => DIALOG_OPTION_LINE_RE.exec(text)?.[2]
  const first = rows.findIndex((row) => optionNumber(row.text) === '1')
  if (first < 0) return false
  const below = rows.slice(first)
  const options = below.filter((row) => optionNumber(row.text) !== undefined)
  if (!options.some((row) => optionNumber(row.text) === '2')) return false
  if (!options.some((row) => row.text.startsWith('❯'))) return false
  return (
    rows.slice(0, first).some((row) => row.text.endsWith('?')) ||
    below.some((row) => DIALOG_NEEDLES.some((needle) => row.text.toLowerCase().includes(needle))) ||
    options.some((row) => row.boxed)
  )
}

/**
 * Classify a pane read from a `working` (or `waiting`) row (b.f2b): `prompt`
 * when its bottom lines show a dialog (`paneShowsDialog`); else `busy` when it
 * shows Claude Code's spinner line anywhere, or a busy hint or an API retry
 * row in its bottom lines; `blank` when it holds no text; otherwise `idle`. A
 * prompt wins over a busy sign, since a dialog may sit under a running turn's
 * spinner: either way nothing is typed. `idle` is no proof the session is
 * idle: the stale-row rule also needs the transcript (`foldWorkingPaneRun`).
 * Pure.
 */
export function classifyWorkingPane(pane: string): WorkingPaneReading {
  const lines = paneLines(pane)
  if (lines.length === 0) return 'blank'
  const bottomLines = lines.slice(-WORKING_PANE_BOTTOM_LINES)
  if (paneShowsDialog(bottomLines)) return 'prompt'
  if (BUSY_SPINNER_LINE_RE.test(lines.join('\n'))) return 'busy'
  const bottom = bottomLines.join('\n').toLowerCase()
  if (BUSY_PANE_NEEDLES.some((needle) => bottom.includes(needle))) return 'busy'
  if (BUSY_API_RETRY_ROWS.some((row) => row.test(bottom))) return 'busy'
  return 'idle'
}

/** A run of consecutive evidence reads of a `working` row that agree (b.f2b). */
export interface WorkingPaneRun {
  /**
   * `idle`: every read showed the same idle screen and the same, unchanged
   * transcript ending with a completed turn; `prompt`: every read showed a
   * prompt or dialog.
   */
  reading: 'idle' | 'prompt'
  /** The run's first screen (its lines, trailing spaces dropped): an idle run lasts only while it is unchanged. */
  screen: string
  /** An idle run's transcript as its first read saw it: the run lasts only while every read sees it unchanged. */
  transcript?: TranscriptSnapshot
  /** When the run started (epoch ms, the session manager's clock `_now`). */
  since: number
}

/**
 * Fold one evidence read into the current run (b.f2b). This is the
 * positive-idle rule: a pane alone is never idle evidence.
 * - `pane` undefined (the read failed), a `busy` or a `blank` pane ends the
 *   run: no evidence.
 * - A `prompt` pane continues a prompt run, or starts one at `now`; the
 *   transcript plays no part (nothing is typed into a prompt either way).
 * - An `idle` pane is evidence only together with `transcript`, the session's
 *   transcript read with it, ending with a completed turn (`ended`, see
 *   `transcriptTailTurnState`). A transcript that doesn't, can't be located or
 *   read, or wasn't read ends the run. An idle run continues only while both
 *   the screen and the transcript's snapshot (path, device, inode, size,
 *   mtime) are unchanged; otherwise a new idle run starts at `now`.
 * So a row is stale only once the same idle screen and the same ended,
 * unchanged transcript were read at every read across the window. A live
 * turn, an API retry included, never ends its transcript with a completed
 * turn, so it never gives idle evidence, however still its screen. Pure.
 */
export function foldWorkingPaneRun(
  run: WorkingPaneRun | undefined,
  pane: string | undefined,
  now: number,
  transcript?: TranscriptReading,
): WorkingPaneRun | undefined {
  if (pane === undefined) return undefined
  const reading = classifyWorkingPane(pane)
  const screen = paneLines(pane).join('\n')
  if (reading === 'prompt') return run?.reading === 'prompt' ? run : { reading, screen, since: now }
  if (reading !== 'idle' || transcript === undefined || transcript.kind !== 'ended') return undefined
  const unchanged =
    run?.reading === 'idle' &&
    run.screen === screen &&
    run.transcript !== undefined &&
    sameTranscriptSnapshot(run.transcript, transcript.snapshot)
  return unchanged ? run : { reading, screen, transcript: transcript.snapshot, since: now }
}

/** One evidence read of a `working` row (b.f2b). */
interface WorkingRowRead {
  /** The pane; undefined when the read failed, or when the persona latched. */
  pane: string | undefined
  /**
   * The pane read's failure outcome (`src/pane-read.ts`: its class and its
   * token-safe description); set only when the read failed and latched
   * nothing. An UNCLASSIFIED here carries the reader's stop mark
   * (`stopping`) when its version re-check decided that the server stops.
   */
  paneFailure?: PaneReadFailure
  /** The session's transcript, read only when the pane shows an idle screen. */
  transcript?: TranscriptReading
  /**
   * b.jg5 SRJ-501: the row state the transcript `get` read (no row for
   * `ErrSpawnNotFound`, unreadable for an UNUSABLE NAME answer), when it was
   * made and gave one: the path's last read of the row from then on.
   */
  rowRead?: LatchRowState
  /**
   * b.jg5 SRJ-502: the persona is latched after one of the read's
   * agent-director calls (its pane read or its transcript `get` latched it,
   * or it was latched elsewhere). No evidence: the caller calls nothing more
   * and types nothing.
   */
  latched?: true
}

/** The evidence read of a persona that is latched (`WorkingRowRead.latched`). */
const WORKING_ROW_READ_LATCHED: WorkingRowRead = Object.freeze({ pane: undefined, latched: true })

/**
 * True when persona `key` is latched now, by the installed latch (b.jg5
 * SRJ-502): a latched query that throws, or a latched persona whose record
 * cannot be read, counts as latched (`latchGateReadingOf`). False with no
 * latch installed. Logs nothing; never throws.
 */
function personaLatchedNow(key: string): boolean {
  return latchGateReadingOf(key) !== undefined
}

/**
 * Asked right after one of persona `key`'s own-row reads (`what` at `site`)
 * that did not itself latch it (b.jg5 SRJ-502): true when the persona is
 * latched now (`personaLatchedNow`), latched elsewhere while the read was
 * awaited (the health tick reads even while a launch is in flight, b.jg5
 * SRJ-315), after logging one line; the caller then calls nothing more for
 * it. False otherwise, with nothing logged. Never throws.
 *
 *   [slack] <site>: <ref> is latched after its <what> — nothing more is called for it (b.jg5 SRJ-502)
 */
function latchedAfterOwnRowRead(key: string, site: string, what: string, ref: string): boolean {
  if (!personaLatchedNow(key)) return false
  console.error(`[slack] ${site}: ${ref} is latched after its ${what} — nothing more is called for it (b.jg5 SRJ-502)`)
  return true
}

/**
 * Read persona `key`'s pane (`readWorkingPane`, whose CONFLICT or UNUSABLE
 * NAME answer latches the persona with `lastRead`, the row state the calling
 * path last read) and, only when it shows an idle screen, its transcript
 * (`readIdlePaneTranscript`), for one evidence read of the launch wait
 * (b.f2b). After the pane read it asks whether the persona is latched
 * (`personaLatchedNow`, or a read that latched it), and then answers
 * `WORKING_ROW_READ_LATCHED` with nothing more read (b.jg5 SRJ-502). A
 * failed pane read that latched nothing is carried as its outcome
 * (`paneFailure`). Never throws.
 */
async function readWorkingRowEvidence(
  key: string,
  configDir: string | undefined,
  lastRead: LatchRowState,
): Promise<WorkingRowRead> {
  const read = await readWorkingPane(key, lastRead)
  if (read.kind === PANE_READ_LATCHED || personaLatchedNow(key)) return WORKING_ROW_READ_LATCHED
  if (read.kind !== PANE_READ_PANE) return { pane: undefined, paneFailure: read }
  return readIdlePaneTranscript(key, read.pane, configDir)
}

/**
 * The rest of one evidence read of persona `key`'s `working` row once its
 * `pane` has been read (b.f2b): the transcript (`readPersonaTranscript`, one
 * `get` of its own row) only when the pane shows an idle screen. After the
 * transcript `get` it asks whether the persona is latched (the `get` latched
 * it, or `personaLatchedNow`), and then answers `WORKING_ROW_READ_LATCHED`
 * (b.jg5 SRJ-502), carrying the state the `get` read when it gave one.
 * Never throws.
 */
async function readIdlePaneTranscript(key: string, pane: string, configDir: string | undefined): Promise<WorkingRowRead> {
  if (classifyWorkingPane(pane) !== 'idle') return { pane }
  const { transcript, rowRead } = await readPersonaTranscript(key, configDir)
  const tracked = rowRead === undefined ? {} : { rowRead }
  if (transcript.kind === PERSONA_TRANSCRIPT_LATCHED || personaLatchedNow(key)) {
    return { ...WORKING_ROW_READ_LATCHED, ...tracked }
  }
  return { pane, transcript, ...tracked }
}

/**
 * Read the last `FULL_PANE_READ_LINES` lines of persona `key`'s pane (b.f2b)
 * through the shared read-pane of its own row (`readPersonaOwnPane`, b.jg5
 * SRJ-117), answering its outcome. A CONFLICT or UNUSABLE NAME answer
 * latches the persona with `lastRead`, the row state the calling path last
 * read (the launch wait's last read, or the `waiting` state the restart
 * path's check was called for), and a persona already latched is not read:
 * either way the outcome is latched, and the caller ends what it was doing
 * with nothing typed (b.jg5 SRJ-501, SRJ-502, SRJ-512). A pane it answers
 * may be a single leftover's (b.jg5 SRJ-613): its callers (the launch wait's
 * evidence read and `checkWaitingRowPane`) act on it only through the
 * reconnect, whose `send-keys` is the backstop (`reconnectMcpWithCause`).
 * Never throws.
 */
async function readWorkingPane(key: string, lastRead: LatchRowState): Promise<OwnPaneReadOutcome> {
  return readPersonaOwnPane(key, { nLines: FULL_PANE_READ_LINES, lastRead, site: 'readWorkingPane' })
}

/**
 * The effective claude_config_dir of `persona`, absolute (`<home>/.claude`
 * when none is set), for composing its transcript's path (b.f2b); undefined
 * when the persona isn't known, and then only the row's persisted path is
 * used (`locateTranscript`).
 */
function transcriptConfigDir(persona: Pick<Persona, 'claude_config_dir'> | undefined): string | undefined {
  return persona === undefined ? undefined : resolveClaudeConfigDir(persona.claude_config_dir, spawnHomeDir())
}

/** `readPersonaTranscript`'s answer when its `get` latched the persona (b.jg5 SRJ-114, SRJ-512). */
const PERSONA_TRANSCRIPT_LATCHED = 'latched'

/** A transcript reading, or that its `get` latched the persona. */
type PersonaTranscriptReading = TranscriptReading | { kind: typeof PERSONA_TRANSCRIPT_LATCHED }

/**
 * What `readPersonaTranscript` answers: the reading, and the row state its
 * `get` read (b.jg5 SRJ-501), when it gave one.
 */
interface PersonaTranscriptRead {
  readonly transcript: PersonaTranscriptReading
  readonly rowRead?: LatchRowState
}

/**
 * Read persona `key`'s transcript for idle evidence (b.f2b): fetch its
 * agent-director row through the shared own-row read (`readPersonaOwnRow`,
 * one `get`, b.jg5 SRJ-114), locate the transcript of the row's session
 * (`locateTranscript`: the persisted `jsonl_path`, else the path composed
 * under `configDir`) and read its turn state (`readTranscriptTurnState`). A
 * `get` that latched the persona (its own row reading `pending` with no
 * launch start, b.jg5 SRJ-513, a latching note, or an UNUSABLE NAME
 * answer, b.jg5 SRJ-512) answers `latched`, and nothing more is read: no
 * evidence. An absent row (`ErrSpawnNotFound`), a failed `get`, a row that
 * names no transcript, or a file that can't be read is `unreadable`, with a
 * token-safe reason: no evidence. Beside the reading it answers the row
 * state the `get` read (`rowRead`, b.jg5 SRJ-501: the state of a row, no row
 * for an absent one, unreadable for an UNUSABLE NAME answer; none for a
 * failed `get`), so the caller tracks it as the path's last read. Never
 * throws.
 */
async function readPersonaTranscript(key: string, configDir: string | undefined): Promise<PersonaTranscriptRead> {
  const read = await readPersonaOwnRow(key, { site: 'readPersonaTranscript', what: 'transcript get' })
  if (read.kind === OWN_ROW_READ_LATCHED) {
    return { transcript: { kind: PERSONA_TRANSCRIPT_LATCHED }, rowRead: LATCH_ROW_STATE_UNREADABLE }
  }
  if (read.kind === OWN_ROW_READ_ABSENT) {
    return {
      transcript: { kind: 'unreadable', reason: 'its agent-director row is absent (ErrSpawnNotFound)' },
      rowRead: LATCH_ROW_STATE_NO_ROW,
    }
  }
  if (read.kind === OWN_ROW_READ_REFUSED) {
    return {
      transcript: { kind: 'unreadable', reason: `reading its agent-director row failed: ${describeAgentDirectorFailure(read.error)}` },
    }
  }
  const { row } = read
  const rowRead = latchRowStateRead(row.state)
  if (read.latched) return { transcript: { kind: PERSONA_TRANSCRIPT_LATCHED }, rowRead }
  const path = locateTranscript(row, configDir)
  if (path === undefined) {
    return { transcript: { kind: 'unreadable', reason: 'its agent-director row names no transcript for its session' }, rowRead }
  }
  const reading = readTranscriptTurnState(path)
  return {
    transcript: reading.kind === 'unreadable' ? { kind: 'unreadable', reason: `"${path}": ${reading.reason}` } : reading,
    rowRead,
  }
}

/**
 * Why a transcript read with an idle pane gives no idle evidence (b.f2b), for
 * a log line; undefined when it was not read or ends with a completed turn.
 */
function transcriptNoEvidence(transcript: TranscriptReading | undefined): string | undefined {
  if (transcript === undefined) return undefined
  if (transcript.kind === 'unreadable') return `its transcript can't be read: ${transcript.reason}`
  return transcript.kind === 'open' ? `its transcript "${transcript.snapshot.path}" does not end with a completed turn` : undefined
}

/**
 * `staleWorkingRowIsIdle`'s answer when its pane read's version re-check
 * decided that the server stops (b.jg5 SRJ-205).
 */
const WORKING_EVIDENCE_STOPPING = 'stopping'

/** One launch wait's evidence for a `working` row (b.f2b). */
interface WorkingPaneWatch {
  run: WorkingPaneRun | undefined
  /** When the wait last read the evidence (`_now`); undefined before its first read. */
  lastReadAt: number | undefined
  /** The first failed pane read was logged (later ones are not, for the rest of the wait). */
  readFailureLogged: boolean
  /** The last reason an idle pane's transcript gave no evidence, as logged: a changed reason is logged again. */
  transcriptNote: string | undefined
  /** A prompt run reached the window: logged and reported once for the wait. */
  promptReported: boolean
}

/**
 * The launch wait's evidence check for persona `key`'s `working` row (b.f2b),
 * called on every status poll. It reads the evidence only once
 * `WORKING_ROW_READ_INTERVAL_MS` has passed since its last read (the first
 * poll reads at once), and folds it into the wait's run (`foldWorkingPaneRun`).
 * True once the idle evidence has held for the whole window: the pane has
 * shown the same idle screen and the transcript has ended with a completed
 * turn, unchanged, at every read. The row is stale and the caller reconnects
 * it. A prompt shown for the window is logged and reported (once per wait,
 * through the not-connected notice) and the wait goes on; nothing is typed
 * into it. A failed pane read or an idle pane whose transcript gives no
 * evidence ends the run; the wait's first pane failure and each new
 * transcript reason are logged, and the wait goes on as before.
 * `latched` when the persona is latched after the read's pane or transcript
 * read (b.jg5 SRJ-502, `WorkingRowRead.latched`; a pane read's CONFLICT or
 * UNUSABLE NAME answer latches it with the wait's last read, b.jg5 SRJ-117,
 * SRJ-501, SRJ-512, SRJ-608, and a latched persona's pane is not read):
 * nothing is logged, folded or reported, and the wait ends with nothing
 * typed. `stopping` (`WORKING_EVIDENCE_STOPPING`) when the pane read's
 * UNCLASSIFIED carries the stop mark (b.jg5 SRJ-205: the shared reader's
 * `ErrInvalidFlags` re-check decided that the server stops): one line,
 * nothing folded or reported, and the wait ends with nothing typed. Every
 * other failed pane read (GONE, an absent row, UNAVAILABLE, ENVIRONMENT,
 * CONFIG, UNCLASSIFIED) is no evidence (b.jg5 SRJ-117, SRJ-608). The state
 * the transcript `get` read, when it was made, becomes the wait's last read
 * (`wait.lastRead`, b.jg5 SRJ-501).
 *
 * The pane may be a single leftover's (b.jg5 SRJ-117, SRJ-613: with no
 * session of the row's current launch there and exactly one leftover of the
 * persona, agent-director answers the leftover's pane), so it is no proof
 * that the worker's own session is there: a pane only feeds the fold, which
 * also needs the transcript. When the fold shows the row stale, the wait's
 * reconnect (`reconnectInWait`, `reconnectMcpWithCause` with the row state
 * `working`) is the backstop: its `send-keys` answers CONFLICT "not this
 * launch's session" on a live row that is not `pending` when a leftover
 * holds the persona's session, and then nothing is typed, P latches (b.jg5
 * SRJ-501) with its CONFLICT notice posted once, the refused `send-keys` is
 * never retried, and the wait answers `transient` noted as latched, so the
 * ladder answers `latched`.
 */
async function staleWorkingRowIsIdle(
  key: string,
  ref: string,
  config: PersonaConfig,
  watch: WorkingPaneWatch,
  wait: WorkingRowWait,
): Promise<boolean | typeof WAIT_OUTCOME_LATCHED | typeof WORKING_EVIDENCE_STOPPING> {
  const due = _now()
  if (watch.lastReadAt !== undefined && due - watch.lastReadAt < _workingRowReadIntervalMs) return false
  watch.lastReadAt = due
  const read = await readWorkingRowEvidence(
    key,
    transcriptConfigDir(config.personas.find((p) => p.key === key)),
    // The poll that called this has just read the row `working`.
    wait.lastRead ?? latchRowStateRead('working'),
  )
  if (read.rowRead !== undefined) wait.lastRead = read.rowRead
  // b.jg5 SRJ-608: a CONFLICT (or UNUSABLE NAME) at the pane read latched P;
  // the wait ends `latched` with no further call and nothing typed.
  if (read.latched) return WAIT_OUTCOME_LATCHED
  // b.jg5 SRJ-205: the pane read's version re-check decided that the server
  // stops; the wait ends with no further call and nothing typed.
  if (read.paneFailure?.kind === PANE_READ_UNCLASSIFIED && read.paneFailure.stopping === true) {
    console.error(
      `[slack] waitForWaitingAndReconnect: reading the pane of ${ref} failed: ${read.paneFailure.description} — the agent-director version re-check decided that the server stops; the wait ends, nothing more is called and nothing is typed (${paneReadClassNote(read.paneFailure)}; b.jg5 SRJ-204, SRJ-205)`,
    )
    return WORKING_EVIDENCE_STOPPING
  }
  if (read.paneFailure !== undefined && !watch.readFailureLogged) {
    watch.readFailureLogged = true
    console.error(
      `[slack] waitForWaitingAndReconnect: reading the pane of ${ref} failed: ${read.paneFailure.description} — no idle evidence from it; still waiting for its working row (${paneReadClassNote(read.paneFailure)}; b.f2b)`,
    )
  }
  const note = transcriptNoEvidence(read.transcript)
  if (note !== undefined && note !== watch.transcriptNote) {
    watch.transcriptNote = note
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane shows an idle screen, but ${note} — no idle evidence; still waiting for its working row (b.f2b)`,
    )
  }
  const now = _now()
  watch.run = foldWorkingPaneRun(watch.run, read.pane, now, read.transcript)
  const run = watch.run
  if (run === undefined || now - run.since < _staleWorkingWindowMs) return false
  const seconds = Math.round((now - run.since) / 1000)
  if (run.reading === 'idle') {
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return true
  }
  if (!watch.promptReported) {
    watch.promptReported = true
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, still waiting (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: config.session_restart_delay === 0 })
  }
  return false
}

/**
 * The restart path's evidence for each persona whose row reads `working`
 * (b.f2b): one run per persona, kept across its reconnect attempts, which are
 * minutes apart (`checkWorkingRowPane`). Forgotten when an attempt finds the
 * row in another state or can't read it (`forgetWorkingRowEvidence`), when a
 * read gives no evidence and ends the run, when an idle run concludes and the
 * reconnect is typed, when any launch for the persona starts
 * (`spawnForPersona`), and with the persona's not-connected episode
 * (`forgetNotConnectedEpisode`: it reconnected, became deliverable again, or
 * was torn down).
 */
const workingRowPaneRuns = new Map<string, WorkingPaneRun>()

/**
 * When each persona's current run of deferrals on its `working` row began
 * (b.f2b, on the session manager's clock `_now`): the first time a launch
 * wait or the restart path held back from the row, typing nothing, because it
 * could not prove the session idle (`noteWorkingRowDeferral`). A run goes on
 * across reads and attempts that find no proof, whatever the reason: a busy,
 * changing or blank pane, a transcript that doesn't end with a completed
 * turn or can't be read, idle evidence not yet held for the window, a
 * prompt, a pane read agent-director could not answer (UNAVAILABLE or
 * CONFIG, b.jg5 SRJ-603). A failed status call, and a pane read that met
 * ENVIRONMENT, UNCLASSIFIED or a latch, neither extend nor end it. It ends
 * (`endWorkingRowDeferral`) when the row reads another state, when a
 * reconnect is typed into it, when any launch for the persona starts (the
 * launch's own wait starts a new run), and with the persona's not-connected
 * episode (`forgetNotConnectedEpisode`).
 */
const workingRowDeferredSince = new Map<string, number>()

/**
 * b.f2b: note that CSCB held back from persona `key`'s `working` row once
 * more, typing nothing, because it could not prove the session idle. The
 * first deferral of a run starts it (`workingRowDeferredSince`); once the run
 * has lasted `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle`
 * not-connected notice is raised, at any `session_restart_delay`, through the
 * shared latch: once per episode, and not at all when another not-connected
 * notice was raised in the episode. `autoRestartDisabled` (`session_restart_delay`
 * is 0) words what happens next; the restart path runs only with auto-restart
 * on. Returns whether it raised the notice; `notifyPersonaNotConnected` logs
 * the line.
 */
export function noteWorkingRowDeferral(key: string, autoRestartDisabled: boolean): boolean {
  const heldMs = noteDeferralRun(workingRowDeferredSince, key)
  if (heldMs < _unprovenIdleNoticeAfterMs) return false
  return notifyPersonaNotConnected(key, { reason: 'unproven-idle', autoRestartDisabled, heldMs })
}

/**
 * b.f2b: end persona `key`'s run of deferrals on its `working` row (it read
 * another state, a reconnect was typed into it, or a launch for it started),
 * so a later deferral starts a new run. Silent; other personas are untouched.
 */
export function endWorkingRowDeferral(key: string): void {
  workingRowDeferredSince.delete(key)
}

/** What `checkWorkingRowPane` tells the restart path's reconnect adapter (b.f2b). */
export type WorkingRowPaneVerdict = 'reconnect' | 'defer'

/** `checkWaitingRowPane`'s answer when the row's `read-pane` answered GONE (b.jg5 SRJ-117, SRJ-604). */
export const WAITING_ROW_PANE_GONE = 'gone'

/** `checkWaitingRowPane`'s answer when the row was absent (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117). */
export const WAITING_ROW_PANE_ABSENT = 'absent'

/**
 * What `checkWaitingRowPane` tells the restart path's reconnect adapter
 * (b.f2b, b.jg5 SRJ-604): `reconnect`, `defer`, or that the row's
 * `read-pane` answered GONE (`gone`) or found the row absent (`absent`), on
 * either of which the adapter sweeps and escalates with nothing typed.
 */
export type WaitingRowPaneVerdict = WorkingRowPaneVerdict | typeof WAITING_ROW_PANE_GONE | typeof WAITING_ROW_PANE_ABSENT

/**
 * What a reconnect line says it does on a row it escalates as dead before the
 * restart path's re-probe (b.jg5 SRJ-610): the sweep and the 'escalate-dead'
 * answer, and no outcome, since a swept row may stay live for further ticks.
 */
export const ESCALATE_DEAD_REPROBE_DECIDES = "sweeping and escalating (escalate-dead); the restart path's re-probe decides"

/**
 * `checkWaitingRowPane`'s line when the `waiting` row's `read-pane` answered
 * GONE (b.jg5 SRJ-604); `read` is that failure.
 */
export function waitingRowPaneGoneLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: ${keyRef(key)} is waiting but agent-director's read-pane found no pane of its launch: ${read.description} — not typing /mcp reconnect; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jg5 SRJ-604)`
}

/**
 * `checkWaitingRowPane`'s line when the `waiting` row was absent
 * (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117); `read` is that
 * failure.
 */
export function waitingRowAbsentAtPaneReadLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: ${keyRef(key)} is waiting but its agent-director row was absent at the pane read: ${read.description} — not typing /mcp reconnect; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jg5 SRJ-117)`
}

/** What `checkWorkingRowPane` is given beside the persona's key and pane. */
export interface WorkingRowPaneCheckOptions {
  /**
   * The persona, for locating its transcript under its claude_config_dir;
   * absent, only the row's persisted transcript path is read.
   */
  readonly persona?: Pick<Persona, 'claude_config_dir'>
  /**
   * The caller's latched gate (b.jg5 SRJ-502; production: the reconnect
   * adapter's `reconnectLatchedAt` for the persona, which logs the latched
   * line), asked right before a deferral is noted and right before the
   * `blocked-on-prompt` notice: a persona that latched meanwhile (a launch
   * outside the restart serializer can latch it during the check's awaits)
   * answers `defer` with its run forgotten, no deferral noted and no notice.
   * Absent: never asked.
   */
  readonly latchedNow?: () => boolean
}

/**
 * b.f2b, b.jg5 SRJ-603 — the restart path's positive-idle fold for a persona
 * whose row reads `working`, on the `pane` its caller read: the reconnect
 * adapter's one `read-pane` of the row (`workingReconnectVerdict` in
 * `server.ts`). It makes no `read-pane` of its own. It reads the transcript
 * (one `get` of the row; located with `options.persona`'s
 * claude_config_dir, and without it only the row's persisted transcript path
 * is used) only when the pane shows an idle screen, and folds the evidence
 * into the persona's run, kept across reconnect attempts
 * (`workingRowPaneRuns`):
 * - `reconnect` once the idle evidence has held across reads spanning
 *   `STALE_WORKING_WINDOW_MS`: the same idle screen (no busy indicator, no
 *   prompt) and the same transcript, ended with a completed turn and
 *   unchanged, at every read. The row is stale, and the caller types
 *   `/mcp reconnect`. The run is forgotten.
 * - `defer` otherwise: a busy or blank pane, or an idle pane whose transcript
 *   does not end with a completed turn or can't be located or read (the run
 *   ends: no evidence); idle evidence not yet held for the window; or a
 *   prompt or dialog. A prompt shown across reads spanning the window also
 *   raises the `blocked-on-prompt` not-connected notice (once per episode);
 *   nothing is ever typed into a prompt.
 * Each `defer` is one more deferral in the persona's run on its `working` row
 * (`noteWorkingRowDeferral`): once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised (once
 * per episode), so a row whose idleness can never be proven is not held back
 * from silently. `reconnect` ends the run. A live turn never ends its
 * transcript with a completed turn, so it is never taken for idle (b.rmy).
 *
 * The pane comes from the caller's one read and may be a single leftover's
 * (b.jg5 SRJ-117, SRJ-613: with no session of the row's current launch there
 * and exactly one leftover of the persona, agent-director answers the
 * leftover's pane), so a pane alone is never proof that the worker's own
 * session is there: the fold also needs the transcript, and `reconnect` only
 * lets the caller type `/mcp reconnect`. That reconnect's `send-keys`
 * (`reconnectMcpWithCause`) is the backstop: on a live row that is not
 * `pending` it answers CONFLICT "not this launch's session" when a leftover
 * holds the persona's session, and then nothing is typed, P latches (b.jg5
 * SRJ-501) with its CONFLICT notice posted once, and the refused `send-keys`
 * is never retried (SRJ-118).
 *
 * A persona latched during the transcript `get` (it read a
 * `provenance_conflict` note or answered UNUSABLE NAME, b.jg5 SRJ-114,
 * SRJ-512, or it was latched elsewhere), or one `options.latchedNow` finds
 * latched right before a deferral is noted or the notice is raised, answers
 * `defer` with its run forgotten, no deferral noted, no not-connected notice
 * and nothing typed (b.jg5 SRJ-502).
 * Logs one line per call; never throws.
 */
export async function checkWorkingRowPane(
  key: string,
  pane: string,
  options: WorkingRowPaneCheckOptions = {},
): Promise<WorkingRowPaneVerdict> {
  const verdict = await workingRowPaneVerdict(key, pane, options)
  // b.jg5 SRJ-502: a persona latched during the check is deferred with no
  // deferral noted, so no not-connected notice is raised for it.
  if (verdict === WAIT_OUTCOME_LATCHED) return 'defer'
  if (verdict === 'reconnect') {
    endWorkingRowDeferral(key)
    return 'reconnect'
  }
  // b.jg5 SRJ-502: asked right before the deferral that may raise the
  // `unproven-idle` notice.
  if (options.latchedNow?.() === true) {
    workingRowPaneRuns.delete(key)
    return 'defer'
  }
  // The restart path runs only with auto-restart on.
  noteWorkingRowDeferral(key, false)
  return 'defer'
}

/**
 * `checkWorkingRowPane`'s transcript read and verdict on the caller's `pane`,
 * before its deferral is noted (b.f2b); `latched` for a persona latched
 * during the transcript `get`, or found latched right before the
 * `blocked-on-prompt` notice (b.jg5 SRJ-502): its run is forgotten.
 */
async function workingRowPaneVerdict(
  key: string,
  pane: string,
  options: WorkingRowPaneCheckOptions,
): Promise<WorkingRowPaneVerdict | typeof WAIT_OUTCOME_LATCHED> {
  const ref = keyRef(key)
  const read = await readIdlePaneTranscript(key, pane, transcriptConfigDir(options.persona))
  if (read.latched) {
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} is working and is latched — deferring; no deferral noted, nothing typed (b.jg5 SRJ-502)`,
    )
    return WAIT_OUTCOME_LATCHED
  }
  const now = _now()
  const run = foldWorkingPaneRun(workingRowPaneRuns.get(key), pane, now, read.transcript)
  if (run === undefined) {
    workingRowPaneRuns.delete(key)
    logNoWorkingRowEvidence(ref, classifyWorkingPane(pane), read.transcript)
    return 'defer'
  }
  workingRowPaneRuns.set(key, run)
  const span = now - run.since
  const seconds = Math.round(span / 1000)
  if (run.reading === 'idle') {
    if (span < _staleWorkingWindowMs) {
      console.error(
        `[slack] reconnectSession: ${ref} is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for ${seconds}s of the ${Math.round(_staleWorkingWindowMs / 1000)}s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)`,
      )
      return 'defer'
    }
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return 'reconnect'
  }
  if (span < _staleWorkingWindowMs) {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  // b.jg5 SRJ-502: asked right before the notice; the gate logs its line.
  if (options.latchedNow?.() === true) {
    workingRowPaneRuns.delete(key)
    return WAIT_OUTCOME_LATCHED
  }
  console.error(
    `[slack] reconnectSession: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
  )
  // The restart path runs only with auto-restart on: `scheduleRestart` arms
  // nothing while `session_restart_delay` is 0.
  notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
  return 'defer'
}

/** `checkWorkingRowPane`'s line for a read that gave no evidence and ended the run (b.f2b). */
function logNoWorkingRowEvidence(ref: string, reading: WorkingPaneReading, transcript: TranscriptReading | undefined): void {
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`)
  } else if (reading === 'blank') {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane is blank — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b)`)
  } else {
    console.error(
      `[slack] reconnectSession: ${ref} is working and its pane shows an idle screen, but ${transcriptNoEvidence(transcript) ?? 'its transcript was not read'} — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`,
    )
  }
}

/**
 * b.f2b, b.jg5 SRJ-604 — the restart path's check of a persona whose row
 * reads `waiting`, before the reconnect adapter types `/mcp reconnect`: one
 * `read-pane` of the row through the shared reader (`readWorkingPane`, the
 * full read, the row state `waiting`), answered by b.jg5 SRJ-117's
 * waiting-row column:
 * - a pane: a running turn (`busy`) defers; so does a prompt or dialog, which
 *   is never typed into and raises the `blocked-on-prompt` not-connected
 *   notice (once per episode); otherwise `reconnect`. The pane may be a
 *   single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no proof the
 *   worker's own session is there: the reconnect's own `send-keys`
 *   (`reconnectMcpWithCause`) is the backstop. On a live row that is not
 *   `pending` it answers CONFLICT "not this launch's session" when a
 *   leftover holds the persona's session; then nothing is typed, P latches
 *   (b.jg5 SRJ-501) with its CONFLICT notice posted once, the refused
 *   `send-keys` is never retried (SRJ-118) and the adapter answers
 *   'transient';
 * - GONE (`ErrTmuxCaptureFailed`): `gone`; the adapter sweeps and escalates,
 *   typing nothing;
 * - the row absent (`ErrSpawnNotFound`): `absent`, which the adapter
 *   handles as GONE without dead evidence (b.jg5 SRJ-117);
 * - CONFLICT or UNUSABLE NAME (the reader latched the persona with the row
 *   state `waiting`, b.jg5 SRJ-501, SRJ-512), or a persona already latched,
 *   which the reader does not read: `defer`, with no notice, so nothing is
 *   typed (b.jg5 SRJ-502);
 * - ENVIRONMENT (`ErrTmuxNotAvailable`; the wrapper raised the
 *   `tmux-unavailable` outage, b.jg5 SRJ-311): `defer`, nothing typed;
 * - an UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *   `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *   SRJ-205): `defer`, nothing typed and nothing more called;
 * - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *   `ad-config-malformed` outage, b.jg5 SRJ-316) and any other
 *   UNCLASSIFIED: `reconnect` on the `waiting` row alone, agent-director's
 *   own idle signal, with one line naming the class.
 * `latchedNow` (the adapter's latched gate, b.jg5 SRJ-502) is asked right
 * before the `blocked-on-prompt` notice: a persona that latched meanwhile
 * gets no notice and `defer`. Logs one line for each answer but a plain
 * `reconnect`; never throws.
 */
export async function checkWaitingRowPane(key: string, latchedNow?: () => boolean): Promise<WaitingRowPaneVerdict> {
  const ref = keyRef(key)
  // The adapter called this for a row it has just read `waiting`.
  const read = await readWorkingPane(key, latchRowStateRead('waiting'))
  switch (read.kind) {
    case PANE_READ_PANE:
      return waitingRowPaneJudgement(key, ref, read.pane, latchedNow)
    case PANE_READ_LATCHED:
      console.error(`[slack] reconnectSession: ${ref} is waiting and is latched — deferring; nothing typed (b.jg5 SRJ-502)`)
      return 'defer'
    case PANE_READ_GONE:
      console.error(waitingRowPaneGoneLine(key, read))
      return WAITING_ROW_PANE_GONE
    case PANE_READ_ABSENT:
      console.error(waitingRowAbsentAtPaneReadLine(key, read))
      return WAITING_ROW_PANE_ABSENT
    case PANE_READ_ENVIRONMENT:
      console.error(
        `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — tmux is not available; not typing /mcp reconnect, deferring to a later tick (${paneReadClassNote(read)}; b.jg5 SRJ-117, SRJ-311)`,
      )
      return 'defer'
    case PANE_READ_UNCLASSIFIED:
      if (read.stopping === true) {
        console.error(
          `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; not typing /mcp reconnect, nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`,
        )
        return 'defer'
      }
      return reconnectOnWaitingRowAlone(ref, read)
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
      return reconnectOnWaitingRowAlone(ref, read)
  }
}

/** `checkWaitingRowPane`'s `reconnect` on the `waiting` row alone after a failed pane read, with its one line (b.f2b, b.jg5 SRJ-604). */
function reconnectOnWaitingRowAlone(ref: string, read: PaneReadFailure): 'reconnect' {
  console.error(
    `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — reconnecting on the waiting row alone (${paneReadClassNote(read)}; b.f2b, b.jg5 SRJ-604)`,
  )
  return 'reconnect'
}

/**
 * `checkWaitingRowPane`'s judgement of the `pane` it read (b.f2b): a running
 * turn defers; a prompt or dialog defers and raises the `blocked-on-prompt`
 * notice, unless `latchedNow` finds the persona latched right before it
 * (b.jg5 SRJ-502: no notice); anything else is `reconnect`.
 */
function waitingRowPaneJudgement(
  key: string,
  ref: string,
  pane: string,
  latchedNow: (() => boolean) | undefined,
): WorkingRowPaneVerdict {
  const reading = classifyWorkingPane(pane)
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  if (reading === 'prompt') {
    // b.jg5 SRJ-502: asked right before the notice; the gate logs its line.
    if (latchedNow?.() === true) return 'defer'
    console.error(
      `[slack] reconnectSession: ${ref} is waiting but its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b/b.rmy)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
    return 'defer'
  }
  return 'reconnect'
}

/**
 * b.f2b: true while the restart path holds an idle run for persona `key`'s
 * `working` row that has not yet concluded: one more reconnect attempt can
 * find the row stale and reconnect it. The health check then schedules that
 * attempt the first tick it finds the persona undeliverable, rather than
 * after two. A prompt run does not count: CSCB cannot recover that persona
 * until someone answers the prompt.
 */
export function hasPendingWorkingRowEvidence(key: string): boolean {
  return workingRowPaneRuns.get(key)?.reading === 'idle'
}

/**
 * b.f2b: forget the restart path's evidence for persona `key`'s `working` row
 * (a reconnect attempt found the row in another state or couldn't read it, so
 * the next `working` reading starts afresh). Silent; other personas are
 * untouched.
 */
export function forgetWorkingRowEvidence(key: string): void {
  workingRowPaneRuns.delete(key)
}

// ---------------------------------------------------------------------------
// Cancelling a launch's wait for a `working` row (b.f2b)
// ---------------------------------------------------------------------------

/** A running `waitForWaitingAndReconnect`, which the persona's teardown can cancel (b.f2b). */
interface WorkingRowWait {
  cancelled: boolean
  /** Ends the wait's current poll sleep at once (a no-op between sleeps). */
  wake: () => void
  /**
   * b.jg5 SRJ-118: set when the wait answers 'transient' because its
   * reconnect latched the persona (a CONFLICT or UNUSABLE NAME answer to the
   * keystrokes) or found it latched, so the ladder answers `latched`.
   */
  latched?: true
  /**
   * b.jg5 SRJ-205: set when the wait answers 'transient' because a version
   * re-check decided that the server stops (its evidence read's, or its
   * reconnect's after an `ErrInvalidFlags`); the ladder answers a `failed`
   * result marked `stopping`, records no `spawn-failed` entry and posts
   * nothing.
   */
  stopping?: true
  /**
   * b.jg5 SRJ-501: the row state the wait's last `status` read gave (no row
   * for `ErrSpawnNotFound`), for a CONFLICT at the resume or spawn the ladder
   * makes after a `dead-session` verdict. Absent until a read answers.
   */
  lastRead?: LatchRowState
}

/** The running wait of each persona whose launch waits for a `working` row (b.f2b); at most one per persona, like its launch. */
const workingRowWaits = new Map<string, WorkingRowWait>()

/**
 * Personas whose launch in flight has not started its wait for a `working`
 * row yet, but whose teardown already cancelled it (b.f2b): a wait that launch
 * starts is cancelled from its first check. Forgotten when the launch settles
 * (`spawnForPersona`).
 */
const cancelledLaunchWaits = new Set<string>()

/**
 * b.f2b: cancel persona `key`'s launch wait for a `working` row
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
 * persona's teardown calls this, so it does not wait out a launch parked on
 * the row, and neither does the apply that runs it (b.av2 SR-8.6). A running
 * wait wakes from its poll sleep at once, checks the flag after each
 * agent-director call, types nothing and returns `cancelled`; its launch then
 * settles as `not-reconnected`. When a launch for the persona is in flight
 * but has not started its wait yet, a wait it starts later is cancelled from
 * its first check. Logs one line and returns true when it cancelled a
 * running or a coming wait; returns false, silently, when no launch for the
 * persona is in flight or its wait was already cancelled.
 */
export function cancelWorkingRowWait(key: string): boolean {
  const wait = workingRowWaits.get(key)
  if (wait !== undefined) {
    if (wait.cancelled) return false
    wait.cancelled = true
    wait.wake()
    console.error(`[slack] waitForWaitingAndReconnect: ${keyRef(key)} — cancelling its launch's wait for its working row (b.f2b)`)
    return true
  }
  if (!inFlightLaunches.has(key) || cancelledLaunchWaits.has(key)) return false
  cancelledLaunchWaits.add(key)
  console.error(
    `[slack] waitForWaitingAndReconnect: ${keyRef(key)} — its launch in flight will not wait for a working row: any such wait is cancelled at once (b.f2b)`,
  )
  return true
}

/** Sleep `ms` (the wait's poll interval), or until the wait is cancelled (b.f2b). */
function sleepUnlessCancelled(wait: WorkingRowWait, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      wait.wake = () => {}
      resolve()
    }
    wait.wake = done
  })
}

/** The wait's outcome once its teardown cancelled it (b.f2b): logged, nothing typed. */
function waitCancelled(ref: string): 'cancelled' {
  console.error(`[slack] waitForWaitingAndReconnect: the wait for ${ref} was cancelled (its persona is being torn down) — nothing typed (b.f2b)`)
  return 'cancelled'
}

/** The wait's outcome once its persona is latched (b.jg5 SRJ-502): logged, nothing more called, nothing typed. */
function waitLatched(ref: string): typeof WAIT_OUTCOME_LATCHED {
  console.error(
    `[slack] waitForWaitingAndReconnect: ${ref} is latched — the wait ends; nothing more is called and nothing is typed (b.jg5 SRJ-502)`,
  )
  return WAIT_OUTCOME_LATCHED
}

/**
 * Whether the wait must end now: its teardown cancelled it, or its persona
 * `key` is latched (`personaLatchedNow`, b.jg5 SRJ-502). Asked after each
 * agent-director call the wait makes. Never throws.
 */
function waitMustEnd(key: string, wait: WorkingRowWait): boolean {
  return wait.cancelled || personaLatchedNow(key)
}

/** The ending outcome for a wait `waitMustEnd` answered true for: `cancelled` first, else `latched`. */
function endWait(ref: string, wait: WorkingRowWait): 'cancelled' | typeof WAIT_OUTCOME_LATCHED {
  return wait.cancelled ? waitCancelled(ref) : waitLatched(ref)
}

/** A wait's length for a notice: whole minutes from one minute up, else seconds. */
function describeWaitSpan(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

/**
 * agent-director states in which the persona's session waits on a question
 * (`ask_user`) or a permission dialog (`check_permission`): nothing is ever
 * typed into them, and a persona left disconnected there is reported as
 * blocked on a prompt (b.f2b).
 */
export const PROMPT_ROW_STATES: ReadonlySet<string> = new Set(['ask_user', 'check_permission'])

/**
 * The not-connected notice for a wait that ended with its session alive and
 * its row in `state` while auto-restart is disabled (b.f2b):
 * `blocked-on-prompt` for `ask_user` or `check_permission` (a prompt is why
 * nothing reconnects it), else `auto-restart-disabled` with `cause`. (The
 * timeout words a `working` row's as `unproven-idle` itself.)
 */
function waitEndedNotice(state: string, cause: string): NotConnectedNotice {
  return PROMPT_ROW_STATES.has(state)
    ? { reason: 'blocked-on-prompt', autoRestartDisabled: true }
    : { reason: 'auto-restart-disabled', cause }
}

/**
 * How a launch wait that ends `not-reconnected` reports itself (b.f2b,
 * `reportWaitEndedDisconnected`): the head of its log line, the line's
 * follow-up with auto-restart on (the recovery the health check drives), and
 * the not-connected notice raised with `session_restart_delay` 0.
 */
export interface WaitEndedReport {
  readonly logHead: string
  readonly enabledFollowUp: string
  readonly notice: NotConnectedNotice
}

/**
 * The report of a wait whose poll read the row in `state`, a live state that
 * is neither `waiting` nor `working` (b.f2b): the notice is
 * `blocked-on-prompt` for a prompt state (`waitEndedNotice`).
 */
export function waitEndedOnStateReport(ref: string, state: string): WaitEndedReport {
  return {
    logHead: `[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} — aborting`,
    enabledFollowUp:
      'the health check reconnects it (tick sees alive && !connected on two ticks -> scheduleRestart -> reconnect, b.9a7; an ask_user or check_permission row is never typed into, b.f2b)',
    notice: waitEndedNotice(state, `it moved to state ${state} while CSCB waited to reconnect it`),
  }
}

/**
 * The report of a wait whose timeout read found the row in `state`, a live
 * state other than `waiting` (b.f2b), `timeoutMs` after it started; the
 * health check's `working`-row report comes after `unprovenIdleAfterMs` of
 * holding back. A `working` row's notice is `unproven-idle`, held for
 * `heldMs` (required for it); any other state's is `waitEndedNotice`'s.
 */
export function waitTimedOutLiveReport(
  ref: string,
  timeoutMs: number,
  unprovenIdleAfterMs: number,
  state: string,
  heldMs?: number,
): WaitEndedReport {
  return {
    logHead: `[slack] reconnect: gave up waiting for ${ref} after ${timeoutMs}ms — claude process state=${state} (alive)`,
    enabledFollowUp: `the health check schedules a reconnect once it has seen the persona disconnected on two ticks; for a working row it types /mcp reconnect only once its pane has shown the same idle screen and its transcript has ended with a completed turn, both unchanged, across attempts, and never into a prompt, and it reports the persona once CSCB has held back from the row for ${describeWaitSpan(unprovenIdleAfterMs)} (b.9a7/b.rmy/b.f2b)`,
    notice:
      state === 'working'
        ? { reason: 'unproven-idle', autoRestartDisabled: true, heldMs: heldMs ?? 0 }
        : waitEndedNotice(
            state,
            `its agent-director row still read ${state} ${describeWaitSpan(timeoutMs)} after launch, and CSCB found no proof it was idle`,
          ),
  }
}

/**
 * The report of a wait whose timeout `status` read failed with any error but
 * `ErrSpawnNotFound` (b.jg5 SRJ-605), `timeoutMs` after it started:
 * `described` is the error through the redacting describer and `errorClass`
 * its class. The line names no tmux session; the notice is
 * `auto-restart-disabled`, saying agent-director could not report the
 * persona's state.
 */
export function waitTimedOutUnreadReport(
  ref: string,
  timeoutMs: number,
  described: string,
  errorClass: AdErrorClass,
): WaitEndedReport {
  return {
    logHead: `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${timeoutMs}ms — its status read failed: ${described} (class=${errorClass}), so its state is not known — not reconnected (b.jg5 SRJ-605)`,
    enabledFollowUp:
      "the health check recovers it from its own reads of the row: once agent-director answers with the row live and the persona disconnected, the tick schedules a reconnect (b.9a7)",
    notice: {
      reason: 'auto-restart-disabled',
      cause: `agent-director could not report its state when CSCB stopped waiting for it, ${describeWaitSpan(timeoutMs)} after launching it`,
    },
  }
}

/**
 * The one line a wait ending `not-reconnected` writes (b.f2b): `report`'s
 * head and, with `session_restart_delay` (`sessionRestartDelay`) on, its
 * follow-up; with it 0, that nothing will reconnect the persona and the
 * not-connected notice reports it.
 */
export function waitEndedDisconnectedLine(
  report: Pick<WaitEndedReport, 'logHead' | 'enabledFollowUp'>,
  sessionRestartDelay: number,
): string {
  return sessionRestartDelay !== 0
    ? `${report.logHead}; ${report.enabledFollowUp}`
    : `${report.logHead}; session_restart_delay is 0, so nothing will reconnect it — the not-connected notice reports it (once per episode) (b.f2b)`
}

/**
 * The line of a wait whose `status` read found persona `ref`'s row absent
 * (`ErrSpawnNotFound`, b.jg5 SRJ-605): at the poll, or, with `timedOutAfterMs`,
 * at the timeout read. The wait answers 'dead-session' with no tmux probe;
 * the recovery's spawn classifies any leftover session.
 */
export function waitRowAbsentLine(ref: string, timedOutAfterMs?: number): string {
  const at = timedOutAfterMs === undefined ? `${ref}'s` : `timed out for ${ref} after ${timedOutAfterMs}ms —`
  return `[slack] waitForWaitingAndReconnect: ${at} agent-director row is absent (ErrSpawnNotFound) — dead session; the recovery's spawn classifies any leftover session (b.jg5 SRJ-605)`
}

/**
 * The line of a wait whose poll `status` read failed with any error but
 * `ErrSpawnNotFound` (b.jg5 SRJ-605): `described` is the error through the
 * redacting describer and `errorClass` its class. The wait goes on; it writes
 * this for its first failed read and again only when the class changes.
 */
export function waitPollStatusErrorLine(ref: string, described: string, errorClass: AdErrorClass): string {
  return `[slack] waitForWaitingAndReconnect: status read failed for ${ref}: ${described} (class=${errorClass}) — its state is not known; still waiting for its working row, nothing posted (b.jg5 SRJ-605)`
}

/**
 * b.f2b: the wait ends with the persona's session alive but not reconnected.
 * Log what happens next for the restart delay in effect
 * (`waitEndedDisconnectedLine`): with auto-restart on, the recovery the health
 * check drives; with `session_restart_delay` 0, that nothing will reconnect
 * it, and raise the once-per-episode not-connected notice, so the persona is
 * never left down silently. Returns the wait's outcome, `not-reconnected`.
 */
function reportWaitEndedDisconnected(key: string, config: PersonaConfig, report: WaitEndedReport): 'not-reconnected' {
  console.error(waitEndedDisconnectedLine(report, config.session_restart_delay))
  if (config.session_restart_delay === 0) notifyPersonaNotConnected(key, report.notice)
  return 'not-reconnected'
}

// ---------------------------------------------------------------------------
// reconcileMissingSweep — shared, load-shedding findMissing sweep
// ---------------------------------------------------------------------------

/**
 * The findMissing memo window (b.m4r), measured on the session manager's
 * clock (`_now`). AD's `findMissing({})` is a whole-store, per-row
 * evidence-based sweep, so two sweeps fired within a few seconds of each
 * other return the same verdicts. On a fleet restart, startupSessionManager
 * (concurrency=3) resolves collisions across N channels near-simultaneously,
 * and every `working`-row collision — plus each dead-path
 * `reconcileMissingFirst` — would otherwise fire its own whole-store sweep
 * (N sweeps, up to 3 concurrent). Single-flight collapses concurrent ordinary
 * callers onto one in-flight run; the window then lets ordinary callers
 * arriving just after it resolves reuse that result instead of re-sweeping.
 *
 * 10s comfortably covers one startup reconcile wave (the whole concurrency=3
 * wave over the fleet completes well inside this window) and collapses a
 * same-tick escalate-dead burst: when N personas escalate together (b.nk5
 * fleet shape — /tmp wiped, every persona dead-tmux at once), those
 * `sweepDeadTmuxChannel` callers land inside the window and share the single
 * in-flight or memoized sweep — one findMissing reconciles the whole store for
 * all of them. Across ticks the window is far shorter than the ~120s
 * health-check cadence, so a later tick's escalate-dead sweep falls outside
 * it and runs again. A swept row is not sure to read dead afterwards:
 * agent-director may leave it live (in `unverified_ids`, or, when `pending`,
 * not judged at all), and it may stay live for further ticks; each
 * escalate-dead tick then sweeps again, with no step beyond the sweep, and
 * the restart path posts the slow-recovery notice once after 3 such ticks
 * (b.jg5 SRJ-610, SRJ-1010). Only redundant load is shed (see the
 * `_buildReconnectSessionAdapter` call-site note in src/server.ts and
 * docs/architecture.md's sweep note).
 *
 * A bypassing run (`FIND_MISSING_RUN_BYPASSING`, b.jg5 SRJ-120) ignores the
 * window and anything in flight; its result is memoized for later ordinary
 * callers like any other run's.
 */
export const FIND_MISSING_MEMO_TTL_MS = 10 * 1000

/**
 * An ordinary findMissing run (b.jg5 SRJ-120): a caller arriving inside the
 * memo window reuses the memoized result, and one arriving while a run is in
 * flight joins it. Every caller today is ordinary.
 */
const FIND_MISSING_RUN_ORDINARY = 'ordinary'

/**
 * A bypassing findMissing run (b.jg5 SRJ-120): a new call whatever is
 * memoized or in flight, whose result is memoized for later ordinary callers
 * (`bypassingFindMissingSweep`).
 */
const FIND_MISSING_RUN_BYPASSING = 'bypassing'

/** The kind of a findMissing run (b.jg5 SRJ-120). */
type FindMissingRunKind = typeof FIND_MISSING_RUN_ORDINARY | typeof FIND_MISSING_RUN_BYPASSING

/** What a findMissing run is asked for (`reconcileMissingSweep`, `sharedFindMissingSweep`). */
interface FindMissingSweepOptions {
  /** The run kind; ordinary when absent. */
  readonly kind?: FindMissingRunKind
  /**
   * The persona whose own row the caller's next step reads with a `get`: a run
   * this caller starts makes no post-run `get` of that row (b.jg5 SRJ-120).
   * Only the starter's key counts: an ordinary caller that joins the run gets
   * no read of that row from it.
   */
  readonly nextStepGetKey?: string
  /**
   * The start sweep's run (`reconcileKilledPrePersonaRows`, which acts for no
   * persona): a run this caller starts makes its post-run `get`s with an
   * UNUSABLE NAME answer routed per SRJ-1002, so it latches nothing (b.jg5
   * SRJ-512) and is carried as a failed read. The note and launch-start
   * decisions still latch there (b.jg5 SRJ-114, SRJ-513). A run another
   * caller started keeps that caller's reads.
   */
  readonly startSweepRun?: boolean
}

/** The context an UNUSABLE NAME answer to the start sweep's post-run `get`s is routed in (b.jg5 SRJ-1002). */
const START_SWEEP_ROUTED_CONTEXT = 'the start sweep'

let _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS

/** What the post-run `get`s of a run read (`readListedPersonaRows`). */
interface PostRunReads {
  /**
   * The configured personas whose own row a post-run `get` of this run read
   * as latching (`OwnRowRead.latched`, b.jg5 SRJ-114, SRJ-513) or that answered
   * UNUSABLE NAME (`OWN_ROW_READ_LATCHED`, b.jg5 SRJ-512).
   */
  readonly latchedKeys: ReadonlySet<string>
  /**
   * The configured personas whose own row's post-run `get` failed with an
   * error other than `ErrSpawnNotFound` and UNUSABLE NAME (`OWN_ROW_READ_REFUSED`), each with
   * that error, carried unchanged; in the start sweep's run an UNUSABLE NAME
   * answer too, which latched nothing there (b.jg5 SRJ-512, SRJ-1002). Only
   * the persona's own caller acts on it (`postRunGetRefusal`, b.jg5
   * SRJ-105, SRJ-114), and an UNUSABLE NAME answer is no refusal there.
   */
  readonly refusedReads: ReadonlyMap<string, unknown>
}

/** What a run that resolved hands every caller awaiting it: its result and its post-run reads. */
interface FindMissingRunOutcome extends PostRunReads {
  readonly result: FindMissingResult
}

/** One findMissing run the server made. `seq` orders runs by when they started. */
interface FindMissingRun {
  readonly seq: number
  readonly kind: FindMissingRunKind
  readonly promise: Promise<FindMissingRunOutcome>
}

/** Sequence number of the most recently started run (`FindMissingRun.seq`). */
let _findMissingRunSeq = 0
/**
 * The most recently started run while it is in flight: ordinary callers join
 * it. Cleared when that run settles; an older run settling never clears it.
 */
let _findMissingInFlight: FindMissingRun | null = null
/**
 * The memo: the result of the most recently started run that succeeded, with
 * the time its call resolved (`_now`) and its `seq`. A run that started earlier
 * than the memoized one never overwrites it; a failure never touches it.
 */
let _findMissingLast: { result: FindMissingResult; at: number; seq: number } | null = null

/**
 * Test-only seam (mirrors `_setWaitForWaitingTimeoutMs`): override the memo
 * window (`FIND_MISSING_MEMO_TTL_MS` by default).
 */
export function _setFindMissingMemoTtlMs(ms: number): void {
  _findMissingMemoTtlMs = ms
}

/**
 * Test-only seam: clear all memo state (the in-flight run, the memoized
 * result, the run sequence) and restore the default window. Tests that count
 * findMissing calls must call this in their setup/teardown to stay
 * deterministic.
 */
export function _resetFindMissingMemo(): void {
  _findMissingInFlight = null
  _findMissingLast = null
  _findMissingRunSeq = 0
  _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS
}

/**
 * Run AD's per-row, evidence-based `findMissing({})` sweep for persona `key`
 * through `withOutageDetection`, shedding redundant load (b.m4r, b.jg5
 * SRJ-120; `sharedFindMissingSweep` holds the rules):
 *
 * - An ordinary run (the default) reuses a result memoized inside the window
 *   and joins a run in flight; a bypassing run always makes a new call.
 * - After a run the server makes (not a memo reuse), each configured
 *   persona's own row listed in `unverified_ids` is read with one `get`
 *   (except `opts.nextStepGetKey`'s and an already-latched persona's), and
 *   only a `provenance_conflict` note there latches.
 *
 * Failures are never memoized. A failure the arming predicate answers a cause
 * for (b.jg5 SRJ-105, `refusalAt` with verb `find-missing`, which is not a
 * read verb, so an UNAVAILABLE, an ENVIRONMENT, a CONFIG or an UNCLASSIFIED
 * answer, b.jg5 SRJ-313) is a refusal: one refusal line, and
 * `FIND_MISSING_REFUSED`, after which the caller calls nothing more in its
 * attempt. Any other failure, UNUSABLE NAME included, logs once and lets the
 * caller proceed. A post-run `get` of persona `key`'s own row that fails with
 * an error other than `ErrSpawnNotFound` is handled as a `get` at an SRJ-114
 * site (b.jg5 SRJ-105, SRJ-114, `refusalAt` with verb `get`): a refusal
 * answers `FIND_MISSING_REFUSED` too; an UNUSABLE NAME answer there latches
 * the persona (b.jg5 SRJ-512), whose caller then gets `FIND_MISSING_LATCHED`.
 *
 * @param key persona key: the outage key and log context — the sweep itself is whole-store.
 * @param logPrefix distinguishes the call sites in the log line.
 * @param ref log reference; defaults to the key alone.
 * @param opts the run kind and the next-step `get` key; an ordinary run with none by default.
 * @returns the sweep's result (this caller's run, a shared in-flight one or
 *   the memoized one), `FIND_MISSING_REFUSED` for a refusal,
 *   `FIND_MISSING_LATCHED` when persona `key` is latched once the sweep is
 *   done (b.jg5 SRJ-502), or undefined when the sweep failed otherwise.
 */
async function reconcileMissingSweep(
  key: string,
  logPrefix: string,
  ref: string = keyRef(key),
  opts: FindMissingSweepOptions = {},
): Promise<FindMissingSweepAnswer> {
  return sharedFindMissingSweep(
    () => withOutageDetection(key, undefined, 'find-missing', (client) => client.findMissing({})),
    logPrefix,
    ref,
    key,
    opts,
  )
}

/**
 * What a persona's findMissing sweep answers (`reconcileMissingSweep`,
 * `bypassingFindMissingSweep`): the result, `FIND_MISSING_REFUSED`,
 * `FIND_MISSING_LATCHED`, or undefined for any other failure.
 */
export type FindMissingSweepAnswer =
  | FindMissingResult
  | typeof FIND_MISSING_REFUSED
  | typeof FIND_MISSING_LATCHED
  | undefined

/**
 * A persona's findMissing sweep that was refused (b.jg5 SRJ-105): the sweep
 * failed with an error the arming predicate answers a cause for, which for
 * `find-missing` (not a read verb) is an UNAVAILABLE, an ENVIRONMENT, a
 * CONFIG or an UNCLASSIFIED answer (b.jg5 SRJ-313); or the sweep succeeded
 * and the post-run `get` of the persona's own row failed with such an error,
 * which for `get` is any error but `ErrSpawnNotFound` and an UNUSABLE NAME
 * answer (b.jg5 SRJ-114). The caller stops its launch or recovery attempt:
 * no resume, kill, delete, launch, reconnect or dead-session verdict follows.
 */
export const FIND_MISSING_REFUSED: unique symbol = Symbol('find-missing refused')

/**
 * A persona's findMissing sweep after which the persona is latched (b.jg5
 * SRJ-502): a post-run `get` of its own row read the latching note (b.jg5
 * SRJ-114, SRJ-120) or answered UNUSABLE NAME (b.jg5 SRJ-512), or the
 * installed latch answers it latched
 * (`personaLatchedNow`). The caller makes no further agent-director call for
 * the persona: no status read, resume, kill, delete, launch or reconnect.
 */
export const FIND_MISSING_LATCHED: unique symbol = Symbol('find-missing latched')

/**
 * The memo and single-flight core of every findMissing caller
 * (b.m4r, b.jg5 SRJ-120). `start` makes the call when a run starts: a
 * persona's call through `withOutageDetection`, or the start sweep's direct
 * call (`reconcileKilledPrePersonaRows`), which acts for no persona. Never
 * throws.
 *
 * Run kinds (`opts.kind`):
 * - ordinary (the default): the run in flight, if any, is joined (a
 *   bypassing one included); otherwise a result memoized less than the
 *   window ago (`_findMissingMemoTtlMs`, on `_now`) is returned with no call
 *   and no `get`; otherwise a run starts;
 * - bypassing: a run always starts, and becomes the run in flight that later
 *   ordinary callers join.
 * A run that succeeds is memoized only when no run started after it has been
 * memoized already, so an older run resolving later never overwrites a newer
 * result, and it clears the in-flight slot only while it is still the run
 * there. Each run logs its line once (the starter's `logPrefix` and `ref`):
 *
 *   [slack] <logPrefix>: findMissing sweep for <ref> — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *   [slack] <logPrefix>: bypassing findMissing sweep for <ref> — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *
 * Post-run `get`s (`readListedPersonaRows`, b.jg5 SRJ-120): when a run
 * resolves, and before any caller awaiting it (its starter and its joiners
 * alike) goes on, each configured persona's own row listed in
 * `unverified_ids` is read with one `get` through the shared own-row read
 * (`readPersonaOwnRow`), except the row of the starter's
 * `opts.nextStepGetKey` and the row of a persona already latched then
 * (`personaLatchedNow`), which is skipped with no `get` and no latch call.
 * A memo hit makes no `get`. When the `get` of a
 * persona caller's own row failed with an error other than
 * `ErrSpawnNotFound`, that caller, the starter or a joiner, handles it as a
 * `get` at an SRJ-114 site (`postRunGetRefusal`, b.jg5 SRJ-105, SRJ-114): a
 * joiner first reports it under its own key, then a refusal (`refusalAt`
 * with `get`) logs its line and answers `FIND_MISSING_REFUSED`:
 *
 *   [slack] <logPrefix>: post-sweep get refused for <ref>: <failure> — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)
 *
 * An UNUSABLE NAME answer there is no failed read: it latched the persona
 * (b.jg5 SRJ-512), so its caller gets `FIND_MISSING_LATCHED`. A
 * failed `get` of another persona's row only shows in the run's line, and
 * no failed `get` changes the run's result or its memo.
 *
 * Failures, of either kind, are logged with the run kind, never memoized, and
 * leave any earlier memoized result in place; a failed run makes no `get`.
 * A joiner's failure is its own: a failed sweep is reported to the retry
 * timer once per persona that met it (b.jg5 SRJ-301): the starter's
 * `withOutageDetection` reports it under the starter's key, and a persona
 * that joined a run someone else started (another persona's, or the start
 * sweep's direct call) reports it here under its own key. A joiner whose
 * sweep failed with ENVIRONMENT (`ErrTmuxNotAvailable`, by class through
 * `src/ad-error-class.ts`) also raises its own 'tmux-unavailable' before that
 * report, as the starter's wrapper does for the starter (b.jg5 SRJ-311): same
 * onset, same-flag dedupe. A joiner whose sweep failed with CONFIG
 * (`ErrConfigMalformed`) raises its own 'ad-config-malformed' the same way
 * (b.jg5 SRJ-316). For a persona's caller, the starter and each joiner alike,
 * a refused sweep answers `FIND_MISSING_REFUSED` (b.jg5 SRJ-105); a caller
 * that acts for no persona only ever gets undefined for a failure. Any other
 * failure logs:
 *
 *   [slack] <logPrefix>: findMissing sweep failed for <ref>: <failure> — proceeding
 *   [slack] <logPrefix>: bypassing findMissing sweep failed for <ref>: <failure> — proceeding
 *
 * A persona's caller gets `FIND_MISSING_LATCHED` instead of a result or
 * undefined when its persona is latched once the sweep is done (b.jg5
 * SRJ-502): a post-run `get` of this run read its row as latching, or
 * `personaLatchedNow` answers true. The caller logs its own stop line. A
 * refusal, of the sweep or of the post-run `get` of the caller's own row,
 * answers `FIND_MISSING_REFUSED` whether or not the persona is latched.
 */
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key?: undefined,
  opts?: FindMissingSweepOptions,
): Promise<FindMissingResult | undefined>
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key: string,
  opts?: FindMissingSweepOptions,
): Promise<FindMissingSweepAnswer>
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key?: string,
  opts: FindMissingSweepOptions = {},
): Promise<FindMissingSweepAnswer> {
  const kind = opts.kind ?? FIND_MISSING_RUN_ORDINARY

  // Single flight (ordinary runs only): join the run in flight rather than
  // starting one. Asked before the memo, so an ordinary caller arriving while
  // a bypassing run is in flight joins it; with ordinary runs alone a run is
  // in flight only once the memo has expired.
  const joined = kind === FIND_MISSING_RUN_ORDINARY ? _findMissingInFlight : null

  // Memo hit (ordinary runs only): a recent successful run is still inside the window.
  if (
    joined === null &&
    kind === FIND_MISSING_RUN_ORDINARY &&
    _findMissingLast &&
    _now() - _findMissingLast.at < _findMissingMemoTtlMs
  ) {
    return latchedOr(key, _findMissingLast.result, NO_LATCHED_KEYS)
  }

  const run = joined ?? startFindMissingRun(start, kind, opts, logPrefix, ref)
  if (joined === null) _findMissingInFlight = run

  let outcome: FindMissingRunOutcome
  try {
    outcome = await run.promise
  } catch (err) {
    // A joiner's failure is its own: raise and report it under its key, as the
    // starter's wrapper did under the starter's (b.jg5 SRJ-301, SRJ-311).
    if (joined !== null && key !== undefined) {
      const { errorClass } = classifyAdError(err)
      if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
        // b.jg5 SRJ-1021: the raising error picks the onset.
        raiseTmuxUnavailable(key, err)
      } else if (errorClass === AD_ERROR_CLASS_CONFIG) {
        // b.jg5 SRJ-316: one outage per persona that met the answer.
        raiseAdConfigMalformed(key, err)
      }
      reportAgentDirectorError(key, err, 'find-missing')
    }
    const what = findMissingSweepWords(run.kind)
    // b.jg5 SRJ-105: a refused sweep stops the persona's attempt.
    if (key !== undefined && refusalAt(key, err, 'find-missing', logPrefix, what, ref)) {
      return FIND_MISSING_REFUSED
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('findMissing', 'UnknownError', String(err))
    console.error(`[slack] ${logPrefix}: ${what} failed for ${ref}: ${describeAgentDirectorFailure(e)} — proceeding`)
    return latchedOr(key, undefined, NO_LATCHED_KEYS)
  }
  // b.jg5 SRJ-105, SRJ-114: a failed post-run `get` of the caller's own row stops its attempt.
  if (key !== undefined && postRunGetRefusal(key, outcome.refusedReads, joined !== null, logPrefix, ref)) {
    return FIND_MISSING_REFUSED
  }
  return latchedOr(key, outcome.result, outcome.latchedKeys)
}

/** No persona latched by a run's post-run `get`s. */
const NO_LATCHED_KEYS: ReadonlySet<string> = new Set<string>()

/**
 * Whether the post-run `get` of persona `key`'s own row, made by the run its
 * caller started or joined, is a refusal for that caller (b.jg5 SRJ-114:
 * this read is one of the `get` sites, and any error but `ErrSpawnNotFound`
 * follows SRJ-105's `status`/`get`/`list` rule). Only `key`'s own read
 * counts: another persona's failed read stays in the run's summary line.
 * When `key`'s read failed (`refusedReads`) and the caller joined a run
 * someone else started, the error is first reported under `key`
 * (`reportAgentDirectorError` with `get`), as a joiner's failed sweep is: the
 * `get` ran in the starter's context, so the caller's own attempt had not
 * seen it (b.jg5 SRJ-301); the read's wrapper has already raised `key`'s
 * outage flags. Then `refusalAt` with `get` decides: a refusal logs its one
 * line and answers true; any other error answers false (only an UNUSABLE
 * NAME answer carried from the start sweep's run, which latched nothing
 * there, b.jg5 SRJ-1002; elsewhere that answer latched the persona and is
 * not carried here), and the caller goes on as after any read. A read that answered absent, or no read,
 * answers false. Never throws.
 */
function postRunGetRefusal(
  key: string,
  refusedReads: ReadonlyMap<string, unknown>,
  joined: boolean,
  logPrefix: string,
  ref: string,
): boolean {
  if (!refusedReads.has(key)) return false
  const err = refusedReads.get(key)
  if (joined) reportAgentDirectorError(key, err, 'get')
  return refusalAt(key, err, 'get', logPrefix, 'post-sweep get', ref) !== undefined
}

/**
 * What a sweep answers persona `key`'s caller: `FIND_MISSING_LATCHED` when
 * `key` is in `latchedKeys` or latched now (`personaLatchedNow`), otherwise
 * `answer`. A caller that acts for no persona (`key` undefined) gets `answer`.
 */
function latchedOr(
  key: string | undefined,
  answer: FindMissingResult | undefined,
  latchedKeys: ReadonlySet<string>,
): FindMissingResult | typeof FIND_MISSING_LATCHED | undefined {
  if (key === undefined) return answer
  return latchedKeys.has(key) || personaLatchedNow(key) ? FIND_MISSING_LATCHED : answer
}

/** The run's words in its log lines: `findMissing sweep`, or `bypassing findMissing sweep` for a bypassing run. */
function findMissingSweepWords(kind: FindMissingRunKind): string {
  return kind === FIND_MISSING_RUN_BYPASSING ? 'bypassing findMissing sweep' : 'findMissing sweep'
}

/**
 * Start one findMissing run (`sharedFindMissingSweep`): make the call, then,
 * on success, log the run's line, make the post-run `get`s
 * (`readListedPersonaRows`, whose latched and failed reads the run's outcome
 * carries), memoize the result unless a run started later
 * has been memoized already, and clear the in-flight slot while this run is
 * still in it. On failure only the slot is cleared (while this run is in it)
 * and the error is rethrown to every caller awaiting the run. The caller puts
 * the run in the in-flight slot.
 */
function startFindMissingRun(
  start: () => Promise<FindMissingResult>,
  kind: FindMissingRunKind,
  opts: FindMissingSweepOptions,
  logPrefix: string,
  ref: string,
): FindMissingRun {
  const seq = ++_findMissingRunSeq
  // Assigned before the call below can settle: `start` runs behind an await.
  let run: FindMissingRun | undefined
  const promise = (async (): Promise<FindMissingRunOutcome> => {
    let result: FindMissingResult
    try {
      // The async wrapper turns a synchronous throw from `start` into a rejection.
      result = await (async () => start())()
    } catch (err) {
      if (_findMissingInFlight === run) _findMissingInFlight = null
      throw err
    }
    const at = _now()
    const words = findMissingSweepWords(kind)
    console.error(
      `[slack] ${logPrefix}: ${words} for ${ref} — count=${result.count} ids=[${result.ids.join(',')}] unverified=${result.unverified} unverified_ids=[${result.unverified_ids.join(',')}]`,
    )
    const reads = await readListedPersonaRows(
      result,
      opts.nextStepGetKey,
      logPrefix,
      `${words} for ${ref}`,
      opts.startSweepRun === true ? START_SWEEP_ROUTED_CONTEXT : undefined,
    )
    if (_findMissingLast === null || _findMissingLast.seq < seq) _findMissingLast = { result, at, seq }
    if (_findMissingInFlight === run) _findMissingInFlight = null
    return { result, latchedKeys: reads.latchedKeys, refusedReads: reads.refusedReads }
  })()
  run = { seq, kind, promise }
  return run
}

/**
 * The persona key whose own row id `id` is (`cscb_<key>`, `personaInstanceId`)
 * when that key is a persona of the applied configuration now (the installed
 * `ConfiguredPersonaQuery`, `configuredReadingOf`); undefined for any other
 * id: another caller's row, a pre-persona row, a non-`cscb_` id, or the
 * `cscb_<key>` of a key outside the applied configuration (C14, C24). With no
 * query installed no id counts. Pure but for the query; never throws.
 */
function configuredPersonaKeyOfRowId(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id.startsWith(PERSONA_INSTANCE_ID_PREFIX)) return undefined
  const key = id.slice(PERSONA_INSTANCE_ID_PREFIX.length)
  if (key === '' || personaInstanceId(key) !== id) return undefined
  return configuredReadingOf(key).configured ? key : undefined
}

/**
 * The post-run `get`s of a findMissing run the server made (b.jg5 SRJ-120's
 * notes on CSCB's rows): each configured persona's own row listed in
 * `result.unverified_ids` (`configuredPersonaKeyOfRowId`, each persona once,
 * in list order), except `nextStepGetKey`'s, is read with one `get` through
 * the shared own-row read (`readPersonaOwnRow`, through
 * `withOutageDetection` for that persona, whatever persona the run was made
 * for), all at once, and the run waits for every one of them to settle.
 * A listed persona that is already latched when the keys are built
 * (`personaLatchedNow`; a latched query that throws counts as latched) is
 * skipped: no `get`, no latch call, nothing in the answer; its own caller
 * still stops on the latch (`latchedOr`).
 * SRJ-114's rule applies at each read: only a `provenance_conflict` note on
 * the persona's own row latches it, and the read logs its note lines
 * (`<logPrefix>: post-sweep get for persona=<key>: …`); a `get` answering
 * UNUSABLE NAME latches it too (b.jg5 SRJ-512), and that persona is among
 * the latched ones, so its caller stops (`FIND_MISSING_LATCHED`), except in
 * the start sweep's run (`unusableNameRoutedIn` set), where that answer is
 * routed per SRJ-1002 (its routed line), latches nothing and is carried as a
 * failed read below. A `get`
 * answering absent changes nothing. A `get` failing with any other error is carried
 * in the answer (`refusedReads`) for that persona's own caller to handle
 * (`postRunGetRefusal`); for every other caller it is only listed in the
 * line below. Neither ever fails the run, is memoized as a failure or stops
 * the other `get`s. No `get` is made for any other id. When at least one
 * listed persona was read or skipped, one line lists every one of them, in
 * `unverified_ids` order, with what its read answered or that it was skipped
 * (persona references only; a refused read carries the redacting
 * describer's text):
 *
 *   [slack] <logPrefix>: after the <run> — one get of each configured persona's own row in unverified_ids: persona=<key> <read|latched|absent|refused (<failure>)|skipped (latched)>, … (b.jg5 SRJ-120)
 *
 * where `<run>` is `findMissing sweep for <ref>` or `bypassing findMissing
 * sweep for <ref>`. No line is logged when no configured persona is listed.
 * Answers the personas whose read latched (`OwnRowRead.latched`, or the
 * `latched` answer) and the personas whose read failed, each with its error.
 * Never throws.
 */
async function readListedPersonaRows(
  result: FindMissingResult,
  nextStepGetKey: string | undefined,
  logPrefix: string,
  run: string,
  unusableNameRoutedIn: string | undefined,
): Promise<PostRunReads> {
  const latchedKeys = new Set<string>()
  const refusedReads = new Map<string, unknown>()
  // One entry per listed configured persona, in `unverified_ids` order: what
  // its `get` answered, or that it was skipped because it was already latched.
  const entries: string[] = []
  try {
    const listed: { readonly key: string; readonly skipped: boolean }[] = []
    for (const id of result.unverified_ids ?? []) {
      const key = configuredPersonaKeyOfRowId(id)
      if (key === undefined || key === nextStepGetKey || listed.some((l) => l.key === key)) continue
      // An already-latched persona gets no `get` (a latched query that throws counts as latched).
      listed.push({ key, skipped: personaLatchedNow(key) })
    }
    const toRead = listed.filter((l) => !l.skipped).map((l) => l.key)
    const settled = await Promise.allSettled(
      toRead.map((key) =>
        readPersonaOwnRow(
          key,
          unusableNameRoutedIn === undefined
            ? { site: logPrefix, what: 'post-sweep get' }
            : { site: logPrefix, what: 'post-sweep get', unusableNameRoutedIn },
        ),
      ),
    )
    const entryOf = new Map<string, string>()
    settled.forEach((outcome, i) => {
      const key = toRead[i]
      if (outcome.status === 'rejected') {
        // Not reached (`readPersonaOwnRow` never throws); that persona is left out of the line.
        console.error(`[slack] ${logPrefix}: after the ${run} — the post-sweep gets failed: ${describeThrownValue(outcome.reason)} (b.jg5 SRJ-120)`)
        return
      }
      const ownRead = outcome.value
      if (ownRead.kind === OWN_ROW_READ_ROW) {
        if (ownRead.latched) latchedKeys.add(key)
        entryOf.set(key, `${keyRef(key)} ${ownRead.latched ? 'latched' : 'read'}`)
      } else if (ownRead.kind === OWN_ROW_READ_LATCHED) {
        // b.jg5 SRJ-512: an UNUSABLE NAME answer latched the persona, so its caller stops.
        latchedKeys.add(key)
        entryOf.set(key, `${keyRef(key)} latched`)
      } else if (ownRead.kind === OWN_ROW_READ_ABSENT) {
        entryOf.set(key, `${keyRef(key)} absent`)
      } else {
        refusedReads.set(key, ownRead.error)
        entryOf.set(key, `${keyRef(key)} refused (${describeAgentDirectorFailure(ownRead.error)})`)
      }
    })
    for (const { key, skipped } of listed) {
      const entry = skipped ? `${keyRef(key)} skipped (latched)` : entryOf.get(key)
      if (entry !== undefined) entries.push(entry)
    }
  } catch (err) {
    // Not reached (nothing above throws); a throw ends the reads with what was read.
    console.error(`[slack] ${logPrefix}: after the ${run} — the post-sweep gets failed: ${describeThrownValue(err)} (b.jg5 SRJ-120)`)
  }
  if (entries.length > 0) {
    console.error(
      `[slack] ${logPrefix}: after the ${run} — one get of each configured persona's own row in unverified_ids: ${entries.join(', ')} (b.jg5 SRJ-120)`,
    )
  }
  return { latchedKeys, refusedReads }
}

/**
 * The bypassing findMissing run for persona `key` (b.jg5 SRJ-120): a new
 * `findMissing({})` call through `withOutageDetection` for `key`, whatever is
 * memoized or in flight; its result is memoized for later ordinary callers,
 * and ordinary callers arriving while it is in flight join it. After it, each
 * configured persona's own row listed in `unverified_ids` is read with one
 * `get` (`readListedPersonaRows`), except `nextStepGetKey`'s, the row the
 * caller's own next step reads with a `get`, and the row of a persona already
 * latched then, which is skipped with no `get`. Exactly these runs bypass, and
 * this is their one entry:
 *
 * - the live-row sequence's runs (b.jg5 SRJ-705) and an old-life wait's runs
 *   (SRJ-811);
 * - the pending-row rule's runs (SRJ-410);
 * - the run before the single retry that follows a latch re-check whose probe
 *   found the condition cleared, and the run after a latch clears by the
 *   re-check's step 1 or by `clear-latch` (SRJ-506).
 *
 * The live-row sequence's dependency builder binds it for the sequence's runs
 * (`buildLiveRowSequenceDeps`, with the persona's key as the next-step
 * `get`). Every other findMissing caller is an ordinary run.
 *
 * Answers as `reconcileMissingSweep` does: the result, `FIND_MISSING_REFUSED`
 * for a refusal of the run or of the post-run `get` of `key`'s own row (b.jg5
 * SRJ-105, SRJ-114: the caller stops its attempt),
 * `FIND_MISSING_LATCHED` when `key` is latched once the run is done (b.jg5
 * SRJ-502: the caller calls nothing more for it), or undefined for any other
 * failure, which is logged and never memoized and leaves the earlier memoized
 * result in place. A persona already latched before the run gets
 * `FIND_MISSING_LATCHED` too, whatever the run found (a refusal still answers
 * `FIND_MISSING_REFUSED`); a successful run's result is still memoized. Never
 * throws.
 *
 * @param key the persona the run is made for: its outage key and log context.
 * @param logPrefix distinguishes the call site in the log lines.
 * @param nextStepGetKey the persona whose own row the caller reads next with a `get`, if any.
 */
export async function bypassingFindMissingSweep(
  key: string,
  logPrefix: string,
  nextStepGetKey?: string,
): Promise<FindMissingSweepAnswer> {
  try {
    return await reconcileMissingSweep(key, logPrefix, keyRef(key), { kind: FIND_MISSING_RUN_BYPASSING, nextStepGetKey })
  } catch (err) {
    // Not reached (`reconcileMissingSweep` never throws).
    console.error(`[slack] ${logPrefix}: bypassing findMissing sweep failed for ${keyRef(key)}: ${describeThrownValue(err)} — proceeding`)
    return undefined
  }
}

/**
 * The reading of one row in a findMissing result (b.jg5 SRJ-120): agent-director
 * marked it `missing` (it is in `ids`).
 */
export const FIND_MISSING_ROW_MARKED_MISSING = 'marked-missing'
/** The row was judged and left live (it is in `unverified_ids`). */
export const FIND_MISSING_ROW_LEFT_LIVE = 'judged-left-live'
/**
 * The row was not judged: it was `pending` when last read and is in neither
 * list (inside the host's grace period, or its launch's worker process is
 * alive). Retry later; never a reason to escalate, alert or kill.
 */
export const FIND_MISSING_ROW_NOT_JUDGED = 'not-judged'
/** The row was judged alive: it was not `pending` when last read and is in neither list. */
export const FIND_MISSING_ROW_JUDGED_ALIVE = 'judged-alive'

/** What a findMissing result says of one row (`readFindMissingRow`). */
export type FindMissingRowReading =
  | typeof FIND_MISSING_ROW_MARKED_MISSING
  | typeof FIND_MISSING_ROW_LEFT_LIVE
  | typeof FIND_MISSING_ROW_NOT_JUDGED
  | typeof FIND_MISSING_ROW_JUDGED_ALIVE

/**
 * What findMissing result `result` says of row `id`, whose state was
 * `stateBefore` as last read before the run (b.jg5 SRJ-120; HO C2 step 2,
 * C14, C21, C23):
 *
 * - in `ids` → `FIND_MISSING_ROW_MARKED_MISSING`: marked `missing`;
 * - in `unverified_ids` → `FIND_MISSING_ROW_LEFT_LIVE`: judged and left live;
 * - in neither, `stateBefore` `pending` → `FIND_MISSING_ROW_NOT_JUDGED`: the
 *   run did not judge it (the row is inside the host's grace period, or its
 *   launch's worker process is alive);
 * - in neither, any other `stateBefore` → `FIND_MISSING_ROW_JUDGED_ALIVE`.
 *
 * `stateBefore` is required: a caller with no state read for the row has no
 * reading to ask for.
 *
 * "Not judged" means retry later, whatever time has passed, and is never a
 * reason to escalate, alert or kill (b.jg5 SRJ-410, SRJ-717). Pure: no state,
 * no call, no log line; never throws.
 */
export function readFindMissingRow(
  result: Pick<FindMissingResult, 'ids' | 'unverified_ids'>,
  id: string,
  stateBefore: string,
): FindMissingRowReading {
  if ((result.ids ?? []).includes(id)) return FIND_MISSING_ROW_MARKED_MISSING
  if ((result.unverified_ids ?? []).includes(id)) return FIND_MISSING_ROW_LEFT_LIVE
  return stateBefore === AGENT_DIRECTOR_PENDING_STATE ? FIND_MISSING_ROW_NOT_JUDGED : FIND_MISSING_ROW_JUDGED_ALIVE
}

/**
 * b.sv7 / Epic t1.tkk.e4: the escalate-dead → internal-sweep entry point, and
 * the single reusable place for it (do NOT inline the sweep at another call
 * site).
 *
 * When the tick/restart path escalates a persona as dead while its AD row
 * still looks alive (an `EscalateDeadVerdict`: a GONE answer, a refused
 * keystroke, a row found absent at a pane read, or a prompt row's tmux
 * session not found; 'dead-session' → 'escalate-dead'), CSCB
 * recovers itself instead of silently waiting on the external
 * `~/startup/find-missing-loop.sh`: emit an operator-visible log line, then run
 * the memoized, ordinary `reconcileMissingSweep` (b.m4r, b.jg5 SRJ-120). The
 * sweep may reconcile the frozen `working` row to `missing`; when the restart
 * run's second liveness probe (b.d61) then reads `dead`, it takes the normal
 * kill+relaunch branch at once. It may also leave the row live (in
 * `unverified_ids`, or, when `pending`, not judged), and the row may stay
 * live for further ticks: nothing promises that the re-probe or a later tick
 * reads it dead (b.jg5 SRJ-610). A re-probe reading `pending` or `unknown`
 * leaves the relaunch undone (`unknown` arms the retry timer); one that still
 * reads `live` ends the run with no kill, launch or counted failure, and each
 * later escalate-dead tick sweeps again here, with no step beyond the sweep,
 * while the restart path counts those re-probes and posts the slow-recovery
 * notice once after 3 such ticks (SRJ-1010). After a run the sweep makes,
 * each configured persona's own row left in `unverified_ids` is read with one
 * `get`, and only a `provenance_conflict` note there latches; the restart run
 * asks the latch right after the 'escalate-dead' verdict, before its re-probe,
 * so a persona latched that way gets no further agent-director call (b.jg5
 * SRJ-502), and again right before its kill (src/restart.ts). The external
 * loop remains belt-and-braces; removing it is a separate operator decision.
 *
 * The log line is emitted UNCONDITIONALLY here — before/outside the memoized
 * helper — because a memo hit returns silently and a sweep failure logs only
 * the generic failure line; an operator must see that recovery was triggered on
 * every escalate-dead verdict. `reconcileMissingSweep` stays module-private;
 * this wrapper, `sweepDeadTmuxChannelWithCause` and the bypassing entry
 * (`bypassingFindMissingSweep`) are its only exports.
 *
 * Never throws: `reconcileMissingSweep` already logs and swallows its own
 * failures (and does not memoize them, so a later escalate-dead tick's sweep
 * runs again).
 *
 * @param key the dead-tmux persona's key (log context; the sweep itself is
 *   whole-store, so one in-flight sweep serves the fleet — b.nk5).
 * @param verdict why the persona was escalated; the log line names it and
 *   says what it proves (`ESCALATE_DEAD_EVIDENCE`, b.jdc).
 */
export async function sweepDeadTmuxChannel(key: string, verdict: EscalateDeadVerdict): Promise<void> {
  await sweepDeadTmuxChannelWithCause(key, verdict)
}

/**
 * `sweepDeadTmuxChannel`, also saying whether the sweep was refused (b.jg5
 * SRJ-105, `FIND_MISSING_REFUSED`: the run, or the post-run `get` of the
 * persona's own row, SRJ-114). The restart path's reconnect adapter
 * (`src/server.ts`) then answers `transient` instead of `escalate-dead`, so
 * the restart run neither re-probes nor kills nor relaunches the persona. A
 * persona latched once the sweep is done (`FIND_MISSING_LATCHED`) answers as
 * an unrefused sweep: the restart run asks the latch right after the
 * 'escalate-dead' verdict, before its re-probe, and stops there with no
 * further agent-director call (b.jg5 SRJ-502).
 */
export async function sweepDeadTmuxChannelWithCause(key: string, verdict: EscalateDeadVerdict): Promise<{ refused?: true }> {
  console.error(escalateDeadSweepLine(key, verdict))
  return (await reconcileMissingSweep(key, 'escalate-dead')) === FIND_MISSING_REFUSED ? { refused: true } : {}
}

/**
 * The escalate-dead line `sweepDeadTmuxChannelWithCause` logs before each
 * sweep (b.sv7, b.jdc): the persona reference, the verdict and what it
 * observed (`ESCALATE_DEAD_EVIDENCE`). It names no outcome: the row may stay
 * live for further ticks, each escalate-dead tick sweeping again (b.jg5
 * SRJ-610).
 */
export function escalateDeadSweepLine(key: string, verdict: EscalateDeadVerdict): string {
  return `[slack] escalate-dead: ${keyRef(key)} verdict=${verdict} — ${ESCALATE_DEAD_EVIDENCE[verdict]}, triggering internal findMissing reconciliation (the row may stay live for further ticks, each escalate-dead tick sweeping again; ~/startup/find-missing-loop.sh is belt-and-braces)`
}

/**
 * Why the restart path's reconnect adapter escalated a persona as dead, by
 * what the verdict came from:
 * - from a GONE answer (`ErrTmuxSendKeys`, or `ErrTmuxCaptureFailed` at a
 *   pane read: agent-director found no session or pane of the row's launch,
 *   b.jg5 SRJ-104):
 *   - `dead-session`: the reconnect's one `send-keys` answered
 *     `ErrTmuxSendKeys` (cause `tmux-gone`; b.3ce, b.jg5 SRJ-609);
 *   - `working-tmux-gone`: its row reads `working` and the reconnect
 *     adapter's `read-pane` of the row answered GONE (b.d61, b.jg5 SRJ-603);
 *   - `waiting-row-pane-gone`: its row reads `waiting` and the waiting-row
 *     check's `read-pane` answered GONE (b.f2b, b.jg5 SRJ-604);
 *   - `prompt-row-tmux-gone`: its row reads `ask_user` or
 *     `check_permission` and the prompt-row verdict's one-line `read-pane`
 *     answered GONE (b.jdc, b.jg5 SRJ-606);
 * - from a refusal: `row-not-interactive`, agent-director refused the
 *   reconnect's keystrokes as not interactive (`ErrSpawnNotInteractive`,
 *   b.dup): a route into the restart path's decision only, which kills
 *   nothing because of it (b.jg5 SRJ-609);
 * - from a row read: `row-absent-at-pane-read`, the row was absent
 *   (`ErrSpawnNotFound`) at the `read-pane` of the `working`-row verdict,
 *   the waiting-row check or the prompt-row verdict, which takes the GONE
 *   column without being a GONE (b.jg5 SRJ-117), or at the reconnect's
 *   `send-keys` (cause `row-absent`, b.jg5 SRJ-118).
 * Neither a GONE (b.jg5 SRJ-613) nor a refusal as not interactive nor a row
 * read proves the worker's process gone, and every evidence text
 * (`ESCALATE_DEAD_EVIDENCE`) says only what was observed. Each verdict
 * records its origin as one of the labels above, apart from its evidence
 * text.
 */
export type EscalateDeadVerdict =
  | 'dead-session'
  | 'row-not-interactive'
  | 'working-tmux-gone'
  | 'waiting-row-pane-gone'
  | 'row-absent-at-pane-read'
  | 'prompt-row-tmux-gone'

/** The escalate-dead verdict of a `waiting` row whose `read-pane` answered GONE (b.jg5 SRJ-604). */
export const ESCALATE_DEAD_WAITING_ROW_PANE_GONE = 'waiting-row-pane-gone' satisfies EscalateDeadVerdict

/**
 * The escalate-dead verdict of a row found absent (`ErrSpawnNotFound`) at a
 * pane read (b.jg5 SRJ-117) or at the reconnect's `send-keys` (cause
 * `row-absent`, b.jg5 SRJ-118).
 */
export const ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ = 'row-absent-at-pane-read' satisfies EscalateDeadVerdict

/**
 * What each escalate-dead verdict observed, for its log line
 * (`sweepDeadTmuxChannelWithCause`, b.jdc): exactly one text per verdict.
 * No text says a tmux session or a worker is provably dead: a GONE says that
 * agent-director found no session or pane of the row's launch, an absent row
 * that the row read found none, and `row-not-interactive` that
 * agent-director refused the keystrokes as not interactive, which does not
 * prove the worker gone (a
 * finished row, or a `pending` row whose session may be another launch's,
 * b.jg5 SRJ-609, SRJ-613).
 */
export const ESCALATE_DEAD_EVIDENCE: Readonly<Record<EscalateDeadVerdict, string>> = Object.freeze({
  'dead-session':
    "agent-director's send-keys answered GONE (ErrTmuxSendKeys) at the /mcp reconnect: no session of the row's launch was found",
  'row-not-interactive':
    "row not interactive (agent-director refused the /mcp reconnect keystrokes as not interactive: the row finished, or a pending row's session may be another launch's; this does not prove the worker gone)",
  'working-tmux-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its working row",
  'waiting-row-pane-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its waiting row",
  'row-absent-at-pane-read':
    "its agent-director row was absent (ErrSpawnNotFound) at the pane read or the /mcp reconnect's send-keys: a row read, not a GONE",
  'prompt-row-tmux-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its ask_user or check_permission row",
})

/**
 * The escalate-dead verdict the restart path's reconnect adapter sweeps with
 * for a `dead-session` reconnect of cause `cause` (b.jg5 SRJ-118, SRJ-609):
 * `tmux-gone` gives `dead-session`, `row-not-interactive` gives
 * `row-not-interactive`, and `row-absent` gives `row-absent-at-pane-read`,
 * never `tmux-gone`'s verdict. A `dead-session` with no cause (none of
 * `reconnectMcpWithCause`'s answers) gives `dead-session`. Pure.
 */
export function escalateDeadVerdictOfCause(cause: DeadSessionCause | undefined): EscalateDeadVerdict {
  switch (cause) {
    case DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE:
      return 'row-not-interactive'
    case DEAD_SESSION_CAUSE_ROW_ABSENT:
      return ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ
    default:
      return 'dead-session'
  }
}

// ---------------------------------------------------------------------------
// Rows waiting on a prompt whose session may be gone (b.jdc)
// ---------------------------------------------------------------------------

/**
 * b.jdc: how long the restart path holds back from a persona whose row reads
 * `ask_user` or `check_permission` while its one-line `read-pane` answers a
 * pane or is taken as alive (UNAVAILABLE, CONFIG or UNCLASSIFIED, b.jg5
 * SRJ-606, SRJ-117), before each further deferral first runs the memoized
 * findMissing sweep and reads the row again (`checkPromptRowDeferral`). A
 * session that dies under a prompt keeps its row in that state:
 * agent-director only refreshes a row at SessionEnd and leaves reaping to its
 * sweep. A read that finds no pane of the row's launch (GONE) escalates at
 * once; this bounds what the read cannot tell: a pane does not show whether
 * a claude process still runs in it, and a read that could not answer is no
 * proof either way. Measured from the first deferral of the
 * run, on the session manager's clock (`_now`).
 */
export const PROMPT_ROW_SWEEP_AFTER_MS = 10 * 60 * 1000

/**
 * When each persona's current run of deferrals on its `ask_user` or
 * `check_permission` row began (b.jdc, on the session manager's clock
 * `_now`): the first time the restart path held back from the row on a pane
 * or a read taken as alive (`checkPromptRowDeferral`). It ends
 * (`endPromptRowDeferral`) when the row reads another state, when its
 * `read-pane` finds no pane of the row's launch (GONE) or finds no row, when
 * the row is escalated, when any launch for the persona starts, and with the
 * persona's not-connected episode (`forgetNotConnectedEpisode`). A failed
 * status call, a latched persona and a read answering ENVIRONMENT neither
 * extend nor end it.
 */
const promptRowDeferredSince = new Map<string, number>()

/**
 * Start persona `key`'s run in `runs` at its first deferral, and return how
 * long the run has lasted (ms, on `_now`). Shared by the `working`-row and
 * prompt-row deferral runs.
 */
function noteDeferralRun(runs: Map<string, number>, key: string): number {
  const now = _now()
  let since = runs.get(key)
  if (since === undefined) {
    since = now
    runs.set(key, since)
  }
  return now - since
}

/**
 * b.jdc: end persona `key`'s run of deferrals on its prompt row, so a later
 * deferral starts a new one. Silent; other personas are untouched.
 */
export function endPromptRowDeferral(key: string): void {
  promptRowDeferredSince.delete(key)
}

/** A row state that says the persona's claude process is gone: agent-director ended the row or marked it missing. */
function isDeadRowState(state: string | undefined): boolean {
  return state === 'ended' || state === 'missing'
}

/**
 * b.jdc: run the memoized findMissing sweep (b.m4r), then read persona
 * `key`'s row state again. Returns that state, or undefined when the read
 * failed (logged with `logPrefix` and `ref`). A failed sweep logs its own
 * line, and the row is read anyway, except a refused one (b.jg5 SRJ-105; the
 * run refused, or the post-run `get` of the persona's own row, SRJ-114):
 * then nothing is read and `FIND_MISSING_REFUSED` is returned. When the
 * persona is latched once the sweep is done (`FIND_MISSING_LATCHED`: a
 * post-run `get` of its row latched it, b.jg5 SRJ-114, SRJ-513, or the latch answers it
 * latched, b.jg5 SRJ-120, SRJ-502), nothing is read, one line is logged and
 * `FIND_MISSING_LATCHED` is returned:
 *
 *   [slack] <logPrefix>: <ref> is latched after the findMissing sweep — its row is not read; nothing more is called for it (b.jg5 SRJ-502)
 *
 * The row is read through the shared own-row `status` read
 * (`readPersonaOwnRowStatus`, b.jg5 SRJ-115): a read that latched the
 * persona (an UNUSABLE NAME answer, b.jg5 SRJ-512, or its own row reading
 * `pending` with no launch start, b.jg5 SRJ-513, logged there) answers
 * `FIND_MISSING_LATCHED` too, and its caller makes no further call and never
 * escalates. So does a persona latched elsewhere while that read was awaited
 * (`latchedAfterOwnRowRead`, b.jg5 SRJ-502), whatever the read gave, with
 * one line:
 *
 *   [slack] <logPrefix>: <ref> is latched after its status read after the findMissing sweep — nothing more is called for it (b.jg5 SRJ-502)
 *
 * Never throws.
 */
async function reconcileAndReadRowState(
  key: string,
  logPrefix: string,
  ref: string,
): Promise<string | typeof FIND_MISSING_REFUSED | typeof FIND_MISSING_LATCHED | undefined> {
  const sweep = await reconcileMissingSweep(key, logPrefix, ref)
  if (sweep === FIND_MISSING_REFUSED) return FIND_MISSING_REFUSED
  if (sweep === FIND_MISSING_LATCHED) {
    console.error(
      `[slack] ${logPrefix}: ${ref} is latched after the findMissing sweep — its row is not read; nothing more is called for it (b.jg5 SRJ-502)`,
    )
    return FIND_MISSING_LATCHED
  }
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const what = 'status read after the findMissing sweep'
  const read = await readPersonaOwnRowStatus(key, { site: logPrefix, what, ref })
  // b.jg5 SRJ-512, SRJ-513, SRJ-502: the read latched P (logged there): no further call.
  if (read.kind === OWN_ROW_STATUS_LATCHED) return FIND_MISSING_LATCHED
  // b.jg5 SRJ-502: P latched elsewhere while the read was awaited: no resume,
  // escalation or notice follows, whatever the read gave.
  if (latchedAfterOwnRowRead(key, logPrefix, what, ref)) return FIND_MISSING_LATCHED
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return read.state
    case OWN_ROW_STATUS_ABSENT:
      console.error(`[slack] ${logPrefix}: reading the row of ${ref} after the findMissing sweep failed: ${ERR_SPAWN_NOT_FOUND_NAME}`)
      return undefined
    case OWN_ROW_STATUS_REFUSED:
      console.error(`[slack] ${logPrefix}: reading the row of ${ref} after the findMissing sweep failed: ${describeAgentDirectorFailure(read.error)}`)
      return undefined
  }
}

/**
 * The UNAVAILABLE retry timer's row read (b.jg5 SRJ-303, SRJ-115): one read
 * of persona `key`'s row (`cscb_<key>`) through the shared own-row `status`
 * read (`readPersonaOwnRowStatus`), with no findMissing sweep before it and
 * no other call. Answers the row's `state` as agent-director reports it
 * (`pending`, `waiting`, `ended`, `missing` …), or
 * `UNAVAILABLE_RETRY_ROW_ABSENT` when there is no row (`ErrSpawnNotFound`,
 * recognised by name). On a `pending` row it also answers the launch start
 * the result shows (`launchStartedAt`, raw, `pendingLaunchStartOf`; absent
 * when not shown, and never answered for another state). A read that
 * latched the persona answers the state as the latch recorded it: an
 * UNUSABLE NAME answer (b.jg5 SRJ-512) as `unreadable`, which counts as
 * live, and its own row reading `pending` with no launch start (b.jg5
 * SRJ-513) as `pending`, so a configured persona's own such row never
 * reaches the pending-only retry as a row still to wait on (it latched
 * first; a row under an unconfigured key latches nothing and still does).
 * The latch's hold has stopped the persona's timer, and the retry
 * action asks the latched query right after this read and stops with the
 * latch's stop reason, handing nothing to the restart path. Every other
 * error is thrown to the caller; inside a recovery attempt for the persona
 * the wrapper has already reported it, so a `status` error arms the
 * persona's retry timer (SRJ-301). Logs nothing of its own.
 */
export async function readPersonaRowState(key: string): Promise<UnavailableRetryRowRead> {
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const read = await readPersonaOwnRowStatus(key, { site: 'unavailable-retry', what: 'retry row read' })
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return read.launchStartedAt === undefined ? { state: read.state } : { state: read.state, launchStartedAt: read.launchStartedAt }
    case OWN_ROW_STATUS_ABSENT:
      return { state: UNAVAILABLE_RETRY_ROW_ABSENT }
    case OWN_ROW_STATUS_LATCHED:
      // b.jg5 SRJ-305, SRJ-512, SRJ-513: the read latched P; the latch's hold
      // has stopped the timer, and the retry asks the latch next and stops.
      return { state: describeLatchRowState(read.rowState) }
    case OWN_ROW_STATUS_REFUSED:
      throw read.error
  }
}

/**
 * b.jdc — the restart path's check of a persona whose row reads `state`
 * (`ask_user` or `check_permission`) and whose one-line `read-pane` answered
 * a pane or was taken as alive (UNAVAILABLE, CONFIG or UNCLASSIFIED; the
 * reconnect adapter's `promptRowReconnectVerdict` in `server.ts`, which
 * types nothing into such a row; b.jg5 SRJ-606). Notes one more deferral
 * in the persona's run on the row (`promptRowDeferredSince`). Once the run
 * has lasted
 * `PROMPT_ROW_SWEEP_AFTER_MS`, it runs the memoized findMissing sweep and
 * reads the row again: `ended` or `missing` means the claude process is gone,
 * so it logs that, ends the run and returns `escalate`, and the adapter
 * escalates the persona as dead for the restart to relaunch. A refused sweep
 * (b.jg5 SRJ-105) returns `refused`: the row is not read, and the adapter
 * answers `transient`, so the restart run kills and launches nothing and
 * raises no notice. A persona latched once the sweep is done (b.jg5 SRJ-120,
 * SRJ-502: `reconcileAndReadRowState` answers `FIND_MISSING_LATCHED`) gets no
 * row read and is never escalated: `latched`, and the adapter answers
 * `transient` with no notice, since the persona is held (b.jg5 SRJ-502) and
 * its latch's own notice already tells the human (SRJ-508). Otherwise
 * `defer`: the adapter defers the row and raises its notice, as before.
 * Never throws.
 */
export async function checkPromptRowDeferral(key: string, state: string): Promise<'escalate' | 'defer' | 'refused' | 'latched'> {
  const heldMs = noteDeferralRun(promptRowDeferredSince, key)
  if (heldMs < PROMPT_ROW_SWEEP_AFTER_MS) return 'defer'
  const ref = keyRef(key)
  const after = await reconcileAndReadRowState(key, 'reconnectSession: prompt row', ref)
  if (after === FIND_MISSING_REFUSED) return 'refused'
  // b.jg5 SRJ-502: a persona latched after the sweep is never escalated, and
  // gets no not-connected notice.
  if (after === FIND_MISSING_LATCHED) return 'latched'
  if (!isDeadRowState(after)) return 'defer'
  endPromptRowDeferral(key)
  console.error(
    `[slack] reconnectSession: ${ref} has read ${state} for ${describeWaitSpan(heldMs)} of deferrals, and after a findMissing sweep its row reads ${after} — its claude process is gone; not deferring, the restart relaunches it (b.jdc)`,
  )
  return 'escalate'
}

/**
 * b.jdc, b.jg5 SRJ-607 — the collision ladder's action for persona
 * `persona`'s row read `state` (`ask_user` or `check_permission`), b.jg5
 * SRJ-117's "b.jdc ladder action" column. Nothing is ever typed into such a
 * row (b.rmy). Its session may be gone, though: a session that dies under a
 * prompt keeps its row in that state until a findMissing sweep reaps it. So
 * the ladder makes one `read-pane` of the persona's own row through the
 * shared reader (`readPersonaOwnPane`: `PROBE_PANE_READ_LINES`, the
 * collision `get`'s state as the recorded state), with no tmux call, mapped:
 * - a pane → no action (`no-op`), as before; the health check's restart path
 *   reports the prompt if the persona stays disconnected. The pane may be a
 *   single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no proof that the
 *   worker's own session is there, and nothing is typed on it. The backstop
 *   is the later reconnect's `send-keys` (`reconnectMcpWithCause`), made
 *   only once the row reads `waiting`, or shows a `working` row stale: on a
 *   live row that is not `pending` it answers CONFLICT "not this launch's
 *   session" when a leftover holds the persona's session, and then nothing
 *   is typed, P latches (b.jg5 SRJ-501) with its CONFLICT notice posted
 *   once, and the refused `send-keys` is never retried (SRJ-118);
 * - GONE (`ErrTmuxCaptureFailed`: agent-director found no pane of the row's
 *   launch), or the row absent (`ErrSpawnNotFound`, which takes the GONE
 *   column, b.jg5 SRJ-117) → the memoized findMissing sweep, then the row is
 *   read again: `ended` or `missing` is recovered through
 *   `resumeOrFreshSpawn`, with that re-read as the state last read (a
 *   finished row, so any replacement there is a reuse spawn of the same id,
 *   b.jg5 SRJ-707), whose resume or spawn decides what holds the
 *   persona's name; anything else (or a failed read) is left as it is
 *   (`no-op`), for the restart path to retry. A refused sweep (b.jg5
 *   SRJ-105) reads nothing and answers `failed`: no resume or launch. A
 *   persona latched before the sweep (b.jg5 SRJ-502, `personaLatchedNow`),
 *   or once it is done (b.jg5 SRJ-120: `FIND_MISSING_LATCHED`, the re-read
 *   included), answers `latched`: no further call, no resume, kill, delete
 *   or launch;
 * - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *   `ad-config-malformed` outage, b.jg5 SRJ-316) or UNCLASSIFIED (b.jg5
 *   SRJ-105) → taken as alive: `no-op`, with one line naming the class;
 * - ENVIRONMENT (the wrapper raised the `tmux-unavailable` outage, b.jg5
 *   SRJ-311) → `no-op`, with one line naming the class;
 * - an UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *   `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *   SRJ-205) → a `failed` result marked `stopping`, as at the working-row
 *   wait: no post, no `spawn-failed` entry, nothing counted;
 * - CONFLICT or UNUSABLE NAME (the reader latched the persona with the
 *   collision `get`'s state and logged its line, b.jg5 SRJ-501, SRJ-512), or
 *   a persona already latched, which the reader does not read → `latched`,
 *   nothing typed.
 * Each log line but the pane's `no-op` comes from an exported builder
 * (`promptRowLadderNoPaneLine`, `promptRowLadderAfterSweepLine`,
 * `promptRowLadderNoActionLine`, `promptRowLadderStoppingLine`,
 * `promptRowLadderLatchedLine`).
 */
async function launchOnPromptRow(
  run: LadderRun,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  state: string,
): Promise<SpawnPersonaResult> {
  const { persona, config, ref } = run
  const { key } = persona
  const read = await readPersonaOwnPane(key, {
    nLines: PROBE_PANE_READ_LINES,
    // b.jg5 SRJ-501: the collision `get` is the path's last read.
    lastRead: latchRowStateRead(state),
    site: PROMPT_ROW_LADDER_PANE_READ_SITE,
  })
  switch (read.kind) {
    case PANE_READ_PANE:
      console.error(`[slack] spawnForPersona: no action — state=${state} for ${ref}`)
      return { key, action: 'no-op' }
    case PANE_READ_LATCHED:
      console.error(promptRowLadderLatchedLine(ref, state))
      return { key, action: 'latched' }
    case PANE_READ_UNCLASSIFIED:
      if (read.stopping === true) {
        console.error(promptRowLadderStoppingLine(ref, state, read))
        return { key, action: 'failed', stopping: true }
      }
      console.error(promptRowLadderNoActionLine(ref, state, read))
      return { key, action: 'no-op' }
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
    case PANE_READ_ENVIRONMENT:
      console.error(promptRowLadderNoActionLine(ref, state, read))
      return { key, action: 'no-op' }
    case PANE_READ_GONE:
    case PANE_READ_ABSENT:
      break
  }
  console.error(promptRowLadderNoPaneLine(ref, state, read))
  // b.jg5 SRJ-502: latched elsewhere while the read was awaited → no sweep.
  if (personaLatchedNow(key)) {
    console.error(promptRowLadderLatchedLine(ref, state))
    return { key, action: 'latched' }
  }
  const after = await reconcileAndReadRowState(key, 'spawnForPersona: prompt row', ref)
  if (after === FIND_MISSING_REFUSED) return { key, action: 'failed' }
  // b.jg5 SRJ-502: a persona latched after the sweep gets no further call.
  if (after === FIND_MISSING_LATCHED) return { key, action: 'latched' }
  if (isDeadRowState(after)) {
    console.error(`[slack] spawnForPersona: dead session for ${ref} (state=${state}) — recovering via resume/fresh-spawn`)
    // b.jg5 SRJ-501: the re-read after the sweep is the path's last read.
    return resumeOrFreshSpawn(run, row, { lastRead: latchRowStateRead(after) })
  }
  const next = config.session_restart_delay === 0
    ? 'session_restart_delay is 0, so nothing retries it before the next server start'
    : "the health check's restart retries it"
  console.error(promptRowLadderAfterSweepLine(ref, read, after, next))
  return { key, action: 'no-op' }
}

/** The site label of the ladder's prompt-row read, the head of the shared reader's latch line. */
const PROMPT_ROW_LADDER_PANE_READ_SITE = 'spawnForPersona: prompt row'

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * one-line `read-pane` answered GONE or found the row absent (b.jdc, b.jg5
 * SRJ-607, SRJ-117); `read` is that failure. Exported for tests.
 *
 * @internal
 */
export function promptRowLadderNoPaneLine(ref: string, state: string, read: PaneReadFailure): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} but ${promptRowLadderNoPaneFinding(read)}: ${read.description} — reconciling its row before deciding (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-607)`
}

/**
 * What the prompt-row ladder's pane read found, shared by
 * `promptRowLadderNoPaneLine` and `promptRowLadderAfterSweepLine` so the two
 * cannot drift: an absent row (`ErrSpawnNotFound`) is a row read, not a GONE
 * (b.jg5 SRJ-117), and its line says so.
 */
function promptRowLadderNoPaneFinding(read: Pick<PaneReadFailure, 'kind'>): string {
  return read.kind === PANE_READ_ABSENT
    ? 'its agent-director row was absent at the pane read'
    : "agent-director's read-pane found no pane of its launch"
}

/**
 * `launchOnPromptRow`'s line when, after a GONE or absent read (`read`) and
 * the findMissing sweep, persona `ref`'s row could not be read (`after`
 * undefined) or still reads `after`, a state that is not `ended` or
 * `missing`: no action; `next` says what retries it (b.jdc, b.jg5 SRJ-607,
 * SRJ-117). Exported for tests.
 *
 * @internal
 */
export function promptRowLadderAfterSweepLine(
  ref: string,
  read: Pick<PaneReadFailure, 'kind'>,
  after: string | undefined,
  next: string,
): string {
  return `[slack] spawnForPersona: ${ref}: ${promptRowLadderNoPaneFinding(read)}, but its row ${after === undefined ? 'could not be read' : `still reads ${after}`} after the findMissing sweep — no action; ${next} (b.jdc, b.jg5 SRJ-607)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * one-line `read-pane` answered UNAVAILABLE, CONFIG or UNCLASSIFIED (taken
 * as alive) or ENVIRONMENT (tmux is not available): no action (b.jdc, b.jg5
 * SRJ-607, SRJ-117, SRJ-105, SRJ-311); `read` is that failure. Exported for
 * tests.
 *
 * @internal
 */
export function promptRowLadderNoActionLine(ref: string, state: string, read: PaneReadFailure): string {
  const why = read.kind === PANE_READ_ENVIRONMENT
    ? 'tmux is not available'
    : 'taken as alive (no proof the session is gone)'
  return `[slack] spawnForPersona: ${ref} reads ${state} and reading its pane failed: ${read.description} — ${why}; no action (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-607, SRJ-117)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * `read-pane` carried the stop mark of a version re-check that decided that
 * the server stops (b.jg5 SRJ-204, SRJ-205); `read` is that failure.
 * Exported for tests.
 *
 * @internal
 */
export function promptRowLadderStoppingLine(ref: string, state: string, read: PaneReadFailure): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and the
 * persona is latched: the shared reader's CONFLICT or UNUSABLE NAME answer
 * latched it (the reader logged that line), it was already latched and was
 * not read, or it latched elsewhere while the read was awaited (b.jg5
 * SRJ-501, SRJ-502, SRJ-512). Exported for tests.
 *
 * @internal
 */
export function promptRowLadderLatchedLine(ref: string, state: string): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} and is latched — no action; nothing typed and nothing more is called for it (b.jg5 SRJ-502)`
}

/**
 * Poll `status({claude_instance_id})` until the spawn transitions to
 * `waiting`, then call reconnectMcp. Transitions to live transient states
 * (ask_user, check_permission, pending) return 'not-reconnected' (b.f2b;
 * 'ok' before); recovery is then the health-check tick's job — post-b.9a7 the
 * tick observes the row as alive && !connected and routes it through
 * scheduleRestart -> reconnect. 'ok' now always means `/mcp reconnect` was
 * typed.
 *
 * b.f2b — a stale `working` row. agent-director can leave a row `working`
 * after the turn ended, so while the row reads `working` the wait also reads
 * its evidence, every `WORKING_ROW_READ_INTERVAL_MS` (`staleWorkingRowIsIdle`):
 * the persona's pane and, when that shows an idle screen, the session's
 * transcript. The row is stale only on the positive-idle rule
 * (`foldWorkingPaneRun`): for the whole `STALE_WORKING_WINDOW_MS`, every read
 * showed the same idle screen (no spinner, busy hint, API retry row, prompt
 * or dialog) AND the same transcript, unchanged, ending with a completed turn.
 * Then it reconnects, as the `waiting` branch does. A live turn never ends its
 * transcript with a completed turn, an API retry or stall included (which can
 * hide the spinner and hold the screen still), so it is never taken for idle
 * and never typed into (the b.rmy invariant). A transcript that can't be
 * located or read is no evidence. A pane that shows a prompt or dialog for
 * the window is never typed into either: the wait goes on, and the prompt is
 * logged and reported through the not-connected notice, once. The reconnect
 * is part of the launch, not an auto-restart, so it runs whatever
 * `session_restart_delay` is, like the `waiting` branch's. Each poll that
 * reads the row `working` and doesn't reconnect it is one more deferral in
 * the persona's run on the row (`noteWorkingRowDeferral`), and so is the
 * timeout on a `working` row: once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised, at
 * any restart delay (once per episode). Any other state ends the run.
 *
 * b.f2b — every wait that ends without reconnecting a live session (a live
 * transient state at the poll; at the timeout, a live row or a failed
 * `status` read) returns 'not-reconnected' and says what happens next for
 * the restart delay in effect: with `session_restart_delay` 0 nothing will
 * reconnect the persona, so the not-connected notice is raised (once per
 * episode) instead of claiming the health check will
 * (`reportWaitEndedDisconnected`, its line and notice built by
 * `waitEndedOnStateReport`, `waitTimedOutLiveReport` and
 * `waitTimedOutUnreadReport`): the `blocked-on-prompt` notice when the row
 * ended at `ask_user` or `check_permission`, `unproven-idle` when the timeout
 * finds it `working`, the `auto-restart-disabled` one otherwise.
 *
 * b.f2b — a teardown cancels the wait (`cancelWorkingRowWait`). The wait
 * checks after each agent-director call and wakes from its poll sleep at
 * once, types nothing once cancelled, and returns 'cancelled'.
 *
 * b.jg5 SRJ-502 — the wait asks whether its persona is latched at the same
 * points, after each agent-director call it makes (its `find-missing` runs,
 * `status` polls, pane reads and transcript `get`s): a latch its transcript
 * `get` set (a `provenance_conflict` note, b.jg5 SRJ-114), one a `find-missing`
 * run's post-run `get` set (b.jg5 SRJ-120), or one set elsewhere ends it
 * with 'latched', one line, no further call, nothing typed and no
 * not-connected notice. A cancelled wait still answers 'cancelled'.
 *
 * b.ecw, b.jg5 SRJ-605 — every terminal branch keys on agent-director's row
 * for the claude process; the wait makes no tmux probe. Where it answers
 * 'dead-session', the recovery's resume or spawn (`resumeOrFreshSpawn`)
 * decides what holds the persona's name: agent-director classifies any
 * leftover session, and a CONFLICT there latches the persona (b.jg5
 * SRJ-501). A 'dead-session' from a row read is not dead evidence (b.jg5
 * SRJ-611).
 *   - ended/missing branch: `ended` means SessionEnd fired (the process
 *     exited); `missing` after the up-front sweep is agent-director's
 *     evidence-based verdict that the process is gone. Returns
 *     'dead-session' directly.
 *   - timeout branch: a FRESH findMissing sweep (the 10s memo has long
 *     expired at the 10-minute deadline) + one status call. A `waiting` row
 *     is reconnected (b.f2b); a process mid-long-turn is left alive,
 *     'not-reconnected' (the b.rmy/b.3ce long-turn guard); only a row that
 *     reads `ended` or `missing`, or is absent, returns 'dead-session'.
 *   - an absent row (`ErrSpawnNotFound`), at the poll or the timeout
 *     `status`: one line, then 'dead-session'.
 *   - any other `status` error (UNAVAILABLE, a timeout, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED, `ErrSystemInstallDisappeared` included; b.jg5 SRJ-605):
 *     never 'dead-session', 'transient' or a refusal. At the poll the wait goes
 *     on to its next poll with no post, logging its first failed read and
 *     again only when the class changes; at the timeout it ends
 *     'not-reconnected' through `reportWaitEndedDisconnected`. The wrapper
 *     raised the error's outage (`ad-unreachable`, `tmux-unavailable`,
 *     `ad-config-malformed`), armed the persona's retry timer and reported
 *     an UNCLASSIFIED answer to its episode, as at any row read in a launch
 *     attempt (b.jg5 SRJ-105, SRJ-301), so the launch's result follows the
 *     wait's outcome.
 *   - an UNUSABLE NAME answer (b.jg5 SRJ-105, SRJ-512), or the persona's own
 *     row reading `pending` with no launch start (b.jg5 SRJ-513), at the
 *     poll or the timeout `status` (both through `readPersonaOwnRowStatus`),
 *     or an UNUSABLE NAME at a pane read or transcript `get` of the evidence
 *     read: the persona latches and the wait ends 'latched', with nothing
 *     typed, no not-connected notice and never 'dead-session'. A `status`
 *     answer records what it read (`wait.lastRead`); a pane read records the
 *     wait's last read; a transcript `get` that read a row, or no row,
 *     becomes the wait's last read (b.jg5 SRJ-501).
 *   - a CONFLICT at the evidence read's pane read (b.jg5 SRJ-608): the
 *     shared reader latches the persona with the refused operation "P's next
 *     check or recovery" and the wait's last read, and the wait ends
 *     'latched' at once, with no further call and nothing typed. Every other
 *     failed pane read (GONE, an absent row, UNAVAILABLE, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED) is no evidence and the wait goes on.
 *   - an UNCLASSIFIED at the evidence read's pane read carrying the stop mark
 *     (`stopping`: the shared reader's `ErrInvalidFlags` re-check decided
 *     that the server stops, b.jg5 SRJ-205): one line, then 'transient' with
 *     the stop noted on the wait, no further call and nothing typed; the
 *     ladder answers a `failed` result marked `stopping`, as for a resume's
 *     re-check stop.
 *   - a refused findMissing sweep (b.jg5 SRJ-105), up front or at the
 *     timeout: its refusal line, then 'transient' with no status read.
 *   - the reconnect (`reconnectMcpWithCause`, made on a row read `waiting`,
 *     at the poll or the timeout, or on a stale `working` row, with that row
 *     state as its last read): its outcome is the wait's, unchanged (b.jg5
 *     SRJ-118). A `transient` reconnect that latched the persona, or found it
 *     latched, is noted on the wait so the ladder answers `latched`; one
 *     whose `ErrInvalidFlags` re-check decided the stop is noted as a stop.
 *     It is never retried.
 */
export async function waitForWaitingAndReconnect(
  key: string,
  config: PersonaConfig,
  ref: string = keyRef(key),
): Promise<WaitReconnectOutcome> {
  return (await waitForWaitingAndReconnectWithCause(key, config, ref)).outcome
}

/**
 * `waitForWaitingAndReconnect`, also saying, for a `transient` outcome,
 * whether the persona is latched (`latched`: the wait's reconnect latched it
 * or found it latched, b.jg5 SRJ-118) or the server stops (`stopping`, b.jg5
 * SRJ-205: a version re-check, the evidence read's or the reconnect's,
 * decided it). `lastRead` is the row state the wait's last read gave (b.jg5
 * SRJ-501), absent when none answered.
 */
async function waitForWaitingAndReconnectWithCause(
  key: string,
  config: PersonaConfig,
  ref: string,
): Promise<{ outcome: WaitReconnectOutcome; latched?: true; stopping?: true; lastRead?: LatchRowState }> {
  const wait: WorkingRowWait = { cancelled: cancelledLaunchWaits.has(key), wake: () => {} }
  workingRowWaits.set(key, wait)
  try {
    const outcome = await waitForWorkingRow(key, config, ref, wait)
    const lastRead = wait.lastRead === undefined ? {} : { lastRead: wait.lastRead }
    if (outcome !== 'transient') return { outcome, ...lastRead }
    if (wait.stopping) return { outcome, stopping: true, ...lastRead }
    return wait.latched ? { outcome, latched: true, ...lastRead } : { outcome, ...lastRead }
  } finally {
    if (workingRowWaits.get(key) === wait) workingRowWaits.delete(key)
  }
}

/**
 * The wait's reconnect (b.jg5 SRJ-118): `reconnectMcpWithCause` with
 * `lastRead`, the row state the wait read just before (`waiting`, or
 * `working` for a stale row), answering its outcome unchanged and noting on
 * `wait` a `transient` one's latch or stop.
 */
async function reconnectInWait(key: string, ref: string, wait: WorkingRowWait, lastRead: LatchRowState): Promise<ReconnectOutcome> {
  const result = await reconnectMcpWithCause(key, lastRead, ref)
  if (result.latched) wait.latched = true
  if (result.stopping) wait.stopping = true
  return result.outcome
}

/**
 * The wait's answer after a refused findMissing sweep (b.jg5 SRJ-105), which
 * logged its own refusal line: 'cancelled' for a wait its teardown cancelled
 * meanwhile (or 'latched' for a persona latched meanwhile), otherwise
 * 'transient': nothing typed, nothing counted. No status read, reconnect or
 * 'dead-session' verdict follows.
 */
function refusedWaitSweep(key: string, ref: string, wait: WorkingRowWait): WaitReconnectOutcome {
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  return 'transient'
}

/** `waitForWaitingAndReconnect`'s body, with its cancellable `wait` (b.f2b). */
async function waitForWorkingRow(
  key: string,
  config: PersonaConfig,
  ref: string,
  wait: WorkingRowWait,
): Promise<WaitReconnectOutcome> {
  const pollIntervalMs = config.agent_director_poll_interval_ms
  const waitStartedAt = _now()
  const deadline = waitStartedAt + _waitForWaitingTimeoutMs
  /** The class of the poll's last logged `status` error (b.jg5 SRJ-605); undefined before the first. */
  let loggedStatusErrorClass: AdErrorClass | undefined
  const paneWatch: WorkingPaneWatch = {
    run: undefined,
    lastReadAt: undefined,
    readFailureLogged: false,
    transcriptNote: undefined,
    promptReported: false,
  }

  // b.m4r: a bot killed mid-turn never fires SessionEnd, so its AD row freezes
  // at `working`. Without a reconcile, the poll below spins on `status` for the
  // full 10-minute window before the timeout branch's sweep + status finally
  // decides — the persona stays down that whole time. Run AD's per-row,
  // evidence-based findMissing sweep ONCE up front (agent-director plan b.93m,
  // t1.93m.hp: degraded-mode guard removed, shipped ≥ 0.8.0). A genuinely-dead
  // row reconciles to `missing`, so the FIRST status poll below hits the
  // ended/missing branch and returns 'dead-session' directly in seconds (b.ecw:
  // process-keyed, no tmux probe); a genuinely-alive long-turn row is untouched
  // by the evidence-based sweep and keeps today's polling behavior (b.rmy
  // long-turn guard preserved). Prefer
  // AD's findMissing verb over a CSCB-side tmux reconcile per
  // docs/engineering-guide.md ("Avoiding Duplicated Effort"), mirroring
  // resumeOrFreshSpawn's reconcileMissingFirst branch. On a findMissing
  // error, log and fall through to the existing poll loop (today's
  // behavior), except a refused sweep (b.jg5 SRJ-105): nothing more is
  // called, and the wait answers 'transient'.
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  const upFrontSweep = await reconcileMissingSweep(key, 'waitForWaitingAndReconnect', ref)
  if (upFrontSweep === FIND_MISSING_REFUSED) return refusedWaitSweep(key, ref, wait)
  // b.jg5 SRJ-120, SRJ-502: a persona latched once the sweep is done ends the wait.
  if (upFrontSweep === FIND_MISSING_LATCHED) return endWait(ref, wait)

  while (_now() < deadline) {
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
    const read = await readPersonaOwnRowStatus(key, { site: 'waitForWaitingAndReconnect', what: 'status read', ref })
    // b.jg5 SRJ-105, SRJ-512, SRJ-513: the read latched P (an UNUSABLE NAME
    // answer, recorded unreadable, or its own row reading `pending` with no
    // launch start, recorded `pending`): the wait ends `latched`, nothing
    // typed and no not-connected notice.
    if (read.kind === OWN_ROW_STATUS_LATCHED) {
      wait.lastRead = read.rowState
      return endWait(ref, wait)
    }
    let state: string
    if (read.kind === OWN_ROW_STATUS_STATE) {
      state = read.state
      wait.lastRead = latchRowStateRead(state)
    } else {
      if (waitMustEnd(key, wait)) return endWait(ref, wait)
      if (read.kind === OWN_ROW_STATUS_ABSENT) {
        // b.jg5 SRJ-605: the row is absent (`ErrSpawnNotFound`): 'dead-session'
        // with no tmux probe; the recovery's spawn classifies any leftover
        // session. A row read, so not dead evidence (b.jg5 SRJ-611).
        wait.lastRead = LATCH_ROW_STATE_NO_ROW
        console.error(waitRowAbsentLine(ref))
        return 'dead-session'
      }
      // b.jg5 SRJ-605: any other `status` error (UNAVAILABLE, ENVIRONMENT,
      // CONFIG, UNCLASSIFIED, `ErrSystemInstallDisappeared` included) is
      // transient: the wait goes on to its next poll, with no post and no
      // result of its own. The wrapper has raised the error's outage, armed
      // the retry timer and reported an UNCLASSIFIED episode (b.jg5 SRJ-105,
      // SRJ-301). The wait's first failed read is logged, and again only
      // when the class changes.
      const errorClass = classifyAdError(read.error).errorClass
      if (errorClass !== loggedStatusErrorClass) {
        loggedStatusErrorClass = errorClass
        console.error(waitPollStatusErrorLine(ref, describeAgentDirectorFailure(read.error), errorClass))
      }
      await sleepUnlessCancelled(wait, pollIntervalMs)
      continue
    }
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    // b.f2b: a run of deferrals on the `working` row ends with any other state.
    if (state !== 'working') endWorkingRowDeferral(key)

    if (state === 'waiting') {
      return reconnectInWait(key, ref, wait, latchRowStateRead(state))
    }

    if (state === 'working') {
      // b.f2b: a stale row — the positive-idle rule held for the whole window
      // (the same idle screen and the same ended, unchanged transcript) — is
      // reconnected like a `waiting` one.
      const stale = await staleWorkingRowIsIdle(key, ref, config, paneWatch, wait)
      // b.jg5 SRJ-608: the evidence read latched P (a pane read's CONFLICT
      // or UNUSABLE NAME): `latched` at once, nothing more called or typed.
      if (stale === WAIT_OUTCOME_LATCHED) return endWait(ref, wait)
      // b.jg5 SRJ-205: the pane read's version re-check decided the stop.
      if (stale === WORKING_EVIDENCE_STOPPING) {
        wait.stopping = true
        return 'transient'
      }
      // b.jg5 SRJ-502: E14's after-call check — a latch set elsewhere, or a
      // cancel, ends the wait.
      if (waitMustEnd(key, wait)) return endWait(ref, wait)
      if (stale) {
        endWorkingRowDeferral(key)
        return reconnectInWait(key, ref, wait, latchRowStateRead(state))
      }
      // b.f2b: held back again; a run that has lasted
      // UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice.
      noteWorkingRowDeferral(key, config.session_restart_delay === 0)
      await sleepUnlessCancelled(wait, pollIntervalMs)
      continue
    }

    // b.ecw: this branch keys on the row agent-director keeps for the claude
    // process. `ended` means SessionEnd fired (the process exited); `missing`
    // (after the up-front reconcileMissingSweep) is agent-director's
    // evidence-based verdict that the process is gone. Either way the wait
    // returns 'dead-session' directly, with no tmux probe, and the recovery's
    // resume or spawn (resumeOrFreshSpawn) decides what holds the persona's
    // name: agent-director classifies any leftover session. A row read, so
    // not dead evidence (b.jg5 SRJ-611). Live transient states (ask_user,
    // check_permission, pending) fall through to 'not-reconnected' below
    // (b.f2b).
    if (state === 'ended' || state === 'missing') {
      console.error(`[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} (claude process gone) — dead session`)
      return 'dead-session'
    }

    return reportWaitEndedDisconnected(key, config, waitEndedOnStateReport(ref, state))
  }

  // b.ecw: timed out — key on agent-director's row for the claude process.
  // The up-front sweep's 10s memo has long expired at the 10-minute
  // deadline, so run a FRESH reconcileMissingSweep (a real whole-store
  // findMissing) to reconcile a row frozen at `working`, then one status call.
  // - ended/missing → the process is gone → 'dead-session'.
  // - waiting → the turn ended at the deadline: reconnect (b.f2b).
  // - any other live state (working/ask_user/check_permission/pending) → a
  //   process merely mid-long-turn is left alive, 'not-reconnected' (b.f2b;
  //   the b.rmy/b.3ce long-turn guard).
  // - ErrSpawnNotFound → the row is absent: 'dead-session', with no tmux
  //   probe, as at the poll; the recovery's spawn classifies any leftover
  //   session (b.jg5 SRJ-605).
  // - any other status error → 'not-reconnected' through
  //   reportWaitEndedDisconnected, never 'dead-session' or 'transient' (b.jg5
  //   SRJ-605); an UNUSABLE NAME answer, or the row reading `pending` with
  //   no launch start, latches the persona and ends the wait 'latched'
  //   (b.jg5 SRJ-512, SRJ-513).
  // - a refused sweep → 'transient' with no status read (b.jg5 SRJ-105).
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  const timeoutSweep = await reconcileMissingSweep(key, 'waitForWaitingAndReconnect: timeout', ref)
  if (timeoutSweep === FIND_MISSING_REFUSED) return refusedWaitSweep(key, ref, wait)
  // b.jg5 SRJ-120, SRJ-502: a persona latched once the sweep is done ends the wait.
  if (timeoutSweep === FIND_MISSING_LATCHED) return endWait(ref, wait)
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const timeoutRead = await readPersonaOwnRowStatus(key, {
    site: 'waitForWaitingAndReconnect: timeout',
    what: 'status read',
    ref,
  })
  // b.jg5 SRJ-105, SRJ-512, SRJ-513: the read latched P (an UNUSABLE NAME
  // answer, recorded unreadable, or its own row reading `pending` with no
  // launch start, recorded `pending`, b.jg5 SRJ-501): the wait ends
  // `latched`, nothing typed, never 'dead-session'.
  if (timeoutRead.kind === OWN_ROW_STATUS_LATCHED) {
    wait.lastRead = timeoutRead.rowState
    return endWait(ref, wait)
  }
  if (timeoutRead.kind !== OWN_ROW_STATUS_STATE) {
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    if (timeoutRead.kind === OWN_ROW_STATUS_ABSENT) {
      // b.jg5 SRJ-605: the row is absent: 'dead-session' with no tmux probe,
      // as at the poll; not dead evidence (b.jg5 SRJ-611).
      wait.lastRead = LATCH_ROW_STATE_NO_ROW
      console.error(waitRowAbsentLine(ref, _waitForWaitingTimeoutMs))
      return 'dead-session'
    }
    // b.jg5 SRJ-605: any other `status` error (`ErrSystemInstallDisappeared`
    // included) ends the wait 'not-reconnected', never 'dead-session' or
    // 'transient'; the wrapper has raised its outage and armed the retry timer.
    const err = timeoutRead.error
    return reportWaitEndedDisconnected(
      key,
      config,
      waitTimedOutUnreadReport(ref, _waitForWaitingTimeoutMs, describeAgentDirectorFailure(err), classifyAdError(err).errorClass),
    )
  }
  const timeoutState = timeoutRead.state
  wait.lastRead = latchRowStateRead(timeoutState)
  if (waitMustEnd(key, wait)) return endWait(ref, wait)

  if (timeoutState !== 'working') endWorkingRowDeferral(key)
  if (timeoutState === 'ended' || timeoutState === 'missing') {
    console.error(
      `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${_waitForWaitingTimeoutMs}ms — claude process state=${timeoutState} (gone) — dead session`,
    )
    return 'dead-session'
  }
  // b.f2b: the row settled at the deadline — reconnect, as the loop would have.
  if (timeoutState === 'waiting') return reconnectInWait(key, ref, wait, latchRowStateRead(timeoutState))
  // b.f2b: a `working` row given up on is one more deferral: a run that has
  // lasted UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice, at
  // any restart delay.
  let heldMs: number | undefined
  if (timeoutState === 'working') {
    heldMs = _now() - (workingRowDeferredSince.get(key) ?? waitStartedAt)
    noteWorkingRowDeferral(key, config.session_restart_delay === 0)
  }
  // b.f2b: say what actually happens next for the restart delay in effect.
  // With auto-restart on, the health check schedules the reconnect, whose
  // adapter types `/mcp reconnect` into a `working` row only on the
  // positive-idle rule across attempts, and never into a prompt
  // (b.9a7/b.rmy); with `session_restart_delay` 0 nothing reconnects it, so
  // the not-connected notice is raised (once per episode: not again after a
  // prompt or unproven-idle report).
  return reportWaitEndedDisconnected(
    key,
    config,
    waitTimedOutLiveReport(ref, _waitForWaitingTimeoutMs, _unprovenIdleNoticeAfterMs, timeoutState, heldMs),
  )
}

// ---------------------------------------------------------------------------
// spawnForPersona — SR-1.4 collision-then-act dispatcher
// ---------------------------------------------------------------------------

export interface SpawnPersonaResult {
  /** Persona key. */
  key: string
  action:
    | 'spawned'
    | 'resumed'
    /** `/mcp reconnect` was typed into the persona's live session. */
    | 'reconnected'
    /**
     * b.f2b: the persona's row read `working`, and the wait for it to settle
     * ended with its session alive but nothing typed
     * (`waitForWaitingAndReconnect`'s `not-reconnected`; the wait logged what
     * happens next), or its teardown cancelled the wait (`cancelled`). Not a
     * failure: the session runs, so it is counted with the
     * succeeded personas and `launchSession` maps it to true, as it did when
     * this outcome was reported as `reconnected` (SR-25.1 counting unchanged).
     */
    | 'not-reconnected'
    | 'no-op'
    | 'failed'
    | 'fresh-after-amnesia'
    | 'fresh-after-inconclusive-amnesia'
    /**
     * Not launched: the persona's claude_config_dir cannot be resolved to a
     * real path (bug b.g57). No agent-director call was made and its row is
     * untouched; the bring-up controller holds the persona `retrying` until
     * the directory resolves. Not a failure: `launchSession` maps it to
     * `'skipped'`, so it counts toward no restart failure or cap.
     */
    | 'deferred'
    /**
     * b.jg5 SRJ-501, SRJ-502: the persona is latched. Either a spawn or
     * `resume` the collision ladder made answered CONFLICT, so the persona
     * latched (`conflictAt`); or a call or read of the ladder answered
     * UNUSABLE NAME (`unusableNameAt`, b.jg5 SRJ-512); or a read of its own
     * row latched it; or it was already latched when the launch was asked
     * for, so no agent-director call was made at all. Not a failure:
     * never counted, no spawn-failure notice, no `spawn-failed` entry, and
     * nothing is killed, deleted or launched after it. `launchSession` maps
     * it to `'skipped'` (SRJ-1015), and the start pass counts it neither as
     * failed nor as succeeded.
     */
    | 'latched'
    /**
     * b.jg5 SRJ-706: a live-row sequence runs for the persona
     * (`isLiveRowSequenceRunning`), so no other launch for it starts: no
     * agent-director call, no trust patch, no reply-guard step, no record
     * written, and nothing armed. Not a failure: `launchSession` maps it to
     * the uncounted `'refused'` (SRJ-1015), so a retry that meets it re-arms
     * the persona's retry timer (SRJ-302), and the start pass counts it
     * neither as failed nor as succeeded.
     */
    | 'sequence-waiting'
  /** For `deferred`: the claude_config_dir cause (`claude-config-dir` step). */
  deferredBy?: PersonaBringUpFailure
  /**
   * The refusal marker, set on a `failed` result only: the launch attempt's
   * last agent-director error armed the persona's UNAVAILABLE retry timer
   * (b.jg5 SRJ-301), which now owns the persona; or the ladder's reconnect,
   * or its launch wait, was `transient` for a persona that is not latched
   * (b.jg5 SRJ-118, `transientReconnectResult`). `launchSession` answers
   * `'refused'` for it, which the restart path never counts (SRJ-302).
   */
  refused?: true
  /**
   * Set on a `failed` result only: a resume, or a pane read of the launch
   * wait's evidence read (b.jg5 SRJ-205), answered `ErrInvalidFlags` and the
   * immediate version re-check decided the stop, so the server is stopping.
   * No spawn-failure notice was posted and no `spawn-failed` entry recorded;
   * `launchSession` answers `'skipped'`, which counts toward no failure or
   * cap.
   */
  stopping?: true
  /**
   * Set on a counted `failed` result only: the launch (a plain spawn, a
   * reuse or a `resume`) answered `ErrTmuxSessionCreate` and armed the
   * persona's retry timer at once in pending-only mode
   * (`launchFailureResult`, `armPendingOnlyAfterLaunchFailure`; b.jg5
   * SRJ-111, SRJ-112, SRJ-113, SRJ-409), so the retry's read of the row
   * decides. The failure is still counted. The live-row sequence arms no
   * other cause of its own after such a final launch.
   */
  pendingOnlyArmed?: true
  /**
   * Set on a `failed` result only, where its error is handled by class: the
   * class is LAUNCH FAILURE (`ErrTmuxSessionCreate`) or DIRECTORY
   * (`ErrCwdNotFound`, `ErrCwdNotADirectory`), the classes SRJ-112 and
   * SRJ-113 count (b.jg5). Every launch's LAUNCH FAILURE sets it
   * (`launchFailureResult`: the plain spawn's, the reuse spawn's and the
   * `resume`'s failure handling); the reuse spawn sets it for DIRECTORY too,
   * and so does the live-row sequence's `resume` leg. The live-row
   * sequence's launch entry counts a failure only when it is set
   * (`sequenceLaunchCounted`); the restart path counts any `failed` result
   * that is neither refused nor stopping.
   */
  countedClass?: true
}

// ---------------------------------------------------------------------------
// Pre-launch claude_config_dir check (bug b.g57)
// ---------------------------------------------------------------------------

/**
 * Realpath and lstat overrides for resolving a persona's claude_config_dir on
 * the launch path: the pre-launch check, the spawn label and the ladder's
 * `config_dir` comparison. `undefined` means the real file system.
 */
let _configDirFs: Partial<StrictRealPathFs> | undefined

/** Test-only seam: resolve every persona's claude_config_dir on the launch path through `fs`. */
export function _setConfigDirFs(fs: Partial<StrictRealPathFs>): void {
  _configDirFs = fs
}

/** Test-only seam: restore the real file system for the claude_config_dir resolution. */
export function _resetConfigDirFs(): void {
  _configDirFs = undefined
}

/**
 * The launch path's check of a persona's claude_config_dir (bug b.g57):
 * `checkPersonaConfigDir` against the spawn home and the file-system seam, so
 * the check, the spawn label and the ladder's comparison resolve the
 * directory the same way. Production also injects it into the bring-up
 * controller as its re-check. Never throws.
 */
export function checkLaunchConfigDir(persona: Persona): ConfigDirCheckResult {
  return checkPersonaConfigDir(persona, { home: spawnHomeDir(), fs: _configDirFs })
}

/**
 * Told when a launch finds a persona's claude_config_dir unresolvable; returns
 * whether it holds the persona (production: the bring-up controller's
 * `holdForConfigDir`, which logs the failure line once per episode and
 * re-checks on the persona's own timer).
 */
export type ConfigDirUnresolvableHook = (persona: Persona, failure: PersonaCheckFailure) => boolean

/**
 * The one hook, installed like the pre-launch reply guard. With none installed
 * (unit tests, the integration driver), or when it does not hold the persona,
 * the failure line is logged here, on every attempt.
 */
let configDirUnresolvableHook: ConfigDirUnresolvableHook | undefined

/** Install (or, with undefined, remove) the unresolvable-claude_config_dir hook (production: `server.ts`). */
export function setConfigDirUnresolvableHook(hook: ConfigDirUnresolvableHook | undefined): void {
  configDirUnresolvableHook = hook
}

/** Hand an unresolvable claude_config_dir to the hook; log its line when nothing holds the persona. Never throws. */
function deferLaunchForConfigDir(persona: Persona, failure: PersonaCheckFailure): void {
  let held = false
  if (configDirUnresolvableHook) {
    try {
      held = configDirUnresolvableHook(persona, failure)
    } catch (err) {
      console.error(
        `[slack] spawnForPersona: holding ${personaRef(persona)} for its claude_config_dir failed: ${describeThrownValue(err)}`,
      )
    }
  }
  if (!held) console.error(failure.line)
}

/** The `deferred` result for a persona whose claude_config_dir cannot be resolved. */
function deferredResult(persona: Persona, failure: PersonaCheckFailure): SpawnPersonaResult {
  return { key: persona.key, action: 'deferred', deferredBy: { step: 'claude-config-dir', class: failure.class, cause: failure.cause } }
}

/**
 * Before a path that would touch the persona's instance ahead of its launch
 * (the restart module's kill adapter): check its claude_config_dir and, when
 * it cannot be resolved, hand it to the hook as a launch would and return
 * true, so the caller leaves the instance and its row alone. False when the
 * directory resolves. Makes no agent-director call.
 */
export function holdLaunchIfConfigDirUnresolvable(persona: Persona): boolean {
  return deferIfConfigDirUnresolvable(persona) !== undefined
}

/**
 * Check the persona's claude_config_dir; when it cannot be resolved, hand it
 * to the hook as a launch would and return the `deferred` result with its
 * cause (`deferredBy`), as the pre-launch check does. Undefined when the
 * directory resolves.
 */
function deferIfConfigDirUnresolvable(persona: Persona): SpawnPersonaResult | undefined {
  const check = checkLaunchConfigDir(persona)
  if (check.ok) return undefined
  deferLaunchForConfigDir(persona, check)
  return deferredResult(persona, check)
}

/**
 * Home directory the spawn path resolves an unset claude_config_dir against
 * (`<home>/.claude`) when computing the `config_dir` label. `undefined` means
 * the OS home, read at spawn time.
 */
let _spawnHomeDir: string | undefined

/** Test-only seam: resolve the spawn `config_dir` label against `home`. */
export function _setSpawnHomeDir(home: string): void {
  _spawnHomeDir = home
}

/** Test-only seam: restore the OS home for the spawn `config_dir` label. */
export function _resetSpawnHomeDir(): void {
  _spawnHomeDir = undefined
}

/**
 * Home directory for `config_dir` label values: the test seam's home when set,
 * else the OS home, read at call time. Used by the spawn labels and by every
 * row comparison, so both derive the label from the same home.
 */
function spawnHomeDir(): string {
  return _spawnHomeDir ?? homedir()
}

/**
 * Build SpawnParams for a persona (SR-1.1, b.av2 SR-2.2): instance ID, tmux
 * session name, labels and env from E1's persona-identity functions, `cwd`
 * set to the persona's working directory.
 *
 * `CLAUDE_CONFIG_DIR` carries the persona's effective claude_config_dir exactly
 * as configured and is absent when none is; the `config_dir` label is
 * `configDirLabel`, the hash of its real path from the launch's pre-launch
 * check (`checkLaunchConfigDir`), never of its lexical path (bug b.g57).
 *
 * extra_env unconditionally carries CSCB_CRONTABLE_PATH (the resolved,
 * tilde-expanded, absolute cron_table_path from the config) so bots can
 * locate the self-documenting crontable from the env var alone — no config
 * file lookup needed (D-Q2, b.grx decision 3).
 *
 * extra_env also always carries `PROMPT_SUGGESTION_OFF_ENV`
 * (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, b.svb/b.f2b; see
 * persona-identity.ts for why). Every plain spawn in the ladder (the first
 * spawn, the retry spawn after the collision `get` found no row, and the
 * spawn after `resume` found none) sends
 * these params unchanged, the reuse spawn (`reuseSpawnForPersona`), which
 * is every replacement of a row the ladder cannot keep (the replace step,
 * `replacePersonaRow`, and the live-row sequence's final launch) and the
 * launch after resume's no-transcript answer (b.jg5 SRJ-707, SRJ-712), sends
 * them with only `reuse_finished: true` added (b.jg5 SRJ-708: one
 * derivation, so a reuse carries the same template, `cwd`, labels and
 * `extra_env` as any launch of the persona), and a resume restores the env
 * agent-director stored with the row at its spawn, so every launch of the
 * persona's Claude runs with it.
 *
 * The params never carry the reuse flag (b.jg5 SRJ-711, SRJ-111): only the
 * reuse launch adds it, so a first spawn of a key that is not retired is
 * plain, and when the key's row is already there it collides and the ladder
 * goes on to the collision `get` and `resume`, which keep the conversation.
 * The only first launch that is a reuse is a retired key's (SRJ-805).
 *
 * CSCB never passes `no_pre_trust`: not here, not on a reuse and not on a
 * `resume`, so agent-director pre-accepts the persona's folder trust at
 * every launch and reports the outcome as the result's `pre_trust`, which
 * CSCB only logs (`preTrustLogLine`, b.jg5 SRJ-413).
 */
function buildSpawnParams(persona: Persona, config: PersonaConfig, configDirLabel: string): SpawnParams {
  const { key } = persona
  return {
    template: TEMPLATE_NAME,
    cwd: persona.working_directory,
    claude_instance_id: personaInstanceId(key),
    relay_mode: 'on',
    tmux_session_name: personaTmuxSessionName(key),
    label: [
      SERVICE_LABEL,
      `${PERSONA_LABEL_PREFIX}${key}`,
      `${CONFIG_DIR_LABEL_PREFIX}${configDirLabel}`,
    ],
    extra_env: personaSpawnEnv({
      key,
      crontablePath: config.cron_table_path,
      claudeConfigDir: persona.claude_config_dir,
    }),
  }
}

/**
 * A kill made inside a launch or recovery attempt for the persona (the
 * live-row sequence's kills, the restart path's kill).
 */
const KILL_CONTEXT_ATTEMPT = 'attempt'
/** A persona teardown's kill: no launch or recovery attempt; it arms nothing (b.jg5 SRJ-110; hatch A3). */
export const KILL_CONTEXT_TEARDOWN = 'teardown'

/** The context of a `killPersonaInstance` call. */
export type KillContext = typeof KILL_CONTEXT_ATTEMPT | typeof KILL_CONTEXT_TEARDOWN

/** Options of `killPersonaInstance`. `context` is required, so no caller takes either form by omission. */
export interface KillPersonaInstanceOptions {
  /**
   * `KILL_CONTEXT_ATTEMPT`: the kill is made inside a launch or recovery
   * attempt for the persona. The wrapper reports its error as for any call in
   * the attempt (b.jg5 SRJ-301: an UNAVAILABLE, ENVIRONMENT, CONFIG or
   * UNCLASSIFIED answer arms the persona's retry timer), and a class the kill
   * has no row for (`unlistedClass`: a STATE name other than
   * `ErrSpawnNotFound`, `ErrInvalidFlags` after its re-check included, LAUNCH
   * FAILURE, DIRECTORY) takes SRJ-105's UNCLASSIFIED row through the outage
   * state's site entry (`reportUnclassifiedAtSite`): it arms the retry timer
   * with the UNCLASSIFIED cause and feeds the persona's unclassified-error
   * episode (b.jg5 SRJ-313), and is never counted.
   *
   * `KILL_CONTEXT_TEARDOWN`: the persona teardown's kill, which is no launch
   * or recovery attempt (b.jg5 SRJ-110; hatch A3): it arms no retry timer,
   * starts no `tmux-unresponsive` condition, reports nothing to the
   * unclassified-error episode, and raises the `tmux-unavailable` or
   * `ad-config-malformed` outage for an ENVIRONMENT or CONFIG answer only
   * when the persona is in the applied configuration (the installed
   * configured-persona query).
   */
  readonly context: KillContext
  /**
   * True when the caller kills a row it read in a live state (b.jg5
   * glossary: only such a kill is tmux-touching): the live-row sequence's
   * kills. Absent or false otherwise (the persona teardown did not read the
   * row; the restart path kills only after a `dead` reading).
   */
  readonly rowReadLive?: boolean
  /**
   * `KILL_CONTEXT_ATTEMPT` only: true for one try of a bounded kill retry
   * (`retryPersonaKill`; b.jg5 SRJ-702): the wrapper does not report an
   * UNAVAILABLE answer (`OutageDetectionOptions.deferUnavailableReport`), so
   * no try but the one whose outcome stands arms the retry timer or starts
   * the `tmux-unresponsive` condition. Ignored for `KILL_CONTEXT_TEARDOWN`.
   */
  readonly deferUnavailableReport?: boolean
}

/**
 * Kill persona `key`'s instance (`cscb_<key>`): one checked kill
 * (`checkedKill`, `src/checked-kill.ts`; b.jg5 SRJ-110, SRJ-701) through
 * `withOutageDetection`, which raises or clears the key's outage flags as
 * `options.context` says (`KillPersonaInstanceOptions`). Answers the kill's
 * outcome, `kill_sent` included: a success (any `kill_sent`,
 * `ErrSpawnNotFound`, or GONE) or a non-success with its class and the
 * thrown value. An `ErrInvalidFlags` gets exactly one immediate version
 * re-check first, in either context (`recheckKillOnInvalidFlags`; b.jg5
 * SRJ-104, SRJ-204), its answer kind kept in the outcome; when it decides
 * that the server stops (`killOutcomeStopsServer`), nothing is reported and
 * the caller does nothing more (b.jg5 SRJ-205). In `KILL_CONTEXT_ATTEMPT`
 * an outcome of a class the kill has no row for is then reported as
 * UNCLASSIFIED (`reportUnlistedKillOutcome`). With
 * `options.deferUnavailableReport` (one try of `retryPersonaKill`) an
 * UNAVAILABLE answer is not reported here. Never throws or rejects, and
 * never retries. Logs nothing, records no startup error, raises no notice of
 * its own and latches nothing: each caller acts on the outcome by its own
 * context. Its callers: the persona teardown (b.av2 SR-6.5, `main()`'s
 * binding, `KILL_CONTEXT_TEARDOWN`, one checked kill) and the bounded retry
 * of the live-row sequence's kills and the restart path's kill
 * (`retryPersonaKill`, `KILL_CONTEXT_ATTEMPT`, one call per try). The
 * collision ladder makes no kill.
 */
export async function killPersonaInstance(key: string, options: KillPersonaInstanceOptions): Promise<KillOutcome> {
  const call = adKillCall(options.rowReadLive === true)
  const inAttempt = options.context === KILL_CONTEXT_ATTEMPT
  const wrapperOptions = inAttempt
    ? options.deferUnavailableReport === true
      ? { deferUnavailableReport: true }
      : undefined
    : { armsNothing: { personaConfigured: () => configuredReadingOf(key).configured } }
  const killed = await checkedKill(personaInstanceId(key), (params) =>
    withOutageDetection(key, undefined, call, (client) => client.kill(params), wrapperOptions),
  )
  const outcome = await recheckKillOnInvalidFlags(killed)
  if (inAttempt) reportUnlistedKillOutcome(key, outcome, call)
  return outcome
}

/**
 * The `ErrInvalidFlags` step at a kill (b.jg5 SRJ-104, SRJ-204): every kill
 * site gives `ErrInvalidFlags` no meaning, so a non-success whose thrown
 * value is an `ErrInvalidFlags` (by name) gets exactly one immediate version
 * re-check (`classifyWithInvalidFlagsRecheck`; a stop it decides ends the
 * process as the re-check defines) and is answered with the re-check's
 * answer kind as its `recheck`; it stays UNCLASSIFIED. Every other outcome is
 * answered as it is, with no re-check. Never throws or rejects.
 */
async function recheckKillOnInvalidFlags(outcome: KillOutcome): Promise<KillOutcome> {
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE) return outcome
  if (!isInvalidFlagsError(outcome.error)) return outcome
  const step = await classifyWithInvalidFlagsRecheck(outcome.error)
  return { ...outcome, recheck: step.recheck.kind }
}

/**
 * Inside a launch or recovery attempt for persona `key`: an outcome of a
 * class the kill has no row for (`unlistedClass`: a STATE name other than
 * `ErrSpawnNotFound`, LAUNCH FAILURE, DIRECTORY; b.jg5 SRJ-104, SRJ-110),
 * which the wrapper did not take as UNCLASSIFIED, is reported as an
 * UNCLASSIFIED outcome through the outage state's site entry
 * (`reportUnclassifiedAtSite`, with its UNCLASSIFIED classification,
 * `unclassifiedClassificationOf`): the persona's retry timer is armed with
 * the UNCLASSIFIED cause (the attempt records it, so a launch it ends is
 * refused and never counted) and its unclassified-error episode is fed
 * (b.jg5 SRJ-105, SRJ-313). An `ErrInvalidFlags` whose re-check decided that
 * the server stops is not reported (b.jg5 SRJ-205). Every other outcome,
 * a by-name UNCLASSIFIED one included (the wrapper reported it), reports
 * nothing. Never throws.
 */
function reportUnlistedKillOutcome(key: string, outcome: KillOutcome, call: AdKillCall): void {
  try {
    if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE) return
    if (outcome.unlistedClass === undefined || killOutcomeStopsServer(outcome)) return
    reportUnclassifiedAtSite(key, outcome.error, call, unclassifiedClassificationOf(outcome.error))
  } catch {
    /* a failing report changes nothing about the kill's own outcome */
  }
}

// ---------------------------------------------------------------------------
// The bounded retry of a persona's kill (b.jg5 SRJ-702)
// ---------------------------------------------------------------------------

/**
 * What the server tells a persona's kill retry (b.jg5 SRJ-702, SRJ-305):
 * whether the persona is up (serving, its bring-up `up`, its key applied;
 * false once it is torn down or not up) and whether the server is shutting
 * down. Production installs one in `main()`. The latch is asked separately
 * (`personaLatchedNow`).
 */
export interface PersonaKillKeepGoingQuery {
  isPersonaUp(key: string): boolean
  isShuttingDown(): boolean
}

let personaKillKeepGoingQuery: PersonaKillKeepGoingQuery | undefined

/** Install (or, with `undefined`, remove) the persona kill retry's keep-going query. */
export function setPersonaKillKeepGoingQuery(query: PersonaKillKeepGoingQuery | undefined): void {
  personaKillKeepGoingQuery = query
}

/**
 * The keep-going check of persona `key`'s kill retry: false once the
 * persona is latched (`personaLatchedNow`, b.jg5 SRJ-502), or, with a query
 * installed, once the server is shutting down or the persona is not up (a
 * query that throws counts as false). With no query installed, only the
 * latch is asked. Never throws.
 */
function personaKillKeepsGoing(key: string): boolean {
  if (personaLatchedNow(key)) return false
  const query = personaKillKeepGoingQuery
  if (query === undefined) return true
  try {
    return query.isShuttingDown() !== true && query.isPersonaUp(key) === true
  } catch {
    return false
  }
}

/** What `retryPersonaKill` is given. */
export interface PersonaKillRetryOptions {
  /** True when the path read the row in a live state: each try is a tmux-touching kill (`AdKillCall`). */
  readonly rowReadLive: boolean
  /** The row state the path last read (`src/kill-retry.ts`'s seed): only a live one gets the tries. */
  readonly lastRead: KillRetrySeed
  /** The head of the tries' and reads' lines (`[slack] <site>: …`). */
  readonly site: string
  /** The persona's reference, for the read's lines. */
  readonly ref: string
  /** The wait between tries. */
  readonly clock: KillRetryWait
  /**
   * The caller's own keep-going check, asked beside the server's
   * (`personaKillKeepsGoing`): the tries go on only while both answer true
   * (the live-row sequence's: it is not stopped and the persona is not
   * latched). A throw counts as false. Absent: the server's alone.
   */
  readonly keepGoing?: () => boolean
}

/** What the between-try read of a persona's own row is called in that read's lines. */
const KILL_RETRY_READ_WHAT = 'status read between kill tries'

/**
 * The bounded retry of persona `key`'s kill inside a launch or recovery
 * attempt (b.jg5 SRJ-702, SRJ-110; `runKillRetry`, `src/kill-retry.ts`):
 *   - each try is one checked kill (`killPersonaInstance`,
 *     `KILL_CONTEXT_ATTEMPT`, with `deferUnavailableReport`), so a try's
 *     UNAVAILABLE answer arms nothing and starts nothing; every other answer
 *     is reported at once, as it stands at once;
 *   - the read between tries is the shared own-row `status` read
 *     (`readPersonaOwnRowStatus`): through `withOutageDetection`, so a CONFIG
 *     answer raises `ad-config-malformed` (b.jg5 SRJ-316) and, inside the
 *     attempt, a failed read reports as any read does; a read of the
 *     persona's own row `pending` with no launch start, or an UNUSABLE NAME
 *     answer, latches the persona (b.jg5 SRJ-512, SRJ-513), which ends the
 *     tries with no further kill;
 *   - the keep-going check (`personaKillKeepsGoing`, and the caller's own
 *     `options.keepGoing` when given) ends the tries with no further kill
 *     once the persona is latched, torn down or not up, or the server is
 *     shutting down (or the caller's check answers false);
 *   - only a seed read live gets the tries; any other kill is one try.
 * Then, when the tries ended in a failure that no stop ended and the caller's
 * own keep-going check, when given, still answers true (`callerKeepsGoing`),
 * its outcome is reported once (`reportDeferredUnavailable`, with the kill's
 * declared call):
 * an UNAVAILABLE outcome arms the persona's retry timer once (the
 * kill-failed cause for `ErrTmuxKillFailed`) and, for a kill of a row read
 * live, an UNAVAILABLE other than `ErrTmuxKillFailed` starts or continues
 * its `tmux-unresponsive` condition. A success reports nothing more, and a
 * stop reports nothing, so no retry timer is armed for a latched persona or
 * for a caller stopped while its last try ran.
 * Answers the retry's result, its alert decision included, for the caller's
 * own handling of the outcome that stands. Never throws or rejects.
 */
export async function retryPersonaKill(key: string, options: PersonaKillRetryOptions): Promise<KillRetryResult> {
  const call = adKillCall(options.rowReadLive)
  const result = await runKillRetry({
    instanceId: personaInstanceId(key),
    kill: () =>
      killPersonaInstance(key, { context: KILL_CONTEXT_ATTEMPT, rowReadLive: options.rowReadLive, deferUnavailableReport: true }),
    read: () => readPersonaKillRow(key, options.site, options.ref),
    wait: options.clock,
    lastRead: options.lastRead,
    keepGoing: () => personaKillKeepsGoing(key) && (options.keepGoing === undefined || options.keepGoing() === true),
    log: (line) => console.error(line),
    logPrefix: `[slack] ${options.site}`,
  })
  if (result.outcome.kind === KILL_OUTCOME_NOT_KILLED && !killRetryStopped(result) && callerKeepsGoing(options)) {
    reportDeferredUnavailable(key, result.outcome.error, call)
  }
  return result
}

/**
 * The caller's own keep-going check of a persona's kill retry, asked once
 * more after the tries: true with no check given, false when it answers
 * anything but true or throws. A caller whose check answers false then (the
 * live-row sequence, stopped or latched while the last try ran) gets no
 * deferred report: the retry timer is not armed and no `tmux-unresponsive`
 * condition starts. Never throws.
 */
function callerKeepsGoing(options: PersonaKillRetryOptions): boolean {
  if (options.keepGoing === undefined) return true
  try {
    return options.keepGoing() === true
  } catch {
    return false
  }
}

/**
 * Raise the kill-failure alert that persona `key`'s kill retry decided
 * (`retried.alert`; b.jg5 SRJ-704, SRJ-702, SRJ-1007), at the restart path
 * (`_buildKillSessionAdapter`, `src/server.ts`) and the live-row sequence's
 * kills, after the standing outcome's own handling (a CONFLICT has
 * latched the persona with its own post; an UNAVAILABLE outcome has armed
 * its retry timer, `ErrTmuxKillFailed` with the kill-failed cause and never
 * the `tmux-unresponsive` condition) and, for the survivor version, before
 * the caller's next step. The context is `recovery` at the restart path
 * (SRJ-1007); the live-row sequence's kills pass their request's context
 * (`recovery` for a sequence the collision ladder starts) and the server's
 * alerts (`buildLiveRowSequenceDeps`). Through the given kill-failure alerts, the
 * installed ones (`setKillFailureAlerts`) by default, which route it by
 * whether the persona is in the applied configuration now:
 *   - `survivor`: its destination, once for this retry, with no episode; or
 *     one `persona-kill-survivor` entry when not configured;
 *   - `ordinary`: its destination, once per kill-failure episode, closing
 *     with the latched sentence when the persona is latched now (the last
 *     outcome latched it, a read between tries did, or it latched while the
 *     tries ran), and otherwise with "CSCB keeps retrying"; or one
 *     `persona-kill-failed` entry when not configured.
 * The keep-going stop (b.jg5 SRJ-702, SRJ-301): an `ordinary` decision whose
 * tries the keep-going check stopped while the persona is not latched (it
 * is torn down or not up, or the server is shutting down), or whose last
 * outcome's version re-check decided that the server stops, is raised with
 * `stopped`: no retry follows, so for a configured persona the alerts post
 * nothing (their text would say CSCB keeps retrying) and open no episode,
 * and write one line with the decision and the redacted descriptions, and,
 * when the decision carries an earlier survivor-naming description (whose
 * failure is the only report of the surviving process), one
 * `persona-kill-failed` entry with the log-only closing sentence and the
 * `recovery` context through the log-only route; for a
 * persona no longer in the applied configuration (one removed while the
 * tries ran) the not-configured route's entry is written as usual. With no
 * alerts installed, one line carries the decision instead. A `none`
 * decision does nothing. Never throws.
 *
 *   [slack] <site>: kill for <ref>: the kill-failure alert's <version> version is not raised — no kill-failure alerts are installed; <descriptions> (b.jg5 SRJ-704)
 *
 * where `<descriptions>` is `last="<redacted>"` and `earlier survivor-naming="<redacted>"`, each when present, or `survivor-naming="<redacted>"`.
 */
export function raisePersonaKillFailureAlert(
  key: string,
  retried: KillRetryResult,
  site: string,
  ref: string,
  context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
): void {
  try {
    const decision = retried.alert
    if (decision.kind === KILL_RETRY_ALERT_NONE) return
    const latched = retried.end === KILL_RETRY_END_READ_LATCHED || personaLatchedNow(key)
    const stopped = killOutcomeStopsServer(retried.outcome) || (retried.end === KILL_RETRY_END_STOPPED && !latched)
    if (alerts === undefined) {
      console.error(
        `[slack] ${site}: kill for ${ref}: the kill-failure alert's ${decision.kind} version is not raised — no kill-failure alerts are installed; ${describeKillFailureDescriptions(decision)} (b.jg5 SRJ-704)`,
      )
      return
    }
    alerts.raise({ key, decision, latched, stopped, context })
  } catch (err) {
    console.error(`[slack] ${site}: kill for ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

/** One between-try `status` read of persona `key`'s own row, as the kill retry takes it. Never throws. */
async function readPersonaKillRow(key: string, site: string, ref: string): Promise<KillRetryRead> {
  const read = await readPersonaOwnRowStatus(key, { site, what: KILL_RETRY_READ_WHAT, ref })
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return { kind: KILL_RETRY_READ_STATE, state: read.state }
    case OWN_ROW_STATUS_ABSENT:
      return { kind: KILL_RETRY_READ_NO_ROW }
    case OWN_ROW_STATUS_LATCHED:
      return { kind: KILL_RETRY_READ_LATCHED }
    case OWN_ROW_STATUS_REFUSED:
      return { kind: KILL_RETRY_READ_FAILED, error: read.error }
  }
}

/**
 * Delete persona `key`'s row (`cscb_<key>`) through `withOutageDetection`;
 * rethrows every error. The persona teardown's delete only
 * (`deletePersonaInstance`; b.jg5 SRJ-715, SRJ-716): no launch path deletes
 * a row, and none deletes before a spawn (SRJ-707).
 */
function deleteInstanceRow(key: string): Promise<unknown> {
  return withOutageDetection(key, undefined, 'delete', (client) => client.delete({ claude_instance_id: [personaInstanceId(key)] }))
}

/**
 * Delete persona `key`'s agent-director row (`cscb_<key>`) through
 * `withOutageDetection`, quietly, as `killPersonaInstance` kills it: true when
 * the row was there, false when it was already gone (`ErrSpawnNotFound`);
 * every other error is rethrown. A failure records no startup error and
 * raises no spawn-failure notice. For the persona teardown only (b.av2
 * SR-6.5, b.jg5 SRJ-715).
 */
export async function deletePersonaInstance(key: string): Promise<boolean> {
  try {
    await deleteInstanceRow(key)
    return true
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) return false
    throw err
  }
}

/**
 * The row state the restart path's kill records in a latch (b.jg5 SRJ-501):
 * the state its run last read, carried by `lastRead`, the run's `dead`
 * reading (`deadRowReadOf`): `ended` or `missing` as read, or no row for
 * `ErrSpawnNotFound`. `NOTHING_READ` when the reading carries no row state
 * (`ErrSystemInstallDisappeared`, which reads no row, or a reading made with
 * no `status` call): the latch then makes the one latch-time `status` read.
 */
function restartKillLastRead(lastRead: LivenessReading): LastRowRead {
  const rowRead = deadRowReadOf(lastRead)
  if (rowRead === undefined) return NOTHING_READ
  return rowRead === LIVENESS_DEAD_ROW_NO_ROW ? LATCH_ROW_STATE_NO_ROW : latchRowStateRead(rowRead)
}

/**
 * The restart path's latch for its kill's outcome (b.jg5 SRJ-110, SRJ-501,
 * SRJ-512; `_buildKillSessionAdapter`, `src/server.ts`): a CONFLICT latches
 * persona `key` through the latch's CONFLICT entry with the refused
 * operation "P's next check or recovery", and an UNUSABLE NAME through the
 * unusable-name entry, each with the row state the restart run last read
 * (`lastRead`, its `dead` reading: `ended`, `missing` or no row;
 * `restartKillLastRead`), with no further `status` read; only when that
 * reading carries no row state (`ErrSystemInstallDisappeared`) is one
 * latch-time `status` read made, its lines prefixed `site` too. A read that
 * itself latches the persona leaves that latch standing. One line prefixed
 * `site`. With no latch installed nothing is read or set, and the line says
 * so. Answers true for those two classes (the restart work answers
 * `latched`), false for every other outcome, for which it does nothing. The
 * kill is never repeated. Never throws.
 */
export async function latchOnRestartKillOutcome(
  key: string,
  outcome: KillOutcome,
  site: string,
  lastRead: LivenessReading,
): Promise<boolean> {
  return latchOnKillOutcomeAt(key, outcome, site, keyRef(key), restartKillLastRead(lastRead))
}

/**
 * The latch for a kill's standing outcome inside a launch or recovery
 * attempt (b.jg5 SRJ-110, SRJ-501, SRJ-512): a CONFLICT latches persona
 * `key` through the latch's CONFLICT entry (`conflictAt`) with the refused
 * operation "P's next check or recovery", and an UNUSABLE NAME through the
 * unusable-name entry (`unusableNameAt`), each with `lastRead`, the row
 * state the path last read (one latch-time `status` read only when it read
 * nothing), its line prefixed `site`. Answers true for those two classes,
 * false for every other outcome, for which it does nothing. The kill is
 * never repeated. Never throws.
 */
async function latchOnKillOutcomeAt(
  key: string,
  outcome: KillOutcome,
  site: string,
  ref: string,
  lastRead: LastRowRead,
): Promise<boolean> {
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) return false
  if (outcome.errorClass === AD_ERROR_CLASS_CONFLICT) {
    await conflictAt(key, outcome.error, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, lastRead, 'kill', ref, site)
    return true
  }
  if (outcome.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    await unusableNameAt(key, outcome.error, lastRead, site, 'kill', ref)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// A launch's failure: the plain spawn's handling and LAUNCH FAILURE
// ---------------------------------------------------------------------------

/** The tail of the one line a launch's LAUNCH FAILURE writes (b.jg5 SRJ-602). */
const LAUNCH_FAILURE_LINE_TAIL = ' — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-602)'

/** Whether `err` is a LAUNCH FAILURE (`ErrTmuxSessionCreate`), decided by name (`classifyAdError`). Never throws. */
function isLaunchFailure(err: unknown): boolean {
  return classifyAdError(err).errorClass === AD_ERROR_CLASS_LAUNCH_FAILURE
}

/**
 * The result of a launch whose `ErrTmuxSessionCreate` (LAUNCH FAILURE) is
 * one counted launch failure (b.jg5 SRJ-602, SRJ-111, SRJ-112, SRJ-113,
 * SRJ-713), once its caller has written the line, the notice and the
 * `spawn-failed` entry. Nothing is killed because of it and no launch
 * follows it. The persona's retry timer is armed at once, with no `get`
 * first, in pending-only mode (`armPendingOnlyAfterLaunchFailure`; SRJ-301,
 * SRJ-409; HO rev 28), so that the retry's read of the row decides: a plain
 * spawn's row reads `pending`, or `ended` after a "duplicate session" whose
 * holder had vanished; a `resume`'s or a reuse's reads as agent-director's
 * restore left it. Answers `failed` marked `countedClass`, and
 * `pendingOnlyArmed` when the timer was armed (inside a launch attempt with a
 * sink installed). Never throws.
 */
function launchFailureResult(key: string): SpawnPersonaResult {
  return armPendingOnlyAfterLaunchFailure(key)
    ? { key, action: 'failed', countedClass: true, pendingOnlyArmed: true }
    : { key, action: 'failed', countedClass: true }
}

/**
 * A plain spawn's failure by class (b.jg5 SRJ-111, SRJ-713), at every plain
 * spawn the ladder makes (the first spawn, the retry spawn after the
 * collision `get` found no row, and the spawn after `resume` found none;
 * every replacement and resume's no-transcript answer go to the reuse spawn
 * of the same id instead, b.jg5 SRJ-707, SRJ-712), with no further launch: the DIRECTORY
 * errors (`ErrCwdNotFound`, `ErrCwdNotADirectory`, by name) answer `failed`
 * quietly (the spawn's wrapper raised `cwd-unreachable`);
 * then the refusal handling (`launchRefusalAt`: a CONFLICT latches with the
 * refused operation "plain spawn" and `lastRead`, an UNUSABLE NAME latches,
 * a refusal answers `failed`); any other error writes one line (`what`
 * names the spawn), a `spawn-failed` entry at start and the spawn-failure
 * notice, and answers `failed`. An `ErrTmuxSessionCreate` among those is one
 * counted launch failure (`launchFailureResult`): nothing is killed and no
 * spawn is made in its place (SRJ-602). Never throws.
 */
async function plainSpawnFailedAt(
  key: string,
  err: unknown,
  isStartup: boolean,
  ref: string,
  what: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult> {
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the spawn's wrapper.
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed' }
  const refused = await launchRefusalAt(key, err, 'spawn', what, ref, lastRead)
  if (refused) return refused
  const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
  const described = describeAgentDirectorFailure(e)
  const launchFailure = isLaunchFailure(err)
  console.error(`[slack] spawnForPersona: ${what} failed for ${ref}: ${described}${launchFailure ? LAUNCH_FAILURE_LINE_TAIL : ''}`)
  if (isStartup) recordStartupError('spawn-failed', `${what} failed for ${ref}: ${described}`)
  notifySpawnFailure(key, e, isStartup)
  return launchFailure ? launchFailureResult(key) : { key, action: 'failed' }
}

// ---------------------------------------------------------------------------
// ErrJsonlMissing diagnostic (bug b.wrb)
// ---------------------------------------------------------------------------

/** The startup-errors class of a lost transcript: a resume met `ErrJsonlMissing` after provable activity (b.wrb; b.jg5 SRJ-712). */
export const JSONL_TRANSCRIPT_LOST_ENTRY_CLASS = 'jsonl-transcript-lost-on-resume'

/** The startup-errors class of an inconclusive lost-transcript diagnosis (b.fwu; b.jg5 SRJ-712). */
export const JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS = 'jsonl-diagnosis-inconclusive'

/**
 * What every text of the lost-transcript diagnosis says about the persona
 * after `ErrJsonlMissing` (b.jg5 SRJ-712): its log lines and startup-errors
 * details ("the persona is …") and its persona notices ("I was …"). The
 * persona is brought up fresh by a reuse spawn of its own id, and its row is
 * kept; none of them says the row goes away.
 */
export const JSONL_DIAGNOSIS_REUSE_WORDING =
  'brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life)'

/** What the lost-transcript diagnosis concluded (b.wrb, b.fwu). */
type JsonlDiagnosisVerdict = 'lost' | 'never-created' | 'inconclusive'

/**
 * The lost-transcript diagnosis's answer when it read the row (or found
 * none): its verdict, and the persona notice it holds back until the reuse
 * spawn after it succeeds (`notice`; absent for `never-created`, which posts
 * none). Its log line and startup-errors entry were written already.
 */
interface JsonlDiagnosis {
  readonly verdict: JsonlDiagnosisVerdict
  readonly notice?: string
}

/** The source tokens agent-director stamps on each candidate it stat'd
 *  (AD's `jsonlAttempt.source`): the persisted jsonl_path column, the
 *  CLAUDE_CONFIG_DIR-aware recomputed fallback, and archived session_history
 *  entries. Kept as the literal token set AD emits — never a version check. */
type AdJsonlCandidateSource = 'persisted' | 'fallback' | 'history'

/** Single source of truth for the tokens the candidate parser anchors on. */
const AD_JSONL_CANDIDATE_SOURCES: readonly AdJsonlCandidateSource[] = [
  'persisted',
  'fallback',
  'history',
]

/** One transcript candidate resume tried (or that we recomputed locally). */
interface JsonlCandidate {
  /** Provenance as reported by AD (see AdJsonlCandidateSource), or a
   *  'locally-computed(…)' label when we reconstructed it ourselves because
   *  AD's message lacked detail. */
  source: string
  path: string
  /** The stat error AD reported, or our own local stat result label. */
  note: string
}

/**
 * Best-effort parse of an ErrJsonlMissing description into the candidate list
 * AD enumerates as `<source> <path> (<stat error>)`, joined by "; ".
 *
 * Returns [] when the description does not carry the enumerated detail — the
 * case for any AD whose ErrJsonlMissing message predates the per-candidate
 * enumeration delivered by AD bug b.1ba. Callers MUST treat [] as "AD gave no
 * path detail" and degrade to locally-computed candidates, never as "no paths".
 *
 * Strictly non-throwing and version-agnostic: it keys off the literal
 * `persisted` / `fallback` / `history` source tokens, not any version string.
 * An AD that emits only a subset of those tokens simply yields fewer matches.
 */
function parseJsonlMissingCandidates(description: string): JsonlCandidate[] {
  if (!description) return []
  const out: JsonlCandidate[] = []
  // AD renders each attempt as: `<source> <path> (<stat error>)`.
  // Anchor on the known source tokens so unrelated prose is ignored.
  const re = new RegExp(
    `(${AD_JSONL_CANDIDATE_SOURCES.join('|')})\\s+(\\S+)\\s+\\(([^)]*)\\)`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(description)) !== null) {
    out.push({ source: m[1], path: m[2], note: m[3] })
  }
  return out
}

/** Local stat label: what WE see at a path right now (never claims AD tried it). */
function localStatNote(path: string): string {
  try {
    const st = statSync(path)
    if (st.isFile() && st.size > 0) return `locally present, ${st.size} bytes`
    if (st.isFile()) return 'locally present but empty'
    return 'locally present but not a regular file'
  } catch (err) {
    const code = (err as { code?: string })?.code
    return code ? `locally absent (${code})` : 'locally absent'
  }
}

/**
 * b.wrb, b.jg5 SRJ-712: make an `ErrJsonlMissing` resume failure legible.
 * Reads the persona's row, logs which transcript path(s) were tried and their
 * provenance, and classifies the loss as never-created (expected, lossless),
 * lost (real context destroyed, operator-visible) or inconclusive. The
 * persona is then brought up fresh by a reuse spawn of its own id, which
 * keeps its row as an earlier life (`JSONL_DIAGNOSIS_REUSE_WORDING`).
 *
 * It runs before that reuse spawn, because the reuse resets the row it reads
 * (its `jsonl_path`, session id, `cwd` and `started_at`). Never throws.
 *
 * The log line and the startup-errors entry (`JSONL_TRANSCRIPT_LOST_ENTRY_CLASS`,
 * `JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS`, at start only) are written here.
 * The persona notice of a `lost` or `inconclusive` verdict is not posted
 * here: it is answered as `notice`, and the caller posts it only once the
 * reuse spawn has brought the persona up (`noTranscriptReuse`), since the
 * notice says the persona was brought up fresh.
 *
 * b.jg5 SRJ-105/SRJ-114: the row `get` is one of SRJ-114's sites, made
 * through the shared own-row read (`readPersonaOwnRow`). No diagnosis is
 * reported (no startup-errors entry, no persona notice, no amnesia count)
 * when it latched the persona (a `provenance_conflict` note on its own row,
 * or an UNUSABLE NAME answer, b.jg5 SRJ-512, which records the state
 * unreadable): the diagnosis answers `latched`, and the caller launches
 * nothing (b.jg5 SRJ-502). The same when the persona latched elsewhere while
 * the get was awaited (`latchedAfterOwnRowRead`, its one line). Nor when it
 * failed with a refusal (`refusalAt` with verb `get`: any error but
 * `ErrSpawnNotFound` and an UNUSABLE NAME answer, a CONFIG answer included,
 * b.jg5 SRJ-316): the diagnosis answers the refusal result, and the caller
 * launches nothing (SRJ-105); any other failure, none today, answers
 * `failed` the same way, with one line and no spawn-failure notice.
 * `ErrSpawnNotFound` (the row is absent) gives 'inconclusive', its reason
 * saying the row is absent.
 *
 * `read.lastRead` is set to what the `get` read (b.jg5 SRJ-501): the state
 * the reuse spawn after it records if it latches.
 *
 * @returns the diagnosis (`JsonlDiagnosis`): 'lost' when the row had
 *          provable prior activity but no transcript survives (loud),
 *          'never-created' when the archive was consulted and proved
 *          idle-since-spawn (quiet, evidence-based lossless), 'inconclusive'
 *          when not enough evidence could be gathered to decide either way
 *          (loud-but-uncertain: the diagnosis machinery itself is degraded,
 *          which correlates with the storage faults that cause loss); or the
 *          ladder's result (`failed` or `latched`) when the row `get` failed
 *          or latched the persona.
 */
async function diagnoseJsonlMissing(
  persona: Persona,
  config: PersonaConfig,
  err: AgentDirectorError,
  isStartup: boolean,
  read: { lastRead?: LatchRowState },
): Promise<JsonlDiagnosis | RefusedSiteResult | LatchedSiteResult> {
  const { key } = persona
  const ref = personaRef(persona)
  // --- 1. What paths did AD try, and from where? -------------------------
  // err.errDescription is AD's detail string. The rich format (AD b.1ba,
  // shipped in v0.10.0) enumerates `<source> <path> (<err>)`; pre-b.1ba ADs do
  // not. Parse defensively — [] means "no AD detail", not "no paths".
  const adCandidates = parseJsonlMissingCandidates(err.errDescription ?? '')

  // --- 2. Read the row before the reuse spawn resets it (best-effort). ----
  // b.jg5 SRJ-501: this get is the path's last read of the row before the
  // reuse spawn, so `read.lastRead` records what it gave.
  const claudeInstanceId = personaInstanceId(key)
  const what = 'ErrJsonlMissing diagnosis get'
  const ownRead = await readPersonaOwnRow(key, { site: 'spawnForPersona', what, ref })
  if (ownRead.kind === OWN_ROW_READ_LATCHED) {
    // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latched the persona.
    // No diagnosis is reported; the caller launches nothing.
    read.lastRead = LATCH_ROW_STATE_UNREADABLE
    return { key, action: 'latched' }
  }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched
  // elsewhere meanwhile (the health tick's liveness read, SRJ-315): no
  // diagnosis is reported, and the caller launches nothing.
  if (latchedAfterOwnRowRead(key, 'spawnForPersona', what, ref)) return { key, action: 'latched' }
  if (ownRead.kind === OWN_ROW_READ_REFUSED) {
    // b.jg5 SRJ-105/SRJ-114: a read error on this get is a refusal (the get
    // runs inside the launch attempt, so it arms the retry timer; `get` is
    // not tmux-touching, so it starts no condition). No diagnosis is
    // reported; the caller launches nothing.
    const refused = refusalAt(key, ownRead.error, 'get', 'spawnForPersona', what, ref)
    if (refused) return refused
    // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME
    // is a refusal. Any other ends the ladder 'failed' as a refusal does: no
    // diagnosis, no launch, no spawn-failure notice (b.jg5 SRJ-105).
    console.error(`[slack] spawnForPersona: ${what} failed for ${ref}: ${describeAgentDirectorFailure(ownRead.error)} — nothing more is called`)
    return { key, action: 'failed' }
  }
  if (ownRead.kind === OWN_ROW_READ_ABSENT) {
    read.lastRead = LATCH_ROW_STATE_NO_ROW
    // (a) Row already gone (ErrSpawnNotFound) — cannot enrich or classify.
    // Inconclusive: the row could not be consulted at all, so whether history
    // was lost is unknown. Report it as uncertainty, not reassurance.
    const adDetail = adCandidates.length
      ? adCandidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : redactSlackLogText(err.errDescription || '(no path detail from agent-director)')
    const notice = reportInconclusiveDiagnosis(
      ref,
      claudeInstanceId,
      `the agent-director row is absent (ErrSpawnNotFound); AD reported: ${adDetail}`,
      isStartup,
      err,
    )
    return { verdict: 'inconclusive', notice }
  }
  const row = ownRead.row
  read.lastRead = latchRowStateRead(row.state)
  // b.jg5 SRJ-502: a persona this read latched is not brought up fresh, so
  // the diagnosis, whose texts say it is, is not reported either.
  if (ownRead.latched) return { key, action: 'latched' }

  // --- 3. Assemble the candidate list to log. ----------------------------
  // The persona's effective claude_config_dir (per-persona, else top-level);
  // undefined makes resolveJsonlPath use the home-directory default.
  const effectiveConfigDir = persona.claude_config_dir
  const candidates: JsonlCandidate[] = [...adCandidates]

  if (adCandidates.length === 0) {
    // pre-b.1ba / shape-mismatch path: AD gave no enumerated detail.
    // Reconstruct what WE can, clearly labelled as locally computed — never
    // claim it is what AD tried.
    if (row.jsonl_path) {
      candidates.push({
        source: 'locally-computed(persisted-column)',
        path: row.jsonl_path,
        note: localStatNote(row.jsonl_path),
      })
    }
    if (row.claude_session_id) {
      const fallback = resolveJsonlPath(row.cwd, row.claude_session_id, effectiveConfigDir)
      if (fallback !== row.jsonl_path) {
        candidates.push({
          source: 'locally-computed(config-dir fallback)',
          path: fallback,
          note: localStatNote(fallback),
        })
      }
    }
  }

  const candidateStr =
    candidates.length > 0
      ? candidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : '(no transcript path could be determined)'
  const detailProvenance =
    adCandidates.length > 0
      ? 'paths+sources reported by agent-director'
      : 'agent-director gave no path detail (pre-b.1ba message shape); paths below are locally computed'

  // --- 4. Classify never-created vs lost via message-archive evidence. ----
  // Reuse b.zak's archive-count helper (message_archive_db, read-only, absent
  // file → null == no evidence). started_at bounds "since spawn".
  const startedAtEpoch = row.started_at ? rfc3339ToEpochSeconds(row.started_at) : null
  // b.av2 SR-7.4: count only the persona's `delivery: all` channels; a zero
  // count is evidence of idleness only when the archive can see all of the
  // persona's traffic (no `mentions` channel, DMs off).
  const scope = personaArchiveEvidenceScope(persona)
  const archiveCount = makeDefaultArchiveCount(config)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : archiveCount(scope.channelIds, startedAtEpoch, ref)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // LOST: conversation provably happened since spawn, yet no transcript
    // survives. Real context destroyed — must be operator-visible.
    const detail =
      `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the persona is ` +
      `${JSONL_DIAGNOSIS_REUSE_WORDING}, but the message archive holds ${archivedSinceSpawn} message(s) since spawn ` +
      `(started_at=${row.started_at}). Conversation history was LOST. Transcript candidates tried ` +
      `(${detailProvenance}): ${candidateStr}.`
    console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
    // Operator-visible signal — reuse the existing startup-errors mechanism.
    if (isStartup) recordStartupError(JSONL_TRANSCRIPT_LOST_ENTRY_CLASS, detail, describeAgentDirectorFailure(err))
    // And a persona notice so it is not buried in logs, posted once the
    // reuse spawn has brought the persona up.
    const notice =
      `⚠️ CSCB: on restart my conversation transcript could not be found, but the message archive shows ` +
      `${archivedSinceSpawn} message(s) since I started — my conversation memory has been lost and I ` +
      `was ${JSONL_DIAGNOSIS_REUSE_WORDING}. An operator should investigate transcript storage. Paths tried: ${candidateStr}`
    return { verdict: 'lost', notice }
  }

  // Below archivedSinceSpawn is 0 or null. Only an attributable 0 (archive
  // consulted, no activity since spawn in channels that carry all of the
  // persona's traffic) is evidence-based never-created. null means we never got
  // a usable count, and an unattributable 0 proves nothing — both are
  // INCONCLUSIVE, not reassurance.
  if (archivedSinceSpawn === 0 && scope.zeroIsAttributable) {
    // NEVER-CREATED (evidence-based): the archive was consulted and proved zero
    // archived activity since spawn. Claude writes the .jsonl lazily on first
    // message; a persona idle since spawn simply never had one. Expected and
    // lossless — quiet log, no error, no persona notice; counted with the
    // diagnosed amnesia (`fresh-after-amnesia`).
    console.error(
      `[slack] ErrJsonlMissing diagnostic: ${ref} instance=${claudeInstanceId} — transcript never ` +
        `created (archive consulted: 0 archived messages since spawn). Nothing to lose; the persona is ` +
        `${JSONL_DIAGNOSIS_REUSE_WORDING}. Transcript candidates tried (${detailProvenance}): ${candidateStr}.`,
    )
    return { verdict: 'never-created' }
  }

  // INCONCLUSIVE: we could not gather enough evidence to decide loss vs
  // never-created. Determine WHY — the operator needs the actionable cause.
  //   (b) started_at absent/unparseable → could not bound "since spawn".
  //   (c-config) no message_archive_db configured → diagnosis is structurally
  //              impossible; actionable "turn on the archive" hint.
  //   (c-other) archive configured but file-missing / unreadable / query threw.
  //   (d) b.av2 SR-7.4: a 0 count the archive cannot attribute to the persona.
  let reason: string
  if (startedAtEpoch === null) {
    reason =
      `the row's started_at is absent or unparseable (started_at=${row.started_at ?? '(none)'}), ` +
      `so "since spawn" could not be bounded and the archive was not consulted`
  } else if (archivedSinceSpawn === 0) {
    reason = UNATTRIBUTABLE_ZERO_REASON
  } else if (!config.message_archive_db) {
    reason =
      `no message archive is configured (message_archive_db unset), so there is no evidence source to ` +
      `consult — enable the message archive to make transcript-loss diagnosis possible`
  } else {
    reason =
      `the message archive (${config.message_archive_db}) could not be consulted (missing file, ` +
      `unreadable, or the count query failed) — see prior archive-count error line`
  }
  const notice = reportInconclusiveDiagnosis(
    ref,
    claudeInstanceId,
    `${reason}. Transcript candidates tried (${detailProvenance}): ${candidateStr}`,
    isStartup,
    err,
  )
  return { verdict: 'inconclusive', notice }
}

/**
 * b.fwu, b.jg5 SRJ-712: the operator-visible signal for an INCONCLUSIVE
 * `ErrJsonlMissing` diagnosis, one where whether prior history was lost
 * could not be determined. Like the 'lost' verdict, it writes the log line
 * and, at start, the startup-errors entry
 * (`JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS`) now, and answers the persona
 * notice text, which its caller posts once the reuse spawn has brought the
 * persona up. Every text says the persona is brought up fresh by a reuse
 * spawn and its row is kept (`JSONL_DIAGNOSIS_REUSE_WORDING`), and is worded
 * as uncertainty, not loss: a false "your history was destroyed" is its own
 * harm. Never throws.
 */
function reportInconclusiveDiagnosis(
  ref: string,
  claudeInstanceId: string,
  reason: string,
  isStartup: boolean,
  err: AgentDirectorError,
): string {
  const detail =
    `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the persona is ` +
    `${JSONL_DIAGNOSIS_REUSE_WORDING}, but diagnosis was INCONCLUSIVE — could not determine whether conversation ` +
    `history was lost because ${reason}.`
  console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
  if (isStartup) recordStartupError(JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS, detail, describeAgentDirectorFailure(err))
  return (
    `⚠️ CSCB: on restart I was ${JSONL_DIAGNOSIS_REUSE_WORDING}; I could not determine whether my prior ` +
    `conversation history was preserved (diagnosis inconclusive: ${reason}). An operator should ` +
    `investigate.`
  )
}

// ---------------------------------------------------------------------------
// The no-transcript step (b.jg5 SRJ-707, SRJ-712)
// ---------------------------------------------------------------------------

/** `resume`'s no-transcript answers, which go on to a reuse spawn of the same id (b.jg5 SRJ-707, SRJ-113, SRJ-705), by name. */
const NO_TRANSCRIPT_RESUME_ERR_NAMES = [ERR_NO_SESSION_ID_NAME, ERR_JSONL_MISSING_NAME, ERR_JSONL_NEVER_WRITTEN_NAME] as const

/**
 * Whether `err` is one of `resume`'s no-transcript answers (`ErrNoSessionId`,
 * `ErrJsonlMissing`, `ErrJsonlNeverWritten`). The answer is decided by name
 * (`hasAdErrorName`); the `instanceof` check only narrows the type.
 */
function isNoTranscriptResumeError(err: unknown): err is AgentDirectorError {
  return err instanceof AgentDirectorError && NO_TRANSCRIPT_RESUME_ERR_NAMES.some((name) => hasAdErrorName(err, name))
}

/** What the no-transcript step is told by its caller. */
interface NoTranscriptReuseOptions {
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  /** The row state the caller last read before the `resume` (the diagnosis's read replaces it when it makes one). */
  readonly lastRead: LatchRowState
  /** True when the caller ran the pre-launch trust patch in this launch attempt. */
  readonly trustPatchRan: boolean
}

/**
 * The no-transcript step (b.jg5 SRJ-707, SRJ-712, SRJ-113): what follows a
 * `resume` of persona `persona`'s id that answered `ErrNoSessionId`,
 * `ErrJsonlNeverWritten` or `ErrJsonlMissing` (`err`, by name;
 * `isNoTranscriptResumeError`). The collision ladder (`resumeOrFreshSpawn`)
 * and the live-row sequence's launch entry's `resume` leg
 * (`sequenceLaunchCall`) both use it. The row `resume` refused for these
 * reasons is finished, so no live-row sequence is needed first.
 *   - `ErrJsonlMissing`: the lost-transcript diagnosis runs first
 *     (`diagnoseJsonlMissing`), because the reuse spawn resets the row it
 *     reads. Its latched and refused answers end the step with no launch
 *     (b.jg5 SRJ-502, SRJ-105), and are answered as they are.
 *   - Then one reuse spawn of the same id (`reuseSpawnForPersona`), with the
 *     row state last read: the diagnosis's read when it made one, else
 *     `options.lastRead`.
 *   - A success answers `fresh-after-amnesia` after `ErrJsonlMissing`
 *     (`fresh-after-inconclusive-amnesia` for an inconclusive diagnosis),
 *     and only then posts the diagnosis's persona notice, which says the
 *     persona was brought up fresh; `spawned` for the other two answers,
 *     which lost no history.
 *   - Every other answer is the reuse spawn's (SRJ-112, `reuseSpawnFailedAt`),
 *     its collided answer included, which each caller handles; the
 *     diagnosis's notice is not posted for it, and a later attempt makes its
 *     own diagnosis.
 * Nothing here deletes, kills or makes a plain spawn. Never throws.
 */
async function noTranscriptReuse(
  persona: Persona,
  config: PersonaConfig,
  err: AgentDirectorError,
  options: NoTranscriptReuseOptions,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  let diagnosis: JsonlDiagnosis | undefined
  // b.jg5 SRJ-501: the diagnosis `get`, when made, is the last read before the reuse.
  const diagnosisRead: { lastRead?: LatchRowState } = {}
  if (hasAdErrorName(err, ERR_JSONL_MISSING_NAME)) {
    const diagnosed = await diagnoseJsonlMissing(persona, config, err, options.isStartup, diagnosisRead)
    if ('action' in diagnosed) return diagnosed
    diagnosis = diagnosed
  }
  const result = await reuseSpawnForPersona(persona, config, {
    isStartup: options.isStartup,
    lastRead: diagnosisRead.lastRead ?? options.lastRead,
    trustPatchRan: options.trustPatchRan,
  })
  if (diagnosis === undefined || result.action !== 'spawned') return result
  // b.jg5 SRJ-712: the persona is up, so the notice that says so is posted now.
  if (diagnosis.notice !== undefined) sendPersonaNotice(key, diagnosis.notice)
  // b.fwu: amnesia, not a clean spawn, so the start summary counts it apart:
  // 'lost' and 'never-created' are diagnosed, 'inconclusive' is not.
  return {
    key,
    action: diagnosis.verdict === 'inconclusive' ? 'fresh-after-inconclusive-amnesia' : 'fresh-after-amnesia',
  }
}

// ---------------------------------------------------------------------------
// The replace step (b.jg5 SRJ-707, SRJ-112, SRJ-705, SRJ-706)
// ---------------------------------------------------------------------------

/**
 * One run of the collision ladder's get-then-act for a persona
 * (`ladderGetThenAct`), carried by every step that can enter it again: the
 * replace step's reuse collision re-runs it once (b.jg5 SRJ-112).
 */
interface LadderRun {
  readonly persona: Persona
  readonly config: PersonaConfig
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  readonly ref: string
  /** The plain spawn's parameters (`buildSpawnParams`), for the retry spawn and the spawn after `resume` found no row. */
  readonly params: SpawnParams
  /** The hooks of the `spawnForPersona` call that started the ladder. */
  readonly hooks: LaunchHooks | undefined
  /**
   * True in the one re-run of get-then-act that a reuse collision gives
   * (b.jg5 SRJ-112): a reuse collision there is the second one, which
   * re-runs nothing.
   */
  readonly reuseCollisionRerun: boolean
}

/**
 * Whether the row state a ladder site last read is finished for the replace
 * step: `ended`, `missing` or no row. Every other state is live, `pending`
 * and an unreadable state included (b.jg5 SRJ-707, SRJ-705).
 */
function lastReadIsFinished(lastRead: LatchRowState): boolean {
  if (lastRead.kind === LATCH_ROW_STATE_KIND_NO_ROW) return true
  return lastRead.kind === LATCH_ROW_STATE_KIND_READ && AGENT_DIRECTOR_DEAD_STATES.has(lastRead.state)
}

/** The live-row sequence's seed state for a live row last read as `lastRead` (an unreadable state is seeded as such, a live state CSCB does not know). */
function sequenceSeedState(lastRead: LatchRowState): string {
  return lastRead.kind === LATCH_ROW_STATE_KIND_READ ? lastRead.state : LATCH_ROW_STATE_KIND_UNREADABLE
}

/**
 * The replace step (b.jg5 SRJ-707, SRJ-1503, SRJ-1504): replace persona P's
 * row `cscb_<key>` at a collision ladder site whose row cannot be kept
 * (`replacing` says why: `resume_enabled` false, a `cwd` mismatch, a
 * `config_dir` label missing or different), deciding on `lastRead`, the row state the site last
 * read:
 *   - finished (`ended`, `missing` or no row): one reuse spawn of the same id
 *     (`reuseSpawnForPersona`, SRJ-112), through the finished-row branch
 *     (`reuseFinishedRow`), whose collision re-runs get-then-act once;
 *   - live (every other state, `pending` and an unreadable state included):
 *     the live-row sequence (SRJ-705), started through the start entry
 *     (`startLiveRowSequence`) with the state last read as its seed, entry
 *     at step 1, the conversation not kept, the key not retired, ending in
 *     a launch, alert context `recovery`; the sequence decides its step-6
 *     launch itself, a reuse spawn of the same id for each of these reasons.
 *     No other call is made, and the answer is `sequence-waiting` whatever
 *     the start entry answers (`started`, `already-running`, `closed`,
 *     `not-installed`), each with its own line from the start entry or the
 *     registry; nothing is counted (SRJ-706, SRJ-1015).
 * The step never deletes, never kills and never launches over a live row.
 * Never throws.
 */
async function replacePersonaRow(run: LadderRun, lastRead: LatchRowState, replacing: string): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref } = run
  const { key } = persona
  if (lastReadIsFinished(lastRead)) {
    console.error(
      `[slack] spawnForPersona: replacing the row of ${ref} (${replacing}; last read ${describeLatchRowState(lastRead)}): a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-707)`,
    )
    return reuseFinishedRow(run, REUSE_SPAWN_WHAT, () =>
      reuseSpawnForPersona(persona, config, { isStartup, lastRead, trustPatchRan: true }),
    )
  }
  const startAnswer = startLiveRowSequence({
    key,
    ref,
    instanceId: personaInstanceId(key),
    lastReadState: sequenceSeedState(lastRead),
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    retiredKey: false,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
  })
  console.error(
    `[slack] spawnForPersona: replacing the row of ${ref} (${replacing}; last read ${describeLatchRowState(lastRead)}): a live row goes through the live-row sequence first, which ends in a reuse spawn of the same id; start answered ${startAnswer} — answering sequence-waiting; no other call, nothing counted (b.jg5 SRJ-707, SRJ-705, SRJ-706)`,
  )
  return { key, action: 'sequence-waiting' }
}

/**
 * The replace step's finished-row branch (b.jg5 SRJ-707, SRJ-112): `reuse`
 * makes the one reuse spawn of persona `run.persona`'s id (the replace
 * step's, or the no-transcript step's after a `resume`, `noTranscriptReuse`;
 * `what` names it in the lines), and its answer is the result, except a
 * collision (`ErrInstanceIdCollision`: the row turned live), which launched
 * nothing:
 *   - the first collision re-runs get-then-act once (`ladderGetThenAct`,
 *     marked as the re-run): its collision `get` reads the row and its
 *     branches decide again;
 *   - a collision in that re-run (any second collision) makes no further
 *     call, arms the persona's retry timer with the reuse-collision cause
 *     (`reportReuseCollisionAtSite`, so the attempt records it) and answers
 *     the uncounted refused result: `failed` marked `refused`, no notice, no
 *     `spawn-failed` entry, nothing counted (SRJ-112, SRJ-301).
 * Never throws.
 */
async function reuseFinishedRow(
  run: LadderRun,
  what: string,
  reuse: () => Promise<ReuseSpawnResult>,
): Promise<SpawnPersonaResult> {
  const { key } = run.persona
  const { ref } = run
  const reused = await reuse()
  if (!isReuseSpawnCollided(reused)) return reused
  if (!run.reuseCollisionRerun) {
    console.error(
      `[slack] spawnForPersona: the ${what} of ${ref} collided with a live row — nothing launched; re-running get-then-act once (b.jg5 SRJ-112)`,
    )
    return ladderGetThenAct({ ...run, reuseCollisionRerun: true })
  }
  // b.jg5 SRJ-112, SRJ-301: a second collision; P is re-evaluated at its
  // next tick or retry, so its retry timer is armed with the reuse-collision cause.
  const armed = reportReuseCollisionAtSite(key)
  console.error(
    `[slack] spawnForPersona: the ${what} of ${ref} collided with a live row again, in the re-run of get-then-act — nothing launched; answering the uncounted refused result, no spawn-failure notice, nothing counted; the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION}; b.jg5 SRJ-112)`,
  )
  return { key, action: 'failed', refused: true }
}

/**
 * Recover a collided spawn whose live session cannot be reached: resume-first
 * (preserves session history) when resume_enabled, with these fallbacks:
 * ErrNoSessionId / ErrJsonlMissing / ErrJsonlNeverWritten (by name) → the
 * no-transcript step (`noTranscriptReuse`, b.jg5 SRJ-707, SRJ-712): after
 * ErrJsonlMissing the lost-transcript diagnosis, then one reuse spawn of the
 * same id through the replace step's finished-row branch
 * (`reuseFinishedRow`), with nothing deleted; ErrSpawnNotResumable → a lost
 * race (below); ErrSpawnNotFound → a plain spawn, since the row is gone.
 * A resume's ErrTmuxSessionCreate has
 * no fallback: it is one counted launch failure through `resumeFailedAt`
 * (b.jg5 SRJ-113, SRJ-602), which kills nothing, makes no spawn in its
 * place and arms the persona's retry timer at once in pending-only mode, so
 * that the retry's read of the row decides (SRJ-409; HO rev 28). The spawn
 * after ErrSpawnNotFound is a plain spawn from `buildSpawnParams` (no reuse
 * flag, b.jg5 SRJ-711) whose failure takes the plain spawn's handling
 * (`plainSpawnFailedAt`), its `ErrTmuxSessionCreate` counted the same way.
 *
 * `opts.lastRead` is the row state the caller last read, which the replace
 * step decides on (b.jg5 SRJ-707): the `ended`/`missing` branch's collision
 * `get` (a finished row); a dead-session path's (`reconcileMissingFirst`)
 * collision `get` or working-row wait's last read, a live row unless that
 * wait read it finished or gone; the prompt-row recovery's re-read, which
 * read it finished.
 *
 * The no-transcript step's reuse spawn has SRJ-112's outcomes
 * (`reuseSpawnFailedAt`); its collision (`ErrInstanceIdCollision`: the row
 * is live again) takes the finished-row branch's one get-then-act re-run,
 * and a second collision arms the reuse-collision cause and answers the
 * uncounted refused result (`reuseFinishedRow`).
 * This is the `ended`/`missing` state handling, extracted so the
 * b.3ce dead-session fallback in the `waiting`/`working` branches reuses the
 * exact same decision logic instead of inventing its own.
 *
 * `resume_enabled: false` (b.jg5 SRJ-707): the row is not resumed; the
 * replace step replaces it, a finished row by a reuse spawn of the same id
 * and a live row through the live-row sequence first, nothing deleted.
 *
 * b.av2 SR-6.2 `config_dir` guard, as amended (b.jg5 SRJ-1504): before the
 * `resume` call (after the reconcile-missing-first sweep), the row's
 * `config_dir` label — captured by the collision `get` when the ladder
 * started — is compared with the persona's current effective
 * claude_config_dir through `compareRowToPersona`. On a mismatch or a
 * missing label it does not resume, because agent-director's `ResumeParams`
 * carries only the instance ID and a resume keeps the old
 * `CLAUDE_CONFIG_DIR`: a live row goes through the live-row sequence, then a
 * reuse spawn of the same id (a new life); a finished row gets that reuse
 * spawn directly; no row is deleted (the replace step). The old history
 * stays in the old directory, archived to the earlier life. No transcript
 * was lost, so no JSONL diagnosis or amnesia action runs. A directory that
 * cannot be resolved keeps the row and answers `deferred` with no call (bug
 * b.g57).
 *
 * b.jg5 SRJ-710: `ErrSpawnNotResumable` is never by itself a reason to kill
 * and replace, and it is no reuse site: it is a lost race. Nothing is
 * killed, deleted or launched, nothing is counted or posted, the persona's
 * retry timer is armed with the lost-race cause
 * (`reportLostRaceAtSite`, `UNAVAILABLE_RETRY_CAUSE_LOST_RACE`), and the
 * answer is the uncounted refused result, so the persona is re-evaluated at
 * its next tick or retry; the row is not re-read here.
 *
 * b.jg5 SRJ-104: a `resume` that answers `ErrInvalidFlags` goes through the
 * `ErrInvalidFlags` step (`classifyWithInvalidFlagsRecheck`): one immediate
 * version re-check (a stop it decides ends the process, SRJ-205), class
 * UNCLASSIFIED, and one log line built from the classification's rendered
 * fields. Nothing is deleted, killed or launched because of it. When the
 * re-check decides the stop, nothing is posted and the `failed` result is
 * marked `stopping`, which the restart path does not count; after any other
 * re-check answer it takes SRJ-105's UNCLASSIFIED row (SRJ-313): the outage
 * state's site entry (`reportUnclassifiedAtSite`) arms the persona's retry
 * timer with the UNCLASSIFIED cause and reports it to the persona's
 * unclassified-error episode, one refusal line is logged, no spawn-failure
 * notice is posted, and the `failed` result is refused (never counted).
 *
 * Every other UNCLASSIFIED outcome here (SRJ-113, SRJ-111: "No step
 * follows"), `ErrSystemInstallDisappeared` included, is a refusal through
 * `refusalAt`, at the resume and at each spawn after it.
 *
 * b.jg5 SRJ-501, SRJ-113, SRJ-111: a CONFLICT at the resume, or at any
 * spawn after it, latches the persona (`conflictAt`), with the refused
 * operation "resume", "plain spawn" or, at a reuse spawn, "reuse spawn", and
 * the row state the path last read before that call: `opts.lastRead` (the
 * caller's last read: the collision `get`'s state, the working-row wait's
 * last `status`, or the prompt row's re-read), or, for the reuse after
 * `ErrJsonlMissing`, what its diagnosis `get` read. It answers `latched`:
 * nothing is killed, deleted or launched after it. An UNUSABLE NAME answer
 * at the resume or at any spawn after it latches the persona the same way,
 * with the refused operation "none" (b.jg5 SRJ-512, `unusableNameAt`).
 *
 * b.jg5 SRJ-120, SRJ-502: with `reconcileMissingFirst`, a persona latched
 * once the findMissing sweep is done (a post-run `get` of its own row read
 * the latching note, or the latch answers it latched) answers `latched` with
 * one line and no `resume`, sequence or spawn.
 *
 * @param row  The row returned by the collision `get` (its `labels`).
 */
async function resumeOrFreshSpawn(
  run: LadderRun,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  opts: { reconcileMissingFirst?: boolean; lastRead: LatchRowState },
): Promise<SpawnPersonaResult> {
  const { persona, params, config, isStartup, ref } = run
  const { key } = persona
  const { lastRead } = opts
  if (config.resume_enabled === false) {
    // b.jg5 SRJ-707: no resume; the replace step decides on the state last read.
    console.error(`[slack] spawnForPersona: resume_enabled=false for ${ref} — not resuming; replacing its row by a reuse spawn of the same id`)
    return replacePersonaRow(run, lastRead, 'resume_enabled is false')
  }

  // b.4dk: dead-session callers (state=waiting/working with a verified-dead
  // tmux session) arrive with a LIVE-state AD row. AD's resume verb requires
  // a terminal row (ended/missing) — otherwise ErrSpawnNotResumable. Run
  // findMissing first so AD's per-row, evidence-based sweep (agent-director
  // plan b.93m, t1.93m.hp: degraded-mode guard removed) transitions the dead
  // row to `missing`, letting resume succeed and preserve session history.
  // The ended/missing caller does NOT set reconcileMissingFirst (row already
  // terminal). A refused sweep (b.jg5 SRJ-105: UNAVAILABLE, e.g.
  // ErrCallTimeout, ENVIRONMENT, ErrTmuxNotAvailable, CONFIG,
  // ErrConfigMalformed, SRJ-316, or UNCLASSIFIED, SRJ-313), or a refused
  // post-run `get` of the persona's own row (SRJ-114), stops the attempt
  // before the resume: a resume of the still-live row would answer
  // ErrSpawnNotResumable, a lost race. The ladder answers failed, and
  // markRefusal adds `refused`. On any other findMissing error, fall through
  // to attempting resume anyway (an ErrSpawnNotResumable then is the lost
  // race below). Prefer AD's findMissing verb over CSCB-side tmux probing per
  // docs/engineering-guide.md ("Avoiding Duplicated Effort").
  if (opts.reconcileMissingFirst) {
    const sweep = await reconcileMissingSweep(key, 'spawnForPersona: before resume', ref)
    if (sweep === FIND_MISSING_REFUSED) return { key, action: 'failed' }
    if (sweep === FIND_MISSING_LATCHED) {
      // b.jg5 SRJ-120, SRJ-502: the persona latched during the sweep (a
      // post-run `get` of its row read the latching note, or the latch
      // answers it latched): no resume, sequence or spawn follows.
      console.error(
        `[slack] spawnForPersona: ${ref} is latched after the findMissing sweep before resume — not resuming; nothing more is called for it (b.jg5 SRJ-502)`,
      )
      return { key, action: 'latched' }
    }
  }

  // b.av2 SR-6.2 (b.jg5 SRJ-1504): a resume keeps the row's old
  // CLAUDE_CONFIG_DIR, so resume only a row labelled with the persona's
  // current effective config dir.
  const configDir = compareRowToPersona(row, persona, spawnHomeDir(), undefined, _configDirFs)
  if (!configDir.configDirResolved) return deferForUnresolvedConfigDir(persona, ref)
  if (!configDir.configDirMatches) {
    console.error(`[slack] spawnForPersona: ${configDirMismatchText(persona, ref, configDir)} — not resuming; replacing its row by a reuse spawn of the same id`)
    return replacePersonaRow(run, lastRead, CONFIG_DIR_MISMATCH_WHY)
  }

  // resume_enabled: attempt resume
  console.error(`[slack] spawnForPersona: attempting resume for ${ref}`)
  try {
    const launched: Phase1ResumeResult = await launchWithReplyGuard(persona, ref, 'resume', (client) => client.resume({ claude_instance_id: personaInstanceId(key) }))
    console.error(`[slack] spawnForPersona: resumed ${ref}`)
    // A resumed bot faces the same startup dialogs as a fresh one. Its row
    // reads `pending` from the resume until its session reports in (HO C5),
    // so the approver clears the dialog through agent-director, as after a
    // spawn (b.jg5 SRJ-402).
    afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_RESUME, launched)
    return { key, action: 'resumed' }
  } catch (err) {
    if (isNoTranscriptResumeError(err)) {
      console.error(
        `[slack] spawnForPersona: ${describeAgentDirectorFailure(err)} on resume for ${ref} — a reuse spawn of the same id follows; nothing is deleted (b.jg5 SRJ-707)`,
      )
      // b.jg5 SRJ-707, SRJ-712: the no-transcript step, through the replace
      // step's finished-row branch (the row `resume` refused is finished).
      // After ErrJsonlMissing the lost-transcript diagnosis runs first; a
      // refused diagnosis get ends the ladder with no launch (`failed`, which
      // markRefusal marks `refused`), and one that latched the persona
      // answers `latched` (b.jg5 SRJ-105, SRJ-502). ErrNoSessionId and
      // ErrJsonlNeverWritten lost no history, so they get no diagnosis and a
      // success answers `spawned`. The reuse spawn's outcomes are SRJ-112's:
      // a CONFLICT latches with the refused operation "reuse spawn" (b.jg5
      // SRJ-501); a collision re-runs get-then-act once.
      return reuseFinishedRow(run, `${REUSE_SPAWN_WHAT} after its resume's no-transcript answer`, () =>
        noTranscriptReuse(persona, config, err, { isStartup, lastRead, trustPatchRan: true }),
      )
    }
    if (hasAdErrorName(err, ERR_SPAWN_NOT_RESUMABLE_NAME)) return spawnNotResumableLostRace(key, ref, err)
    if (err instanceof ErrSpawnNotFound) {
      // Row vanished between the dead-session verdict and resume (operator
      // action, expire, race) — a plain spawn: the row is already gone.
      // Mirrors the caller-level retry below.
      console.error(`[slack] spawnForPersona: ErrSpawnNotFound on resume for ${ref} — fresh-spawn`)
      try {
        const launched: Phase1SpawnResult = await launchWithReplyGuard(persona, ref, 'spawn', (client) => client.spawn(params))
        console.error(`[slack] spawnForPersona: fresh-spawned (after ErrSpawnNotFound on resume) for ${ref}`)
        afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_SPAWN, launched)
        return { key, action: 'spawned' }
      } catch (err2) {
        // b.jg5 SRJ-501: `resume` is not a read, so the last read is still the caller's.
        return plainSpawnFailedAt(key, err2, isStartup, ref, 'fresh spawn after ErrSpawnNotFound on resume', lastRead)
      }
    }
    return resumeFailedAt(key, err, isStartup, ref, lastRead)
  }
}

/** The replace step's reason for a `config_dir` label missing or different (b.jg5 SRJ-707, SRJ-1504). */
const CONFIG_DIR_MISMATCH_WHY = 'its config_dir label is missing or differs'

/** The replace step's reason for a row whose `cwd` differs from the persona's working directory by real path (b.jg5 SRJ-707, SRJ-1503). */
const CWD_MISMATCH_WHY = "its cwd differs from the persona's working directory"

/** The words of a `config_dir` mismatch line: the label missing or changed, what it was and what it is now. */
function configDirMismatchText(persona: Persona, ref: string, configDir: RowPersonaComparison): string {
  const was = configDir.configDirLabel === undefined ? 'label absent' : `was=${configDir.configDirLabel}`
  return (
    `${ref} config_dir label ${configDir.configDirLabel === undefined ? 'missing' : 'changed'} ` +
    `(${was}, now=${configDir.expectedConfigDirLabel} for claude_config_dir=${persona.claude_config_dir ?? '<default>'})`
  )
}

/**
 * Bug b.g57: the persona's claude_config_dir stopped resolving since this
 * ladder's pre-launch check, so a row's `config_dir` label has no verdict and
 * is no reason to replace it: the row is kept and nothing is launched; the
 * hold re-checks and launches once it resolves (`deferred`). Never throws.
 */
function deferForUnresolvedConfigDir(persona: Persona, ref: string): SpawnPersonaResult {
  const deferred = deferIfConfigDirUnresolvable(persona)
  if (deferred !== undefined) return deferred
  // It resolved again between the comparison and the re-check: nothing
  // holds it, and its next restart or health tick launches it.
  console.error(
    `[slack] spawnForPersona: ${ref} claude_config_dir could not be resolved during the launch — keeping its row; not launching`,
  )
  return { key: persona.key, action: 'deferred' }
}

/**
 * `resume`'s `ErrSpawnNotResumable` at the collision ladder (b.jg5 SRJ-710,
 * SRJ-707, SRJ-301): never by itself a reason to kill and replace, and no
 * reuse site, so a lost race: one line, no kill, delete or launch, the
 * persona's retry timer armed with the lost-race cause through the outage
 * state's site entry (`reportLostRaceAtSite`; the attempt records it), and
 * the uncounted refused result (`failed` marked `refused`): no notice, no
 * `spawn-failed` entry, nothing counted. The persona is re-evaluated at its
 * next tick or retry; the row is not re-read here. Never throws.
 */
function spawnNotResumableLostRace(key: string, ref: string, err: unknown): SpawnPersonaResult {
  const armed = reportLostRaceAtSite(key)
  console.error(
    `[slack] spawnForPersona: ${describeAgentDirectorFailure(err)} on resume for ${ref} — a lost race: nothing killed, deleted or launched; answering the uncounted refused result, no spawn-failure notice, nothing counted; the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_LOST_RACE}; b.jg5 SRJ-710)`,
  )
  return { key, action: 'failed', refused: true }
}

/**
 * A `resume`'s failure by class, once its site's own branches have passed
 * it (`resumeOrFreshSpawn`'s, the live-row sequence's launch entry's), with
 * no further launch: `ErrInvalidFlags` gets one immediate version re-check
 * (a stop it decides answers `failed` marked `stopping`; otherwise
 * UNCLASSIFIED through the site entry, b.jg5 SRJ-104, SRJ-313); the
 * DIRECTORY errors (`ErrCwdNotFound`, `ErrCwdNotADirectory`, by name) answer
 * `failed` quietly (the wrapper raised `cwd-unreachable`); then the refusal handling
 * (`launchRefusalAt`: a CONFLICT latches with the refused operation
 * "resume" and `lastRead`, an UNUSABLE NAME latches, a refusal answers
 * `failed`); any other error answers `failed` with one line and the
 * spawn-failure notice. An `ErrTmuxSessionCreate` (LAUNCH FAILURE, by name)
 * among those is one counted launch failure (b.jg5 SRJ-113, SRJ-602): one
 * line, the notice, a `spawn-failed` entry at start, and
 * `launchFailureResult`'s answer: nothing is killed, no spawn is made in its
 * place, and the persona's retry timer is armed at once in pending-only
 * mode, since agent-director's restore of the row may not have applied (HO
 * rev 28), so the retry's read of the row decides (SRJ-301, SRJ-409); the
 * result is marked `countedClass`, and `pendingOnlyArmed` when it armed.
 * Never throws.
 */
async function resumeFailedAt(
  key: string,
  err: unknown,
  isStartup: boolean,
  ref: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult> {
  if (isInvalidFlagsError(err)) {
    // b.jg5 SRJ-104: the resume site gives ErrInvalidFlags no meaning: one
    // immediate version re-check, then UNCLASSIFIED. The line is built from
    // the classification's rendered fields, never from the error itself.
    const step = await classifyWithInvalidFlagsRecheck(err)
    const recheck = `after one immediate agent-director version re-check: ${step.recheck.kind}`
    // The stop posts nothing to Slack, and a launch it ends is not counted.
    if (step.recheck.kind === RECHECK_OUTCOME_STOP) {
      console.error(
        `[slack] spawnForPersona: resume failed for ${ref}: ${describeAdErrorClassification(step.classification)} (${recheck})`,
      )
      return { key, action: 'failed', stopping: true }
    }
    // b.jg5 SRJ-105, SRJ-313: UNCLASSIFIED handling. The site entry arms
    // the persona's retry timer with the UNCLASSIFIED cause (so the launch
    // is refused and never counted) and reports the outcome to its
    // unclassified-error episode. No notice; no delete, kill or launch.
    reportUnclassifiedAtSite(key, err, 'resume', step.classification)
    logRefusal('spawnForPersona', 'resume', ref, `${describeAdErrorClassification(step.classification)} (${recheck})`)
    return { key, action: 'failed' }
  }
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the resume's wrapper.
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed' }
  // b.jg5 SRJ-104, SRJ-105: `ErrSystemInstallDisappeared` is UNCLASSIFIED
  // (its wrapper has raised `ad-unreachable`), a refusal like the others.
  // b.jg5 SRJ-113: a CONFLICT latches the persona (refused operation
  // "resume"); never a kill.
  const refused = await launchRefusalAt(key, err, 'resume', 'resume', ref, lastRead)
  if (refused) return refused
  const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('resume', 'UnknownError', String(err))
  const described = describeAgentDirectorFailure(e)
  if (!isLaunchFailure(err)) {
    console.error(`[slack] spawnForPersona: resume failed for ${ref}: ${described}`)
    notifySpawnFailure(key, e, isStartup)
    return { key, action: 'failed' }
  }
  console.error(`[slack] spawnForPersona: resume failed for ${ref}: ${described}${LAUNCH_FAILURE_LINE_TAIL}`)
  if (isStartup) recordStartupError('spawn-failed', `resume failed for ${ref}: ${described}`)
  notifySpawnFailure(key, e, isStartup)
  return launchFailureResult(key)
}

// ---------------------------------------------------------------------------
// Pre-launch trust patch (b.av2 SR-6.2)
// ---------------------------------------------------------------------------

/** Patches the persona's `.claude.json` trust flags before a launch. */
export type PreLaunchTrustPatcher = (persona: Persona) => void

/**
 * The one pre-launch trust patcher. Production installs the single-persona
 * trust patch (`trustPatchPersona` in `src/trust-bootstrap.ts`). With none
 * installed (unit tests, the integration driver) no patch runs and nothing
 * is written.
 */
let preLaunchTrustPatcher: PreLaunchTrustPatcher | undefined

/** Install the pre-launch trust patcher (production: `server.ts`). */
export function setPreLaunchTrustPatcher(patcher: PreLaunchTrustPatcher): void {
  preLaunchTrustPatcher = patcher
}

/** Test-only seam: remove any installed pre-launch trust patcher. */
export function _resetPreLaunchTrustPatcher(): void {
  preLaunchTrustPatcher = undefined
}

/**
 * Run the installed pre-launch trust patcher for `persona`. A throw is logged
 * with the persona reference and never reaches the ladder.
 */
function runPreLaunchTrustPatch(persona: Persona, ref: string): void {
  if (!preLaunchTrustPatcher) return
  try {
    preLaunchTrustPatcher(persona)
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch trust patch failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Pre-launch reply guard (b.av2 SR-9.4, SR-6.2)
// ---------------------------------------------------------------------------

/**
 * Runs the reply-guard steps before one persona's launch (record write,
 * launched-with update, launch-time hook pass) and may return an undo for a
 * launch that turns out not to be one.
 */
export type PreLaunchReplyGuard = (persona: Persona) => ReplyGuardUndo | void

/**
 * The one pre-launch reply guard. Production installs `preLaunchReplyGuard`
 * from `src/stop-hook-bootstrap.ts`, closed over the server's state directory
 * and a getter for the applied persona set. With none installed (unit tests,
 * the integration driver) no record is written and no settings are patched;
 * nothing here resolves a state directory.
 */
let preLaunchReplyGuard: PreLaunchReplyGuard | undefined

/** Install the pre-launch reply guard (production: `server.ts`). */
export function setPreLaunchReplyGuard(guard: PreLaunchReplyGuard): void {
  preLaunchReplyGuard = guard
}

/** Test-only seam: remove any installed pre-launch reply guard. */
export function _resetPreLaunchReplyGuard(): void {
  preLaunchReplyGuard = undefined
}

/**
 * Run the installed pre-launch reply guard for `persona`, immediately before
 * an agent-director spawn or resume. A throw is logged with the persona
 * reference and never reaches the ladder. Returns the guard's undo, if any.
 */
function runPreLaunchReplyGuard(persona: Persona, ref: string): ReplyGuardUndo | undefined {
  if (!preLaunchReplyGuard) return undefined
  try {
    return preLaunchReplyGuard(persona) ?? undefined
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch reply guard failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
    return undefined
  }
}

/** Run a reply-guard undo; a throw is logged and never reaches the ladder. */
function undoPreLaunchReplyGuard(undo: ReplyGuardUndo | undefined, ref: string): void {
  if (!undo) return
  try {
    undo()
  } catch (err) {
    console.error(`[slack] spawnForPersona: undoing the pre-launch reply guard failed for ${ref}: ${describeThrownValue(err)}`)
  }
}

/**
 * An agent-director call that starts the persona's instance (`client.spawn`
 * or `client.resume`, declared as `verb`), preceded immediately by the
 * reply-guard steps. Every
 * spawn and resume in the ladder goes through here except the optimistic
 * first spawn, which also undoes the steps when it meets a live instance.
 */
function launchWithReplyGuard<T>(
  persona: Persona,
  ref: string,
  verb: 'spawn' | 'resume',
  call: (client: Client) => Promise<T>,
): Promise<T> {
  runPreLaunchReplyGuard(persona, ref)
  return withSpawnDetection(persona.key, persona.working_directory, verb, call)
}

/**
 * In-flight launches by persona key (b.av2 SR-6.3): at most one ladder per
 * persona runs at a time. Holds only unsettled launches; an entry is removed
 * when its launch settles, whatever the outcome. A launch's dialog approver
 * is not part of it: it runs after the launch call returned, in the approver
 * registry below (b.jg5 SRJ-401).
 */
const inFlightLaunches = new Map<string, Promise<SpawnPersonaResult>>()

/**
 * Test-only seam: forget every in-flight launch (and, b.f2b, every cancel of
 * a wait one had not started); cancel, wake and forget every running wait for
 * a `working` row, as `cancelWorkingRowWait` does but without its log line, so
 * the wait types nothing more and returns `cancelled` instead of polling on
 * to its deadline; and stop and forget every dialog approver
 * (`_resetDialogApprovers`); so none outlives a test.
 */
export function _resetInFlightLaunches(): void {
  inFlightLaunches.clear()
  cancelledLaunchWaits.clear()
  for (const wait of workingRowWaits.values()) {
    wait.cancelled = true
    wait.wake()
  }
  workingRowWaits.clear()
  _resetDialogApprovers()
}

/**
 * True while a launch call (collision ladder) for persona `key` is in flight
 * (b.av2 SR-6.6). The restart module's kill adapter consults this so a restart
 * that is about to join a running launch does not first kill the session that
 * launch is bringing up. The health check skips such a persona (b.f2b): a
 * start launch still waiting in the background for a `working` row owns its
 * session until it settles. The launch's dialog approver is not part of the
 * launch in flight: this answers false while only the approver runs
 * (b.jg5 SRJ-401; `isDialogApproverRunning` answers for it).
 */
export function isLaunchInFlight(key: string): boolean {
  return inFlightLaunches.has(key)
}

// ---------------------------------------------------------------------------
// The dialog approver registry (b.jg5 SRJ-401, SRJ-404)
// ---------------------------------------------------------------------------

/** One running approver in the registry: its state and the promise its stop resolves. */
interface RegisteredApprover {
  readonly run: ApproverRun
  readonly ref: string
  /** Resolves once the approver has stopped (after any call in progress returned); never rejects. */
  readonly stopped: Promise<ApproverOutcome>
}

/**
 * The running dialog approvers by persona key (b.jg5 SRJ-401; hatch A2): at
 * most one per persona. An approver's entry is removed when it stops; an
 * approver a later start superseded has already left the map then, and the
 * later one waits for its stop before its first call.
 */
const runningApprovers = new Map<string, RegisteredApprover>()

/**
 * Keys whose launch in flight has not started its approver yet and whose
 * approver was stopped meanwhile (`stopDialogApprover`), with the stop's
 * reason: that launch's approver does not start. Forgotten when the launch
 * settles, as `cancelledLaunchWaits` is.
 */
const cancelledComingApprovers = new Map<string, ApproverStopRequestReason>()

/** Set by `stopAllDialogApprovers` (shutdown): no approver starts after it. Cleared only by the reset seam. */
let approversClosed = false

/**
 * How each persona's latest stopped approver ended; one entry per key.
 * Read by the await seam `_whenDialogApproverStopped`, which answers from it
 * once no approver runs for the key.
 */
const lastApproverOutcomes = new Map<string, ApproverOutcome>()

/**
 * Ask `entry`'s approver to stop with `reason`: marks it (the first reason
 * asked is kept) and wakes its sleep at once; a call in progress returns
 * first, and the loop makes no further call. Logs one line when this ask
 * is the first. Answers whether it was.
 */
function requestApproverStop(entry: RegisteredApprover, reason: ApproverStopRequestReason, log: boolean): boolean {
  if (entry.run.stopRequested !== undefined) return false
  entry.run.stopRequested = reason
  if (log) console.error(approverLogLine(approverStopRequestedMessage(entry.ref, reason)))
  entry.run.wake?.()
  return true
}

/**
 * Start persona `key`'s dialog approver on its own (b.jg5 SRJ-401): the
 * approver's loop (`approvePreSessionDialogs`' rules) runs without being
 * awaited, outside every launch or recovery attempt (`runOutsideAttempts`),
 * so this returns at once, and the caller's launch call returns while the
 * approver runs. Its UNAVAILABLE answers then arm no retry timer and start
 * no `tmux-unresponsive` condition, its UNCLASSIFIED answers open no
 * unclassified-error episode and arm nothing, and its ENVIRONMENT and CONFIG
 * answers raise their outages and arm the persona's retry timer as from any
 * verb (SRJ-301, SRJ-307, SRJ-311, SRJ-313, SRJ-316).
 *
 * The approver makes its first call only once the launch in flight for
 * `key` when it starts (the launch whose success started it), if any, has
 * settled, so it never runs while `isLaunchInFlight` answers for that
 * launch. The registry holds at most one approver per persona (hatch A2): an
 * approver still running for `key` is stopped first (`superseded`, one line),
 * and the new one makes its first call only once that stop has completed.
 * No approver starts when `key` was stopped while this launch was in flight
 * (`stopDialogApprover`), or after `stopAllDialogApprovers`: one line, and
 * the answer false. Otherwise answers true. A failure inside the loop is
 * logged and the approver stops (`failed`); it never becomes an unhandled
 * rejection. The entry is removed when the approver stops. Never throws.
 */
export function startDialogApprover(key: string, isStartup: boolean, ref: string = keyRef(key)): boolean {
  const refusal = approversClosed ? APPROVER_STOP_SHUTDOWN : cancelledComingApprovers.get(key)
  if (refusal !== undefined) {
    console.error(approverLogLine(approverNotStartedMessage(ref, refusal)))
    return false
  }
  const previous = runningApprovers.get(key)
  if (previous !== undefined) requestApproverStop(previous, APPROVER_STOP_SUPERSEDED, true)
  const run = newApproverRun()
  let resolveStopped!: (outcome: ApproverOutcome) => void
  const stopped = new Promise<ApproverOutcome>((resolve) => {
    resolveStopped = resolve
  })
  const entry: RegisteredApprover = { run, ref, stopped }
  runningApprovers.set(key, entry)
  const launch = inFlightLaunches.get(key)
  runOutsideAttempts(() => {
    void runRegisteredApprover(key, isStartup, entry, launch, previous).then(resolveStopped)
  })
  return true
}

/**
 * The registered approver's run: waits for `launch` to settle and
 * `previous` to stop, runs the loop unless a stop came meanwhile, and
 * removes its entry. Never rejects.
 */
async function runRegisteredApprover(
  key: string,
  isStartup: boolean,
  entry: RegisteredApprover,
  launch: Promise<unknown> | undefined,
  previous: RegisteredApprover | undefined,
): Promise<ApproverOutcome> {
  let reason: ApproverStopReason
  try {
    // Always awaited, so the first call comes after the start entry returned.
    await (launch ?? Promise.resolve()).then(
      () => undefined,
      () => undefined, // the launch's own caller handles its outcome
    )
    if (previous !== undefined) await previous.stopped
    reason = entry.run.stopRequested ?? (await runApproverLoop(key, isStartup, entry.ref, entry.run))
  } catch (err) {
    console.error(approverLogLine(approverFailedMessage(entry.ref, describeThrownValue(err))))
    reason = APPROVER_STOP_FAILED
  }
  const outcome: ApproverOutcome = { reason, launchStartMs: entry.run.launchStartMs }
  if (runningApprovers.get(key) === entry) {
    runningApprovers.delete(key)
    lastApproverOutcomes.set(key, outcome)
  }
  return outcome
}

/**
 * Stop persona `key`'s dialog approver with `reason` (b.jg5 SRJ-404), as
 * `cancelWorkingRowWait` cancels a launch's wait. A running approver is
 * marked and its sleep woken at once; it makes no call after the one in
 * progress, if any, returns (no `send-keys` follows a stop), and resolves
 * true once it has stopped, with one line logged when this stop was the
 * first asked of it. While a launch for `key` is in flight, the approver that
 * launch would start is cancelled too, from its start: it makes no call.
 * Resolves false, silently, when no approver ran. Never rejects.
 */
export async function stopDialogApprover(key: string, reason: ApproverStopRequestReason): Promise<boolean> {
  if (inFlightLaunches.has(key) && !cancelledComingApprovers.has(key)) cancelledComingApprovers.set(key, reason)
  const entry = runningApprovers.get(key)
  if (entry === undefined) return false
  requestApproverStop(entry, reason, true)
  await entry.stopped
  return true
}

/**
 * Stop every running dialog approver (`shutdown`, b.jg5 SRJ-404), and let no
 * approver start after it. Every approver is marked and woken before this
 * returns its promise, so none makes a further call once the call in
 * progress returns; the promise resolves once all have stopped. Never rejects.
 */
export async function stopAllDialogApprovers(): Promise<void> {
  approversClosed = true
  const entries = [...runningApprovers.values()]
  for (const entry of entries) requestApproverStop(entry, APPROVER_STOP_SHUTDOWN, true)
  await Promise.all(entries.map((entry) => entry.stopped))
}

/**
 * True while a dialog approver runs for persona `key` (b.jg5 SRJ-401): from
 * its start until it has stopped, a stop asked but not yet completed
 * included. Such an approver is in flight for the persona for the health
 * tick and the lost-message routing, and never blocks a retry (SRJ-303).
 */
export function isDialogApproverRunning(key: string): boolean {
  return runningApprovers.has(key)
}

/**
 * The launch start (epoch ms) that persona `key`'s running approver kept:
 * the one its first lap whose `status` read the row `pending` with a launch
 * start read (b.jg5 SRJ-401, SRJ-412). Undefined when no approver runs or
 * none has kept one yet. Read-only. That kept launch start is what decides
 * whether a launch that returned success is CSCB's own (b.jg5 SRJ-412).
 */
export function dialogApproverLaunchStart(key: string): number | undefined {
  return runningApprovers.get(key)?.run.launchStartMs
}

/**
 * Test-only seam: resolves with how persona `key`'s latest approver ended:
 * the running one's, once it has stopped; otherwise at once the last one's
 * that stopped while it was the persona's latest (a superseded approver's
 * outcome is not kept); `undefined` when there is none. Starts and stops
 * nothing.
 */
export function _whenDialogApproverStopped(key: string): Promise<ApproverOutcome | undefined> {
  return runningApprovers.get(key)?.stopped ?? Promise.resolve(lastApproverOutcomes.get(key))
}

/**
 * Test-only seam: stop every running approver (marked and woken, silently;
 * each makes no further call once its call in progress returns) and forget
 * them all, with every cancel of a coming approver and the shutdown mark.
 */
export function _resetDialogApprovers(): void {
  for (const entry of runningApprovers.values()) requestApproverStop(entry, APPROVER_STOP_SHUTDOWN, false)
  runningApprovers.clear()
  cancelledComingApprovers.clear()
  lastApproverOutcomes.clear()
  approversClosed = false
}

/** The launches whose success runs the after-launch step, as the `pre_trust` line names them. */
export type LaunchVerb = typeof LAUNCH_VERB_SPAWN | typeof LAUNCH_VERB_RESUME | typeof LAUNCH_VERB_REUSE_SPAWN
/** A plain spawn (a first or retry spawn, or the spawn after `resume` found no row). */
export const LAUNCH_VERB_SPAWN = 'spawn'
/** A `resume`. */
export const LAUNCH_VERB_RESUME = 'resume'
/** A reuse spawn: agent-director's `spawn` with the reuse flag (`reuseSpawnForPersona`; b.jg5 SRJ-112, SRJ-413). */
export const LAUNCH_VERB_REUSE_SPAWN = 'reuse spawn'

/** The head of every `pre_trust` line. */
export const PRE_TRUST_LOG_PREFIX = '[slack] spawnForPersona: '

/**
 * The one log line a successful launch writes about its `pre_trust` (b.jg5
 * SRJ-413): the persona reference `ref`, the launch verb (a plain spawn, a
 * `resume` or a reuse spawn, `LaunchVerb`) and the value the result carried, shown as it arrived (rendered for the log, never checked
 * against a list); for a result without the field (`preTrust` undefined), that
 * the result came from an agent-director older than Phase 1. The line is
 * information only: no value changes what CSCB does, and a folder-trust prompt
 * that follows is the dialog approver's. Pure; never throws.
 */
export function preTrustLogLine(ref: string, verb: LaunchVerb, preTrust: PreTrust | undefined): string {
  if (preTrust === undefined) {
    return (
      `${PRE_TRUST_LOG_PREFIX}${ref} ${verb} result carries no pre_trust: ` +
      `it came from an agent-director older than Phase 1 (logged only, b.jg5 SRJ-413)`
    )
  }
  return `${PRE_TRUST_LOG_PREFIX}${ref} ${verb} pre_trust=${renderPreTrustValue(preTrust)} (logged only, b.jg5 SRJ-413)`
}

/**
 * A present `pre_trust` value as the log shows it: a string through
 * `renderLogMessageText`, any other JSON value by its JSON text, rendered the
 * same way; `<unreadable>` when that renders to nothing. Never throws.
 */
function renderPreTrustValue(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  } catch {
    text = ''
  }
  const rendered = renderLogMessageText(text)
  return rendered === '' ? '<unreadable>' : rendered
}

/**
 * The one step after a launch call that returned success (b.jg5 SRJ-401):
 * the plain spawn, the retry spawn after the collision
 * `get`'s `ErrSpawnNotFound`, the fresh spawn of a replacement, the
 * `resume`, the spawns after `resume`'s
 * `ErrSpawnNotResumable` and `ErrSpawnNotFound`, and the reuse spawn
 * (`reuseSpawnForPersona`), including the reuse spawn of the same id after
 * `resume`'s no-transcript answer (b.jg5 SRJ-707, SRJ-712). `verb` names the launch and `launched` is the
 * call's whole result. The step writes the launch's one
 * `pre_trust` line (`preTrustLogLine`, b.jg5 SRJ-413), then starts the
 * persona's dialog approver (`startDialogApprover`) without awaiting it, so
 * the ladder's result is returned as soon as the launch call returned.
 * The client returns the parsed reply as is, so a `null` or missing result
 * is read as one with no `pre_trust` field. Nothing here or after it reads
 * the `pre_trust` value. Never throws.
 */
function afterLaunchSucceeded(
  key: string,
  isStartup: boolean,
  ref: string,
  verb: LaunchVerb,
  launched: Phase1SpawnResult | Phase1ResumeResult,
): void {
  console.error(preTrustLogLine(ref, verb, launched?.pre_trust))
  try {
    startDialogApprover(key, isStartup, ref)
  } catch (err) {
    // Not reached: the start entry never throws.
    console.error(approverLogLine(approverFailedMessage(ref, describeThrownValue(err))))
  }
}

/**
 * Resolves once the launch in flight for persona `key` (if any) has settled,
 * whatever its outcome; at once when none is. Never rejects and starts
 * nothing. For a teardown (b.av2 SR-6.6), which must not kill or delete the
 * row while a launch is still bringing it up; launches that run outside the
 * lifecycle serializer (the start pass) are covered too. The launch's dialog
 * approver is not waited for: a launch settles as its launch call returns,
 * and the teardown stops the approver first (`stopDialogApprover`, b.jg5
 * SRJ-404, SRJ-715).
 */
export async function whenLaunchSettled(key: string): Promise<void> {
  const inFlight = inFlightLaunches.get(key)
  if (inFlight === undefined) return
  try {
    await inFlight
  } catch {
    /* the launch's own caller handles its outcome */
  }
}

/**
 * Core per-persona spawn dispatcher (SR-1.4), addressing `cscb_<key>`:
 *
 * 0. The live-row sequence gate (b.jg5 SRJ-706): while a live-row sequence
 *    runs for the persona (`isLiveRowSequenceRunning`) and it is not
 *    latched, the call answers `sequence-waiting` before any other step,
 *    joining no launch in flight (the sequence's own step-6 launch
 *    included), with one log line: no agent-director call, no trust patch,
 *    no reply-guard step, no record written, nothing armed. The sequence's
 *    own launch (`launchForLiveRowSequence`) does not come through here and
 *    is exempt. A latched persona goes on to the latched gate.
 * 1. One in-flight launch per persona (b.av2 SR-6.3): while a launch for the
 *    key is in flight, a second call joins it and receives its result instead
 *    of starting a second ladder. The start's worker pool and the restart
 *    module's `launchSession` both come through here. Keys are independent.
 * 1a. The latched gate (b.jg5 SRJ-502): a persona the installed latch
 *    (`setConflictLatch`) holds latched answers `latched` before any other
 *    step, with one log line naming its case, and nothing else runs. A call
 *    joining a launch already in flight still gets that launch's result.
 * 2. Pre-launch claude_config_dir check (bug b.g57, `checkLaunchConfigDir`),
 *    dry run included: when the directory cannot be resolved to a real path,
 *    nothing else runs (no trust patch, no reply-guard step, no
 *    agent-director call, no record written); the failure goes to the
 *    installed hook (the bring-up controller holds the persona `retrying`)
 *    and the result is `deferred`. Otherwise its real path gives the spawn's
 *    `config_dir` label.
 * 3. Dry-run: skip the rest, return synthetic success.
 * 4. Run the installed pre-launch trust patcher for the persona (b.av2
 *    SR-6.2) once, before any spawn or resume the ladder makes.
 *    Then attempt `client.spawn(...)`: a plain first spawn from
 *    `buildSpawnParams`, with no reuse flag (b.jg5 SRJ-711), so a key whose
 *    row is already there collides and step 5's `get` and `resume` keep its
 *    conversation; only the reuse launch adds the flag, and the only first
 *    launch that is a reuse is a retired key's (SRJ-805). On success → done. Every spawn and
 *    resume below is immediately preceded by the installed pre-launch reply
 *    guard (b.av2 SR-9.4); the optimistic spawn undoes its reply-guard steps
 *    on `ErrInstanceIdCollision`: the record and launched-with dir are
 *    restored while still its own, and the hook is re-evaluated.
 * 5. `ErrInstanceIdCollision` → `client.get(...)`, the shared own-row read
 *    (`readPersonaOwnRow`, b.jg5 SRJ-114), then:
 *    - the note check comes first, before the guards and the state branches:
 *      a read that latched the persona (its own row carries the
 *      `provenance_conflict` note and it is configured) answers `latched` at
 *      once, whatever the row's state, `cwd` or `config_dir` label: no wait,
 *      sweep, reconnect, sequence or launch, no notice, nothing counted
 *      (b.jg5 SRJ-501, SRJ-502). Any other note, or none, goes on below.
 *      `ErrSpawnNotFound` retries the plain spawn once; any other error takes
 *      the refusal row (`refusalAt`);
 *    - the row's `cwd` differs from the persona's working_directory by real
 *      path (`compareRowToPersona`) → the replace step, whatever the state
 *      and resume_enabled (b.av2 SR-6.2 as amended, b.jg5 SRJ-1503: "An
 *      existing row whose `cwd` differs from the persona's working
 *      directory, by real path, is replaced on every ladder path with no row
 *      deleted: a live row goes through the live-row sequence (b.jg5
 *      SRJ-705), then a reuse spawn; a finished row gets a reuse spawn (b.jg5
 *      SRJ-707)."). When the working directory
 *      cannot be resolved to a real path at that moment and the row's `cwd`
 *      has none either (`cwdCheckDeferred`), the row is kept instead: no
 *      replacement, `cwd-unreachable` raised and `failed` returned
 *      (b.av2 SR-6.4). Otherwise branch on state:
 *    - ended/missing + resume_enabled → resume; on ErrNoSessionId/
 *      ErrJsonlMissing/ErrJsonlNeverWritten → the no-transcript step: after
 *      ErrJsonlMissing the lost-transcript diagnosis, then one reuse spawn
 *      of the same id through the replace step's finished-row branch;
 *      nothing is deleted (`noTranscriptReuse`, `reuseFinishedRow`); on
 *      ErrSpawnNotResumable → a lost race (b.jg5 SRJ-710): nothing killed,
 *      deleted or launched, the retry timer armed with the lost-race cause,
 *      the uncounted refused result.
 *    - ended/missing + !resume_enabled → the replace step: a reuse spawn of
 *      the same id.
 *    - waiting → the reconnect (`reconnectMcpWithCause`, one `send-keys`,
 *      b.jg5 SRJ-118); 'dead-session', whatever its cause → the find-missing
 *      run, then resume/fresh-spawn (b.3ce), whose resume or spawn decides
 *      what holds the persona's name; 'transient' → `latched` for a latched
 *      persona, otherwise the uncounted refused result (`failed` with the
 *      refusal marker): no spawn-failure notice, no `spawn-failed` entry,
 *      nothing counted.
 *    - working → waitForWaitingAndReconnect; its outcome is mapped as the
 *      `waiting` branch maps the reconnect's ('dead-session' and
 *      'transient'); 'not-reconnected' or 'cancelled' (its teardown cancelled
 *      the wait) → `not-reconnected` (b.f2b: nothing was typed;
 *      `reconnected` only when `/mcp reconnect` was). `hooks.onWorkingRowWait`
 *      is called as the wait starts (b.f2b).
 *    - check_permission/ask_user → never typed into; one one-line
 *      `read-pane` of the persona's own row through the shared reader first
 *      (b.jdc, b.jg5 SRJ-607, `launchOnPromptRow`), with no tmux call: a
 *      pane, UNAVAILABLE, CONFIG, UNCLASSIFIED or ENVIRONMENT → no-op; GONE
 *      or the row absent (`ErrSpawnNotFound`) → findMissing sweep and a
 *      re-read, and a row now `ended` or `missing` → resume/fresh-spawn
 *      (otherwise no-op); CONFLICT or UNUSABLE NAME (the reader latched the
 *      persona) → `latched`.
 *    - pending → no-op when its `config_dir` label matches; a label missing
 *      or different (b.jg5 SRJ-411, SRJ-707) means the row is not covered,
 *      and the replace step sends it through the live-row sequence.
 *    Every resume first checks the row's `config_dir` label; a missing or
 *    different label means the replace step instead (resumeOrFreshSpawn;
 *    b.av2 SR-6.2 as amended, b.jg5 SRJ-1504).
 *    A directory that stopped resolving since step 2 keeps the row and
 *    returns `deferred` instead.
 *    The replace step (`replacePersonaRow`, b.jg5 SRJ-707) decides on the
 *    row state the path last read: `ended`, `missing` or no row → one reuse
 *    spawn of the same id (`reuseSpawnForPersona`); its collision re-runs
 *    this step 5 once, and a second collision arms the reuse-collision
 *    cause and answers the uncounted refused result; any live state,
 *    `pending` included → the live-row sequence is started (SRJ-705,
 *    SRJ-706) and the launch answers `sequence-waiting` with no other call.
 *    Nothing in step 5 deletes or kills a row.
 * 6. A CONFLICT at any spawn or resume above latches the persona and
 *    answers `latched` (b.jg5 SRJ-501, `conflictAt`); other errors → surface
 *    to Slack + (when isStartup) startup-errors.log, except a refusal. An
 *    `ErrTmuxSessionCreate` (LAUNCH FAILURE, by name) at any of them is one
 *    counted launch failure (b.jg5 SRJ-602; `plainSpawnFailedAt`,
 *    `resumeFailedAt`): the notice, a `spawn-failed` entry at start, and
 *    `failed` marked `countedClass`; nothing is killed because of it, no
 *    spawn is made in its place, and the persona's retry timer is armed at
 *    once in pending-only mode (`launchFailureResult`; SRJ-301, SRJ-409).
 * 7. Steps 4 to 6 run as a launch attempt for the key (b.jg5 SRJ-301,
 *    `runInAttempt`): an agent-director error there that the arming predicate
 *    answers a cause for arms the persona's retry timer through the installed
 *    trigger sink, and a `failed` result whose attempt's last agent-director
 *    error armed it carries the refusal marker (`refused`). A joining call,
 *    the latched gate, the claude_config_dir deferral and dry run are no
 *    attempt.
 * 8. Every spawn or resume above that returns success is followed by one
 *    after-launch step (`afterLaunchSucceeded`), which starts the persona's
 *    dialog approver in its own registry (`startDialogApprover`, b.jg5
 *    SRJ-401) without awaiting it: the result is returned as soon as the
 *    launch call returns, and the launch is no longer in flight
 *    (`isLaunchInFlight`) while the approver runs. The approver runs outside
 *    the launch attempt. No other branch, result or dry run starts one.
 *
 * `hooks` belong to the ladder this call starts; a call that joins a launch
 * already in flight gets none of them.
 */
export async function spawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  isStartup = true,
  hooks?: LaunchHooks,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const ref = personaRef(persona)
  // b.jg5 SRJ-706: while P's live-row sequence runs (its own step-6 launch in
  // flight included), no other launch for P starts or joins one: no
  // agent-director call, no trust patch, no reply-guard step, no record.
  // A latched persona still gets the latched gate's answer.
  const sequenceWaiting = sequenceWaitingResult(key, ref, 'spawnForPersona')
  if (sequenceWaiting !== undefined) return sequenceWaiting
  const inFlight = inFlightLaunches.get(key)
  if (inFlight) {
    console.error(`[slack] spawnForPersona: launch already in flight for ${ref} — joining it`)
    return inFlight
  }

  // b.jg5 SRJ-502: a latched persona is not launched, whoever asks (the start
  // pass, the bring-up controller, an apply's bring-up, a restart, a retry):
  // no trust patch, no reply-guard step, no config-dir hold and no
  // agent-director call. A latch that cannot be read counts as latched.
  const latched = latchGateReadingOf(key)
  if (latched !== undefined) {
    const why = latched.failure === undefined ? 'it is latched' : `${latched.failure} — taken as latched`
    console.error(
      `[slack] spawnForPersona: not launching ${ref} — ${why} (case=${latched.latchCase}); no agent-director call (b.jg5 SRJ-502)`,
    )
    return { key, action: 'latched' }
  }

  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }

  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping spawn for ${ref} cwd=${persona.working_directory}`)
    return { key, action: 'no-op' }
  }

  const configDirLabel = configDirLabelValue(configDir.realPath, spawnHomeDir())
  // b.f2b: the restart path's idle evidence for an earlier `working` row says
  // nothing about the session this launch brings up (and must not let the
  // health check skip its two-tick guard while it boots), and the launch's own
  // wait, if any, starts its own run of deferrals on the row. b.jdc: nor does
  // its run of deferrals on a row waiting on a prompt.
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  endPromptRowDeferral(key)
  // b.jg5 SRJ-301: the ladder is a launch attempt; joiners get its result, marker included.
  const launch = runInAttempt(key, 'launch', async (attempt) =>
    markRefusal(await runPersonaLadder(persona, config, isStartup, ref, configDirLabel, hooks), attempt),
  )
  inFlightLaunches.set(key, launch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === launch) {
      inFlightLaunches.delete(key)
      // b.f2b: a teardown's cancel of this launch's wait ends with it, and
      // (b.jg5 SRJ-404) so does a stop of the approver it had not started.
      cancelledLaunchWaits.delete(key)
      cancelledComingApprovers.delete(key)
    }
  }
}

/**
 * `result`, with the refusal marker when it is `failed` and the launch
 * attempt's last agent-director error armed the persona's retry timer (b.jg5
 * SRJ-301). Any other result is returned as it is.
 */
function markRefusal(result: SpawnPersonaResult, attempt: AttemptView): SpawnPersonaResult {
  if (result.action !== 'failed' || result.refused || attempt.lastError?.armed !== true) return result
  return { ...result, refused: true }
}

/** What the ladder answered for a `transient` reconnect (`transientReconnectResult`). */
export type TransientReconnectAnswer = 'latched' | 'refused' | 'stopping'

/**
 * The ladder's one line for a `transient` reconnect at its `waiting` or
 * `working` branch (`state`), with what it answered (b.jg5 SRJ-118, SRJ-609).
 */
export function transientReconnectLine(ref: string, state: string, answer: TransientReconnectAnswer): string {
  const what =
    answer === 'latched'
      ? 'the persona is latched — answering latched'
      : answer === 'stopping'
        ? 'a version re-check decided that the server stops — answering failed, marked stopping'
        : 'answering the uncounted refused result'
  return `[slack] spawnForPersona: the reconnect for ${ref} (state=${state}) was transient: nothing was typed; ${what}; no spawn-failure notice, no spawn-failed entry, nothing counted (b.jg5 SRJ-118)`
}

/**
 * The ladder's result for a `transient` reconnect at its `waiting` or
 * `working` branch (b.jg5 SRJ-118, SRJ-609): a `failed` result marked
 * `stopping` when a version re-check decided the stop (b.jg5 SRJ-205);
 * `latched` when the reconnect latched the persona or found it latched, or
 * the latched query (`personaLatchedNow`, b.jg5 SRJ-502) answers it latched;
 * otherwise the uncounted refused result (`failed` with the refusal marker,
 * which `launchSession` answers as `'refused'` and the restart path never
 * counts). No spawn-failure notice, no `spawn-failed` entry, nothing counted,
 * and nothing more is called. One line (`transientReconnectLine`).
 */
function transientReconnectResult(
  key: string,
  ref: string,
  state: string,
  transient: { latched?: true; stopping?: true },
): SpawnPersonaResult {
  if (transient.stopping) {
    console.error(transientReconnectLine(ref, state, 'stopping'))
    return { key, action: 'failed', stopping: true }
  }
  if (transient.latched || personaLatchedNow(key)) {
    console.error(transientReconnectLine(ref, state, 'latched'))
    return { key, action: 'latched' }
  }
  console.error(transientReconnectLine(ref, state, 'refused'))
  return { key, action: 'failed', refused: true }
}

/** A caller's view into the collision ladder one `spawnForPersona` call starts (b.f2b). */
export interface LaunchHooks {
  /**
   * Called once, as the ladder starts waiting for a `working` row to settle
   * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
   * start pass stops waiting for the launch here and lets it finish in the
   * background; the launch stays in flight until it settles. Must not throw.
   */
  onWorkingRowWait?: () => void
}

/** One collision ladder for a persona; `spawnForPersona` single-flights it per key. */
async function runPersonaLadder(
  persona: Persona,
  config: PersonaConfig,
  isStartup: boolean,
  ref: string,
  configDirLabel: string,
  hooks: LaunchHooks | undefined,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const params = buildSpawnParams(persona, config, configDirLabel)

  // b.av2 SR-6.2: the trust patch precedes every launch. Running it once here,
  // before the first agent-director spawn or resume this ladder can make,
  // covers every path below (the patch is idempotent).
  runPreLaunchTrustPatch(persona, ref)

  // Attempt fresh spawn ---
  // b.jg5 SRJ-711: the first spawn is plain (`buildSpawnParams`, no reuse
  // flag), so a key whose row is already there collides and goes on to the
  // collision `get` and `resume` below, which keep the conversation. Only the
  // reuse launch adds the flag; the only first launch that is a reuse is a
  // retired key's (SRJ-805).
  // b.av2 SR-9.4: the reply-guard steps run immediately before every spawn or
  // resume, never on a path that only reconnects to a live instance or does
  // nothing. This optimistic spawn is a launch only when no row exists; a
  // collision means an instance already exists, so its steps are undone (the
  // record and launched-with dir restored while still this step's own, and
  // the hook re-evaluated against the persona's current config) and any later
  // spawn or resume below runs them again.
  let replyGuardUndo: ReplyGuardUndo | undefined
  try {
    replyGuardUndo = runPreLaunchReplyGuard(persona, ref)
    const r: Phase1SpawnResult = await withSpawnDetection(key, persona.working_directory, 'spawn', (client) => client.spawn(params))
    console.error(`[slack] spawnForPersona: spawned ${ref} instanceId=${r.claude_instance_id}`)
    afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_SPAWN, r)
    return { key, action: 'spawned' }
  } catch (err) {
    if (err instanceof ErrInstanceIdCollision) {
      // Collision → fall through to get-then-act
      undoPreLaunchReplyGuard(replyGuardUndo, ref)
      console.error(`[slack] spawnForPersona: ErrInstanceIdCollision for ${ref} — fetching current state`)
    } else {
      // b.jg5 SRJ-111: a CONFLICT (the pre-spawn scan's, or one after
      // "duplicate session") latches the persona with the refused operation
      // "plain spawn"; nothing of the row was read before this first spawn,
      // so the latch-time `status` read gives its state. An
      // `ErrTmuxSessionCreate` (by name) is one counted launch failure:
      // nothing is killed and no spawn is made in its place, and the
      // persona's retry timer is armed at once in pending-only mode
      // (b.jg5 SRJ-602, SRJ-713, SRJ-409).
      return plainSpawnFailedAt(key, err, isStartup, ref, 'spawn', NOTHING_READ)
    }
  }

  return ladderGetThenAct({ persona, config, isStartup, ref, params, hooks, reuseCollisionRerun: false })
}

/**
 * The collision ladder's get-then-act (b.jg5 SRJ-114, SRJ-112): the
 * collision `get`, then the `cwd` guard and the state branches, as
 * `spawnForPersona`'s step 5 lists them. Entered once after the first
 * spawn's collision, and once more when a reuse spawn of the replace step's
 * finished-row branch collides (`run.reuseCollisionRerun`, `reuseFinishedRow`).
 * Never throws.
 */
async function ladderGetThenAct(run: LadderRun): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref, params, hooks } = run
  const { key } = persona
  // Collision-handling: get-then-act ---
  // b.jg5 SRJ-114: the collision `get` is the shared own-row read. A read
  // that latched the persona (its own row reading `pending` with no launch
  // start, b.jg5 SRJ-513, whatever its `cwd`, or a `provenance_conflict`
  // note on it) ends the ladder here, before the `cwd` and `config_dir` guards and the
  // state branches: no wait, sweep, reconnect, sequence or launch, no
  // notice, nothing counted (b.jg5 SRJ-501, SRJ-502).
  const collisionRead = await readPersonaOwnRow(key, { site: 'spawnForPersona', what: 'collision get', ref })
  // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latched the persona: no
  // retry spawn, sequence or launch, no notice, nothing counted.
  if (collisionRead.kind === OWN_ROW_READ_LATCHED) return { key, action: 'latched' }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched
  // elsewhere meanwhile (the health tick's liveness read, SRJ-315): no retry
  // spawn, wait, resume, sequence or launch follows.
  if (latchedAfterOwnRowRead(key, 'spawnForPersona', 'collision get', ref)) return { key, action: 'latched' }
  if (collisionRead.kind !== OWN_ROW_READ_ROW) {
    if (collisionRead.kind === OWN_ROW_READ_ABSENT) {
      // Race: row deleted between spawn-collision and get. Retry spawn once.
      console.error(`[slack] spawnForPersona: ErrSpawnNotFound after collision for ${ref} — retrying spawn (single retry)`)
      try {
        const r: Phase1SpawnResult = await launchWithReplyGuard(persona, ref, 'spawn', (client) => client.spawn(params))
        console.error(`[slack] spawnForPersona: retry-spawn succeeded for ${ref} instanceId=${r.claude_instance_id}`)
        afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_SPAWN, r)
        return { key, action: 'spawned' }
      } catch (err2) {
        // b.jg5 SRJ-501: the collision `get` read no row.
        return plainSpawnFailedAt(key, err2, isStartup, ref, 'retry-spawn', LATCH_ROW_STATE_NO_ROW)
      }
    }
    // b.jg5 SRJ-105, SRJ-311, SRJ-313, SRJ-316: a read error is a refusal,
    // an ENVIRONMENT, a CONFIG and an UNCLASSIFIED answer
    // (`ErrSystemInstallDisappeared` too) included.
    const err = collisionRead.error
    const refused = refusalAt(key, err, 'get', 'spawnForPersona', 'collision get', ref)
    if (refused) return refused
    // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME
    // is a refusal. Any other ends the ladder 'failed': no spawn-failure
    // notice, no `spawn-failed` entry (b.jg5 SRJ-105).
    console.error(`[slack] spawnForPersona: collision get failed for ${ref}: ${describeAgentDirectorFailure(err)} — nothing more is called`)
    return { key, action: 'failed' }
  }
  if (collisionRead.latched) return { key, action: 'latched' }
  const { row } = collisionRead

  const { state } = row
  console.error(`[slack] spawnForPersona: collision resolved, state=${state} for ${ref}`)
  // b.jg5 SRJ-501: the collision `get` is the path's last read until a later
  // read replaces it (the working-row wait's, the prompt row's re-read).
  const lastRead = latchRowStateRead(state)

  // b.av2 SR-6.2 as amended (b.jg5 SRJ-1503): a row in another directory (by
  // real path) is never resumed, reconnected or waited on, whatever its state
  // and resume_enabled: it is replaced with no row deleted, a live row
  // through the live-row sequence, then a reuse spawn; a finished row by a
  // reuse spawn (the replace step, b.jg5 SRJ-707).
  const comparison = compareRowToPersona(row, persona, spawnHomeDir())
  if (!comparison.cwdMatches) {
    if (comparison.cwdCheckDeferred) {
      // b.av2 SR-6.4: neither the working directory nor the row's cwd has a
      // real path right now, so the row cannot be shown to be in another
      // directory. Keep it (its instance and history) and fail the launch as a
      // spawn in a missing directory would: the cwd-unreachable notice, then
      // restart recovery. A row whose cwd resolves to an existing directory is
      // not deferred and is replaced below.
      console.error(
        `[slack] spawnForPersona: ${ref} working_directory=${persona.working_directory} cannot be resolved to a real path — ` +
          `keeping its row (cwd=${row.cwd || '<none>'}, state=${state}); the launch fails and is retried by the restart path`,
      )
      setOutageFlag(key, 'cwd-unreachable', persona.working_directory)
      return { key, action: 'failed' }
    }
    console.error(
      `[slack] spawnForPersona: ${ref} row cwd=${row.cwd || '<none>'} differs from working_directory=${persona.working_directory} (state=${state}) — replacing the row by a reuse spawn of the same id; nothing is deleted`,
    )
    return replacePersonaRow(run, lastRead, CWD_MISMATCH_WHY)
  }

  if (state === 'ended' || state === 'missing') {
    return resumeOrFreshSpawn(run, row, { lastRead })
  }

  if (state === 'waiting') {
    // b.jg5 SRJ-118: one `send-keys`, never retried, with the collision
    // `get`'s `waiting` as its last read. A 'dead-session' answer, whatever
    // its cause (a GONE `send-keys`, a refusal as not interactive, or no
    // row), takes the find-missing run and then resume/fresh-spawn, whose
    // resume or spawn decides what holds the persona's name (b.3ce, b.dup):
    // none of those causes is taken as proof that the worker is gone
    // (SRJ-609). A 'transient' answer types nothing and counts nothing.
    const result = await reconnectMcpWithCause(key, lastRead, ref)
    if (result.outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead session for ${ref} (state=waiting) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(run, row, { reconcileMissingFirst: true, lastRead })
    }
    if (result.outcome === 'transient') return transientReconnectResult(key, ref, state, result)
    return { key, action: 'reconnected' }
  }

  if (state === 'working') {
    // b.3ce/b.ecw, b.jg5 SRJ-118: the same mapping as the `waiting` branch.
    // waitForWaitingAndReconnect returns 'ok' once it typed `/mcp reconnect`;
    // 'not-reconnected' (b.f2b) on live transient transitions, whenever the
    // row reads live at the deadline (a long turn isn't an error), and when
    // the timeout `status` read fails (b.jg5 SRJ-605); 'dead-session' when
    // the row reads ended or missing (or the timeout sweep + status verdict
    // says so, b.ecw), when its reconnect answered 'dead-session' (any
    // cause), or when the row is absent (`ErrSpawnNotFound`, b.jg5
    // SRJ-605): the recovery's resume or spawn then decides what holds the
    // name; 'transient' when its reconnect was 'transient' or its findMissing
    // sweep was refused: nothing typed, nothing counted.
    // b.f2b: the wait can take up to WAIT_FOR_WAITING_TIMEOUT_MS; tell the
    // caller (the start pass lets the launch go on in the background).
    hooks?.onWorkingRowWait?.()
    const { outcome, latched, stopping, lastRead: waitRead } = await waitForWaitingAndReconnectWithCause(key, config, ref)
    // b.jg5 SRJ-502, SRJ-608: the persona latched during the wait (a CONFLICT
    // or UNUSABLE NAME at a read, a note its transcript `get` read, or a
    // latch set elsewhere): nothing more for it.
    if (outcome === WAIT_OUTCOME_LATCHED) return { key, action: 'latched' }
    // b.jg5 SRJ-205: the evidence read's version re-check decided the stop:
    // no post, no `spawn-failed` entry, nothing counted (as at a resume).
    if (stopping) return { key, action: 'failed', stopping: true }
    if (outcome === 'dead-session') {
      console.error(`[slack] spawnForPersona: dead session for ${ref} (state=working) — recovering via resume/fresh-spawn`)
      return resumeOrFreshSpawn(run, row, {
        reconcileMissingFirst: true,
        lastRead: waitRead ?? lastRead,
      })
    }
    // b.f2b: report the real outcome, not `reconnected`. A wait its persona's
    // teardown cancelled typed nothing either, and its session is left to
    // the teardown.
    if (outcome === 'not-reconnected' || outcome === 'cancelled') return { key, action: 'not-reconnected' }
    // b.jg5 SRJ-118: a 'transient' wait (its reconnect's, or a refused
    // findMissing sweep's) types nothing and counts nothing. A `status`
    // error in the wait never gets here (b.jg5 SRJ-605).
    if (outcome === 'transient') return transientReconnectResult(key, ref, state, latched ? { latched } : {})
    return { key, action: 'reconnected' }
  }

  if (PROMPT_ROW_STATES.has(state)) {
    // b.jdc: never typed into (b.rmy), but its session may be gone.
    return launchOnPromptRow(run, row, state)
  }

  if (state === 'pending') {
    // b.jg5 SRJ-513: a configured persona's own `pending` row with no launch
    // start never reaches here: the collision `get` latched it first.
    // b.jg5 SRJ-411, SRJ-707, SRJ-1504: a `pending` row whose `config_dir`
    // label is missing or differs is not P's current life, so it is not
    // covered: the replace step sends it through the live-row sequence,
    // which waits until G past its launch start and ends in a reuse spawn of
    // the same id. A directory that cannot be resolved gives no verdict and
    // keeps the deferral (bug b.g57). A matching row is left as it is.
    const configDir = compareRowToPersona(row, persona, spawnHomeDir(), undefined, _configDirFs)
    if (!configDir.configDirResolved) return deferForUnresolvedConfigDir(persona, ref)
    if (!configDir.configDirMatches) {
      console.error(`[slack] spawnForPersona: ${configDirMismatchText(persona, ref, configDir)} on a pending row — not covered; replacing its row by a reuse spawn of the same id`)
      return replacePersonaRow(run, lastRead, CONFIG_DIR_MISMATCH_WHY)
    }
    console.error(`[slack] spawnForPersona: no action — state=${state} for ${ref}`)
    return { key, action: 'no-op' }
  }

  console.error(`[slack] spawnForPersona: unexpected state=${state} for ${ref} — no action`)
  return { key, action: 'no-op' }
}

// ---------------------------------------------------------------------------
// The reuse spawn (b.jg5 SRJ-112, SRJ-708)
// ---------------------------------------------------------------------------

/** The prefix of the reuse spawn's own lines. */
const REUSE_SPAWN_SITE = 'reuseSpawnForPersona'

/** What the reuse spawn's lines call the call. */
const REUSE_SPAWN_WHAT = 'reuse spawn'

/**
 * The reuse spawn's answer to `ErrInstanceIdCollision` (b.jg5 SRJ-112): the
 * row is live (a launch in progress included), so nothing was launched. Not
 * a launch result: no notice, no entry, nothing counted and nothing armed by
 * the reuse itself. Its caller decides what follows: the live-row sequence
 * ends without its launch and arms the reuse-collision cause; a collision
 * ladder reuse site re-runs get-then-act once, and a second collision arms
 * that cause and ends the attempt (`reuseFinishedRow`).
 */
export const REUSE_SPAWN_COLLIDED = 'reuse-collided'

/** The reuse spawn's collided answer (`REUSE_SPAWN_COLLIDED`). */
export interface ReuseSpawnCollided {
  readonly key: string
  readonly action: typeof REUSE_SPAWN_COLLIDED
}

/**
 * What the reuse spawn answers: a launch result, or the collided answer.
 * The collided answer's action is none of `SpawnPersonaResult`'s, so a
 * caller must tell it apart (`isReuseSpawnCollided`) before it can pass the
 * answer on as a launch result: no caller can count a collision by mistake.
 */
export type ReuseSpawnResult = SpawnPersonaResult | ReuseSpawnCollided

/** Whether a reuse spawn's answer is its collided answer. */
export function isReuseSpawnCollided(result: ReuseSpawnResult): result is ReuseSpawnCollided {
  return result.action === REUSE_SPAWN_COLLIDED
}

/** What the reuse spawn is told by its caller. */
export interface ReuseSpawnOptions {
  /** Whether the launch is part of the start pass (a `spawn-failed` entry is written only then). */
  readonly isStartup: boolean
  /**
   * The row state the caller last read before the reuse (`LATCH_ROW_STATE_NO_ROW`
   * included): the state a CONFLICT or UNUSABLE NAME latch records (b.jg5
   * SRJ-501). Never re-read here.
   */
  readonly lastRead: LatchRowState
  /**
   * True when the caller has already run the pre-launch trust patch in this
   * launch attempt (the collision ladder at its start; a `resume` that went
   * on to the reuse). Otherwise the reuse runs it once before its call.
   */
  readonly trustPatchRan?: boolean
}

/**
 * The reuse spawn of persona `persona`'s `cscb_<key>` (b.jg5 SRJ-112,
 * SRJ-708): agent-director's `spawn` of the same fixed id with the reuse
 * flag, which brings the persona up fresh on its own id and keeps its row as
 * an earlier life. One launch, called by every reuse site; it runs inside its
 * caller's launch or recovery attempt and opens none of its own, and its
 * caller registers the launch in flight.
 *   - The launch path's `claude_config_dir` check comes first (bug b.g57):
 *     a directory that does not resolve goes to the installed deferral hook
 *     and the answer is `deferred`, with no agent-director call.
 *   - Its parameters are `buildSpawnParams`'s, with only `reuse_finished:
 *     true` added (SRJ-708): the same template, `cwd`, labels and `extra_env`
 *     as any launch of the persona, prompt suggestions off included. No
 *     `no_pre_trust` is ever set (SRJ-413).
 *   - The pre-launch trust patch runs once before the call unless the caller
 *     ran it in this attempt (`options.trustPatchRan`), and the call goes
 *     through `launchWithReplyGuard` (the reply guard immediately before it,
 *     then spawn detection, which reports an error by class).
 *   - A success logs one line naming the reuse spawn and the persona (and,
 *     when `options.lastRead` is no row, that no earlier life is kept: an
 *     ordinary fresh spawn, SRJ-112), then
 *     runs the after-launch step (`afterLaunchSucceeded`: the `pre_trust`
 *     line naming the reuse spawn, SRJ-413, and the dialog approver on the
 *     persona's row, SRJ-401), and answers `spawned`.
 *   - Every failure is handled by SRJ-112's outcome table
 *     (`reuseSpawnFailedAt`).
 * Nothing here calls `delete` or `kill`, sets `include_finished`, makes a
 * second launch or says that a row was deleted. Never throws.
 */
export async function reuseSpawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  options: ReuseSpawnOptions,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  const ref = personaRef(persona)
  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }
  const configDirLabel = configDirLabelValue(configDir.realPath, spawnHomeDir())
  // b.jg5 SRJ-708: one derivation of the parameters; only the flag is added.
  const params: Phase1SpawnParams = { ...buildSpawnParams(persona, config, configDirLabel), reuse_finished: true }
  // b.av2 SR-6.2: the trust patch precedes every launch, once per attempt.
  if (options.trustPatchRan !== true) runPreLaunchTrustPatch(persona, ref)
  let launched: Phase1SpawnResult
  try {
    launched = await launchWithReplyGuard(persona, ref, 'spawn', (client) => client.spawn(params))
  } catch (err) {
    return reuseSpawnFailedAt(persona, err, options.isStartup, ref, options.lastRead)
  }
  // b.jg5 SRJ-112: a reuse of an id with no row is an ordinary fresh spawn; no earlier life is kept.
  const earlierLife =
    options.lastRead === LATCH_ROW_STATE_NO_ROW
      ? 'the id had no row when last read (an ordinary fresh spawn), so no earlier life is kept'
      : 'its row is kept as an earlier life'
  console.error(
    `[slack] ${REUSE_SPAWN_SITE}: reuse-spawned ${ref} instanceId=${personaInstanceId(key)} — a new life on its own id; ${earlierLife} (b.jg5 SRJ-112)`,
  )
  afterLaunchSucceeded(key, options.isStartup, ref, LAUNCH_VERB_REUSE_SPAWN, launched)
  return { key, action: 'spawned' }
}

/**
 * SRJ-112's outcome table for a value the reuse spawn's call threw (b.jg5
 * SRJ-112, SRJ-709, SRJ-105), classified by name (`src/ad-error-class.ts`),
 * with the refused operation "reuse spawn" and `lastRead` as the recorded
 * row state of a latch:
 *   - `ErrInstanceIdCollision`: one line and the collided answer
 *     (`REUSE_SPAWN_COLLIDED`): no notice, no entry, nothing counted; it
 *     never reaches `notifySpawnFailure`;
 *   - `ErrInvalidFlags`: one immediate version re-check (SRJ-204); a stop it
 *     decides answers `failed` marked `stopping`; otherwise SRJ-105's
 *     UNCLASSIFIED row through the outage state's site entry (the retry timer
 *     armed, the unclassified-error episode fed; refused, never counted).
 *     Never another launch;
 *   - CONFLICT (`conflictAt`): the persona latches with the case its
 *     description gives ("another agent-director store" and "conflicting
 *     labels" included) and `lastRead` ("no row" for a reuse of an id with
 *     no row, which the pre-spawn scan refused, writing no row); `latched`;
 *   - UNUSABLE NAME (`unusableNameAt`): latched with the refused operation
 *     none; `latched`;
 *   - UNAVAILABLE (every form, a launch timeout included), ENVIRONMENT,
 *     CONFIG and UNCLASSIFIED (`refusalAt`): one line and `failed`, which the
 *     attempt marks refused: never counted, no notice; the reporting point
 *     has armed the retry timer, started the condition or raised the outage,
 *     and fed the unclassified-error episode, by class;
 *   - LAUNCH FAILURE (`ErrTmuxSessionCreate`): one counted launch failure
 *     (one line, the spawn-failure notice, a `spawn-failed` entry at start,
 *     `failed`), never a kill and never a spawn in its place (SRJ-602); the
 *     persona's retry timer is also armed at once in pending-only mode
 *     (`armPendingOnlyAfterLaunchFailure`; SRJ-301, SRJ-409; HO rev 28),
 *     whatever row the reuse was made over, and the result says so
 *     (`pendingOnlyArmed`); the result is marked `countedClass`;
 *   - DIRECTORY (`ErrCwdNotFound`, `ErrCwdNotADirectory`): `failed`, counted
 *     (marked `countedClass`), the wrapper having raised `cwd-unreachable`;
 *   - any other value (a GONE name, a STATE name the reuse gives no meaning):
 *     SRJ-105's UNCLASSIFIED row, as for `ErrInvalidFlags` after its re-check.
 * Never throws.
 */
async function reuseSpawnFailedAt(
  persona: Persona,
  err: unknown,
  isStartup: boolean,
  ref: string,
  lastRead: LatchRowState,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  if (hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) {
    console.error(
      `[slack] ${REUSE_SPAWN_SITE}: ${describeAgentDirectorFailure(err)} on the ${REUSE_SPAWN_WHAT} of ${ref} — its row is live, so nothing was launched; no spawn-failure notice, nothing counted (b.jg5 SRJ-112)`,
    )
    return { key, action: REUSE_SPAWN_COLLIDED }
  }
  if (isInvalidFlagsError(err)) {
    const step = await classifyWithInvalidFlagsRecheck(err)
    const recheck = `after one immediate agent-director version re-check: ${step.recheck.kind}`
    // The stop posts nothing to Slack, and a launch it ends is not counted.
    if (step.recheck.kind === RECHECK_OUTCOME_STOP) {
      console.error(
        `[slack] ${REUSE_SPAWN_SITE}: ${REUSE_SPAWN_WHAT} failed for ${ref}: ${describeAdErrorClassification(step.classification)} (${recheck}); no other launch`,
      )
      return { key, action: 'failed', stopping: true }
    }
    // b.jg5 SRJ-104, SRJ-105, SRJ-313: UNCLASSIFIED handling; never a
    // fallback to any other launch (SRJ-112).
    reportUnclassifiedAtSite(key, err, 'spawn', step.classification)
    logRefusal(REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref, `${describeAdErrorClassification(step.classification)} (${recheck})`)
    return { key, action: 'failed' }
  }
  const latched =
    (await conflictAt(key, err, REFUSED_OPERATION_REUSE_SPAWN, lastRead, REUSE_SPAWN_WHAT, ref, REUSE_SPAWN_SITE)) ??
    (await unusableNameAt(key, err, lastRead, REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref))
  if (latched) return latched
  const refused = refusalAt(key, err, 'spawn', REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref)
  if (refused) return refused
  const { errorClass } = classifyAdError(err)
  // The class is decided by name above; the `instanceof` check only narrows
  // the type for the describer and the notice.
  if (errorClass === AD_ERROR_CLASS_LAUNCH_FAILURE && err instanceof AgentDirectorError) {
    const described = describeAgentDirectorFailure(err)
    console.error(
      `[slack] ${REUSE_SPAWN_SITE}: ${REUSE_SPAWN_WHAT} failed for ${ref}: ${described} — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-112, SRJ-602)`,
    )
    if (isStartup) recordStartupError('spawn-failed', `${REUSE_SPAWN_WHAT} failed for ${ref}: ${described}`)
    notifySpawnFailure(key, err, isStartup)
    // b.jg5 SRJ-112, SRJ-301, SRJ-409 (HO rev 28): the row may read restored,
    // live, gone or still `pending`; the retry's read decides.
    return launchFailureResult(key)
  }
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the spawn's wrapper; counted.
  if (errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed', countedClass: true }
  // b.jg5 SRJ-104, SRJ-105, SRJ-313: a name the reuse gives no meaning.
  const classification = unclassifiedClassificationOf(err)
  reportUnclassifiedAtSite(key, err, 'spawn', classification)
  logRefusal(REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref, describeAdErrorClassification(classification))
  return { key, action: 'failed' }
}

// ---------------------------------------------------------------------------
// The live-row sequence registry (b.jg5 SRJ-706)
// ---------------------------------------------------------------------------

/** The start entry's answer when no registry is installed: nothing was started. */
export const LIVE_ROW_START_NOT_INSTALLED = 'not-installed'

/** What the session manager's start entry answers: the registry's answer, or that none is installed. */
export type LiveRowSequenceStartEntryAnswer = LiveRowSequenceStartAnswer | typeof LIVE_ROW_START_NOT_INSTALLED

/**
 * The installed live-row sequence registry (`createLiveRowSequenceRegistry`,
 * one per server; production: built in `main()` before the start pass). With
 * none installed (unit tests that install none) no sequence runs: the start
 * entry answers `not-installed` with one line, the running query answers
 * false and a stop does nothing.
 */
let liveRowSequenceRegistry: LiveRowSequenceRegistry | undefined

/** Removes the sequence-stop set observer from the installed latch; undefined while none is registered. */
let removeSequenceLatchObserver: (() => void) | undefined

/**
 * Install the server's live-row sequence registry, or remove it with
 * undefined (b.jg5 SRJ-706). Start sites (the collision ladder's replace
 * step, b.jg5 SRJ-707) reach it through the start entry here
 * (`startLiveRowSequence`). When a latch with `addSetObserver` is
 * installed too, one set observer stops a latched persona's running sequence
 * (`stopSequenceOnLatch`), whichever of the two is installed second.
 */
export function setLiveRowSequenceRegistry(registry: LiveRowSequenceRegistry | undefined): void {
  liveRowSequenceRegistry = registry
  syncSequenceLatchObserver()
}

/** Test-only seam: remove the installed registry and its latch observer (the registry's sequences are not stopped). */
export function _resetLiveRowSequenceRegistry(): void {
  setLiveRowSequenceRegistry(undefined)
}

/**
 * Register the sequence-stop set observer on the installed latch exactly
 * once while both a registry and a latch with `addSetObserver` are
 * installed; remove it otherwise. Called by both installers.
 */
function syncSequenceLatchObserver(): void {
  removeSequenceLatchObserver?.()
  removeSequenceLatchObserver = undefined
  const latch = conflictLatch
  if (liveRowSequenceRegistry !== undefined && latch?.addSetObserver !== undefined) {
    removeSequenceLatchObserver = latch.addSetObserver(stopSequenceOnLatch)
  }
}

/**
 * The latch's set observer for the live-row sequence (b.jg5 SRJ-502,
 * SRJ-706): stops persona `event.key`'s running sequence with the reason
 * `latched`. The stop signal is set synchronously, inside this call, so the
 * sequence makes no call after the one in progress returns. Does nothing
 * when none runs for the persona. Returns nothing to await; never throws.
 */
function stopSequenceOnLatch(event: ConflictLatchSetEvent): void {
  void stopLiveRowSequence(event.key, LIVE_ROW_STOP_LATCHED)
}

/**
 * The start entry (b.jg5 SRJ-706), used by the collision ladder's replace
 * step (`replacePersonaRow`, SRJ-707) and by later starters: forwards `request` to the
 * installed registry and answers its answer (`started`, `already-running`,
 * `closed`); the sequence runs in the background and this never waits for
 * it. A step-2 entry is the same call with the request's entry step 2. With
 * no registry installed: `not-installed`, one line, nothing started. Never
 * throws.
 */
export function startLiveRowSequence(request: LiveRowSequenceRequest): LiveRowSequenceStartEntryAnswer {
  const registry = liveRowSequenceRegistry
  if (registry === undefined) {
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${request.ref ?? `persona=${request.key}`}: no sequence registry is installed — nothing started (b.jg5 SRJ-706)`,
    )
    return LIVE_ROW_START_NOT_INSTALLED
  }
  return registry.start(request)
}

/**
 * True while a live-row sequence runs for persona `key` (b.jg5 SRJ-706):
 * from its start's answer until it settles, its step-6 launch included.
 * False with no registry installed. While it is true every launch path for
 * the persona but the sequence's own launch answers `sequence-waiting` with
 * no agent-director call, it blocks a retry of the persona's retry timer and
 * counts as in flight for the health tick, and a lost message reports
 * `restarting`.
 */
export function isLiveRowSequenceRunning(key: string): boolean {
  return liveRowSequenceRegistry?.isRunning(key) === true
}

/**
 * Stop persona `key`'s running live-row sequence with `reason` (b.jg5
 * SRJ-706: its latch, its teardown) through the installed registry. The stop
 * signal is set before this returns; the promise resolves true once the
 * sequence has settled (its call in flight returned), false at once when
 * none runs or no registry is installed. Never rejects.
 */
export function stopLiveRowSequence(key: string, reason: LiveRowSequenceStopReason): Promise<boolean> {
  return liveRowSequenceRegistry?.stop(key, reason) ?? Promise.resolve(false)
}

/**
 * The live-row sequence gate of the launch paths (b.jg5 SRJ-706): while a
 * sequence runs for persona `key` and the persona is not latched (the
 * latched gate answers for a latched one), log one line and answer the
 * `sequence-waiting` result; otherwise undefined. The sequence's own launch
 * (`launchForLiveRowSequence`) never passes through it.
 */
function sequenceWaitingResult(key: string, ref: string, site: string): SpawnPersonaResult | undefined {
  if (!isLiveRowSequenceRunning(key)) return undefined
  if (latchGateReadingOf(key) !== undefined) return undefined
  console.error(
    `[slack] ${site}: not launching ${ref} — its live-row sequence runs; no agent-director call (sequence-waiting; b.jg5 SRJ-706)`,
  )
  return { key, action: 'sequence-waiting' }
}

// ---------------------------------------------------------------------------
// The live-row sequence's final launch and its dependencies (b.jg5 SRJ-705)
// ---------------------------------------------------------------------------

/** What the sequence-launch entry is asked for. */
export interface LiveRowSequenceLaunchRequest {
  /** Step 6's launch kind (`decideLiveRowLaunchKind`, `src/live-row-sequence.ts`). */
  readonly kind: LiveRowSequenceLaunchKind
  /** The row state the sequence last read (`ended`, `missing` or no row): the state a latch records. */
  readonly lastRead: LatchRowState
  /**
   * The sequence's stop signal (b.jg5 SRJ-706): once it is set (P's latch,
   * its teardown, shutdown), the entry stops waiting for another launch of P
   * and makes no call. Absent: only the latched gate holds the launch back.
   */
  readonly stop?: LiveRowSequenceStopSignal
}

/** The entry's answer when it made no launch: a reuse collision, `ErrSpawnNotResumable`, the sequence stopped. */
export interface LiveRowSequenceNotLaunched {
  readonly key: string
  readonly action: typeof LIVE_ROW_OUTCOME_NOT_LAUNCHED
  readonly reason: LiveRowSequenceNotLaunchedReason
}

/** What the sequence-launch entry answers: the launch's result, or that no launch was made. */
export type LiveRowSequenceLaunchEntryResult = SpawnPersonaResult | LiveRowSequenceNotLaunched

/**
 * The live-row sequence's final launch (b.jg5 SRJ-705 step 6) of persona
 * `persona`'s `cscb_<key>`, of `request.kind`. It is a launch call:
 *   - it waits for any launch still in flight for the persona to settle
 *     (never joining or overlapping it), then registers in the in-flight
 *     map `spawnForPersona` uses, so `isLaunchInFlight` is true and
 *     `whenLaunchSettled` waits for it while it runs (a teardown's wait
 *     covers it, SRJ-715); a call that joins it gets its launch result, a
 *     not-launched answer or any failure that is neither refused nor
 *     stopping reading as the uncounted refused result, so a failure is
 *     counted only here, once and by class;
 *   - once the sequence's stop signal (`request.stop`) is set, it stops
 *     waiting and makes no call (b.jg5 SRJ-706): one line, nothing
 *     registered, and a not-launched answer (`stopped`);
 *   - it is exempt from the `sequence-waiting` gate on the persona's launch
 *     paths (`spawnForPersona`): it is the sequence's own launch, made from
 *     inside it, and never passes through that gate;
 *   - the latched gate, the pre-launch `claude_config_dir` check and dry run
 *     come first, as in `spawnForPersona`; then the launch runs as a launch
 *     attempt for the persona (SRJ-301), the trust patch once before it;
 *   - `resume`: one `resume` of the id through the ladder's launch helper
 *     (`launchWithReplyGuard`: the reply guard, spawn detection, arming by
 *     class). `ErrNoSessionId`, `ErrJsonlMissing` and `ErrJsonlNeverWritten`
 *     (by name) go on to the no-transcript step (`noTranscriptReuse`,
 *     SRJ-707, SRJ-712): after `ErrJsonlMissing` the lost-transcript
 *     diagnosis first (a latched or refused diagnosis read ends the launch
 *     with no reuse), then the reuse spawn once with the row state last read
 *     (the diagnosis's read when it made one); its success answers
 *     `fresh-after-amnesia` or `fresh-after-inconclusive-amnesia` after
 *     `ErrJsonlMissing` and `spawned` otherwise, and its collision answers
 *     not launched as the `reuse` kind's does; `ErrSpawnNotResumable`
 *     answers not launched (SRJ-710: no second sequence); an
 *     `ErrTmuxSessionCreate` (by class) is a counted launch failure that also
 *     arms the persona's retry timer at once in pending-only mode, through
 *     the shared `resumeFailedAt` (SRJ-113, SRJ-409), and a DIRECTORY error
 *     is a counted launch failure; any other
 *     non-success ends by class (`resumeFailedAt`: a CONFLICT or UNUSABLE
 *     NAME latches with `request.lastRead`; `ErrSpawnNotFound` gets the
 *     spawn-failure notice and is not counted) with no further call: no
 *     delete, no kill and no fresh spawn;
 *   - `reuse`: the reuse spawn (`reuseSpawnForPersona`) with
 *     `request.lastRead`, its outcomes SRJ-112's. Its collision answers not
 *     launched (`reuse-collision`): no further launch, nothing counted, no
 *     notice; the sequence ends without its launch and arms the persona's
 *     retry timer with the reuse-collision cause (SRJ-112, SRJ-705, SRJ-706);
 *   - a success runs the after-launch step (`afterLaunchSucceeded`: the
 *     `pre_trust` line and the dialog approver); any other result ends the
 *     sequence without its launch (`runLiveRowSequence` arms by its rule,
 *     SRJ-301).
 * The launch's result is counted once here, as the restart path counts a
 * launch's result (`recordLaunchResultOutsideRestartWork`, b.jg5 SRJ-112,
 * SRJ-113, SRJ-602), by class: a success resets the persona's failure
 * count, and a `failed` result that is neither refused nor stopping and
 * whose class is LAUNCH FAILURE (`ErrTmuxSessionCreate`) or DIRECTORY
 * (`ErrCwdNotFound`, `ErrCwdNotADirectory`), marked `countedClass` where
 * that class is handled, is one counted launch failure; any other `failed`
 * result (a `resume`'s `ErrSpawnNotFound`, which still posts the
 * spawn-failure notice, for one) and a refused, stopping, latched, deferred
 * or not-launched answer record nothing.
 * The launch is never part of the start pass, whichever path started the
 * sequence (a start-pass collision ladder's replacement site included): the
 * sequence runs detached, after its starter has answered `sequence-waiting`
 * and the start pass has counted that (b.jg5 SRJ-706, SRJ-1015), so every
 * call here passes the start flag false. No `spawn-failed`,
 * `jsonl-transcript-lost-on-resume` or `jsonl-diagnosis-inconclusive`
 * startup-errors entry is written for it; its log lines and persona notices
 * are written as for any launch outside the start pass.
 * Never calls `delete` and never sets `include_finished`. Never throws.
 */
export async function launchForLiveRowSequence(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  const ref = personaRef(persona)
  if (inFlightLaunches.has(key)) {
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} a launch for ${ref} is in flight — the sequence's launch waits for it to settle (b.jg5 SRJ-705, SRJ-706)`,
    )
  }
  while (inFlightLaunches.has(key) && request.stop?.reason === undefined) await whenLaunchSettledOrStopped(key, request.stop)
  // b.jg5 SRJ-706: a sequence stopped meanwhile (its teardown, shutdown, the
  // latch) makes no call; nothing is registered as in flight.
  const stoppedFor = request.stop?.reason
  if (stoppedFor !== undefined) {
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} not launching ${ref} — the sequence was stopped (${stoppedFor}); no agent-director call (b.jg5 SRJ-706)`,
    )
    return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_STOPPED }
  }
  const launch = sequenceLaunchAttempt(persona, config, request, ref)
  // A call that joins this launch gets a launch result; no launch, and any
  // failure neither refused nor stopping, read as the uncounted refused one.
  const asLaunch: Promise<SpawnPersonaResult> = launch.then((result) => {
    if (result.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED) return { key, action: 'failed', refused: true }
    return isUnrefusedFailure(result) ? { ...result, refused: true } : result
  })
  inFlightLaunches.set(key, asLaunch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === asLaunch) {
      inFlightLaunches.delete(key)
      cancelledLaunchWaits.delete(key)
      cancelledComingApprovers.delete(key)
    }
  }
}

/**
 * Resolves once the launch in flight for persona `key` has settled, or once
 * `stop` is set, whichever comes first; at once when neither is pending.
 * Never rejects.
 */
function whenLaunchSettledOrStopped(key: string, stop: LiveRowSequenceStopSignal | undefined): Promise<void> {
  if (stop === undefined) return whenLaunchSettled(key)
  return new Promise<void>((resolve) => {
    const unsubscribe = stop.onStop(() => resolve())
    void whenLaunchSettled(key).then(() => {
      unsubscribe()
      resolve()
    })
  })
}

/** Whether `result` is `failed`, neither refused nor stopping. */
function isUnrefusedFailure(result: SpawnPersonaResult): boolean {
  return result.action === 'failed' && result.refused !== true && result.stopping !== true
}

/**
 * Whether the entry counts `result` as a launch failure (b.jg5 SRJ-112,
 * SRJ-113): `failed`, neither refused nor stopping, and marked `countedClass`
 * (its class is LAUNCH FAILURE or DIRECTORY).
 */
function sequenceLaunchCounted(result: SpawnPersonaResult): boolean {
  return isUnrefusedFailure(result) && result.countedClass === true
}

/** The sequence launch's gates, then its call as a launch attempt for the persona, then its count. Never throws. */
async function sequenceLaunchAttempt(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
  ref: string,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  const latched = latchGateReadingOf(key)
  if (latched !== undefined) {
    const why = latched.failure === undefined ? 'it is latched' : `${latched.failure} — taken as latched`
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} not launching ${ref} — ${why} (case=${latched.latchCase}); no agent-director call (b.jg5 SRJ-502)`,
    )
    return { key, action: 'latched' }
  }
  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }
  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping the live-row sequence's ${request.kind} for ${ref}`)
    return { key, action: 'no-op' }
  }
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  endPromptRowDeferral(key)
  // b.jg5 SRJ-301: the launch is a launch attempt for the persona.
  const result = await runInAttempt(key, 'launch', async (attempt) => {
    const called = await sequenceLaunchCall(persona, config, request, ref)
    return called.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED ? called : markRefusal(called, attempt)
  })
  if (result.action !== LIVE_ROW_OUTCOME_NOT_LAUNCHED) countSequenceLaunch(key, ref, result)
  return result
}

/**
 * Count the sequence launch's `result` once (b.jg5 SRJ-112, SRJ-113,
 * SRJ-602), as the restart path counts a launch result
 * (`launchSession`'s reading), by class: a success records a success; a
 * `failed` result that is neither refused nor stopping and is marked
 * `countedClass` (LAUNCH FAILURE or DIRECTORY) records one counted launch
 * failure (the cap notice at the cap); any other `failed` result (a
 * `resume`'s `ErrSpawnNotFound`, for one) and a latched or deferred result
 * record nothing. The step-6 launch is not routed through `launchSession`,
 * so nothing else counts it. Never throws.
 */
function countSequenceLaunch(key: string, ref: string, result: SpawnPersonaResult): void {
  const succeeded = LIVE_ROW_LAUNCH_SUCCESS_ACTIONS.has(result.action)
  if (!succeeded && !sequenceLaunchCounted(result)) return
  try {
    recordLaunchResultOutsideRestartWork(key, succeeded)
  } catch (err) {
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} counting the launch of ${ref} failed: ${describeThrownValue(err)}`)
  }
}

/** The sequence launch's call: the `resume` leg with its fallback to the reuse, or the reuse. Never throws. */
async function sequenceLaunchCall(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
  ref: string,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  if (request.kind === LIVE_ROW_LAUNCH_REUSE) return sequenceReuse(persona, config, request.lastRead, false)
  // b.av2 SR-6.2: the trust patch precedes every launch.
  runPreLaunchTrustPatch(persona, ref)
  console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} resuming ${ref} (b.jg5 SRJ-705)`)
  try {
    const launched: Phase1ResumeResult = await launchWithReplyGuard(persona, ref, 'resume', (client) =>
      client.resume({ claude_instance_id: personaInstanceId(key) }),
    )
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} resumed ${ref}`)
    afterLaunchSucceeded(key, false, ref, LAUNCH_VERB_RESUME, launched)
    return { key, action: 'resumed' }
  } catch (err) {
    if (isNoTranscriptResumeError(err)) {
      console.error(
        `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${describeAgentDirectorFailure(err)} on resume for ${ref} — going on to a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-705, SRJ-707)`,
      )
      // b.jg5 SRJ-712: after ErrJsonlMissing the diagnosis runs first.
      const reused = await noTranscriptReuse(persona, config, err, {
        isStartup: false,
        lastRead: request.lastRead,
        trustPatchRan: true,
      })
      return sequenceReuseAnswer(persona, reused)
    }
    if (hasAdErrorName(err, ERR_SPAWN_NOT_RESUMABLE_NAME)) {
      console.error(
        `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${describeAgentDirectorFailure(err)} on resume for ${ref} — no second sequence and no further call; the sequence ends without its launch (b.jg5 SRJ-710)`,
      )
      return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE }
    }
    // b.jg5 SRJ-113, SRJ-301, SRJ-409 (HO rev 28): `resumeFailedAt` marks
    // an `ErrTmuxSessionCreate` result `countedClass` (`countSequenceLaunch`
    // counts it) and arms the persona's retry timer at once in pending-only
    // mode itself.
    const notResumed = await resumeFailedAt(key, err, false, ref, request.lastRead)
    // b.jg5 SRJ-113: only LAUNCH FAILURE and DIRECTORY are counted; any
    // other failure `resumeFailedAt` answers is not (`ErrSpawnNotFound`, for one).
    if (isUnrefusedFailure(notResumed) && classifyAdError(err).errorClass === AD_ERROR_CLASS_DIRECTORY) {
      return { ...notResumed, countedClass: true }
    }
    return notResumed
  }
}

/**
 * The sequence's reuse spawn (`reuseSpawnForPersona`) of the `reuse` kind,
 * with `lastRead`, the row state the sequence last read; `trustPatchRan`
 * when this attempt already ran the trust patch. Its answer is read as
 * `sequenceReuseAnswer` reads it. Never throws.
 */
async function sequenceReuse(
  persona: Persona,
  config: PersonaConfig,
  lastRead: LatchRowState,
  trustPatchRan: boolean,
): Promise<LiveRowSequenceLaunchEntryResult> {
  return sequenceReuseAnswer(persona, await reuseSpawnForPersona(persona, config, { isStartup: false, lastRead, trustPatchRan }))
}

/**
 * A reuse spawn's answer at the sequence's launch, of either leg: its
 * collided answer becomes the not-launched answer `reuse-collision` (b.jg5
 * SRJ-112, SRJ-705): no further launch, nothing counted; any other answer is
 * the launch's result.
 */
function sequenceReuseAnswer(persona: Persona, result: ReuseSpawnResult): LiveRowSequenceLaunchEntryResult {
  const { key } = persona
  if (!isReuseSpawnCollided(result)) return result
  console.error(
    `${LIVE_ROW_SEQUENCE_LOG_PREFIX} the reuse spawn of ${personaRef(persona)} collided with a live row — no further launch, nothing counted; the sequence ends without its launch (b.jg5 SRJ-112, SRJ-705)`,
  )
  return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION }
}

/** What the live-row sequence's dependency builder is given (per-server instances). */
export interface LiveRowSequenceDepsInput {
  /** The server's kill-failure alerts (over its episodes instance); absent: the installed ones (`setKillFailureAlerts`). */
  readonly killFailureAlerts?: KillFailureAlerts
  /** The retry controller's arm (or a recorder in front of it). */
  readonly retryArm: UnavailableRetryTriggerSink
  /** The sequence's clock: its waits and its kills' waits between tries. */
  readonly clock: NeverEarlyWaitClock
  /** Where the sequence's own lines go. */
  readonly log: (line: string) => void
  /** The applied configuration now, read at each call. */
  readonly appliedConfig: () => PersonaConfig | null | undefined
}

/**
 * The retry cause label each of the sequence's arm causes arms with (b.jg5
 * SRJ-301, SRJ-717). Its type holds each label to its cause's own string, so
 * the sequence's end line and the retry controller's lines name a cause alike.
 */
const LIVE_ROW_SEQUENCE_ARM_CAUSE_LABELS: { readonly [C in LiveRowSequenceArmCause]: C } = Object.freeze({
  [LIVE_ROW_ARM_NOT_JUDGED]: UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED,
  [LIVE_ROW_ARM_ENDED]: UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED,
  [LIVE_ROW_ARM_REUSE_COLLISION]: UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
})

/**
 * The live-row sequence's production dependencies (b.jg5 SRJ-705, SRJ-706,
 * SRJ-717), bound to the shared entries, so `main()` and the recovery
 * harness compose the sequence identically:
 *   - each `get` through the shared own-row read (`readPersonaOwnRow`: a
 *     `provenance_conflict` note, a configured persona's own `pending` row
 *     with no launch start or an UNUSABLE NAME answer latches the persona);
 *   - each run as a bypassing run (`bypassingFindMissingSweep`) with the
 *     persona's key as its next-step `get`, read with `readFindMissingRow`;
 *   - each kill through the bounded retry over the deferred-report
 *     persona-kill binding (`retryPersonaKill`), whose between-try read is
 *     the shared own-row `status` read, with the sequence's keep-going check
 *     beside the server's and its wait between tries;
 *   - a kill's CONFLICT and UNUSABLE NAME through the latch's entries
 *     (`conflictAt`, `unusableNameAt`) with the state last read;
 *   - the alerts through the server's kill-failure alerts, with the
 *     request's context;
 *   - the latched query, P's `ad-config-malformed` flag, E6's G accessor
 *     (`adGraceMsInEffect`), the applied `resume_enabled` and the row
 *     comparison (`compareRowToPersona`), the sequence-launch entry
 *     (`launchForLiveRowSequence`) and the retry arm with the sequence's
 *     three causes (`UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED`,
 *     `UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED`,
 *     `UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION`).
 * Every agent-director call goes through `withOutageDetection` inside those
 * entries. The builder reads nothing and starts nothing when called.
 */
export function buildLiveRowSequenceDeps(input: LiveRowSequenceDepsInput): LiveRowSequenceDeps {
  const applied = (key: string): { readonly persona: Persona; readonly config: PersonaConfig } | undefined => {
    const config = input.appliedConfig() ?? undefined
    const persona = config?.personas.find((p) => p.key === key)
    return config !== undefined && persona !== undefined ? { persona, config } : undefined
  }
  return {
    clock: input.clock,
    log: input.log,
    isLatched: (key) => personaLatchedNow(key),
    isConfigMalformedRaised: (key) => getOutageFlags(key).has('ad-config-malformed'),
    graceMs: adGraceMsInEffect,
    readRow: (key, ref) => readSequenceRow(key, ref),
    runFindMissing: (key, instanceId, stateBefore) => runSequenceFindMissing(key, instanceId, stateBefore),
    killWithRetry: (key, options) =>
      retryPersonaKill(key, {
        rowReadLive: true,
        lastRead:
          options.lastReadState === LIVE_ROW_SEQUENCE_NO_ROW ? KILL_RETRY_SEED_NOT_LIVE_VALUE : killRetrySeedOfState(options.lastReadState),
        site: LIVE_ROW_SEQUENCE_SITE,
        ref: options.ref,
        clock: options.wait,
        keepGoing: options.keepGoing,
      }),
    latchOnKillOutcome: (key, outcome, lastRead, ref) =>
      latchOnKillOutcomeAt(key, outcome, LIVE_ROW_SEQUENCE_SITE, ref, latchRowStateOfSequenceRead(lastRead)),
    raiseKillAlert: (key, retried, context, ref) =>
      raisePersonaKillFailureAlert(key, retried, LIVE_ROW_SEQUENCE_SITE, ref, context, input.killFailureAlerts),
    raiseEscalationAlert: (key, context, ref) => raiseSequenceEscalationAlert(key, context, ref, input.killFailureAlerts),
    personaFacts: (key, row) => {
      const found = applied(key)
      if (found === undefined) return undefined
      const resumeEnabled = found.config.resume_enabled !== false
      if (row === undefined) return { resumeEnabled, cwdMatches: true, configDirMatches: true }
      const comparison = compareRowToPersona({ cwd: row.cwd, labels: row.labels }, found.persona, spawnHomeDir(), undefined, _configDirFs)
      return {
        resumeEnabled,
        // b.av2 SR-6.4: a `cwd` check that cannot be made now is no mismatch.
        cwdMatches: comparison.cwdMatches || comparison.cwdCheckDeferred,
        // Bug b.g57: an unresolvable directory gives no verdict; the launch's own check holds it.
        configDirMatches: !comparison.configDirResolved || comparison.configDirMatches === true,
      }
    },
    launch: async (key, kind, lastRead, ref, stop) => {
      const found = applied(key)
      if (found === undefined) {
        console.error(
          `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: step 6: the persona is not in the applied configuration — no launch (b.jg5 SRJ-705)`,
        )
        return { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED }
      }
      const result = await launchForLiveRowSequence(found.persona, found.config, {
        kind,
        lastRead: latchRowStateOfSequenceRead(lastRead),
        stop,
      })
      return result.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED
        ? { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: result.reason }
        : { kind: LIVE_ROW_LAUNCH_ANSWER_LAUNCHED, result }
    },
    armRetry: (key, cause) => {
      try {
        input.retryArm.arm(key, { kind: LIVE_ROW_SEQUENCE_ARM_CAUSE_LABELS[cause] })
      } catch (err) {
        console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} persona=${key}: arming the retry timer failed: ${describeThrownValue(err)}`)
      }
    },
  }
}

/** The state a latch records for what the sequence last read. */
function latchRowStateOfSequenceRead(lastRead: LiveRowSequenceLastRead): LatchRowState {
  return lastRead.kind === LIVE_ROW_SEQUENCE_NO_ROW ? LATCH_ROW_STATE_NO_ROW : latchRowStateRead(lastRead.state)
}

/** One `get` of persona `key`'s row through the shared own-row read, as the sequence takes it. Never throws. */
async function readSequenceRow(key: string, ref: string): Promise<LiveRowSequenceRead> {
  const read = await readPersonaOwnRow(key, { site: LIVE_ROW_SEQUENCE_SITE, what: 'get', ref })
  switch (read.kind) {
    case OWN_ROW_READ_ROW:
      // The row whole, so the sequence reads its launch start and session id.
      return read.latched ? { kind: LIVE_ROW_READ_LATCHED } : { kind: LIVE_ROW_READ_ROW, row: read.row as Phase1GetResult }
    case OWN_ROW_READ_ABSENT:
      return { kind: LIVE_ROW_READ_ABSENT }
    case OWN_ROW_READ_LATCHED:
      return { kind: LIVE_ROW_READ_LATCHED }
    case OWN_ROW_READ_REFUSED:
      return { kind: LIVE_ROW_READ_REFUSED, error: read.error }
  }
}

/**
 * One bypassing run for persona `key` (`bypassingFindMissingSweep`, its key
 * as the next-step `get`), with where it put `instanceId`, last read
 * `stateBefore` (`readFindMissingRow`); or how it failed: refused by class
 * (`FIND_MISSING_REFUSED`), the persona latched (`FIND_MISSING_LATCHED`),
 * any other failure. Never throws.
 */
async function runSequenceFindMissing(key: string, instanceId: string, stateBefore: string): Promise<LiveRowSequenceRunPlacement> {
  const answer = await bypassingFindMissingSweep(key, LIVE_ROW_SEQUENCE_SITE, key)
  if (answer === FIND_MISSING_REFUSED) return LIVE_ROW_RUN_REFUSED
  if (answer === FIND_MISSING_LATCHED) return LIVE_ROW_RUN_LATCHED
  if (answer === undefined) return LIVE_ROW_RUN_FAILED
  switch (readFindMissingRow(answer, instanceId, stateBefore)) {
    case FIND_MISSING_ROW_MARKED_MISSING:
      return LIVE_ROW_RUN_MARKED_MISSING
    case FIND_MISSING_ROW_LEFT_LIVE:
      return LIVE_ROW_RUN_LEFT_LIVE
    case FIND_MISSING_ROW_NOT_JUDGED:
      return LIVE_ROW_RUN_NOT_JUDGED
    case FIND_MISSING_ROW_JUDGED_ALIVE:
      return LIVE_ROW_RUN_JUDGED_ALIVE
  }
}

/**
 * Step 5's kill-failure alert (b.jg5 SRJ-705, SRJ-704, SRJ-1007): the
 * ordinary version with no description, for persona `key`, with the
 * request's `context`, through `alerts` (the installed ones by default),
 * which route it and hold it once per episode. With no alerts installed, one
 * line instead. Never throws.
 */
function raiseSequenceEscalationAlert(
  key: string,
  context: KillFailureAlertContext,
  ref: string,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
): void {
  try {
    if (alerts === undefined) {
      console.error(
        `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: the kill-failure alert's ordinary version is not raised — no kill-failure alerts are installed (b.jg5 SRJ-704, SRJ-705)`,
      )
      return
    }
    alerts.raise({ key, decision: { kind: KILL_RETRY_ALERT_ORDINARY }, latched: personaLatchedNow(key), context })
  } catch (err) {
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// reconcileOrphans — SR-1.6 startup orphan reconciliation
// ---------------------------------------------------------------------------

/** What the start sweep did. */
export interface OrphanReconcileResult {
  /** Rows swept: each killed, then deleted only after a kill that succeeded. Pre-persona rows are never swept. */
  found: number
  /** Swept rows deleted. */
  killed: number
  /** Swept rows kept because their kill did not succeed, or whose delete failed. */
  failed: number
  /** Pre-persona rows (no `persona` label), all kept (b.1ix). */
  prePersona: PrePersonaSweepCounts
}

/**
 * The start sweep's pre-persona rows (b.1ix): all kept; each live one is
 * killed at this start, then one findMissing sweep lets a killed row whose
 * session is gone read `missing`, so a later start doesn't kill it again.
 */
export interface PrePersonaSweepCounts {
  /** Pre-persona rows listed. Every one is kept. */
  kept: number
  /** Those in a live state (`AGENT_DIRECTOR_LIVE_STATES`), each given one kill call at this start. */
  live: number
  /** Live ones whose kill did not succeed (`kill_sent` false or absent, and `ErrSpawnNotFound`, are successes). */
  killFailed: number
}

/** A start sweep that did nothing (dry run, or a failed list). */
function emptySweepResult(): OrphanReconcileResult {
  return { found: 0, killed: 0, failed: 0, prePersona: { kept: 0, live: 0, killFailed: 0 } }
}

/**
 * What the start sweep does with a row that has a `persona` label (b.av2
 * SR-6.3, SR-6.4): `sweep` it with a reason, `keep` it, or keep it with its
 * `cwd` check `deferred` to the persona's launch. A row is kept only when its
 * label names an applied persona, its instance ID is that persona's
 * `cscb_<key>`, and its `cwd` matches the persona's working directory by real
 * path. When that working directory cannot be resolved to a real path (a
 * directory-broken persona) and the row's `cwd` has no real path either or
 * equals the configured path lexically (`cwdCheckDeferred`), the `cwd`
 * condition cannot be evaluated and is deferred; the other conditions still
 * apply. A row whose `cwd` resolves to an existing directory is swept as
 * `wrong cwd`. A row with no `persona` label never gets here: see
 * `keepPrePersonaRow`.
 */
function sweepDecision(
  row: ListRow,
  persona: Persona | undefined,
  home: string,
): { action: 'sweep'; reason: string } | { action: 'keep' } | { action: 'deferred'; persona: Persona } {
  if (!persona) return { action: 'sweep', reason: 'absent persona' }
  if (row.claude_instance_id !== personaInstanceId(persona.key)) return { action: 'sweep', reason: 'wrong instance ID' }
  const comparison = compareRowToPersona(row, persona, home)
  if (comparison.cwdCheckDeferred) return { action: 'deferred', persona }
  if (!comparison.cwdMatches) return { action: 'sweep', reason: 'wrong cwd' }
  return { action: 'keep' }
}

/**
 * The start sweep's handling of a pre-persona row, one with no `persona`
 * label (b.1ix; the rows a build that predates personas made, instance IDs
 * `cscb_<name>_<channel>`): the row is kept, never deleted. Its ID is never a
 * persona's `cscb_<key>`, so no launch reuses or resumes it, and keeping it is
 * harmless. A row in a live state gets its kill at this start, through the
 * bounded retry with the pass's budget (`sweepKill`; b.jg5 SRJ-110, SRJ-701,
 * SRJ-702), and the outcome that stands logged; an `ended` or `missing` row
 * is left alone, with no call and no line. Returns whether it called
 * `kill`.
 *
 * agent-director 0.10.0's `kill` doesn't change the row's state, so a killed
 * row would still read live at every later start and be killed again each
 * time. `reconcileOrphans` therefore runs one findMissing sweep after the
 * kills (`reconcileKilledPrePersonaRows`): a row whose session is gone then
 * reads `missing`, and later starts leave it alone. A row whose session is
 * still there stays live and is killed again at the next start.
 *
 * Why no delete: agent-director 0.10.0's `kill` can report success while the
 * session lives on, and a deleted row would leave that session running with
 * no row to find it by (the incident pattern, at the upgrade to personas the
 * whole fleet at once). The upgrade runbook stops the old build's bots first
 * and has an operator confirm with `tmux ls` that none is left.
 *
 *   [slack] reconcileOrphans: pre-persona row (no persona label) instanceId=<id> state=<state> tmux_session=<name> is live — killing it; the row is kept (a pre-persona row is never deleted)
 *   [slack] reconcileOrphans: kill succeeded for pre-persona row instanceId=<id> (<outcome>) — row kept
 *
 * `<outcome>` is `describeKillOutcome`'s rendering, `kill_sent` included; a
 * success with `kill_sent` false or absent, `ErrSpawnNotFound` and GONE are
 * successes. A kill that did not succeed records one `orphan-cleanup` entry
 * (`kill did not succeed for pre-persona row instanceId=<id>: <outcome>; row
 * kept, its session may still be running`), except when its `ErrInvalidFlags`
 * re-check decided that the server stops (`stop.stopping` is then set): one
 * line (`sweepStoppedLine`), and nothing more. The row has no persona label,
 * so no outage is raised for it and nothing latches.
 *
 * The kill-failure alert (b.jg5 SRJ-704, SRJ-714, SRJ-1007), from the
 * retry's decision, with the start sweep's context and closing sentence and
 * the row's own id: the ordinary version's text rides in that
 * `orphan-cleanup` entry (`; kill-failure alert: instanceId=<id> (start
 * sweep): <text>`); after a success that stands, the survivor version is one
 * `persona-kill-survivor` entry naming the row. Nothing is posted, no retry
 * timer is armed and nothing latches.
 */
async function keepPrePersonaRow(
  pass: SweepPass,
  row: ListRow,
  counts: PrePersonaSweepCounts,
): Promise<boolean> {
  const { stop } = pass
  counts.kept++
  if (!AGENT_DIRECTOR_LIVE_STATES.has(row.state)) return false
  counts.live++
  const id = row.claude_instance_id
  console.error(
    `[slack] reconcileOrphans: pre-persona row (no persona label) instanceId=${id} state=${row.state} tmux_session=${row.tmux_session_name} is live — killing it; the row is kept (a pre-persona row is never deleted)`,
  )
  const { outcome, alert } = await sweepKill(pass, id, row.state, undefined)
  if (!killLetsNextStepRun(outcome)) {
    counts.killFailed++
    if (stop.stopping) {
      console.error(sweepStoppedLine(id, describeKillOutcome(outcome)))
      return true
    }
    recordStartupError(
      ORPHAN_CLEANUP_LABEL,
      `kill did not succeed for pre-persona row instanceId=${id}: ${describeKillOutcome(outcome)}; row kept, its session may still be running` +
        sweepOrdinaryAlertTail(row, alert),
    )
    return true
  }
  console.error(`[slack] reconcileOrphans: kill succeeded for pre-persona row instanceId=${id} (${describeKillOutcome(outcome)}) — row kept`)
  recordSweepSurvivorAlert(row, alert)
  return true
}

/**
 * The kill-failure alert for a start-sweep kill of `row` (b.jg5 SRJ-704,
 * SRJ-714, SRJ-1007): the route `selectKillFailureAlertRoute` gives for the
 * start sweep (the sweep acts for no persona: no destination, no episode, no
 * retry timer) and the entry's text, `instanceId=<id> (start sweep): <text>`,
 * the text naming the row's session and its instance id (a pre-persona row's
 * id as it is) with the start sweep's closing sentence, unescaped. Undefined
 * when `alert` is not of `version`. Never throws.
 */
function sweepKillAlertEntry(
  row: ListRow,
  alert: KillRetryAlert,
  version: typeof KILL_FAILURE_VERSION_ORDINARY | typeof KILL_FAILURE_VERSION_SURVIVOR,
): { readonly classLabel: string; readonly entry: string } | undefined {
  try {
    const session = typeof row.tmux_session_name === 'string' ? row.tmux_session_name : ''
    const content = killFailureAlertContentOf(alert, session, row.claude_instance_id)
    if (content === undefined || content.version !== version) return undefined
    const route = selectKillFailureAlertRoute({ version, context: KILL_FAILURE_CONTEXT_START_SWEEP, configured: false, latched: false })
    if (route.classLabel === undefined) return undefined
    const text = killFailureAlertText(content, route.closing, false)
    return { classLabel: route.classLabel, entry: killFailureAlertEntryText(`instanceId=${row.claude_instance_id}`, KILL_FAILURE_CONTEXT_START_SWEEP, text) }
  } catch (err) {
    console.error(`${SWEEP_LOG_PREFIX}: building the kill-failure alert for instanceId=${row.claude_instance_id} failed: ${describeThrownValue(err)}`)
    return undefined
  }
}

/**
 * The tail a start-sweep kill's `orphan-cleanup` entry gains for the
 * kill-failure alert's ordinary version (b.jg5 SRJ-714, SRJ-1007):
 * `; kill-failure alert: <entry>` when the retry decided it (an
 * `ErrTmuxKillFailed` that stands, or any failure after a survivor-naming
 * one), else the empty string, so the entry stays as it was. Never throws.
 */
function sweepOrdinaryAlertTail(row: ListRow, alert: KillRetryAlert): string {
  const built = sweepKillAlertEntry(row, alert, KILL_FAILURE_VERSION_ORDINARY)
  return built === undefined ? '' : `; kill-failure alert: ${built.entry}`
}

/**
 * After a start-sweep kill whose success stands: when the retry decided the
 * survivor version (a survivor-naming `ErrTmuxKillFailed` earlier in its
 * tries; b.jg5 SRJ-702, SRJ-704, SRJ-1013), one `persona-kill-survivor`
 * entry names the row with the survivor text and the start sweep's closing
 * sentence, its writer also writing the server-log line. Nothing else is
 * done: the row counts as killed. Never throws.
 */
function recordSweepSurvivorAlert(row: ListRow, alert: KillRetryAlert): void {
  const built = sweepKillAlertEntry(row, alert, KILL_FAILURE_VERSION_SURVIVOR)
  if (built !== undefined) recordStartupError(built.classLabel, built.entry)
}

/**
 * Whether a start-sweep kill's `ErrInvalidFlags` re-check decided that the
 * server stops (b.jg5 SRJ-205): once set, the sweep makes no further
 * agent-director call (no kill, delete or findMissing sweep).
 */
interface SweepStop {
  stopping: boolean
}

/**
 * One start sweep pass's kill context: the sweep's own client, its stop
 * flag, its pass budget (b.jg5 SRJ-702, AC 56: once one row's kill has used
 * its tries on UNAVAILABLE, every later kill in the pass is made once) and
 * the clock its retries wait on.
 */
interface SweepPass {
  readonly client: Client
  readonly stop: SweepStop
  readonly budget: KillRetryPassBudget
  readonly clock: KillRetryWait
}

/** The start sweep's line prefix, its kill retry's lines included. */
const SWEEP_LOG_PREFIX = '[slack] reconcileOrphans'

/**
 * The start sweep's line when a kill's `ErrInvalidFlags` re-check decided
 * that the server stops (b.jg5 SRJ-104, SRJ-204, SRJ-205): the row is kept,
 * and the sweep makes no further call. `described` is the outcome's
 * rendering (`describeKillOutcome`).
 */
function sweepStoppedLine(instanceId: string, described: string): string {
  return `[slack] reconcileOrphans: kill did not succeed for instanceId=${instanceId}: ${described} — the version re-check decided that the server stops; row kept; the sweep makes no further call (b.jg5 SRJ-205)`
}

/**
 * One start-sweep kill (b.jg5 SRJ-110, SRJ-701, SRJ-702): the bounded retry
 * (`runKillRetry`, `src/kill-retry.ts`) of `instanceId`'s kill on the
 * sweep's own client, seeded with `listedState`, the state the sweep listed
 * the row in, on the pass's clock and with the pass's budget: a row listed
 * live gets up to 3 tries 2 s apart on UNAVAILABLE, until one row of the
 * pass has used its tries that way, after which every later kill in the
 * pass is made once (AC 56); a row listed finished gets one kill. Each try
 * is one checked kill (`sweepKillTry`); before each further try, one bare
 * `status` read of the row (`sweepKillRead`). Each try and read is logged
 * with the sweep's prefix. Answers the retry's result; its caller writes the
 * alert decision's entries (`sweepOrdinaryAlertTail`,
 * `recordSweepSurvivorAlert`; b.jg5 SRJ-704, SRJ-714).
 *
 * The start sweep is no launch or recovery attempt: nothing latches (a
 * CONFLICT or an UNUSABLE NAME answer is recorded, b.jg5 SRJ-1002), no retry
 * timer is armed, no `tmux-unresponsive` condition starts and no
 * unclassified-error episode is fed (a class the kill has no row for is
 * UNCLASSIFIED and only recorded). An `ErrInvalidFlags` gets exactly one
 * immediate version re-check (`recheckKillOnInvalidFlags`; b.jg5 SRJ-104,
 * SRJ-204); when the outcome that stands is one whose re-check decided that
 * the server stops, `stop.stopping` is set and the caller does nothing more
 * (b.jg5 SRJ-205). Of the outcome that stands only (hatch A3, through the
 * tries), an ENVIRONMENT answer raises `tmux-unavailable`, and a CONFIG
 * answer `ad-config-malformed`, for `configuredKey` only: the persona of the
 * applied configuration the row's label names, `undefined` for a row of an
 * absent persona or with no persona label, whose answer is only logged and
 * recorded by the caller (b.jg5 SRJ-110, SRJ-301, SRJ-1002). Never throws.
 */
async function sweepKill(
  pass: SweepPass,
  instanceId: string,
  listedState: string,
  configuredKey: string | undefined,
): Promise<KillRetryResult> {
  const result = await runKillRetry({
    instanceId,
    kill: () => sweepKillTry(pass.client, instanceId),
    read: () => sweepKillRead(pass.client, instanceId, configuredKey),
    wait: pass.clock,
    lastRead: killRetrySeedOfState(listedState),
    budget: pass.budget,
    log: (line) => console.error(line),
    logPrefix: SWEEP_LOG_PREFIX,
  })
  const { outcome } = result
  if (killOutcomeStopsServer(outcome)) pass.stop.stopping = true
  if (configuredKey !== undefined && outcome.kind === KILL_OUTCOME_NOT_KILLED) {
    try {
      if (outcome.errorClass === AD_ERROR_CLASS_ENVIRONMENT) raiseTmuxUnavailable(configuredKey, outcome.error)
      else if (outcome.errorClass === AD_ERROR_CLASS_CONFIG) raiseAdConfigMalformed(configuredKey, outcome.error)
    } catch (err) {
      console.error(
        `${SWEEP_LOG_PREFIX}: raising the outage for persona=${configuredKey} failed: ${describeThrownValue(err)}`,
      )
    }
  }
  return result
}

/**
 * One try of a start-sweep kill: one checked kill of `instanceId` on the
 * sweep's own client, with the `ErrInvalidFlags` re-check
 * (`recheckKillOnInvalidFlags`). Never throws.
 */
async function sweepKillTry(client: Client, instanceId: string): Promise<KillOutcome> {
  return recheckKillOnInvalidFlags(await checkedKill(instanceId, (params) => client.kill(params)))
}

/**
 * One `status` read of a swept row between its kill's tries (b.jg5 SRJ-702),
 * on the sweep's own client: its state, or no row for `ErrSpawnNotFound` (by
 * name), or a failed read that latches nothing (the start sweep latches
 * nothing; an UNUSABLE NAME answer is a failed read). A CONFIG answer raises
 * `ad-config-malformed` for `configuredKey` only, through its raise entry,
 * arming no retry timer, and is otherwise only logged (b.jg5 SRJ-110,
 * SRJ-316; hatch A3); the retry then ends the tries when the row was last
 * read `pending`. Never throws.
 */
async function sweepKillRead(client: Client, instanceId: string, configuredKey: string | undefined): Promise<KillRetryRead> {
  try {
    const result = await client.status({ claude_instance_id: instanceId })
    return { kind: KILL_RETRY_READ_STATE, state: result.state }
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) return { kind: KILL_RETRY_READ_NO_ROW }
    if (classifyAdError(err).errorClass === AD_ERROR_CLASS_CONFIG) sweepReadConfigAnswer(instanceId, configuredKey, err)
    return { kind: KILL_RETRY_READ_FAILED, error: err }
  }
}

/** A CONFIG answer at a swept row's between-try read: raised for a configured persona, else one line. Never throws. */
function sweepReadConfigAnswer(instanceId: string, configuredKey: string | undefined, err: unknown): void {
  if (configuredKey === undefined) {
    console.error(
      `${SWEEP_LOG_PREFIX}: the status read between kill tries for instanceId=${instanceId} answered CONFIG; the row names no persona of the applied configuration, so no outage is raised — logged only (b.jg5 SRJ-110, SRJ-316)`,
    )
    return
  }
  try {
    raiseAdConfigMalformed(configuredKey, err)
  } catch (raiseErr) {
    console.error(
      `${SWEEP_LOG_PREFIX}: raising the outage for persona=${configuredKey} failed: ${describeThrownValue(raiseErr)}`,
    )
  }
}

/**
 * After the start sweep's kills of live pre-persona rows (b.1ix), run one
 * findMissing sweep, so each killed row whose session is gone reads `missing`
 * and is not killed again at the next start (agent-director 0.10.0's `kill`
 * leaves the row's state as it was). It runs after a failed kill too: the
 * session may be gone all the same, and only the sweep would tell.
 *
 * It is an ordinary run of the memoized, single-flight sweep every
 * findMissing caller shares (`sharedFindMissingSweep`, b.m4r, b.jg5 SRJ-120).
 * The start sweep runs before any launch and before the health check, so no
 * earlier sweep in this process can be reused; the launches right after it
 * reuse this one within its window. The call goes to the start sweep's client
 * directly, as its list and kills do: it acts for no persona, so no persona's
 * outage flag is raised or cleared by the call. As after any run the server
 * makes, each configured persona's own row listed in `unverified_ids` is then
 * read with one `get` through that persona's `withOutageDetection`
 * (`readListedPersonaRows`; an already-latched persona is skipped), and only
 * a `provenance_conflict` note there, or the persona's own row reading
 * `pending` with no launch start (b.jg5 SRJ-513), latches. The run is the
 * start sweep's (`startSweepRun`), so an UNUSABLE NAME answer to one of
 * those `get`s is routed per SRJ-1002 and latches nothing (b.jg5 SRJ-512):
 * its routed line, and `refused (<failure>)` in the reads' line. Never
 * throws.
 *
 * Each killed row is read with `readFindMissingRow` and the state the start
 * sweep listed it with: `missing` holds the rows marked missing; `not-judged`
 * the `pending` rows in neither list, which agent-director did not judge
 * (retry later; never a reason to escalate, alert or kill); `still-live` the
 * rest, judged and left live (in `unverified_ids`) or judged alive. The
 * start sweep's kill decisions do not depend on this line. The sweep's own
 * line, then one line with the outcome for the killed rows:
 *
 *   [slack] reconcileOrphans: findMissing sweep for killed pre-persona rows — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *   [slack] reconcileOrphans: findMissing after the kills of <n> live pre-persona row(s): missing=<n> [<ids>] still-live=<n> [<ids>] not-judged=<n> [<ids>] — a row that still reads live is killed again at the next start; a not-judged row was pending and not judged by this sweep (retry later)
 *
 * or, when the sweep fails, its failure line and:
 *
 *   [slack] reconcileOrphans: findMissing after the kills of <n> live pre-persona row(s) failed — they still read live and are killed again at the next start
 */
async function reconcileKilledPrePersonaRows(client: Client, killed: readonly KilledPrePersonaRow[]): Promise<void> {
  const head = `[slack] reconcileOrphans: findMissing after the kills of ${killed.length} live pre-persona row(s)`
  const r = await sharedFindMissingSweep(() => client.findMissing({}), 'reconcileOrphans', 'killed pre-persona rows', undefined, {
    startSweepRun: true,
  })
  if (!r) {
    console.error(`${head} failed — they still read live and are killed again at the next start`)
    return
  }
  const missing: string[] = []
  const stillLive: string[] = []
  const notJudged: string[] = []
  for (const { id, state } of killed) {
    const reading = readFindMissingRow(r, id, state)
    if (reading === FIND_MISSING_ROW_MARKED_MISSING) missing.push(id)
    else if (reading === FIND_MISSING_ROW_NOT_JUDGED) notJudged.push(id)
    else stillLive.push(id)
  }
  console.error(
    `${head}: missing=${missing.length} [${missing.join(',')}] still-live=${stillLive.length} [${stillLive.join(',')}] not-judged=${notJudged.length} [${notJudged.join(',')}] — a row that still reads live is killed again at the next start; a not-judged row was pending and not judged by this sweep (retry later)`,
  )
}

/** A pre-persona row the start sweep killed: its instance id and the state the sweep listed it with. */
interface KilledPrePersonaRow {
  readonly id: string
  readonly state: string
}

/**
 * Kill one row the start sweep swept (the bounded retry with the pass's
 * budget, `sweepKill`; b.jg5 SRJ-110, SRJ-701, SRJ-702), then delete it only
 * after the success that stands (any `kill_sent`, `ErrSpawnNotFound`, GONE,
 * or a read between tries that found the row finished). A kill that did not succeed keeps the row: no
 * delete call is made, and one `orphan-cleanup` entry names the outcome
 * (`kill did not succeed for orphan instanceId=<id> persona=<persona>:
 * <outcome>; row kept, no delete was made, its session may still be
 * running`); nothing latches and no retry timer is armed. `configuredKey`
 * is the applied persona the row's label names (`undefined` for an absent
 * persona), for whom an ENVIRONMENT or CONFIG answer raises its outage
 * (`sweepKill`). A kill whose `ErrInvalidFlags` re-check decided that the
 * server stops (`stop.stopping`) records nothing: one line, no delete.
 * Returns whether the delete succeeded; a failed delete records
 * `orphan-cleanup` too.
 *
 * The kill-failure alert (b.jg5 SRJ-704, SRJ-714, SRJ-1007), from the
 * retry's decision, with the start sweep's context and closing sentence: the
 * ordinary version's text rides in the kill's `orphan-cleanup` entry (`;
 * kill-failure alert: instanceId=<id> (start sweep): <text>`); after a
 * success that stands, the survivor version is one `persona-kill-survivor`
 * entry naming the row, written before the delete. Nothing is posted, even
 * for a configured persona's row: the sweep acts for no persona.
 *
 *   [slack] reconcileOrphans: kill succeeded for orphan instanceId=<id> (<outcome>) — deleting the row
 */
async function killAndDeleteSweptRow(
  pass: SweepPass,
  row: ListRow,
  displayPersona: string,
  configuredKey: string | undefined,
): Promise<boolean> {
  const { client, stop } = pass
  const id = row.claude_instance_id
  const { outcome, alert } = await sweepKill(pass, id, row.state, configuredKey)
  if (!killLetsNextStepRun(outcome)) {
    if (stop.stopping) {
      console.error(sweepStoppedLine(id, describeKillOutcome(outcome)))
      return false
    }
    recordStartupError(
      ORPHAN_CLEANUP_LABEL,
      `kill did not succeed for orphan instanceId=${id} persona=${displayPersona}: ${describeKillOutcome(outcome)}; row kept, no delete was made, its session may still be running` +
        sweepOrdinaryAlertTail(row, alert),
    )
    return false
  }
  console.error(`[slack] reconcileOrphans: kill succeeded for orphan instanceId=${id} (${describeKillOutcome(outcome)}) — deleting the row`)
  recordSweepSurvivorAlert(row, alert)
  try {
    await client.delete({ claude_instance_id: [id] })
    return true
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('delete', 'UnknownError', String(err))
    recordStartupError(ORPHAN_CLEANUP_LABEL, `delete failed for orphan instanceId=${id} persona=${displayPersona}: ${describeAgentDirectorFailure(e)}`)
    return false
  }
}

/**
 * Start sweep (b.av2 SR-6.3; formerly SR-1.6): enumerate every `service=cscb`
 * spawn.
 *
 * A pre-persona row (no `persona` label) is kept, never deleted, and killed
 * only when it is live (`keepPrePersonaRow`, b.1ix). When at least one was
 * killed, one findMissing sweep follows the loop, so a killed row whose
 * session is gone reads `missing` and the next start leaves it alone
 * (`reconcileKilledPrePersonaRows`).
 *
 * Every other row is swept, killed and then deleted after a kill that
 * succeeded (`killAndDeleteSweptRow`), when it
 *   - names a persona absent from the applied configuration (the kill and
 *     delete stay until b.fmk: agent-director 0.10.0 has no reuse, and a
 *     persona added again must start fresh),
 *   - has an instance ID other than `cscb_<key>` for its persona, or
 *   - has a `cwd` other than its persona's working directory, by real path
 *     (`compareRowToPersona`).
 * When a persona's working directory cannot be resolved to a real path (a
 * directory-broken persona, b.av2 SR-6.4), its rows whose `cwd` has no real
 * path either (or equals the configured path lexically) are kept, and one
 * line per persona says the check is deferred to its launch; a row whose
 * `cwd` resolves to an existing directory is still swept as `wrong cwd`:
 *
 *   [slack] reconcileOrphans: persona "<name>" (key=<key>) working_directory="<path>" cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch
 *
 * A `channel` label left on a row by an older spawn plays no part. Every kill
 * is a checked kill, run through the bounded retry (`sweepKill`; b.jg5
 * SRJ-110, SRJ-701, SRJ-702) with one pass budget for the whole pass, so a
 * wedged tmux delays the pass by at most one row's retries (AC 56), on
 * `clock` (the production clock unless the caller passes its own): a swept
 * row whose kill did not succeed is kept, with no delete call, and counted
 * failed. A
 * kill whose `ErrInvalidFlags` re-check decides that the server stops ends
 * the sweep: no further row is handled and no findMissing sweep follows
 * (b.jg5 SRJ-205); the summary line is still logged. No
 * sweep kill latches anything or arms a retry timer; an ENVIRONMENT or CONFIG
 * answer raises its outage only for a configured persona's row (hatch A3). A
 * kill that did not succeed and a failed delete record `orphan-cleanup`, a
 * list failure records `orphan-cleanup-list-failed` and does not block
 * startup. One summary line ends the sweep:
 *
 *   [slack] reconcileOrphans: found=<n> killed=<n> failed=<n>; pre-persona rows kept=<n> live=<n> kill-failed=<n>
 */
export async function reconcileOrphans(
  personaConfig: PersonaConfig,
  clock: KillRetryWait = KILL_RETRY_SYSTEM_CLOCK,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return emptySweepResult()
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    const r = await client.list({ label: [SERVICE_LABEL] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    recordStartupError(
      'orphan-cleanup-list-failed',
      `failed to list spawns for orphan reconciliation: ${describeAgentDirectorFailure(e)}`,
    )
    return emptySweepResult()
  }

  const personasByKey = new Map(personaConfig.personas.map((p) => [p.key, p]))
  const home = spawnHomeDir()
  const result = emptySweepResult()
  const deferredLogged = new Set<string>()
  const killedPrePersonaRows: KilledPrePersonaRow[] = []
  const stop: SweepStop = { stopping: false }
  const pass: SweepPass = { client, stop, budget: createKillRetryPassBudget(), clock }

  for (const row of rows) {
    // b.jg5 SRJ-205: a kill's version re-check decided that the server
    // stops, so the sweep makes no further agent-director call.
    if (stop.stopping) break
    const personaLabel = row.labels?.[PERSONA_LABEL_KEY]
    if (!personaLabel) {
      if (await keepPrePersonaRow(pass, row, result.prePersona)) {
        killedPrePersonaRows.push({ id: row.claude_instance_id, state: row.state })
      }
      continue
    }
    const persona = personasByKey.get(personaLabel)
    const decision = sweepDecision(row, persona, home)
    if (decision.action === 'keep') continue
    if (decision.action === 'deferred') {
      const deferred = decision.persona
      if (!deferredLogged.has(deferred.key)) {
        deferredLogged.add(deferred.key)
        console.error(
          `[slack] reconcileOrphans: persona ${personaRef(deferred)} working_directory="${deferred.working_directory}" ` +
            'cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch',
        )
      }
      continue
    }
    const { reason } = decision

    result.found++
    // The persona reference when the persona exists, else the raw label value.
    const displayPersona = persona ? personaRef(persona) : personaLabel
    const cwdDetail = reason === 'wrong cwd' ? ` cwd=${row.cwd}` : ''
    console.error(
      `[slack] reconcileOrphans: sweeping row (${reason}) persona=${displayPersona} instanceId=${row.claude_instance_id} state=${row.state}${cwdDetail} — killing and deleting`,
    )
    if (await killAndDeleteSweptRow(pass, row, displayPersona, persona?.key)) result.killed++
    else result.failed++
  }

  if (killedPrePersonaRows.length > 0 && !stop.stopping) await reconcileKilledPrePersonaRows(client, killedPrePersonaRows)

  const { found, killed, failed, prePersona } = result
  console.error(
    `[slack] reconcileOrphans: found=${found} killed=${killed} failed=${failed}; pre-persona rows kept=${prePersona.kept} live=${prePersona.live} kill-failed=${prePersona.killFailed}`,
  )
  return result
}

// ---------------------------------------------------------------------------
// startupSessionManager — iterate personas and dispatch per persona
// ---------------------------------------------------------------------------

/**
 * What `startupSessionManager` needs to run steps 1–3 of the SR-6.1 bring-up
 * procedure for each persona: the bring-up controller
 * (`createPersonaBringUpController`), which gives each persona its outcome and
 * runs its retries on the persona's own timers. The applied set is supplied
 * here; the launch (step 4) at start is `spawnForPersona`.
 */
export type StartupBringUpDeps = Pick<PersonaBringUpController, 'bringUp'>

/**
 * One persona's start outcome: a spawn outcome; not brought up (steps 1–3:
 * `broken` or `retrying`) with its causes; or, b.f2b, a launch still waiting
 * in the background for its `working` row to settle when the pass returned.
 */
export type StartupPersonaOutcome =
  | { key: string; action: SpawnPersonaResult['action'] }
  | {
    key: string
    action: 'not-brought-up'
    outcome: Exclude<PersonaBringUpOutcome, 'up'>
    failures: PersonaBringUpFailure[]
  }
  | { key: string; action: 'waiting-in-background' }

/** b.f2b: a start launch parked while it waits for a `working` row to settle. */
const WAITING_IN_BACKGROUND = 'waiting-in-background'

/** A start launch's result as the start pass sees it (b.f2b). */
type StartLaunchResult = SpawnPersonaResult | typeof WAITING_IN_BACKGROUND

export interface StartupSessionManagerResult {
  /** Any non-failed action (kept for callers that only care about liveness). */
  succeeded: number
  failed: number
  /**
   * Personas not brought up at start: `broken` or `retrying` after steps 1–3
   * (credentials, working directory, Slack). Not launched by the start and
   * not counted as a failed spawn; a `retrying` persona is launched later
   * from its own retry, outside the pool.
   */
  notBroughtUp: number
  /** b.wrb: honest per-outcome breakdown of the succeeded personas. */
  resumed: number
  /** Clean fresh spawns (no prior row / no resume attempted). */
  freshSpawned: number
  /** Fresh spawns that REPLACED a resume because the transcript was missing
   *  (ErrJsonlMissing amnesia) and diagnosis was CONCLUSIVE ('lost' or
   *  evidence-based 'never-created') — separated so they are never hidden in
   *  "ok". */
  freshAfterAmnesia: number
  /** b.fwu: fresh spawns that REPLACED a resume after ErrJsonlMissing amnesia
   *  where diagnosis was INCONCLUSIVE — we could not determine whether prior
   *  history was destroyed. Kept apart from freshAfterAmnesia so the operator
   *  can distinguish known-cause amnesia from undiagnosable amnesia. */
  freshAfterInconclusiveAmnesia: number
  /** `/mcp reconnect` typed into a live session. */
  reconnected: number
  /**
   * b.f2b: `not-reconnected` launches — the session runs, but the wait for
   * its `working` row ended with nothing typed. Counted in `succeeded` too,
   * as when they were reported as reconnected.
   */
  notReconnected: number
  noop: number
  /**
   * b.f2b: launches still waiting in the background for a `working` row to
   * settle when the pass returned; counted in no other field. Each stays in
   * flight (`isLaunchInFlight`) until it settles, and its outcome is logged
   * then.
   */
  waitingInBackground: number
  /** One outcome per persona, by key. */
  perPersona: StartupPersonaOutcome[]
}

/**
 * On server startup, bring every applied persona up once — a persona listed
 * in several channels still gets exactly one bring-up and one spawn.
 *
 * With `options.bringUp` (the server always passes its bring-up controller)
 * each persona goes through the b.av2 SR-6.1 procedure, in order: the local
 * credentials check (skipped in dry run), the working-directory check, Slack
 * validation and connection (the controller's `bringUp`, which also logs the
 * persona's `persona-start` line), then the launch (`spawnForPersona`). Steps
 * 1–3 run for every persona at once, so no persona's Slack connection waits
 * behind another persona's launch; only the launches share a pool of at most
 * `concurrency` (default 3), taken in the order the personas become ready. The
 * pass returns once every persona has an outcome and every `up` persona's
 * launch has settled or is waiting for a `working` row: a `broken` or
 * `retrying` persona is not brought up and never takes a pool slot (its
 * retries run on its own timers, and a retry that succeeds launches it from
 * there). It is counted apart from spawn outcomes, records no startup error,
 * posts no notice and is not a failed spawn. Without `options.bringUp` each
 * persona is launched directly (steps 1–3 skipped), in config order through
 * the same pool; only unit tests of the launch ladder call it that way.
 *
 * b.f2b — one stuck persona must not hold up the others. A launch whose
 * collision ladder starts waiting for a `working` row to settle
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`) is
 * parked: the pass stops waiting for it and frees its pool slot, and the
 * launch goes on in the background. It is reported as `waiting-in-background`
 * (`waitingInBackground`), stays in flight until it settles (so the health
 * check skips it, a restart joins it and a teardown waits for it, as for any
 * launch in flight), and its outcome is logged when it settles. So the health
 * check and the reload detection tick, which start once the pass returns, are
 * not held up by one persona's wait (b.av2 SR-8.2 keeps its intent: every
 * persona's bring-up has read its credentials by then).
 *
 * Per-persona launch failures are logged and recorded in startup-errors.log
 * but never crash the server. cozempic availability is probed in the
 * background (non-blocking).
 */
export async function startupSessionManager(
  config: PersonaConfig,
  options?: { concurrency?: number; bringUp?: StartupBringUpDeps },
): Promise<StartupSessionManagerResult> {
  await checkCozempicAvailable()

  const personas = config.personas
  const concurrency = options?.concurrency ?? 3

  console.error(
    `[slack] startupSessionManager: ${personas.length} persona(s), concurrency=${concurrency}`,
  )

  const perPersona: StartupPersonaOutcome[] = []
  const bringUp = options?.bringUp
  const launchSlot = createLaunchPool(Math.max(1, concurrency))
  let succeeded = 0
  let failed = 0
  let notBroughtUp = 0
  let resumed = 0
  let freshSpawned = 0
  let freshAfterAmnesia = 0
  let freshAfterInconclusiveAmnesia = 0
  let reconnected = 0
  let notReconnected = 0
  let noop = 0
  let waitingInBackground = 0

  function tally(action: SpawnPersonaResult['action']): void {
    switch (action) {
      case 'failed':
        failed++
        break
      case 'resumed':
        resumed++
        succeeded++
        break
      case 'not-reconnected':
        notReconnected++
        succeeded++
        break
      case 'fresh-after-amnesia':
        freshAfterAmnesia++
        succeeded++
        break
      case 'fresh-after-inconclusive-amnesia':
        freshAfterInconclusiveAmnesia++
        succeeded++
        break
      case 'reconnected':
        reconnected++
        succeeded++
        break
      case 'no-op':
        noop++
        succeeded++
        break
      case 'latched':
        // b.jg5 SRJ-502, SRJ-1015: not a failure and not a launch, so neither
        // failed nor succeeded. The summary line has no `latched` count yet.
        break
      case 'sequence-waiting':
        // b.jg5 SRJ-706, SRJ-1015: held for the persona's live-row sequence;
        // neither failed nor succeeded. The summary line has no count for it.
        break
      case 'spawned':
      default:
        freshSpawned++
        succeeded++
        break
    }
  }

  /**
   * Steps 1–3 (with `bringUp`, outside the pool), then step 4 through the
   * launch pool; the launch alone without `bringUp`. Undefined when not
   * brought up (recorded here). `waiting-in-background` once the launch
   * waits for a `working` row (b.f2b): its pool slot is freed then.
   */
  async function launchPersona(persona: Persona): Promise<StartLaunchResult | undefined> {
    if (bringUp) {
      const started = await bringUp.bringUp(persona, personas)
      if (started.outcome !== 'up') {
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: started.outcome, failures: started.failures })
        notBroughtUp++
        return undefined
      }
    }
    return launchSlot(() => launchOrPark(persona, config))
  }

  async function processPersona(persona: Persona): Promise<void> {
    try {
      const result = await launchPersona(persona)
      if (result === undefined) return
      if (result === WAITING_IN_BACKGROUND) {
        perPersona.push({ key: persona.key, action: WAITING_IN_BACKGROUND })
        waitingInBackground++
        return
      }
      if (result.action === 'deferred') {
        // Bug b.g57: its claude_config_dir cannot be resolved; the bring-up
        // controller holds it retrying and launches it once it resolves.
        const failures = result.deferredBy === undefined ? [] : [result.deferredBy]
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: 'retrying', failures })
        notBroughtUp++
        return
      }
      perPersona.push({ key: persona.key, action: result.action })
      tally(result.action)
    } catch (err) {
      const ref = personaRef(persona)
      // Token-safe: the launch covers the persona's Slack bring-up, so the
      // thrown value's message can carry secrets. Only the describer's output
      // (type, code, message through `redactSlackLogText`, frames) reaches
      // the log and startup-errors.log.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
      perPersona.push({ key: persona.key, action: 'failed' })
      failed++
    }
  }

  await Promise.all(personas.map((persona) => processPersona(persona)))

  // b.wrb/b.fwu: honest breakdown. A fresh-spawn that replaced a resume because
  // the transcript was missing is reported separately and never folded into a
  // generic "ok". b.fwu splits that amnesia into DIAGNOSED (fresh-after-amnesia:
  // we know whether history was lost) vs UNDIAGNOSABLE
  // (fresh-after-inconclusive-amnesia: we could not tell). b.f2b: a session
  // left running but not reconnected has its own bucket, last, so the line up
  // to `not brought up` reads as before.
  console.error(
    `[slack] startupSessionManager: complete — ${personas.length} persona(s): ${resumed} resumed, ` +
      `${freshSpawned} fresh-spawned, ${freshAfterAmnesia} fresh-after-amnesia, ` +
      `${freshAfterInconclusiveAmnesia} fresh-after-inconclusive-amnesia, ` +
      `${reconnected} reconnected, ${noop} no-op, ${failed} failed, ${notBroughtUp} not brought up, ` +
      `${notReconnected} not reconnected`,
  )
  if (freshAfterAmnesia > 0) {
    // Loud, grep-friendly signal that some personas lost their resume target.
    // Per-persona "lost vs never-created" detail was already emitted (and, for
    // 'lost', recorded to startup-errors) by diagnoseJsonlMissing.
    console.error(
      `[slack] startupSessionManager: ${freshAfterAmnesia} persona(s) were fresh-spawned after ErrJsonlMissing ` +
        `(transcript could not be resumed) — see per-persona "ErrJsonlMissing diagnostic" lines above.`,
    )
  }
  if (freshAfterInconclusiveAmnesia > 0) {
    // b.fwu: a separate, louder signal — these personas were fresh-spawned but
    // the diagnosis machinery could not tell whether history was destroyed. That
    // degraded-diagnosis condition correlates with the storage faults that cause
    // real loss, so it warrants its own attention. Each was recorded to
    // startup-errors as JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS.
    console.error(
      `[slack] startupSessionManager: ${freshAfterInconclusiveAmnesia} persona(s) were fresh-spawned after ` +
        `ErrJsonlMissing WITHOUT a conclusive diagnosis — could NOT determine whether conversation history was ` +
        `lost. See per-persona "ErrJsonlMissing diagnostic ... INCONCLUSIVE" lines and the ` +
        `'${JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS}' startup errors above.`,
    )
  }
  if (waitingInBackground > 0) {
    console.error(
      `[slack] startupSessionManager: ${waitingInBackground} persona(s) still waiting in the background for a working row ` +
        `to settle — not counted above; each logs its outcome when it settles (b.f2b)`,
    )
  }

  return {
    succeeded,
    failed,
    notBroughtUp,
    resumed,
    freshSpawned,
    freshAfterAmnesia,
    freshAfterInconclusiveAmnesia,
    reconnected,
    notReconnected,
    noop,
    waitingInBackground,
    perPersona,
  }
}

/**
 * b.f2b: one start launch, or `waiting-in-background` as soon as its
 * collision ladder starts waiting for a `working` row to settle. From then on
 * the launch goes on in the background, in flight until it settles, and
 * `followParkedLaunch` logs its outcome. A launch that rejects before that
 * rejects here, as before.
 */
async function launchOrPark(persona: Persona, config: PersonaConfig): Promise<StartLaunchResult> {
  let park: () => void = () => {}
  const parked = new Promise<typeof WAITING_IN_BACKGROUND>((resolve) => {
    park = () => resolve(WAITING_IN_BACKGROUND)
  })
  const launch = spawnForPersona(persona, config, true, { onWorkingRowWait: () => park() })
  const first = await Promise.race([launch, parked])
  if (first === WAITING_IN_BACKGROUND) followParkedLaunch(persona, launch)
  return first
}

/**
 * b.f2b: log that the start pass goes on without a parked launch, and its
 * outcome once it settles: its `SpawnPersonaResult` action, so `reconnected`
 * only when `/mcp reconnect` was typed and `not-reconnected` when the wait
 * gave up with the session alive (the wait's own line says what happens
 * next). A rejection is logged and recorded as the start pass records one;
 * never rethrown.
 */
function followParkedLaunch(persona: Persona, launch: Promise<SpawnPersonaResult>): void {
  const ref = personaRef(persona)
  console.error(
    `[slack] startupSessionManager: ${ref} is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)`,
  )
  launch.then(
    (result) => console.error(`[slack] startupSessionManager: background launch for ${ref} settled: ${result.action} (b.f2b)`),
    (err: unknown) => {
      // Token-safe, as in the start pass: only the describer's output.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error in the background launch for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
    },
  )
}

/**
 * A first-in, first-out pool: `run(task)` starts `task` once fewer than
 * `size` tasks are running, in the order `run` was called, and settles with
 * its result.
 */
function createLaunchPool(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

// ---------------------------------------------------------------------------
// launchSession — restart.ts adapter
// ---------------------------------------------------------------------------

/**
 * Restart-adapter shim for restart.ts (`RestartDeps.launchSession`): launch
 * the applied persona with this key. Runs step 4 of the start procedure only:
 * a restart never repeats the credentials, working-directory or Slack steps.
 *
 * `options.canLaunch` (the server passes `createPersonaRelaunchGate`) is
 * asked first, before the persona is looked up: when it answers false — the
 * persona is not up (its Slack connection is not serving, or its bring-up is
 * broken or retrying) or its key is no longer applied (b.av2 SR-8.6) —
 * nothing is launched and the result is `'skipped'`, which restart.ts counts
 * as neither a success nor a failure. Asking it first keeps a key a
 * confirmed apply removed from counting as a failure. restart.ts asks the
 * same gate before any kill or reconnect; this check covers a flip in
 * between.
 *
 * Returns true on any non-failed action (spawned / resumed / reconnected /
 * not-reconnected / no-op; b.f2b: `not-reconnected` counts as it did when it
 * was reported as `reconnected`, so SR-25.1 counting is unchanged), false on
 * `failed` or when no applied persona has the key,
 * `'skipped'` for `deferred` (bug b.g57: its claude_config_dir cannot be
 * resolved; nothing was launched and its row is kept), for `latched` (b.jg5
 * SRJ-502, SRJ-1015: the persona is latched, or latched at this launch;
 * nothing more was launched, and the latch stops its retry timer) and for a `failed`
 * marked `stopping` (the version re-check of a resume or of the launch wait's
 * evidence read decided the stop), which
 * count toward no failure or cap, and `'refused'` for a `failed` carrying the
 * refusal marker (b.jg5 SRJ-301: its UNAVAILABLE retry timer owns the
 * persona) and for `sequence-waiting` (b.jg5 SRJ-706, SRJ-1015: the
 * persona's live-row sequence runs; never `'skipped'`, which would stop the
 * retry timer), which the restart path never counts (SRJ-302). The richer `SpawnPersonaResult` is collapsed here
 * because the restart subsystem only cares about did-it-relaunch.
 */
export async function launchSession(
  key: string,
  config: PersonaConfig,
  options?: { canLaunch?: (key: string) => boolean },
): Promise<boolean | 'skipped' | 'refused'> {
  if (options?.canLaunch && !options.canLaunch(key)) return 'skipped'
  const persona = config.personas.find((p) => p.key === key)
  if (!persona) return false
  const result = await spawnForPersona(persona, config, false)
  // b.jg5 SRJ-1015: a latched persona records nothing; the latch stops its retry timer.
  if (result.action === 'deferred' || result.action === 'latched' || result.stopping) return 'skipped'
  // b.jg5 SRJ-706, SRJ-1015: a launch held for P's live-row sequence records
  // nothing and is a refusal at a retry, which re-arms the timer (SRJ-302).
  if (result.action === 'sequence-waiting') return 'refused'
  if (result.refused) return 'refused'
  return result.action !== 'failed'
}
