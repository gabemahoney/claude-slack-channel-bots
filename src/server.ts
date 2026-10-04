#!/usr/bin/env bun
/**
 * Slack Channel for Claude Code
 *
 * Two-way Slack ↔ Claude Code bridge via Socket Mode + MCP HTTP (StreamableHTTP).
 * Security: per-persona delivery rules, persona posting scope, file exfiltration
 * guard, bot token sent only to Slack-hosted file URLs.
 *
 * Configuration: `main()` resolves the start through the reload controller
 * (`reload.ts`, b.av2 SR-8.7): it runs `config.json.last-applied` beside
 * `config.json` in the state directory (`resolveServerConfigPath`) when that
 * record exists, and otherwise validates, records and applies `config.json`.
 * A missing, unreadable, pre-persona or invalid file with no record, a record
 * that cannot be read or validated, or a record that cannot be written stops
 * the start with one line (b.av2 SR-1.7). Once the start bring-up pass has
 * returned, the controller's detection tick (every 5 s, `reload-timer.ts`)
 * keeps `config.json.pending` in step with any unconfirmed change, and applies
 * a change only once the operator confirms it: removed personas are torn
 * down and added ones brought up through `persona-lifecycle.ts` (SR-8.5,
 * SR-8.6). Nothing about it is posted to Slack (SR-8.2, SR-8.3, SR-7.2).
 * No Slack client is built and no token is read at module scope (SR-3.1,
 * SR-10.2).
 *
 * agent-director: `main()` first runs the startup gate
 * (`agent-director-startup.ts`), then installs the runtime version re-check
 * (`ad-version-gate.ts`, b.jg5 SRJ-204): every 120 s it re-checks the host
 * binary, and one that fails the gate stops the server through `shutdown()`
 * with a non-zero exit (b.jg5 SRJ-205).
 *
 * Slack: one connection per persona, run by the connection manager
 * (`persona-connections.ts`) and brought up at start through the SR-6.1
 * procedure (`startupSessionManager` → the bring-up controller in
 * `persona-bringup-controller.ts`, then the launch). Each persona ends its
 * start `up`, `broken` or `retrying`; retries run on the persona's own timers
 * and launch it once it is up. Only a persona that is up is touched by the
 * health check or a restart (`createPersonaRelaunchGate`). Each persona's
 * `message`, `app_mention` and `interactive` events reach the event router
 * (`persona-event-router.ts`) tagged with that persona's key.
 *
 * Multi-session routing: each Claude Code session connects to its own MCP Server
 * instance and is matched to a persona by the real path of its roots working
 * directory; it registers only while that persona is up, and a persona that
 * stops being up has its session dropped (b.av2 SR-6.3, SR-6.4). Inbound Slack
 * messages go through the receiving persona's pipeline in
 * `persona-routing.ts`: a persona hears the channels it is configured into
 * (every message in a `delivery: all` channel, only its direct mentions in a
 * `delivery: mentions` one) and, with `dm.enabled` on, direct messages to its
 * own app (SR-4.3); group DMs are never delivered. A delivered message reaches
 * that persona's session only. Outbound tool calls post as the session's persona,
 * through its own client, and are scoped to that persona's configured channels
 * and, while its `dm.enabled` is on, its DM conversations and (for `reply`)
 * user IDs (`checkPersonaTarget` in `registry.ts`).
 *
 * SPDX-License-Identifier: MIT
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import type { WebClient } from '@slack/web-api'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, promises as fsPromises } from 'fs'

import { assertSendable as libAssertSendable } from './lib.ts'
import {
  expandTilde,
  credentialsFilesToProtect,
  resolveRealPath,
  resolveServerConfigPath,
  resolveServerStateDir,
  type Persona,
  type PersonaConfig,
  type ReplySettings,
  replySettingsOf,
  agentDirectorCallTimeoutMsOf,
  type ServerSettings,
  MCP_SERVER_NAME,
} from './config.ts'
import { personaInstanceId, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'
import {
  APPROVER_STOP_RETIRED_KEY,
  APPROVER_STOP_TEARDOWN,
  applyOwnRowStatusStep,
  buildLatchRecheck,
  buildLiveRowSequenceDeps,
  cancelWorkingRowWait,
  checkLaunchConfigDir,
  checkPromptRowDeferral,
  checkWaitingRowPane,
  checkWorkingRowPane,
  clearByHandOf,
  carriedDeadEvidenceOf,
  DEAD_SESSION_CAUSE_ROW_READ_FINISHED,
  type DeadEvidenceSource,
  escalateDeadVerdictOfCause,
  ESCALATE_DEAD_REPROBE_DECIDES,
  ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ,
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  type EscalateDeadVerdict,
  endPromptRowDeferral,
  endWorkingRowDeferral,
  forgetNotConnectedEpisode,
  forgetWorkingRowEvidence,
  hasPendingWorkingRowEvidence,
  holdLaunchIfConfigDirUnresolvable,
  isDialogApproverRunning,
  isLaunchInFlight,
  createOldLifeHoldEndRetry,
  forgetOldLifeWaits,
  isOwnRowOldLifeHeld,
  isSequenceOrOldLifeWaitRunning,
  liveRowSequenceGate,
  oldLifeHeldDirectory,
  oldLifeHoldStep,
  personaRetryBlockCause,
  killPersonaInstanceForTeardown,
  latchOnRestartKillOutcome,
  raisePersonaKillFailureAlert,
  retryPersonaKill,
  setKillFailureAlerts,
  setPersonaKillKeepGoingQuery,
  setStuckLaunchEpisodes,
  launchSession,
  noteWorkingRowDeferral,
  notifyDisconnectedWithAutoRestartDisabled,
  notifyPersonaNotConnected,
  notifyRestartCapReached,
  PROMPT_ROW_STATES,
  readPersonaOwnPane,
  readAndStepPendingRow,
  readPersonaRowState,
  reconcileOrphans,
  retryPendingRowStep,
  runPendingRowRuleAtRetry,
  buildPendingRowRuleDeps,
  setPendingRowRule,
  PENDING_ROW_STEP_LATCHED,
  PENDING_ROW_STEP_NO_ROW,
  PENDING_ROW_STEP_NOT_PENDING,
  PENDING_ROW_STEP_REFUSED,
  reconnectMcpWithCause,
  retiredKeyReadingOf,
  setConfigDirUnresolvableHook,
  setConfiguredPersonaQuery,
  setConflictLatch,
  setInvalidFlagsHold,
  setLiveRowSequenceRegistry,
  setOldLifeHolds,
  setOldLifeWaitBindings,
  createOldLifeWaitUnclassifiedErrors,
  type OldLifeWaitUnclassifiedErrors,
  waitsOnKillFailedHold,
  setPreLaunchReplyGuard,
  setPreLaunchTrustPatcher,
  setRetiredKeyStore,
  setSessionNotifier,
  spawnForPersona,
  startLiveRowSequence,
  startupSessionManager,
  stopAllDialogApprovers,
  stopDialogApprover,
  stopLiveRowSequence,
  sweepDeadTmuxChannelWithCause,
  WAITING_ROW_PANE_ABSENT,
  WAITING_ROW_PANE_GONE,
  whenLaunchSettled,
} from './session-manager.ts'
import {
  FULL_PANE_READ_LINES,
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_ENVIRONMENT,
  PANE_READ_GONE,
  PANE_READ_LATCHED,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  paneReadClassNote,
  type PaneReadFailure,
  PROBE_PANE_READ_LINES,
} from './pane-read.ts'
import { createPersonaNotifier } from './persona-notifier.ts'
import {
  createKillFailureAlerts,
  createPersonaEpisodes,
  createTmuxUnresponsiveCondition,
  createUnclassifiedErrorEpisodes,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  personaUnclassifiedErrorEntryText,
  TMUX_UNRESPONSIVE_END_LATCHED,
  TMUX_UNRESPONSIVE_END_RETRY,
  TMUX_UNRESPONSIVE_END_TICK,
  UNCLASSIFIED_ERROR_END_CAPPED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  type KillFailureAlerts,
  type PersonaEpisodes,
  type TmuxUnresponsiveCondition,
} from './persona-episodes.ts'
import {
  bindConflictLatchHolds,
  bindConflictNotice,
  bindLatchRecheck,
  createConflictLatch,
  latchRowStateRead,
  type ConflictLatch,
  type LatchRecheckController,
} from './conflict-latch.ts'
import { createPendingRowRule, endStuckLaunchEpisodeForLatch, PENDING_ROW_COVERED, PENDING_ROW_RULE_GONE } from './pending-row.ts'
import {
  bindInvalidFlagsHoldSetReaction,
  createInvalidFlagsHold,
  endInvalidFlagsHoldsOnVersionChange,
  type InvalidFlagsHold,
} from './invalid-flags-hold.ts'
import { createPersonaDestinations } from './persona-destination.ts'
import { createPersonaDestinationHold } from './persona-destination-hold.ts'
import { createSlowRecoveryTracker } from './slow-recovery.ts'
import { createPersonaRouting, hasSessionStream } from './persona-routing.ts'
import {
  createPersonaConnectionManager,
  SYSTEM_PERSONA_CONNECTION_CLOCK,
  type PersonaConnectionManager,
} from './persona-connections.ts'
import {
  createLiveRowSequenceRegistry,
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_STOP_TEARDOWN,
  type LiveRowSequenceRegistry,
} from './live-row-sequence.ts'
import { KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN, KILL_FAILURE_CONTEXT_RECOVERY } from './kill-failure-alert.ts'
import { resolveSlackApiUrlOverride } from './persona-slack-clients.ts'
import { createUnhandledRejectionHandler, describeThrownValue, renderLogMessageText } from './persona-connection-errors.ts'
import { createPersonaEventRouter } from './persona-event-router.ts'
import {
  composePersonaStatusListeners,
  createPersonaClientLookup,
  createPersonaIdentityLookup,
  createPersonaRelaunchGate,
  createPersonaUpFlushListener,
  createPersonaUpPredicate,
} from './persona-start.ts'
import {
  createNotUpSessionDropper,
  createPersonaBringUpController,
  describePersonaNotUp,
  type PersonaBringUpController,
} from './persona-bringup-controller.ts'
import { createPersonaSerializer } from './persona-serializer.ts'
import { createPersonaLifecycle, type PersonaLifecycle } from './persona-lifecycle.ts'
import { describeKillOutcome, killOutcomeStopsServer } from './checked-kill.ts'
import { KILL_RETRY_SEED_NOT_LIVE_VALUE, KILL_RETRY_SYSTEM_CLOCK, killRetryStopped, type KillRetryWait } from './kill-retry.ts'
import { cleanSession, getCozempicAvailable } from './cozempic.ts'
import { resolveSystemBinary } from 'agent-director'
import {
  ErrSpawnNotFound,
  ErrSystemInstallDisappeared,
} from './agent-director-errors.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_ENVIRONMENT,
  classifyAdError,
  describeAdFailureForLog,
  isAdErrorInstance,
} from './ad-error-class.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_DEAD_ROW_NO_ROW,
  LIVENESS_LIVE,
  LIVENESS_READING_DEAD,
  LIVENESS_READING_DEAD_NO_ROW,
  LIVENESS_READING_DEAD_INSTALL_GONE,
  LIVENESS_READING_UNKNOWN,
  LIVENESS_UNKNOWN,
  livenessReadingForStatus,
  pendingLaunchStartOf,
  type DeadLivenessReading,
  type DeadRowRead,
  type LivenessReading,
} from './liveness-reading.ts'
import { getClient, closeClient } from './agent-director-client.ts'
import { trustBootstrap, trustPatchPersona } from './trust-bootstrap.ts'
import { runJsonlPersistenceSafeguard, runPersonaStorageCheck } from './jsonl-persistence-check.ts'
import {
  getLaunchedWithDir,
  preLaunchReplyGuard,
  stopHookBootstrap,
  stopHookLaunchPass,
  teardownPersonaReplyGuard,
} from './stop-hook-bootstrap.ts'
import { forgetPersonaPrompts, startPermissionPoller, stopPermissionPoller } from './permission-poller.ts'
import {
  initRestart,
  scheduleRestart,
  cancelAllRestartTimers,
  cancelRestartTimer,
  isRestartPendingOrActive,
  runRestartRetry,
  KILL_SESSION_NOT_KILLED_GUARD,
  RESTART_FAILURE_CAP,
  type KillSessionResult,
  type ReconnectEscalateDead,
} from './restart.ts'
import {
  createFullModeRetryAction,
  createUnavailableRetryController,
  holdsLatchRecheckPermit,
  isInsideTimerRetry,
  runDetachedRecoveryAttempt,
  runOutsideAttempts,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_HELD,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type RetryRunGateDeps,
  type UnavailableRetryController,
} from './unavailable-retry.ts'
import {
  buildPersonaWorkList,
  forgetDisconnectedStreak,
  initHealthCheck,
  startHealthCheck,
  stopHealthCheck,
} from './health-check.ts'
import { forgetFailures, isAtCap as backoffIsAtCap } from './backoff.ts'
import { isDryRun } from './tokens.ts'
import { checkPidConflict, writePidFile, removePidFile } from './pid.ts'
import { consumeAck, forgetPersonaAcks } from './ack-tracker.ts'
import {
  openArchiveDatabase,
  createPersonaArchiveWriter,
  createPersonaNameResolverSource,
} from './message-archive.ts'
import {
  registerSession,
  unregisterByMcpSessionId,
  getSessionByPersona,
  decideSessionAdmission,
  dropPersonaSession,
  resolveTransportForRequest,
  registerMcpSessionId,
  createSessionServer,
  getAllSessions,
  createPendingSession,
  getPendingSession,
  removePendingSession,
  getAllPendingSessions,
  closePendingSession,
  type ClosePendingSessionDeps,
  type SessionToolDeps,
  type SessionEntry,
} from './registry.ts'
import { buildPersonaClientOrExit, runAgentDirectorStartupGate } from './agent-director-startup.ts'
import { disposeAdVersionRecheck, installAdVersionRecheck, onAdVersionChanged } from './ad-version-gate.ts'
import {
  adAlertThresholdMsInEffect,
  adSettingsInEffect,
  checkAdCallTimeoutAtStartup,
  installAdSettings,
  type AdSettingsInEffect,
} from './ad-settings.ts'
import { armShutdownDeadline } from './shutdown-deadline.ts'
import { recordStartupError } from './startup-errors.ts'
import { installSlackChannelBotTemplate } from './agent-director-template.ts'
import { createCronLog } from './cron-log.ts'
import { createCronDispatcher } from './cron-dispatch.ts'
import { handleInterject } from './interject.ts'
import {
  CLEAR_LATCH_ROUTE,
  handleClearLatch,
  removeServerPortRecord,
  serverPortFilePath,
  serverPortWriteFailedLine,
  writeServerPortRecord,
} from './clear-latch.ts'
import { createCronScheduler, type CronScheduler } from './cron-scheduler.ts'
import { configInEffect, createReloadController, reloadFilePaths, type ReloadController } from './reload.ts'
import { createReloadTickDriver } from './reload-timer.ts'
import { createOldLifeHoldSet, readRetiredKeysAtStart, type OldLifeHoldSet, type RetiredKeyStore } from './retired-keys.ts'
import { PRODUCTION_SLACK_CLIENT_FACTORY } from './persona-slack-clients.ts'
import { initOutageState, getOutageFlags, setOutageFlag, clearOutageFlag, raiseAdConfigMalformed, raiseTmuxUnavailable, resetAllToHealthy, withOutageDetection, reportAgentDirectorError } from './outage-state.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-request HTTP access-line verbosity gate (b.3k6).
 *
 * The `/mcp` endpoint's `fetch` handler is hit on every MCP round-trip — client
 * polls, notifications, tool-call responses, and each SSE stream open — so a
 * one-line-per-request access log is the highest-frequency routine "success"
 * line left in server.log after b.brv silenced the SubprocessClient dumps. It
 * has the same signal/noise profile: routine and continuous at steady state,
 * useful only when debugging a specific transport/session-routing problem.
 *
 * OFF by default (mirrors b.brv's CSCB_AD_VERBOSE). Set CSCB_HTTP_VERBOSE to a
 * truthy value (`1`, `true`, `yes`, `on`, case-insensitive) to restore the
 * per-request line for transport debugging. Real events (session connect /
 * disconnect / persona mismatch / errors) are logged unconditionally elsewhere.
 *
 * Exported as an env-parameterized seam (mirrors b.brv's isVerbose in
 * agent-director-logger.ts) so behavior can be tested by injecting `env`;
 * the call site passes no argument and reads process.env per request.
 */
export const HTTP_VERBOSE_ENV = 'CSCB_HTTP_VERBOSE'

export function isHttpVerbose(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HTTP_VERBOSE_ENV]
  if (raw === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = resolveServerStateDir()
/** The configuration file main() loads; the file guard also reads it (b.av2 SR-5.2). */
const CONFIG_PATH = resolveServerConfigPath()
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'server.pid')
/** The listener's PID-and-port record beside the PID file (b.jg5 SRJ-510). */
const SERVER_PORT_FILE = serverPortFilePath(STATE_DIR)
const KEEP_ALIVE_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// SSE keep-alive — prevents idle stream disconnection
// ---------------------------------------------------------------------------

const keepAliveTimers = new Map<WebStandardStreamableHTTPServerTransport, ReturnType<typeof setInterval>>()

export function startSseKeepAlive(transport: WebStandardStreamableHTTPServerTransport): void {
  const id = setInterval(() => {
    const streamEntry = (transport as any)._streamMapping?.get('_GET_stream')
    if (streamEntry?.controller && streamEntry?.encoder) {
      try {
        streamEntry.controller.enqueue(streamEntry.encoder.encode(':ping\n\n'))
      } catch {
        clearInterval(id)
        keepAliveTimers.delete(transport)
      }
    }
  }, KEEP_ALIVE_INTERVAL_MS)
  keepAliveTimers.set(transport, id)
}

export function stopSseKeepAlive(transport: WebStandardStreamableHTTPServerTransport): void {
  const id = keepAliveTimers.get(transport)
  if (id !== undefined) {
    clearInterval(id)
    keepAliveTimers.delete(transport)
  }
}

export function stopAllKeepAliveTimers(): void {
  for (const id of keepAliveTimers.values()) {
    clearInterval(id)
  }
  keepAliveTimers.clear()
}

// ---------------------------------------------------------------------------
// Persona Slack connections (b.av2 SR-3.1)
//
// The connection manager is constructed in main(); nothing Slack-related is
// built or read at import. Until then every lookup below answers "no client".
// ---------------------------------------------------------------------------

let connections: PersonaConnectionManager | undefined

/**
 * The per-persona bring-up outcomes and retries; built in main(), told of
 * every connection status by the manager's listener, cancelled on shutdown.
 */
let bringUps: PersonaBringUpController | undefined

/**
 * The per-persona UNAVAILABLE retry timers (b.jg5 SRJ-301, SRJ-303,
 * SRJ-305); built in main() before the start pass, closed on shutdown.
 */
let unavailableRetry: UnavailableRetryController | undefined

/**
 * The per-persona latch re-check timers (b.jg5 SRJ-505); built in main()
 * before the start pass, every timer stopped on shutdown.
 */
let latchRecheckTimers: LatchRecheckController | undefined

/**
 * The per-persona notice episodes (b.jg5 SRJ-1016); built in main() before
 * the start pass, every episode forgotten on shutdown.
 */
let personaEpisodes: PersonaEpisodes | undefined

/**
 * The old-life wait's unclassified-error episodes (b.jg5 SRJ-313, SRJ-811),
 * keyed by held instance id in an episodes instance of their own; built in
 * main() with the wait's bindings, every episode ended on shutdown.
 */
let oldLifeWaitUnclassifiedErrors: OldLifeWaitUnclassifiedErrors | undefined

/**
 * The kill-failure alerts (b.jg5 SRJ-704, SRJ-1016), for the lost-message
 * state's kill-failed query (SRJ-1011 state 4); built in main() over the
 * notice episodes, before the start pass. Undefined before then, when no
 * kill-failure episode is open.
 */
let personaKillFailureAlerts: Pick<KillFailureAlerts, 'isOpen'> | undefined

/**
 * The server's one per-persona latch (b.jg5 SRJ-501), for the lost-message
 * state's latched query; built in main() before the start pass. Undefined
 * before then, when no persona is latched.
 */
let personaLatch: Pick<ConflictLatch, 'isLatched'> | undefined

/**
 * The server's one `ErrInvalidFlags` hold (b.jg5 SRJ-207), for the
 * lost-message state's cannot-launch query (SRJ-1011 state 3) and shutdown's
 * forget-all; built in main() before the start pass. Undefined before then,
 * when no persona is held.
 */
let personaInvalidFlagsHold: Pick<InvalidFlagsHold, 'isHeld' | 'forgetAll'> | undefined

/**
 * The server's one live-row sequence registry (b.jg5 SRJ-706), built and
 * installed in the session manager in main() before the start pass; closed
 * by shutdown(). Undefined before then, when no sequence runs.
 */
let liveRowSequences: LiveRowSequenceRegistry | undefined

/**
 * b.jg5 SRJ-303: true while work in flight for the persona blocks a retry of
 * its retry timer: a launch call (`isLaunchInFlight`), a running live-row
 * sequence (`isLiveRowSequenceRunning`, b.jg5 SRJ-706), or an old-life wait
 * step for a hold the persona waits on (`isOldLifeWaitRunningFor`, b.jg5
 * SRJ-811), each false before main() installs the registry, the hold set and
 * the wait's bindings: exactly when the session manager's
 * `personaRetryBlockCause` names one, which the retry controller also gets
 * (`retryBlockCause`) to name it in the again-reason and the restart retry's
 * skip line. A running dialog approver is not here: it runs after its
 * launch call has returned and never blocks a retry (SRJ-401). Given to the
 * retry controller (`isInFlight`). Every member here is also in flight for
 * the persona (`isPersonaWorkInFlight` is built from this), so the tick
 * never attempts over work that holds back the retry timer.
 */
function isPersonaRetryBlocked(key: string): boolean {
  return personaRetryBlockCause(key) !== undefined
}

/**
 * b.jg5 SRJ-315, SRJ-1011 (Terms, "In flight for P"): true while work is in
 * flight for the persona: anything that blocks a retry
 * (`isPersonaRetryBlocked`), or a running dialog approver
 * (`isDialogApproverRunning`, SRJ-401). Given to the health tick's in-flight
 * member (`isLaunchInFlight`), the lost-message routing's read gate
 * (`isWorkInFlight`) and the `tmux-unavailable` retry check
 * (`armMissingTmuxUnavailableRetry`, for the session disconnect handler and
 * the lost-message routing), which mirrors the tick's own check.
 */
function isPersonaWorkInFlight(key: string): boolean {
  return isPersonaRetryBlocked(key) || isDialogApproverRunning(key)
}

/**
 * b.jg5 SRJ-311: arm the persona's UNAVAILABLE retry timer with the
 * ENVIRONMENT cause, the `tmux-unavailable` outage's own class, on the
 * controller main() builds (read at call time; nothing is armed before it
 * exists). The one arm path for a persona held off on that outage with no
 * timer: the health tick's `armRetryTimer` and the `tmux-unavailable` retry
 * check (`armMissingTmuxUnavailableRetry`, for the session disconnect handler
 * and the lost-message routing) both call it. An arm while the timer is armed
 * or running keeps its due time and wait count.
 */
function armEnvironmentRetryTimer(key: string): void {
  unavailableRetry?.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT })
}

/**
 * The per-persona `tmux-unresponsive` conditions (b.jg5 SRJ-307), for the
 * lost-message state's holds query; built in main() before the start pass.
 * Undefined before then, when no condition holds.
 */
let personaTmuxUnresponsive: Pick<TmuxUnresponsiveCondition, 'holds'> | undefined

/**
 * The liveness adapter main() builds (`_buildIsSessionAliveAdapter`, the one
 * instance the restart path and the health tick also receive), for the
 * lost-message row read (b.jg5 SRJ-115, SRJ-1011); set in main() before the
 * start bring-up pass. Undefined before then, when no read is made.
 */
let personaRowLiveness: ((key: string) => Promise<LivenessReading>) | undefined

/** The manager's per-persona queries, answering nothing before main() builds it. */
const connectionView: Pick<PersonaConnectionManager, 'status' | 'webClient' | 'identity'> = {
  status: (key) => connections?.status(key),
  webClient: (key) => connections?.webClient(key),
  identity: (key) => connections?.identity(key),
}

/**
 * The persona's Web client: its long-lived client from the connection manager
 * while it is serving (up, lost, or retrying a reopen); undefined otherwise,
 * for an unknown key and in dry run (see `createPersonaClientLookup`).
 */
const clientFor = createPersonaClientLookup(connectionView, () => personaConfig)

/** The persona's bot identity while it is serving; the placeholder identity in dry run. */
const identityFor = createPersonaIdentityLookup(connectionView, () => personaConfig)

/**
 * Whether a persona is up (b.av2 SR-6.4): its connection is serving, its
 * bring-up outcome is `up` and its key is applied (b.av2 SR-8.6). False for
 * every persona before main() builds the controller. The one check behind
 * MCP session admission, the permission poller's skip and `/interject`'s 503
 * (see `createPersonaUpPredicate`).
 */
const isPersonaUp = createPersonaUpPredicate(connectionView, {
  isUp: (key) => bringUps?.isUp(key) ?? false,
  isApplied: (key) => bringUps?.isApplied(key) ?? false,
})

/**
 * The per-persona lifecycle serializer (b.av2 SR-6.6): a restart timer's
 * work, each bring-up retry attempt with its launch, and the apply's
 * lifecycle operations run through it, one at a time per persona. Holds
 * nothing until the first operation.
 */
const personaLifecycle = createPersonaSerializer()

/** A not-up persona's outcome and cause, for the refusal and session-drop lines. */
function describePersonaNotUpByKey(key: string): string {
  return describePersonaNotUp(bringUps?.state(key))
}

/** Installed once, in main(), before any persona connects. */
let unhandledRejectionHandlerInstalled = false

// ---------------------------------------------------------------------------
// Message archive — write every inbound Slack message to SQLite (feature-gated)
// ---------------------------------------------------------------------------

/**
 * The archive writer for the receiving persona (name lookups on its own
 * client), set in main() when `message_archive_db` is configured. Undefined
 * when the archive is disabled.
 */
let archiveWrite: ((key: string, event: unknown) => void) | undefined

// Permission relay state lives in src/permission-poller.ts (SR-2.1 polling
// model). AskUserQuestion is denied at the agent-director template level
// (SR-3.1); the prior in-process pendingQuestions registry has been
// removed (SR-7.1).

// ---------------------------------------------------------------------------
// Security — assertSendable (file exfiltration guard)
// ---------------------------------------------------------------------------

/**
 * Refuses files under the state directory outside the inbox, and every
 * persona credentials file named by the applied config or by the config file
 * currently on disk (b.av2 SR-5.2): the reload controller's guard source,
 * which main() builds. The protected list is built per call. Before main()
 * builds the controller there is no applied config, and the config file's
 * paths are still refused.
 */
function assertSendable(filePath: string): void {
  const protectedPaths = reloadController?.protectedCredentialsFiles() ?? credentialsFilesToProtect([], CONFIG_PATH)
  libAssertSendable(filePath, resolve(STATE_DIR), resolve(INBOX_DIR), protectedPaths)
}

// ---------------------------------------------------------------------------
// Resolve user display name
// ---------------------------------------------------------------------------

// One cache for every persona: the server serves one workspace (b.av2 SR-11).
const userNameCache = new Map<string, string>()

async function lookupUserName(client: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!
  try {
    const res = await client.users.info({ user: userId })
    const name =
      res.user?.profile?.display_name ||
      res.user?.profile?.real_name ||
      res.user?.name ||
      userId
    userNameCache.set(userId, name)
    return name
  } catch {
    return userId
  }
}

/**
 * Display name for a persona's inbound dispatch or tool call, looked up on the
 * persona's client; the user ID itself when the persona has no client.
 */
function resolvePersonaUserName(personaKey: string, userId: string): Promise<string> {
  const client = clientFor(personaKey)
  return client ? lookupUserName(client, userId) : Promise.resolve(userId)
}

// ---------------------------------------------------------------------------
// Tool dependencies shared by all session servers. Each tool call reads the
// persona and its client through these at call time (b.av2 SR-5.1).
// ---------------------------------------------------------------------------

const sessionToolDeps: SessionToolDeps = {
  assertSendable,
  getReplySettings,
  getPersona: getAppliedPersona,
  clientFor,
  inboxDir: INBOX_DIR,
  resolveUserName: resolvePersonaUserName,
  consumeAck,
  serverPort: 0, // updated to actual port in main() before Bun.serve
}

