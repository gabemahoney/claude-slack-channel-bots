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
import { loadConfig, expandTilde, type RoutingConfig } from './config.ts'
import {
  registerSession,
  unregisterByMcpSessionId,
  getSessionByChannel,
  getSessionByRoute,
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
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// ---------------------------------------------------------------------------
// Bootstrap — tokens & state directory
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(INBOX_DIR, { recursive: true })

function loadEnv(): { botToken: string; appToken: string } {
  if (!existsSync(ENV_FILE)) {
    console.error(
      `[slack] No .env found at ${ENV_FILE}\n` +
        'Run /slack-channel:configure <bot-token> <app-token> first.',
    )
    process.exit(1)
  }

  chmodSync(ENV_FILE, 0o600)

  const raw = readFileSync(ENV_FILE, 'utf-8')
  const vars: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }

  const botToken = vars['SLACK_BOT_TOKEN'] || ''
  const appToken = vars['SLACK_APP_TOKEN'] || ''

  if (!botToken.startsWith('xoxb-')) {
    console.error('[slack] SLACK_BOT_TOKEN must start with xoxb-')
    process.exit(1)
  }
  if (!appToken.startsWith('xapp-')) {
    console.error('[slack] SLACK_APP_TOKEN must start with xapp-')
    process.exit(1)
  }

  return { botToken, appToken }
}

const { botToken, appToken } = loadEnv()

// ---------------------------------------------------------------------------
// Slack clients
// ---------------------------------------------------------------------------

const web = new WebClient(botToken)
const socket = new SocketModeClient({ appToken })

let botUserId = ''

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
  return libGate(event, {
    access: getAccess(),
    staticMode: STATIC_MODE,
    saveAccess,
    botUserId,
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
  // routeName/channelId are placeholders; tools only use deliveredChannels.
  const entryStub: SessionEntry = {
    routeName: '',
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
      const routeName = unregisterByMcpSessionId(mcpSessionId)
      if (routeName) {
        console.error(`[slack] Session disconnected: route="${routeName}"`)
      }
    },
  })

  entryStub.transport = transport

  // Build the MCP server (closes over entryStub.deliveredChannels)
  const server = createSessionServer(entryStub, sessionToolDeps)
  entryStub.server = server

  // Set roots handler — fires after MCP initialized notification
  server.oninitialized = () => {
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

async function handleInitialized(
  pendingId: string,
  server: import('@modelcontextprotocol/sdk/server/index.js').Server,
): Promise<void> {
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

  const matchedRoute = routingConfig.routes[matchedChannelId]
  const existingSession = getSessionByRoute(matchedRoute.name)

  // Promote pending → registered (removes from pendingSessionMap internally)
  registerSession(matchedRoute.name, matchedChannelId, pendingId)

  // Register MCP session ID for future HTTP request routing
  registerMcpSessionId(pendingId, matchedRoute.name)

  if (existingSession) {
    console.error(`[slack] Session replaced existing connection on route "${matchedRoute.name}"`)
  }
  console.error(`[slack] Session connected and matched route "${matchedRoute.name}" at CWD "${normalizedCwd}"`)
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

        targetSession = getSessionByRoute(routingConfig.default_dm_session)

        if (!targetSession || !targetSession.connected) {
          console.error(
            `[slack] DM session "${routingConfig.default_dm_session}" not live — dropping message`,
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
          targetSession = getSessionByRoute(routingConfig.default_route)
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
      targetSession.server.notification({
        method: 'notifications/claude/channel',
        params: { content: text, meta },
      })
    }
  }
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
        `[slack] Closing MCP transport for route "${entry.routeName}"\n`,
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

async function main(): Promise<void> {
  let mcpHost: string
  let mcpPort: number

  try {
    routingConfig = loadConfig()
    mcpHost = routingConfig.bind
    mcpPort = routingConfig.port
    const routeNames = Object.values(routingConfig.routes).map((r) => r.name)
    console.error(
      `[slack] Loaded routing config: ${routeNames.length} route(s): ${routeNames.join(', ')}`,
    )
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
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

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
        return (entry as NonNullable<typeof entry>).transport.handleRequest(req)
      }

      // --- Init request: no Mcp-Session-Id ---
      // Create a pending session; route resolved after roots/list in handleInitialized()
      const { transport } = initPendingSession()
      return transport.handleRequest(req)
    },
  })

  console.error(`[slack] MCP server listening on http://${mcpHost}:${mcpPort}/mcp`)
  console.error('')
  console.error('Add to Claude Code ~/.claude.json mcpServers:')
  console.error(
    JSON.stringify(
      {
        mcpServers: {
          slack: {
            type: 'http',
            url: `http://${mcpHost}:${mcpPort}/mcp`,
          },
        },
      },
      null,
      2,
    ),
  )
  console.error('')
}

main().catch((err) => {
  console.error('[slack] Fatal:', err)
  process.exit(1)
})
