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
import { readSessions, writeSessions } from './sessions.ts'
import { defaultTmuxClient, sessionName, isClaudeRunning } from './tmux.ts'
import { startupSessionManager, launchSession } from './session-manager.ts'
import {
  initRestart,
  scheduleRestart,
  resetFailureCounter,
  cancelAllRestartTimers,
  isRestartPendingOrActive,
  hasReachedMaxFailures,
} from './restart.ts'
import { initHealthCheck, startHealthCheck, stopHealthCheck } from './health-check.ts'
import { loadTokens } from './tokens.ts'
import { checkPidConflict, writePidFile, removePidFile } from './pid.ts'
import { trackAck, consumeAck } from './ack-tracker.ts'
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
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = process.env['SLACK_STATE_DIR'] || join(homedir(), '.claude', 'channels', 'slack')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'server.pid')

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
// Permission relay — pending request registry
// ---------------------------------------------------------------------------

interface PendingPermission {
  requestId: string
  channelId: string
  messageTs: string
  toolName: string
  waiters: Array<(decision: 'allow' | 'deny') => void>
}

const pendingPermissions = new Map<string, PendingPermission>()
const completedDecisions = new Map<string, 'allow' | 'deny'>()

// ---------------------------------------------------------------------------
// AskUserQuestion relay — pending question registry
// ---------------------------------------------------------------------------

interface PendingQuestion {
  requestId: string
  channelId: string
  messageTs: string
  question: string
  waiters: Array<(answer: string) => void>
}