// ---------------------------------------------------------------------------
// Pending session factory
//
// Creates a Transport + Server pair for an init request before the session's
// persona is known. The session is held in the pending map until roots/list
// matches its working directory to a persona.
// ---------------------------------------------------------------------------

/**
 * Which branch {@link armMissingTmuxUnavailableRetry} took for a persona
 * (b.jg5 SRJ-311), the first that applies:
 *   - `not-raised`: its `tmux-unavailable` outage is not raised; nothing done;
 *   - `retry-armed`: its retry timer is armed (waiting or running); nothing done;
 *   - `latched`: it is latched; nothing armed;
 *   - `in-flight`: work is in flight for it; nothing armed;
 *   - `no-controller`: there is no retry controller to ask (`isRetryArmed`
 *     answered neither true nor false); nothing armed;
 *   - `armed`: none of the above, and its retry timer was armed.
 */
export type TmuxUnavailableRetryBranch =
  | 'not-raised'
  | 'retry-armed'
  | 'latched'
  | 'in-flight'
  | 'no-controller'
  | 'armed'

/** The dependencies of {@link armMissingTmuxUnavailableRetry}, each asked at call time. */
export interface TmuxUnavailableRetryDeps {
  /** Whether the persona's `tmux-unavailable` outage flag is raised. */
  isTmuxUnavailable(key: string): boolean
  /**
   * Whether the persona has a retry timer, waiting or running (production:
   * the retry controller's `isArmed`); `undefined` when there is no
   * controller. Only exactly `false` lets a timer be armed.
   */
  isRetryArmed(key: string): boolean | undefined
  /** Whether the persona is latched (production: the server's one latch). Only exactly `true` counts. */
  isLatched(key: string): boolean
  /** Whether work is in flight for the persona (production: `isPersonaWorkInFlight`). */
  isWorkInFlight(key: string): boolean
  /** Arm the persona's retry timer with the ENVIRONMENT cause (production: `armEnvironmentRetryTimer`). */
  armRetryTimer(key: string): void
  /** Writes one log line. */
  log(line: string): void
}

/**
 * b.jg5 SRJ-311: while persona `key`'s `tmux-unavailable` outage is raised,
 * the only attempt made for it is its retry timer's, one per backoff
 * interval, whatever `session_restart_delay` and `health_check_interval`
 * are. A raised flag does not guarantee a timer: a retry that stopped as not
 * up, on a declined launch or on a failed run leaves the flag raised with
 * none, and then nothing would ever attempt for it. So when the flag is
 * raised, no timer is armed (`isRetryArmed` answers exactly false), the
 * persona is not latched and nothing is in flight for it, this logs
 * `armLine` and arms its timer; otherwise it does nothing. The armed read is
 * made once, before the latch and in-flight checks. Answers the branch it
 * took. It never schedules a restart: arming the timer is the outage's own
 * retry, not a human-triggered restart (SRJ-1501). The session-disconnect
 * handler (`_buildRestartDisconnectedPersona`) and the lost-message routing
 * (`armRetryTimerIfMissing`) both decide through it.
 */
export function armMissingTmuxUnavailableRetry(
  key: string,
  deps: TmuxUnavailableRetryDeps,
  armLine: string,
): TmuxUnavailableRetryBranch {
  if (!deps.isTmuxUnavailable(key)) return 'not-raised'
  const armed = deps.isRetryArmed(key)
  if (armed === true) return 'retry-armed'
  if (deps.isLatched(key) === true) return 'latched'
  if (deps.isWorkInFlight(key)) return 'in-flight'
  if (armed !== false) return 'no-controller'
  deps.log(armLine)
  deps.armRetryTimer(key)
  return 'armed'
}

/**
 * The production dependencies of {@link armMissingTmuxUnavailableRetry}: the
 * outage state's flag, the retry controller and the latch through the
 * holders main() sets (read at call time: before main() builds them there is
 * no controller and no persona is latched), "in flight for P" as the health
 * tick takes it (`isPersonaWorkInFlight`, a running dialog approver included)
 * and the one ENVIRONMENT arm path.
 */
const tmuxUnavailableRetryDeps: TmuxUnavailableRetryDeps = {
  isTmuxUnavailable: (key) => getOutageFlags(key).has('tmux-unavailable'),
  isRetryArmed: (key) => unavailableRetry?.isArmed(key),
  isLatched: (key) => personaLatch?.isLatched(key) === true,
  isWorkInFlight: isPersonaWorkInFlight,
  armRetryTimer: armEnvironmentRetryTimer,
  log: (line) => console.error(line),
}

/** The dependencies of {@link _buildRestartDisconnectedPersona}. */
export interface RestartDisconnectedPersonaDeps extends TmuxUnavailableRetryDeps {
  /** The applied persona with this key, read at call time; undefined when there is none. */
  getPersona(key: string): Persona | undefined
  /** Schedule a restart of the persona in its working directory (production: `restart.ts`'s `scheduleRestart`). */
  scheduleRestart(key: string, cwd: string): void
  /** Whether the server is shutting down (production: the flag `shutdown()` raises). */
  isShuttingDown(): boolean
}

/**
 * _buildRestartDisconnectedPersona — the session-disconnect handler over its
 * dependencies; `server.ts` builds the one production instance,
 * `restartDisconnectedPersona`, bound to the real holders at call time.
 *
 * A registered session for persona `key` closed: log it and schedule a
 * restart of that persona in its working directory. `via` qualifies the log
 * line (e.g. ` (SSE abort)`). A key that is not an applied persona gets one
 * line and nothing more.
 *
 * While the server is shutting down (the HTTP server's stop aborts every MCP
 * stream, which lands here), it logs one skip line, the one
 * `scheduleRestart` logs then, and does nothing more: no restart, no arm.
 *
 * b.jg5 SRJ-311: while the persona's `tmux-unavailable` outage is raised, the
 * retry timer's retries, one per backoff interval, are the only attempts made
 * for it, so no restart is ever scheduled here, and one line says what was
 * done instead (`armMissingTmuxUnavailableRetry` decides):
 *   - its retry timer is armed: nothing more;
 *   - it is latched or work is in flight for it: nothing is armed;
 *   - there is no retry controller: nothing is armed;
 *   - otherwise its timer is armed with the ENVIRONMENT cause, so a retry
 *     comes even with `session_restart_delay` 0 and `health_check_interval` 0.
 *
 * @internal
 */
export function _buildRestartDisconnectedPersona(
  deps: RestartDisconnectedPersonaDeps,
): (key: string, via: string) => void {
  return (key, via) => {
    const persona = deps.getPersona(key)
    if (!persona) {
      deps.log(`[slack] Session disconnected${via}: persona=${key} is not an applied persona`)
      return
    }
    const ref = renderPersonaRef(persona.name, persona.key)
    deps.log(`[slack] Session disconnected${via}: persona ${ref} cwd="${persona.working_directory}"`)
    if (deps.isShuttingDown()) {
      deps.log(`[slack] Skipping restart — server is shutting down (persona=${key})`)
      return
    }
    const head = `[slack] Session disconnected${via}: persona ${ref} has its tmux-unavailable outage raised`
    const branch = armMissingTmuxUnavailableRetry(
      key,
      deps,
      `${head} with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)`,
    )
    switch (branch) {
      case 'not-raised':
        // Session-id resume is owned by agent-director (SR-1.3); launchSession
        // relaunches the persona in its own working directory.
        deps.scheduleRestart(key, persona.working_directory)
        return
      case 'retry-armed':
        deps.log(`${head} — no restart scheduled; its retry timer recovers it (b.jg5 SRJ-311)`)
        return
      case 'latched':
        deps.log(`${head} and is latched — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-502)`)
        return
      case 'in-flight':
        deps.log(`${head} with work in flight — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-315)`)
        return
      case 'no-controller':
        deps.log(`${head} and no retry controller — no restart scheduled, no retry timer armed (b.jg5 SRJ-311)`)
        return
      case 'armed':
        return
    }
  }
}

/**
 * The one session-disconnect handler, reached from a registered session's
 * close and its SSE abort (see `_buildRestartDisconnectedPersona`), over the
 * applied-persona lookup, `restart.ts`'s `scheduleRestart`, the shutdown flag
 * and the production `tmuxUnavailableRetryDeps`, each read at call time.
 */
const restartDisconnectedPersona = _buildRestartDisconnectedPersona({
  ...tmuxUnavailableRetryDeps,
  getPersona: getAppliedPersona,
  scheduleRestart: (key, cwd) => scheduleRestart(key, cwd),
  isShuttingDown: () => shuttingDown,
})

/**
 * Drop the session registered for persona `key` (`dropPersonaSession`: the
 * registry entry and its MCP session IDs go before the transport closes, so
 * neither `onsessionclosed` nor the SSE abort restarts anything) and stop its
 * SSE keep-alive. Resolves whether a session was registered.
 */
async function dropPersonaSessionAndKeepAlive(key: string): Promise<boolean> {
  const session = getSessionByPersona(key)
  if (session) stopSseKeepAlive(session.transport)
  return dropPersonaSession(key)
}

function initPendingSession(): { pendingId: string; transport: WebStandardStreamableHTTPServerTransport } {
  const pendingId = crypto.randomUUID()

  // Stub entry the session's tool handlers close over. Its persona key stays
  // empty (tools refuse) until roots matching promotes this same object in
  // place with the persona key and the real-path cwd.
  const entryStub: SessionEntry = {
    cwd: '',
    personaKey: '',
    transport: null as unknown as WebStandardStreamableHTTPServerTransport,
    server: null as unknown as import('@modelcontextprotocol/sdk/server/index.js').Server,
    connected: true,
    peerPort: 0,
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => pendingId,
    onsessioninitialized: (_mcpSessionId) => {
      // Transport-level init. Roots resolution happens via server.oninitialized.
    },
    onsessionclosed: (mcpSessionId) => {
      stopSseKeepAlive(transport)
      // Session closed — clean up pending or registered state
      const pending = getPendingSession(mcpSessionId)
      if (pending) {
        removePendingSession(mcpSessionId)
        console.error(`[slack] Session disconnected: pending (not yet matched to a persona)`)
        return
      }
      const key = unregisterByMcpSessionId(mcpSessionId)
      if (key) restartDisconnectedPersona(key, '')
    },
  })

  entryStub.transport = transport
  startSseKeepAlive(transport)

  // Build the MCP server (its tools close over entryStub)
  const server = createSessionServer(entryStub, sessionToolDeps)
  entryStub.server = server

  // Set roots handler — fires after MCP initialized notification
  server.oninitialized = () => {
    const caps = server.getClientCapabilities()
    const clientInfo = server.getClientVersion?.() ?? (server as any)._clientVersion
    console.error(`[slack] Session "${pendingId}" initialized`)
    console.error(`[slack]   Client: ${JSON.stringify(clientInfo)}`)
    console.error(`[slack]   Capabilities: ${JSON.stringify(caps)}`)
    handleInitialized(pendingId, server).catch((err) => {
      console.error(`[slack] Error in roots handler for session "${pendingId}":`, err)
    })
  }

  // Store as pending — pass entryStub so the promotion path can mutate it in
  // place, keeping tool handler closures in sync with the registry entry.
  createPendingSession(pendingId, transport, server, entryStub)

  // Wire server to transport
  server.connect(transport).catch((err) => {
    console.error(`[slack] Error connecting MCP server for pending session "${pendingId}":`, err)
    removePendingSession(pendingId)
  })

  return { pendingId, transport }
}

// ---------------------------------------------------------------------------
// Roots-based session identification
//
// Called after the MCP initialized notification. Calls roots/list on the
// client and matches the first root's directory, by real path, to exactly one
// applied persona (b.av2 SR-6.3), admitting it only while that persona is up
// (SR-6.4, `decideSessionAdmission`), and never while that directory is held
// for an old life that may still be running (SR-6.3 as amended by b.jg5
// SRJ-1505; SRJ-810). On admission: promotes the pending session to
// registered under the persona key. On no match, a held directory, a persona
// that is not up, or an error: disconnects it.
// ---------------------------------------------------------------------------

/**
 * Wait for the client to open a GET SSE stream on the transport.
 * The MCP SDK silently drops server-to-client requests when no SSE stream
 * is available, so we must wait before calling roots/list.
 */
async function waitForSseStream(
  transport: WebStandardStreamableHTTPServerTransport,
  timeoutMs = 10_000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Check the transport's internal stream mapping for the standalone GET stream
    if ((transport as any)._streamMapping?.has('_GET_stream')) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

/**
 * How `handleInitialized` disconnects a pending session it will not register
 * (`closePendingSession`): the pending map's remove and this module's SSE
 * keep-alive stop.
 */
const pendingSessionCloseDeps: ClosePendingSessionDeps<WebStandardStreamableHTTPServerTransport> = {
  removePending: removePendingSession,
  stopKeepAlive: stopSseKeepAlive,
}

async function handleInitialized(
  pendingId: string,
  server: import('@modelcontextprotocol/sdk/server/index.js').Server,
): Promise<void> {
  // Get the pending session's transport so we can wait for SSE stream
  const pendingEntry = getPendingSession(pendingId)
  if (!pendingEntry) {
    console.error(`[slack] Pending session "${pendingId}" disappeared before roots resolution`)
    return
  }

  // Wait for the client to open the GET SSE stream before sending roots/list.
  // Without this, the transport silently drops the request (no delivery channel).
  const sseReady = await waitForSseStream(pendingEntry.transport)
  if (!sseReady) {
    console.error(`[slack] Timed out waiting for SSE stream from session "${pendingId}" — disconnecting`)
    await closePendingSession(pendingId, pendingEntry.transport, pendingSessionCloseDeps)
    return
  }

  let roots: { uri: string }[]

  try {
    const result = await server.listRoots()
    roots = result.roots
  } catch (err) {
    console.error(`[slack] roots/list failed for pending session "${pendingId}":`, err)
    const pending = getPendingSession(pendingId)
    if (pending) await closePendingSession(pendingId, pending.transport, pendingSessionCloseDeps)
    return
  }

  if (!roots.length) {
    console.error(`[slack] Pending session "${pendingId}" reported no roots — disconnecting`)
    const pending = getPendingSession(pendingId)
    if (pending) await closePendingSession(pendingId, pending.transport, pendingSessionCloseDeps)
    return
  }

  // Extract filesystem path from file:// URI (use first root as CWD).
  // fileURLToPath handles percent-encoded characters and the triple-slash convention.
  const rawCwd = fileURLToPath(roots[0].uri)
  const rootsPath = resolve(expandTilde(rawCwd))
  const realCwd = resolveRealPath(rootsPath)

  // b.av2 SR-6.3 / SR-6.4: match by real path, then admit only an up persona.
  // b.jg5 SRJ-810, SRJ-1505: before any persona is matched, a session opened
  // from a directory held for an old life is refused, whichever persona
  // names it, with the one line the admission logs; the hold set is read at
  // call time, so before main() installs it nothing is held.
  // A refused session is disconnected like an unmatched one; the persona's
  // registered session, if any, is left as it is.
  const admission = decideSessionAdmission(rootsPath, personaConfig?.personas ?? [], {
    isPersonaUp,
    describeNotUp: describePersonaNotUpByKey,
    log: (line) => console.error(line),
    heldDirectory: oldLifeHeldDirectory,
  })

  if (admission.kind !== 'admitted') {
    if (admission.kind === 'unmatched') {
      console.error(`[slack] Session connected with CWD "${realCwd}" — no matching persona`)
    }
    const pending = getPendingSession(pendingId)
    if (pending) await closePendingSession(pendingId, pending.transport, pendingSessionCloseDeps)
    return
  }

  const { persona } = admission
  const ref = renderPersonaRef(persona.name, persona.key)
  const existingSession = getSessionByPersona(persona.key)

  // Promote pending → registered (removes from pendingSessionMap internally;
  // the pending stub becomes the registered entry).
  registerSession(realCwd, persona.key, pendingId)
  // b.f2b: connected again, so its not-connected episode (if any) is over:
  // its notice latch and the restart path's idle evidence are forgotten.
  forgetNotConnectedEpisode(persona.key)

  // Register MCP session ID for future HTTP request routing
  registerMcpSessionId(pendingId, persona.key)

  if (existingSession) {
    console.error(`[slack] Session replaced existing connection for persona ${ref}`)
  }
  console.error(`[slack] Session connected: persona ${ref} cwd="${realCwd}"`)
}

// ---------------------------------------------------------------------------
// Inbound delivery per persona (b.av2 SR-4.1, SR-4.2)
// ---------------------------------------------------------------------------

/**
 * The one persona-routing instance. The event router hands each `message`
 * and `app_mention` event to it with the receiving persona as the only
 * receiver.
 */
const personaRouting = createPersonaRouting({
  getPersonaConfig: () => personaConfig,
  getBotIdentity: identityFor,
  clientFor,
  resolveUserName: resolvePersonaUserName,
  archive: (key, event) => archiveWrite?.(key, event),
  getReplySettings,
  // Lost-message notices go through the one notifier. It is built further
  // down, so it is read at call time: naming it here would throw while this
  // module is still loading.
  notify: (key, text, options) => personaNotifier.notify(key, text, options),
  log: (line) => console.error(line),
  // A lost message for a persona that is not up restarts nothing (b.av2 SR-6.4).
  isPersonaUp,
  // b.jg5 SRJ-1011: the lost-message state inputs, each read at call time.
  // The latch and the tmux-unresponsive conditions are built in main(), so
  // before then no persona is latched and no condition holds. State 6's
  // launch-or-approver member: a launch call, or the dialog approver that
  // runs after it returned, in its own registry (SRJ-401). This is not the
  // "in flight for P" predicate below: a live-row sequence or an old-life
  // wait step reports `restarting` instead (the sequence/wait member below).
  isLatched: (key) => personaLatch?.isLatched(key) ?? false,
  isTmuxUnresponsive: (key) => personaTmuxUnresponsive?.holds(key) ?? false,
  isLaunchOrApproverRunning: (key) => isLaunchInFlight(key) || isDialogApproverRunning(key),
  // b.jg5 SRJ-1011: the lost-message read gate's "in flight for P" is the
  // health tick's (isPersonaWorkInFlight: a running approver and a running
  // live-row sequence included), so in-flight work reaches the gate through it.
  isWorkInFlight: isPersonaWorkInFlight,
  // b.jg5 SRJ-706, SRJ-811, SRJ-812, SRJ-1011: while P's live-row sequence,
  // or an old-life wait step for a hold P waits on, runs, a lost message
  // reports `restarting`, asked after states 1 to 5 and before
  // `session-starting`, even while its row reads `pending`, with no status
  // read and no human-triggered restart. Resolved at call time through the
  // session manager's queries, which answer false before main() installs
  // the registry, the hold set and the wait's bindings.
  isSequenceOrWaitRunning: (key) => isSequenceOrOldLifeWaitRunning(key),
  // b.jg5 SRJ-115, SRJ-1011: the lost-message read is the liveness adapter's
  // one `status` for P (no new getClient() site), read at call time; before
  // main() builds the adapter no read is made and the answer is `unknown`,
  // which leaves session-starting out. It runs outside any launch or
  // recovery attempt, so an UNAVAILABLE or UNCLASSIFIED answer arms nothing
  // and opens no episode, while ENVIRONMENT and CONFIG raise their outages
  // and arm the retry timer as from any verb (SRJ-105, SRJ-1501).
  readRowLiveness: (key) => personaRowLiveness?.(key) ?? Promise.resolve(LIVENESS_READING_UNKNOWN),
  // b.jg5 SRJ-1011 as amended: state 5 applies only while P's retry timer is
  // armed. Its notice says CSCB is retrying, so a P whose retry timer is not
  // armed is not reported `not-answering`, whatever condition or flag is
  // raised. The routing also asks the restart cap (SRJ-305) itself, so a P
  // at the cap reports `restart-limit-reached` even while a timer that will
  // stop at its next retry is still armed. Read at call time through the
  // holder main() sets: before main() builds the controller no timer is armed.
  isRetryArmed: (key) => unavailableRetry?.isArmed(key) === true,
  // b.jg5 SRJ-311: before a lost message's state is decided, a P that would
  // be `not-answering` but for the retry-timer gate, with its
  // tmux-unavailable outage raised and below the restart cap (SRJ-305), has
  // its retry timer armed when none is armed, P is not latched and nothing
  // is in flight for it: the same check the session-disconnect handler
  // makes, over the same holders, read at call time. The decision then sees
  // the armed timer and reports `not-answering`. It never schedules a
  // restart (SRJ-1501). While the server is shutting down it arms nothing
  // and logs nothing: shutdown has closed the retry controller, which would
  // refuse the arm.
  armRetryTimerIfMissing: (key) => {
    if (shuttingDown) return
    armMissingTmuxUnavailableRetry(
      key,
      tmuxUnavailableRetryDeps,
      `[slack] Lost message: persona=${key} has its tmux-unavailable outage raised with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)`,
    )
  },
  // b.jg5 SRJ-1011 state 4: P's kill-failure episode is open (the ordinary
  // version of the kill-failure alert was raised at P's destination and its
  // row has not since read `ended` or `missing`, or been found gone), or P
  // waits on an old-life hold whose old key's kill has failed (b.jg5
  // SRJ-812: a teardown, start-sweep or wait kill decided the ordinary
  // version, or the wait's step 5 found the row still live; until the hold
  // ends). Read at call time through the holder main() sets and the session
  // manager's hold query: before main() builds the alerts and installs the
  // hold set, neither holds. The survivor version opens no episode and marks
  // no hold, so it never reports this state.
  isKillFailed: (key) => personaKillFailureAlerts?.isOpen(key) === true || waitsOnKillFailedHold(key),
  // b.jg5 SRJ-1011 state 3, SRJ-207: P is held on ErrInvalidFlags (a reuse
  // spawn's ErrInvalidFlags whose re-check did not stop the server): a lost
  // message reports `cannot-launch` and fires no human-triggered restart.
  // Read at call time through the holder main() sets: before main() builds
  // the hold no persona is held.
  isHeldOnInvalidFlags: (key) => personaInvalidFlagsHold?.isHeld(key) === true,
})

// Permission Block Kit builders moved to src/permission-poller.ts
// (SR-2.1/2.2 — owns the message + action_id encoding).

// ---------------------------------------------------------------------------
// Persona configuration
// ---------------------------------------------------------------------------

/**
 * The applied persona configuration, as main()'s start resolution chose it
 * (b.av2 SR-1, SR-8.7): the last-applied record when there is one, never the
 * edited config file. A confirmed apply's step 1 reassigns it (b.av2 SR-8.6,
 * the reload controller's `onApplied`) to the confirmed persona set with the
 * start-time server-wide values, which apply only at the next start. Null
 * only before main() resolves the start; every getter reads it at call time.
 */
let personaConfig: PersonaConfig | null = null

/**
 * The reload controller (b.av2 SR-8.7): built in main(), which resolves the
 * start through it; the file guard reads its protected credentials files.
 * Undefined before main() builds it (nothing is built or read at import).
 */
let reloadController: ReloadController | undefined

/**
 * The applied persona with this key, read from the current persona config at
 * call time; undefined when there is none. The one by-key lookup: the
 * notifier and the MCP tools both use it.
 */
function getAppliedPersona(key: string): Persona | undefined {
  return personaConfig?.personas.find((p) => p.key === key)
}

/**
 * The server-wide reply settings (b.av2 SR-1.6): `ack_reaction`,
 * `reply_chunk_limit` and `reply_chunk_mode`, read from `personaConfig` at
 * call time. A confirmed apply keeps their start-time values (`configInEffect`),
 * so they change only at the next start (b.av2 SR-8.6). Before main() resolves
 * the start: no reaction and the default chunking (`replySettingsOf`). The one source for the
 * inbound ack step and the `reply` tool.
 */
function getReplySettings(): ReplySettings {
  return replySettingsOf(personaConfig)
}

// ---------------------------------------------------------------------------
// Persona notices (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

/**
 * The one destination resolver (b.av2 SR-7.1): resolves each persona's
 * destination and caches its DM conversation per persona and contact. Shared
 * by the notifier and the permission poller, so they open a persona's DM
 * once. Side-effect-free to build: an empty cache, no timer, no Slack call.
 */
const personaDestinations = createPersonaDestinations({ log: (line) => console.error(line) })

/**
 * The one destination hold (b.av2 SR-7.1): when a post to a persona's
 * destination fails, holds that persona's prompts and notices, retries them
 * on the SR-3.2 backoff and logs one `persona-destination-failed` line per
 * episode. Shared by the notifier and the permission poller, so one persona's
 * prompts and notices share one episode. Built at module scope like the
 * notifier it is given to: side-effect-free, no Slack call, and no timer until
 * a notice is held (the real clock is its default). A persona's teardown reaches a
 * persona's `cancel(key)` here, beside `personaDestinations.forget(key)`;
 * shutdown cancels every persona.
 */
const personaDestinationHold = createPersonaDestinationHold({
  destinations: personaDestinations,
  getPersona: getAppliedPersona,
  clientFor,
  log: (line) => console.error(line),
})

/**
 * The one per-persona notifier. Outage state, the session manager, the JSONL
 * safeguard (installed in main()) and the persona routing's lost-message
 * notices send every persona notice through it.
 * A notice raised while its persona has no client is held, and flushed when
 * that persona reports up (the manager's status listener).
 * b.jg5 SRJ-1003, SRJ-1013: while a persona's teardown window is open (the
 * persona lifecycle opens it for the whole of `runTeardown`), every notice
 * for its key is written instead, one server-log line and one
 * `startup-errors.log` entry (`persona-teardown-notice`, or
 * `persona-kill-survivor` for the kill-failure alert's survivor version)
 * through `recordStartupError` with its default log directory, and so is the
 * all-clear of an outage whose onset the window routed, whenever it comes;
 * none is posted or dropped. Building it writes nothing.
 */
const personaNotifier = createPersonaNotifier({
  getPersona: getAppliedPersona,
  clientFor,
  destinations: personaDestinations,
  destinationHold: personaDestinationHold,
  isDryRun,
  log: (line) => console.error(line),
  recordStartupError: (classLabel, message) => recordStartupError(classLabel, message),
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
let httpServer: ReturnType<typeof Bun.serve> | null = null
let cronScheduler: CronScheduler | null = null

/**
 * The shutdown sequence, reached from SIGTERM / SIGINT (exit code 0) and from
 * the runtime version re-check's stop (`AD_VERSION_RECHECK_STOP_EXIT_CODE`,
 * b.jg5 SRJ-205). `reason` is named in the shutdown line. It stops every
 * timer the server runs (the permission poller, the health check, the
 * runtime version re-check, the reload detection tick, the cron scheduler,
 * restart, UNAVAILABLE retry, bring-up and destination-hold timers,
 * keep-alives), stops every live-row sequence (b.jg5 SRJ-706; none makes a
 * further call, and none starts after it) and every dialog approver (b.jg5
 * SRJ-404; likewise), forgets every persona's notice
 * episodes and `ErrInvalidFlags` hold (b.jg5 SRJ-207), closes HTTP,
 * the MCP transports and the persona Slack connections, releases the
 * agent-director client handle, removes the PID file and exits with
 * `exitCode`. It makes no agent-director call: every worker and row is left
 * as it is, and an apply already under way is not awaited. A second call
 * while one runs is a no-op. Its awaits have no deadline of their own; a
 * re-check stop is bounded by the deadline `main()` arms before calling it
 * (`shutdown-deadline.ts`), and exits with its code even when the process
 * runs out of work first, because that stop sets `process.exitCode`.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stopPermissionPoller()
  stopHealthCheck()
  // The runtime version re-check (b.jg5 SRJ-204): its timers are cleared and
  // a call in flight is never acted on. Its ticks were the only re-reads of
  // agent-director's timing settings (SRJ-209), so those stop with it.
  disposeAdVersionRecheck()
  // The reload detection tick (b.av2 SR-8.2): no further pending-file check.
  reloadController?.stopDetection()
  if (cronScheduler) {
    cronScheduler.stop()
    cronScheduler = null
  }
  // b.jg5 SRJ-706: every running live-row sequence stops (its stop signal set
  // now, so none makes a call after the one in progress returns, and none
  // holds a timer), and no sequence starts after this; a call in progress is
  // not waited for, as for the dialog approvers below. Before the retry
  // controller closes and before the client is released.
  void liveRowSequences?.close().catch((err: unknown) => {
    console.error(`[slack] stopping the live-row sequences on shutdown failed: ${describeThrownValue(err)}`)
  })
  cancelAllRestartTimers()
  // b.jg5 SRJ-305: every persona's UNAVAILABLE retry timer stops, and none is
  // armed again (a launch still in flight that meets UNAVAILABLE arms
  // nothing), so no retry is pending after this and none fires.
  unavailableRetry?.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
  // b.jg5 SRJ-505: every latched persona's re-check timer stops and none is
  // armed again, so no re-check round is due after this; a round already in
  // its turn finishes and schedules nothing. Before the client is released.
  latchRecheckTimers?.stopAll()
  // b.jg5 SRJ-1016: every persona's notice episodes end silently, which
  // cancels every tmux-unresponsive alert check and ends every
  // unclassified-error episode, and none begins again (a launch still in
  // flight that meets UNAVAILABLE or UNCLASSIFIED starts no condition and no
  // episode), so nothing is posted and no alert check is pending after this.
  personaEpisodes?.close()
  // b.jg5 SRJ-313, SRJ-811: the old-life waits' unclassified-error episodes
  // end silently with them, and none begins again.
  oldLifeWaitUnclassifiedErrors?.close()
  // b.jg5 SRJ-207: every persona's ErrInvalidFlags hold ends with the server,
  // with no post and no retry; nothing persists it, so a restart holds nothing.
  personaInvalidFlagsHold?.forgetAll()
  // Every persona's bring-up retry (directory re-checks); the manager's Slack
  // retries stop with stopAll() below.
  bringUps?.cancelAll()
  // Every persona's held notices and destination retry timer; one line per
  // persona whose held notices are dropped unposted.
  personaDestinationHold.cancelAll()
  stopAllKeepAliveTimers()
  // b.jg5 SRJ-404: every running dialog approver is stopped (marked and woken
  // now, so none makes a call after the one in progress returns) and none
  // starts after this; a call in progress is not waited for.
  void stopAllDialogApprovers().catch((err: unknown) => {
    console.error(`[slack] stopping the dialog approvers on shutdown failed: ${describeThrownValue(err)}`)
  })

  console.error(`[slack] Shutting down: ${reason}`)

  if (httpServer) {
    console.error('[slack] Stopping HTTP server')
    httpServer.stop(true)
    httpServer = null
  }

  // Close all pending (not yet routed) MCP transports
  for (const pending of getAllPendingSessions()) {
    console.error('[slack] Closing pending MCP transport (not yet routed)')
    removePendingSession(pending.pendingId)
    try {
      await pending.transport.close()
    } catch { /* ignore */ }
  }

  // Close all active MCP transports
  for (const entry of getAllSessions()) {
    if (entry.connected) {
      console.error(`[slack] Closing MCP transport for CWD "${entry.cwd}"`)
      try {
        await entry.transport.close()
      } catch { /* ignore */ }
      entry.connected = false
    }
  }

  console.error('[slack] Disconnecting persona Slack connections')
  try {
    await connections?.stopAll()
  } catch { /* ignore */ }

  // SR-11 Event 11: release the agent-director Client handle. close() is
  // idempotent + never throws per the library contract, but wrap defensively.
  try {
    closeClient()
  } catch (err) {
    console.error(`[slack] closeClient on shutdown threw (ignored): ${describeThrownValue(err)}`)
  }

  // b.jg5 SRJ-510: the listener's record goes with the PID file.
  removeServerPortRecord(SERVER_PORT_FILE)
  removePidFile(PID_FILE)

  console.error('[slack] Shutdown complete')
  process.exit(exitCode)
}

