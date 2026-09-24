#!/usr/bin/env bun
/**
 * Slack Channel for Claude Code
 *
 * Two-way Slack ↔ Claude Code bridge via Socket Mode + MCP HTTP (StreamableHTTP).
 * Security: per-persona delivery rules, persona posting scope, file exfiltration
 * guard, bot token sent only to Slack-hosted file URLs.
 *
 * Multi-session routing: each Claude Code session connects to its own MCP Server
 * instance and is matched to a persona by the real path of its roots working
 * directory. Inbound Slack messages go through each receiving persona's
 * pipeline in `persona-routing.ts`: a persona hears only the channels it is
 * configured into (every message in a `delivery: all` channel, only its direct
 * mentions in a `delivery: mentions` one), and a delivered message reaches that
 * persona's session only. Outbound tool calls post as the session's persona and
 * are scoped to that persona's configured channels.
 *
 * SPDX-License-Identifier: MIT
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  readFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  promises as fsPromises,
} from 'fs'

import {
  defaultAccess,
  assertSendable as libAssertSendable,
  type Access,
} from './lib.ts'
import {
  loadConfig,
  expandTilde,
  credentialsFilesToProtect,
  resolveRealPath,
  DEFAULT_CONFIG_PATH,
  type Persona,
  type PersonaConfig,
  type RoutingConfig,
  MCP_SERVER_NAME,
} from './config.ts'
import { personaInstanceId, renderPersonaRef, resolvePersonaTarget } from './persona-identity.ts'
import { routesToPersonaConfig } from './route-persona-adapter.ts'
import {
  AGENT_DIRECTOR_LIVE_STATES,
  isLaunchInFlight,
  launchSession,
  notifyRestartCapReached,
  reconcileOrphans,
  reconnectMcp,
  setPreLaunchTrustPatcher,
  setSessionNotifier,
  startupSessionManager,
  sweepDeadTmuxChannel,
} from './session-manager.ts'
import { createPersonaNotifier } from './persona-notifier.ts'
import { createPersonaRouting, hasSessionStream } from './persona-routing.ts'
import { cleanSession, getCozempicAvailable } from './cozempic.ts'
import { ErrSpawnNotFound } from 'agent-director'
import { ErrSystemInstallDisappeared, ErrTmuxNotAvailable } from './agent-director-errors.ts'
import { getClient, closeClient } from './agent-director-client.ts'
import {
  emitBlockActionReceived,
  handlePermissionClick,
} from './permission-click-handler.ts'
import { personaKeyFromActionId } from './permission-action-id.ts'
import { trustBootstrap, trustPatchPersona } from './trust-bootstrap.ts'
import { runJsonlPersistenceSafeguard } from './jsonl-persistence-check.ts'
import { stopHookBootstrap } from './stop-hook-bootstrap.ts'
import { startPermissionPoller, stopPermissionPoller } from './permission-poller.ts'
import {
  initRestart,
  scheduleRestart,
  cancelAllRestartTimers,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
} from './restart.ts'
import { buildPersonaWorkList, initHealthCheck, startHealthCheck, stopHealthCheck } from './health-check.ts'
import { isAtCap as backoffIsAtCap } from './backoff.ts'
import { loadTokens, isDryRun } from './tokens.ts'
import { checkPidConflict, writePidFile, removePidFile } from './pid.ts'
import { consumeAck } from './ack-tracker.ts'
import {
  openArchiveDatabase,
  createNameResolver,
  archiveSlackMessage,
  type SlackMessageEvent,
  type NameResolver,
} from './message-archive.ts'
import type { Database as ArchiveDatabase } from 'bun:sqlite'
import {
  registerSession,
  unregisterByMcpSessionId,
  getSessionByPersona,
  matchPersonaByRootsPath,
  resolveTransportForRequest,
  registerMcpSessionId,
  createSessionServer,
  getAllSessions,
  createPendingSession,
  getPendingSession,
  removePendingSession,
  getAllPendingSessions,
  type SessionToolDeps,
  type SessionEntry,
} from './registry.ts'
import { runAgentDirectorStartupGate } from './agent-director-startup.ts'
import { installSlackChannelBotTemplate } from './agent-director-template.ts'
import { createCronLog } from './cron-log.ts'
import { createCronDispatcher } from './cron-dispatch.ts'
import { handleInterject } from './interject.ts'
import { createCronScheduler, type CronScheduler } from './cron-scheduler.ts'
import { initOutageState, setOutageFlag, clearOutageFlag, resetAllToHealthy, withOutageDetection } from './outage-state.ts'

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
 * disconnect / route mismatch / errors) are logged unconditionally elsewhere.
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

const STATE_DIR = process.env['SLACK_STATE_DIR'] || join(homedir(), '.claude', 'channels', 'slack')
/** The configuration file main() loads; the file guard also reads it (b.av2 SR-5.2). */
const CONFIG_PATH = DEFAULT_CONFIG_PATH
const ACCESS_FILE = join(STATE_DIR, 'access.json')
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
// Bootstrap — tokens & state directory
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(INBOX_DIR, { recursive: true })

