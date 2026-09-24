#!/usr/bin/env bun
/**
 * Slack Channel for Claude Code
 *
 * Two-way Slack ↔ Claude Code bridge via Socket Mode + MCP HTTP (StreamableHTTP).
 * Security: gate layer, outbound gate, file exfiltration guard, prompt hardening.
 *
 * Multi-session routing: each Claude Code session connects to its own MCP Server
 * instance, assigned to a Slack channel via routing config. Inbound Slack messages
 * are dispatched to the session whose channel matches; outbound tool calls are
 * scoped to channels that session has received messages from.
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
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  renameSync,
  promises as fsPromises,
} from 'fs'

import {
  defaultAccess,
  pruneExpired,
  assertSendable as libAssertSendable,
  assertOutboundAllowed as libAssertOutboundAllowed,
  gate as libGate,
  hasGetStreamKey,
  type Access,
  type GateResult,
} from './lib.ts'
import { loadConfig, expandTilde, type PersonaConfig, type RoutingConfig, MCP_SERVER_NAME } from './config.ts'
import { personaInstanceId } from './persona-identity.ts'
import { routesToPersonaConfig } from './route-persona-adapter.ts'
import {
  AGENT_DIRECTOR_LIVE_STATES,
  isLaunchInFlight,
  launchSession,
  notifyRestartCapReached,
  reconcileOrphans,
  reconnectMcp,
  setSessionNotifier,
  startupSessionManager,
  sweepDeadTmuxChannel,
} from './session-manager.ts'
import { createPersonaNotifier } from './persona-notifier.ts'
import { cleanSession, getCozempicAvailable } from './cozempic.ts'
import { ErrSpawnNotFound } from 'agent-director'
import { ErrSystemInstallDisappeared, ErrTmuxNotAvailable } from './agent-director-errors.ts'
import { getClient, closeClient } from './agent-director-client.ts'
import {
  emitBlockActionReceived,
  handlePermissionClick,
} from './permission-click-handler.ts'
import { trustBootstrap } from './trust-bootstrap.ts'
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
import { trackAck, consumeAck } from './ack-tracker.ts'
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
  getSessionByChannel,
  getSessionByCwd,
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
import { createCronScheduler, type CronScheduler } from './cron-scheduler.ts'
import { initOutageState, setOutageFlag, clearOutageFlag, resetAllToHealthy, withOutageDetection } from './outage-state.ts'

// Re-export constants so they stay in one place (lib.ts)
export { MAX_PENDING, MAX_PAIRING_REPLIES, PAIRING_EXPIRY_MS } from './lib.ts'

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

const { botToken, appToken } = loadTokens()

// ---------------------------------------------------------------------------
// Slack clients
// ---------------------------------------------------------------------------

const web = new WebClient(botToken)
const socket = new SocketModeClient({ appToken })

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
// Access control — load / save / prune
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

function saveAccess(access: Access): void {
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(access, null, 2), 'utf-8')
  chmodSync(tmp, 0o600)
  renameSync(tmp, ACCESS_FILE)
}

// ---------------------------------------------------------------------------
// Static mode
// ---------------------------------------------------------------------------

const STATIC_MODE = (process.env['SLACK_ACCESS_MODE'] || '').toLowerCase() === 'static'
let staticAccess: Access | null = null

if (STATIC_MODE) {
  staticAccess = loadAccess()
  pruneExpired(staticAccess)
  if (staticAccess.dmPolicy === 'pairing') {
    staticAccess.dmPolicy = 'allowlist'
  }
}

function getAccess(): Access {
  if (STATIC_MODE && staticAccess) return staticAccess
  const access = loadAccess()
  pruneExpired(access)
  return access
}

// ---------------------------------------------------------------------------
// Security — assertSendable (file exfiltration guard)
// ---------------------------------------------------------------------------

function assertSendable(filePath: string): void {
  libAssertSendable(filePath, resolve(STATE_DIR), resolve(INBOX_DIR))
}

// ---------------------------------------------------------------------------
// Security — outbound gate (per-session deliveredChannels)
//
// Task t2.c1r.zk.qm: each session has its own deliveredChannels Set.
// Tool handlers call this with the session's own set, not a global one.
// ---------------------------------------------------------------------------

function assertOutboundAllowed(chatId: string, deliveredChannels: Set<string>): void {
  libAssertOutboundAllowed(chatId, getAccess(), deliveredChannels)
}

// ---------------------------------------------------------------------------
// Gate function
// ---------------------------------------------------------------------------

async function gate(event: unknown): Promise<GateResult> {
  const routeChannels = routingConfig
    ? new Set(Object.keys(routingConfig.routes))
    : undefined
  return libGate(event, {
    access: getAccess(),
    staticMode: STATIC_MODE,
    saveAccess,
    botUserId,
    routeChannels,
  })
}

// ---------------------------------------------------------------------------
// Resolve user display name
// ---------------------------------------------------------------------------

const userNameCache = new Map<string, string>()

async function resolveUserName(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!
  try {
    const res = await web.users.info({ user: userId })
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

// ---------------------------------------------------------------------------
// Tool dependencies shared by all session servers
// ---------------------------------------------------------------------------

const sessionToolDeps: SessionToolDeps = {
  assertOutboundAllowed,
  assertSendable,
  getAccess,
  web,
  botToken,
  inboxDir: INBOX_DIR,
  resolveUserName,
  consumeAck,
  serverPort: 0, // updated to actual port in main() before Bun.serve
}

// ---------------------------------------------------------------------------
// Pending session factory
//
// Creates a Transport + Server pair for an init request before the session's
// route is known. The session is held in the pending map until roots/list
// resolves the CWD to a route.
// ---------------------------------------------------------------------------

function initPendingSession(): { pendingId: string; transport: WebStandardStreamableHTTPServerTransport } {
  const pendingId = crypto.randomUUID()

  // Empty deliveredChannels set — shared by reference with SessionEntry on promotion
  const deliveredChannels = new Set<string>()

  // Stub entry for createSessionServer to close over deliveredChannels.
  // cwd/channelId are placeholders; tools only use deliveredChannels.
  const entryStub: SessionEntry = {
    cwd: '',
    channelId: '',
    transport: null as unknown as WebStandardStreamableHTTPServerTransport,
    server: null as unknown as import('@modelcontextprotocol/sdk/server/index.js').Server,
    deliveredChannels,
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
        console.error(`[slack] Session disconnected: pending (not yet routed)`)
        return
      }
      const channelId = unregisterByMcpSessionId(mcpSessionId)
      if (channelId) {
        const cwd = routingConfig?.routes[channelId]?.cwd
        if (cwd) {
          console.error(`[slack] Session disconnected: channel=${channelId} cwd="${cwd}"`)
          // Session-id resume is now owned by agent-director (SR-1.3); the
          // sessionId arg to scheduleRestart is retained for API stability
          // but ignored by launchSession.
          scheduleRestart(channelId, cwd)
        } else {
          console.error(`[slack] Session disconnected: channel=${channelId}`)
        }
      }
    },
  })

  entryStub.transport = transport
  startSseKeepAlive(transport)

  // Build the MCP server (closes over entryStub.deliveredChannels)
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
  createPendingSession(pendingId, transport, server, deliveredChannels, entryStub)

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
// client, normalizes the CWD, and matches against the routing config.
// On match: promotes the pending session to registered.
// On no match or error: disconnects the session.
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
  const normalizedCwd = resolve(expandTilde(rawCwd))

  if (!routingConfig) {
    console.error(`[slack] No routing config — disconnecting pending session "${pendingId}" (CWD: "${normalizedCwd}")`)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  // Find the route whose cwd matches (exact after normalization)
  const matchedChannelId = Object.entries(routingConfig.routes).find(
    ([, route]) => resolve(expandTilde(route.cwd)) === normalizedCwd,
  )?.[0]

  if (!matchedChannelId) {
    console.error(`[slack] Session connected with CWD "${normalizedCwd}" — no matching route`)
    const pending = getPendingSession(pendingId)
    if (pending) {
      removePendingSession(pendingId)
      try { await pending.transport.close() } catch { /* ignore */ }
    }
    return
  }

  const existingSession = getSessionByCwd(normalizedCwd)

  // Promote pending → registered (removes from pendingSessionMap internally)
  registerSession(normalizedCwd, matchedChannelId, pendingId)

  // Register MCP session ID for future HTTP request routing
  registerMcpSessionId(pendingId, matchedChannelId)

  if (existingSession) {
    console.error(`[slack] Session replaced existing connection for CWD "${normalizedCwd}"`)
  }
  console.error(`[slack] Session connected: channel=${matchedChannelId} cwd="${normalizedCwd}"`)
}