process.on('SIGTERM', () => { shutdown('received SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { shutdown('received SIGINT').catch(() => process.exit(1)) })

// ---------------------------------------------------------------------------
// _runCallTimeoutStartStep
// ---------------------------------------------------------------------------

/** The dependencies of {@link _runCallTimeoutStartStep}; production defaults for any omitted. */
export interface CallTimeoutStartStepDeps {
  /**
   * Build the persona client with the call timeout and install it as the
   * singleton, closing the gate's client. Production:
   * `buildPersonaClientOrExit`, which on a construct failure or a floor
   * refusal records one startup error and exits non-zero, as the gate does.
   */
  buildPersonaClient: (callTimeoutMs: number) => Promise<unknown>
  /** The values in effect of agent-director's settings. Production: `adSettingsInEffect`. */
  valuesInEffect: () => AdSettingsInEffect
  /** The server log. */
  log: (line: string) => void
}

const PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS: CallTimeoutStartStepDeps = {
  buildPersonaClient: (callTimeoutMs) => buildPersonaClientOrExit(callTimeoutMs),
  valuesInEffect: adSettingsInEffect,
  log: (line) => console.error(line),
}

/**
 * The call-timeout start step (b.jg5 SRJ-213), which `main()` runs once per
 * start, right after the startup read of agent-director's settings and before
 * the template install and the start pass. With `config`, the start-time
 * configuration the start resolved (the last-applied record, else
 * `config.json`), it takes `agent_director_call_timeout_ms` (its default when
 * absent), then:
 * 1. runs the startup check once (`checkAdCallTimeoutAtStartup`): at most one
 *    warning line when the setting is at or below the need or
 *    `[pause] timeout_seconds` holds a value that is not used; a warning
 *    never stops the start and changes no value;
 * 2. builds the persona client with that value and installs it as the
 *    singleton, so every later agent-director call the server makes uses it.
 *
 * Exported for tests (`main()` cannot run in one); production passes no deps.
 *
 * @internal
 */
export async function _runCallTimeoutStartStep(
  config: ServerSettings,
  deps: Partial<CallTimeoutStartStepDeps> = {},
): Promise<void> {
  const d: CallTimeoutStartStepDeps = { ...PRODUCTION_CALL_TIMEOUT_START_STEP_DEPS, ...deps }
  const callTimeoutMs = agentDirectorCallTimeoutMsOf(config)
  checkAdCallTimeoutAtStartup(callTimeoutMs, { log: d.log, valuesInEffect: d.valuesInEffect })
  await d.buildPersonaClient(callTimeoutMs)
}

// ---------------------------------------------------------------------------
// _buildIsSessionAliveAdapter
// ---------------------------------------------------------------------------

/**
 * _buildIsSessionAliveAdapter — test-only factory for the liveness probe the
 * health tick, the restart path and b.d61's re-probe share. Production code
 * wires this via main() as `isSessionAliveAdapter`; tests call it directly
 * without importing the private closure inside main().
 *
 * It answers one of four readings (b.jg5 SRJ-314, `src/liveness-reading.ts`):
 * a `status` result maps through `livenessReadingForStatus` (`pending` →
 * `pending`, carrying the row's raw launch start when the result shows one,
 * b.jg5 SRJ-115; another live state → `live`, `ended` or `missing` → `dead`
 * carrying the state it read, any other state → `unknown`, logged), and clears `ad-unreachable` and
 * `ad-config-malformed` (b.jg5 SRJ-312: agent-director loaded its config and
 * read the store). It
 * never clears `tmux-unavailable` (b.jg5 SRJ-312): a `status` is not
 * tmux-touching, so neither its success nor its `ErrSpawnNotFound` shows tmux
 * answering; only a tmux-touching success or GONE (the outage wrappers), or a
 * check that finds the row live and connected with its stream (the health
 * tick's healthy branch, a retry's healthy row), clears it. A `status` error
 * is decided by class through `src/ad-error-class.ts`:
 *   - `ErrSpawnNotFound` → `dead`, carrying no row as what it read
 *     (`LIVENESS_READING_DEAD_NO_ROW`); clears `ad-unreachable` and
 *     `ad-config-malformed`, as a state answer does;
 *   - `ErrSystemInstallDisappeared` → `dead`, marked as read from no row
 *     (`LIVENESS_READING_DEAD_INSTALL_GONE`: the slow-recovery count resets
 *     on it without ending its episode, b.jg5 SRJ-610); raises
 *     `ad-unreachable` with its binary path;
 *   - `ErrTmuxNotAvailable` (ENVIRONMENT) → `unknown`; raises
 *     `tmux-unavailable` through `raiseTmuxUnavailable` with the error, which
 *     posts SRJ-1021's onset for the re-bound-socket form;
 *   - a CONFIG answer (`ErrConfigMalformed`) → `unknown`; raises
 *     `ad-config-malformed` through `raiseAdConfigMalformed` with the error
 *     (b.jg5 SRJ-316: its one onset per episode, and its raise line), and
 *     logs the shared line below at every read;
 *   - any other thrown value (each UNAVAILABLE form, `ErrCallTimeout`,
 *     CSCB's `UnknownError` wrapper, `ErrInternal`, a name CSCB does not
 *     know, a value that is not an agent-director error) → `unknown`, with
 *     one log line: a `status` error is never read as dead.
 * Every error but `ErrSpawnNotFound` leaves `ad-config-malformed` as it was.
 * A key not in the persona config (or no config) reads `dead` with no
 * `status` call; the relaunch gate refuses such a key before any kill or
 * launch.
 *
 * After its own call it applies the session manager's own-row `status` step
 * (`applyOwnRowStatusStep`, b.jg5 SRJ-115) to the answer: an UNUSABLE NAME
 * answer latches the persona (b.jg5 SRJ-512; it is never reported as an
 * unclassified error, and arms nothing), and so does a latch decision of the
 * row-read rule over a returned result: a configured persona's own row
 * that reads `pending` with no launch start latches it with "launch start
 * not recorded" (b.jg5 SRJ-513), so such a row is never read `pending` and
 * never handed to `deferPendingRow`. The step reads the result whole, its
 * `launch_started_at` included. An answer that latched the persona
 * reads `unknown` (`livenessLatchedReading`), so the restart work, the
 * health tick and the lost-message routing ask the latch next. The step also
 * ends an old-life hold on `cscb_<key>` when the row reads `ended` or
 * `missing`, or the answer is `ErrSpawnNotFound`, and keeps it on any live
 * reading, `pending` included (b.jg5 SRJ-809), so this read needs no hold
 * call of its own.
 *
 * Its bare `status` is the one persona call not made through the outage
 * wrappers, so its error branches report the error themselves
 * (`reportAgentDirectorError` with the verb `status`): inside a restart run
 * it arms the persona's retry timer (b.jg5 SRJ-301), and from the health
 * tick, which runs outside every attempt, it arms nothing, except for an
 * ENVIRONMENT or CONFIG answer, which arms the persona's timer in any context
 * (b.jg5 SRJ-311, SRJ-316). Inside a restart run an UNCLASSIFIED answer (an
 * `ErrInternal`, a store-open name, a name CSCB gives no handling) is also
 * reported to the persona's unclassified-error episode (b.jg5 SRJ-313), but
 * `ErrSystemInstallDisappeared` is not: it keeps its `dead` reading (SRJ-105,
 * SRJ-314). From the health tick nothing is reported.
 *
 * The same instance is the persona routing's lost-message row read (b.jg5
 * SRJ-115, SRJ-1011), made from the Slack event path, outside any launch or
 * recovery attempt, as the health tick's is; a read there that latched the
 * persona makes the lost message report it held for a human, with no
 * restart, since the routing decides its states again after the read. An UNAVAILABLE or UNCLASSIFIED
 * answer arms no retry timer and opens no unclassified-error episode, and,
 * `status` not being tmux-touching, no answer starts a `tmux-unresponsive`
 * condition; an ENVIRONMENT or CONFIG answer raises its outage and arms the
 * retry timer, and `ErrSystemInstallDisappeared` raises `ad-unreachable` and
 * reads `dead` (SRJ-105, SRJ-1501).
 *
 * @internal
 */
export function _buildIsSessionAliveAdapter(
  getPersonaConfig: () => PersonaConfig | null | undefined,
): (key: string) => Promise<LivenessReading> {
  // `key` is the persona key.
  return async (key: string) => {
    const config = getPersonaConfig()
    if (!config?.personas.some((p) => p.key === key)) return LIVENESS_READING_DEAD
    const claude_instance_id = personaInstanceId(key)
    try {
      const r = await getClient().status({ claude_instance_id })
      // b.jg5 SRJ-312: a `status` is not tmux-touching, so its success never
      // clears `tmux-unavailable`. It reads agent-director's store, so it
      // clears `ad-unreachable` and `ad-config-malformed`.
      clearOutageFlag(key, 'ad-unreachable')
      clearOutageFlag(key, 'ad-config-malformed')
      // b.jg5 SRJ-115: the own-row rules over this answer; a read that
      // latched the persona reads `unknown`. b.jg5 SRJ-809: the same step
      // ends an old-life hold on cscb_<key> when the row reads `ended` or
      // `missing`; a live reading, `pending` included, keeps it.
      if (applyOwnRowStatusStep(key, { result: r }, LIVENESS_STATUS_SITE)) return livenessLatchedReading()
      const reading = livenessReadingForStatus(r)
      if (reading.kind === LIVENESS_UNKNOWN) {
        console.error(`[slack] isSessionAlive: status answered a state CSCB does not know for persona=${key} — read as unknown, not dead`)
      }
      return reading
    } catch (err) {
      // b.jg5 SRJ-301: inside a restart run (a recovery attempt) a status
      // error arms the persona's retry timer, whatever the reading below.
      // b.jg5 SRJ-313: an UNCLASSIFIED status there is reported to the
      // persona's unclassified-error episode, except ErrSystemInstallDisappeared,
      // which keeps its `dead` reading (SRJ-105, SRJ-314).
      reportAgentDirectorError(key, err, 'status', {
        reportUnclassified: !isAdErrorInstance(err, ErrSystemInstallDisappeared),
      })
      // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latches the persona
      // (the own-row `status` step) and reads `unknown`, never `dead`.
      // b.jg5 SRJ-809: the same step ends an old-life hold on cscb_<key> on
      // `ErrSpawnNotFound` (no row); any other error keeps it.
      if (applyOwnRowStatusStep(key, { thrown: err }, LIVENESS_STATUS_SITE)) return livenessLatchedReading()
      return statusErrorReading(key, err)
    }
  }
}

/** Who reads, in the own-row `status` step's lines for the liveness adapter's read. */
export const LIVENESS_STATUS_SITE = { site: 'isSessionAlive', what: 'status' } as const

/**
 * The liveness adapter's reading for a `status` answer that latched the
 * persona (b.jg5 SRJ-115, SRJ-502): `unknown`, never `dead` or `live`; the
 * step logged the one line. The restart work and the health tick then ask
 * the latch and stop; the lost-message routing decides its states again and
 * reports the latched persona as held for a human (b.jg5 SRJ-1011).
 */
function livenessLatchedReading(): LivenessReading {
  return LIVENESS_READING_UNKNOWN
}

/**
 * The liveness adapter's reading for a `status` error (b.jg5 SRJ-314), with
 * its outage flags; see `_buildIsSessionAliveAdapter`. Decided by class
 * through `src/ad-error-class.ts`. Only `ErrSpawnNotFound` and
 * `ErrSystemInstallDisappeared` read `dead`.
 */
function statusErrorReading(key: string, err: unknown): LivenessReading {
  if (isAdErrorInstance(err, ErrSpawnNotFound)) {
    // b.jg5 SRJ-312: agent-director answered, but tmux did not; `tmux-unavailable` stays raised.
    // It loaded its config and read the store, so `ad-config-malformed` clears.
    clearOutageFlag(key, 'ad-unreachable')
    clearOutageFlag(key, 'ad-config-malformed')
    return LIVENESS_READING_DEAD_NO_ROW
  }
  if (isAdErrorInstance(err, ErrSystemInstallDisappeared)) {
    setOutageFlag(key, 'ad-unreachable', binaryPathOf(err))
    // b.jg5 SRJ-610: `dead` all the same, marked as read from no row, so the
    // slow-recovery count resets without ending its episode (hatch A2).
    return LIVENESS_READING_DEAD_INSTALL_GONE
  }
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
    // b.jg5 SRJ-1021: the raising error picks the onset.
    raiseTmuxUnavailable(key, err)
    return LIVENESS_READING_UNKNOWN
  }
  // b.jg5 SRJ-316: a CONFIG answer raises `ad-config-malformed` (once per
  // episode) and still reads `unknown`, with the shared line below.
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_CONFIG) raiseAdConfigMalformed(key, err)
  console.error(`[slack] isSessionAlive: status error for persona=${key}: ${describeThrownValue(err)} — read as unknown, not dead`)
  return LIVENESS_READING_UNKNOWN
}

/** The `binaryPath` an `ErrSystemInstallDisappeared` carries, when it is a string. Never throws. */
function binaryPathOf(err: unknown): string | undefined {
  try {
    const path = (err as { readonly binaryPath?: unknown }).binaryPath
    return typeof path === 'string' ? path : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// _buildStatRouteImpl
// ---------------------------------------------------------------------------

/**
 * _buildStatRouteImpl — test-only factory for the health-check tick's
 * statRoute dependency. Production code wires this via main()'s
 * initHealthCheck call with no deps; tests inject `stat` / `setTimeout` /
 * `clearTimeout` to exercise the 5-second timeout budget and the
 * fsPromises.stat error swallowing against the REAL factory (not a replica).
 *
 * @internal
 */
export function _buildStatRouteImpl(deps?: {
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout> | undefined) => void
}): (cwd: string) => Promise<boolean> {
  const stat = deps?.stat ?? ((p: string) => fsPromises.stat(p) as Promise<{ isDirectory(): boolean }>)
  const setT = deps?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps?.clearTimeout ?? ((h: ReturnType<typeof setTimeout> | undefined) => clearTimeout(h))
  const STAT_TIMEOUT_MS = 5_000
  return async (cwd: string) => {
    const statPromise = (async () => {
      try {
        const st = await stat(cwd)
        return st.isDirectory()
      } catch (err) {
        console.error(`[slack] health-check: statRoute(${cwd}) failed: ${describeThrownValue(err)}`)
        return false
      }
    })()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setT(() => {
        console.error(`[slack] health-check: statRoute(${cwd}) timed out after ${STAT_TIMEOUT_MS}ms — treating as unreachable`)
        resolve(false)
      }, STAT_TIMEOUT_MS)
    })
    try {
      return await Promise.race([statPromise, timeoutPromise])
    } finally {
      clearT(timeoutHandle)
    }
  }
}

// ---------------------------------------------------------------------------
// _buildKillSessionAdapter
// ---------------------------------------------------------------------------

/** The restart kill adapter's line prefix, its latch-time `status` read's included. */
const KILL_SESSION_ADAPTER_SITE = 'killSession (restart adapter)'

/**
 * _buildKillSessionAdapter — test-only factory for the restart module's
 * killSession dependency. Production code wires this via main()'s initRestart
 * call; tests call it directly.
 *
 * b.av2 SR-6.6 (per-persona lifecycle ops in sequence): restart.ts kills the
 * persona's session and then calls launchSession, which joins a launch already
 * in flight for the key. While a launch is in flight (a collision ladder
 * between its `resume` or reuse spawn and the row's next state, or the
 * live-row sequence's final launch) the row can read dead, so an unguarded
 * kill here would take down the process the running launch is bringing up.
 * While a launch for the key is in flight the adapter therefore skips the
 * kill; the in-flight launch owns the session's lifecycle. A running
 * live-row sequence is asked by the restart work itself, right before it
 * calls this adapter (b.jg5 SRJ-706).
 *
 * Bug b.g57: with `getPersona`, a persona whose claude_config_dir cannot be
 * resolved to a real path is not killed either. The kill precedes a launch
 * that could not be made, so the instance and its row are left as they are
 * and the persona is handed to the bring-up controller's hold, as the launch
 * would (`holdLaunchIfConfigDirUnresolvable`); the launch that follows is then
 * refused by the relaunch gate (`'skipped'`), counting no failure.
 *
 * b.jg5 SRJ-110, SRJ-701, SRJ-702: both guards make no call and answer
 * `KILL_SESSION_NOT_KILLED_GUARD`, after which the restart work goes on as it
 * always has (the launch joins the launch in flight, or the relaunch gate
 * refuses it). Otherwise the adapter's kill runs through the bounded retry
 * (`retryPersonaKill`, inside the restart work's recovery attempt, on
 * `clock`), seeded with the run's `dead` reading: the restart path kills
 * only after one, and only after its `ErrSystemInstallDisappeared` form,
 * which reads no row (`killBeforeRelaunch` in `src/restart.ts`; b.jg5
 * SRJ-314, SRJ-611: no kill is sent for a row just read `ended`, `missing`
 * or gone), so its kill is not of a row read live (not tmux-touching) and is
 * one try, its outcome standing at once. The adapter logs the outcome that stands with
 * `kill_sent` (`describeKillOutcome`), does its class's handling below,
 * raises the retry's kill-failure alert decision
 * (`raisePersonaKillFailureAlert`, context `recovery`; b.jg5 SRJ-704) and
 * answers the outcome: an `ErrTmuxKillFailed` that stands raises the
 * ordinary version (P's destination once per kill-failure episode, or a log
 * line and a `persona-kill-failed` entry for a persona no longer in the
 * applied configuration), and starts no `tmux-unresponsive` condition. A
 * stop of the tries (a read between tries that latched the persona, or the
 * keep-going check) answers the last outcome with no class handling, and the
 * restart work answers `latched` when the persona is latched. Every answer
 * is classified by error class through `src/ad-error-class.ts`. The restart work
 * launches only after a success (any `kill_sent`, `ErrSpawnNotFound`,
 * GONE, or a read that found the row finished). By class:
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry with
 *     the refused operation "P's next check or recovery"
 *     (`latchOnRestartKillOutcome`; b.jg5 SRJ-501, SRJ-505; a "not this
 *     launch's session" answer on a live row is SRJ-613's kill backstop), and
 *     the work answers `latched`;
 *   - UNUSABLE NAME: the persona latches through the unusable-name entry
 *     (b.jg5 SRJ-512), and the work answers `latched`;
 *   - either latch records `lastRead`'s row state, the state the restart run
 *     last read (`ended`, `missing` or no row), with no further `status`
 *     read; only a reading that carries none (`ErrSystemInstallDisappeared`)
 *     leads to one latch-time `status` read, its lines prefixed
 *     `killSession (restart adapter)` (b.jg5 SRJ-501);
 *   - `ErrInvalidFlags`: one immediate version re-check (b.jg5 SRJ-104,
 *     SRJ-204); when it decides that the server stops, the outcome is
 *     answered with nothing more done and the work answers `shutting-down`
 *     (b.jg5 SRJ-205); otherwise it is UNCLASSIFIED, as below;
 *   - UNAVAILABLE (`ErrTmuxKillFailed` included), ENVIRONMENT (the wrapper
 *     raises `tmux-unavailable`), CONFIG (the wrapper raises
 *     `ad-config-malformed`) and UNCLASSIFIED (`ErrSystemInstallDisappeared`
 *     included, whose wrapper raises `ad-unreachable`; and a class the kill
 *     has no row for, which `killPersonaInstance` reports as UNCLASSIFIED):
 *     the persona's retry timer is armed, an UNCLASSIFIED outcome feeds its
 *     unclassified-error episode, and the work answers `refused`.
 * No non-success launches anything or counts anything, and the kill is never
 * repeated.
 *
 * @param getPersona  The applied persona with a key (production:
 *   `getAppliedPersona`); without it the directory is not checked here.
 * @param clock  The wait between the kill's tries (a clock with
 *   `setTimeout`, or a sleep function); the production clock by default.
 * @internal
 */
export function _buildKillSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
  clock: KillRetryWait = KILL_RETRY_SYSTEM_CLOCK,
): (key: string, lastRead: DeadLivenessReading) => Promise<KillSessionResult> {
  // `key` is the persona key; `lastRead` the restart run's `dead` reading.
  return async (key: string, lastRead: DeadLivenessReading) => {
    // The launch call only, not a running dialog approver (b.jg5 SRJ-401):
    // this kill can run while an approver still runs for the persona (an
    // approver reads the row again only at its next lap, or once its call in
    // progress returns). That approver then meets GONE, or is superseded by
    // a newer launch's, and stops. So the kill checks `isLaunchInFlight` only, as do the
    // reconnect verdicts (`promptRowReconnectVerdict`, `workingReconnectVerdict`).
    if (isLaunchInFlight(key)) {
      console.error(`[slack] killSession (restart adapter): launch already in flight for persona=${key} — not killing`)
      return KILL_SESSION_NOT_KILLED_GUARD
    }
    const persona = getPersona?.(key)
    if (persona !== undefined && holdLaunchIfConfigDirUnresolvable(persona)) {
      console.error(
        `[slack] killSession (restart adapter): persona=${key} claude_config_dir cannot be resolved to a real path — not killing; its row is kept`,
      )
      return KILL_SESSION_NOT_KILLED_GUARD
    }
    // The restart path kills only after a `dead` reading (b.jg5 SRJ-314), so this
    // kill is not of a row read live: not tmux-touching, and one try of the
    // bounded retry (b.jg5 SRJ-702). It runs inside the restart work's
    // recovery attempt.
    const retried = await retryPersonaKill(key, {
      rowReadLive: false,
      lastRead: KILL_RETRY_SEED_NOT_LIVE_VALUE,
      site: KILL_SESSION_ADAPTER_SITE,
      ref: `persona=${key}`,
      clock,
    })
    const { outcome } = retried
    console.error(`[slack] killSession (restart adapter): kill for persona=${key}: ${describeKillOutcome(outcome)}`)
    // b.jg5 SRJ-205: a stop the re-check decided is answered as it is, and
    // nothing more is done here. b.jg5 SRJ-702, SRJ-502: so is a stop of the
    // tries (the persona latched, or is no longer up, or shutdown).
    if (!killOutcomeStopsServer(outcome) && !killRetryStopped(retried)) {
      await latchOnRestartKillOutcome(key, outcome, KILL_SESSION_ADAPTER_SITE, lastRead)
    }
    // b.jg5 SRJ-702, SRJ-704: the retry's kill-failure alert decision, after
    // the outcome's own handling and before the launch that a success lets
    // run; a keep-going stop that is not a latch posts nothing.
    raisePersonaKillFailureAlert(key, retried, KILL_SESSION_ADAPTER_SITE, `persona=${key}`)
    return outcome
  }
}

// ---------------------------------------------------------------------------
// _buildReconnectSessionAdapter
// ---------------------------------------------------------------------------