const serverTokens = loadTokens()

// ---------------------------------------------------------------------------
// Slack clients
// ---------------------------------------------------------------------------

const web = new WebClient(serverTokens.botToken)
const socket = new SocketModeClient({ appToken: serverTokens.appToken })

let botUserId = ''

// ---------------------------------------------------------------------------
// Message archive — write every inbound Slack message to SQLite (feature-gated)
// ---------------------------------------------------------------------------

let archiveDb: ArchiveDatabase | undefined
let archiveResolver: NameResolver | undefined

/**
 * Fire-and-forget archive write. Safe to call on every inbound event; a no-op
 * when the feature is disabled. Errors are logged but never thrown so archiving
 * can never interfere with routing/delivery.
 */
function archiveInboundMessage(event: unknown): void {
  if (!archiveDb || !archiveResolver) return
  const msg = event as SlackMessageEvent
  archiveSlackMessage(archiveDb, msg, archiveResolver).catch((err) => {
    console.error('[slack] message-archive write failed:', err)
  })
}

// Permission relay state lives in src/permission-poller.ts (SR-2.1 polling
// model). AskUserQuestion is denied at the agent-director template level
// (SR-3.1); the prior in-process pendingQuestions registry has been
// removed (SR-7.1).

// ---------------------------------------------------------------------------
// Access settings — load (ack reaction and reply chunking until E9)
// ---------------------------------------------------------------------------

function loadAccess(): Access {
  if (!existsSync(ACCESS_FILE)) return defaultAccess()
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf-8')
    return { ...defaultAccess(), ...JSON.parse(raw) }
  } catch {
    const aside = ACCESS_FILE + '.corrupt.' + Date.now()
    try {
      renameSync(ACCESS_FILE, aside)
    } catch { /* ignore */ }
    return defaultAccess()
  }
}

// ---------------------------------------------------------------------------
// Static mode
// ---------------------------------------------------------------------------

const STATIC_MODE = (process.env['SLACK_ACCESS_MODE'] || '').toLowerCase() === 'static'
let staticAccess: Access | null = null

if (STATIC_MODE) {
  staticAccess = loadAccess()
}

function getAccess(): Access {
  if (STATIC_MODE && staticAccess) return staticAccess
  return loadAccess()
}

// ---------------------------------------------------------------------------
// Security — assertSendable (file exfiltration guard)
// ---------------------------------------------------------------------------

/**
 * Refuses files under the state directory outside the inbox, and every
 * persona credentials file named by the applied config or by the config file
 * currently on disk (b.av2 SR-5.2). The protected list is built per call.
 */
