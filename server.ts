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
import { loadConfig, type RoutingConfig } from './config.ts'
import {
  registerSession,
  unregisterSession,
  getSessionByChannel,
  getSessionByRoute,
  resolveTransportForRequest,
  registerMcpSessionId,
  createSessionServer,
  getAllSessions,
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
// Session factory
//
// Task t2.c1r.zk.6r: creates a new Transport + Server pair for each connecting
// Claude Code session.
//
// Task t2.c1r.zk.8b: Session identification.
// The URL path carries the route name: POST /mcp/<routeName>
// This is the simplest reliable approach — the Claude Code MCP config specifies
// the full URL (e.g. http://127.0.0.1:3100/mcp/my-bot), binding the session
// identity at connection time without requiring roots protocol or custom headers.
// ---------------------------------------------------------------------------

function createNewSession(
  routeName: string,
  channelId: string,
): { transport: WebStandardStreamableHTTPServerTransport } {
  // Guard: reject if route already has a live session
  // (registerSession also checks, but we log early here)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (mcpSessionId) => {
      // Index the transport-level session ID so we can route follow-up HTTP requests
      registerMcpSessionId(mcpSessionId, routeName)
      console.error(
        `[slack] Session initialized: route="${routeName}" channel=${channelId} mcp-session=${mcpSessionId}`,
      )
    },
    onsessionclosed: (mcpSessionId) => {
      console.error(
        `[slack] MCP session closed: ${mcpSessionId} (route "${routeName}")`,
      )
      // Mark the registry entry as disconnected
      const entry = getSessionByChannel(channelId, routingConfig!)
      if (entry) {
        entry.connected = false
      }
      unregisterSession(routeName)
    },
  })

  // Register the session with a placeholder server first, then build the real server
  // that closes over this entry's deliveredChannels, then patch it in.
  // We need the entry to exist before createSessionServer so it can close over entry,
  // but we also need the server to pass into registerSession cleanly.
  // Solution: register with a stub, build server (it closes over entry ref), patch entry.server.
  const stubServer = { connect: async () => {}, notification: () => {} } as any
  const entry = registerSession(routeName, channelId, transport, stubServer)

  // Build a Server that closes over this entry's deliveredChannels
  const server = createSessionServer(entry, sessionToolDeps)

  // Patch the real server reference into the entry
  entry.server = server

  // Wire server to transport
  server.connect(transport).catch((err) => {
    console.error(`[slack] Error connecting MCP server for route "${routeName}":`, err)
    unregisterSession(routeName)
  })

  console.error(
    `[slack] New session created: route="${routeName}" channel=${channelId}`,
  )

  return { transport }
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
// HTTP routing strategy (t2.c1r.zk.6r / t2.c1r.zk.8b):
//
//   POST /mcp/<routeName>   — init request (no Mcp-Session-Id) for a named route
//   GET/POST/DELETE /mcp/<routeName>?sessionId=... — handled by transport internally
//
// The route name is embedded in the URL path so that the Claude Code MCP config
// can point to the correct endpoint:
//   { "type": "http", "url": "http://127.0.0.1:3100/mcp/my-bot" }
//
// For subsequent requests the Mcp-Session-Id header is used to look up the
// transport, falling back to a 404 if the session is unknown.
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
  // HTTP server — multi-session routing
  //
  // URL scheme: /mcp/<routeName>
  //
  // 1. Extract routeName from URL path.
  // 2. If Mcp-Session-Id header is present: look up existing transport and forward.
  // 3. If no session ID (init request): verify routeName matches a config route,
  //    create a new Transport+Server pair, register it, and forward to it.
  // -------------------------------------------------------------------------

  httpServer = Bun.serve({
    hostname: mcpHost,
    port: mcpPort,
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

      // Extract route name from path: /mcp/<routeName>[/...]
      const pathParts = url.pathname.replace(/^\/+/, '').split('/')
      // Support both /mcp/<routeName> and /<routeName>
      let routeName: string | undefined
      if (pathParts[0] === 'mcp' && pathParts[1]) {
        routeName = pathParts[1]
      } else if (pathParts[0]) {
        routeName = pathParts[0]
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
        // entry is guaranteed non-null here (null means init, but we have a session ID)
        return (entry as NonNullable<typeof entry>).transport.handleRequest(req)
      }

      // --- Init request: no session ID ---
      if (!routeName) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                'Bad Request: URL must include route name, e.g. /mcp/<routeName>',
            },
            id: null,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      // Validate route name against config
      if (routingConfig) {
        const routeEntry = Object.values(routingConfig.routes).find(
          (r) => r.name === routeName,
        )
        if (!routeEntry) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: `Unknown route "${routeName}". Check your routing config.`,
              },
              id: null,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }

        // Find the channel ID for this route (reverse lookup in routes map)
        const channelId = Object.entries(routingConfig.routes).find(
          ([, r]) => r.name === routeName,
        )?.[0]

        if (!channelId) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: `No channel found for route "${routeName}"` },
              id: null,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }

        try {
          const { transport } = createNewSession(routeName, channelId)
          return transport.handleRequest(req)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[slack] Failed to create session for route "${routeName}":`, msg)
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: msg },
              id: null,
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          )
        }
      }

      // No routing config — legacy single-session fallback
      // Create a session with a placeholder channel ID
      try {
        const fallbackChannel = 'UNKNOWN'
        const { transport } = createNewSession(routeName, fallbackChannel)
        return transport.handleRequest(req)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: msg },
            id: null,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        )
      }
    },
  })

  console.error(`[slack] MCP server listening on http://${mcpHost}:${mcpPort}/mcp/<routeName>`)
  console.error('')
  console.error('Add to Claude Code ~/.claude.json mcpServers (one entry per route):')

  if (routingConfig) {
    const examples: Record<string, unknown> = {}
    for (const [, route] of Object.entries(routingConfig.routes)) {
      examples[`slack-${route.name}`] = {
        type: 'http',
        url: `http://${mcpHost}:${mcpPort}/mcp/${route.name}`,
      }
    }
    console.error(JSON.stringify({ mcpServers: examples }, null, 2))
  } else {
    console.error(
      JSON.stringify(
        {
          slack: {
            type: 'http',
            url: `http://${mcpHost}:${mcpPort}/mcp/default`,
          },
        },
        null,
        2,
      ),
    )
  }
  console.error('')
}

main().catch((err) => {
  console.error('[slack] Fatal:', err)
  process.exit(1)
})