/**
 * _buildReconnectSessionAdapter — test-only factory for the restart module's
 * reconnectSession dependency. Production code wires this via main()'s
 * initRestart call; tests call it directly to exercise the b.9a7 working→
 * 'transient' state gate without importing the private closure inside main().
 *
 * b.9a7 HAZARD 2 (turn corruption, b.rmy invariant) — state gate:
 * reconnectMcp types `/mcp reconnect` into the tmux pane. Before b.9a7 only
 * rare event paths reached this; now the health-check tick can drive it
 * periodically for any live state. A session mid-long-turn (`working`) is
 * exactly the case most likely to look disconnected while healthy, and typing
 * into its pane mid-turn risks corrupting the turn. So DEFER `working`: probe
 * AD state and, if working, return 'transient' — a no-op that restart.ts does
 * NOT count and does NOT re-enter scheduleRestart on, leaving a later tick free
 * to retry once the turn settles to `waiting`. This does not regress the b.rmy
 * invariant: we never declare a `working` row with a live tmux session dead,
 * only decline to poke it.
 *
 * b.f2b — never type blind. When the status call throws, nothing is known
 * about the session (it may be mid-turn), so nothing is typed: the failure is
 * logged and the adapter returns 'transient'; the next tick retries. In the
 * liveness probe (b.jg5 SRJ-314) only `ErrSpawnNotFound` and
 * `ErrSystemInstallDisappeared` read dead; every other `status` error reads
 * `unknown`, so nothing kills or relaunches the persona on it. Before b.f2b a
 * failed status call fell through to the reconnect.
 *
 * b.f2b — never type into a prompt or dialog. `/mcp reconnect` + Enter typed
 * into an `ask_user` or `check_permission` session could confirm the dialog's
 * default, so those states are deferred too ('transient'): the deferral is
 * logged, and the persona's `blocked-on-prompt` not-connected notice is raised
 * (once per episode). b.jdc, b.jg5 SRJ-606: only while its session may
 * still be waiting on the prompt. The row keeps its state after the session
 * dies, so the row is read first with one one-line `read-pane` through the
 * shared reader (`promptRowReconnectVerdict`: `PROBE_PANE_READ_LINES`, no
 * tmux call), answered by b.jg5 SRJ-117's b.jdc reconnect-verdict column:
 *   - a pane → the deferral: once the deferrals have run for
 *     `PROMPT_ROW_SWEEP_AFTER_MS` each one first sweeps and reads the row
 *     again (`checkPromptRowDeferral`), and otherwise `deferPromptRow`
 *     defers with the notice. A pane leads at most to the deferral: it may
 *     be a single leftover's (b.jg5 SRJ-117, SRJ-613), nothing is typed on
 *     it, and the reconnect's `send-keys` a later tick makes is the backstop
 *     (its CONFLICT "not this launch's session" latches the persona);
 *   - GONE → the dead-tmux sweep (verdict `prompt-row-tmux-gone`) and an
 *     escalate-dead answer carrying that verdict (`escalateDeadWith`), with
 *     no notice; the row absent (`ErrSpawnNotFound`) → the same, carrying
 *     the verdict `row-absent-at-pane-read`;
 *   - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *     `ad-config-malformed` outage) or UNCLASSIFIED → taken as alive: the
 *     deferral;
 *   - ENVIRONMENT (the wrapper raised the `tmux-unavailable` outage) →
 *     'transient', with no deferral noted and no notice;
 *   - CONFLICT or UNUSABLE NAME (the reader latched the persona with the row
 *     state the adapter read), or a persona already latched → 'transient',
 *     with no deferral noted, no notice and nothing typed.
 * Once the prompt is answered, a later tick reconnects it
 * when it can tell the session is idle again (its row reads `waiting`, or the
 * positive-idle rule shows a `working` row stale).
 *
 * b.f2b, b.jg5 SRJ-604 — a `waiting` row's pane is read once first, with one
 * `read-pane` of the row (`checkWaitingRowPane`), answered by b.jg5
 * SRJ-117's waiting-row column:
 *   - a pane: a running turn or a prompt or dialog on it defers
 *     ('transient') the same way (a prompt raises the same notice);
 *     otherwise the reconnect below goes ahead. The pane may be a single
 *     leftover's (b.jg5 SRJ-117, SRJ-613), so it is no proof that the
 *     worker's own session is there: the reconnect's own `send-keys` is the
 *     backstop, and its CONFLICT "not this launch's session" latches the
 *     persona with nothing typed (b.jg5 SRJ-118, SRJ-501);
 *   - GONE → nothing is typed: the dead-tmux sweep
 *     (`sweepDeadTmuxChannelWithCause`, verdict `waiting-row-pane-gone`) and
 *     an escalate-dead answer carrying that verdict (`escalateDeadWith`;
 *     'transient' when the sweep was refused), as the `working` row's GONE
 *     below; the row absent (`ErrSpawnNotFound`) → the same, carrying the
 *     verdict `row-absent-at-pane-read` (b.jg5 SRJ-117);
 *   - CONFLICT or UNUSABLE NAME (the reader latched the persona with the row
 *     state `waiting`), a persona already latched, or ENVIRONMENT (the
 *     wrapper raised the `tmux-unavailable` outage) → 'transient', nothing
 *     typed;
 *   - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *     `ad-config-malformed` outage) or UNCLASSIFIED → the reconnect goes
 *     ahead on the `waiting` row alone, agent-director's own idle signal.
 *
 * b.d61, b.jg5 SRJ-603 — the `working` deferral is bounded by agent-director's
 * `read-pane`. A `working` row is no proof of a live turn: when the persona's
 * session is killed mid-turn, SessionEnd fires but AD only soft-refreshes the
 * row (`working → working`), and it stays frozen until a findMissing sweep
 * reconciles it to `missing`. Deferring on the row alone would repeat on every
 * tick and the persona would never relaunch. So the `working` branch
 * (`workingReconnectVerdict`) makes one `read-pane` of the persona's own row
 * through the shared reader (`readPersonaOwnPane`: `FULL_PANE_READ_LINES`,
 * the row state `working`), with no tmux probe, and answers by b.jg5
 * SRJ-117's working-row column:
 *   - a launch for the persona is in flight → defer ('transient'), first and
 *     with no agent-director call: the launch owns the session's lifecycle;
 *   - a pane → the positive-idle rule decides (b.f2b, `checkWorkingRowPane`
 *     on that pane, which reads no pane of its own). A `working` row can be
 *     stale: agent-director may leave it `working` after the turn ended, and
 *     deferring on it forever would strand the persona. The pane may be a
 *     single leftover's (b.jg5 SRJ-613), so it is never proof on its own:
 *     each attempt reads the session's transcript too when the pane shows an
 *     idle screen (located with the persona's claude_config_dir from
 *     `getPersona`), and the evidence is kept across attempts (they are a
 *     tick or more apart): once the pane has shown the same idle screen (no
 *     busy indicator, no prompt) AND the transcript has ended with a
 *     completed turn, both unchanged, at every read across reads spanning
 *     `STALE_WORKING_WINDOW_MS`, the row is stale and the adapter goes on to
 *     the reconnect below, whose own `send-keys` is the backstop: its
 *     CONFLICT "not this launch's session" latches the persona with nothing
 *     typed (b.jg5 SRJ-118, SRJ-501). A busy, changing or blank pane, an
 *     idle one whose transcript doesn't end with a completed turn or can't
 *     be located or read, or evidence not yet held for the window, defers
 *     ('transient'), as above;
 *     so does a prompt, which is never typed into, and which raises the
 *     `blocked-on-prompt` notice (once per episode) once shown across reads
 *     spanning the window. The evidence is forgotten when an attempt reads
 *     the row in another state or reads no pane, when a launch for the
 *     persona starts, and when it reconnects, becomes deliverable again or
 *     is torn down. Each deferral here, and an UNAVAILABLE or CONFIG read's
 *     below, is one more in the persona's run of deferrals on the row
 *     (`noteWorkingRowDeferral`): once the run has lasted
 *     `UNPROVEN_IDLE_NOTICE_AFTER_MS` (10 min), the `unproven-idle`
 *     not-connected notice is raised (once per episode), so a row whose
 *     idleness can never be proven is not held back from silently. The run
 *     ends when an attempt reads another state (a failed status call leaves
 *     it), when a reconnect is typed, when a launch starts and with the
 *     episode;
 *   - GONE (`ErrTmuxCaptureFailed`: agent-director found no pane of the
 *     row's launch) → there is no pane to type into: forget the evidence,
 *     fire the dead-tmux sweep (`sweepDeadTmuxChannelWithCause`, b.sv7,
 *     verdict `working-tmux-gone`) once and answer escalate-dead carrying
 *     that verdict (`escalateDeadWith`; 'transient' when the sweep was
 *     refused, b.jg5 SRJ-105: nothing is re-probed, killed or relaunched);
 *   - the row absent (`ErrSpawnNotFound`) → the same, carrying the verdict
 *     `row-absent-at-pane-read`: a row read that takes the GONE column
 *     without being a GONE (b.jg5 SRJ-117);
 *   - UNAVAILABLE (timeouts included), or CONFIG (the wrapper raised the
 *     `ad-config-malformed` outage, b.jg5 SRJ-316) → defer ('transient'),
 *     with one deferral noted on the row: a read that could not run is never
 *     proof the session is dead (b.rmy);
 *   - ENVIRONMENT (the wrapper raised the `tmux-unavailable` outage, b.jg5
 *     SRJ-311) or UNCLASSIFIED (b.jg5 SRJ-105: the wrapper reported the
 *     persona's unclassified-error episode, or the reader did after an
 *     `ErrInvalidFlags` re-check) → defer ('transient'), with no deferral
 *     noted;
 *   - CONFLICT or UNUSABLE NAME (the reader latched the persona with the row
 *     state `working`, b.jg5 SRJ-501, SRJ-512), or a persona already latched,
 *     which the reader does not read → 'transient', with no deferral noted,
 *     no notice and nothing typed (b.jg5 SRJ-502).
 *   After an escalate-dead answer restart.ts probes liveness again in the
 *   same restart run and, when the reconciled row reads dead, relaunches at
 *   once, with its checked kill first only for a verdict that is dead
 *   evidence and a re-probe of `ErrSystemInstallDisappeared`, which reads
 *   no row; a re-probe that read the row voids the verdict, so the relaunch
 *   has no kill and carries none (b.jg5 SRJ-611). The sweep may leave the row live (in
 *   `unverified_ids`, or, when `pending`, not judged, b.jg5 SRJ-120), and it
 *   may then stay live for further ticks: nothing promises that the re-probe
 *   or a later tick reads it dead. Each escalate-dead tick sweeps again, with
 *   no step beyond the sweep, and restart.ts's slow-recovery observer posts
 *   the slow-recovery notice once after 3 such ticks whose re-probe still
 *   reads the row live (b.jg5 SRJ-610, SRJ-1010). After a
 *   run the sweep makes, each configured persona's own row left in
 *   `unverified_ids` is read with one `get`, and only a `provenance_conflict`
 *   note there latches (b.jg5 SRJ-114); restart.ts asks the latch right after
 *   this verdict, before its re-probe, so a persona latched that way gets no
 *   further agent-director call (b.jg5 SRJ-502), and again before its kill.
 * The deferral therefore lasts only while agent-director reads the persona's
 * pane, or cannot answer, and gives no positive evidence that the row is
 * stale (b.f2b), and is reported once it has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`.
 *
 * b.dup — a row agent-director will not type into. agent-director refuses
 * send-keys to a row that is not interactive (`ErrSpawnNotInteractive`):
 *   - `pending` (its session has not started; SessionStart has not fired) →
 *     defer ('pending'), typing nothing (`deferPendingRow`, awaited, passed
 *     the row's raw launch start when the result showed one, b.jg5 SRJ-115):
 *     the keystrokes would be refused, and the session connects its MCP
 *     servers on its own once it starts. The deferral decides whether the
 *     row is covered (b.jg5 SRJ-409, SRJ-411): a covered row arms the
 *     persona's retry timer in pending-only mode; a retired key's old life
 *     before its new life, or a `cwd` or `config_dir` mismatch, goes through
 *     the live-row sequence, with no `/mcp reconnect` typed. The restart work hands a row its liveness
 *     probe reads `pending` to `deferPendingRow` itself, before it would
 *     call this adapter (b.jg5 SRJ-314); this branch covers a row the probe
 *     read `live` that reads `pending` by this second read. Its deferral
 *     makes no pending-row rule run and never answers gone
 *     (`mayRunRule: false`): the next retry's first probe reads the row
 *     and runs the rule there (b.jg5 SRJ-410). restart.ts
 *     treats it as it treats 'transient', and answers
 *     `RESTART_OUTCOME_PENDING_DEFERRED`, so the UNAVAILABLE retry timer
 *     knows the row read `pending`.
 *   - `ended` or `missing` — read here, or reached between this status read
 *     and the keystrokes (a findMissing sweep, such as the one another
 *     persona's launch wait starts with, marked the row missing) → the
 *     refused keystrokes make the reconnect answer 'dead-session' with cause
 *     `row-not-interactive`, which is swept with that verdict (b.jdc) and
 *     answered escalate-dead carrying it: a verdict that is never dead
 *     evidence and only routes the persona into restart.ts's decision, since
 *     a finished row (or a `pending` row whose session may be another
 *     launch's, b.jg5 SRJ-613) does not prove the worker gone (b.jg5 SRJ-609,
 *     SRJ-611). When restart.ts's re-probe reads the row dead it relaunches
 *     the persona in the same run with no kill, carrying the verdict into
 *     the ladder (b.d61); a row that still reads live is swept again at each
 *     later escalate-dead tick (b.jg5 SRJ-610). No spawn-failure notice is
 *     raised.
 *
 * b.jg5 SRJ-118, SRJ-609 — the reconnect itself (`reconnectMcpWithCause`,
 * with the row state this adapter's `status` read gave as its last read) is
 * one `send-keys`, never retried, with no tmux server start. It is the
 * backstop for every pane read above: a pane may be a single leftover's
 * (b.jg5 SRJ-117, SRJ-613), and this `send-keys` is answered by the row's
 * current launch, so on a live row that is not `pending` it answers CONFLICT
 * "not this launch's session" when a leftover holds the persona's session,
 * with nothing typed; the persona latches (b.jg5 SRJ-501). Its answer maps:
 *   - `ok` → 'success';
 *   - `dead-session` → one dead-tmux sweep (`sweepDeadTmuxChannelWithCause`)
 *     with the verdict its cause gives (`escalateDeadVerdictOfCause`):
 *     `tmux-gone` (GONE) → `dead-session`, `row-not-interactive` →
 *     `row-not-interactive`, `row-absent` (`ErrSpawnNotFound`, a row read) →
 *     `row-absent-at-pane-read`, never `tmux-gone`'s; then escalate-dead
 *     carrying that verdict ('transient' when the sweep was refused, b.jg5
 *     SRJ-105);
 *   - `transient` (the reconnect latched the persona on a CONFLICT or
 *     UNUSABLE NAME, found it latched, or met UNAVAILABLE, ENVIRONMENT,
 *     CONFIG or UNCLASSIFIED) → 'transient' with no sweep: nothing typed,
 *     nothing counted, no spawn-failure notice.
 *
 * b.jg5 SRJ-611 — every escalate-dead answer carries what proved it
 * (`ReconnectEscalateDead`, `escalateDeadWith`): the verdict it swept with,
 * the one its escalate-dead line names, or, for a prompt row whose 10-minute
 * sweep found it finished, the cause `row-read-finished` that the deferral
 * check's line names. Only the GONE-based verdicts are dead evidence:
 * `dead-session` (`tmux-gone`), `working-tmux-gone`, `waiting-row-pane-gone`
 * and `prompt-row-tmux-gone`. `row-not-interactive` (b.jg5 SRJ-609),
 * `row-absent-at-pane-read` and `row-read-finished` are a refusal and row
 * reads: they only route the persona into restart.ts's decision, which
 * relaunches after a `dead` re-probe with no kill.
 *
 * b.jg5 SRJ-115, SRJ-512, SRJ-513 — the state read applies the session manager's
 * own-row `status` step (`applyOwnRowStatusStep`) after its own call, on the
 * result whole: an UNUSABLE NAME answer, or a latch decision of the row-read
 * rule over the result (a configured persona's own row reading `pending`
 * with no launch start, b.jg5 SRJ-513), latches the persona, and the
 * adapter answers 'transient' with nothing typed and no `deferPendingRow`
 * hand-off (`reconnectLatchedByRead`). The same step ends an old-life hold
 * on `cscb_<key>` when the row reads `ended` or `missing`, or the answer is
 * `ErrSpawnNotFound`, and keeps it on any live reading, `pending` included
 * (b.jg5 SRJ-809). The `working` and `waiting`
 * rows' pane reads (`workingReconnectVerdict`, `checkWaitingRowPane`, both
 * through the shared reader) latch on an UNUSABLE NAME answer too and
 * defer, so nothing is typed after them.
 * (The lost-message row read is the liveness adapter's,
 * `_buildIsSessionAliveAdapter`, which applies the same step; not this one.)
 *
 * b.jg5 SRJ-805 — never type into a retired key's old life. Right after the
 * state read and the latched gate below, a row that reads live other than
 * `pending` (`waiting`, `working`, a prompt state, or a state CSCB does not
 * know) of a key the installed retired-key store has recorded with no "new
 * life has begun" mark (`retiredKeyReadingOf`, the session manager's one
 * reader of that store; a mark held in memory after a failed write counts as
 * set) is the old life (`ownRowOldLifeOf`): no pane is read and nothing is
 * typed; the live-row sequence is started through the session manager's
 * start entry with the retired-key flag, the conversation not kept and alert
 * context `recovery`, seeded with the state read, and the adapter answers
 * 'transient', never counted (`replaceOwnRowOldLife`). The health tick, the
 * lost-message trigger and the retry timer's full-mode rerun all reach it
 * through the restart path. With the mark set the live row is the new life
 * and is reconnected as below; a `pending` row goes to the `pending`
 * deferral, which sends an unmarked key's old life through the live-row
 * sequence under the uncovered-row rule (b.jg5 SRJ-411).
 *
 * b.jg5 SRJ-810 — never type into a held old life. The same path serves a
 * key that is not recorded whose own row `cscb_<key>` is held for an old
 * life (`isOwnRowOldLifeHeld`: a row the start sweep swept for its `cwd`
 * whose kill did not succeed), read live other than `pending`: the live-row
 * sequence is started with no retired-key flag and the adapter answers
 * 'transient'. While the old-life wait runs on that row the start answers
 * `already-running` and the persona's retry timer is armed (b.jg5 SRJ-811).
 * Any other key is unchanged. The `working` and `waiting` branches read
 * the pane, which is awaited, so the store and the hold set are asked again
 * right before `/mcp reconnect` is typed, after the latch, and a key
 * recorded or held meanwhile takes the same replacement with nothing typed.
 * The state read itself
 * clears a marked key's entry when the row reads `waiting`, `working`,
 * `ask_user` or `check_permission` (b.jg5 SRJ-807).
 *
 * b.jg5 SRJ-502 — never type into a latched persona, nor read its pane. The
 * reads above are awaited, and a launch outside the restart serializer can
 * latch the persona while they run, after the restart work's own latched
 * check. So the latch (`isLatched`, `reconnectLatchedAt`) is asked again after
 * each awaited step that a further call follows: right after the state read,
 * before any branch on the state (so no pane read, sweep or notice follows
 * it); in the `working`-row verdict, right after its `read-pane`, before the
 * fold, the sweep or a deferral; in the prompt-row verdict, right after its
 * `read-pane`, before the sweep or the deferral, and again right before
 * `deferPromptRow`'s `blocked-on-prompt` notice; in the `waiting` branch,
 * right after its `read-pane`'s GONE or absent answer, before the sweep;
 * right before each not-connected notice the `working` and `waiting` checks
 * raise (the `unproven-idle` notice a noted deferral can raise, and the
 * `blocked-on-prompt` notice), passed to them as `latchedNow`; and right
 * before `/mcp reconnect` is typed. A latched persona, or a query that throws (fail
 * safe), gets nothing more done and one line naming it, and the adapter
 * answers 'transient', which restart.ts neither counts nor escalates to a
 * kill (`RESTART_OUTCOME_RECONNECT_DEFERRED`).
 *
 * @param getPersona  The applied persona with a key (production:
 *   `getAppliedPersona`), for locating a `working` row's transcript under its
 *   claude_config_dir; without it only the row's persisted transcript path is
 *   read.
 * @param isLatched  The latched query (production: the server's latch's
 *   `isLatched`); absent, no persona is latched here.
 * @param appliedPersona  The applied-persona lookup `deferPendingRow` reads
 *   for a `pending` row (default `getAppliedPersona`, the server's applied
 *   config; a caller outside `main()` passes its own).
 * @internal
 */
export function _buildReconnectSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
  isLatched?: (key: string) => boolean,
  appliedPersona: (key: string) => Persona | undefined = getAppliedPersona,
):(key: string) => Promise<'success' | ReconnectEscalateDead | 'transient' | 'pending'> {
  // `key` is the persona key.
  return async (key: string) => {
    let state: string
    // b.jg5 SRJ-115: a `pending` row's raw launch start, for `deferPendingRow`.
    let launchStartedAt: string | undefined
    try {
      const claude_instance_id = personaInstanceId(key)
      const st = await withOutageDetection(key, undefined, 'status', (client) =>
        client.status({ claude_instance_id }),
      )
      // b.jg5 SRJ-115: the own-row rules over this answer; a read that
      // latched the persona types nothing. b.jg5 SRJ-809: the same step ends
      // an old-life hold on cscb_<key> when the row reads `ended` or
      // `missing`; a live reading, `pending` included, keeps it.
      if (applyOwnRowStatusStep(key, { result: st }, RECONNECT_STATUS_SITE)) return reconnectLatchedByRead(key)
      state = st.state
      launchStartedAt = pendingLaunchStartOf(st)
    } catch (err) {
      // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latches the persona
      // (the own-row `status` step); nothing is typed. b.jg5 SRJ-809: the
      // same step ends an old-life hold on cscb_<key> on `ErrSpawnNotFound`
      // (no row); any other error keeps it.
      if (applyOwnRowStatusStep(key, { thrown: err }, RECONNECT_STATUS_SITE)) return reconnectLatchedByRead(key)
      // b.f2b: nothing is known about the session, so nothing is typed.
      forgetWorkingRowEvidence(key)
      console.error(reconnectStatusCheckFailedLine(key, describeAdFailureForLog(err)))
      return 'transient'
    }
    // b.jg5 SRJ-502: the state read is awaited, and the persona may have
    // latched elsewhere meanwhile; a latched persona gets no pane read, sweep
    // or notice, and nothing typed.
    const latchedNow = (): boolean => reconnectLatchedAt(key, isLatched)
    if (latchedNow()) return 'transient'
    // b.jg5 SRJ-805, SRJ-810: a retired key's old life, and a held own row,
    // are never typed into; the live-row sequence replaces it and the adapter
    // reports 'transient'.
    const oldLife = ownRowOldLifeOf(key, state)
    if (oldLife !== undefined) return replaceOwnRowOldLife(key, state, oldLife)
    // b.f2b: the evidence for a `working` row spans consecutive attempts that
    // read the row `working`; any other reading ends it, and the run of
    // deferrals on the row with it.
    if (state !== 'working') {
      forgetWorkingRowEvidence(key)
      endWorkingRowDeferral(key)
    }
    // b.jdc: likewise the run of deferrals on a row waiting on a prompt.
    if (!PROMPT_ROW_STATES.has(state)) endPromptRowDeferral(key)
    if (state === 'working') {
      const verdict = await workingReconnectVerdict(key, getPersona, latchedNow)
      if (verdict !== 'reconnect') return verdict
    } else if (PROMPT_ROW_STATES.has(state)) {
      return promptRowReconnectVerdict(key, state, latchedNow)
    } else if (state === 'pending') {
      // A deliberate deviation from b.jg5 SRJ-410 ("at each retry"): no
      // pending-row rule run here. This branch is reached only in a race,
      // since the probe had just read the row live and not `pending`, and
      // its 'pending' answer cannot carry a gone answer. The cost is the
      // rule running at the next retry, whose first probe reads the row.
      await deferPendingRow(key, launchStartedAt, appliedPersona, { mayRunRule: false })
      return 'pending'
    } else if (state === 'waiting') {
      const check = await checkWaitingRowPane(key, latchedNow)
      // b.f2b: its pane shows a running turn or a prompt, or the read latched
      // the persona, met ENVIRONMENT, or carried the stop mark of a version
      // re-check that decided the server stops (b.jg5 SRJ-205); logged
      // there. Nothing is typed.
      if (check === 'defer') return 'transient'
      // b.jg5 SRJ-604, SRJ-117: GONE, or the row absent: nothing is typed.
      if (check === WAITING_ROW_PANE_GONE) return escalateRowWithNoPane(key, ESCALATE_DEAD_WAITING_ROW_PANE_GONE, latchedNow)
      if (check === WAITING_ROW_PANE_ABSENT) return escalateRowWithNoPane(key, ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, latchedNow)
    }
    // Widened return type (SR-25.1 single counting site): surface the
    // ReconnectOutcome to restart.ts so it can call recordSuccess on the
    // success path. Map the ReconnectOutcome onto the restart union —
    // 'ok' is the only success signal restart.ts acts on; 'dead-session'
    // and 'transient' are non-success (no recordSuccess, no recordFailure).
    // 'dead-session' maps to an escalate-dead answer (b.9a7-amended),
    // carrying the verdict swept with (b.jg5 SRJ-611): restart.ts does not
    // re-enter scheduleRestart on it. For the escalate-dead case
    // (b.sv7), CSCB recovers ITSELF: we fire the internal
    // sweep wrapper here, which may reconcile the frozen `working` row to
    // `missing`, and restart.ts probes liveness again in the same restart run
    // (b.d61): a re-probe that reads `dead` relaunches at once, with its
    // checked kill first only after a verdict that is dead evidence and a
    // re-probe of `ErrSystemInstallDisappeared` (the relaunch alone after
    // `row-not-interactive` or `row-absent-at-pane-read`, and after a
    // re-probe that read the row, which voids the verdict, b.jg5 SRJ-609,
    // SRJ-611). `pending` or
    // `unknown` leaves the relaunch undone
    // (`unknown` arms the retry timer). The sweep may leave the row live (in
    // `unverified_ids`, or, when `pending`, not judged at all, b.jg5
    // SRJ-120), and the row may then stay live for further ticks: nothing
    // promises that the re-probe or the next tick reads it dead. Each later
    // escalate-dead tick sweeps again, with no step beyond the sweep, and
    // restart.ts's slow-recovery observer posts the slow-recovery notice once
    // after 3 such ticks whose re-probe still reads the row live (b.jg5
    // SRJ-610, SRJ-1010). After a run the sweep
    // makes, each configured persona's own row left in `unverified_ids` is
    // read with one `get`, and only a `provenance_conflict` note there
    // latches (b.jg5 SRJ-114); restart.ts asks the latch right after this
    // verdict, before its re-probe, so a persona latched that way gets no
    // further agent-director call (b.jg5 SRJ-502), and again right before its
    // kill. The external
    // ~/startup/find-missing-loop.sh is belt-and-braces only (it may also
    // reconcile the row, but recovery no longer silently depends on it —
    // removing it is a separate operator decision). Not counting here keeps
    // failures attributed to the launchSession site, which owns the single
    // counting site (SR-25.1).
    //
    // b.jg5 SRJ-502: the reads above are awaited, and a launch outside the
    // restart serializer (e.g. the start pass's) may have latched the persona
    // meanwhile. Ask the latch right before typing: a latched persona (or a
    // query that throws: fail safe) gets nothing typed, 'transient'.
    if (latchedNow()) return 'transient'
    // b.jg5 SRJ-805, SRJ-810: the pane reads above are awaited, and the key
    // may have been recorded meanwhile (an apply's step 1), or its own row
    // held: the store and the hold set are asked again right before typing,
    // so an old life is never typed into.
    const oldLifeNow = ownRowOldLifeOf(key, state)
    if (oldLifeNow !== undefined) return replaceOwnRowOldLife(key, state, oldLifeNow)
    // b.jg5 SRJ-118, SRJ-501: the reconnect's last read is this adapter's
    // `status` read (`waiting`, or a stale `working` row).
    const result = await reconnectMcpWithCause(key, latchRowStateRead(state))
    if (result.outcome === 'ok') return 'success'
    if (result.outcome === 'dead-session') {
      // b.sv7: trigger the internal memoized findMissing sweep (b.m4r) before
      // returning the verdict. The escalate-dead return value is unchanged
      // regardless of sweep outcome (the wrapper never throws). b.jdc, b.jg5
      // SRJ-118: the verdict says what agent-director answered, so the line
      // claims no dead tmux session for a refused keystroke (b.dup) or an
      // absent row.
      //
      // Memo-TTL vs. tick-cadence: reconcileMissingSweep's 10s memo window is
      // harmless at the ~120s health-check tick cadence — a later
      // escalate-dead tick's sweep runs again well past the window, though a
      // row agent-director leaves live (b.jg5 SRJ-120) may stay live for
      // further ticks whatever the sweep's age; each such tick sweeps again
      // and nothing more (b.jg5 SRJ-610). And the fleet-wide
      // post-reboot case (b.nk5 — /tmp wiped, ALL personas dead-tmux at once)
      // is served correctly by the single in-flight-shared sweep: one
      // findMissing reconciles the whole store for every escalating persona.
      // b.jg5 SRJ-105: a refused sweep stops the restart run: 'transient',
      // so no re-probe, kill or relaunch follows.
      const verdict = escalateDeadVerdictOfCause(result.deadCause)
      const sweep = await sweepDeadTmuxChannelWithCause(key, verdict)
      if (sweep.refused) return 'transient'
      // b.jg5 SRJ-609, SRJ-611: the answer carries the verdict swept with;
      // only `dead-session` (`tmux-gone`) is dead evidence. A refusal as not
      // interactive or an absent row never by itself leads to a kill:
      // restart.ts relaunches after a `dead` re-probe with no kill.
      return escalateDeadWith(verdict)
    }
    // b.jg5 SRJ-118: 'transient' — nothing typed, no sweep, nothing counted.
    return 'transient'
  }
}

/** Who reads, in the own-row `status` step's lines for the reconnect adapter's state read. */
export const RECONNECT_STATUS_SITE = { site: 'reconnectSession', what: 'status check' } as const

/** `ownRowOldLifeOf`: the key is recorded as retired with no "new life has begun" mark (b.jg5 SRJ-805). */
const OWN_ROW_OLD_LIFE_RETIRED = 'retired'
/** `ownRowOldLifeOf`: the key's own row is held for an old life while the key is not recorded (b.jg5 SRJ-810). */
const OWN_ROW_OLD_LIFE_HELD = 'held'

/** Why the reconnect adapter reads persona `key`'s own live row as an old life. */
type OwnRowOldLife = typeof OWN_ROW_OLD_LIFE_RETIRED | typeof OWN_ROW_OLD_LIFE_HELD

