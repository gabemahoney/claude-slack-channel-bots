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
} from 'fs'

import {
  defaultAccess,
  pruneExpired,
  assertSendable as libAssertSendable,
  assertOutboundAllowed as libAssertOutboundAllowed,
  gate as libGate,
  type Access,
  type GateResult,
} from './lib.ts'
import { loadConfig, expandTilde, type RoutingConfig, MCP_SERVER_NAME } from './config.ts'
import { recordStartupError } from './startup-errors.ts'
import {
  status as cliStatus,
  kill as cliKill,
  deleteSpawn as cliDeleteSpawn,
  get as cliGet,
  decide as cliDecide,
} from './claude-director-cli.ts'
import {
  initPermissionPoller,
  startPermissionPoller,
  stopPermissionPoller,
  markFinalized,
  getLivePrompt,
  dropLivePrompt,
} from './permission-poller.ts'
import { handlePermissionClick, type PermissionClickDeps } from './permission-click-handler.ts'
import {
  startupSessionManager,
  reconcileOrphans,
  flushSpawnFailureQueue,
  spawnForRoute,
  reconnectMcp,
  CLAUDE_DIRECTOR_LIVE_STATES,
} from './session-manager.ts'
import {
  initRestart,
  scheduleRestart,
  resetFailureCounter,
  cancelAllRestartTimers,
  isRestartPendingOrActive,
  hasReachedMaxFailures,
} from './restart.ts'
import { initHealthCheck, startHealthCheck, stopHealthCheck } from './health-check.ts'
import { loadTokens, isDryRun } from './tokens.ts'
import { bootstrapTrust } from './trust-bootstrap.ts'
import { writeTemplate } from './claude-director-template.ts'
import { checkPidConflict, writePidFile, removePidFile } from './pid.ts'
import { runStartupGates } from './claude-director-probe.ts'
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