function assertSendable(filePath: string): void {
  const protectedPaths = credentialsFilesToProtect(personaConfig?.personas ?? [], CONFIG_PATH)
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
  getAccess,
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
// applied persona (b.av2 SR-6.3). On match: promotes the pending session to
// registered under the persona key. On no match or error: disconnects it.
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
    removePendingSession(pendingId)
    try { await pendingEntry.transport.close() } catch { /* ignore */ }
    return
  }

  let roots: { uri: string }[]

  try {
    const result = await server.listRoots()
    roots = result.roots
  } catch (err) {
    console.error(`[slack] roots/list failed for pending session "${pendingId}":`, err)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  if (!roots.length) {
    console.error(`[slack] Pending session "${pendingId}" reported no roots — disconnecting`)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  // Extract filesystem path from file:// URI (use first root as CWD).
  // fileURLToPath handles percent-encoded characters and the triple-slash convention.
  const rawCwd = fileURLToPath(roots[0].uri)
  const rootsPath = resolve(expandTilde(rawCwd))
  const realCwd = resolveRealPath(rootsPath)

  if (!personaConfig) {
    console.error(`[slack] No persona config — disconnecting pending session "${pendingId}" (CWD: "${realCwd}")`)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  const persona = matchPersonaByRootsPath(rootsPath, personaConfig.personas)

  if (!persona) {
    console.error(`[slack] Session connected with CWD "${realCwd}" — no matching persona`)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  const ref = renderPersonaRef(persona.name, persona.key)
  const existingSession = getSessionByPersona(persona.key)

  // Promote pending → registered (removes from pendingSessionMap internally;
  // the pending stub becomes the registered entry).
  registerSession(realCwd, persona.key, pendingId)

  // Register MCP session ID for future HTTP request routing
  registerMcpSessionId(pendingId, persona.key)

  if (existingSession) {
    console.error(`[slack] Session replaced existing connection for persona ${ref}`)
  }
  console.error(`[slack] Session connected: persona ${ref} cwd="${realCwd}"`)
}

// ---------------------------------------------------------------------------
// Inbound delivery per persona (b.av2 SR-4.1, SR-4.2 core)
// ---------------------------------------------------------------------------

/** Keys of the applied personas; empty when there is no persona config. */
function appliedPersonaKeys(): string[] {
  return personaConfig?.personas.map((p) => p.key) ?? []
}

/**
 * The one persona-routing instance. Each socket event is handed to it with
 * every applied persona as a receiver: until E3 Task 9 there is one Socket
 * Mode connection, which every stand-in persona shares.
 */
const personaRouting = createPersonaRouting({
  getPersonaConfig: () => personaConfig,
  // TRANSITIONAL — re-pointed in E3 Task 9 at each persona's own identity from
  // the connection manager. Until then every applied persona shares the one
  // module-scope bot user (`U000DRY` in dry run).
  getBotUserId: (key) => (getAppliedPersona(key) ? botUserId : undefined),
  clientFor,
  resolveUserName: resolvePersonaUserName,
  // Today's archive writer and resolver; the per-persona resolver is E3 Task 9's.
  archive: (_key, event) => archiveInboundMessage(event),
  getAccess,
  log: (line) => console.error(line),
})

// Permission Block Kit builders moved to src/permission-poller.ts
// (SR-2.1/2.2 — owns the message + action_id encoding).

// ---------------------------------------------------------------------------
// Socket Mode event routing
// ---------------------------------------------------------------------------

// Both events go to the persona-routing intake, which acks first. With no
// persona config (the MCP_HOST / MCP_PORT fallback) there is no receiver, so
// the event is acked and nothing is delivered.
socket.on('message', async ({ event, ack }) => {
  console.error('[slack] RAW message event:', JSON.stringify(event)?.slice(0, 300))
  await personaRouting.receive(event, ack, appliedPersonaKeys())
})

socket.on('app_mention', async ({ event, ack }) => {
  console.error('[slack] RAW app_mention event:', JSON.stringify(event)?.slice(0, 300))
  await personaRouting.receive(event, ack, appliedPersonaKeys())
})

socket.on('interactive', async (evt) => {
  const { ack } = evt as { ack: () => Promise<void> }
  const p = ((evt as any).body ?? (evt as any).payload ?? evt) as Record<string, unknown>
  const actions = (Array.isArray(p['actions']) ? p['actions'] : []) as Array<{ action_id: string }>
  // SR-V-2.6 / SR-V-2.9 envelope: pull the inbound channel / message ts /
  // clicking user once per payload — all actions in this payload share them.
  const channelId = ((p['channel'] as { id?: string } | undefined)?.id) ?? undefined
  const messageTs = ((p['message'] as { ts?: string } | undefined)?.ts) ?? undefined
  const userId = ((p['user'] as { id?: string } | undefined)?.id) ?? undefined

  for (const action of actions) {
    const actionId = action.action_id
    // SR-V-2.9: emit cscb.block_action.received for every action regardless
    // of whether handlePermissionClick decides to engage. Decode-failure
    // cases are diagnostically critical for "I clicked and nothing happened".
    emitBlockActionReceived(actionId, {
      channel: channelId,
      messageTs,
      user: userId,
    })

    // TRANSITIONAL — until E3 Task 9 there is one Socket Mode connection, so
    // the receiving persona is taken from the action ID. Task 9 replaces it
    // with the receiving connection's persona key.
    const handled = await handlePermissionClick(
      actionId,
      {
        receivingPersonaKey: personaKeyFromActionId(actionId),
        clientFor,
        getPersona: getAppliedPersona,
      },
      { channel: channelId, messageTs, user: userId },
    )
    if (handled) {
      await ack()
      return
    }
  }
  await ack()
})

// ---------------------------------------------------------------------------
// Routing config
// ---------------------------------------------------------------------------

let routingConfig: RoutingConfig | null = null

/**
 * TRANSITIONAL — removed in E3 Task 9 with the route->persona adapter.
 * Stand-in personas built from `routingConfig` right after `loadConfig()`
 * succeeds; null on the MCP_HOST / MCP_PORT fallback path. Read by the
 * persona-keyed consumers (template install, start passes, startup spawns,
 * restart launch, liveness probe).
 */
let personaConfig: PersonaConfig | null = null

/**
 * The applied persona with this key, read from the current persona config at
 * call time; undefined when there is none. The one by-key lookup: the
 * notifier and the MCP tools both use it.
 */
function getAppliedPersona(key: string): Persona | undefined {
  return personaConfig?.personas.find((p) => p.key === key)
}

// ---------------------------------------------------------------------------
// Persona notices (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

/**
 * True once Slack is validated: set right after Socket Mode connects, where
 * held persona notices are flushed. Never set in dry run.
 */
let slackValidated = false

/**
 * The validated Web client for persona `key`: the module-scope client once
 * Slack is validated and `key` is an applied persona; undefined before that,
 * in dry run and for any other key.
 *
 * TRANSITIONAL — re-pointed in E3 Task 9 at the persona's own client from the
 * connection manager (validated per persona).
 */
function clientFor(key: string): WebClient | undefined {
  if (!slackValidated || isDryRun()) return undefined
  if (!personaConfig?.personas.some((p) => p.key === key)) return undefined
  return web
}

/**
 * The one per-persona notifier. Outage state, the session manager and the
 * JSONL safeguard send every persona notice through it (installed in main()).
 */
const personaNotifier = createPersonaNotifier({
  getPersona: getAppliedPersona,
  clientFor,
  isDryRun,
  log: (line) => console.error(line),
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
let httpServer: ReturnType<typeof Bun.serve> | null = null
let cronScheduler: CronScheduler | null = null

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stopPermissionPoller()
  stopHealthCheck()
  if (cronScheduler) {
    cronScheduler.stop()
    cronScheduler = null
  }
  cancelAllRestartTimers()
  stopAllKeepAliveTimers()

  console.error(`[slack] Received ${signal} — shutting down`)

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

  console.error('[slack] Disconnecting Socket Mode')
  try {
    await socket.disconnect()
  } catch { /* ignore */ }

  // SR-11 Event 11: release the agent-director Client handle. close() is
  // idempotent + never throws per the library contract, but wrap defensively.
  try {
    closeClient()
  } catch (err) {
    console.error('[slack] closeClient on shutdown threw (ignored):', err)
  }

  removePidFile(PID_FILE)

  console.error('[slack] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })

// ---------------------------------------------------------------------------
// _buildIsSessionAliveAdapter
// ---------------------------------------------------------------------------

/**
 * _buildIsSessionAliveAdapter — test-only factory for the tick-path liveness
 * probe. Production code wires this via main() as `isSessionAliveAdapter`;
 * tests call it directly to exercise the four SRD § Liveness probe branches
 * without importing the private closure inside main().
 *
 * @internal
 */
export function _buildIsSessionAliveAdapter(
  getPersonaConfig: () => PersonaConfig | null | undefined,
): (key: string) => Promise<boolean> {
  // `key` is the persona key (the channel ID under the route->persona adapter).
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
      console.error(`[slack] isSessionAlive: status error for persona=${key}:`, err)
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
        console.error(`[slack] health-check: statRoute(${cwd}) failed:`, err)
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
 * @internal
 */
export function _buildKillSessionAdapter(): (key: string) => Promise<void> {
  // `key` is the persona key (the channel ID under the route->persona adapter).
  return async (key: string) => {
    if (isLaunchInFlight(key)) {
      console.error(`[slack] killSession (restart adapter): launch already in flight for persona=${key} — not killing`)
      return
    }
    try {
      await withOutageDetection(key, undefined, (client) =>
        client.kill({ claude_instance_id: personaInstanceId(key) })
      )
    } catch (err) {
      if (err instanceof ErrSpawnNotFound) return
      if (err instanceof ErrSystemInstallDisappeared || err instanceof ErrTmuxNotAvailable) return
      console.error(`[slack] killSession (restart adapter): error for persona=${key}:`, err)
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
 * NOT count and does NOT re-enter scheduleRestart on, leaving the next tick free
 * to retry once the turn settles to an idle-like state (waiting/ask_user/
 * check_permission). This does not regress the b.rmy invariant: we never declare
 * `working` dead, only decline to poke it. On any status error we fall through
 * to the reconnect attempt (today's behavior) rather than manufacture a false
 * defer.
 *
 * @internal
 */
export function _buildReconnectSessionAdapter(): (key: string) => Promise<'success' | 'escalate-dead' | 'transient'> {
  // `key` is the persona key (the channel ID under the route->persona adapter).
  return async (key: string) => {
    try {
      const claude_instance_id = personaInstanceId(key)
      const st = await withOutageDetection(key, undefined, (client) =>
        client.status({ claude_instance_id }),
      )
      if (st.state === 'working') {
        console.error(`[slack] reconnectSession: persona=${key} is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`)
        return 'transient'
      }
    } catch {
      // Ignore — proceed to reconnect attempt below (reconnectMcp handles its
      // own status/send-keys errors and outage flagging).
    }
    // Widened return type (SR-25.1 single counting site): surface the
    // ReconnectOutcome to restart.ts so it can call recordSuccess on the
    // success path. Map main's ReconnectOutcome onto the restart union —
    // 'ok' is the only success signal restart.ts acts on; 'dead-session'
    // and 'failed' are non-success (no recordSuccess, no recordFailure).
    // 'dead-session' maps to 'escalate-dead' (b.9a7-amended): restart.ts does
    // not re-enter scheduleRestart on it, but the NEXT health-check tick will
    // — it sees the row still alive && !connected (or dead), and reschedules.
    // For the dead-tmux escalate-dead case (b.sv7 / Epic t1.tkk.e4), CSCB
    // recovers ITSELF: we fire the internal sweep wrapper here so the frozen
    // `working` row reconciles to `missing`, and the next tick sees
    // alive === false and takes the normal kill+relaunch branch. The external
    // ~/startup/find-missing-loop.sh is belt-and-braces only (it may also
    // reconcile the row, but recovery no longer silently depends on it —
    // removing it is a separate operator decision). Not counting here keeps
    // failures attributed to the launchSession site, which owns the single
    // counting site (SR-25.1).
    const result = await reconnectMcp(key)
    if (result === 'ok') return 'success'
    if (result === 'dead-session') {
      // b.sv7: trigger the internal memoized findMissing sweep (b.m4r) before
      // returning the verdict. The 'escalate-dead' return value is unchanged
      // regardless of sweep outcome (the wrapper never throws).
      //
      // Memo-TTL vs. tick-cadence: reconcileMissingSweep's 10s memo TTL is
      // harmless at the ~120s health-check tick cadence — a memoized-stale
      // answer costs at most ONE extra tick, because the following tick's
      // escalate-dead sweeps again well past the TTL. And the fleet-wide
      // post-reboot case (b.nk5 — /tmp wiped, ALL channels dead-tmux at once)
      // is served correctly by the single in-flight-shared sweep: one
      // findMissing reconciles the whole store for every escalating channel.
      await sweepDeadTmuxChannel(key, result)
      return 'escalate-dead'
    }
    return 'transient'
  }
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
  // SR-5.1: agent-director startup gate.
  // Runs before any other CSCB work — imports the library, constructs the
  // singleton Client, performs the version probe, and verifies that the
  // existing ~/.agent-director/state.db (if any) is owned by the current
  // user. Any failure records to startup-errors.log and exits non-zero.
  await runAgentDirectorStartupGate()

  // Check for an existing server BEFORE any side-effectful startup work —
  // before writePidFile (which would clobber the live server's PID file),
  // and before the template overwrite and Socket Mode connect below (crontable
  // bootstrap now happens later, inside the scheduler started after Bun.serve).
  // A duplicate start must fail fast without mutating shared state.
  checkPidConflict(PID_FILE)

  // The agent-director store owns session-id state; CSCB's own sessions.json
  // registry was deleted (SR-7.1, Epic 2).

  let mcpHost: string
  let mcpPort: number

  try {
    routingConfig = loadConfig(CONFIG_PATH)
    const appliedPersonas = routesToPersonaConfig(routingConfig)
    personaConfig = appliedPersonas
    // b.av2 SR-6.2: the trust patch precedes every launch. Installed as soon as
    // the persona config is set — before the Slack socket, Bun.serve and
    // initRestart — so no launch path (start, restart or a human trigger) can
    // run unpatched.
    setPreLaunchTrustPatcher(trustPatchPersona)
    mcpHost = routingConfig.bind
    mcpPort = routingConfig.port
    const routeCount = Object.keys(routingConfig.routes).length
    console.error(`[slack] Loaded routing config: ${routeCount} route(s)`)

    // SR-3.2: refresh the slack-channel-bot agent-director template on every
    // boot, after the persona config is set: its memory-read rules cover the
    // personas' effective config dirs. Atomic replacement via
    // Client.makeTemplate(..., overwrite: true) gives us "ensure post-state"
    // semantics. Fatal startup error on failure.
    await installSlackChannelBotTemplate(appliedPersonas)

    // Initialize message archive if configured
    if (routingConfig.message_archive_db) {
      try {
        archiveDb = openArchiveDatabase(routingConfig.message_archive_db)
        archiveResolver = createNameResolver(web)
        console.error(`[slack] Message archive enabled: ${routingConfig.message_archive_db}`)
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err)
        console.error(`[slack] Warning: failed to initialize message archive: ${cause}`)
        archiveDb = undefined
        archiveResolver = undefined
      }
    }

    // NOTE: crontable bootstrap (ensureCrontableExists) is NO LONGER called
    // here. Per PM review it moved into cron-scheduler.start() — the scheduler
    // is now the ONLY caller of ensure-exists, wired after Bun.serve() below.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('cannot read routing config')) {
      console.error(
        `[slack] Warning: no routing config found — falling back to env vars (MCP_HOST/MCP_PORT)`,
      )
      mcpHost = process.env['MCP_HOST'] ?? '127.0.0.1'
      mcpPort = Number(process.env['MCP_PORT'] ?? 3100)
    } else {
      console.error(`[slack] Fatal: routing config error — ${msg}`)
      process.exit(1)
    }
  }

  // Every persona notice goes through the one per-persona notifier: it holds
  // a notice until Slack is validated and logs instead of posting in dry run.
  initOutageState({
    notify: (key, text) => {
      void personaNotifier.notify(key, text)
    },
    getClient,
  })
  setSessionNotifier(personaNotifier.notify)

  if (isDryRun()) {
    console.error('[slack] Running in dry-run mode — Slack disabled')
    botUserId = 'U000DRY'
  } else {
    // Resolve bot user ID
    try {
      const auth = await web.auth.test()
      botUserId = (auth.user_id as string) || ''
    } catch (err) {
      console.error('[slack] Failed to resolve bot user ID:', err)
    }

    // Connect Socket Mode
    await socket.start()
    console.error('[slack] Socket Mode connected')

    if (personaConfig) {
      resetAllToHealthy(personaConfig.personas.map((p) => p.key))
    }

    // SR-2.1 permission poller — single-threaded interval loop monitors AD
    // state for spawns in check_permission and posts Block Kit prompts to
    // each persona's destination through its client (b.av2 SR-7.1).
    if (personaConfig) {
      startPermissionPoller({
        getClient,
        clientFor,
        getPersona: getAppliedPersona,
        intervalMs: personaConfig.agent_director_poll_interval_ms,
      })
    }

    // Slack is validated: post each applied persona's held notices, one
    // persona at a time, through that persona's client (b.av2 SR-7.2).
    slackValidated = true
    for (const persona of personaConfig?.personas ?? []) {
      void personaNotifier.flush(persona.key)
    }
  }

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
  // that placement). Guarded on routingConfig: the env-var fallback path
  // constructs and starts NOTHING cron-related. Uses the ACTUAL bound port
  // (httpServer.port) so port-0 configs still reach the right listener. Any
  // construction/start failure is non-fatal — the server keeps serving without
  // a scheduler. scheduler.start() also owns the crontable bootstrap (the sole
  // ensure-exists caller) and is failure-isolated internally.
  if (routingConfig) {
    try {
      const cronLog = createCronLog(routingConfig.cron_log_path)
      // Prefer the ACTUAL bound port (covers port-0 configs); fall back to the
      // requested port only if Bun leaves it undefined (never expected once the
      // server is listening).
      const boundPort = httpServer.port ?? mcpPort
      const dispatcher = createCronDispatcher({
        port: boundPort,
        cronLog,
        cronTablePath: routingConfig.cron_table_path,
        // Resolved against the applied persona config at each fire.
        resolveTarget: (target) => resolvePersonaTarget(personaConfig, target)?.key,
      })
      cronScheduler = createCronScheduler({
        dispatcher,
        cronLog,
        cronTablePath: routingConfig.cron_table_path,
      })
      cronScheduler.start()
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      console.error(`[slack] Warning: cron scheduler failed to start — ${cause}`)
      cronScheduler = null
    }
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
    isSessionAlive: isSessionAliveAdapter,
    isSessionConnected: (key) => {
      const session = getSessionByPersona(key)
      return session?.connected === true
    },
    hasSessionStream,
    reconnectSession: _buildReconnectSessionAdapter(),
    killSession: _buildKillSessionAdapter(),
    launchSession: async (key) => {
      if (!personaConfig) return false
      // Launches the applied persona with this key; false when there is none.
      // resume vs fresh is handled inside spawnForPersona (SR-1.4
      // collision-then-act). The cwd and session-id arguments from the legacy
      // restart deps are ignored — the persona carries its working directory
      // and AD owns the resume state, not CSCB.
      return await launchSession(key, personaConfig)
    },
    getRestartDelay: () => routingConfig?.session_restart_delay ?? 60,
    isShuttingDown: () => shuttingDown,
    // The persona's restart-cap notice (SR-25.3), built in the session manager.
    onCapReached: (key) => notifyRestartCapReached(key),
  })

  // b.av2 SR-6.3: the start sweep, BEFORE the trust patch and any spawn.
  // `service=cscb` spawns with no `persona` label, a persona absent from the
  // applied config, an instance ID other than `cscb_<key>` or a `cwd` other
  // than the persona's working directory get killed + deleted.
  if (personaConfig) {
    try {
      await reconcileOrphans(personaConfig)
    } catch (err) {
      console.error('[slack] Warning: orphan reconciliation failed:', err)
    }
  }

  // b.uhv / b.k54 / b.av2 SR-6.2: patch .claude.json for every applied
  // persona's working directory so the trust dialog and project onboarding are
  // pre-accepted before any spawn fires (the pre-launch patcher repeats it per
  // launch). Runs for both real and dry-run modes (config-file patch, not a
  // session operation).
  if (personaConfig) {
    await trustBootstrap(personaConfig)
  }

  // b.zak: preventative JSONL-persistence safeguard. Detect non-persistent
  // storage roots (Layer 1) and personas whose transcript would be treated as
  // missing on resume (Layer 2) and say so LOUDLY, BEFORE startupSessionManager
  // runs the resume path that silently deletes+fresh-spawns on ErrJsonlMissing.
  // Runs over the applied personas. Awaited but wrapped so a rejection can
  // never kill startup. Its notices go through the per-persona notifier, which
  // only logs them in dry run.
  if (personaConfig) {
    try {
      await runJsonlPersistenceSafeguard(personaConfig, personaNotifier.notify)
    } catch (err) {
      console.error('[slack] Warning: jsonl-persistence safeguard failed — continuing:', err)
    }
  }

  // b.osj: install (or remove) the CSCB-managed Stop hook in each applied
  // persona's effective claude_config_dir settings.json before any spawn
  // fires. Runs for both real and dry-run modes (config-file patch, not a
  // session operation). Never throws — per-dir failures are recorded via
  // recordStartupError.
  if (personaConfig) {
    stopHookBootstrap(personaConfig)
  }

  // Per-persona reconcile via library: spawnForPersona dispatches fresh-spawn or
  // collision-handling per SR-1.4, once per persona. Failures raise a notice to
  // the persona's destination; the server stays up.
  if (personaConfig) {
    try {
      await startupSessionManager(personaConfig)
    } catch (err) {
      console.error('[slack] Warning: session startup failed — continuing:', err)
    }
  }

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
    isAtCap: (key) => backoffIsAtCap(key, RESTART_FAILURE_CAP),
    statRoute: _buildStatRouteImpl(),
    scheduleRestart,
    isShuttingDown: () => shuttingDown,
    // One entry per applied persona: key → working directory.
    getPersonas: () => (personaConfig ? buildPersonaWorkList(personaConfig) : {}),
  })

  if (routingConfig) {
    // INVARIANT: Health check starts only after startupSessionManager() returns.
    // Promise.allSettled ensures all launches have settled before this point.
    // Do not move this call earlier in the startup sequence.
    startHealthCheck(routingConfig.health_check_interval)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[slack] Fatal:', err)
    process.exit(1)
  })
}