/**
 * Whether persona `key`'s own row, read `state` by the reconnect adapter's
 * `status` read, is an old life, and why. Only a row that reads live other
 * than `pending` (`waiting`, `working`, a prompt state, or a state CSCB does
 * not know) can be one; a `pending` row keeps the `pending` deferral, and an
 * `ended` or `missing` row the adapter's own handling. Then:
 *   - `retired` (b.jg5 SRJ-805): the installed retired-key store has the key
 *     recorded with no "new life has begun" mark (`retiredKeyReadingOf`, the
 *     in-memory mark of a failed write counting as set). With the mark set
 *     the live row is the new life, reconnected as any other;
 *   - `held` (b.jg5 SRJ-810): the key is not recorded, and its own row
 *     `cscb_<key>` is held for an old life (`isOwnRowOldLifeHeld`): a row the
 *     start sweep swept for its `cwd` whose kill did not succeed.
 * Undefined otherwise: the row is reconnected as before. Never throws.
 */
function ownRowOldLifeOf(key: string, state: string): OwnRowOldLife | undefined {
  if (state === AGENT_DIRECTOR_PENDING_STATE || AGENT_DIRECTOR_DEAD_STATES.has(state)) return undefined
  const retired = retiredKeyReadingOf(key)
  if (retired.recorded) return retired.marked ? undefined : OWN_ROW_OLD_LIFE_RETIRED
  return isOwnRowOldLifeHeld(key) ? OWN_ROW_OLD_LIFE_HELD : undefined
}

/**
 * The reconnect adapter's answer for persona `key`'s own row read `state`
 * that is an old life (`ownRowOldLifeOf`; b.jg5 SRJ-805, SRJ-810): no
 * `/mcp reconnect` is typed into it and no pane is read. One path serves a
 * retired key's old life and a held own row of a key that is not recorded:
 * the `working`-row evidence and the runs of deferrals on the row are ended
 * (they were the old life's), one live-row sequence is started through the
 * session manager's start entry (`startLiveRowSequence`: seeded with
 * `state`, entry at step 1, the conversation not kept, the retired-key flag
 * set only for a retired key, ending in a launch, alert context
 * `recovery`), so its step 6 is the reuse spawn that begins the new life,
 * and one line names the start's answer:
 *
 *   [slack] reconnectSession: persona=<key> is <state> and its key is retired with no new life begun — not typing /mcp reconnect into its old life; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-805)
 *   [slack] reconnectSession: persona=<key> is <state> and its own row is held for an old life — not typing /mcp reconnect into it; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-810, SRJ-805)
 *
 * While the old-life wait runs on the row the start answers `already-running`
 * and the start entry arms the persona's retry timer with the
 * held-for-an-old-life cause (b.jg5 SRJ-811), so no sequence starts beside
 * the wait. The answer is 'transient', which restart.ts neither counts nor
 * escalates (`RESTART_OUTCOME_RECONNECT_DEFERRED`), whatever the start
 * answered; the running sequence then holds every other launch path for the
 * persona (SRJ-706). Never throws.
 */
function replaceOwnRowOldLife(key: string, state: string, why: OwnRowOldLife): 'transient' {
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  endPromptRowDeferral(key)
  const startAnswer = startLiveRowSequence({
    key,
    ref: `persona=${key}`,
    instanceId: personaInstanceId(key),
    lastReadState: state,
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    retiredKey: why === OWN_ROW_OLD_LIFE_RETIRED,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
  })
  console.error(
    why === OWN_ROW_OLD_LIFE_RETIRED
      ? reconnectRetiredOldLifeLine(key, state, startAnswer)
      : reconnectHeldOwnRowLine(key, state, startAnswer),
  )
  return 'transient'
}

/**
 * The reconnect adapter's line for a `status` read that failed (b.f2b,
 * b.rmy): nothing is typed and the persona is deferred to a later tick;
 * `failure` is the thrown value as `describeAdFailureForLog` renders it
 * (redacted; an agent-director error as its reported name and message). Pure.
 *
 *   [slack] reconnectSession: persona=<key> status check failed: <failure> — not typing /mcp reconnect blind; deferring to a later tick (b.f2b/b.rmy)
 */
export function reconnectStatusCheckFailedLine(key: string, failure: string): string {
  return `[slack] reconnectSession: persona=${key} status check failed: ${failure} — not typing /mcp reconnect blind; deferring to a later tick (b.f2b/b.rmy)`
}

/**
 * The reconnect adapter's line for a retired key's old life (b.jg5 SRJ-805;
 * `replaceOwnRowOldLife`): its key is recorded as retired with no "new life
 * has begun" mark, so nothing is typed and the live-row sequence replaces it:
 *
 *   [slack] reconnectSession: persona=<key> is <state> and its key is retired with no new life begun — not typing /mcp reconnect into its old life; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-805)
 *
 * Pure.
 */
export function reconnectRetiredOldLifeLine(key: string, state: string, startAnswer: string): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and its key is retired with no new life begun — not typing /mcp reconnect into its old life; the live-row sequence replaces it (start answered ${startAnswer}); deferring (b.jg5 SRJ-805)`
}

/**
 * The reconnect adapter's line for a held own row of a key that is not
 * recorded (b.jg5 SRJ-810; `replaceOwnRowOldLife`):
 *
 *   [slack] reconnectSession: persona=<key> is <state> and its own row is held for an old life — not typing /mcp reconnect into it; the live-row sequence replaces it (start answered <answer>); deferring (b.jg5 SRJ-810, SRJ-805)
 *
 * Pure.
 */
export function reconnectHeldOwnRowLine(key: string, state: string, startAnswer: string): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and its own row is held for an old life — not typing /mcp reconnect into it; the live-row sequence replaces it (start answered ${startAnswer}); deferring (b.jg5 SRJ-810, SRJ-805)`
}

/**
 * The reconnect adapter's answer for a state read that latched the persona
 * (b.jg5 SRJ-115, SRJ-502, SRJ-512): its `working`-row evidence is
 * forgotten, nothing is typed (the step logged the one line), and the
 * adapter answers 'transient', which restart.ts neither counts nor escalates
 * to a kill.
 */
function reconnectLatchedByRead(key: string): 'transient' {
  forgetWorkingRowEvidence(key)
  return 'transient'
}

/**
 * The reconnect adapter's escalate-dead answer (b.jg5 SRJ-611): it carries
 * `source`, the verdict the adapter swept with (`escalateRowWithNoPane`, the
 * reconnect's `dead-session`), or, for the prompt row's 10-minute sweep, the
 * cause its re-read gave (`row-read-finished`), with whether it is dead
 * evidence (`carriedDeadEvidenceOf`). restart.ts kills before its relaunch
 * only for dead evidence and carries the verdict into the relaunch.
 */
function escalateDeadWith(source: DeadEvidenceSource): ReconnectEscalateDead {
  return { outcome: 'escalate-dead', deadEvidence: carriedDeadEvidenceOf(source) }
}

/**
 * The reconnect adapter's latched gate (b.jg5 SRJ-502), asked after its
 * state read, after the `read-pane` of a `working`, `waiting` or prompt row,
 * right before each not-connected notice of the `working`, `waiting` and
 * prompt-row checks, and right before `/mcp reconnect` is typed
 * (see `_buildReconnectSessionAdapter`): true, after logging one line naming
 * the persona,
 * when `isLatched` answers exactly `true` for persona `key` or throws (fail
 * safe: the line names what it threw); false when it answers anything else or
 * is absent, and false for a call that carries the latch re-check's permit
 * (`holdsLatchRecheckPermit`: the re-check's own run of the restart path's
 * decision, until its first refusal). Never throws.
 */
function reconnectLatchedAt(key: string, isLatched: ((key: string) => boolean) | undefined): boolean {
  if (isLatched === undefined) return false
  // b.jg5 SRJ-502, SRJ-505: the latch re-check's own run of the restart
  // path's decision passes this gate while its permit holds.
  if (holdsLatchRecheckPermit(key)) return false
  let queryFailure: string | undefined
  try {
    if (isLatched(key) !== true) return false
  } catch (err) {
    queryFailure = describeThrownValue(err)
  }
  console.error(reconnectLatchedGateLine(key, queryFailure))
  return true
}

/**
 * The reconnect adapter's latched gate line (b.jg5 SRJ-502;
 * `reconnectLatchedAt`): nothing is typed. `queryFailure`, when given, is
 * what the latched query threw as `describeThrownValue` renders it
 * (redacted), the persona then taken as latched. Pure.
 *
 *   [slack] reconnectSession: persona=<key> is latched[ (the latched query failed: <queryFailure> — taken as latched)] — not typing /mcp reconnect; nothing done (b.jg5 SRJ-502)
 */
export function reconnectLatchedGateLine(key: string, queryFailure?: string): string {
  const failure = queryFailure === undefined ? '' : ` (the latched query failed: ${queryFailure} — taken as latched)`
  return `[slack] reconnectSession: persona=${key} is latched${failure} — not typing /mcp reconnect; nothing done (b.jg5 SRJ-502)`
}

/**
 * b.jdc, b.jg5 SRJ-606: the reconnect adapter's verdict for a persona whose
 * row reads `ask_user` or `check_permission` (see
 * `_buildReconnectSessionAdapter`), b.jg5 SRJ-117's "b.jdc reconnect
 * verdict" column. Nothing is ever typed into such a row (b.rmy). But a
 * session that dies under a prompt keeps its row in that state
 * (agent-director only refreshes a row at SessionEnd and leaves reaping to
 * its findMissing sweep), so the row alone is no proof anyone is waiting on
 * a prompt. Checked in order:
 *   - a launch for the persona is in flight → 'transient', first and with no
 *     agent-director call and no notice: the launch owns the session;
 *   - otherwise one `read-pane` of the persona's own row through the shared
 *     reader (`readPersonaOwnPane`: `PROBE_PANE_READ_LINES`, the row state
 *     the adapter read as the recorded state), with no tmux call, mapped:
 *     - CONFLICT or UNUSABLE NAME (the reader latched the persona with that
 *       row state and logged its line, b.jg5 SRJ-501, SRJ-512), or a persona
 *       already latched, which the reader does not read → 'transient', with
 *       no deferral noted and no notice (`promptRowLatchedLine`);
 *     - an UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *       `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *       SRJ-205) → 'transient', nothing more called
 *       (`promptRowPaneReadStoppingLine`);
 *     - latched by the time the read answers (`latchedNow`, the adapter's
 *       `reconnectLatchedAt` for the persona; b.jg5 SRJ-502) → 'transient',
 *       with no sweep, no deferral noted and no notice;
 *     - a pane → the deferral below: a pane leads at most to the deferral.
 *       It may be a single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no
 *       proof that the worker's own session is there, and nothing is typed
 *       on it. The backstop is the later reconnect's `send-keys`
 *       (`reconnectMcpWithCause`), made only once a later tick reads the row
 *       `waiting`, or shows a `working` row stale: on a live row that is not
 *       `pending` it answers CONFLICT "not this launch's session" when a
 *       leftover holds the persona's session, and then nothing is typed, P
 *       latches (b.jg5 SRJ-501) with its CONFLICT notice posted once, and
 *       the refused `send-keys` is never retried (SRJ-118);
 *     - GONE (`ErrTmuxCaptureFailed`: agent-director found no pane of the
 *       row's launch) → the run of deferrals on the row ends, the dead-tmux
 *       sweep runs (`escalateRowWithNoPane`, verdict `prompt-row-tmux-gone`)
 *       and the answer is escalate-dead carrying that verdict
 *       (`escalateDeadWith`), with no notice (`promptRowPaneGoneLine`);
 *     - the row absent (`ErrSpawnNotFound`) → the same, carrying the verdict
 *       `row-absent-at-pane-read`: a row read that takes the GONE column
 *       without being a GONE (b.jg5 SRJ-117; `promptRowAbsentAtPaneReadLine`);
 *     - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *       `ad-config-malformed` outage, b.jg5 SRJ-316) or UNCLASSIFIED (b.jg5
 *       SRJ-105: the wrapper reported the persona's unclassified-error
 *       episode, or the reader did after an `ErrInvalidFlags` re-check) →
 *       taken as alive, with one line naming the class
 *       (`promptRowTakenAsAliveLine`), then the deferral below: a read that
 *       could not run is never proof the session is dead (b.rmy);
 *     - ENVIRONMENT (the wrapper raised the `tmux-unavailable` outage, b.jg5
 *       SRJ-311) → 'transient', with no deferral noted and no notice
 *       (`promptRowPaneReadEnvironmentLine`).
 * The deferral is one more deferral on the row (`checkPromptRowDeferral`):
 * once the run has lasted `PROMPT_ROW_SWEEP_AFTER_MS`, it sweeps and reads
 * the row again, and a row now `ended` or `missing` answers escalate-dead
 * carrying `row-read-finished`, a row read and not dead evidence;
 * a persona latched once that sweep is done (a post-run `get` of its own row
 * read a `provenance_conflict` note, b.jg5 SRJ-114, SRJ-120, or the latch
 * answers it latched) gets no row read and is never escalated: the check
 * answers `latched`, and this answers 'transient' with no notice, since the
 * persona is held (b.jg5 SRJ-502) and its latch's own notice already tells
 * the human (SRJ-508). Otherwise the latch is asked once more (`latchedNow`)
 * right before `deferPromptRow`, which defers and raises the
 * `blocked-on-prompt` notice: a persona latched meanwhile (for example by a
 * launch outside the restart serializer during the `read-pane`) gets
 * 'transient' with no notice.
 * Each escalate-dead answer carries its verdict (`escalateDeadWith`, b.jg5
 * SRJ-611): `prompt-row-tmux-gone`, dead evidence; `row-absent-at-pane-read`
 * and the 10-minute sweep's `row-read-finished`, row reads that are not.
 * After it restart.ts re-probes and, when the row reads dead, relaunches the
 * persona in the same run (b.d61), killing first only for dead evidence; a
 * row the sweep leaves live may stay live for further ticks (b.jg5 SRJ-120), each
 * escalate-dead tick sweeping again with no step beyond the sweep and the
 * slow-recovery notice posted once after 3 such ticks (b.jg5 SRJ-610,
 * SRJ-1010). A refused sweep at either step (b.jg5 SRJ-105) answers
 * 'transient', with no notice: nothing is re-probed, killed or relaunched.
 * Never throws: the reader, the sweep and the deferral check swallow their
 * own failures.
 */
async function promptRowReconnectVerdict(
  key: string,
  state: string,
  latchedNow: () => boolean,
): Promise<ReconnectEscalateDead | 'transient'> {
  if (isLaunchInFlight(key)) {
    console.error(`[slack] reconnectSession: persona=${key} is ${state} and a launch for it is in flight — deferring to a later tick (b.jdc)`)
    return 'transient'
  }
  const read = await readPersonaOwnPane(key, {
    nLines: PROBE_PANE_READ_LINES,
    // The adapter has just read the row in this prompt state.
    lastRead: latchRowStateRead(state),
    site: PROMPT_ROW_PANE_READ_SITE,
  })
  if (read.kind === PANE_READ_LATCHED) {
    console.error(promptRowLatchedLine(key, state))
    return 'transient'
  }
  // b.jg5 SRJ-205: the reader's version re-check decided that the server
  // stops → nothing more is called for the persona.
  if (read.kind === PANE_READ_UNCLASSIFIED && read.stopping === true) {
    console.error(promptRowPaneReadStoppingLine(key, state, read))
    return 'transient'
  }
  // b.jg5 SRJ-502: latched during the read → no sweep, no deferral, no notice.
  if (latchedNow()) return 'transient'
  switch (read.kind) {
    case PANE_READ_PANE:
      return promptRowDeferral(key, state, latchedNow)
    case PANE_READ_GONE:
      endPromptRowDeferral(key)
      console.error(promptRowPaneGoneLine(key, state, read))
      return escalateRowWithNoPane(key, 'prompt-row-tmux-gone', latchedNow)
    case PANE_READ_ABSENT:
      endPromptRowDeferral(key)
      console.error(promptRowAbsentAtPaneReadLine(key, state, read))
      return escalateRowWithNoPane(key, ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, latchedNow)
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
    case PANE_READ_UNCLASSIFIED:
      console.error(promptRowTakenAsAliveLine(key, state, read))
      return promptRowDeferral(key, state, latchedNow)
    case PANE_READ_ENVIRONMENT:
      console.error(promptRowPaneReadEnvironmentLine(key, state, read))
      return 'transient'
  }
}

/** The site label of the prompt-row verdict's read, the head of the shared reader's latch line. */
const PROMPT_ROW_PANE_READ_SITE = 'reconnectSession: prompt row'

/**
 * b.jdc: `promptRowReconnectVerdict`'s deferral, for a pane or a read taken
 * as alive: one more deferral on the row (`checkPromptRowDeferral`), then
 * escalate-dead for a row its 10-minute sweep found `ended` or `missing`,
 * carrying the cause `row-read-finished`, a row read and not dead evidence
 * (b.jg5 SRJ-609, SRJ-611), as the check's line says,
 * 'transient' with no notice for a refused sweep or a persona latched after
 * it, and otherwise, unless `latchedNow` finds the persona latched right
 * before it (b.jg5 SRJ-502: 'transient', no notice), `deferPromptRow`'s
 * deferral and notice. Never throws.
 */
async function promptRowDeferral(
  key: string,
  state: string,
  latchedNow: () => boolean,
): Promise<ReconnectEscalateDead | 'transient'> {
  const deferral = await checkPromptRowDeferral(key, state)
  if (deferral === 'escalate') return escalateDeadWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED)
  if (deferral === 'refused') return 'transient'
  // b.jg5 SRJ-502: latched after the sweep (its line is logged there): no notice.
  if (deferral === 'latched') return 'transient'
  // b.jg5 SRJ-502: latched elsewhere while the read or the deferral check was
  // awaited (the gate logs its line): no notice.
  if (latchedNow()) return 'transient'
  return deferPromptRow(key, state)
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * (`ask_user` or `check_permission`) and the row's `read-pane` answered GONE
 * (b.jdc, b.jg5 SRJ-606); `read` is that failure. Exported for tests.
 *
 * @internal
 */
export function promptRowPaneGoneLine(key: string, state: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is ${state} but agent-director's read-pane found no pane of its launch: ${read.description} — not deferring; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-606)`
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * but was absent (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117);
 * `read` is that failure. Exported for tests.
 *
 * @internal
 */
export function promptRowAbsentAtPaneReadLine(key: string, state: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is ${state} but its agent-director row was absent at the pane read: ${read.description} — not deferring; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-117)`
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * and its `read-pane` answered UNAVAILABLE, CONFIG or UNCLASSIFIED, taken as
 * alive (b.jdc, b.jg5 SRJ-606, SRJ-117, SRJ-105); `read` is that failure.
 * Exported for tests.
 *
 * @internal
 */
export function promptRowTakenAsAliveLine(key: string, state: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and reading its pane failed: ${read.description} — taken as alive (no proof the session is gone); deferring as for a pane (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-606, SRJ-117)`
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * and its `read-pane` answered ENVIRONMENT (b.jg5 SRJ-117, SRJ-311): the
 * wrapper raised the `tmux-unavailable` outage; no deferral is noted and no
 * notice raised. `read` is that failure. Exported for tests.
 *
 * @internal
 */
export function promptRowPaneReadEnvironmentLine(key: string, state: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and reading its pane failed: ${read.description} — tmux is not available; deferring to a later tick, no deferral noted and no notice (${paneReadClassNote(read)}; b.jg5 SRJ-117, SRJ-311)`
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * and its `read-pane` carried the stop mark of a version re-check that
 * decided that the server stops (b.jg5 SRJ-204, SRJ-205); `read` is that
 * failure. Exported for tests.
 *
 * @internal
 */
export function promptRowPaneReadStoppingLine(key: string, state: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`
}

/**
 * `promptRowReconnectVerdict`'s line when persona `key`'s row reads `state`
 * and the shared reader answered latched: its CONFLICT or UNUSABLE NAME
 * answer latched the persona (the reader logged that line), or the persona
 * was already latched and was not read (b.jg5 SRJ-501, SRJ-502, SRJ-512).
 * Exported for tests.
 *
 * @internal
 */
export function promptRowLatchedLine(key: string, state: string): string {
  return `[slack] reconnectSession: persona=${key} is ${state} and is latched — deferring; no deferral noted, no notice, nothing typed (b.jg5 SRJ-502)`
}

/**
 * b.f2b: the reconnect adapter's verdict for a persona whose row reads
 * `ask_user` or `check_permission` and whose session is not known to be gone
 * (see `promptRowReconnectVerdict`):
 * `/mcp reconnect` + Enter could confirm the dialog's default, so nothing is
 * typed. Logs the deferral, raises the `blocked-on-prompt` not-connected
 * notice (once per episode) and returns 'transient'. The notice says that,
 * once the prompt is answered, CSCB reconnects the persona when it can tell
 * the session is idle again: the restart path runs only with auto-restart on
 * (`scheduleRestart` arms nothing while `session_restart_delay` is 0), and
 * its later attempts reconnect a `waiting` row, or a `working` row the
 * positive-idle rule shows stale.
 */
function deferPromptRow(key: string, state: string): 'transient' {
  console.error(
    `[slack] reconnectSession: persona=${key} is ${state} — its session waits on a prompt or dialog; not typing /mcp reconnect into it, deferring to a later tick (b.f2b/b.rmy)`,
  )
  notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
  return 'transient'
}

/**
 * A launch start as `deferPendingRow` logs it: timestamp characters only
 * (digits, `T`, `Z`, `:`, `.`, `+`, `-`), at most 40 of them. agent-director
 * supplies the value, so one that fails this (a line break that could fake a
 * `[slack]` line, or any other text) is left out of the line rather than
 * echoed. Exported for tests.
 *
 * @internal
 */
export const LAUNCH_START_LOG_RE = /^[0-9TZ:.+-]{1,40}$/

/**
 * `deferPendingRow`'s first line for persona `key` (b.dup; b.jg5 SRJ-409),
 * naming the launch start `launchStartedAt` only when it passes
 * `LAUNCH_START_LOG_RE` (anything else is left out):
 *
 *   [slack] Deferring persona=<key>: its row reads pending[ (launch started <ts>)] — its session has not started (SessionStart has not fired) and agent-director refuses send-keys until it does; no reconnect typed, nothing counted; the restart path defers the pending row to the pending-row step, whose own lines say what follows (b.dup; b.jg5 SRJ-409)
 *
 * It says only what the deferral itself does: the pending-row step decides
 * whether the row is armed, left undecided or sent through the live-row
 * sequence, and logs that. Pure. Exported for tests.
 *
 * @internal
 */
export function deferringPendingRowLine(key: string, launchStartedAt?: string): string {
  const launch =
    typeof launchStartedAt === 'string' && LAUNCH_START_LOG_RE.test(launchStartedAt)
      ? ` (launch started ${launchStartedAt})`
      : ''
  return `[slack] Deferring persona=${key}: its row reads pending${launch} — its session has not started (SessionStart has not fired) and agent-director refuses send-keys until it does; no reconnect typed, nothing counted; the restart path defers the pending row to the pending-row step, whose own lines say what follows (b.dup; b.jg5 SRJ-409)`
}

/**
 * The `pending` deferral for persona `key` (b.dup; b.jg5 SRJ-314, SRJ-409,
 * SRJ-411): its row reads `pending`, so its session has not started.
 * agent-director would refuse keystrokes to it (`ErrSpawnNotInteractive`,
 * which the reconnect answers as `dead-session` with cause
 * `row-not-interactive`, a route into the restart path's decision only,
 * b.jg5 SRJ-609), and the session connects its MCP servers on its own once
 * it starts. Two callers reach it, both inside the restart work's recovery
 * attempt and awaiting it: the restart work, through
 * `RestartDeps.deferPendingRow` (bound in `main()`), when its liveness probe
 * or b.d61's re-probe reads `pending`, whatever the session's connection
 * shows; and the reconnect adapter, when its own `status` read finds the
 * row `pending` (see `_buildReconnectSessionAdapter`). `launchStartedAt` is
 * the row's launch start as that `status` result showed it (raw, never
 * parsed or aged here; b.jg5 SRJ-115, SRJ-406), absent when it showed none.
 *
 * It logs the deferral (`deferringPendingRowLine`), naming the launch start
 * when one was read and it passes `LAUNCH_START_LOG_RE` (anything else is
 * left out of the line; the value itself stays as carried), then, for the
 * applied persona with this
 * key, runs the session manager's read-and-step entry
 * (`readAndStepPendingRow`): one `get` of its own row through the shared
 * own-row read, whose row supersedes the `status` read's, and the one
 * pending-row step:
 *   - covered, or undecided (a directory that cannot be resolved now): the
 *     persona's retry timer is armed in pending-only mode (the controller's
 *     armed line, cause `pending-row`); nothing typed, killed or launched;
 *   - not covered (an unmarked retired key's old life, before its new life
 *     has begun, b.jg5 SRJ-805; or a `cwd` or `config_dir` mismatch): one
 *     start of the live-row sequence, with the conversation
 *     not kept and alert context `recovery`; nothing typed and no approver;
 *   - latched by the read (a provenance note, or the persona's own row with
 *     no launch start, b.jg5 SRJ-513): nothing more; the latch's gates stop
 *     later work;
 *   - another state, no row, or a refused read: one line saying so; the
 *     next run decides again.
 * At a retry of the persona's retry timer only (`isInsideTimerRetry`; b.jg5
 * SRJ-410, rulings: the rule runs there and nowhere else, and a read-and-step
 * `get` reading `ended` counts as gone in a full-mode retry), and unless
 * `options.mayRunRule` is false:
 *   - covered: the pending-row rule's one run of that retry on the row the
 *     `get` read (`runPendingRowRuleAtRetry`); a row it reads `ended`,
 *     `missing` or gone answers gone, anything else 'pending', the abort of
 *     CSCB's own stuck launch included (b.jg5 SRJ-412: its live-row
 *     sequence started, or the abort kept the row), which the restart work
 *     answers as its `pending` deferral;
 *   - `ended`, `missing` or no row from the step's own `get`: gone.
 * A gone answer (the `DeadRowRead`) lets the restart work go
 * on to its dead branch in the same run, with no kill for a row read
 * finished and never a launch over `pending`. Reached from any other origin
 * (the start pass, a restart timer, a human-triggered restart, the
 * lost-message trigger), the deferral only arms, as before.
 * A persona that is not applied reads nothing more; `appliedPersona` is the
 * applied-persona lookup that decides it (default `getAppliedPersona`, the
 * server's applied config; a caller outside `main()` passes its own).
 * Otherwise answers 'pending' whatever the step did, a deferral like
 * 'transient': nothing is counted and no notice is raised (a launch whose
 * session never leaves `pending` gets the pending-row rule's stuck-launch
 * post at B, its only post about the launch, b.jg5 SRJ-405). A step that
 * throws is logged and changes nothing about the answer.
 *
 * Exported for tests.
 *
 * @internal
 */
export async function deferPendingRow(
  key: string,
  launchStartedAt?: string,
  appliedPersona: (key: string) => Persona | undefined = getAppliedPersona,
  options: DeferPendingRowOptions = {},
): Promise<DeferPendingRowAnswer> {
  console.error(deferringPendingRowLine(key, launchStartedAt))
  // A key that is not applied is not read again; its restart work stops on its own gates.
  const persona = appliedPersona(key)
  if (persona === undefined) return 'pending'
  // b.jg5 SRJ-410: the rule, and a gone answer, only at a retry of P's timer.
  const atRetry = options.mayRunRule !== false && isInsideTimerRetry(key)
  try {
    const step = await readAndStepPendingRow(persona)
    switch (step.kind) {
      case PENDING_ROW_STEP_NOT_PENDING:
        if (atRetry && isFinishedRowState(step.state)) return deferralGone(key, step.state)
        console.error(deferralNotPendingLine(key, step.state))
        break
      case PENDING_ROW_STEP_NO_ROW:
        if (atRetry) return deferralGone(key, LIVENESS_DEAD_ROW_NO_ROW)
        console.error(deferralNoRowLine(key))
        break
      case PENDING_ROW_COVERED: {
        if (!atRetry) break
        const ruled = await runPendingRowRuleAtRetry(persona, step.row)
        if (ruled?.kind === PENDING_ROW_RULE_GONE) return deferralGone(key, ruled.state)
        break
      }
      case PENDING_ROW_STEP_REFUSED:
        console.error(deferralRefusedLine(key, describeAdFailureForLog(step.error)))
        break
      case PENDING_ROW_STEP_LATCHED:
        // The shared read logged the latch; the latch's gates stop later work.
        break
      default:
        // Undecided: armed pending-only (the controller's line); not
        // covered: the sequence started (the step's lines).
        break
    }
  } catch (err) {
    console.error(deferralStepFailedLine(key, describeThrownValue(err)))
  }
  return 'pending'
}

/**
 * `deferPendingRow`'s line when the step's read finds the row no longer
 * `pending` (b.jg5 SRJ-409), `state` as read (rendered by
 * `renderLogMessageText`). Pure.
 *
 *   [slack] Deferring persona=<key>: its row now reads <state> — nothing more in this run; the next run decides (b.jg5 SRJ-409)
 */
export function deferralNotPendingLine(key: string, state: string): string {
  return `[slack] Deferring persona=${key}: its row now reads ${renderLogMessageText(state)} — nothing more in this run; the next run decides (b.jg5 SRJ-409)`
}

/**
 * `deferPendingRow`'s line when the step's read finds no row
 * (`ErrSpawnNotFound`; b.jg5 SRJ-409). Pure.
 *
 *   [slack] Deferring persona=<key>: its row is gone (ErrSpawnNotFound) — nothing more in this run; the next run decides (b.jg5 SRJ-409)
 */
export function deferralNoRowLine(key: string): string {
  return `[slack] Deferring persona=${key}: its row is gone (ErrSpawnNotFound) — nothing more in this run; the next run decides (b.jg5 SRJ-409)`
}

/**
 * `deferPendingRow`'s line when the step's read was refused (b.jg5 SRJ-409);
 * `failure` is the refusal as `describeAdFailureForLog` renders it
 * (redacted; an agent-director error as its reported name and message). Pure.
 *
 *   [slack] Deferring persona=<key>: its row could not be read again (<failure>) — nothing more in this run; the next run decides (b.jg5 SRJ-409)
 */
export function deferralRefusedLine(key: string, failure: string): string {
  return `[slack] Deferring persona=${key}: its row could not be read again (${failure}) — nothing more in this run; the next run decides (b.jg5 SRJ-409)`
}

/**
 * `deferPendingRow`'s line when the pending-row step threw; `failure` is the
 * thrown value as `describeThrownValue` renders it (redacted). Pure.
 *
 *   [slack] Deferring persona=<key>: the pending-row step failed: <failure> — nothing more in this run
 */
export function deferralStepFailedLine(key: string, failure: string): string {
  return `[slack] Deferring persona=${key}: the pending-row step failed: ${failure} — nothing more in this run`
}

/** What `deferPendingRow` is told about its caller. */
export interface DeferPendingRowOptions {
  /**
   * False for the reconnect adapter's deferral (`_buildReconnectSessionAdapter`),
   * whose answer the restart path reads as `pending` only: no pending-row
   * rule run and no gone answer there (the next retry's first probe reads
   * the row and runs the rule). Absent or true: the restart work's deferral,
   * at its first probe and its re-probe.
   */
  readonly mayRunRule?: boolean
}

/**
 * What `deferPendingRow` answers: 'pending' (the row is deferred, nothing
 * counted), or, at a retry of the persona's timer only, that the row is gone
 * (its `DeadRowRead`: `ended`, `missing` or `no-row`), for the restart work
 * to go on to its dead branch in the same run (b.jg5 SRJ-410, SRJ-303).
 */
export type DeferPendingRowAnswer = 'pending' | DeadRowRead

/** True for a finished row state (`ended` or `missing`), which the deferral's gone answer carries; no row is not a state, so not included. Pure. */
function isFinishedRowState(state: string): state is typeof LIVENESS_DEAD_ROW_ENDED | typeof LIVENESS_DEAD_ROW_MISSING {
  return state === LIVENESS_DEAD_ROW_ENDED || state === LIVENESS_DEAD_ROW_MISSING
}

/**
 * The deferral's line when, at a retry of the persona's timer, the row is
 * gone (b.jg5 SRJ-410, SRJ-303): no longer `pending`, so the restart work
 * goes on to its dead branch in this run, with no kill. Pure. Exported for
 * tests.
 *
 * @internal
 */
export function deferringPendingRowGoneLine(key: string, gone: DeadRowRead): string {
  return `[slack] Deferring persona=${key}: at this retry its row reads ${gone} — no longer pending; the restart run goes on to its relaunch, with no kill for a row read finished (b.jg5 SRJ-410, SRJ-303)`
}

/** The deferral's gone answer for persona `key`, with its line. */
function deferralGone(key: string, gone: DeadRowRead): DeferPendingRowAnswer {
  console.error(deferringPendingRowGoneLine(key, gone))
  return gone
}

/**
 * `workingReconnectVerdict`'s line when the `working` row's `read-pane`
 * answered GONE (b.d61, b.jg5 SRJ-603); `read` is that failure. Exported for
 * tests.
 *
 * @internal
 */
export function workingRowPaneGoneLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is working but agent-director's read-pane found no pane of its launch: ${read.description} — not deferring; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.d61, b.jg5 SRJ-603)`
}