// Re-export constants so they stay in one place (lib.ts)
export { MAX_PENDING, MAX_PAIRING_REPLIES, PAIRING_EXPIRY_MS } from './lib.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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

  // Reset failure counter — session reconnected successfully
  resetFailureCounter(matchedChannelId)
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
          // If the channel has a route but no registered session, notify the sender
          if (routingConfig?.routes[channelId]) {
            try {
              await web.chat.postMessage({
                channel: channelId,
                text: 'Message not delivered — session starting up, please retry in a moment.',
              })
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
      console.error(`[slack] Dispatching to session cwd="${targetSession.cwd}" channel=${channelId} text="${text.slice(0, 80)}"`)
      targetSession.server.notification({
        method: 'notifications/claude/channel',
        params: { content: text, meta },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Block Kit builders — permission request messages
// ---------------------------------------------------------------------------

function buildPermissionBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  claudeInstanceId: string,
  requestId: string,
): any[] {
  let summary: string
  if (toolName === 'Bash') {
    summary = '`' + String(toolInput['command'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else if (toolName === 'Edit' || toolName === 'Write') {
    summary = '`' + String(toolInput['file_path'] ?? JSON.stringify(toolInput).slice(0, 500)) + '`'
  } else {
    const raw = JSON.stringify(toolInput)
    summary = '`' + (raw.length > 500 ? raw.slice(0, 500) + '…' : raw) + '`'
  }

  // SR-2.3: action_id format is perm_<allow|deny>_<claudeInstanceId>_<requestId>.
  // requestId is always a string — NEVER coerced through Number.
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🤖🛠️ *${toolName}*\n${summary}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: `perm_allow_${claudeInstanceId}_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: `perm_deny_${claudeInstanceId}_${requestId}`,
        },
      ],
    },
  ]
}

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

  // Build deps once per event (web is module-level; poller fns imported at top).
  const clickDeps: PermissionClickDeps = {
    getLivePrompt,
    markFinalized,
    dropLivePrompt,
    cliGet,
    cliDecide,
    chatUpdate: (params) => web.chat.update(params).then(() => {}),
    chatPostMessage: (params) => web.chat.postMessage(params).then(() => {}),
    resolveUserName,
  }

  for (const action of actions) {
    const actionId = action.action_id

    // ---------------------------------------------------------------------------
    // New claude-director permission branch (SR-2.2 / E4)
    // Delegates to handlePermissionClick (extracted for testability).
    // ---------------------------------------------------------------------------
    const userId = ((p['user'] as Record<string, unknown> | undefined)?.['id'] as string | undefined) ?? ''
    const result = await handlePermissionClick(clickDeps, actionId, userId)
    if (result === 'handled' || result === 'malformed') {
      await ack()
      continue
    }
    // result === 'not-permission' → fall through to other handlers
  }
  await ack()
})

// ---------------------------------------------------------------------------
// Routing config
// ---------------------------------------------------------------------------

let routingConfig: RoutingConfig | null = null

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
let httpServer: ReturnType<typeof Bun.serve> | null = null

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stopHealthCheck()
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

  stopPermissionPoller()

  console.error('[slack] Disconnecting Socket Mode')
  try {
    await socket.disconnect()
  } catch { /* ignore */ }

  removePidFile(PID_FILE)

  console.error('[slack] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })

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
  // Run startup gates in order: dep-probe (CE1) → state.db same-user (CE2) → checkPidConflict.
  // These run before any disruptive side effects (sessions.json rotation, Socket Mode connect,
  // PID file write). A missing or broken claude-director binary exits here with a clear message.
  runStartupGates({ checkPidConflict, pidFile: PID_FILE })

  let mcpHost: string
  let mcpPort: number

  try {
    routingConfig = loadConfig()
    mcpHost = routingConfig.bind
    mcpPort = routingConfig.port
    const routeCount = Object.keys(routingConfig.routes).length
    console.error(`[slack] Loaded routing config: ${routeCount} route(s)`)

    // Initialize permission poller with Slack posting deps (SR-2.1).
    // Started after socket.start() below so we have a live Slack connection.
    initPermissionPoller({
      pollIntervalMs: routingConfig.claude_director_poll_interval_ms,
      async postPermissionMessage(channelId, toolName, toolInput, claudeInstanceId, requestId) {
        const blocks = buildPermissionBlocks(toolName, toolInput, claudeInstanceId, requestId)
        const postResult = await web.chat.postMessage({
          channel: channelId,
          text: `Permission request: ${toolName}`,
          blocks,
        })
        return postResult.ts as string
      },
      async expirePermissionMessage(channelId, messageTs, toolName) {
        await web.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `${toolName} — expired (no decision)`,
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${toolName}* — ⏱️ expired (no decision made)`,
            },
          }],
        })
      },
    })

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('cannot read routing config')) {
      console.error(
        `[slack] Warning: no routing config found — falling back to env vars (MCP_HOST/MCP_PORT)`,
      )
      mcpHost = process.env['MCP_HOST'] ?? '127.0.0.1'
      mcpPort = Number(process.env['MCP_PORT'] ?? 3100)
    } else {
      // Fatal config-validation failure at startup: record to startup-errors.log (T-A module),
      // then exit non-zero. recordStartupError never throws or exits — exit decision stays here.
      recordStartupError('config-validation', msg, err)
      console.error(`[slack] Fatal: routing config error — ${msg}`)
      process.exit(1)
    }
  }

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

    // Start the claude-director permission poller now that Socket Mode is live (SR-2.1).
    startPermissionPoller()

    // Drain any spawn failure notifications queued before auth completed.
    flushSpawnFailureQueue(web)
  }

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
      console.error(`[slack] HTTP ${req.method} ${url.pathname} session=${mcpSid ?? '(none)'}`)

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

  // Shared adapter: calls claude-director status to determine if a spawn is alive.
  const isSessionAliveAdapter = async (channelId: string): Promise<boolean> => {
    if (!routingConfig?.routes[channelId]) return false
    try {
      const result = cliStatus({ channelId })
      if (result.ok) {
        const { state } = result.data
        if ((CLAUDE_DIRECTOR_LIVE_STATES as Set<string>).has(state)) return true
        if (state === 'ended' || state === 'missing') return false
        // Unexpected state
        console.error(`[slack] isSessionAlive: unexpected state '${state}' for channel=${channelId} — treating as dead`)
        return false
      }
      if (result.error.kind === 'ErrSpawnNotFound') return false
      console.error(`[slack] isSessionAlive: status error for channel=${channelId}: ${result.error.kind} — treating as dead`)
      return false
    } catch (err) {
      console.error(`[slack] isSessionAlive: unexpected throw for channel=${channelId}:`, err)
      return false
    }
  }

  // Initialize restart module with adapters bridging claude-director + session-manager
  initRestart({
    isSessionAlive: isSessionAliveAdapter,
    isSessionConnected: (channelId) => {
      const session = getSessionByChannel(channelId)
      return session?.connected === true
    },
    reconnectSession: async (channelId) => {
      await reconnectMcp(channelId, isDryRun() ? undefined : web)
    },
    killSession: async (channelId) => {
      const killResult = cliKill({ channelId })
      if (!killResult.ok && killResult.error.kind !== 'ErrSpawnNotFound') {
        console.error(`[slack] killSession: kill failed for channel=${channelId}: ${killResult.error.kind}`)
      }
      const deleteResult = cliDeleteSpawn({ channelId })
      if (!deleteResult.ok && deleteResult.error.kind !== 'ErrSpawnNotFound') {
        console.error(`[slack] killSession: delete failed for channel=${channelId}: ${deleteResult.error.kind}`)
      }
    },
    launchSession: async (channelId, _cwd) => {
      if (!routingConfig) return false
      if (!routingConfig.routes[channelId]) return false
      const result = await spawnForRoute(channelId, routingConfig.routes[channelId], routingConfig, isDryRun() ? undefined : web, false)
      return result.action !== 'failed'
    },
    getRestartDelay: () => routingConfig?.session_restart_delay ?? 60,
    isShuttingDown: () => shuttingDown,
  })

  // Start up managed claude-director sessions for all configured routes.
  if (routingConfig) {
    // Write the claude-director template before trust bootstrap and session manager.
    // writeTemplate exits on failure via recordStartupError + process.exit(1).
    writeTemplate(routingConfig)

    // Reconcile orphan spawns BEFORE launching routes (E1).
    await reconcileOrphans(routingConfig)

    try {
      bootstrapTrust(routingConfig)
    } catch (err) {
      console.error('[slack] Warning: trust bootstrap failed — continuing without trust pre-acceptance:', err)
    }
    try {
      await startupSessionManager(routingConfig, undefined, isDryRun() ? undefined : web)
    } catch (err) {
      console.error('[slack] Warning: session startup failed — continuing without managed sessions:', err)
    }
  }

  // Initialize and start the health-check poller.
  initHealthCheck({
    isSessionAlive: isSessionAliveAdapter,
    isRestartPendingOrActive,
    hasReachedMaxFailures,
    scheduleRestart,
    isShuttingDown: () => shuttingDown,
    getRoutes: () => {
      if (!routingConfig) return {}
      return Object.fromEntries(
        Object.entries(routingConfig.routes).map(([channelId, route]) => [channelId, route.cwd]),
      )
    },
  })

  if (routingConfig) {
    // INVARIANT: Health check starts only after startupSessionManager() returns
    // and sessions.json is written. Promise.allSettled ensures all launches have
    // settled before this point. Do not move this call earlier in the startup sequence.
    startHealthCheck(routingConfig.health_check_interval)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[slack] Fatal:', err)
    process.exit(1)
  })
}