// ---------------------------------------------------------------------------
// Inbound message handler
//
// Task t2.c1r.zk.3d: Route inbound Slack messages to the correct session.
// ---------------------------------------------------------------------------

async function handleMessage(event: unknown): Promise<void> {
  const result = await gate(event)
  const ev = event as Record<string, unknown>

  switch (result.action) {
    case 'drop':
      console.error(`[slack] Gate dropped message from channel=${ev['channel']} user=${ev['user']}`)
      return

    case 'pair': {
      const msg = result.isResend
        ? `Your pairing code is still: *${result.code}*\nAsk the Claude Code user to run: \`/slack-channel:access pair ${result.code}\``
        : `Hi! I need to verify you before connecting.\nYour pairing code: *${result.code}*\nAsk the Claude Code user to run: \`/slack-channel:access pair ${result.code}\``

      await web.chat.postMessage({
        channel: ev['channel'] as string,
        text: msg,
        unfurl_links: false,
        unfurl_media: false,
      })
      return
    }

    case 'deliver': {
      const channelId = ev['channel'] as string
      const isDm = ev['channel_type'] === 'im'

      let targetSession: SessionEntry | undefined

      if (isDm) {
        // -----------------------------------------------------------------------
        // Task t2.c1r.3i.gp — DM deliver: route to default_dm_session
        // Task t2.c1r.3i.bo — Add DM channel to that session's deliveredChannels
        // -----------------------------------------------------------------------
        if (!routingConfig?.default_dm_session) {
          // No DM session configured — drop silently
          console.error(
            `[slack] DM from channel ${channelId} but no default_dm_session configured — dropping`,
          )
          return
        }

        targetSession = getSessionByCwd(routingConfig.default_dm_session)

        if (!targetSession || !targetSession.connected) {
          console.error(
            `[slack] DM session for CWD "${routingConfig.default_dm_session}" not live — dropping message`,
          )
          return
        }

        // Task t2.c1r.3i.bo — add DM channel ID to that session's deliveredChannels
        targetSession.deliveredChannels.add(channelId)
      } else {
        // -----------------------------------------------------------------------
        // Task t2.c1r.zk.3d — Find the session for this channel
        // -----------------------------------------------------------------------
        targetSession = routingConfig
          ? getSessionByChannel(channelId)
          : undefined

        // If no direct match, check default_route
        if (!targetSession && routingConfig?.default_route && !routingConfig.routes[channelId]) {
          targetSession = getSessionByCwd(routingConfig.default_route)
        }

        if (!targetSession || !targetSession.connected) {
          // No live session for this channel
          console.error(
            `[slack] No live session for channel ${channelId} — dropping message`,
          )
          // b.kvq: recover a dead/capped route on an explicit inbound message.
          // Determine the configured cwd for this channel AND the channel that
          // OWNS the session on that cwd. A channel is "configured" if it has a
          // direct route OR falls under default_route (same precedence used
          // above when resolving targetSession).
          //
          // Recovery must be keyed to the OWNING channel, not the inbound one:
          // the spawn's instance id + tmux name derive from the persona key
          // (the channelId under the route->persona adapter), and the restart
          // guards/backoff are keyed by channelId. For a direct route the
          // owning channel IS the inbound channel. For default_route the
          // session is owned by the direct route whose cwd === default_route
          // (config.ts guarantees such a route exists — default_route must
          // match a defined route CWD, and CWDs are unique per channel).
          // Keying to the inbound channel there would spawn a SECOND instance
          // on the shared cwd and its guards could not see the owning
          // session's in-flight restart or cap state.
          const directRoute = routingConfig?.routes[channelId]
          let cwd: string | undefined
          let ownerChannelId: string | undefined
          if (directRoute) {
            cwd = directRoute.cwd
            ownerChannelId = channelId
          } else if (routingConfig?.default_route && !routingConfig.routes[channelId]) {
            cwd = routingConfig.default_route
            // Resolve the direct route that owns the session on default_route.
            for (const [ownerId, route] of Object.entries(routingConfig.routes)) {
              if (route.cwd === cwd) {
                ownerChannelId = ownerId
                break
              }
            }
            // If no owning route is found (should be impossible per config
            // validation), drop silently rather than schedule under the inbound
            // channelId and spawn a duplicate/unrecoverable instance.
            if (!ownerChannelId) {
              cwd = undefined
            }
          }

          if (cwd && ownerChannelId) {
            // The dropped message itself is lost — recovery only starts a
            // session; it does NOT deliver or replay this message. The reply
            // below must never imply otherwise.
            const alreadyRestarting = isRestartPendingOrActive(ownerChannelId)
            const autoRestartDisabled = (routingConfig?.session_restart_delay ?? 60) === 0
            const capped = backoffIsAtCap(ownerChannelId, RESTART_FAILURE_CAP)

            let replyText: string
            if (alreadyRestarting) {
              // A restart is already pending/active — do not stack a second
              // launch. Telling the sender to retry shortly is honest here.
              replyText =
                'Your message was not delivered. The session is restarting — please retry in a moment.'
            } else if (autoRestartDisabled) {
              // getRestartDelay()===0: auto-restart is off. scheduleRestart
              // would early-return, so do not pretend recovery is underway.
              replyText =
                'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ' +
                'so it will NOT recover on its own — an operator must restart the server.'
            } else if (capped) {
              // At the consecutive-failure cap: firing another launch would only
              // burn a spawn attempt against a route that cannot come up (the cap
              // exists precisely to stop that), and in-process backoff clears only
              // on a server restart. Bound the human trigger here rather than
              // spawn-looping, and say so plainly.
              replyText =
                'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ' +
                'and will NOT recover on its own — an operator must restart the server.'
            } else {
              // Live route, no session, under cap, auto-restart enabled: trigger
              // a fast human-clamped recovery. This message is still lost.
              scheduleRestart(ownerChannelId, cwd, undefined, { humanTrigger: true })
              replyText =
                'Your message was not delivered and was not saved. I have started the session for this channel — ' +
                'please retry in a moment.'
            }

            try {
              await web.chat.postMessage({ channel: channelId, text: replyText })
            } catch { /* non-critical */ }
          }
          return
        }

        // -----------------------------------------------------------------------
        // Task t2.c1r.zk.qm — Add channel to session's deliveredChannels
        // -----------------------------------------------------------------------
        targetSession.deliveredChannels.add(channelId)
      }

      const access = result.access!
      const userName = await resolveUserName(ev['user'] as string)

      // Ack reaction
      if (access.ackReaction) {
        try {
          await web.reactions.add({
            channel: channelId,
            timestamp: ev['ts'] as string,
            name: access.ackReaction,
          })
        } catch { /* non-critical */ }
        trackAck(channelId, ev['ts'] as string)
      }

      // Build meta attributes for the <channel> tag
      const meta: Record<string, string> = {
        chat_id: channelId,
        message_id: ev['ts'] as string,
        user: userName,
        ts: ev['ts'] as string,
      }

      if (ev['thread_ts']) {
        meta.thread_ts = ev['thread_ts'] as string
      }

      const evFiles = ev['files'] as any[] | undefined
      if (evFiles?.length) {
        const { sanitizeFilename } = await import('./lib.ts')
        const fileDescs = evFiles.map((f: any) => {
          const name = sanitizeFilename(f.name || 'unnamed')
          return `${name} (${f.mimetype || 'unknown'}, ${f.size || '?'} bytes)`
        })
        meta.attachment_count = String(evFiles.length)
        meta.attachments = fileDescs.join('; ')
      }

      // Strip bot mention from text if present
      let text = (ev['text'] as string | undefined) || ''
      if (botUserId) {
        text = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()
      }

      // Dispatch to the session's Server instance
      const transport = targetSession.transport as any
      const hasGetStream = hasGetStreamKey(transport)
      const mcpSessionId = targetSession.transport.sessionId ?? '(unset)'
      console.error(
        `[slack] Dispatching to session cwd="${targetSession.cwd}" channel=${channelId} ` +
        `mcpSessionId=${mcpSessionId} hasGetStream=${hasGetStream} ` +
        `connected=${targetSession.connected} text="${text.slice(0, 80)}"`
      )
      if (!hasGetStream) {
        // b.9cj: the registry says connected but the SDK has silently dropped
        // the standalone GET SSE stream, so notification() would evaporate with
        // no throw and no return value. Do NOT send it — the message provably
        // cannot reach the bot. Trigger recovery (which now actually fires:
        // restart.ts no longer waves a connected-but-streamless session through
        // as "already reconnected"), and give the sender the same honest
        // "not delivered" reply a disconnected session gets on the b.kvq path.
        console.error(
          `[slack] DROP: no _GET_stream for cwd="${targetSession.cwd}" channel=${channelId} ` +
          `mcpSessionId=${mcpSessionId} — message will not reach the bot; triggering recovery`
        )

        // Recovery is keyed to the OWNING channel of the session, not the
        // inbound channel. targetSession may have been resolved via
        // default_route (getSessionByCwd) or the DM default_dm_session path, in
        // which case channelId is not the owner. The instance id, tmux naming,
        // backoff, and the pending/cap guards are all keyed by the owning
        // channelId (the persona key under the route->persona adapter), so
        // scheduling under the inbound channel could spawn a duplicate
        // instance on a shared cwd and miss the owner's in-flight restart/cap
        // state. The reply below stays on the inbound channelId.
        const ownerChannelId = targetSession.channelId
        const alreadyRestarting = isRestartPendingOrActive(ownerChannelId)
        const autoRestartDisabled = (routingConfig?.session_restart_delay ?? 60) === 0
        const capped = backoffIsAtCap(ownerChannelId, RESTART_FAILURE_CAP)

        let replyText: string
        if (alreadyRestarting) {
          // A restart is already pending/active — do not stack a second launch.
          replyText =
            'Your message was not delivered. The session is restarting — please retry in a moment.'
        } else if (autoRestartDisabled) {
          // getRestartDelay()===0: auto-restart is off. scheduleRestart would
          // early-return, so do not pretend recovery is underway.
          replyText =
            'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ' +
            'so it will NOT recover on its own — an operator must restart the server.'
        } else if (capped) {
          // At the consecutive-failure cap: firing another launch would only
          // burn a spawn attempt against a route that cannot come up. Bound the
          // human trigger here rather than spawn-looping, and say so plainly.
          replyText =
            'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ' +
            'and will NOT recover on its own — an operator must restart the server.'
        } else {
          // Live session, streamless, under cap, auto-restart enabled: trigger a
          // fast human-clamped recovery. This message is still lost.
          scheduleRestart(ownerChannelId, targetSession.cwd, undefined, { humanTrigger: true })
          replyText =
            'Your message was not delivered. The session is restarting — please retry in a moment.'
        }

        try {
          await web.chat.postMessage({ channel: channelId, text: replyText })
        } catch { /* non-critical */ }
        return
      }
      targetSession.server.notification({
        method: 'notifications/claude/channel',
        params: { content: text, meta },
      })
    }
  }
}