/**
 * `workingReconnectVerdict`'s line when the `working` row was absent
 * (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117); `read` is that
 * failure. Exported for tests.
 *
 * @internal
 */
export function workingRowAbsentAtPaneReadLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: persona=${key} is working but its agent-director row was absent at the pane read: ${read.description} — not deferring; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jg5 SRJ-117)`
}

/** The site label of the `working`-row verdict's read, the head of the shared reader's latch line. */
const WORKING_ROW_PANE_READ_SITE = 'reconnectSession'

/**
 * b.d61, b.jg5 SRJ-603: the reconnect adapter's verdict for a persona whose
 * AD row reads `working` (see `_buildReconnectSessionAdapter`). A launch for
 * it in flight defers first ('transient'), with no agent-director call. Then
 * one `read-pane` of its own row through the shared reader
 * (`readPersonaOwnPane`: `FULL_PANE_READ_LINES`, the row state `working`),
 * with no tmux probe, answered by b.jg5 SRJ-117's working-row column:
 *   - a pane → the positive-idle rule decides on it (b.f2b,
 *     `checkWorkingRowPane`, the transcript located with the persona
 *     `getPersona` returns): 'reconnect' once the row is shown stale, and the
 *     adapter goes on to type `/mcp reconnect`; otherwise 'transient'. The
 *     pane may be a single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no
 *     proof that the worker's own session is there. The backstop is the
 *     reconnect's `send-keys` (`reconnectMcpWithCause`, with the row state
 *     `working`): on a live row that is not `pending` it answers CONFLICT
 *     "not this launch's session" when a leftover holds the persona's
 *     session, and then nothing is typed, P latches (b.jg5 SRJ-501) with its
 *     CONFLICT notice posted once, the refused `send-keys` is never retried
 *     (SRJ-118) and the adapter answers 'transient';
 *   - GONE → the sweep with the verdict `working-tmux-gone`
 *     (`escalateRowWithNoPane`) and an escalate-dead answer carrying that
 *     verdict (`escalateDeadWith`);
 *   - the row absent (`ErrSpawnNotFound`) → the same, carrying the verdict
 *     `row-absent-at-pane-read`;
 *   - UNAVAILABLE (timeouts included) or CONFIG → 'transient', with one
 *     deferral noted on the row (`noteWorkingRowDeferral`);
 *   - ENVIRONMENT or UNCLASSIFIED → 'transient', with no deferral noted (the
 *     wrapper raised the outage or reported the episode, b.jg5 SRJ-105); an
 *     UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *     `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *     SRJ-205) logs its own line, and nothing more is called for it;
 *   - CONFLICT or UNUSABLE NAME (the reader latched the persona and logged
 *     its line), or a persona already latched → 'transient', with no
 *     deferral noted and no notice.
 * Every answer but a pane forgets the persona's working-row evidence. A
 * refused sweep (b.jg5 SRJ-105) answers 'transient' instead of
 * escalate-dead. A persona latched by the time the read answers
 * (`latchedNow`, the adapter's `reconnectLatchedAt` for the persona; b.jg5
 * SRJ-502) gets no fold, sweep, deferral or notice: 'transient'; the check
 * on a pane asks `latchedNow` again right before each notice it can raise.
 * Never throws: the reader, `sweepDeadTmuxChannelWithCause` and
 * `checkWorkingRowPane` swallow their own failures.
 */
async function workingReconnectVerdict(
  key: string,
  getPersona: ((key: string) => Persona | undefined) | undefined,
  latchedNow: () => boolean,
): Promise<ReconnectEscalateDead | 'transient' | 'reconnect'> {
  if (isLaunchInFlight(key)) {
    console.error(`[slack] reconnectSession: persona=${key} is working and a launch for it is in flight — deferring /mcp reconnect to a later tick (b.d61)`)
    return 'transient'
  }
  const read = await readPersonaOwnPane(key, {
    nLines: FULL_PANE_READ_LINES,
    // The adapter has just read the row `working`.
    lastRead: latchRowStateRead('working'),
    site: WORKING_ROW_PANE_READ_SITE,
  })
  if (read.kind === PANE_READ_LATCHED) {
    forgetWorkingRowEvidence(key)
    console.error(
      `[slack] reconnectSession: persona=${key} is working and is latched — deferring; no deferral noted, nothing typed (b.jg5 SRJ-502)`,
    )
    return 'transient'
  }
  // b.jg5 SRJ-205: the reader's version re-check decided that the server
  // stops → nothing more is called for the persona.
  if (read.kind === PANE_READ_UNCLASSIFIED && read.stopping === true) {
    forgetWorkingRowEvidence(key)
    console.error(
      `[slack] reconnectSession: persona=${key} is working and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; not typing /mcp reconnect, nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`,
    )
    return 'transient'
  }
  // b.jg5 SRJ-502: latched elsewhere while the read was awaited → no fold,
  // sweep, deferral or notice.
  if (latchedNow()) {
    forgetWorkingRowEvidence(key)
    return 'transient'
  }
  switch (read.kind) {
    case PANE_READ_PANE:
      // b.f2b: the fold on this pane (and the transcript, for an idle one),
      // kept across attempts; `checkWorkingRowPane` logs what it found (a
      // running turn logs the b.9a7 deferral line).
      return (await checkWorkingRowPane(key, read.pane, { persona: getPersona?.(key), latchedNow })) === 'reconnect'
        ? 'reconnect'
        : 'transient'
    case PANE_READ_GONE:
      console.error(workingRowPaneGoneLine(key, read))
      return escalateRowWithNoPane(key, 'working-tmux-gone', latchedNow)
    case PANE_READ_ABSENT:
      console.error(workingRowAbsentAtPaneReadLine(key, read))
      return escalateRowWithNoPane(key, ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, latchedNow)
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
      forgetWorkingRowEvidence(key)
      console.error(
        `[slack] reconnectSession: persona=${key} is working and reading its pane failed: ${read.description} — no idle evidence, and no proof the session is gone; deferring /mcp reconnect to a later tick (${paneReadClassNote(read)}; b.jg5 SRJ-603, b.rmy)`,
      )
      // b.f2b: held back from the row once more; a long run is reported. The
      // restart path runs only with auto-restart on.
      noteWorkingRowDeferral(key, false)
      return 'transient'
    case PANE_READ_ENVIRONMENT:
    case PANE_READ_UNCLASSIFIED:
      forgetWorkingRowEvidence(key)
      console.error(
        `[slack] reconnectSession: persona=${key} is working and reading its pane failed: ${read.description} — deferring /mcp reconnect to a later tick; no deferral noted (${paneReadClassNote(read)}; b.jg5 SRJ-105, SRJ-117)`,
      )
      return 'transient'
  }
}

/**
 * The reconnect adapter's answer for a `working`, `waiting`, `ask_user` or
 * `check_permission` row whose `read-pane` found no pane of its launch (GONE)
 * or found the row absent (b.d61, b.f2b, b.jdc, b.jg5 SRJ-603, SRJ-604,
 * SRJ-606, SRJ-117): nothing is typed; the
 * persona's working-row evidence is forgotten, the dead-tmux sweep runs once
 * with `verdict` (`sweepDeadTmuxChannelWithCause`, which logs the
 * escalate-dead line) and the answer is escalate-dead carrying that same
 * verdict (`escalateDeadWith`, b.jg5 SRJ-611: the GONE verdicts are dead
 * evidence, `row-absent-at-pane-read` is not), or 'transient' when
 * the sweep was refused (b.jg5 SRJ-105). A persona `latchedNow` finds
 * latched first gets no sweep: 'transient' (b.jg5 SRJ-502). restart.ts then
 * probes liveness again in the same run (b.d61); the row may still read live
 * then and at further ticks, each escalate-dead tick sweeping again (b.jg5
 * SRJ-610). Never throws.
 */
async function escalateRowWithNoPane(
  key: string,
  verdict: EscalateDeadVerdict,
  latchedNow: () => boolean,
): Promise<ReconnectEscalateDead | 'transient'> {
  forgetWorkingRowEvidence(key)
  if (latchedNow()) return 'transient'
  const sweep = await sweepDeadTmuxChannelWithCause(key, verdict)
  return sweep.refused ? 'transient' : escalateDeadWith(verdict)
}

