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
import { randomBytes } from 'node:crypto'
import { prepareBotSystemPrompt, botSystemPromptPath } from './bot-system-prompt.ts'
import type { Client } from 'agent-director'
import { createDeliveryEngines, createDeliveryLifecycle, type DeliveryEngines, type DeliveryLifecycle, type DeliveryEngineEvent } from './delivery-engine.ts'
import { createDeliveryAdScope } from './delivery-ad-scope.ts'
import { parseLaunchStart } from './pending-row.ts'
import { setDeliveryLifecycle, setDeliveryPersonaLookup, inspectPersonaUpgrade, isTagUpgradePending, hasNotConnectedEpisode, applyDeliveryOwnRowRead, handleDeliveryKeyError, handleDeliveryReadError, recoverDeliveryGone } from './session-manager.ts'
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
  channelModeOf,
  type ServerSettings,
  MCP_SERVER_NAME,
} from './config.ts'
import { personaInstanceId, renderPersonaRef, resolvePersonaTarget, resolveClaudeConfigDir } from './persona-identity.ts'
import {
  applyOwnRowStatusStep,
  buildLatchRecheck,
  buildLiveRowSequenceDeps,
  cancelWorkingRowWait,
  checkLaunchConfigDir,
  checkPromptRowDeferral,
  clearByHandOf,
  carriedDeadEvidenceOf,
  DEAD_SESSION_CAUSE_ROW_READ_FINISHED,
  type DeadEvidenceSource,
  escalateDeadVerdictOfCause,
  ESCALATE_DEAD_REPROBE_DECIDES,
  ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ,
  type EscalateDeadVerdict,
  endPromptRowDeferral,
  forgetNotConnectedEpisode,
  holdLaunchIfConfigDirUnresolvable,
  isLaunchInFlight,
  isLiveRowSequenceRunning,
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
  setPreLaunchTrustPatcher,
  setSystemPromptPreparer,
  setRetiredKeyStore,
  setSessionNotifier,
  spawnForPersona,
  startLiveRowSequence,
  startupSessionManager,
  stopLiveRowSequence,
  sweepDeadTmuxChannelWithCause,
  whenLaunchSettled,
} from './session-manager.ts'
import {
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
import { createDeliveryReporting } from './delivery-notices.ts'
import { buildDeliveryDiagnostic, buildQueuedMessageRetryLine, SYSTEM_PROMPT_UNWRITABLE, queueErrorCode } from './persona-diagnostics.ts'
import { createPersonaRouting } from './persona-routing.ts'
import { createDeliveryQueue, type ReplyReminderQueue, type QueueEvent } from './delivery-queue.ts'
import { createReplyReminders, type ReplyReminders } from './reply-reminder.ts'
import { createDeliveryPreparation, type DeliveryPreparation } from './delivery-intake.ts'
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
import { redactSlackLogText } from './slack-log-redaction.ts'
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
import { removeLegacyReplyHooks } from './legacy-reply-hook-cleanup.ts'
import { forgetPersonaPrompts, startPermissionPoller, stopPermissionPoller, hasNativePromptWarning } from './permission-poller.ts'
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
  UNAVAILABLE_RETRY_RUN_NOW_RAN,
  UNAVAILABLE_RETRY_RUN_NOW_ARMED,
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
import { createDeliveryAckCallback, consumeAck, forgetPersonaAcks } from './ack-tracker.ts'
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
import { buildPersonaClientOrExit, runAgentDirectorStartupGate, createDeliveryClientFactory } from './agent-director-startup.ts'
import { disposeAdVersionRecheck, installAdVersionRecheck, onAdVersionChanged } from './ad-version-gate.ts'
import { installTestTimerOverrides } from './test-timer-overrides.ts'
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
import { handleTestMcpDrop, TEST_MCP_DROP_ROUTE, TEST_MCP_DROP_START_LINE } from './test-mcp-drop.ts'
import { createCronScheduler, type CronScheduler } from './cron-scheduler.ts'
import { repointLogging } from './logging.ts'
import {
  migrateStateDirAtStart,
  STATE_MIGRATE_STARTUP_ERROR_CLASS,
  stateDirMigrationStopsStart,
  stateDirStopMessage,
} from './state-dir-migration.ts'
import { configInEffect, createReloadController, reloadFilePaths, type ReloadController } from './reload.ts'
import {
  channelDeliveryDeclarationOf,
  loadChannelDeliveryAtStart,
  type ChannelDeliveryStore,
} from './channel-delivery.ts'
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


function isPersonaRetryBlocked(key: string): boolean {
  return personaRetryBlockCause(key) !== undefined
}


function isPersonaWorkInFlight(key: string): boolean {
  return isPersonaRetryBlocked(key)
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

// Persona-scoped names: credentials and workspaces may differ (b.omv SR-2.1).
const userNameCache = new WeakMap<WebClient, Map<string, string>>()

async function lookupUserName(client: WebClient, userId: string): Promise<string> {
  let cache = userNameCache.get(client)
  if (!cache) { cache = new Map(); userNameCache.set(client, cache) }
  if (cache.has(userId)) return cache.get(userId)!
  try {
    const res = await client.users.info({ user: userId })
    const name =
      res.user?.profile?.display_name ||
      res.user?.profile?.real_name ||
      res.user?.name ||
      userId
    cache.set(userId, name)
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
  onReplyCall: key => replyReminders?.noteReplyCall(key),
  serverPort: 0, // updated to actual port in main() before Bun.serve
  // The channel mode of the configuration in effect, read at each tool call
  // (b.deo SRI-201, SRI-601).
  getChannelMode: () => channelModeOf(personaConfig),
  // b.av2 SR-5.1 beside b.deo SRI-502: set_channel_delivery's inputs, each
  // read at call time. The one stored-choice store, through the holder main()
  // sets (undefined before then, so the call is refused and nothing is
  // written); the routing's heard set; the applied personas of the
  // configuration in effect, for the loop guard. The routing is built further
  // down, so it is named only inside the arrow.
  getChannelDelivery: () => channelDeliveryStore,
  heardChannels: (key) => personaRouting.heardChannels(key),
  getAppliedPersonas: () => personaConfig?.personas ?? [],
  // b.deo SRI-505, SRI-901: the persona-channel-delivery-set line goes to the
  // [slack] stream, as the routing's persona lines do.
  log: (line) => console.error(line),
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
// Holders are populated in main(), after the duplicate-server guard and before admission.
let deliveryQueue: ReplyReminderQueue | undefined
let replyReminders: ReplyReminders | undefined
let deliveryPreparation: DeliveryPreparation | undefined
let deliveryEngines: DeliveryEngines | undefined
let deliveryLifecycle: DeliveryLifecycle | undefined
/** Test seam: share one typing gate and launch identity with the session manager; undefined resets both. */
export function _setDeliveryLifecycle(value: DeliveryLifecycle | undefined): void {
  deliveryLifecycle = value
  setDeliveryLifecycle(value)
}
let deliveryReporting: ReturnType<typeof createDeliveryReporting> | undefined
const bufferedQueueEvents: QueueEvent[] = []
let deliveryClients: ReturnType<typeof createDeliveryClientFactory> | undefined
export const deliveryEngineEvents = { emit: (event: DeliveryEngineEvent): void => { deliveryReporting?.engineEvent(event); if (event.type === 'item-delivered') replyReminders?.wake(event.key) } }
/** E5 binds event handling here; E2 supplies facts without notices or wording. */
export const deliveryQueueEvents = { emit: (event: QueueEvent): void => { if (deliveryReporting) deliveryReporting.queueEvent(event); else bufferedQueueEvents.push(event) } }
/** E3's engine binds this hook after startup; until then queued work waits. */
export const deliveryQueueWake = { wake: (_key: string): void => {} }
const personaRouting = createPersonaRouting({
  getPersonaConfig: () => personaConfig,
  getBotIdentity: identityFor,
  queue: {
    accept: (key, input) => {
      if (!deliveryQueue) return Promise.resolve({ status: 'failed' as const, error: new Error('Queue not started') })
      return deliveryQueue.accept(key, input)
    },
    lookupSlackKey: (key, slackKey) => deliveryQueue?.lookupSlackKey(key, slackKey),
  },
  prepare: (key, item) => deliveryPreparation?.prepare(key, item) ?? Promise.resolve(),
  onReceived: (key, item) => deliveryReporting?.received(key, item),
  archive: (key, event) => archiveWrite?.(key, event),
  log: (line) => console.error(line),
  // b.av2 SR-4.2 beside b.deo SRI-305, SRI-403: the stored choices and their
  // readability, read at each fungible-mode event through the holder main()
  // sets, which the session tools and the reload controller read too. Before
  // main() loads the store it is undefined, so no stored choice applies.
  getChannelDelivery: () => channelDeliveryStore,
  // A lost message for a persona that is not up restarts nothing (b.av2 SR-6.4).
  isPersonaUp,
  isLatched: (key) => personaLatch?.isLatched(key) ?? false,
  isTmuxUnresponsive: (key) => personaTmuxUnresponsive?.holds(key) ?? false,
  isLaunchRunning: (key) => isLaunchInFlight(key),
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
      buildQueuedMessageRetryLine(key),
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
 * b.deo SRI-201; the reload controller's `onApplied`, through
 * `configInEffect`) to the confirmed persona set and the confirmed
 * `allow_invited_channels` switch, with every other server-wide value kept
 * from start time until the next start. The switch is the one server-wide
 * setting applied in place: every consumer of the channel mode reads it from
 * here at call time (`channelModeOf`). Null only before main() resolves the
 * start; every getter reads it at call time.
 */
let personaConfig: PersonaConfig | null = null

/**
 * The reload controller (b.av2 SR-8.7): built in main(), which resolves the
 * start through it; the file guard reads its protected credentials files.
 * Undefined before main() builds it (nothing is built or read at import).
 */
let reloadController: ReloadController | undefined

/**
 * The one stored-choice store (`channel-delivery.ts`; b.deo SRI-401,
 * SRI-403): set once by main(), which loads it after the start resolves its
 * configuration and before the start bring-up pass, and read at call time by
 * the routing's `getChannelDelivery`, the session tools' `getChannelDelivery`
 * (b.deo SRI-305, SRI-502) and the reload controller's `channelDelivery`
 * accessor. Undefined before main() loads it (nothing is read at import):
 * the routing then applies no stored choice and the tool refuses.
 */
let channelDeliveryStore: ChannelDeliveryStore | undefined

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
 * once. The one destination rule reads the switch from `personaConfig`, the
 * configuration in effect, at each attempt (b.deo SRI-201, SRI-701).
 * Side-effect-free to build: an empty cache, no timer, no Slack call.
 */
const personaDestinations = createPersonaDestinations({
  log: (line) => console.error(line),
  getPersonaConfig: () => personaConfig,
})

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


  console.error(`[slack] Shutting down: ${reason}`)

  if (httpServer) {
    console.error('[slack] Stopping HTTP server')
    httpServer.stop(true)
    httpServer = null
  }

  // b.omv SR-3.3: finish fixation and drain the shared writers after every
  // synchronous stop above, before closing the transports and clients.
  const remindersStopping = replyReminders?.stop()
  const deliveryStopping = deliveryEngines?.stop()
  await deliveryPreparation?.stop()
  await deliveryStopping
  await remindersStopping
  await deliveryClients?.close()
  await deliveryQueue?.stop()

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
 *   - `ErrSystemInstallDisappeared` → `unknown`: no agent state was read;
 *     raises `ad-unreachable` with its binary path, and recovery waits for
 *     an authoritative agent-director observation (b.jpf);
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
 * `ErrSystemInstallDisappeared` is not: its `ad-unreachable` outage reports
 * the failure, and its reading is `unknown`. From the health tick nothing
 * is reported.
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
 * reads `unknown` (b.jpf).
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
    const instance_id = personaInstanceId(key)
    try {
      const r = await getClient().status({ instance_id })
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
      // whose ad-unreachable outage already reports the failure (b.jpf).
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
 * through `src/ad-error-class.ts`. Only `ErrSpawnNotFound` reads `dead`:
 * an installation failure supplies no observation of the agent (b.jpf).
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
    // The executable disappearing says nothing about its agents. Keep the
    // outage and wait for an authoritative status answer before recovery.
    return LIVENESS_READING_UNKNOWN
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
 * Legacy checked-kill adapter retained for compatibility with direct callers.
 * Restart work no longer calls it: installation failure is unknown and
 * supplies no agent observation that can authorize recovery (b.jpf).
 *
 * Guards refuse a kill while a launch is in flight or the persona's config
 * directory cannot be resolved. Otherwise `retryPersonaKill` decides the
 * checked-kill outcome, which is logged and handled by class: CONFLICT and
 * UNUSABLE NAME latch the persona, retryable failures arm its retry timer,
 * and the retry's kill-failure alert decision is raised. `lastRead` supplies
 * the latch's row state; absent a state, latching reads status once.
 * This factory does not launch or count a launch outcome.
 *
 * @param getPersona The applied persona; without it the directory is not checked.
 * @param clock The wait between the kill's tries; the production clock by default.
 * @internal
 */
export function _buildKillSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
  clock: KillRetryWait = KILL_RETRY_SYSTEM_CLOCK,
): (key: string, lastRead: DeadLivenessReading) => Promise<KillSessionResult> {
  // `key` is the persona key; `lastRead` is the caller's `dead` reading.
  return async (key: string, lastRead: DeadLivenessReading) => {
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


export function _buildReconnectSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
  isLatched?: (key: string) => boolean,
  appliedPersona: (key: string) => Persona | undefined = getAppliedPersona,
  options: { noNotice?: boolean } = {},
):(key: string) => Promise<'success' | ReconnectEscalateDead | 'transient' | 'pending'> {
  // `key` is the persona key.
  const run: (key: string) => Promise<'success' | ReconnectEscalateDead | 'transient' | 'pending'> = async (key: string) => {
    const upgrade = await inspectPersonaUpgrade(key, getPersona?.(key) ?? appliedPersona(key))
    if (upgrade !== 'current') { if (!isLiveRowSequenceRunning(key)) deliveryLifecycle?.defer(key); return 'transient' }
    if (getSessionByPersona(key)?.connected === true && !deliveryLifecycle?.reconnectInput(key)) { deliveryLifecycle?.clearDeferred(key); return 'success' }
    if (deliveryLifecycle?.owner(key) !== undefined && deliveryLifecycle.owner(key) !== 'free') { deliveryLifecycle.defer(key); return 'transient' }
    if (deliveryLifecycle && !await deliveryLifecycle.recoverBeforeReconnect(key)) { if (!isLiveRowSequenceRunning(key)) deliveryLifecycle.defer(key); return 'transient' }
    let state: string
    // b.jg5 SRJ-115: a `pending` row's raw launch start, for `deferPendingRow`.
    let launchStartedAt: string | undefined
    try {
      const instance_id = personaInstanceId(key)
      const st = await withOutageDetection(key, undefined, 'status', (client) =>
        client.status({ instance_id }),
      )
      // b.jg5 SRJ-115: the own-row rules over this answer; a read that
      // latched the persona types nothing. b.jg5 SRJ-809: the same step ends
      // an old-life hold on cscb_<key> when the row reads `ended` or
      // `missing`; a live reading, `pending` included, keeps it.
      if (applyOwnRowStatusStep(key, { result: st }, RECONNECT_STATUS_SITE)) return reconnectLatchedByRead()
      state = st.state
      launchStartedAt = pendingLaunchStartOf(st)
    } catch (err) {
      // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latches the persona
      // (the own-row `status` step); nothing is typed. b.jg5 SRJ-809: the
      // same step ends an old-life hold on cscb_<key> on `ErrSpawnNotFound`
      // (no row); any other error keeps it.
      if (applyOwnRowStatusStep(key, { thrown: err }, RECONNECT_STATUS_SITE)) return reconnectLatchedByRead()
      // b.f2b: nothing is known about the session, so nothing is typed.
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
    if (!PROMPT_ROW_STATES.has(state)) endPromptRowDeferral(key)
    if (state === 'working' && isLaunchInFlight(key)) return 'transient'
    if (PROMPT_ROW_STATES.has(state)) {
      return promptRowReconnectVerdict(key, state, latchedNow, options.noNotice)
    } else if (state === 'pending') {
      // A deliberate deviation from b.jg5 SRJ-410 ("at each retry"): no
      // pending-row rule run here. This branch is reached only in a race,
      // since the probe had just read the row live and not `pending`, and
      // its 'pending' answer cannot carry a gone answer. The cost is the
      // rule running at the next retry, whose first probe reads the row.
      await deferPendingRow(key, launchStartedAt, appliedPersona, { mayRunRule: false })
      return 'pending'
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
    // (b.d61): a re-probe that reads `dead` relaunches at once, with no kill.
    // A row read voids GONE-based evidence for an older life (b.jg5 SRJ-611).
    // Installation failure reads unknown (b.jpf). `pending` or
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
    // `status` read; the fresh waiting row still decides before keys.
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
  return async key => {
    if (deliveryLifecycle?.deferred(key)) deliveryLifecycle.defer(key)
    const result = await run(key)
    if (result === 'transient' || result === 'pending') {
      if (!isLiveRowSequenceRunning(key) && !deliveryLifecycle?.deferred(key)) deliveryLifecycle?.defer(key)
    } else deliveryLifecycle?.clearDeferred(key)
    return result
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
 * (b.jg5 SRJ-115, SRJ-502, SRJ-512): nothing is typed (the step logged
 * the one line), and the
 * adapter answers 'transient', which restart.ts neither counts nor escalates
 * to a kill.
 */
function reconnectLatchedByRead(): 'transient' {
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
  noNotice = false,
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
      return promptRowDeferral(key, state, latchedNow, noNotice)
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
      return promptRowDeferral(key, state, latchedNow, noNotice)
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
  noNotice = false,
): Promise<ReconnectEscalateDead | 'transient'> {
  const deferral = await checkPromptRowDeferral(key, state)
  if (deferral === 'escalate') return escalateDeadWith(DEAD_SESSION_CAUSE_ROW_READ_FINISHED)
  if (deferral === 'refused') return 'transient'
  // b.jg5 SRJ-502: latched after the sweep (its line is logged there): no notice.
  if (deferral === 'latched') return 'transient'
  // b.jg5 SRJ-502: latched elsewhere while the read or the deferral check was
  // awaited (the gate logs its line): no notice.
  if (latchedNow()) return 'transient'
  // b.omv SR-5.5: a failed read preserves prompt-row liveness retries,
  deliveryLifecycle?.defer(key)
  return deferPromptRow(key, state, noNotice)
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


function deferPromptRow(key: string, state: string, noNotice = false): 'transient' {
  console.error(
    `[slack] reconnectSession: persona=${key} is ${state} — its session waits on a prompt or dialog; not typing /mcp reconnect into it, deferring to a later tick (b.f2b/b.rmy)`,
  )
  if (!noNotice) notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
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
  // Bugs b.fc4, b.smv: the state directory's default sits outside ~/.claude
  // ($XDG_CONFIG_HOME/claude-slack-channel-bots, ~/.config/claude-slack-channel-bots),
  // where Claude Code does not ask before a write. On an existing host the old
  // defaults' files (~/.claude/channels/slack, ~/.config/cscb) move there,
  // and each old directory becomes a symbolic link to the new one
  // (state-dir-migration.ts says what happens to each entry, and why it is
  // not done by the CLI or postinstall). First of all: before the directory
  // is made, and so before anything reads or writes it (the PID check, the
  // retired keys, the last-applied record, config.json, channel-delivery.json,
  // the logs, the permission trail). With SLACK_STATE_DIR set it does nothing.
  // It never throws; a start it cannot make safe (an old server still running
  // on the old directory, a step that failed) stops here with the reason in
  // startup-errors.log and on stderr, and moves nothing it has not placed.
  // The log goes to the directory the CLI and the daemon's server.log use
  // (resolveCliStateDir, computed by the migration before it moves anything):
  // the directory that holds the configuration, not the legacy directory of
  // the step that stopped (on a 0.14.0 host the configuration is in
  // ~/.claude/channels/slack while the stopping step is ~/.config/cscb, which
  // holds only the crontable and prompts/).
  const stateDirMigration = migrateStateDirAtStart({ log: (line) => console.error(line) })
  if (stateDirMigration.paths !== undefined && stateDirMigrationStopsStart(stateDirMigration.outcome)) {
    recordStartupError(
      STATE_MIGRATE_STARTUP_ERROR_CLASS,
      stateDirStopMessage(stateDirMigration.paths, stateDirMigration.outcome),
      undefined,
      { logDir: stateDirMigration.startupErrorDir },
    )
    process.exit(1)
  }

  // The state and inbox directories, before any file in the state directory
  // is read or written (nothing is created at import).
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(INBOX_DIR, { recursive: true })

  // The CLI's daemon redirected the console to the server log at the path it
  // chose before this move: in the old directory. After a move that is a name
  // in the old directory (a link, per file while the move is pending), and a
  // rotation would rename the link and reopen a file there. Log to the new
  // directory's file from here on (the same file). Where nothing moved, or the
  // old directory is not ours to move (legacy-unusable), the log stays where
  // the CLI reads a startup failure from.
  const migrationKind = stateDirMigration.outcome.kind
  if (migrationKind === 'moved' || migrationKind === 'pending') repointLogging(join(STATE_DIR, 'server.log'))

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
  // ~/.config/agent-director/state.db (if any) is owned by the current user. Any
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

  // b.omv SR-3.6: replay and compact every journal before Slack/HTTP admission.
  deliveryQueue = createDeliveryQueue({ stateDir: STATE_DIR, onEvent: event => deliveryQueueEvents.emit(event) })
  await deliveryQueue.start()
  deliveryQueue.startMaintenance()
  deliveryPreparation = createDeliveryPreparation({
    queue: deliveryQueue,
    onReceived: (key, item) => deliveryReporting?.received(key, item),
    resolveUserName: resolvePersonaUserName,
    clientFor,
    wake: key => deliveryQueueWake.wake(key),
    onPending: key => deliveryEngines?.wake(key),
  })

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
  // restart delay. Set below, right after the start resolves; never replaced
  // after that. A confirmed apply replaces `personaConfig`'s persona set and
  // its allow_invited_channels switch, and keeps every other server-wide value
  // from here (`configInEffect`, b.av2 SR-8.6, b.deo SRI-201); the start
  // bring-up launches over the same rule. The reload controller keeps its own
  // applied configuration, the record's as resolved, without that override.
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
    queueOpenCount: key => deliveryQueue?.openCount(key) ?? 0,
    onQueueRetained: key => deliveryQueue?.retained(key),
    // b.jg5 SRJ-809: apply step 1 begins its old-life holds in the one hold
    // set, once the last-applied rewrite has succeeded.
    oldLifeHolds,
    stopDelivery: async (key) => { const stopping = deliveryEngines?.forget(key); deliveryLifecycle?.forget(key); const remindersStopping = replyReminders?.forget(key); await Promise.all([stopping, remindersStopping]) },
    // b.av2 SR-8.6 as amended by b.jg5 SRJ-1511, beside b.deo SRI-406,
    // SRI-408 and SRI-502: a confirmed apply's step 1 writes the unwritten
    // drops of a key it brings up, drops the retired keys' stored choices and
    // marks the retiring keys through the one stored-choice store, loaded
    // below after the start resolution, so this reads the holder at call
    // time. An apply before the load is never expected (detection is armed
    // only after the start bring-up); it throws, before anything is written,
    // and the controller logs it.
    channelDelivery: () => {
      if (channelDeliveryStore === undefined) throw new Error('a confirmed apply ran before the start loaded the stored-choice store')
      return channelDeliveryStore
    },
    lifecycle: {
      // b.jg5 SRJ-205: the pass's launch pool reads
      // `shuttingDown` live before starting each launch, so a shutdown begun
      // during the pass (a version re-check's stop included) starts no
      // queued launch and changes no agent-director row.
      // The pass launches over the server's configuration in effect, as every
      // later launch does: the controller's applied persona set and switch over
      // appliedConfig's start-time server-wide settings (configInEffect), never
      // over the controller's configuration as a whole. The pass runs only
      // after the start resolved, so appliedConfig is set; a call before that
      // throws rather than launch without the start-time values, and main()
      // logs it.
      startBringUp: (applied) => {
        if (appliedConfig === undefined) throw new Error('the start bring-up ran before the start resolved its configuration')
        return startupSessionManager(configInEffect(appliedConfig, applied), { bringUp: personaBringUps, isShuttingDown: () => shuttingDown })
      },
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
    // b.av2 SR-8.6 step 1, b.deo SRI-201: once the record holds a confirmed
    // change, the server runs its persona set and its allow_invited_channels
    // switch, the one server-wide setting applied in place. Every other
    // server-wide setting keeps its start-time value (the next start applies
    // it). Everything that reads the applied set or the channel mode reads
    // `personaConfig` at call time: the bring-up controller's applied set,
    // reply reminders, routing, the destination resolver, the notifier,
    // /interject, cron, the health work list and MCP admission.
    // An apply before the start resolved is never expected (detection is
    // armed only after the start bring-up); it throws rather than build a
    // config without the start-time values, and the controller logs it.
    onApplied: (config) => {
      if (appliedConfig === undefined) throw new Error('a confirmed apply ran before the start resolved its configuration')
      personaConfig = configInEffect(appliedConfig, config)
      void deliveryPreparation?.recover(config.personas.map(p => p.key))
    },
  })
  reloadController = reload
  const start = reload.resolveStart()
  if (start.kind === 'refused') process.exit(1)
  personaConfig = start.config
  // b.2nr: the test-only timer override block, read once here from the
  // start-time configuration (never again: a reload does not apply a change
  // of it live). Off unless the file has the block; when any override is
  // active it logs one loud line, moves the version re-check's interval
  // (installed before the configuration was read) and sets B's floor. The
  // latch re-check and the retry timers below take their values from it.
  const testTimers = installTestTimerOverrides(personaConfig.test_timer_overrides, (line) => console.error(line))
  const testMcpDropEnabled = personaConfig.test_mcp_drop_endpoint === true
  if (testMcpDropEnabled) console.error(TEST_MCP_DROP_START_LINE)
  // b.av2 SR-6.2: the trust patch precedes every launch. Installed as soon as
  // the persona config is set — before the Slack connections, Bun.serve and
  // initRestart — so no launch path (start, restart or a human trigger) can
  // run unpatched.
  setPreLaunchTrustPatcher(persona => {
    removeLegacyReplyHooks([persona.claude_config_dir])
    trustPatchPersona(persona)
  })
  // b.omv SR-7.2: startup failure is local; every launch retries the write and fails closed.
  const prepareSystemPrompt = (key: string): void => {
    try {
      if (personaConfig === null) throw new Error('persona configuration unavailable')
      prepareBotSystemPrompt(personaConfig, STATE_DIR)
    } catch (err) {
      const code = redactSlackLogText(queueErrorCode(err))
      console.error(buildDeliveryDiagnostic(SYSTEM_PROMPT_UNWRITABLE, key, `path=${JSON.stringify(botSystemPromptPath(STATE_DIR))} code=${code}`))
      throw err
    }
  }
  setSystemPromptPreparer(prepareSystemPrompt)
  try { prepareSystemPrompt('server-start') } catch { /* persona launches retry independently */ }

  console.error(`[slack] Loaded persona config: ${personaConfig.personas.length} persona(s)`)
  // The start-time applied config (declared before the reload controller).
  appliedConfig = personaConfig

  // b.deo SRI-403, SRI-407 beside b.av2 SR-8.7: the stored-choice file
  // (channel-delivery.json in the state directory) is read once here, right
  // after the start resolved the configuration it runs and before the first
  // await that follows, so no early shutdown return skips it and it comes
  // before the connection manager, Bun.serve, the PID file, the start sweep
  // and the start bring-up; behind no branch, so in both modes and in dry run
  // too. The start rules run right after the read, over the applied personas
  // and the retired-key store loaded above. Its production writer, delete and
  // clock are the store's defaults (durableWriteFileSync, durableUnlinkSync,
  // Date.now). An unreadable file is the store's own state and line, never a
  // stop. This is the server's only stored-choice store: the reload
  // controller reaches it through `channelDeliveryStore`, and nothing else
  // builds one.
  channelDeliveryStore = loadChannelDeliveryAtStart(
    STATE_DIR,
    {
      applied: appliedConfig.personas.map((persona) => ({
        key: persona.key,
        declaration: channelDeliveryDeclarationOf(persona),
      })),
      retiredKeys,
    },
    { log: (line) => console.error(line) },
  )

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
    intervalMs: testTimers.latchRecheckIntervalMs,
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
    // b.av2 SR-6.3, b.jg5 SRJ-509: a clear by hand that clears a latch resets
    // the persona's restart failure count (the counter the cap query above
    // reads) before its retry at once, so the cap does not refuse that retry.
    // Only the clear by hand is handed it; the re-check's own clears leave
    // the count as it is.
    resetRestartFailures: forgetFailures,
  })
  latchRecheckTimers = latchRecheck
  bindLatchRecheck(conflictLatch, latchRecheck)
  // b.jg5 SRJ-510, SRJ-509, SRJ-506: the clear by hand the `/clear-latch`
  // route uses, through the re-check's one clear entry and after-clear
  // sequence with the "cleared by hand" reason. A clear that clears a latch
  // also resets the persona's restart failure count before the retry at once;
  // one that finds the persona unlatched changes nothing. It answers once the
  // clear (and that reset) has run in the persona's serializer turn.
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
    baseS: testTimers.unavailableRetryBaseS,
    ceilingS: testTimers.unavailableRetryCeilingS,
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
      isInFlight: isPersonaRetryBlocked,
      retryBlockCause: personaRetryBlockCause,
      readRow: readPersonaRowState,
      isSessionConnected: (key) => getSessionByPersona(key)?.connected === true,
      endTmuxUnresponsive: (key, reading) => {
        tmuxUnresponsive.end(key, TMUX_UNRESPONSIVE_END_RETRY, reading)
        clearOutageFlag(key, 'tmux-unavailable', reading)
      },
      stepPendingRow: (key) => retryPendingRowStep(key, getAppliedPersona(key)),
    }),
  })
  unavailableRetry = retryTimers

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
  const deliveryScope = createDeliveryAdScope()
  initOutageState({
    deliveryScope,
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


  // b.omv SR-5/6: one gate for every automatic key path, independent
  // delivery clients and retry ownership even with health checks disabled.
  deliveryReporting = createDeliveryReporting({
    queue: deliveryQueue!, episodes: noticeEpisodes,
    persona: getAppliedPersona,
    state: key => ({
      up: !shuttingDown && isPersonaUp(key),
      latched: conflictLatch.isLatched(key), invalidFlags: invalidFlagsHold.isHeld(key),
      killFailed: personaKillFailureAlerts?.isOpen(key) === true || waitsOnKillFailedHold(key),
      oldLife: isOwnRowOldLifeHeld(key) || !!(getAppliedPersona(key) && oldLifeHeldDirectory(getAppliedPersona(key)!.working_directory)), upgrade: isTagUpgradePending(key),
      atRestartLimit: backoffIsAtCap(key, RESTART_FAILURE_CAP), restartsOff: personaConfig?.session_restart_delay === 0,
      outage: getOutageFlags(key).size > 0,
      prompt: hasNotConnectedEpisode(key) || hasNativePromptWarning(key),
      launch: noticeEpisodes.isOpen(key, 'stuck-launch') || isLaunchInFlight(key),
    }),
    stuckAfterMs: testTimers.deliveryStuckAfterMs,
    log: line => console.error(line),
    notify: (key, text) => personaNotifier.notify(key, text),
    delivered: createDeliveryAckCallback({ getReaction: () => getReplySettings().ack_reaction, clientFor }),
  })
  for (const event of bufferedQueueEvents.splice(0)) deliveryReporting.queueEvent(event)
  deliveryReporting.startupFindings(deliveryQueue!.startupFindings())
  deliveryLifecycle = createDeliveryLifecycle({
    startId: randomBytes(16).toString('hex'), parseLaunchStart,
    onError: error => console.error(`[slack] deferred reconnect failed: ${describeThrownValue(error)}`),
  })
  setDeliveryLifecycle(deliveryLifecycle)
  setDeliveryPersonaLookup(getAppliedPersona)
  deliveryClients = createDeliveryClientFactory(agentDirectorCallTimeoutMsOf(personaConfig))
  const deferredReconnect = _buildReconnectSessionAdapter(getAppliedPersona, key => conflictLatch.isLatched(key), getAppliedPersona, { noNotice: true })
  deliveryEngines = createDeliveryEngines({
    queue: deliveryQueue!, lifecycle: deliveryLifecycle,
    clientFor: key => deliveryClients!.clientFor(key),
    call: (key, verb, client, run) => withOutageDetection(key, undefined, verb, c => run(c), { client: client as Client, armsNothing: { personaConfigured: () => !!getAppliedPersona(key) } }),
    instanceId: personaInstanceId,
    persona: key => { const p = getAppliedPersona(key); return p ? { cwd: p.working_directory, configDir: resolveClaudeConfigDir(p.claude_config_dir) } : undefined },
    isUp: key => !shuttingDown && isPersonaUp(key),
    isLatched: key => conflictLatch.isLatched(key),
    isHeld: key => invalidFlagsHold.isHeld(key) || personaKillFailureAlerts?.isOpen(key) === true || waitsOnKillFailedHold(key) || isOwnRowOldLifeHeld(key) || isLiveRowSequenceRunning(key),
    isConnected: key => getSessionByPersona(key)?.connected === true,
    // The engine can notice a newly accepted head while its Slack handler
    // is still acknowledging it. Only post-ack intake/recovery may start
    // name lookups; an unfixed head waits for that owner's durable wake.
    prepare: (key, item) => deliveryPreparation!.owns(key, item.accepted.seq) ? deliveryPreparation!.prepare(key, item) : Promise.resolve(),
    onRow: (key, row) => {
      const held = applyDeliveryOwnRowRead(key, row)
      if (!held) void replyReminders?.observe(key, row)
      return held
    },
    inspectUpgrade: (key, _row, client, beforeCall) => deliveryScope.run(key, client as Client, beforeCall, async () => { await inspectPersonaUpgrade(key, getAppliedPersona(key)) }),
    onKeyError: handleDeliveryKeyError,
    onReadError: handleDeliveryReadError,
    isRestartPendingOrActive, scheduleRestart,
    recoverGone: recoverDeliveryGone,
    recoverAbsent: (key, launch) => {
      if (deliveryLifecycle?.launchId(key) !== launch) return false
      const result = retryTimers.runNow(key, { kind: 'delivery-row-absent' }, 'delivery-row-absent')
      // An already running retry may stop on a row read from before the
      // absence. Keep the engine's GONE evidence unless a new pass started.
      return result === UNAVAILABLE_RETRY_RUN_NOW_RAN || result === UNAVAILABLE_RETRY_RUN_NOW_ARMED
    },
    onEvent: event => deliveryEngineEvents.emit(event),
    onError: (key, error) => console.error(`[slack] delivery persona=${key}: ${describeThrownValue(error)}`),
    reconnect: (key, client, beforeCall) => deliveryScope.run(key, client as Client, beforeCall, async () => {
      const result = await deferredReconnect(key)
      if (typeof result === 'object' && !isRestartPendingOrActive(key)) {
        const p = getAppliedPersona(key)
        if (p) scheduleRestart(key, p.working_directory)
      }
    }),
  })
  replyReminders = createReplyReminders({
    queue: deliveryQueue!,
    getRow: async (key, current) => {
      try {
        const client = await deliveryClients!.clientFor(key)
        if (!current()) return undefined
        const row = await withOutageDetection(key, undefined, 'get', c => c.get({ instance_id: personaInstanceId(key) }), { client: client as Client, armsNothing: { personaConfigured: () => !!getAppliedPersona(key) } })
        if (!current()) return undefined
        return applyDeliveryOwnRowRead(key, row) ? undefined : row
      } catch (error) {
        if (!current()) return undefined
        await handleDeliveryReadError(key, error, 'get')
        throw error
      }
    },
    ready: key => !shuttingDown && deliveryLifecycle?.active(key) === true && !!getAppliedPersona(key) && isPersonaUp(key) && getSessionByPersona(key)?.connected === true && !isDryRun() && !isRestartPendingOrActive(key)
      && !conflictLatch.isLatched(key) && !invalidFlagsHold.isHeld(key) && personaKillFailureAlerts?.isOpen(key) !== true && !waitsOnKillFailedHold(key) && !isOwnRowOldLifeHeld(key)
      && !oldLifeHeldDirectory(getAppliedPersona(key)!.working_directory),
    // Legacy configuration remains accepted as the reminder opt-out. It no
    // longer patches settings or installs a Claude-only hook.
    enabled: key => getAppliedPersona(key)?.stop_hook_bootstrap !== false,
    prepare: (key, item) => deliveryPreparation!.prepare(key, item),
    onError: key => console.error(`[slack] reply-reminder persona=${key}: observation or journal update failed; retrying`),
  })
  replyReminders.start()
  deliveryQueueWake.wake = key => deliveryEngines?.wake(key)
  // Retained in-flight items need recovery before launch reconnects; an
  // accepted-only head has no keys to recover and is fixed after bring-up.
  for (const p of personaConfig.personas) if (deliveryQueue!.items(p.key).some(i => !i.delivered && i.records.some(r => r.kind === 'sent'))) deliveryEngines.wake(p.key)
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

  personaLifecycleOps = createPersonaLifecycle({
    serialize: personaLifecycle.run,
    bringUps: personaBringUps,
    connections: manager,
    routing: { ...personaRouting, forget: key => { personaRouting.forget(key); deliveryReporting?.forget(key); deliveryPreparation?.forget(key); void deliveryEngines?.forget(key); deliveryLifecycle?.forget(key) } },
    destinations: personaDestinations,
    destinationHold: personaDestinationHold,
    notifier: personaNotifier,
    appliedPersonas: () => personaConfig?.personas ?? [],
    dryRun: isDryRun(),
    isShuttingDown: () => shuttingDown,
    log: (line) => console.error(line),
    whenLaunchSettled,
    stopDelivery: async (key) => { const stopping = deliveryEngines?.forget(key); deliveryLifecycle?.forget(key); const remindersStopping = replyReminders?.forget(key); await Promise.all([stopping, remindersStopping]) },
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
    forgetReplyReminders: key => replyReminders?.forget(key) ?? Promise.resolve(),
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
      if (testMcpDropEnabled && url.pathname === TEST_MCP_DROP_ROUTE) {
        return handleTestMcpDrop(req, server.requestIP(req)?.address, {
          getPersonaConfig: () => personaConfig,
          log: (line) => console.error(line),
          disconnect: async (key) => {
            const entry = getSessionByPersona(key)
            if (!entry?.connected) return
            const sessionId = entry.transport.sessionId
            if (!sessionId) throw new Error('No MCP session ID')
            // Exercise the SDK's actual client DELETE path: it invokes
            // onsessionclosed BEFORE closing, preserving normal reconnect.
            const response = await entry.transport.handleRequest(new Request('http://127.0.0.1/mcp', {
              method: 'DELETE', headers: { 'mcp-session-id': sessionId },
            }))
            if (!response.ok) throw new Error('MCP session termination refused')
          },
        })
      }
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
          accept: (key, input) => deliveryPreparation!.accept(key, input),
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
  console.error(`  claude --mcp-config ~/.claude/slack-mcp.json`)
  console.error('')

  // b.omv SR-4.4: scheduler acceptance goes directly to the shared queue.
  try {
    const cronLog = createCronLog(personaConfig.cron_log_path, { maxBytes: personaConfig.cron_log_max_bytes })
    const dispatcher = createCronDispatcher({
      accept: (key, input) => deliveryPreparation!.accept(key, input),
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
  // live state; `dead` for a terminal state (ended, missing) or ErrSpawnNotFound;
  // `unknown` for every other status error, installation failure included,
  // and any state CSCB does not know. Only `dead` leads to a launch, with no kill;
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

  // Initialize restart module with library-backed adapters. Every key is a
  // persona key.
  initRestart({
    canRestart: canRelaunch,
    isSessionAlive: isSessionAliveAdapter,
    inspectUpgrade: async key => (await inspectPersonaUpgrade(key)) !== 'current',
    isSessionConnected: (key) => {
      const session = getSessionByPersona(key)
      return session?.connected === true
    },
    // b.f2b: the persona locates a `working` row's transcript (its
    reconnectSession: _buildReconnectSessionAdapter(getAppliedPersona, (key) => conflictLatch.isLatched(key)),
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

  // Migration only: remove old managed entries before starting bots. Each
  // launch also retries cleanup, including config directories added by reload.
  if (shuttingDown) return
  removeLegacyReplyHooks(personaConfig.personas.map(persona => persona.claude_config_dir))

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
    isReconnectDeferred: key => !!deliveryLifecycle?.deferred(key),
    inspectUpgrade: async key => (await inspectPersonaUpgrade(key)) !== 'current',
    // b.9a7: same connectedness adapter wired into initRestart above
    // (registry entry with connected === true). Lets the tick notice
    // alive-but-disconnected rows and route them to scheduleRestart.
    isSessionConnected: (key) => {
      const session = getSessionByPersona(key)
      return session?.connected === true
    },
    isRestartPendingOrActive,
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
    // (once per episode, for a disconnected session)
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
  // Fix accepted-only items with the clients available after bring-up, including retained keys.
  await deliveryPreparation?.recover()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[slack] Fatal:', err)
    process.exit(1)
  })
}