// Permission Block Kit builders moved to src/permission-poller.ts
// (SR-2.1/2.2 — owns the message + action_id encoding).

// ---------------------------------------------------------------------------
// Socket Mode event routing
// ---------------------------------------------------------------------------

socket.on('message', async ({ event, ack }) => {
  console.error('[slack] RAW message event:', JSON.stringify(event)?.slice(0, 300))
  await ack()
  if (!event) return
  archiveInboundMessage(event)
  try {
    await handleMessage(event)
  } catch (err) {
    console.error('[slack] Error handling message:', err)
  }
})

socket.on('app_mention', async ({ event, ack }) => {
  console.error('[slack] RAW app_mention event:', JSON.stringify(event)?.slice(0, 300))
  await ack()
  if (!event) return
  archiveInboundMessage(event)
  try {
    await handleMessage(event)
  } catch (err) {
    console.error('[slack] Error handling mention:', err)
  }
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

    const handled = await handlePermissionClick(
      actionId,
      { web },
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
 * persona-keyed consumers (startup spawns, restart launch, liveness probe).
 */
let personaConfig: PersonaConfig | null = null

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
  getPersona: (key) => personaConfig?.personas.find((p) => p.key === key),
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
//                            session and resolves the route via roots/list
//   GET/POST/DELETE /mcp   — subsequent requests (Mcp-Session-Id header required)
//   *                      — 404 for all other paths
//
// All Claude Code sessions point to the same URL: http://<host>:<port>/mcp
// Route assignment happens after the MCP initialized notification when the
// server calls roots/list and matches the CWD against config.json.
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
    routingConfig = loadConfig()
    personaConfig = routesToPersonaConfig(routingConfig)
    mcpHost = routingConfig.bind
    mcpPort = routingConfig.port
    const routeCount = Object.keys(routingConfig.routes).length
    console.error(`[slack] Loaded routing config: ${routeCount} route(s)`)

    // SR-3.2: refresh the slack-channel-bot agent-director template on every
    // boot. Atomic replacement via Client.makeTemplate(..., overwrite: true)
    // gives us "ensure post-state" semantics. Fatal startup error on failure.
    await installSlackChannelBotTemplate(routingConfig)

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
    // state for spawns in check_permission and posts Block Kit prompts.
    if (routingConfig) {
      startPermissionPoller({
        getClient,
        web,
        intervalMs: routingConfig.agent_director_poll_interval_ms,
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
      // /interject — inject a message into an active session from localhost
      // -----------------------------------------------------------------------
      if (url.pathname === '/interject') {
        if (req.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
        }
        const remoteAddr = server.requestIP(req)
        const remoteHost = remoteAddr?.address ?? ''
        if (remoteHost !== '127.0.0.1' && remoteHost !== '::1' && !remoteHost.startsWith('::ffff:127.')) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
        }

        const bodyText = await req.text()
        if (new TextEncoder().encode(bodyText).byteLength > 32768) {
          return new Response(JSON.stringify({ error: 'Request body too large (max 32KB)' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        let body: { channel?: unknown; message?: unknown; sender?: unknown }
        try {
          body = JSON.parse(bodyText)
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const { channel, message, sender } = body
        if (typeof channel !== 'string' || !channel) {
          return new Response(
            JSON.stringify({ error: 'Missing or invalid field: channel (string) required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (typeof message !== 'string' || !message) {
          return new Response(
            JSON.stringify({ error: 'Missing or invalid field: message (string) required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        // Check if the channel exists in routing config
        const route = routingConfig?.routes[channel]
        if (!route) {
          return new Response(
            JSON.stringify({ error: 'Channel not found in routing config' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }

        // Check if a session is connected for this channel
        const targetSession = getSessionByChannel(channel)
        if (!targetSession || !targetSession.connected) {
          return new Response(
            JSON.stringify({ error: 'No active session for this channel' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const senderLabel = typeof sender === 'string' && sender ? sender : 'interject'
        const ts = String(Date.now() / 1000)
        const meta: Record<string, string> = {
          chat_id: channel,
          message_id: ts,
          user: senderLabel,
          ts,
        }

        console.error(`[slack] /interject: delivering to session cwd="${targetSession.cwd}" channel=${channel} sender="${senderLabel}" message="${message.slice(0, 80)}"`)
        targetSession.server.notification({
          method: 'notifications/claude/channel',
          params: { content: message, meta },
        })

        return new Response(JSON.stringify({ ok: true, channel, cwd: targetSession.cwd }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
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
        if (entry !== null && 'channelId' in entry) {
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
            const channelId = unregisterByMcpSessionId(mcpSessionId)
            if (!channelId) return

            const cwd = routingConfig?.routes[channelId]?.cwd
            if (cwd) {
              console.error(`[slack] Session disconnected (SSE abort): channel=${channelId} cwd="${cwd}"`)
              scheduleRestart(channelId, cwd)
            } else {
              console.error(`[slack] Session disconnected (SSE abort): channel=${channelId}`)
            }
          })
        }

        return (entry as NonNullable<typeof entry>).transport.handleRequest(req)
      }

      // --- Init request: no Mcp-Session-Id ---
      // Create a pending session; route resolved after roots/list in handleInitialized()
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

  // b.9cj: shared stream-presence probe. A session can be `connected === true`
  // in the registry while the SDK has silently deleted its `_GET_stream` map
  // entry, in which state messages cannot reach the bot. Both the restart guard
  // and the health-check tick consult this alongside isSessionConnected so a
  // connected-but-streamless session is treated as unhealthy, not "healed".
  // Factored here so the two dep objects below stay in exact agreement.
  // Registry lookups take the persona key: the channel ID under the
  // route->persona adapter, until E3 Task 5 re-keys the registry.
  const hasSessionStreamAdapter = (key: string): boolean => {
    const session = getSessionByChannel(key)
    return session ? hasGetStreamKey(session.transport) : false
  }

  // Initialize restart module with library-backed adapters. Every key is a
  // persona key.
  initRestart({
    isSessionAlive: isSessionAliveAdapter,
    isSessionConnected: (key) => {
      const session = getSessionByChannel(key)
      return session?.connected === true
    },
    hasSessionStream: hasSessionStreamAdapter,
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

  // b.uhv / b.k54: patch .claude.json for every routed cwd so the trust dialog
  // and project onboarding are pre-accepted before any spawn fires. Runs for
  // both real and dry-run modes (config-file patch, not a session operation).
  if (routingConfig) {
    await trustBootstrap(routingConfig)
  }

  // b.zak: preventative JSONL-persistence safeguard. Detect non-persistent
  // storage roots (Layer 1) and personas whose transcript would be treated as
  // missing on resume (Layer 2) and say so LOUDLY, BEFORE startupSessionManager
  // runs the resume path that silently deletes+fresh-spawns on ErrJsonlMissing.
  // Awaited but wrapped so a rejection can never kill startup. Its notices go
  // through the per-persona notifier, which only logs them in dry run.
  if (routingConfig) {
    try {
      await runJsonlPersistenceSafeguard(routingConfig, personaNotifier.notify)
    } catch (err) {
      console.error('[slack] Warning: jsonl-persistence safeguard failed — continuing:', err)
    }
  }

  // b.osj: install (or remove) the CSCB-managed Stop hook in each effective
  // claude_config_dir's settings.json before any spawn fires. Runs for both
  // real and dry-run modes (config-file patch, not a session operation).
  // Never throws — per-dir failures are recorded via recordStartupError.
  if (routingConfig) {
    stopHookBootstrap(routingConfig)
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
      const session = getSessionByChannel(key)
      return session?.connected === true
    },
    // b.9cj: same stream-presence probe wired into initRestart above, so the
    // tick can notice connected-but-streamless rows and route them to recovery.
    hasSessionStream: hasSessionStreamAdapter,
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