// ---------------------------------------------------------------------------
// Main
//
// HTTP routing strategy (roots-based session identity):
//
//   POST /mcp              — init request (no Mcp-Session-Id); creates a pending
//                            session and matches it to a persona via roots/list
//   GET/POST/DELETE /mcp   — subsequent requests (Mcp-Session-Id header required)
//   *                      — 404 for all other paths
//
// All Claude Code sessions point to the same URL: http://<host>:<port>/mcp
// Persona assignment happens after the MCP initialized notification when the
// server calls roots/list and matches the CWD, by real path, to the working
// directory of exactly one applied persona.
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // The state and inbox directories, before any file in the state directory
  // is read or written (nothing is created at import).
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(INBOX_DIR, { recursive: true })

  // b.av2 SR-3.3: one persona's stray rejection must not take the process
  // down. Installed once, before any persona connects; never at import.
  if (!unhandledRejectionHandlerInstalled) {
    process.on('unhandledRejection', createUnhandledRejectionHandler((line) => console.error(line)))
    unhandledRejectionHandlerInstalled = true
  }

  // SR-5.1: agent-director startup gate.
  // Runs before any other CSCB work — imports the library, constructs the
  // Client (whose construction probes the binary's version and applies the
  // client's own minimum), refuses a binary below CSCB's Phase 1 floor
  // (b.jg5 SRJ-203) before the Client is installed as the singleton, probes
  // the library's API surface, and verifies that the existing
  // ~/.agent-director/state.db (if any) is owned by the current user. Any
  // failure records to startup-errors.log and exits non-zero. The gate runs
  // before the configuration is read, so its client has the client's default
  // call timeout; the call-timeout start step below replaces it with the
  // persona client, built with the configured agent_director_call_timeout_ms,
  // before any other agent-director call (b.jg5 SRJ-213).
  //
  // b.jg5 SRJ-204: once the gate passes, and before the PID check or any
  // Slack connection, the runtime version re-check is installed from the
  // gate's result, in the statement right after the gate. Its first re-check
  // runs one interval later, on its own timer, whatever health_check_interval
  // is (0 included), in dry run too. Its baseline is the version the gate
  // read. After each timed re-check that does not stop, agent-director's
  // timing settings are read again (b.jg5 SRJ-209; installAdSettings below,
  // after the start's configuration resolution). A re-check that refuses
  // the binary records one startup-errors entry, then runs shutdown() with
  // a non-zero exit code; shutdown()
  // disposes the re-check before its first await, so no stop reaches a
  // shutdown already running, and a rejected shutdown still exits non-zero.
  // No outside party ends such a stop (the CLI's SIGKILL follows only its own
  // stop), so the stop first arms an unref'd deadline (shutdown-deadline.ts)
  // and sets process.exitCode to its code: a shutdown that hangs with a
  // handle still open is ended by the deadline, and one that hangs with no
  // handle open lets the process run out of work and exit on its own, with
  // that same non-zero code (b.jg5 SRJ-205). The signals leave exitCode as
  // it is. The stop can come while main() is still starting up; main()
  // checks shuttingDown after its awaits and starts nothing more once a
  // shutdown has begun.
  const startupGate = await runAgentDirectorStartupGate()
  installAdVersionRecheck({
    resolveSystemBinary,
    baselineVersion: startupGate.adVersion,
    recordStartupError,
    stop: (exitCode) => {
      armShutdownDeadline({ exitCode, exit: process.exit.bind(process), log: (line) => console.error(line) })
      process.exitCode = exitCode
      shutdown('the runtime version re-check refused the agent-director binary (see startup-errors.log)', exitCode)
        .catch(() => process.exit(exitCode))
    },
    log: (line) => console.error(line),
  })

  // Check for an existing server BEFORE any side-effectful startup work —
  // before writePidFile (which would clobber the live server's PID file),
  // and before the template overwrite and the persona Slack connections below
  // (crontable bootstrap now happens later, inside the scheduler started after
  // Bun.serve). A duplicate start must fail fast without mutating shared state.
  checkPidConflict(PID_FILE)

  // b.jg5 SRJ-801, SRJ-802: the retired-key record (retired-keys.json in the
  // state directory) is read once here, after the PID check (so a duplicate
  // start reads nothing) and before the reload controller's start resolution
  // below (which can write config.json.last-applied), the start sweep and
  // every bring-up; in dry run too. A record that exists but cannot be read,
  // parsed or validated records one retired-keys-unreadable startup-errors
  // entry naming the file and the move-aside remedy, and the start stops here,
  // before any port, PID file, Slack connection, sweep, launch or last-applied
  // write: the start never guesses. Otherwise `retiredKeys` is the server's
  // one store: only the server writes the file, through it, and nothing else
  // builds a store.
  const retiredKeysStart = readRetiredKeysAtStart(STATE_DIR, { log: (line) => console.error(line) })
  if (retiredKeysStart.kind === 'refused') process.exit(1)
  const retiredKeys: RetiredKeyStore = retiredKeysStart.store
  // b.jg5 SRJ-809: the server's one old-life hold set, in memory only, built
  // beside the store: the reload controller's apply step 1 begins holds in it
  // and the session manager (installed below, before the start sweep) ends
  // them at its reads, begins the start sweep's and marks kill failures. A
  // restart drops every hold; the start sweep rebuilds the ones still needed
  // from its list and the retired-key record.
  const oldLifeHolds: OldLifeHoldSet = createOldLifeHoldSet({ log: (line) => console.error(line) })

  // The agent-director store owns session-id state; CSCB keeps no
  // sessions.json registry (SR-7.1).

  // b.av2 SR-8.7: every start runs the last-applied record
  // (config.json.last-applied) when there is one, so an edit of config.json
  // that was never applied does not run. Without a record, config.json is
  // validated, recorded and applied. A missing, unreadable, pre-persona or
  // invalid file (with no record), a record that cannot be read or validated,
  // or a record that cannot be written stops the start here with one logged
  // line, before any port, PID file, Slack connection or spawn, and after the
  // PID check, so a duplicate start never writes the record. The start pass
  // is the controller's lifecycle bring-up, run below after the pre-launch
  // steps; the bring-up controller it uses is built further down.
  // The detection tick (b.av2 SR-8.2, SR-8.3) is armed only by
  // startDetection() after the start bring-up pass below; it reads the held
  // credentials digests and bring-up states from the bring-up controller
  // built further down.
  //
  // The applied config at the start (the record's at a start from the
  // record): the server-wide values that hold until the next start, e.g. the
  // restart delay. Set once, below, right after the start resolves, and never
  // replaced; a confirmed apply replaces only `personaConfig`'s persona set.
  // Declared here, before the controller whose onApplied reads it, so that
  // closure never depends on declaration order (no temporal dead zone).
  let appliedConfig!: PersonaConfig
  // A confirmed apply's teardowns (step 2, destructive old halves included),
  // in-place updates (step 3), credentials changes (step 4), template
  // refresh (step 5) and bring-ups (step 6, recoveries and destructive new
  // halves included), composed in persona-lifecycle.ts once the bring-up
  // controller exists (below).
  // Declared here for the same reason as appliedConfig; an apply runs only
  // after the start bring-up pass, long after it is set.
  let personaLifecycleOps!: PersonaLifecycle
  // b.jg5 SRJ-803, SRJ-804, SRJ-1511: a confirmed apply's step 1 records the
  // retired keys (removed personas, a rename's old key, destructive modifies'
  // old halves, and an added persona's key held only in memory) in
  // `retiredKeys`, the one store loaded above, before it rewrites the
  // last-applied record, and restores the store when that rewrite fails. The
  // store writes with durableWriteFileSync, the controller's default writer.
  // The start resolution records nothing.
  const reload = createReloadController({
    paths: reloadFilePaths(CONFIG_PATH),
    retiredKeys,
    // b.jg5 SRJ-809: apply step 1 begins its old-life holds in the one hold
    // set, once the last-applied rewrite has succeeded.
    oldLifeHolds,
    // b.jg5 SRJ-808, SRJ-404: apply step 1 stops the dialog approver of each
    // key it records, right after the record and before the last-applied
    // rewrite and the teardown's kill; no pending-row rule run follows.
    stopApprover: (key) => stopDialogApprover(key, APPROVER_STOP_RETIRED_KEY),
    lifecycle: {
      // b.jg5 SRJ-205: the pass's launch pool reads
      // `shuttingDown` live before starting each launch, so a shutdown begun
      // during the pass (a version re-check's stop included) starts no
      // queued launch and changes no agent-director row.
      startBringUp: (applied) => startupSessionManager(applied, { bringUp: personaBringUps, isShuttingDown: () => shuttingDown }),
      teardown: (persona) => personaLifecycleOps.teardown(persona),
      updateInPlace: (change) => personaLifecycleOps.updateInPlace(change),
      bringUp: (persona, applied, options) => personaLifecycleOps.bringUp(persona, applied, options),
      reconnectCredentials: (persona, applied) => personaLifecycleOps.reconnectCredentials(persona, applied),
      refreshTemplate: (applied) => personaLifecycleOps.refreshTemplate(applied),
    },
    log: (line) => console.error(line),
    tickDriver: createReloadTickDriver({ log: (line) => console.error(line) }),
    dryRun: isDryRun(),
    heldCredentialsDigest: (key) => bringUps?.credentialsDigest(key),
    // For the preview: a persona broken by its credentials is brought up at
    // apply rather than reconnected (b.av2 SR-8.6).
    bringUpState: (key) => bringUps?.state(key),
    // Bug b.g57: the preview checks an added persona's claude_config_dir with
    // the launch's own check, as its bring-up will.
    checkConfigDir: checkLaunchConfigDir,
    slackClientFactory: PRODUCTION_SLACK_CLIENT_FACTORY,
    // b.av2 SR-8.6 step 1: once the record holds a confirmed change, the
    // server runs its persona set. Server-wide settings keep their start-time
    // values (the next start applies them). Everything that reads the applied
    // set reads `personaConfig` at call time: the bring-up controller's
    // applied set, the reply-guard step, routing, the notifier, /interject,
    // cron, the health work list and MCP admission.
    // An apply before the start resolved is never expected (detection is
    // armed only after the start bring-up); it throws rather than build a
    // config without the start-time values, and the controller logs it.
    onApplied: (config) => {
      if (appliedConfig === undefined) throw new Error('a confirmed apply ran before the start resolved its configuration')
      personaConfig = configInEffect(appliedConfig, config)
    },
  })
  reloadController = reload
  const start = reload.resolveStart()
  if (start.kind === 'refused') process.exit(1)
  personaConfig = start.config
  // b.av2 SR-6.2: the trust patch precedes every launch. Installed as soon as
  // the persona config is set — before the Slack connections, Bun.serve and
  // initRestart — so no launch path (start, restart or a human trigger) can
  // run unpatched.
  setPreLaunchTrustPatcher(trustPatchPersona)
  // b.av2 SR-9.4: the reply-guard steps (record, launched-with dir, hook
  // install) run immediately before each spawn or resume. The step gets a
  // getter for the applied persona set (read at the launch and again by its
  // undo, never a snapshot) and the server's own state directory. With no
  // persona config the installed step does nothing: no record, no patch.
  setPreLaunchReplyGuard((persona) =>
    personaConfig === null ? undefined : preLaunchReplyGuard(persona, () => personaConfig?.personas, STATE_DIR),
  )
  console.error(`[slack] Loaded persona config: ${personaConfig.personas.length} persona(s)`)
  // The start-time applied config (declared before the reload controller).
  appliedConfig = personaConfig

  // b.jg5 SRJ-209: agent-director's timing settings. Read once here, after
  // the startup gate has passed and the start has resolved its configuration,
  // and before the boot template install and the start bring-up; in dry run
  // too. The install also registers the re-read on the version re-check's
  // 120 s tick, so the file is read again only at those ticks, whatever
  // health_check_interval is, and never after shutdown() disposes the
  // re-check. It reads the file under the server process's HOME, never a
  // HOME from the configuration or a persona. Its outcome never stops the
  // start: a refused read logs one line and leaves the defaults in effect.
  // The call-timeout check right after reads the values this read left in
  // effect.
  installAdSettings()

  // b.jg5 SRJ-213: the call timeout. Once, right after the settings read
  // above and before the boot template install (the first agent-director
  // call after the start's resolution) and the start pass, in dry run too:
  // the startup check writes at most one warning when
  // agent_director_call_timeout_ms is at or below the need the values in
  // effect give (it never stops the start), then the persona client is built
  // with the start-time configuration's value and installed in place of the
  // gate's client, so every later agent-director call the server makes uses
  // it (a later confirmed apply's value takes effect at the next start). A
  // construct failure or a floor refusal of that client records one startup
  // error and exits non-zero, as the gate does.
  await _runCallTimeoutStartStep(appliedConfig)
  // A re-check stop may have begun a shutdown during the await above; nothing
  // more is started.
  if (shuttingDown) return

  // SR-3.2: refresh the slack-channel-bot agent-director template on every
  // boot, after the persona config is set: its memory-read rules cover the
  // personas' effective config dirs. Atomic replacement via
  // Client.makeTemplate(..., overwrite: true) gives us "ensure post-state"
  // semantics. Fatal startup error on failure. A confirmed apply's step 5
  // refreshes its memory-read rules and keeps the rest of what this wrote.
  const installedTemplate = await installSlackChannelBotTemplate(personaConfig)
  // A re-check stop may have begun a shutdown during the await above; it has
  // already stopped what it found, so nothing more is started (no poller,
  // no Bun.serve, no scheduler).
  if (shuttingDown) return

  // Initialize message archive if configured. Name lookups run on the
  // receiving persona's own client (b.av2 SR-4.1).
  if (personaConfig.message_archive_db) {
    try {
      const archiveDb = openArchiveDatabase(personaConfig.message_archive_db)
      archiveWrite = createPersonaArchiveWriter(archiveDb, createPersonaNameResolverSource(clientFor), (err) => {
        console.error(`[slack] message-archive write failed: ${describeThrownValue(err)}`)
      })
      console.error(`[slack] Message archive enabled: ${personaConfig.message_archive_db}`)
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      console.error(`[slack] Warning: failed to initialize message archive: ${cause}`)
      archiveWrite = undefined
    }
  }

  // NOTE: crontable bootstrap (ensureCrontableExists) is NOT called here. The
  // cron scheduler's start() is the ONLY caller of ensure-exists, wired after
  // Bun.serve() below.

  // b.jg5 SRJ-1016: the one set of per-persona notice episodes, on the system
  // clock, built before the retry controller and the start pass, so every
  // poster reaches it from the first launch. Its posts go through the persona
  // notifier. A teardown forgets the key's episodes and shutdown closes it.
  // b.jg5 SRJ-1003: its teardown query is the one notifier's
  // `teardownWindowState`: from a persona teardown's submit until its window
  // opens the key's posts are muted, and while the window is open its
  // log-only routes (the unclassified alert for a key no longer applied,
  // every kill-failure alert for the key) go through the notifier too, whose
  // window writes them; the survivor version's class rides in the options.
  const noticeEpisodes = createPersonaEpisodes({
    sink: (key, text, options) => {
      void personaNotifier.notify(key, text, options)
    },
    log: (line) => console.error(line),
    teardownWindow: (key) => personaNotifier.teardownWindowState(key),
  })
  personaEpisodes = noticeEpisodes
  // b.jg5 SRJ-1016, SRJ-1017: the stuck-launch episode lives in these
  // episodes; the session manager's shared own-row reads end it on a row
  // read live out of `pending` (installed before the start pass, so the
  // first read already ends it). Shutdown's `close` ends every episode.
  setStuckLaunchEpisodes(noticeEpisodes)

  // b.jg5 SRJ-501, SRJ-508, SRJ-1016: the server's one per-persona latch, in
  // memory only (nothing is loaded from a file), built before the start pass
  // so it exists before any launch can latch a persona. Its one notice
  // reaction is bound to the notice episodes and posts every latch kind's
  // notice: a latch, or a relatch with a new case, ends the persona's open
  // episodes of the other latch kinds silently, begins the episode of its own
  // kind (CONFLICT, the unusable-recorded-name hold or the
  // launch-start-not-recorded hold) and posts that kind's
  // notice once through the persona notifier; the same case posts nothing.
  // b.jg5 SRJ-305, SRJ-310, SRJ-313, SRJ-502: its holds are bound first, so
  // they run before the notice on every set: the persona's retry timer stops
  // through the controller's `stop` with the latch's reason (never the
  // condition-end entry, whose `pending` and kill-failure exceptions do not
  // apply to a latch), its tmux-unresponsive condition ends silently (no
  // recovery notice; the latch's notice follows), its unclassified-error
  // episode ends, and its slow-recovery count resets and that episode ends
  // silently (b.jg5 SRJ-610, SRJ-1016), and its stuck-launch episode ends
  // silently (b.jg5 SRJ-1016). The first four are built below; no latch
  // can be set before the start pass, by which time they exist.
  const conflictLatch = createConflictLatch({ log: (line) => console.error(line) })
  bindConflictLatchHolds(
    conflictLatch,
    {
      stopRetryTimer: (key) => retryTimers.stop(key, UNAVAILABLE_RETRY_STOP_LATCHED),
      endTmuxUnresponsive: (key) => {
        tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_LATCHED, undefined, { silent: true })
      },
      endUnclassifiedError: (key) => {
        unclassifiedErrors.end(key, UNCLASSIFIED_ERROR_END_LATCHED)
      },
      endSlowRecovery: (key) => {
        slowRecovery.endForLatch(key)
      },
      endStuckLaunch: (key) => {
        endStuckLaunchEpisodeForLatch(noticeEpisodes, key, (line) => console.error(line))
      },
    },
    (line) => console.error(line),
  )
  bindConflictNotice(conflictLatch, noticeEpisodes)
  // b.jg5 SRJ-505: the latch re-check, built once through the session
  // manager's one builder (the recovery harness calls the same), on the
  // system clock and the one persona lifecycle serializer. Its observer is
  // bound after the holds and the notice, so a set runs the read, the set,
  // the holds, the notice, then the timer's arm: a persona that latches gets
  // one timer, its first round 120 s later whatever health_check_interval
  // is, and a relatch adds none. Its clear hand-off clears through the one
  // clear entry (one recovery post through the notice episodes, the episode
  // ended, the timer stopped) and, after a clear that launched nothing,
  // retries the persona at once (b.jg5 SRJ-506); the binding also stops a
  // persona's timer at every forget of its latch (the persona teardown's,
  // bound below), and shutdown() stops every timer. The health tick is not
  // handed it.
  const latchRecheck = buildLatchRecheck({
    latch: conflictLatch,
    clock: SYSTEM_PERSONA_CONNECTION_CLOCK,
    serialize: personaLifecycle.run,
    appliedConfig: () => personaConfig,
    log: (line) => console.error(line),
    episodes: noticeEpisodes,
    // b.av2 SR-6.4: a round's launch asks the relaunch gate the restart path
    // asks. It is built below; the first round comes 120 s after a latch,
    // and a round that asks before it is built finds it throwing, which the
    // round reads as not up (no launch).
    canRelaunch: (key) => canRelaunch(key),
    // b.av2 SR-6.3: the cap wins over the re-check. A persona at the restart
    // cap gets its reads, so its latch can still clear, but no launch and no
    // run of the restart path's decision from a round.
    isAtCap: (key) => backoffIsAtCap(key, RESTART_FAILURE_CAP),
  })
  latchRecheckTimers = latchRecheck
  bindLatchRecheck(conflictLatch, latchRecheck)
  // b.jg5 SRJ-510, SRJ-506: the clear by hand the `/clear-latch` route uses,
  // through the re-check's one clear entry and after-clear sequence with the
  // "cleared by hand" reason; it answers once the clear has run in the
  // persona's serializer turn.
  const clearByHand = clearByHandOf(latchRecheck)
  // b.jg5 SRJ-1011: the persona routing's lost-message state reads it.
  personaLatch = conflictLatch
  // b.jg5 SRJ-501, SRJ-502: the collision ladder latches through it on a
  // CONFLICT at a spawn or resume, and launches no latched persona. The
  // restart work, the retry action and the health tick ask it below. A
  // persona's teardown forgets its latch silently (b.jg5 SRJ-504; bound into
  // the persona lifecycle below); a server restart drops every latch with the
  // process, so there is no forget-all at shutdown.
  setConflictLatch(conflictLatch)
  // b.jg5 SRJ-114, SRJ-501: which keys are configured personas, for the note
  // rule at every read of a persona's own row (a `provenance_conflict` note on
  // a configured persona's own row latches it through the latch above). It
  // reads the applied configuration at each call, so a persona an apply adds
  // counts at once and one it removes stops counting at once; it holds no
  // state, so shutdown has nothing to undo. Installed with the latch, before
  // the start sweep and the start pass.
  setConfiguredPersonaQuery((key) => getAppliedPersona(key) !== undefined)
  // b.jg5 SRJ-807: the one retired-key store loaded above, for the clear at
  // every own-row read: any key's own row read waiting, working, ask_user or
  // check_permission while the key is recorded with its mark set clears the
  // key's entry. Installed here, with no branch, before the start sweep, the
  // start bring-up pass, the health tick and the restart path, so the first
  // row the server reads already clears; with no store installed no read
  // would clear, and an entry whose new life reads live would stay retired.
  setRetiredKeyStore(retiredKeys)
  // b.jg5 SRJ-809: the one old-life hold set built above, the one the reload
  // controller begins apply step 1's holds in, installed with no branch
  // before the start sweep (which rebuilds the holds a restart dropped, from
  // its list and the retired-key record), the start bring-up pass, the health
  // tick and the restart path, so every row read ends or re-points a hold.
  setOldLifeHolds(oldLifeHolds)
  // b.jg5 SRJ-702, SRJ-305: a persona's kill retry (the restart path's kill,
  // the live-row sequence's kills) makes no further try once the
  // persona is torn down or not up (`isPersonaUp`: serving, its bring-up
  // `up`, its key applied), or the server is shutting down; the session
  // manager asks the latch itself. It holds no state.
  setPersonaKillKeepGoingQuery({ isPersonaUp, isShuttingDown: () => shuttingDown })

  // b.jg5 SRJ-207, SRJ-1008, SRJ-1016: the server's one ErrInvalidFlags hold,
  // in memory only (a server restart ends every hold), built before the
  // start pass so it exists before any reuse spawn can hold a persona. The
  // session manager holds a persona through it when a reuse spawn answers
  // ErrInvalidFlags and the immediate version re-check passes or cannot run,
  // and answers `held` from every launch entry for a held persona with no
  // agent-director call. b.jg5 SRJ-305: its set reaction first stops the
  // persona's retry timer through the controller's `stop` with the hold's
  // reason (never the condition-end entry, whose `pending` and kill-failure
  // exceptions do not apply to a hold), then begins the persona's
  // ErrInvalidFlags hold episode and posts SRJ-1008's alert once in it
  // through the persona notifier; a second ErrInvalidFlags in the same
  // episode posts nothing. It does not end the persona's unclassified-error
  // episode (SRJ-313). The controller is built below; no hold can be set
  // before the start pass, by which time it exists. The restart work, the
  // retry action and the health tick ask it below; a teardown forgets a
  // persona's hold silently (bound into the persona lifecycle below) and
  // shutdown() forgets every hold.
  const invalidFlagsHold = createInvalidFlagsHold({ log: (line) => console.error(line) })
  bindInvalidFlagsHoldSetReaction(invalidFlagsHold, {
    stopRetryTimer: (key) => retryTimers.stop(key, UNAVAILABLE_RETRY_STOP_HELD),
    episodes: noticeEpisodes,
    log: (line) => console.error(line),
  })
  setInvalidFlagsHold(invalidFlagsHold)
  // b.jg5 SRJ-1011 state 3: the persona routing's lost-message state reads it.
  personaInvalidFlagsHold = invalidFlagsHold
  // b.jg5 SRJ-204, SRJ-207: the runtime re-check's version-changed signal is
  // the hold's end. A re-check (timed or triggered) that passes with a
  // version different from the last version seen ends every hold whose
  // version differs from the new one, or that began under none; each ended
  // persona's hold episode ends silently and, when it is still applied, it
  // is retried at once: one run of the restart path's retry entry, without
  // the delay gate, given the cause query so a skip line names what blocks
  // it. A new ErrInvalidFlags then starts a new episode with one new alert.
  onAdVersionChanged((_previousVersion, newVersion) => {
    endInvalidFlagsHoldsOnVersionChange(invalidFlagsHold, newVersion, {
      episodes: noticeEpisodes,
      isApplied: (key) => getAppliedPersona(key) !== undefined,
      retryAtOnce: (key) => {
        const persona = getAppliedPersona(key)
        if (persona === undefined) return undefined
        return runRestartRetry(key, persona.working_directory, isPersonaRetryBlocked, personaRetryBlockCause).then((outcome) => {
          console.error(`[slack] invalid-flags-hold: persona=${key} retry after its hold ended answered ${outcome} (b.jg5 SRJ-207)`)
        })
      },
      log: (line) => console.error(line),
    })
  })

  // b.jg5 SRJ-313, SRJ-1009: each persona's unclassified-error episode, held
  // in the notice episodes (so a teardown forgets it and shutdown closes it).
  // The outage state's reporting point feeds it each UNCLASSIFIED outcome in a
  // launch or recovery attempt (installed as its unclassified sink below,
  // before the start pass). Its one alert per episode is posted at the first
  // such outcome met longer than agent-director's alert threshold in effect
  // (SRJ-210) after the episode's first: to the persona's destination while
  // the persona is in the applied configuration, else written only to the
  // server log and startup-errors.log (`persona-unclassified-error`, SRJ-1013).
  // It ends when the retry timer stops because the persona's state got
  // better (the retry timer's stop observer below): a retry finds nothing
  // left to recover, a pending-only retry reads the row live out of
  // `pending` or ended or gone, or the timer's tmux condition ends; and at
  // the restart cap (`onCapReached`).
  const unclassifiedErrors = createUnclassifiedErrorEpisodes({
    episodes: noticeEpisodes,
    log: (line) => console.error(line),
    alertThresholdMs: adAlertThresholdMsInEffect,
    isConfigured: (key) => getAppliedPersona(key) !== undefined,
    logOnly: (key, text) => recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, personaUnclassifiedErrorEntryText(key, text)),
  })

  // b.jg5 SRJ-704, SRJ-1007, SRJ-1016: the kill-failure alerts, their
  // episode held in the notice episodes (so a teardown forgets it and
  // shutdown closes it). The session manager raises them from the bounded
  // kill retry's decision at the restart path's kill and the live-row
  // sequence's kills (installed here, before the start pass), the persona
  // teardown raises them with the context 'persona teardown' (its log-only
  // route, b.jg5 SRJ-704, SRJ-715; bound below; while a key's teardown
  // window is open every alert for it takes that route, written by the
  // notifier's window, b.jg5 SRJ-1003), and
  // ends a persona's episode at any read of its own row that reads `ended`
  // or `missing`, or finds it gone. A persona in the applied configuration
  // gets the alert at its destination (the ordinary version once per
  // episode, the survivor version once per bounded retry); any other gets
  // only a server-log line and a startup-errors entry (`persona-kill-failed`
  // or `persona-kill-survivor`), so the persona notifier, which drops a
  // notice for a key no longer applied, never sees it. The persona routing's
  // lost-message state reads its episode (state 4).
  const killFailureAlerts = createKillFailureAlerts({
    episodes: noticeEpisodes,
    log: (line) => console.error(line),
    isConfigured: (key) => getAppliedPersona(key) !== undefined,
    logOnly: (classLabel, entry) => recordStartupError(classLabel, entry),
  })
  setKillFailureAlerts(killFailureAlerts)
  personaKillFailureAlerts = killFailureAlerts

  // b.jg5 SRJ-610, SRJ-1010, SRJ-1016: the slow dead-session recovery
  // tracker, its count and episode held in the notice episodes (so a
  // teardown's forget clears both and shutdown's close drops them). The
  // restart work tells it each run's readings and verdicts (initRestart's
  // `slowRecovery` below), and the health tick resets its count on each tick
  // that finds the persona healthy (initHealthCheck's
  // `resetSlowRecoveryCount` below): the third escalate-dead verdict in a
  // row whose re-probe still reads the row live posts SRJ-1010 once per
  // episode through the persona notifier. A row read of `ended`, `missing` or no row
  // ends the episode; the latch's hold above ends it at a latch. It adds no
  // timer and makes no agent-director call.
  const slowRecovery = createSlowRecoveryTracker({
    episodes: noticeEpisodes,
    log: (line) => console.error(line),
  })

  // b.jg5 SRJ-301, SRJ-303, SRJ-305: one UNAVAILABLE retry controller, on the
  // system clock, installed below as the outage state's trigger sink before
  // the start pass (whose launches are the first attempts that can arm it).
  // A full-mode retry reruns the restart path's decision through the restart
  // module's retry entry, and so through the one per-persona serializer
  // initRestart gets; a pending-only retry reads the persona's row with the
  // session manager's row read. Either stops on shutdown, a persona no longer
  // applied, latched, held on ErrInvalidFlags, not up (the relaunch gate) or
  // at the restart cap. The gate is built further down and
  // initRestart runs later still: no statement in between awaits, and no
  // retry falls due before 30 s. Dry run arms nothing, since it makes no
  // agent-director call. b.jg5 SRJ-310: a retry that finds the persona's row
  // live out of `pending` with its session connected with its stream ends
  // its tmux-unresponsive condition (built just below; no retry runs before
  // it exists). b.jg5 SRJ-308: every retry, one skipped for work in flight
  // included, is the condition's onset check with the health check off.
  // b.jg5 SRJ-309: every stop of a persona's timer, whatever its reason (a
  // teardown and shutdown included), cancels the condition's alert check
  // not yet posted while it holds, since the alert says CSCB keeps retrying;
  // b.jg5 SRJ-305, SRJ-308: the same call holds the condition's onset back
  // until a later refusal (never again after a terminal stop).
  // b.jg5 SRJ-311, SRJ-312: the same healthy-row observation (a live row out
  // of `pending`, connected with its stream) also clears the persona's
  // `tmux-unavailable` outage, with that reading, which the cleared-flag
  // observer below passes on to the timer's condition-end entry.
  // b.jg5 SRJ-313: the same stop observer then tells the unclassified-error
  // episodes, which end the persona's episode only when the stop's reason is
  // that a retry found nothing left to recover, that a pending-only retry
  // read the row live out of `pending` or ended or gone, or that the
  // `tmux-unavailable` condition cleared or the `tmux-unresponsive`
  // condition ended. Each consumer is isolated, so one that throws does not
  // skip the other.
  // b.jg5 SRJ-303, SRJ-305, SRJ-404: the retry action's gate before any call
  // (applied, latched, held on ErrInvalidFlags, up, the cap, shutdown), one
  // object for the retry action and the pending-row rule's run at a dialog
  // approver's stop, so that run is gated as a retry's is.
  const retryRunGate: RetryRunGateDeps = {
    appliedPersona: getAppliedPersona,
    canRelaunch: (key) => canRelaunch(key),
    isAtCap: (key) => backoffIsAtCap(key, RESTART_FAILURE_CAP),
    isShuttingDown: () => shuttingDown,
    // b.jg5 SRJ-303, SRJ-305: a retry of a latched persona makes no call and stops the timer.
    isLatched: (key) => conflictLatch.isLatched(key),
    // b.jg5 SRJ-207, SRJ-303, SRJ-305: so does a retry of a persona held on
    // ErrInvalidFlags, whatever its causes.
    isHeld: (key) => invalidFlagsHold.isHeld(key),
  }
  const retryTimers = createUnavailableRetryController({
    log: (line) => console.error(line),
    onRetryFire: (key, firedAt) => tmuxUnresponsive.onsetAtRetry(key, firedAt),
    onStopped: (key, reason) => {
      try {
        tmuxUnresponsive.cancelAlert(key, reason)
      } catch {
        /* isolated: the episode's stop handler still runs */
      }
      try {
        unclassifiedErrors.retryStopped(key, reason)
      } catch {
        /* isolated: a stop never fails because of an observer */
      }
    },
    action: createFullModeRetryAction({
      retry: runRestartRetry,
      ...retryRunGate,
      // b.jg5 SRJ-303: only work that blocks a retry skips it; a running
      // dialog approver alone never does (SRJ-401). The skip's again-reason
      // and the restart retry's skip line name what blocks it.
      isInFlight: isPersonaRetryBlocked,
      retryBlockCause: personaRetryBlockCause,
      readRow: readPersonaRowState,
      isSessionConnected: (key) => getSessionByPersona(key)?.connected === true,
      hasSessionStream,
      endTmuxUnresponsive: (key, reading) => {
        tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading)
        clearOutageFlag(key, 'tmux-unavailable', reading)
      },
      // b.jg5 SRJ-409, SRJ-411: a pending-only retry whose row read shows
      // `pending` reads the applied persona's row once more with `get` and
      // decides whether it is covered: a covered or undecided row is armed
      // pending-only and kept; one that is not covered goes through the
      // live-row sequence, with no launch or approver of the retry's own.
      stepPendingRow: (key) => retryPendingRowStep(key, getAppliedPersona(key)),
    }),
  })
  unavailableRetry = retryTimers

  // b.jg5 SRJ-705, SRJ-706: the one live-row sequence registry, on the system
  // clock, its sequences composed by the session manager's one builder over
  // the kill-failure alerts installed above (the builder's default), the
  // retry controller's arm and the applied configuration read at each call;
  // each sequence runs in its own recovery
  // attempt for its persona, detached from its starter's. Installed in the
  // session manager before the start pass and before any path that can start
  // a sequence; the latch installed above gets its set observer here, so a
  // latch of a persona stops its sequence. Its running query is in "blocks a
  // retry" (and so in "in flight for P"), the lost-message routing's
  // sequence/wait member and the restart work's gate; a teardown stops a
  // persona's sequence right after its approver, and shutdown() closes it.
  const sequences = createLiveRowSequenceRegistry({
    deps: buildLiveRowSequenceDeps({
      retryArm: retryTimers,
      clock: SYSTEM_PERSONA_CONNECTION_CLOCK,
      log: (line) => console.error(line),
      appliedConfig: () => personaConfig,
    }),
    runAttempt: runDetachedRecoveryAttempt,
    // b.jg5 SRJ-811, SRJ-1512: an old-life wait runs outside every attempt.
    runOutsideAttempt: (run) => runOutsideAttempts(run),
  })
  liveRowSequences = sequences
  setLiveRowSequenceRegistry(sequences)

  // b.jg5 SRJ-410, SRJ-404: the one pending-row rule, built through its
  // factory over the session manager's one dependency builder (the notice
  // episodes above for its held post) and installed beside the sequence
  // registry, before the start pass. It runs only at a retry of a persona's
  // timer (the pending-only step, the restart path's deferral, the ladder's
  // `pending` step) and once at a dialog approver's stop, which takes the
  // persona's turn in the lifecycle serializer and is dropped when the retry
  // action's gate would stop a retry then; every other origin only arms.
  setPendingRowRule({
    rule: createPendingRowRule(
      buildPendingRowRuleDeps({
        appliedPersona: getAppliedPersona,
        episodes: noticeEpisodes,
        log: (line) => console.error(line),
      }),
    ),
    serialize: personaLifecycle.run,
    gate: retryRunGate,
  })

  // b.jg5 SRJ-811, SRJ-812, SRJ-1512: the old-life wait's bindings, installed
  // with the registry its waits run in: each waiting persona's retry timer
  // through the retry controller's arm (never the old key's), the system
  // clock, the applied configuration read at each call, and the alert sinks
  // the persona teardown's are given: the kill-failure alerts over the one
  // episodes instance (its log-only route for the context 'old-life wait')
  // and the startup-errors recorder (the `persona-teardown-notice` entries
  // worded "during the wait"); and the wait's own unclassified-error
  // episodes (SRJ-313), keyed by the held instance id, apart from every
  // persona's: each round that keeps the hold reports its first UNCLASSIFIED
  // answer, the one alert per episode is the `persona-unclassified-error`
  // entry naming the wait's reference (log-only, against the alert threshold
  // in effect), and the hold's end ends the episode. Nothing reaches Slack. A
  // wait is started only through the session manager's ensure entry; its
  // hold's end and shutdown's close of the registry stop it.
  const waitUnclassifiedErrors = createOldLifeWaitUnclassifiedErrors({
    log: (line) => console.error(line),
    alertThresholdMs: adAlertThresholdMsInEffect,
    recordStartupError: (classLabel, entry) => recordStartupError(classLabel, entry),
  })
  oldLifeWaitUnclassifiedErrors = waitUnclassifiedErrors
  setOldLifeWaitBindings({
    retryArm: retryTimers,
    clock: SYSTEM_PERSONA_CONNECTION_CLOCK,
    log: (line) => console.error(line),
    appliedConfig: () => personaConfig,
    killFailureAlerts,
    recordStartupError: (classLabel, entry) => recordStartupError(classLabel, entry),
    unclassifiedErrorEpisodes: waitUnclassifiedErrors,
  })
  // b.jg5 SRJ-810: once a hold ends, each persona recorded as waiting on it
  // that is still applied and not latched is retried at once through the
  // retry controller's run-now entry (armed with the held-for-an-old-life
  // cause when it was not); one waiting on its own row, once the wait the
  // end stopped there has settled. Registered on the one hold set after the
  // session manager's own end observer (`setOldLifeHolds` above), so the
  // hold's wait is stopped first. The set lives for the server's life;
  // nothing removes it.
  oldLifeHolds.onEnd(
    createOldLifeHoldEndRetry({
      runNow: (key) => retryTimers.runNow(key, { kind: UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD }, UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED),
      isApplied: (key) => getAppliedPersona(key) !== undefined,
    }),
  )

  // b.jg5 SRJ-307, SRJ-310: the per-persona tmux-unresponsive condition,
  // held in the notice episodes, apart from the outage flags. The outage
  // state's wrappers start and end it (installed as its condition sink
  // below, before the start pass); the health tick and a retry end it too.
  // Each end is reported once to the retry controller's condition-end entry
  // (SRJ-306), with the live reading a tick or a retry brings. It posts its
  // onset, alert and recovery (SRJ-308 to SRJ-310, SRJ-1006) through the
  // notice episodes: the onset at a health tick, or with
  // health_check_interval 0 (read from the configuration in effect at each
  // check) at a retry; the alert against agent-director's threshold in
  // effect (SRJ-210).
  const tmuxUnresponsive = createTmuxUnresponsiveCondition({
    episodes: noticeEpisodes,
    log: (line) => console.error(line),
    conditionEnded: (key, reading) =>
      retryTimers.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, reading),
    healthCheckOn: () => (personaConfig ?? appliedConfig).health_check_interval !== 0,
    alertThresholdMs: adAlertThresholdMsInEffect,
  })
  // b.jg5 SRJ-1011: the persona routing's lost-message state reads its holds.
  personaTmuxUnresponsive = tmuxUnresponsive

  // Every persona notice goes through the one per-persona notifier: it holds
  // a notice until the persona's client is available and logs instead of
  // posting in dry run. An agent-director error inside a launch or recovery
  // attempt, or an ENVIRONMENT answer from any call, arms the persona's retry
  // timer through the trigger sink, a tmux-touching call's UNAVAILABLE
  // there starts the persona's tmux-unresponsive condition through the
  // condition sink, and an UNCLASSIFIED answer there (a row read's included)
  // reaches the persona's unclassified-error episode through the
  // unclassified sink (b.jg5 SRJ-313). b.jg5 SRJ-305, SRJ-306: each real clear of a persona's
  // `tmux-unavailable` outage (never the silent boot or teardown reset) is
  // reported once to the retry controller's condition-end entry, with the
  // reading the clear brought (the live reading of a tick or a retry that
  // found the row healthy, or a launch call's `pending`), so the timer stops
  // unless its `pending` or kill-failure exception holds.
  initOutageState({
    // b.jg5 SRJ-1002, SRJ-1003: each onset and all-clear carries its phase
    // and classes, so the notifier writes the all-clear of an outage whose
    // onset a persona teardown's window routed as that onset was.
    notify: (key, text, options) => {
      void personaNotifier.notify(key, text, options)
    },
    getClient,
    triggerSink: retryTimers,
    conditionSink: tmuxUnresponsive,
    unclassifiedSink: unclassifiedErrors,
    onFlagCleared: (key, cls, reading) => {
      if (cls === 'tmux-unavailable') {
        retryTimers.conditionEnded(key, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE, reading)
      }
    },
  })
  setSessionNotifier(personaNotifier.notify)

  // b.av2 SR-3.1: one Slack connection per persona. Each connection's
  // `message`, `app_mention` and `interactive` events reach the event router
  // with that persona's key; each time a persona reports up its held notices
  // are flushed (SR-7.2), and a persona that reaches up from retrying its
  // bring-up is launched by the bring-up controller (SR-6.1). Nothing
  // connects until the bring-up pass below. The controller is built over this
  // manager, so the listener reaches it through the module-scope `bringUps`,
  // assigned right after it is built and before anything connects.
  //
  // The integration suite's Slack API base URL override: read once here, at
  // start, honoured only for an http URL on 127.0.0.1 or [::1] (its origin
  // logged once), any other value ignored with one warning. Unset, the clients use the library
  // default. Never set on an operator's host.
  const slackApiUrl = resolveSlackApiUrlOverride(process.env, (line) => console.error(line))
  const manager = createPersonaConnectionManager({
    onEvent: createPersonaEventRouter({
      routing: personaRouting,
      clientFor,
      getPersona: getAppliedPersona,
      log: (line) => console.error(line),
    }),
    log: (line) => console.error(line),
    dryRun: isDryRun(),
    slackApiUrl,
    // b.ujn: a running persona whose Web API call is refused for its bot
    // token is marked credentials-broken at once; only the network close of
    // its detached socket goes through the per-persona serializer.
    serialize: personaLifecycle.run,
    onStatus: composePersonaStatusListeners(
      createPersonaUpFlushListener(personaNotifier),
      (key, status) => bringUps?.onConnectionStatus(key, status),
    ),
  })
  connections = manager

  // b.av2 SR-6.1 / SR-6.4: each persona's bring-up outcome (up, broken or
  // retrying) and its retries on its own timers. A persona that reaches up
  // through a retry is launched from there, through the one-launch-in-flight
  // guard restarts use; its restart counter is not touched.
  const personaBringUps = createPersonaBringUpController({
    connections: manager,
    dryRun: isDryRun(),
    log: (line) => console.error(line),
    // The persona set applied now (b.av2 SR-8.6): a retry re-checks against
    // it, and a persona no longer in it is neither re-checked nor launched.
    appliedPersonas: () => personaConfig?.personas ?? [],
    launch: (persona) => spawnForPersona(persona, personaConfig ?? appliedConfig, false),
    // Bug b.g57: a persona's claude_config_dir is checked before its Slack
    // step, and re-checked while it is held, exactly as the launch checks it.
    checkConfigDir: checkLaunchConfigDir,
    serialize: personaLifecycle.run,
    // b.av2 SR-6.3: a session is registered only while its persona is up. A
    // persona that stops being up (a refused reopen) has its session dropped;
    // its instance and row are kept, nothing is restarted or posted, and the
    // instance registers again once the persona is up.
    onLeftUp: createNotUpSessionDropper({
      drop: dropPersonaSessionAndKeepAlive,
      log: (line) => console.error(line),
    }),
  })
  bringUps = personaBringUps
  // Bug b.g57: a launch that finds a persona's claude_config_dir unresolvable
  // launches nothing and hands the persona to the controller, which holds it
  // retrying, closes its Slack connection (the manager's `stop`), and once
  // the directory resolves connects it with its held credentials and
  // launches it.
  setConfigDirUnresolvableHook(personaBringUps.holdForConfigDir)

  // b.av2 SR-6.5 / SR-6.1 / SR-8.6 / SR-6.6 / SR-6.4: the apply's persona
  // teardown, in-place update, credentials change and bring-up (recovery
  // included), each through the per-persona serializer, and its template
  // refresh. The teardown (b.jg5 SRJ-715, SRJ-1507) stops the key's
  // approver, live-row sequence and retry timer first, kills its row with
  // the bounded retry and keeps the row: nothing here deletes one. b.jg5
  // SRJ-1003: the one notifier also carries the teardown's window: its submit
  // mutes the key's notice episodes, and from the start of its turn until it
  // completes every notice for the key, a CONFLICT or UNUSABLE NAME its kill
  // meets included, is written to the server log and startup-errors.log,
  // never posted. This supplies only the production dependencies; the
  // operations live in persona-lifecycle.ts.
  personaLifecycleOps = createPersonaLifecycle({
    serialize: personaLifecycle.run,
    bringUps: personaBringUps,
    connections: manager,
    routing: personaRouting,
    destinations: personaDestinations,
    destinationHold: personaDestinationHold,
    notifier: personaNotifier,
    appliedPersonas: () => personaConfig?.personas ?? [],
    dryRun: isDryRun(),
    isShuttingDown: () => shuttingDown,
    log: (line) => console.error(line),
    whenLaunchSettled,
    // b.jg5 SRJ-404, SRJ-715: a teardown stops the key's dialog approver
    // first, and the one its launch in flight would start.
    stopApprover: (key) => stopDialogApprover(key, APPROVER_STOP_TEARDOWN),
    // b.jg5 SRJ-706, SRJ-715: right after the approver, the key's live-row
    // sequence, before the wait for its launch in flight; the teardown waits
    // for the sequence's call in flight to return.
    stopLiveRowSequence: (key) => stopLiveRowSequence(key, LIVE_ROW_STOP_TEARDOWN),
    // b.f2b: a teardown cancels a launch's wait for a `working` row rather
    // than wait it out (up to 10 min).
    cancelLaunchWait: cancelWorkingRowWait,
    cancelRestartTimer,
    // b.jg5 SRJ-309: the stop also cancels the key's tmux-unresponsive alert
    // check (at a destructive modify's submit too), here as well as through
    // the controller's stop observer: the observer runs only for a timer the
    // stop really stopped, and a teardown silences the alert even with none
    // armed (a failed first arm). The cancel is idempotent and logs only a
    // check it really cancels, so one line at most. The episode is forgotten
    // at the teardown's turn.
    stopRetryTimer: (key) => {
      retryTimers.stop(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      tmuxUnresponsive.cancelAlert(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
    },
    // b.jg5 SRJ-811: right after each of those stops before the kill, the
    // key is forgotten from every old-life hold's waiting record, and a wait
    // no persona left in the applied configuration waits on is stopped.
    forgetOldLifeWaits,
    forgetFailures,
    forgetDisconnectedStreak,
    forgetNotConnectedEpisode,
    // b.jg5 SRJ-504, SRJ-715: the teardown forgets the key's latch silently
    // (no observer call, no post, no line) three times: in its first group,
    // again once its launch in flight settled, each right before its notice
    // episodes (the CONFLICT episode included), and once more after the kill.
    forgetConflictLatch: (key) => conflictLatch.forget(key),
    // b.jg5 SRJ-207, SRJ-715: likewise its ErrInvalidFlags hold, with no post
    // and no retry, right after its latch and before its notice episodes,
    // the hold episode included.
    forgetInvalidFlagsHold: (key) => invalidFlagsHold.forget(key),
    forgetNoticeEpisodes: (key) => noticeEpisodes.forget(key),
    resetOutageState: resetAllToHealthy,
    forgetPersonaPrompts,
    forgetAcks: forgetPersonaAcks,
    dropSession: dropPersonaSessionAndKeepAlive,
    // b.jg5 SRJ-715, SRJ-110, SRJ-702: the teardown's kill, with the bounded
    // retry on the real clock, arming nothing and latching nothing; there is
    // no delete, so the row is kept whatever the outcome.
    killInstance: (key) => killPersonaInstanceForTeardown(key, { clock: KILL_RETRY_SYSTEM_CLOCK }),
    // b.jg5 SRJ-704, SRJ-1003: its kill-failure alert, through the one
    // kill-failure alerts instance over the notice episodes, with the context
    // 'persona teardown': raised in its window, so the notifier writes it to
    // the server log and a startup-errors entry, never Slack.
    raiseKillFailureAlert: (key, decision) =>
      killFailureAlerts.raise({ key, decision, latched: false, context: KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN }),
    // b.jg5 SRJ-110, SRJ-1003: the key's outage flags, read after its kill,
    // so a standing non-success whose outage onset the window wrote raises
    // no second notice.
    outageFlags: getOutageFlags,
    replyGuard: {
      launchedWithDir: getLaunchedWithDir,
      teardown: (key) => teardownPersonaReplyGuard(STATE_DIR, key),
      launchPass: (dirs, personas) => stopHookLaunchPass(dirs, personas, STATE_DIR),
    },
    storageCheck: (persona) => runPersonaStorageCheck(persona, personaNotifier.notify),
    launch: (persona) => spawnForPersona(persona, personaConfig ?? appliedConfig, false),
    // Step 5 keeps the server-wide arguments the boot install wrote.
    templateRefresh: { installed: installedTemplate.params, getClient },
  })

  // Only a persona that is up may be restarted or relaunched: the health
  // check's work list, the restart module (before any kill or reconnect) and
  // the restart launch all ask this gate, so a broken or retrying persona's
  // instance is never touched. It logs once per persona per non-serving state.
  const canRelaunch = createPersonaRelaunchGate(manager, (line) => console.error(line), personaBringUps)

  if (isDryRun()) {
    console.error('[slack] Running in dry-run mode — Slack disabled')
  } else {
    // A clean outage slate for every applied persona before any of them is
    // brought up (the boundary for pre-start observations).
    resetAllToHealthy(personaConfig.personas.map((p) => p.key))

    // SR-2.1 permission poller — single-threaded interval loop monitors AD
    // state for spawns in check_permission and posts Block Kit prompts to
    // each persona's destination through its client (b.av2 SR-7.1). It does
    // not wait for any persona: one with no client yet is skipped.
    startPermissionPoller({
      getClient,
      clientFor,
      destinations: personaDestinations,
      destinationHold: personaDestinationHold,
      // b.jg5 SRJ-1003: a stuck-prompt warning raised in a persona's teardown
      // window is written by the notifier's window, never posted.
      teardownNotices: personaNotifier,
      getPersona: getAppliedPersona,
      // b.av2 SR-6.4: a not-up persona's rows are skipped, its prompts and
      // wedge state held until it is up.
      isPersonaUp,
      intervalMs: personaConfig.agent_director_poll_interval_ms,
    })
  }

  const mcpHost = personaConfig.bind
  const mcpPort = personaConfig.port

  // Propagate resolved port to tool deps for peer PID discovery
  sessionToolDeps.serverPort = mcpPort

  // -------------------------------------------------------------------------
  // HTTP server — single /mcp endpoint, roots-based session identity
  // -------------------------------------------------------------------------

  httpServer = Bun.serve({
    hostname: mcpHost,
    port: mcpPort,
    idleTimeout: 0, // Disabled: SSE connections are long-lived and idle between messages. Dead processes are detected by TCP socket closure (localhost) and the health check (isClaudeRunning).
    async fetch(req: Request, server: { requestIP(r: Request): { address: string } | null; timeout(req: Request, seconds: number): void }): Promise<Response> {
      const url = new URL(req.url)
      const mcpSid = req.headers.get('mcp-session-id')
      if (isHttpVerbose()) {
        console.error(`[slack] HTTP ${req.method} ${url.pathname} session=${mcpSid ?? '(none)'}`)
      }


      // -----------------------------------------------------------------------
      // /interject — inject a message into one persona's session from
      // localhost (b.av2 SR-9.1; handler in src/interject.ts)
      // -----------------------------------------------------------------------
      if (url.pathname === '/interject') {
        return handleInterject(req, server.requestIP(req)?.address, {
          getPersonaConfig: () => personaConfig,
          isPersonaUp,
          getSessionByPersona,
        })
      }

      // -----------------------------------------------------------------------
      // /clear-latch — clear one persona's latch by hand from localhost, for
      // the operator only (b.jg5 SRJ-510, SRJ-511; handler in
      // src/clear-latch.ts)
      // -----------------------------------------------------------------------
      if (url.pathname === CLEAR_LATCH_ROUTE) {
        return handleClearLatch(req, server.requestIP(req)?.address, {
          getPersonaConfig: () => personaConfig,
          clearByHand,
        })
      }

      // Only /mcp is the MCP endpoint — everything else is a 404
      if (url.pathname !== '/mcp') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not found' },
            id: null,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      // --- Existing session: route by Mcp-Session-Id header ---
      const mcpSessionId = req.headers.get('mcp-session-id')
      if (mcpSessionId) {
        const entry = resolveTransportForRequest(req)
        if (entry === undefined) {
          // Unknown session ID
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // entry is non-null here (null means init request, but we have a session ID)

        // Propagate peer port to registered sessions for tool call PID discovery
        if (entry !== null && 'personaKey' in entry) {
          const remoteAddr = server.requestIP(req) as { address: string; port: number } | null
          if (remoteAddr?.port) (entry as SessionEntry).peerPort = remoteAddr.port
        }

        // For GET requests (SSE streams), attach an abort listener to detect
        // client disconnections. The MCP SDK's onsessionclosed only fires on
        // explicit HTTP DELETE, so silent TCP/tmux kills are never detected
        // without this. When the signal aborts, look up the session by
        // mcpSessionId (not by entry state at attach time, since the session
        // may still be pending when the GET arrives but registered by abort time).
        if (req.method === 'GET') {
          server.timeout(req, 0)
          req.signal.addEventListener('abort', () => {
            // Look up the session at abort time — it may have been registered
            // after this GET request started (the SSE stream opens before
            // roots/list completes). Also guards against double-fire if
            // onsessionclosed already ran from an explicit DELETE.
            const key = unregisterByMcpSessionId(mcpSessionId)
            if (key) restartDisconnectedPersona(key, ' (SSE abort)')
          })
        }

        return (entry as NonNullable<typeof entry>).transport.handleRequest(req)
      }

      // --- Init request: no Mcp-Session-Id ---
      // Create a pending session; persona matched after roots/list in handleInitialized()
      const { transport } = initPendingSession()
      return transport.handleRequest(req)
    },
  })

  // b.jg5 SRJ-510: once the listener is up, record this process's PID and the
  // listener's bound port (the ephemeral one for a port-0 configuration),
  // before the PID file, so a `clear-latch` that finds a running PID finds
  // the record. A failed write is one line; the server keeps serving.
  try {
    writeServerPortRecord(SERVER_PORT_FILE, { pid: process.pid, port: httpServer.port ?? mcpPort })
  } catch (err) {
    console.error(serverPortWriteFailedLine(SERVER_PORT_FILE, describeThrownValue(err)))
  }
  writePidFile(PID_FILE)

  console.error(`[slack] MCP server listening on http://${mcpHost}:${mcpPort}/mcp`)
  console.error('')
  console.error('Save this to ~/.claude/slack-mcp.json:')
  console.error(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `http://${mcpHost}:${mcpPort}/mcp` } } }, null, 2))
  console.error('')
  console.error('Then launch Claude from a project directory with:')
  console.error(`  claude --mcp-config ~/.claude/slack-mcp.json --dangerously-load-development-channels server:${MCP_SERVER_NAME}`)
  console.error('')

  // Cron scheduler — the once-per-minute dispatch tick (b.he5). It is its
  // own /interject client, so it MUST start only AFTER Bun.serve() is listening
  // (unlike startPermissionPoller, which starts before Bun.serve — do not copy
  // that placement). Uses the ACTUAL bound port (httpServer.port) so port-0
  // configs still reach the right listener. Any construction/start failure is
  // non-fatal — the server keeps serving without a scheduler.
  // scheduler.start() also owns the crontable bootstrap (the sole ensure-exists
  // caller) and is failure-isolated internally.
  try {
    const cronLog = createCronLog(personaConfig.cron_log_path)
    // Prefer the ACTUAL bound port (covers port-0 configs); fall back to the
    // requested port only if Bun leaves it undefined (never expected once the
    // server is listening).
    const boundPort = httpServer.port ?? mcpPort
    const dispatcher = createCronDispatcher({
      port: boundPort,
      cronLog,
      cronTablePath: personaConfig.cron_table_path,
      // Resolved against the applied persona config at each fire.
      resolveTarget: (target) => resolvePersonaTarget(personaConfig, target)?.key,
    })
    cronScheduler = createCronScheduler({
      dispatcher,
      cronLog,
      cronTablePath: personaConfig.cron_table_path,
    })
    cronScheduler.start()
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    console.error(`[slack] Warning: cron scheduler failed to start — ${cause}`)
    cronScheduler = null
  }

  // Shared adapter: probes agent-director for the spawn's current state per
  // SR-11 Event 6a and answers one of four readings (b.jg5 SRJ-314): `pending`,
  // with the row's raw launch start when shown (SRJ-115); `live` for another
  // live state; `dead` for a terminal state (ended, missing), ErrSpawnNotFound
  // or ErrSystemInstallDisappeared; `unknown` for every other status error and
  // any state CSCB does not know. Only `dead` leads to a launch, with a kill
  // before it only for ErrSystemInstallDisappeared (b.jg5 SRJ-314);
  // the restart path hands `pending` to `deferPendingRow` and arms the
  // persona's retry timer on `unknown`; the health tick never counts
  // `pending` healthy and skips an `unknown` persona that tick. A configured
  // persona's own `pending` row with no launch start latches it instead and
  // reads `unknown` (b.jg5 SRJ-513).
  const isSessionAliveAdapter = _buildIsSessionAliveAdapter(() => personaConfig)
  // b.jg5 SRJ-115, SRJ-1011: the persona routing's lost-message row read is
  // this same instance, set before the start bring-up pass opens any
  // persona's connection.
  personaRowLiveness = isSessionAliveAdapter

  // b.9cj: the restart guard and the health-check tick share persona-routing's
  // stream-presence probe (`hasSessionStream`), the same `_GET_stream` check
  // the dispatch path applies to the session it sends to, so a
  // connected-but-streamless session is treated as unhealthy, not "healed",
  // everywhere alike.

  // Initialize restart module with library-backed adapters. Every key is a
  // persona key.
  initRestart({
    canRestart: canRelaunch,
    isSessionAlive: isSessionAliveAdapter,
    isSessionConnected: (key) => {
      const session = getSessionByPersona(key)
      return session?.connected === true
    },
    hasSessionStream,
    // b.f2b: the persona locates a `working` row's transcript (its
    // claude_config_dir) for the positive-idle rule.
    reconnectSession: _buildReconnectSessionAdapter(getAppliedPersona, (key) => conflictLatch.isLatched(key)),
    killSession: _buildKillSessionAdapter(getAppliedPersona, KILL_RETRY_SYSTEM_CLOCK),
    launchSession: async (key, _cwd, _sessionId, deadEvidence) => {
      if (!personaConfig) return false
      // Launches the applied persona with this key; false when there is none.
      // resume vs fresh is handled inside spawnForPersona (SR-1.4
      // collision-then-act). The cwd and session-id arguments from the legacy
      // restart deps are ignored — the persona carries its working directory
      // and AD owns the resume state, not CSCB. A persona that is not up is
      // skipped (neither success nor failure); a launch its UNAVAILABLE retry
      // timer was armed for is passed through as 'refused', which restart.ts
      // never counts (b.jg5 SRJ-301, SRJ-302). The escalate-dead verdict a
      // relaunch carries is passed on unchanged, into the ladder (b.jg5
      // SRJ-611).
      return await launchSession(key, personaConfig, { canLaunch: canRelaunch, deadEvidence })
    },
    getRestartDelay: () => appliedConfig.session_restart_delay,
    isShuttingDown: () => shuttingDown,
    // The persona's restart-cap notice (SR-25.3), built in the session
    // manager. b.jg5 SRJ-313: reaching the cap also ends the persona's
    // unclassified-error episode silently; each step is isolated.
    // b.jg5 SRJ-305: reaching the cap stops the persona's retry timer at
    // once, in either mode: a pending-only timer the counted launch failure
    // that reached the cap armed is not left until its first retry.
    onCapReached: (key) => {
      try {
        notifyRestartCapReached(key)
      } catch {
        /* isolated: the episode still ends */
      }
      try {
        unclassifiedErrors.end(key, UNCLASSIFIED_ERROR_END_CAPPED)
      } catch {
        /* isolated: the cap notice is unaffected */
      }
      try {
        retryTimers.stop(key, UNAVAILABLE_RETRY_STOP_CAPPED)
      } catch {
        /* isolated: the notice and the episode are unaffected */
      }
    },
    // b.av2 SR-6.6: a fired timer's work waits its turn behind any lifecycle
    // operation for the persona.
    serialize: personaLifecycle.run,
    // b.jg5 SRJ-314, SRJ-301: a restart run whose liveness reads `unknown`
    // (at its probe or b.d61's re-probe) arms the persona's UNAVAILABLE retry
    // timer on the controller built above, with the read-error cause. An arm
    // while the timer is armed or running keeps its due time and wait count.
    armRetryTimer: (key) => {
      retryTimers.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    },
    // b.jg5 SRJ-314, SRJ-409, SRJ-411: a restart run whose liveness reads
    // `pending` (its first probe or b.d61's re-probe) hands the row, with its
    // launch start, to the `pending` deferral, awaited, whatever the
    // session's connection shows; nothing is reconnected, killed, launched or
    // counted. The deferral arms the persona's retry timer pending-only for a
    // covered row and sends a row that is not covered through the live-row
    // sequence. A configured persona's own `pending` row with no launch start
    // never reaches it: the probe latched the persona (b.jg5 SRJ-513).
    // b.jg5 SRJ-410: at a retry, a row the deferral reads gone lets the
    // restart work go on to its relaunch in the same run.
    deferPendingRow: async (key, reading) => deferPendingRow(key, reading.launchStartedAt),
    // b.jg5 SRJ-502: a latched persona's restart work (a fired timer, a
    // retry, a human-triggered restart) makes no agent-director call.
    isLatched: (key) => conflictLatch.isLatched(key),
    // b.jg5 SRJ-207, SRJ-303: nor does the restart work of a persona held on
    // ErrInvalidFlags (no status, kill, send-keys, spawn or resume; nothing
    // recorded), and no restart timer is armed for it.
    isHeld: (key) => invalidFlagsHold.isHeld(key),
    // b.jg5 SRJ-706, SRJ-303: while the persona's live-row sequence runs, its
    // restart work (a fired timer, a retry, a human-triggered restart) makes
    // no agent-director call and answers sequence-waiting; the work asks
    // again wherever it asks the latch again and before its launch, and a
    // launch the sequence held answers sequence-waiting too. b.jg5 SRJ-811:
    // when an old-life wait runs on the persona's own row, the gate also arms
    // its retry timer, since the wait launches no one.
    isLiveRowSequenceRunning: (key) => liveRowSequenceGate(key, 'runRestartWork'),
    // b.jg5 SRJ-810, SRJ-812: while an old life may still run in the applied
    // persona's working directory (a hold on its own row excepted), its
    // restart work (a fired timer, a retry, a human-triggered restart, the
    // lost-message trigger's included) makes no agent-director call: the
    // session manager's hold step records it as waiting, starts the hold's
    // wait and arms its retry timer, and the work answers sequence-waiting.
    isHeldForOldLife: (key) => {
      const persona = getAppliedPersona(key)
      return persona !== undefined && oldLifeHoldStep(persona, 'runRestartWork')
    },
    // b.jg5 SRJ-610: each run's readings and verdicts feed the slow-recovery
    // count; nothing in the run changes because of it.
    slowRecovery,
  })

  // b.av2 SR-6.3 as amended by b.jg5 SRJ-1506; b.jg5 SRJ-116, SRJ-714: the
  // start sweep, BEFORE the trust patch and any spawn. One `list` reads every
  // `service=cscb` row in every state; then, over the whole list and before
  // any kill, the latch pass (a latched persona's own row and every row
  // labelled with it are left unkilled) and one batch record of the keys of
  // rows naming a persona absent from the applied config as retired. Each
  // remaining live row naming an absent persona, or with an instance ID
  // other than `cscb_<key>` or a `cwd` other than the persona's working
  // directory, and each live row with no `persona` label (a pre-persona row,
  // b.1ix), is killed with the result checked; a finished row is never
  // killed, and no row is deleted: pre-persona and absent-persona rows are
  // kept and never resumed until agent-director's `expire` removes them. One
  // findMissing run follows the kills, and one summary line ends the sweep.
  // The sweep reads `shuttingDown` live through its shutdown query: once a
  // shutdown has begun (a version re-check's stop, b.jg5 SRJ-205) it makes no
  // further agent-director call and changes no agent-director row.
  // No sweep once a shutdown has begun (b.jg5 SRJ-205).
  if (shuttingDown) return
  try {
    await reconcileOrphans(personaConfig, KILL_RETRY_SYSTEM_CLOCK, () => shuttingDown)
  } catch (err) {
    console.error(`[slack] Warning: orphan reconciliation failed: ${describeThrownValue(err)}`)
  }

  // b.uhv / b.k54 / b.av2 SR-6.2: patch .claude.json for every applied
  // persona's working directory so the trust dialog and project onboarding are
  // pre-accepted before any spawn fires (the pre-launch patcher repeats it per
  // launch). Runs for both real and dry-run modes (config-file patch, not a
  // session operation).
  // A shutdown may have begun during the sweep: no bootstrap pass starts
  // after it (b.jg5 SRJ-205).
  if (shuttingDown) return
  await trustBootstrap(personaConfig)

  // b.zak: preventative JSONL-persistence safeguard. Detect non-persistent
  // storage roots (Layer 1) and personas whose transcript would be treated as
  // missing on resume (Layer 2) and say so LOUDLY, BEFORE startupSessionManager
  // runs the resume path, which on ErrJsonlMissing brings the persona up fresh
  // by a reuse spawn of the same id.
  // Runs over the applied personas. Awaited but wrapped so a rejection can
  // never kill startup. Its notices go through the per-persona notifier, which
  // only logs them in dry run.
  // It makes agent-director `get` calls: none once a shutdown has begun
  // (b.jg5 SRJ-205).
  if (shuttingDown) return
  try {
    await runJsonlPersistenceSafeguard(personaConfig, personaNotifier.notify)
  } catch (err) {
    console.error(`[slack] Warning: jsonl-persistence safeguard failed — continuing: ${describeThrownValue(err)}`)
  }

  // b.osj / b.av2 SR-9.4: install (or remove) the CSCB-managed Stop hook in
  // each applied persona's effective claude_config_dir settings.json before
  // any spawn fires; its command names this server's reply-guard record
  // directory. Runs for both real and dry-run modes (config-file patch, not a
  // session operation). Never throws — per-dir failures are recorded via
  // recordStartupError.
  // No bootstrap pass starts once a shutdown has begun (b.jg5 SRJ-205).
  if (shuttingDown) return
  stopHookBootstrap(personaConfig, STATE_DIR)

  // b.av2 SR-6.1: bring each applied persona up — one persona-start line,
  // the local credentials check (skipped in dry run), the working-directory
  // check, Slack validation and connection through the manager, then, for
  // each persona that is up, the launch (spawnForPersona: fresh spawn or
  // collision handling per SR-1.4). The pass returns once every persona is
  // up, broken or retrying; a broken or retrying persona is logged, never
  // posted about, and a retrying one is launched later from its own retry.
  // b.f2b: it does not wait out a launch that is waiting for a `working` row
  // to settle (up to 10 min): that launch goes on in the background, in
  // flight, so one stuck persona does not hold up the health check and the
  // detection tick for the others.
  // A launch failure raises a notice to the persona's destination. The
  // server stays up. The pass is the reload controller's start bring-up
  // (startupSessionManager over the applied set and the bring-up controller),
  // so it runs exactly the applied persona set.
  // No bring-up (no Slack connection, no launch) once a shutdown has begun.
  if (shuttingDown) return
  try {
    await reload.runStartBringUp()
  } catch (err) {
    console.error(`[slack] Warning: session startup failed — continuing: ${describeThrownValue(err)}`)
  }

  // shutdown() stops the health check and the detection tick; neither is
  // started after it has begun.
  if (shuttingDown) return

  // Initialize and start the health-check poller.
  initHealthCheck({
    isSessionAlive: isSessionAliveAdapter,
    // b.9a7: same connectedness adapter wired into initRestart above
    // (registry entry with connected === true). Lets the tick notice
    // alive-but-disconnected rows and route them to scheduleRestart.
    isSessionConnected: (key) => {
      const session = getSessionByPersona(key)
      return session?.connected === true
    },
    // b.9cj: same stream-presence probe wired into initRestart above, so the
    // tick can notice connected-but-streamless rows and route them to recovery.
    hasSessionStream,
    isRestartPendingOrActive,
    // b.f2b, b.jg5 SRJ-315: "in flight for P", a running dialog approver
    // included (SRJ-401). Work in flight owns the session (a start launch
    // may still be waiting in the background for a `working` row), so the
    // tick still reads the persona but makes no attempt for it.
    isLaunchInFlight: isPersonaWorkInFlight,
    // b.jg5 SRJ-315, SRJ-502: a latched persona is still read, but the tick
    // makes no attempt for it.
    isLatched: (key) => conflictLatch.isLatched(key),
    // b.jg5 SRJ-315, SRJ-207: so is a persona held on ErrInvalidFlags.
    isHeld: (key) => invalidFlagsHold.isHeld(key),
    // b.jg5 SRJ-311: a persona held off on its `tmux-unavailable` outage that
    // the tick does not find healthy, with no retry timer on the controller
    // built above (a retry can stop with the flag still raised), gets one
    // armed with the ENVIRONMENT cause, the outage's own class; its stop
    // checks end it with no agent-director call for a persona not up.
    isRetryArmed: (key) => retryTimers.isArmed(key),
    armRetryTimer: armEnvironmentRetryTimer,
    // b.f2b: with session_restart_delay 0 scheduleRestart does nothing, so an
    // alive persona the tick would reconnect gets the not-connected notice
    // (once per episode, worded for a disconnected or a streamless session)
    // instead of being left down silently; the episode ends when the tick
    // finds it deliverable again.
    isAutoRestartDisabled: () => appliedConfig.session_restart_delay === 0,
    notifyNotConnected: notifyDisconnectedWithAutoRestartDisabled,
    endNotConnectedEpisode: forgetNotConnectedEpisode,
    // b.jg5 SRJ-310: a tick that finds the persona `live`, connected and with
    // its stream ends its tmux-unresponsive condition, with that reading.
    endTmuxUnresponsive: (key) => {
      tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE)
    },
    // b.jg5 SRJ-610: the same tick resets the persona's slow-recovery count
    // (the tracker built above), leaving an open episode open; the reset
    // logs only when the count was above 0.
    resetSlowRecoveryCount: (key) => {
      slowRecovery.noteHealthy(key)
    },
    // b.jg5 SRJ-308: each tick body ends with the condition's onset check,
    // after all of its per-persona work, for every condition whose first
    // refusal precedes the tick's start, read on the notice episodes' clock
    // (the one the first refusal's time comes from).
    now: () => noticeEpisodes.clock.now(),
    onTickEnd: (tickStartedAt) => tmuxUnresponsive.onsetAtTick(tickStartedAt),
    // b.f2b: while the reconnect adapter holds an idle run for a persona's
    // `working` row, the next attempt (which can find the row stale and
    // reconnect it) is scheduled on the first undeliverable tick.
    hasPendingWorkingRowEvidence,
    isAtCap: (key) => backoffIsAtCap(key, RESTART_FAILURE_CAP),
    statRoute: _buildStatRouteImpl(),
    scheduleRestart,
    isShuttingDown: () => shuttingDown,
    // One entry per applied persona that is up: key → working directory. A
    // broken or retrying persona (or one whose connection is not serving) is
    // left out, so the tick never touches it; it joins once it is up.
    getPersonas: () => (personaConfig ? buildPersonaWorkList(personaConfig, canRelaunch) : {}),
  })

  // INVARIANT: Health check starts only after startupSessionManager() returns.
  // By then every start launch has settled, or (b.f2b) is still waiting in the
  // background for a `working` row: such a launch stays in flight, and the
  // tick makes no attempt for a persona with work in flight
  // (`isPersonaWorkInFlight`), though it still reads it.
  // Do not move this call earlier in the startup sequence.
  startHealthCheck(personaConfig.health_check_interval)

  // INVARIANT (b.av2 SR-8.2): the reload detection tick starts only after the
  // start bring-up pass returns, like the health check; the controller arms
  // nothing before that, so every persona's bring-up has read its credentials
  // (b.f2b: a launch still waiting in the background for a `working` row does
  // not hold it up; a teardown of that persona waits for its launch).
  // Every 5 s it compares config.json (and, outside dry
  // run, the credentials files it references) with what is applied and keeps
  // config.json.pending in step, and applies a change the operator confirmed.
  reload.startDetection()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[slack] Fatal:', err)
    process.exit(1)
  })
}