const pendingQuestions = new Map<string, PendingQuestion>()
const completedAnswers = new Map<string, string>()

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
      // Session closed — clean up pending or registered state
      const pending = getPendingSession(mcpSessionId)
      if (pending) {
        removePendingSession(mcpSessionId)
        console.error(`[slack] Session disconnected: pending (not yet routed)`)
        return
      }
      const cwd = unregisterByMcpSessionId(mcpSessionId)
      if (cwd) {
        // Look up channelId by CWD — hook point for t1.uya.co (restart logic)
        const channelId = routingConfig
          ? Object.entries(routingConfig.routes).find(([, route]) => route.cwd === cwd)?.[0]
          : undefined
        if (channelId) {
          console.error(`[slack] Session disconnected: channel=${channelId} cwd="${cwd}"`)
          scheduleRestart(channelId, cwd, readSessions()[channelId]?.sessionId)
        } else {
          console.error(`[slack] Session disconnected: cwd="${cwd}"`)
        }
      }
    },
  })

  entryStub.transport = transport

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

  // Store as pending
  createPendingSession(pendingId, transport, server, deliveredChannels)

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
  registerMcpSessionId(pendingId, normalizedCwd)

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
          ? getSessionByChannel(channelId, routingConfig)
          : undefined

        // If no direct match, check default_route
        if (!targetSession && routingConfig?.default_route) {
          targetSession = getSessionByCwd(routingConfig.default_route)
        }

        if (!targetSession || !targetSession.connected) {
          // No live session for this channel
          console.error(
            `[slack] No live session for channel ${channelId} — dropping message`,
          )
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
          action_id: `perm_allow_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: `perm_deny_${requestId}`,
        },
      ],
    },
  ]
}

function buildPermissionDecisionBlocks(
  toolName: string,
  decision: 'allow' | 'deny',
  userName: string,
): any[] {
  const label = decision === 'allow' ? 'Allowed' : 'Denied'
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${toolName}* — ${label} by ${userName}`,
      },
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
  for (const action of actions) {
    const actionId = action.action_id
    if (actionId.startsWith('perm_allow_') || actionId.startsWith('perm_deny_')) {
      const isAllow = actionId.startsWith('perm_allow_')
      const prefix = isAllow ? 'perm_allow_' : 'perm_deny_'
      const requestId = actionId.slice(prefix.length)
      const pending = pendingPermissions.get(requestId)
      if (pending) {
        const decision: 'allow' | 'deny' = isAllow ? 'allow' : 'deny'
        completedDecisions.set(requestId, decision)
        for (const waiter of pending.waiters) waiter(decision)
        await ack()
        pendingPermissions.delete(requestId)

        // Update the Slack message to remove buttons and show the decision
        const userId = ((p['user'] as Record<string, unknown> | undefined)?.['id'] as string | undefined) ?? ''
        const userName = userId ? await resolveUserName(userId) : 'unknown'
        try {
          await web.chat.update({
            channel: pending.channelId,
            ts: pending.messageTs,
            text: `${pending.toolName} — ${decision === 'allow' ? 'Allowed' : 'Denied'} by ${userName}`,
            blocks: buildPermissionDecisionBlocks(pending.toolName, decision, userName),
          })
        } catch (err) {
          console.error('[slack] /permission: chat.update failed:', err)
        }
        return
      }
    }
    // Handle ask_ action IDs (AskUserQuestion relay)
    if (actionId.startsWith('ask_')) {
      // Format: ask_<requestId>_<optionIndex>
      const rest = actionId.slice('ask_'.length)
      const lastUnderscore = rest.lastIndexOf('_')
      if (lastUnderscore !== -1) {
        const requestId = rest.slice(0, lastUnderscore)
        const optionIndex = parseInt(rest.slice(lastUnderscore + 1), 10)
        const pending = pendingQuestions.get(requestId)
        if (pending) {
          // Get the button text as the answer
          const buttonText = (action as any).text?.text ?? `Option ${optionIndex + 1}`
          completedAnswers.set(requestId, buttonText)
          for (const waiter of pending.waiters) waiter(buttonText)
          await ack()
          pendingQuestions.delete(requestId)

          const userId = ((p['user'] as Record<string, unknown> | undefined)?.['id'] as string | undefined) ?? ''
          const userName = userId ? await resolveUserName(userId) : 'unknown'
          try {
            await web.chat.update({
              channel: pending.channelId,
              ts: pending.messageTs,
              text: `${pending.question} — "${buttonText}" selected by ${userName}`,
              blocks: [{
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `❓ *${pending.question}*\n✅ _"${buttonText}"_ — selected by ${userName}`,
                },
              }],
            })
          } catch (err) {
            console.error('[slack] /ask: chat.update failed:', err)
          }
          return
        }
      }
    }
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

  process.stderr.write(`[slack] Received ${signal} — shutting down\n`)

  if (httpServer) {
    process.stderr.write('[slack] Stopping HTTP server\n')
    httpServer.stop(true)
    httpServer = null
  }

  // Close all pending (not yet routed) MCP transports
  for (const pending of getAllPendingSessions()) {
    process.stderr.write('[slack] Closing pending MCP transport (not yet routed)\n')
    removePendingSession(pending.pendingId)
    try {
      await pending.transport.close()
    } catch { /* ignore */ }
  }

  // Close all active MCP transports
  for (const entry of getAllSessions()) {
    if (entry.connected) {
      process.stderr.write(
        `[slack] Closing MCP transport for CWD "${entry.cwd}"\n`,
      )
      try {
        await entry.transport.close()
      } catch { /* ignore */ }
      entry.connected = false
    }
  }

  process.stderr.write('[slack] Disconnecting Socket Mode\n')
  try {
    await socket.disconnect()
  } catch { /* ignore */ }

  removePidFile(PID_FILE)

  process.stderr.write('[slack] Shutdown complete\n')
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
// server calls roots/list and matches the CWD against routing.json.
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  checkPidConflict(PID_FILE)

  let mcpHost: string
  let mcpPort: number

  try {
    routingConfig = loadConfig()
    mcpHost = routingConfig.bind
    mcpPort = routingConfig.port
    const routeCount = Object.keys(routingConfig.routes).length
    console.error(`[slack] Loaded routing config: ${routeCount} route(s)`)
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

  // -------------------------------------------------------------------------
  // HTTP server — single /mcp endpoint, roots-based session identity
  // -------------------------------------------------------------------------

  httpServer = Bun.serve({
    hostname: mcpHost,
    port: mcpPort,
    idleTimeout: 255,
    async fetch(req: Request, server: { requestIP(r: Request): { address: string } | null }): Promise<Response> {
      const url = new URL(req.url)
      const mcpSid = req.headers.get('mcp-session-id')
      console.error(`[slack] HTTP ${req.method} ${url.pathname} session=${mcpSid ?? '(none)'}`)

      // -----------------------------------------------------------------------
      // /permission — permission relay endpoint (POST + GET long-poll)
      // -----------------------------------------------------------------------
      if (url.pathname === '/permission' || url.pathname.startsWith('/permission/')) {
        // Reject non-GET/POST methods on /permission paths
        if (req.method !== 'POST' && req.method !== 'GET') {
          return new Response('Method Not Allowed', { status: 405 })
        }

        // Validate request from localhost
        const remoteAddr = server.requestIP(req)
        const remoteHost = remoteAddr?.address ?? ''
        if (remoteHost !== '127.0.0.1' && remoteHost !== '::1' && !remoteHost.startsWith('::ffff:127.')) {
          return new Response('Forbidden', { status: 403 })
        }

        // GET /permission/<requestId> — long-poll for decision
        if (req.method === 'GET' && url.pathname.startsWith('/permission/')) {
          const pollRequestId = url.pathname.slice('/permission/'.length)

          // Already decided — return immediately
          const existingDecision = completedDecisions.get(pollRequestId)
          if (existingDecision !== undefined) {
            return new Response(JSON.stringify({ status: 'decided', decision: existingDecision }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          const pendingEntry = pendingPermissions.get(pollRequestId)

          // Unknown requestId — deny
          if (!pendingEntry) {
            return new Response(JSON.stringify({ status: 'decided', decision: 'deny' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          // Race 60s timeout vs waiter resolving
          const decision = await new Promise<'allow' | 'deny' | null>((promiseResolve) => {
            let settled = false
            let timerId: ReturnType<typeof setTimeout>

            const waiter = (d: 'allow' | 'deny') => {
              if (settled) return
              settled = true
              clearTimeout(timerId)
              promiseResolve(d)
            }

            pendingEntry.waiters.push(waiter)

            timerId = setTimeout(() => {
              if (settled) return
              settled = true
              const idx = pendingEntry.waiters.indexOf(waiter)
              if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
              promiseResolve(null)
            }, 60_000)

            req.signal.addEventListener('abort', () => {
              if (settled) return
              settled = true
              clearTimeout(timerId)
              const idx = pendingEntry.waiters.indexOf(waiter)
              if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
              promiseResolve(null)
            })
          })

          if (decision === null) {
            return new Response(JSON.stringify({ status: 'pending' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          return new Response(JSON.stringify({ status: 'decided', decision }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // POST /permission — create permission request and return requestId immediately
        if (req.method !== 'POST') {
          return new Response('Method Not Allowed', { status: 405 })
        }

        // Parse and validate JSON body
        let body: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
        try {
          body = await req.json()
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const { tool_name, tool_input, cwd } = body
        if (
          typeof tool_name !== 'string' ||
          typeof tool_input !== 'object' ||
          tool_input === null ||
          typeof cwd !== 'string'
        ) {
          return new Response(
            JSON.stringify({ error: 'Missing or invalid fields: tool_name, tool_input, cwd required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        // Normalize CWD and find matching channel
        const normalizedCwd = resolve(expandTilde(cwd))
        const matchedChannelId = routingConfig
          ? Object.entries(routingConfig.routes).find(
              ([, route]) => resolve(expandTilde(route.cwd)) === normalizedCwd,
            )?.[0]
          : undefined

        if (!matchedChannelId) {
          return new Response(JSON.stringify({ error: 'No route found for CWD' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Generate unique request ID
        const requestId = crypto.randomUUID()

        // Post Block Kit message to channel
        let messageTs: string
        try {
          const blocks = buildPermissionBlocks(tool_name, tool_input as Record<string, unknown>, requestId)
          const postResult = await web.chat.postMessage({
            channel: matchedChannelId,
            text: `Permission request: ${tool_name}`,
            blocks,
          })
          messageTs = postResult.ts as string
        } catch (err) {
          console.error('[slack] /permission: chat.postMessage failed:', err)
          return new Response(JSON.stringify({ error: 'Failed to post message' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Register pending entry with empty waiters array
        pendingPermissions.set(requestId, {
          requestId,
          channelId: matchedChannelId,
          messageTs,
          toolName: tool_name,
          waiters: [],
        })

        return new Response(JSON.stringify({ requestId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // -----------------------------------------------------------------------
      // /ask — AskUserQuestion relay endpoint (POST + GET long-poll)
      // -----------------------------------------------------------------------
      if (url.pathname === '/ask' || url.pathname.startsWith('/ask/')) {
        if (req.method !== 'POST' && req.method !== 'GET') {
          return new Response('Method Not Allowed', { status: 405 })
        }

        const remoteAddr = server.requestIP(req)
        const remoteHost = remoteAddr?.address ?? ''
        if (remoteHost !== '127.0.0.1' && remoteHost !== '::1' && !remoteHost.startsWith('::ffff:127.')) {
          return new Response('Forbidden', { status: 403 })
        }

        // GET /ask/<requestId> — long-poll for answer
        if (req.method === 'GET' && url.pathname.startsWith('/ask/')) {
          const pollRequestId = url.pathname.slice('/ask/'.length)

          const existingAnswer = completedAnswers.get(pollRequestId)
          if (existingAnswer !== undefined) {
            return new Response(JSON.stringify({ status: 'decided', answer: existingAnswer }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          const pendingEntry = pendingQuestions.get(pollRequestId)
          if (!pendingEntry) {
            return new Response(JSON.stringify({ status: 'decided', answer: '' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          const answer = await new Promise<string | null>((promiseResolve) => {
            let settled = false
            let timerId: ReturnType<typeof setTimeout>

            const waiter = (a: string) => {
              if (settled) return
              settled = true
              clearTimeout(timerId)
              promiseResolve(a)
            }

            pendingEntry.waiters.push(waiter)

            timerId = setTimeout(() => {
              if (settled) return
              settled = true
              const idx = pendingEntry.waiters.indexOf(waiter)
              if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
              promiseResolve(null)
            }, 60_000)

            req.signal.addEventListener('abort', () => {
              if (settled) return
              settled = true
              clearTimeout(timerId)
              const idx = pendingEntry.waiters.indexOf(waiter)
              if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
              promiseResolve(null)
            })
          })

          if (answer !== null) {
            return new Response(JSON.stringify({ status: 'decided', answer }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ status: 'pending' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // POST /ask — create a new question
        let body: { question?: unknown; options?: unknown; cwd?: unknown }
        try {
          body = await req.json()
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const { question, options, cwd } = body
        if (typeof question !== 'string' || !Array.isArray(options) || typeof cwd !== 'string') {
          return new Response(
            JSON.stringify({ error: 'Missing or invalid fields: question, options, cwd required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const normalizedCwd = resolve(expandTilde(cwd as string))
        const matchedChannelId = routingConfig
          ? Object.entries(routingConfig.routes).find(
              ([, route]) => resolve(expandTilde(route.cwd)) === normalizedCwd,
            )?.[0]
          : undefined

        if (!matchedChannelId) {
          return new Response(JSON.stringify({ error: 'No route found for CWD' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const requestId = crypto.randomUUID()

        // Build Block Kit with option buttons
        const optionButtons = (options as string[]).map((opt: string, i: number) => ({
          type: 'button',
          text: { type: 'plain_text', text: opt },
          action_id: `ask_${requestId}_${i}`,
        }))

        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❓ *${question}*`,
            },
          },
          {
            type: 'actions',
            elements: optionButtons,
          },
        ]

        let messageTs: string
        try {
          const postResult = await web.chat.postMessage({
            channel: matchedChannelId,
            text: `Question: ${question}`,
            blocks,
          })
          messageTs = postResult.ts as string
        } catch (err) {
          console.error('[slack] /ask: chat.postMessage failed:', err)
          return new Response(JSON.stringify({ error: 'Failed to post message' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        pendingQuestions.set(requestId, {
          requestId,
          channelId: matchedChannelId,
          messageTs,
          question: question as string,
          waiters: [],
        })

        return new Response(JSON.stringify({ requestId }), {
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
          req.signal.addEventListener('abort', () => {
            // Look up the session at abort time — it may have been registered
            // after this GET request started (the SSE stream opens before
            // roots/list completes). Also guards against double-fire if
            // onsessionclosed already ran from an explicit DELETE.
            const cwd = unregisterByMcpSessionId(mcpSessionId)
            if (!cwd) return

            const channelId = routingConfig
              ? Object.entries(routingConfig.routes).find(([, route]) => route.cwd === cwd)?.[0]
              : undefined
            if (channelId) {
              console.error(`[slack] Session disconnected (SSE abort): channel=${channelId} cwd="${cwd}"`)
              scheduleRestart(channelId, cwd, readSessions()[channelId]?.sessionId)
            } else {
              console.error(`[slack] Session disconnected (SSE abort): cwd="${cwd}"`)
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

  // Initialize restart module with adapters bridging tmux + session-manager
  initRestart({
    isSessionAlive: async (channelId) => {
      const cwd = routingConfig?.routes[channelId]?.cwd
      if (!cwd) return false
      const name = sessionName(cwd)
      const exists = await defaultTmuxClient.hasSession(name)
      if (!exists) return false
      return isClaudeRunning(name, defaultTmuxClient)
    },
    killSession: async (channelId) => {
      const cwd = routingConfig?.routes[channelId]?.cwd
      if (!cwd) return
      const name = sessionName(cwd)
      const exists = await defaultTmuxClient.hasSession(name)
      if (exists) await defaultTmuxClient.killSession(name)
    },
    launchSession: (channelId, cwd, sessionId) => {
      if (!routingConfig) return Promise.resolve(false)
      const resolvedSessionId = sessionId ?? readSessions()[channelId]?.sessionId
      return launchSession(
        channelId, cwd, routingConfig, defaultTmuxClient, readSessions, writeSessions,
        resolvedSessionId !== undefined ? { sessionId: resolvedSessionId } : undefined,
      )
    },
    getRestartDelay: () => routingConfig?.session_restart_delay ?? 60,
    isShuttingDown: () => shuttingDown,
  })

  // Start up managed tmux sessions for all configured routes.
  // If tmux is unavailable or startup fails, log a warning and continue.
  if (routingConfig) {
    try {
      await startupSessionManager(routingConfig, defaultTmuxClient, readSessions, writeSessions)
    } catch (err) {
      console.error('[slack] Warning: session startup failed — continuing without managed sessions:', err)
    }
  }

  // Initialize and start the health-check poller.
  const isSessionAliveAdapter = async (channelId: string): Promise<boolean> => {
    const cwd = routingConfig?.routes[channelId]?.cwd
    if (!cwd) return false
    const name = sessionName(cwd)
    const exists = await defaultTmuxClient.hasSession(name)
    if (!exists) return false
    return isClaudeRunning(name, defaultTmuxClient)
  }

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
    startHealthCheck(routingConfig.health_check_interval)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[slack] Fatal:', err)
    process.exit(1)
  })
}
