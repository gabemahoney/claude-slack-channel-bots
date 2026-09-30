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
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'
import {
  AGENT_DIRECTOR_LIVE_STATES,
  cancelWorkingRowWait,
  checkLaunchConfigDir,
  checkPromptRowDeferral,
  checkWaitingRowPane,
  checkWorkingRowPane,
  deletePersonaInstance,
  endPromptRowDeferral,
  endWorkingRowDeferral,
  forgetNotConnectedEpisode,
  forgetWorkingRowEvidence,
  hasPendingWorkingRowEvidence,
  hasPersonaTmuxSession,
  holdLaunchIfConfigDirUnresolvable,
  isLaunchInFlight,
  killPersonaInstance,
  launchSession,
  noteWorkingRowDeferral,
  notifyDisconnectedWithAutoRestartDisabled,
  notifyPersonaNotConnected,
  notifyRestartCapReached,
  PROMPT_ROW_STATES,
  reconcileOrphans,
  reconnectMcpWithCause,
  setConfigDirUnresolvableHook,
  setPreLaunchReplyGuard,
  setPreLaunchTrustPatcher,
  setSessionNotifier,
  spawnForPersona,
  startupSessionManager,
  sweepDeadTmuxChannel,
  whenLaunchSettled,
} from './session-manager.ts'
import { createPersonaNotifier } from './persona-notifier.ts'
import { createPersonaDestinations } from './persona-destination.ts'
import { createPersonaDestinationHold } from './persona-destination-hold.ts'
import { createPersonaRouting, hasSessionStream } from './persona-routing.ts'
import { createPersonaConnectionManager, type PersonaConnectionManager } from './persona-connections.ts'
import { resolveSlackApiUrlOverride } from './persona-slack-clients.ts'
import { createUnhandledRejectionHandler, describeThrownValue } from './persona-connection-errors.ts'
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
import { cleanSession, getCozempicAvailable } from './cozempic.ts'
import { ErrSpawnNotFound, resolveSystemBinary } from 'agent-director'
import { ErrSystemInstallDisappeared, ErrTmuxNotAvailable } from './agent-director-errors.ts'
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
  RESTART_FAILURE_CAP,
} from './restart.ts'
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
import { disposeAdVersionRecheck, installAdVersionRecheck } from './ad-version-gate.ts'
import { adSettingsInEffect, checkAdCallTimeoutAtStartup, installAdSettings, type AdSettingsInEffect } from './ad-settings.ts'
import { armShutdownDeadline } from './shutdown-deadline.ts'
import { recordStartupError } from './startup-errors.ts'
import { installSlackChannelBotTemplate } from './agent-director-template.ts'
import { createCronLog } from './cron-log.ts'
import { createCronDispatcher } from './cron-dispatch.ts'
import { handleInterject } from './interject.ts'
import { createCronScheduler, type CronScheduler } from './cron-scheduler.ts'
import { configInEffect, createReloadController, reloadFilePaths, type ReloadController } from './reload.ts'
import { createReloadTickDriver } from './reload-timer.ts'
import { PRODUCTION_SLACK_CLIENT_FACTORY } from './persona-slack-clients.ts'
import { initOutageState, setOutageFlag, clearOutageFlag, resetAllToHealthy, withOutageDetection, reportAgentDirectorError } from './outage-state.ts'

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
 * A registered session for persona `key` closed: log it and schedule a
 * restart of that persona in its working directory. `via` qualifies the log
 * line (e.g. ` (SSE abort)`).
 */
function restartDisconnectedPersona(key: string, via: string): void {
  const persona = getAppliedPersona(key)
  if (!persona) {
    console.error(`[slack] Session disconnected${via}: persona=${key} is not an applied persona`)
    return
  }
  console.error(
    `[slack] Session disconnected${via}: persona ${renderPersonaRef(persona.name, persona.key)} ` +
    `cwd="${persona.working_directory}"`,
  )
  // Session-id resume is owned by agent-director (SR-1.3); launchSession
  // relaunches the persona in its own working directory.
  scheduleRestart(key, persona.working_directory)
}

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
// (SR-6.4, `decideSessionAdmission`). On admission: promotes the pending
// session to registered under the persona key. On no match, a persona that is
// not up, or an error: disconnects it.
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
  // A refused session is disconnected like an unmatched one; the persona's
  // registered session, if any, is left as it is.
  const admission = decideSessionAdmission(rootsPath, personaConfig?.personas ?? [], {
    isPersonaUp,
    describeNotUp: describePersonaNotUpByKey,
    log: (line) => console.error(line),
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
 * a notice is held (the real clock is its default). E12's teardown reaches a
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
 */
const personaNotifier = createPersonaNotifier({
  getPersona: getAppliedPersona,
  clientFor,
  destinations: personaDestinations,
  destinationHold: personaDestinationHold,
  isDryRun,
  log: (line) => console.error(line),
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
 * restart, bring-up and destination-hold timers, keep-alives), closes HTTP,
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
  cancelAllRestartTimers()
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
 * _buildIsSessionAliveAdapter — test-only factory for the tick-path liveness
 * probe. Production code wires this via main() as `isSessionAliveAdapter`;
 * tests call it directly to exercise the four SRD § Liveness probe branches
 * without importing the private closure inside main().
 *
 * Its bare `status` is the one persona call not made through the outage
 * wrappers, so its error branches report the error themselves
 * (`reportAgentDirectorError` with the verb `status`): inside a restart run
 * it arms the persona's retry timer (b.jg5 SRJ-301), and from the health
 * tick, which runs outside every attempt, it arms nothing. A thrown `status`
 * still reads dead.
 *
 * @internal
 */
export function _buildIsSessionAliveAdapter(
  getPersonaConfig: () => PersonaConfig | null | undefined,
): (key: string) => Promise<boolean> {
  // `key` is the persona key.
  return async (key: string) => {
    const config = getPersonaConfig()
    if (!config?.personas.some((p) => p.key === key)) return false
    const claude_instance_id = personaInstanceId(key)
    try {
      const r = await getClient().status({ claude_instance_id })
      clearOutageFlag(key, 'ad-unreachable')
      clearOutageFlag(key, 'tmux-unavailable')
      return AGENT_DIRECTOR_LIVE_STATES.has(r.state)
    } catch (err) {
      // b.jg5 SRJ-301: inside a restart run (a recovery attempt) a status
      // error arms the persona's retry timer; the reading below is unchanged.
      reportAgentDirectorError(key, err, 'status')
      if (err instanceof ErrSpawnNotFound) {
        clearOutageFlag(key, 'ad-unreachable')
        clearOutageFlag(key, 'tmux-unavailable')
        return false
      }
      if (err instanceof ErrSystemInstallDisappeared) {
        setOutageFlag(key, 'ad-unreachable', err.binaryPath)
        return false
      }
      if (err instanceof ErrTmuxNotAvailable) {
        setOutageFlag(key, 'tmux-unavailable')
        return false
      }
      console.error(`[slack] isSessionAlive: status error for persona=${key}: ${describeThrownValue(err)}`)
      return false
    }
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

/**
 * _buildKillSessionAdapter — test-only factory for the restart module's
 * killSession dependency. Production code wires this via main()'s initRestart
 * call; tests call it directly.
 *
 * b.av2 SR-6.6 (per-persona lifecycle ops in sequence): restart.ts kills the
 * persona's session and then calls launchSession, which joins a launch already
 * in flight for the key. Mid-ladder (dialog approval on resume, or between
 * delete and spawn) the row reads dead, so an unguarded kill here would take
 * down the process the running launch is bringing up. While a launch for the
 * key is in flight the adapter therefore skips the kill; the in-flight launch
 * owns the session's lifecycle.
 *
 * Bug b.g57: with `getPersona`, a persona whose claude_config_dir cannot be
 * resolved to a real path is not killed either. The kill precedes a launch
 * that could not be made, so the instance and its row are left as they are
 * and the persona is handed to the bring-up controller's hold, as the launch
 * would (`holdLaunchIfConfigDirUnresolvable`); the launch that follows is then
 * refused by the relaunch gate (`'skipped'`), counting no failure.
 *
 * @param getPersona  The applied persona with a key (production:
 *   `getAppliedPersona`); without it the directory is not checked here.
 * @internal
 */
export function _buildKillSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
): (key: string) => Promise<void> {
  // `key` is the persona key.
  return async (key: string) => {
    if (isLaunchInFlight(key)) {
      console.error(`[slack] killSession (restart adapter): launch already in flight for persona=${key} — not killing`)
      return
    }
    const persona = getPersona?.(key)
    if (persona !== undefined && holdLaunchIfConfigDirUnresolvable(persona)) {
      console.error(
        `[slack] killSession (restart adapter): persona=${key} claude_config_dir cannot be resolved to a real path — not killing; its row is kept`,
      )
      return
    }
    try {
      await withOutageDetection(key, undefined, (client) =>
        client.kill({ claude_instance_id: personaInstanceId(key) })
      )
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) return
      if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) return
      console.error(`[slack] killSession (restart adapter): error for persona=${key}: ${describeThrownValue(err)}`)
    }
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
 * logged and the adapter returns 'transient'; the next tick retries (and
 * during an agent-director outage the liveness probe reads the persona dead,
 * so the tick relaunches it instead). Before b.f2b a failed status call fell
 * through to the reconnect.
 *
 * b.f2b — never type into a prompt or dialog. `/mcp reconnect` + Enter typed
 * into an `ask_user` or `check_permission` session could confirm the dialog's
 * default, so those states are deferred too ('transient'): the deferral is
 * logged, and the persona's `blocked-on-prompt` not-connected notice is raised
 * (once per episode). b.jdc: only while its session may still be waiting on
 * the prompt. The row keeps its state after the session dies, so the
 * persona's tmux session is probed first: a gone one is swept and escalated
 * ('escalate-dead', no notice), and once the deferrals have run for
 * `PROMPT_ROW_SWEEP_AFTER_MS` each one first sweeps and reads the row again
 * (`promptRowReconnectVerdict`). Once the prompt is answered, a later tick reconnects it
 * when it can tell the session is idle again (its row reads `waiting`, or the
 * positive-idle rule shows a `working` row stale). A `waiting` row's pane is read once first
 * (`checkWaitingRowPane`): a running turn or a prompt or dialog on it defers
 * the same way (a prompt raises the same notice); a failed read does not, as
 * the `waiting` row is agent-director's own idle signal.
 *
 * b.d61 — the `working` deferral is bounded by the tmux session. A `working`
 * row is no proof of a live turn: when the persona's tmux session is killed
 * mid-turn, SessionEnd fires but AD only soft-refreshes the row
 * (`working → working`), and it stays frozen until a findMissing sweep
 * reconciles it to `missing`. Deferring on the row alone would repeat on every
 * tick and the persona would never relaunch. So the `working` branch also
 * probes the persona's own `slack_bot_<key>` tmux session
 * (`hasPersonaTmuxSession`, the session manager's prober seam):
 *   - a launch for the persona is in flight → defer ('transient'): the launch
 *     owns the session's lifecycle, and a tmux session it has not created yet
 *     is no proof of death;
 *   - alive → the positive-idle rule decides (b.f2b, `checkWorkingRowPane`).
 *     A `working` row can be stale: agent-director may leave it `working`
 *     after the turn ended, and deferring on it forever would strand the
 *     persona. Each attempt makes one evidence read (the pane and, when it
 *     shows an idle screen, the session's transcript, located with the
 *     persona's claude_config_dir from `getPersona`), and the evidence is kept
 *     across attempts (they are a tick or more apart): once the pane has shown
 *     the same idle screen (no busy indicator, no prompt) AND the transcript
 *     has ended with a completed turn, both unchanged, at every read across
 *     reads spanning `STALE_WORKING_WINDOW_MS`, the row is stale and the
 *     adapter goes on to the reconnect below. A busy, changing, blank or
 *     unreadable pane, an idle one whose transcript doesn't end with a
 *     completed turn or can't be located or read, or evidence not yet held for
 *     the window, defers ('transient'), as above; so does a prompt, which is
 *     never typed into, and which raises the `blocked-on-prompt` notice (once
 *     per episode) once shown across reads spanning the window. The evidence
 *     is forgotten when an attempt reads the row in another state or can't
 *     read it, when a launch for the persona starts, and when it reconnects,
 *     becomes deliverable again or is torn down. Each deferral here, and a
 *     failed tmux probe's below, is one more in the persona's run of
 *     deferrals on the row (`noteWorkingRowDeferral`): once the run has lasted
 *     `UNPROVEN_IDLE_NOTICE_AFTER_MS` (10 min), the `unproven-idle`
 *     not-connected notice is raised (once per episode), so a row whose
 *     idleness can never be proven is not held back from silently. The run
 *     ends when an attempt reads another state (a failed status call leaves
 *     it), when a reconnect is typed, when a launch starts and with the
 *     episode;
 *   - gone → there is no pane to type into: fire the dead-tmux sweep
 *     (`sweepDeadTmuxChannel`, b.sv7) once and return 'escalate-dead'.
 *     restart.ts then probes liveness again in the same restart run and, when
 *     the reconciled row reads dead, takes the kill+relaunch branch at once
 *     (otherwise a later tick does);
 *   - the probe throws → defer ('transient'): a failed probe is no proof the
 *     session is dead (b.rmy).
 * The deferral therefore lasts only while the persona's tmux session exists
 * and gives no positive evidence that the row is stale (b.f2b), and is
 * reported once it has lasted `UNPROVEN_IDLE_NOTICE_AFTER_MS`.
 *
 * b.dup — a row agent-director will not type into. agent-director refuses
 * send-keys to a row that is not interactive (`ErrSpawnNotInteractive`):
 *   - `pending` (its session has not started; SessionStart has not fired) →
 *     defer ('transient'), typing nothing (`deferPendingRow`): the keystrokes
 *     would be refused, and the session connects its MCP servers on its own
 *     once it starts.
 *   - `ended` or `missing` — read here, or reached between this status read
 *     and the keystrokes (a findMissing sweep, such as the one another
 *     persona's launch wait starts with, marked the row missing) → the
 *     refused keystrokes make `reconnectMcp` answer 'dead-session', which
 *     escalates below: the claude process is gone, and restart.ts's re-probe
 *     reads the row dead and relaunches the persona in the same run (b.d61).
 *     No spawn-failure notice is raised. Its escalate-dead line has the
 *     verdict `row-not-interactive` (b.jdc), not a dead tmux session's.
 *
 * @param getPersona  The applied persona with a key (production:
 *   `getAppliedPersona`), for locating a `working` row's transcript under its
 *   claude_config_dir; without it only the row's persisted transcript path is
 *   read.
 * @internal
 */
export function _buildReconnectSessionAdapter(
  getPersona?: (key: string) => Persona | undefined,
): (key: string) => Promise<'success' | 'escalate-dead' | 'transient'> {
  // `key` is the persona key.
  return async (key: string) => {
    let state: string
    try {
      const claude_instance_id = personaInstanceId(key)
      const st = await withOutageDetection(key, undefined, (client) =>
        client.status({ claude_instance_id }),
      )
      state = st.state
    } catch (err) {
      // b.f2b: nothing is known about the session, so nothing is typed.
      forgetWorkingRowEvidence(key)
      console.error(
        `[slack] reconnectSession: persona=${key} status check failed: ${describeThrownValue(err)} — not typing /mcp reconnect blind; deferring to a later tick (b.f2b/b.rmy)`,
      )
      return 'transient'
    }
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
      const verdict = await workingReconnectVerdict(key, getPersona)
      if (verdict !== 'reconnect') return verdict
    } else if (PROMPT_ROW_STATES.has(state)) {
      return promptRowReconnectVerdict(key, state)
    } else if (state === 'pending') {
      return deferPendingRow(key)
    } else if (state === 'waiting' && (await checkWaitingRowPane(key)) === 'defer') {
      // b.f2b: its pane shows a running turn or a prompt; logged there.
      return 'transient'
    }
    // Widened return type (SR-25.1 single counting site): surface the
    // ReconnectOutcome to restart.ts so it can call recordSuccess on the
    // success path. Map main's ReconnectOutcome onto the restart union —
    // 'ok' is the only success signal restart.ts acts on; 'dead-session'
    // and 'failed' are non-success (no recordSuccess, no recordFailure).
    // 'dead-session' maps to 'escalate-dead' (b.9a7-amended): restart.ts does
    // not re-enter scheduleRestart on it. For the dead-tmux escalate-dead case
    // (b.sv7 / Epic t1.tkk.e4), CSCB recovers ITSELF: we fire the internal
    // sweep wrapper here so the frozen `working` row reconciles to `missing`,
    // and restart.ts probes liveness again in the same restart run (b.d61):
    // alive === false takes the normal kill+relaunch branch at once. When the
    // row still reads alive, the NEXT health-check tick sees it still alive
    // && !connected (or dead) and reschedules. The external
    // ~/startup/find-missing-loop.sh is belt-and-braces only (it may also
    // reconcile the row, but recovery no longer silently depends on it —
    // removing it is a separate operator decision). Not counting here keeps
    // failures attributed to the launchSession site, which owns the single
    // counting site (SR-25.1).
    const result = await reconnectMcpWithCause(key)
    if (result.outcome === 'ok') return 'success'
    if (result.outcome === 'dead-session') {
      // b.sv7: trigger the internal memoized findMissing sweep (b.m4r) before
      // returning the verdict. The 'escalate-dead' return value is unchanged
      // regardless of sweep outcome (the wrapper never throws). b.jdc: the
      // verdict says what proved the session dead, so the line doesn't claim
      // a dead tmux session for a refused keystroke (b.dup).
      //
      // Memo-TTL vs. tick-cadence: reconcileMissingSweep's 10s memo TTL is
      // harmless at the ~120s health-check tick cadence — a memoized-stale
      // answer costs at most ONE extra tick, because the following tick's
      // escalate-dead sweeps again well past the TTL. And the fleet-wide
      // post-reboot case (b.nk5 — /tmp wiped, ALL personas dead-tmux at once)
      // is served correctly by the single in-flight-shared sweep: one
      // findMissing reconciles the whole store for every escalating persona.
      await sweepDeadTmuxChannel(key, result.deadCause === 'row-not-interactive' ? 'row-not-interactive' : 'dead-session')
      return 'escalate-dead'
    }
    return 'transient'
  }
}

/**
 * b.jdc: the reconnect adapter's verdict for a persona whose row reads
 * `ask_user` or `check_permission` (see `_buildReconnectSessionAdapter`).
 * Nothing is ever typed into such a row (b.rmy). But a session that dies
 * under a prompt keeps its row in that state (agent-director only refreshes a
 * row at SessionEnd and leaves reaping to its findMissing sweep), so the row
 * alone is no proof anyone is waiting on a prompt. Checked in order, the
 * probe before the notice:
 *   - a launch for the persona is in flight → 'transient', with no tmux probe
 *     and no notice: the launch owns the session;
 *   - its own tmux session is gone (`hasPersonaTmuxSession`, exact target) →
 *     the dead-tmux sweep (`sweepDeadTmuxChannel`, verdict
 *     `prompt-row-tmux-gone`) and 'escalate-dead', with no notice: restart.ts
 *     re-probes and relaunches the persona in the same run (b.d61);
 *   - alive, or the probe failed (no proof it is dead) → one more deferral on
 *     the row (`checkPromptRowDeferral`): once the run has lasted
 *     `PROMPT_ROW_SWEEP_AFTER_MS`, it sweeps and reads the row again, and a
 *     row now `ended` or `missing` escalates the same way; otherwise
 *     `deferPromptRow` defers and raises the notice, as before.
 * Never throws: the sweep and the deferral check swallow their own failures.
 */
async function promptRowReconnectVerdict(key: string, state: string): Promise<'escalate-dead' | 'transient'> {
  if (isLaunchInFlight(key)) {
    console.error(`[slack] reconnectSession: persona=${key} is ${state} and a launch for it is in flight — deferring to a later tick (b.jdc)`)
    return 'transient'
  }
  let tmuxAlive: boolean
  try {
    tmuxAlive = await hasPersonaTmuxSession(key)
  } catch (err) {
    console.error(
      `[slack] reconnectSession: persona=${key} is ${state} and its tmux session probe failed: ${describeThrownValue(err)} — taking the session as alive (b.jdc/b.rmy)`,
    )
    tmuxAlive = true
  }
  if (!tmuxAlive) {
    endPromptRowDeferral(key)
    console.error(
      `[slack] reconnectSession: persona=${key} is ${state} but its tmux session "${personaTmuxSessionName(key)}" is gone — no prompt is waiting in it; not deferring, reconciling so the restart relaunches it (b.jdc)`,
    )
    await sweepDeadTmuxChannel(key, 'prompt-row-tmux-gone')
    return 'escalate-dead'
  }
  if ((await checkPromptRowDeferral(key, state)) === 'escalate') return 'escalate-dead'
  return deferPromptRow(key, state)
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
 * b.dup: the reconnect adapter's verdict for a persona whose row reads
 * `pending` (see `_buildReconnectSessionAdapter`): its session has not
 * started, so agent-director would refuse the keystrokes
 * (`ErrSpawnNotInteractive`, which `reconnectMcp` reads as a dead session),
 * and the session connects its MCP servers on its own once it starts. Types
 * nothing, raises no notice (a launch whose session never leaves `pending`
 * raises its own, from its dialog approver), logs the deferral and returns
 * 'transient'; a later tick retries.
 */
function deferPendingRow(key: string): 'transient' {
  console.error(
    `[slack] reconnectSession: persona=${key} is pending — its session has not started (SessionStart has not fired), agent-director refuses send-keys until it does, and it connects on its own once it starts; not typing /mcp reconnect, deferring to a later tick (b.dup)`,
  )
  return 'transient'
}

/**
 * b.d61: the reconnect adapter's verdict for a persona whose AD row reads
 * `working` — defer while a launch for it is in flight or its tmux session
 * cannot be probed, sweep and escalate once it is provably gone (see
 * `_buildReconnectSessionAdapter`). b.f2b: with its tmux session alive the
 * positive-idle rule decides (`checkWorkingRowPane`, the transcript located
 * with the persona `getPersona` returns): 'reconnect' once the row is shown
 * stale, and the adapter goes on to type `/mcp reconnect`; otherwise defer.
 * Never throws: `sweepDeadTmuxChannel` and `checkWorkingRowPane` swallow
 * their own failures. A failed tmux probe is noted as a deferral on the row
 * (`noteWorkingRowDeferral`), as `checkWorkingRowPane` notes its own.
 */
async function workingReconnectVerdict(
  key: string,
  getPersona: ((key: string) => Persona | undefined) | undefined,
): Promise<'escalate-dead' | 'transient' | 'reconnect'> {
  if (isLaunchInFlight(key)) {
    console.error(`[slack] reconnectSession: persona=${key} is working and a launch for it is in flight — deferring /mcp reconnect to a later tick (b.d61)`)
    return 'transient'
  }
  let tmuxAlive: boolean
  try {
    tmuxAlive = await hasPersonaTmuxSession(key)
  } catch (err) {
    console.error(
      `[slack] reconnectSession: persona=${key} is working and its tmux session probe failed: ${describeThrownValue(err)} — deferring /mcp reconnect to a later tick (b.d61/b.rmy)`,
    )
    // b.f2b: held back from the row once more; a long run is reported. The
    // restart path runs only with auto-restart on.
    noteWorkingRowDeferral(key, false)
    return 'transient'
  }
  if (tmuxAlive) {
    // b.f2b: one evidence read (pane, and transcript for an idle pane), folded
    // into the evidence kept across attempts; `checkWorkingRowPane` logs what
    // it found (a running turn logs the b.9a7 deferral line).
    return (await checkWorkingRowPane(key, getPersona?.(key))) === 'reconnect' ? 'reconnect' : 'transient'
  }
  console.error(
    `[slack] reconnectSession: persona=${key} is working but its tmux session "${personaTmuxSessionName(key)}" is gone — not deferring; reconciling so the restart relaunches it (b.d61)`,
  )
  await sweepDeadTmuxChannel(key, 'working-tmux-gone')
  return 'escalate-dead'
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

  // The agent-director store owns session-id state; CSCB's own sessions.json
  // registry was deleted (SR-7.1, Epic 2).

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
  const reload = createReloadController({
    paths: reloadFilePaths(CONFIG_PATH),
    lifecycle: {
      startBringUp: (applied) => startupSessionManager(applied, { bringUp: personaBringUps }),
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

  // Every persona notice goes through the one per-persona notifier: it holds
  // a notice until the persona's client is available and logs instead of
  // posting in dry run.
  initOutageState({
    notify: (key, text) => {
      void personaNotifier.notify(key, text)
    },
    getClient,
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
  // refresh. This supplies only
  // the production dependencies; the operations live in persona-lifecycle.ts.
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
    // b.f2b: a teardown cancels a launch's wait for a `working` row rather
    // than wait it out (up to 10 min).
    cancelLaunchWait: cancelWorkingRowWait,
    cancelRestartTimer,
    forgetFailures,
    forgetDisconnectedStreak,
    forgetNotConnectedEpisode,
    resetOutageState: resetAllToHealthy,
    forgetPersonaPrompts,
    forgetAcks: forgetPersonaAcks,
    dropSession: dropPersonaSessionAndKeepAlive,
    killInstance: killPersonaInstance,
    deleteInstance: deletePersonaInstance,
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
    // brought up (Epic 2 boundary for pre-start observations).
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

  writePidFile(PID_FILE)

  console.error(`[slack] MCP server listening on http://${mcpHost}:${mcpPort}/mcp`)
  console.error('')
  console.error('Save this to ~/.claude/slack-mcp.json:')
  console.error(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `http://${mcpHost}:${mcpPort}/mcp` } } }, null, 2))
  console.error('')
  console.error('Then launch Claude from a project directory with:')
  console.error(`  claude --mcp-config ~/.claude/slack-mcp.json --dangerously-load-development-channels server:${MCP_SERVER_NAME}`)
  console.error('')

  // Cron scheduler — the once-per-minute dispatch tick (b.he5 E2). It is its
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
  // SR-11 Event 6a. Any AGENT_DIRECTOR_LIVE_STATES value → alive; terminal
  // states (ended, missing) and ErrSpawnNotFound → dead. Other errors fall
  // back to "dead" defensively — health-check will retry.
  const isSessionAliveAdapter = _buildIsSessionAliveAdapter(() => personaConfig)

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
    reconnectSession: _buildReconnectSessionAdapter(getAppliedPersona),
    killSession: _buildKillSessionAdapter(getAppliedPersona),
    launchSession: async (key) => {
      if (!personaConfig) return false
      // Launches the applied persona with this key; false when there is none.
      // resume vs fresh is handled inside spawnForPersona (SR-1.4
      // collision-then-act). The cwd and session-id arguments from the legacy
      // restart deps are ignored — the persona carries its working directory
      // and AD owns the resume state, not CSCB. A persona that is not up is
      // skipped (neither success nor failure); a launch its UNAVAILABLE retry
      // timer was armed for is passed through as 'refused', which restart.ts
      // never counts (b.jg5 SRJ-301, SRJ-302).
      return await launchSession(key, personaConfig, { canLaunch: canRelaunch })
    },
    getRestartDelay: () => appliedConfig.session_restart_delay,
    isShuttingDown: () => shuttingDown,
    // The persona's restart-cap notice (SR-25.3), built in the session manager.
    onCapReached: (key) => notifyRestartCapReached(key),
    // b.av2 SR-6.6: a fired timer's work waits its turn behind any lifecycle
    // operation for the persona.
    serialize: personaLifecycle.run,
  })

  // b.av2 SR-6.3: the start sweep, BEFORE the trust patch and any spawn.
  // `service=cscb` spawns naming a persona absent from the applied config, or
  // with an instance ID other than `cscb_<key>` or a `cwd` other than the
  // persona's working directory, get killed + deleted. A spawn with no
  // `persona` label (a pre-persona row, b.1ix) is never deleted: a live one is
  // killed and kept, and one findMissing sweep after those kills lets a row
  // whose session is gone read `missing`.
  try {
    await reconcileOrphans(personaConfig)
  } catch (err) {
    console.error(`[slack] Warning: orphan reconciliation failed: ${describeThrownValue(err)}`)
  }

  // b.uhv / b.k54 / b.av2 SR-6.2: patch .claude.json for every applied
  // persona's working directory so the trust dialog and project onboarding are
  // pre-accepted before any spawn fires (the pre-launch patcher repeats it per
  // launch). Runs for both real and dry-run modes (config-file patch, not a
  // session operation).
  await trustBootstrap(personaConfig)

  // b.zak: preventative JSONL-persistence safeguard. Detect non-persistent
  // storage roots (Layer 1) and personas whose transcript would be treated as
  // missing on resume (Layer 2) and say so LOUDLY, BEFORE startupSessionManager
  // runs the resume path that silently deletes+fresh-spawns on ErrJsonlMissing.
  // Runs over the applied personas. Awaited but wrapped so a rejection can
  // never kill startup. Its notices go through the per-persona notifier, which
  // only logs them in dry run.
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
    // b.f2b: a launch in flight owns its session (a start launch may still be
    // waiting in the background for a `working` row), so the tick skips it.
    isLaunchInFlight,
    // b.f2b: with session_restart_delay 0 scheduleRestart does nothing, so an
    // alive persona the tick would reconnect gets the not-connected notice
    // (once per episode, worded for a disconnected or a streamless session)
    // instead of being left down silently; the episode ends when the tick
    // finds it deliverable again.
    isAutoRestartDisabled: () => appliedConfig.session_restart_delay === 0,
    notifyNotConnected: notifyDisconnectedWithAutoRestartDisabled,
    endNotConnectedEpisode: forgetNotConnectedEpisode,
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
  // tick skips a persona whose launch is in flight (`isLaunchInFlight`).
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
