/**
 * registry.ts — Persona-keyed MCP session registry and the per-session MCP
 * Server with its persona-scoped Slack tools.
 *
 * Session identity (b.av2 SR-6.3): an MCP session is identified by the working
 * directory its client reports through `roots/list`. That directory is
 * compared by real path (`resolveRealPath`) with the applied personas' working
 * directories and maps to exactly one persona (`matchPersonaByRootsPath`). A
 * session is admitted only while that persona is up (b.av2 SR-6.4,
 * `decideSessionAdmission`, with the up check injected), and a persona that
 * stops being up has its session dropped (`dropPersonaSession`). The
 * registry is keyed by persona key; a newer session for a persona replaces the
 * older one. A session sits in the pending map from its MCP init request until
 * its roots are matched, and its entry stub is promoted in place so the tool
 * handlers that closed over it read the persona key it is promoted under.
 *
 * Tool scope (b.av2 SR-5.1, SR-3.1): the tools keep their names and inputs.
 * Each call resolves the calling session's persona and that persona's Slack
 * client at call time, may target only the channels in the persona's current
 * applied configuration and, while its `dm.enabled` is on, its DM
 * conversations and (for `reply`) user IDs (`checkPersonaTarget`), and posts
 * as the persona with no username or icon override.
 *
 * Importing this module has no side effects.
 *
 * SPDX-License-Identifier: MIT
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { WebClient } from '@slack/web-api'
import { writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { DM_CONTACT_RE, MCP_SERVER_NAME, resolveRealPath, type Persona, type ReplySettings } from './config.ts'
import { chunkText, sanitizeFilename } from './lib.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeSlackCallFailure, describeThrownValue, slackPlatformReason } from './persona-connection-errors.ts'
import { DM_OPEN_SCOPE, MISSING_SCOPE_ERROR } from './persona-destination.ts'
import { isDryRun } from './tokens.ts'
// Peer-PID + sessions.json registry have been deleted (SR-7.1). The
// agent-director library owns session state.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  /** Real path of the session's roots working directory — the session identity */
  cwd: string
  /** Key of the persona this session is matched to; empty on a pending stub until promotion */
  personaKey: string
  /** MCP transport for this session */
  transport: WebStandardStreamableHTTPServerTransport
  /** MCP Server instance for this session */
  server: Server
  /** Whether the session is currently connected (transport alive) */
  connected: boolean
  /**
   * TCP peer port of the most recent MCP request from this session.
   * Updated per-request in server.ts before transport.handleRequest().
   * Used by the CallToolRequestSchema handler to identify the calling process.
   */
  peerPort: number
}

/**
 * A session that has connected but not yet been matched to a persona.
 * Exists between the MCP init request and roots/list resolution.
 */
export interface PendingSessionEntry {
  /** The MCP session ID — also the key in pendingSessionMap */
  pendingId: string
  /** MCP transport for this session */
  transport: WebStandardStreamableHTTPServerTransport
  /** MCP Server instance — already connected to transport */
  server: Server
  /** Unix ms timestamp of creation */
  createdAt: number
  /**
   * The SessionEntry stub created in initPendingSession.
   * When present, the promotion path in registerSession mutates this object
   * in place instead of creating a new one, so tool handler closures that
   * captured the stub always read the latest peerPort / personaKey / cwd.
   */
  stub?: SessionEntry
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Maps persona key → SessionEntry.
 * A separate index (mcpSessionIdToPersonaKey) maps the MCP-level session ID
 * (assigned by the transport after initialization) back to the persona key,
 * so that incoming HTTP requests can be dispatched to the right transport.
 */
const registry = new Map<string, SessionEntry>()

/** MCP session ID (UUID from transport) → persona key, for HTTP routing */
const mcpSessionIdToPersonaKey = new Map<string, string>()

/**
 * Sessions that have connected but not yet been matched to a persona.
 * Keyed by the MCP session ID (pendingId).
 */
const pendingSessionMap = new Map<string, PendingSessionEntry>()

// ---------------------------------------------------------------------------
// Roots cwd → persona matching (b.av2 SR-6.3)
// ---------------------------------------------------------------------------

/** Options for `matchPersonaByRootsPath`. */
export interface MatchPersonaOptions {
  /** Realpath function passed to `resolveRealPath`; defaults to `fs.realpathSync`. */
  realpath?: (path: string) => string
  /** Writes the one log line for an ambiguous match; defaults to `console.error`. */
  log?: (line: string) => void
}

/**
 * The persona a session's roots working directory maps to (b.av2 SR-6.3):
 * the one applied persona whose `working_directory` has the same real path
 * (`resolveRealPath`) as `rootsPath`, or undefined when none does.
 *
 * `rootsPath` is the path after `file://` decoding and tilde expansion. When
 * more than one persona matches, returns undefined and logs one line, so a
 * session never maps to two personas.
 */
export function matchPersonaByRootsPath(
  rootsPath: string,
  personas: readonly Persona[],
  options: MatchPersonaOptions = {},
): Persona | undefined {
  const { realpath, log = (line: string) => console.error(line) } = options
  const target = resolveRealPath(rootsPath, realpath)
  const matches = personas.filter((p) => resolveRealPath(p.working_directory, realpath) === target)
  if (matches.length > 1) {
    const refs = matches.map((p) => renderPersonaRef(p.name, p.key)).join(', ')
    log(`[registry] Roots cwd "${target}" matches more than one persona (${refs}) — matching none`)
    return undefined
  }
  return matches[0]
}

// ---------------------------------------------------------------------------
// Session admission (b.av2 SR-6.3, SR-6.4)
// ---------------------------------------------------------------------------

/** Options for `decideSessionAdmission`. */
export interface SessionAdmissionOptions extends MatchPersonaOptions {
  /**
   * Whether the persona with this key is up (b.av2 SR-6.4). Production passes
   * `createPersonaUpPredicate` over the connection manager and the bring-up
   * controller.
   */
  isPersonaUp: (key: string) => boolean
  /**
   * The token-free outcome or cause of a persona that is not up, for the
   * refusal line (production: `describePersonaNotUp` of the controller's
   * state). The line omits it when absent.
   */
  describeNotUp?: (key: string) => string
}

/** What `decideSessionAdmission` decided for a session. */
export type SessionAdmission =
  /** The roots working directory maps to an up persona: register the session under it. */
  | { kind: 'admitted'; persona: Persona }
  /** No persona (or more than one) matches the roots working directory. */
  | { kind: 'unmatched' }
  /** The matched persona is not up: refuse the session and keep any session already registered for it. */
  | { kind: 'not-up'; persona: Persona }

/**
 * Decide whether a session whose roots working directory is `rootsPath` may
 * register (b.av2 SR-6.3, SR-6.4): match it to one persona by real path
 * (`matchPersonaByRootsPath`), then admit it only when that persona is up.
 * A persona that is not up (broken or retrying) keeps its instance, but the
 * instance's session is refused until the persona is up; the refusal logs one
 * line through `options.log`, with no token and no diagnostic class label:
 *
 *   [slack] Session refused: persona "<name>" (key=<key>) is not up (<outcome>: <cause>) — not registered; its instance is kept and may register once the persona is up
 *
 * A missing working directory still matches its own persona (the lexical
 * fallback of `resolveRealPath`) and is refused here. Registers, removes and
 * closes nothing: the caller acts on the result.
 */
export function decideSessionAdmission(
  rootsPath: string,
  personas: readonly Persona[],
  options: SessionAdmissionOptions,
): SessionAdmission {
  const persona = matchPersonaByRootsPath(rootsPath, personas, options)
  if (!persona) return { kind: 'unmatched' }
  if (options.isPersonaUp(persona.key)) return { kind: 'admitted', persona }
  const log = options.log ?? ((line: string) => console.error(line))
  const why = options.describeNotUp ? ` (${options.describeNotUp(persona.key)})` : ''
  log(
    `[slack] Session refused: persona ${renderPersonaRef(persona.name, persona.key)} is not up${why} — ` +
      'not registered; its instance is kept and may register once the persona is up',
  )
  return { kind: 'not-up', persona }
}

// ---------------------------------------------------------------------------
// Public API — registry operations
// ---------------------------------------------------------------------------

/**
 * Register a session in the registry under a persona key.
 *
 * Two call forms:
 *   registerSession(cwd, personaKey, transport, server)
 *     — fresh registration (e.g. for testing)
 *
 *   registerSession(cwd, personaKey, pendingId)
 *     — promote a pending session to registered; looks up transport/server
 *       from pendingSessionMap and removes the pending entry. When the pending
 *       entry carries a stub, the stub itself becomes the registered entry.
 *
 * `cwd` is the real path of the session's roots working directory. If a live
 * session already exists for the persona it is marked disconnected and
 * replaced.
 */
export function registerSession(
  cwd: string,
  personaKey: string,
  transportOrPendingId: WebStandardStreamableHTTPServerTransport | string,
  server?: Server,
): SessionEntry {
  let transport: WebStandardStreamableHTTPServerTransport
  let resolvedServer: Server

  let stub: SessionEntry | undefined

  if (typeof transportOrPendingId === 'string') {
    // Promotion path: look up pending entry by ID
    const pendingId = transportOrPendingId
    const pending = pendingSessionMap.get(pendingId)
    if (!pending) {
      throw new Error(`registerSession: no pending session found for ID "${pendingId}"`)
    }
    transport = pending.transport
    resolvedServer = pending.server
    stub = pending.stub
    removePendingSession(pendingId)
  } else {
    // Fresh registration path
    transport = transportOrPendingId
    resolvedServer = server!
  }

  const existing = registry.get(personaKey)
  if (existing && existing.connected) {
    // Replace stale/existing session
    console.error(`[registry] WARNING: persona=${personaKey} already has a live session (MCP ID: ${existing.transport.sessionId ?? 'unknown'}) — replacing with new registration`)
    existing.connected = false
    registry.delete(personaKey)
  }

  let entry: SessionEntry
  if (stub) {
    // Mutate the existing stub in place so that any closures that captured it
    // (e.g. tool handlers in createSessionServer) see the updated values.
    stub.cwd = cwd
    stub.personaKey = personaKey
    stub.transport = transport
    stub.server = resolvedServer
    stub.connected = true
    // peerPort intentionally left as-is (stays 0 until first HTTP request)
    entry = stub
  } else {
    entry = {
      cwd,
      personaKey,
      transport,
      server: resolvedServer,
      connected: true,
      peerPort: 0,
    }
  }
  registry.set(personaKey, entry)
  return entry
}

// ---------------------------------------------------------------------------
// Pending session operations
// ---------------------------------------------------------------------------

/**
 * Create a pending session entry (session connected, persona not yet known).
 * The pendingId must equal the transport's MCP session ID so that
 * resolveTransportForRequest can look it up by the Mcp-Session-Id header.
 *
 * Pass `stub` when the SessionEntry was already created (e.g. in initPendingSession)
 * so that the promotion path in registerSession can mutate it in place rather than
 * creating a new object. This keeps tool handler closures in sync with the registry.
 */
export function createPendingSession(
  pendingId: string,
  transport: WebStandardStreamableHTTPServerTransport,
  server: Server,
  stub?: SessionEntry,
): PendingSessionEntry {
  const entry: PendingSessionEntry = { pendingId, transport, server, createdAt: Date.now(), stub }
  pendingSessionMap.set(pendingId, entry)
  return entry
}

/** Look up a pending session by its ID. */
export function getPendingSession(pendingId: string): PendingSessionEntry | undefined {
  return pendingSessionMap.get(pendingId)
}

/** Remove a pending session. No-op if not found. */
export function removePendingSession(pendingId: string): void {
  pendingSessionMap.delete(pendingId)
}

/** What `closePendingSession` acts through, injected (b.av2 SR-13.1). */
export interface ClosePendingSessionDeps<T> {
  /** Remove the pending entry (production: `removePendingSession`). */
  removePending: (pendingId: string) => void
  /** Stop the transport's SSE keep-alive (production: server.ts `stopSseKeepAlive`). */
  stopKeepAlive: (transport: T) => void
}

/**
 * Disconnect a pending session that will not be registered: remove its
 * pending entry, stop its SSE keep-alive, then close its transport (a close
 * failure is ignored). The one close path for a pending session in
 * `handleInitialized`: a persona that is not up (b.av2 SR-6.4), a roots
 * working directory that matches no persona, a roots/list failure or empty
 * roots, and an SSE stream that never opened. Registers nothing and never
 * touches a persona's registered session. Resolves once the close settles.
 */
export async function closePendingSession<T extends { close(): Promise<void> }>(
  pendingId: string,
  transport: T,
  deps: ClosePendingSessionDeps<T>,
): Promise<void> {
  deps.removePending(pendingId)
  deps.stopKeepAlive(transport)
  try {
    await transport.close()
  } catch {
    /* ignore */
  }
}

/** Return all pending sessions (for graceful shutdown). */
export function getAllPendingSessions(): PendingSessionEntry[] {
  return Array.from(pendingSessionMap.values())
}

/**
 * Remove a session from the registry by its MCP session ID.
 * Marks the entry as disconnected before removal.
 * Returns the persona key if found, undefined otherwise.
 *
 * Guards against a race condition where a reconnect registers a new session
 * for the same persona before the old SSE abort fires. If the current registry
 * entry's transport belongs to a different MCP session, the old mapping is
 * cleaned up but the new session is left intact and undefined is returned.
 */
export function unregisterByMcpSessionId(mcpSessionId: string): string | undefined {
  const personaKey = mcpSessionIdToPersonaKey.get(mcpSessionId)
  if (!personaKey) return undefined

  // Always clean up the stale MCP ID → persona key mapping
  mcpSessionIdToPersonaKey.delete(mcpSessionId)

  const entry = registry.get(personaKey)
  if (!entry) return personaKey

  // If a newer session has already replaced this one in the registry,
  // don't destroy it — just clean up the old mapping and return.
  if (entry.transport.sessionId !== mcpSessionId) {
    console.error(`[registry] Skipping unregister for stale MCP session "${mcpSessionId}" — persona=${personaKey} already has a newer session`)
    return undefined
  }

  entry.connected = false
  unregisterSession(personaKey)
  return personaKey
}

/**
 * Remove a persona's session from the registry.
 * Also cleans up the MCP session ID → persona key index.
 */
export function unregisterSession(personaKey: string): void {
  const entry = registry.get(personaKey)
  if (!entry) return

  // Clean up the MCP session ID index for this persona key
  for (const [mcpId, k] of mcpSessionIdToPersonaKey) {
    if (k === personaKey) {
      mcpSessionIdToPersonaKey.delete(mcpId)
      break
    }
  }

  registry.delete(personaKey)
  console.error(`[registry] Unregistered session for persona=${personaKey}`)
}

/**
 * Drop the session registered for a persona (b.av2 SR-6.3: a session is
 * registered only while its persona is up; the SR-6.5 teardown can reuse it):
 * remove its registry entry and every MCP session ID mapped to the persona,
 * mark the entry not connected, then close its transport. The mappings go
 * first, so the close's `onsessionclosed` and the SSE abort find no session
 * and restart nothing. Every other persona's session is untouched. Resolves
 * whether a session was registered; a persona with none is a no-op. A failing
 * close is ignored. Makes no agent-director call and logs nothing.
 */
export async function dropPersonaSession(personaKey: string): Promise<boolean> {
  const entry = registry.get(personaKey)
  if (!entry) return false
  for (const [mcpId, key] of [...mcpSessionIdToPersonaKey]) {
    if (key === personaKey) mcpSessionIdToPersonaKey.delete(mcpId)
  }
  registry.delete(personaKey)
  entry.connected = false
  try {
    await entry.transport.close()
  } catch { /* ignore */ }
  return true
}

/** Look up the session registered for a persona key. */
export function getSessionByPersona(
  personaKey: string,
): SessionEntry | undefined {
  return registry.get(personaKey)
}

/**
 * Register the MCP transport session ID (UUID assigned after initialization)
 * so that subsequent HTTP requests can be routed to the correct transport.
 */
export function registerMcpSessionId(mcpSessionId: string, personaKey: string): void {
  mcpSessionIdToPersonaKey.set(mcpSessionId, personaKey)
  console.error(
    `[registry] Mapped MCP session ID "${mcpSessionId}" to persona=${personaKey}`,
  )
}

/**
 * Find the transport to handle an incoming HTTP request.
 *
 * Strategy:
 *   1. If no Mcp-Session-Id header: init request — return null so the caller
 *      creates a new pending session.
 *   2. If session ID matches a registered session: return it.
 *   3. If session ID matches a pending session (not yet persona-matched): return
 *      it so in-flight requests (e.g. SSE stream establishment) are served.
 *   4. Otherwise return undefined (404).
 */
export function resolveTransportForRequest(
  req: Request,
): SessionEntry | PendingSessionEntry | null | undefined {
  const mcpSessionId = req.headers.get('mcp-session-id')

  if (!mcpSessionId) {
    // No session ID → initialization request
    return null
  }

  // Check registered sessions first
  const personaKey = mcpSessionIdToPersonaKey.get(mcpSessionId)
  if (personaKey) {
    const entry = registry.get(personaKey)
    if (entry && entry.connected) return entry
    return undefined
  }

  // Check pending sessions
  const pendingEntry = pendingSessionMap.get(mcpSessionId)
  if (pendingEntry) return pendingEntry

  // Unknown session ID
  return undefined
}

// ---------------------------------------------------------------------------
// Per-session Server factory
// ---------------------------------------------------------------------------

/**
 * Tool handler dependencies injected at session creation time.
 * Server.ts provides these after its own setup is complete. The persona and
 * its client are looked up through these on every tool call, never cached.
 */
export interface SessionToolDeps {
  /** File exfiltration guard — throws when the file must not be sent */
  assertSendable: (filePath: string) => void
  /**
   * The server-wide reply settings (b.av2 SR-1.6): reply chunking and the
   * ack reaction name. Their start-time values; a reload does not change them.
   */
  getReplySettings: () => ReplySettings
  /** The current applied persona with this key, or undefined when there is none */
  getPersona: (key: string) => Persona | undefined
  /** The persona's validated Slack Web client, or undefined when it has none */
  clientFor: (key: string) => WebClient | undefined
  /** Inbox directory for downloads */
  inboxDir: string
  /** Resolve a user's display name through the persona's client */
  resolveUserName: (personaKey: string, userId: string) => Promise<string>
  /** Consume a pending ack entry — returns true if it existed */
  consumeAck: (channelId: string, messageTs: string) => boolean
  /** TCP port the MCP HTTP server is listening on (retained for diagnostics). */
  serverPort: number
}

// ---------------------------------------------------------------------------
// Posting scope (b.av2 SR-5.1)
// ---------------------------------------------------------------------------

/** A DM conversation ID. A group DM (`G…`, `mpim`) never matches. */
const DM_CONVERSATION_ID_RE = /^D[A-Z0-9]+$/

/**
 * What a tool target is, for one persona (b.av2 SR-5.1):
 * - `channel`: the `id` of one of the persona's configured channels;
 * - `dm`: a DM conversation ID (`D…`);
 * - `user`: a Slack user ID (`U…`/`W…`, the `dm.contact` format);
 * - `other`: anything else (another channel, a group DM, an empty value …).
 */
type PersonaTargetKind = 'channel' | 'dm' | 'user' | 'other'

/**
 * Classify `target` for `persona`. A configured channel wins over the ID
 * shapes. Pure: no Slack call, logging or state.
 */
function classifyPersonaTarget(persona: Persona, target: string): PersonaTargetKind {
  if (target !== '' && persona.channels.some((c) => c.id === target)) return 'channel'
  if (DM_CONVERSATION_ID_RE.test(target)) return 'dm'
  if (DM_CONTACT_RE.test(target)) return 'user'
  return 'other'
}

/**
 * The kind of action a tool takes on its target: `post` posts a new message
 * (`reply`, with its file uploads); `act` acts on an existing conversation
 * (`react`, `edit_message`, `fetch_messages`, `download_attachment`).
 */
export type PersonaTargetAction = 'post' | 'act'

/**
 * Outcome of `checkPersonaTarget`. An allowed `user` target is a user ID that
 * must first be opened with `conversations.open` on the persona's client; the
 * tool then acts in the returned conversation, never on the user ID itself.
 */
export type PersonaTargetCheck =
  | { allowed: true; kind: 'channel' | 'dm' | 'user' }
  | { allowed: false; message: string }

/**
 * The posting scope of a persona (b.av2 SR-5.1), decided from the persona as
 * applied now (callers pass the persona resolved at call time):
 * - a configured channel is allowed, whatever its delivery mode;
 * - a `D…` conversation is allowed only while `dm.enabled` is on (Slack itself
 *   refuses one the persona's app is not in);
 * - a user ID is allowed only for `post` and only while `dm.enabled` is on,
 *   as `kind: 'user'` (open the DM first); for `act` it is refused whatever
 *   the switch, so no read, edit or reaction ever opens a DM;
 * - everything else is refused.
 * A refusal message names the persona (`renderPersonaRef` with its stored
 * key) and the target. While `dm.enabled` is off, every `D…`/`U…`/`W…`
 * target on any tool gets the DMs-off reason, so the model is never steered
 * to a DM conversation that would be refused too. Pure.
 */
export function checkPersonaTarget(
  persona: Persona,
  target: string,
  action: PersonaTargetAction,
): PersonaTargetCheck {
  const kind = classifyPersonaTarget(persona, target)
  const refuse = (why: string): PersonaTargetCheck => ({
    allowed: false,
    message: `Persona ${renderPersonaRef(persona.name, persona.key)} may not target ${JSON.stringify(target)}: ${why}`,
  })
  if (kind === 'channel') return { allowed: true, kind }
  if (kind === 'other') return refuse(`it is not one of the persona's configured channels.`)
  if (!persona.dm.enabled) return refuse(`DMs are off for this persona (dm.enabled is false).`)
  if (kind === 'user' && action !== 'post') {
    return refuse(`this tool needs a conversation ID (a channel ID or a D… DM conversation ID), not a user ID.`)
  }
  return { allowed: true, kind }
}

/**
 * Each tool's Slack target: the argument naming it, and the kind of action the
 * tool takes there (only `reply` posts a new message). Tools not listed here
 * are unknown.
 */
const TOOL_TARGET: Readonly<Record<string, { arg: string; action: PersonaTargetAction }>> = {
  reply: { arg: 'chat_id', action: 'post' },
  react: { arg: 'chat_id', action: 'act' },
  edit_message: { arg: 'chat_id', action: 'act' },
  fetch_messages: { arg: 'channel', action: 'act' },
  download_attachment: { arg: 'chat_id', action: 'act' },
}

/** A CallTool result flagged as a tool error. */
function toolError(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

// ---------------------------------------------------------------------------
// Attachment downloads — where the persona's bot token may go
// ---------------------------------------------------------------------------

/** The only host a persona's bot token is ever sent to by `download_attachment`. */
const SLACK_FILES_HOST = 'files.slack.com'
const SLACK_FILES_ORIGIN = `https://${SLACK_FILES_HOST}`

/** Most redirects `download_attachment` follows for one file. */
export const MAX_DOWNLOAD_REDIRECTS = 3

/**
 * True only for an `https:` URL whose host is exactly `files.slack.com` (default
 * port, no user info). Anything else — another host, a lookalike subdomain,
 * `http:`, an explicit port, an unparseable value — is not Slack-hosted, and
 * the persona's bot token must not be sent to it.
 */
export function isSlackHostedFileUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.host === SLACK_FILES_HOST &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

/**
 * How a file is named in a `download_attachment` refusal: its Slack file ID
 * when it has a well-formed one, else its 1-based position on the message.
 * Never the URL (its query string could carry a secret) or the free-text name.
 */
function fileLabel(file: { id?: unknown }, index: number): string {
  return typeof file.id === 'string' && /^[A-Z0-9]+$/.test(file.id) ? file.id : `#${index + 1}`
}

/** Outcome of `fetchSlackHostedFile`. */
type SlackFileFetch =
  | { kind: 'ok'; body: Buffer }
  | { kind: 'failed' }
  | { kind: 'refused'; reason: 'offsite' | 'too-many-redirects' }

/**
 * Fetch a Slack-hosted file with the persona's bot token, never letting the
 * `Authorization` header reach another origin. `url` must already have passed
 * `isSlackHostedFileUrl`. Redirects are handled manually and followed only
 * while they stay on https://files.slack.com, at most `MAX_DOWNLOAD_REDIRECTS`
 * times; a redirect elsewhere, or past the limit, is `refused`. A redirect
 * that cannot be followed (no readable or parseable `Location`) and a non-2xx
 * final response are `failed`. Network errors propagate.
 */
async function fetchSlackHostedFile(url: string, token: string): Promise<SlackFileFetch> {
  let current = url
  for (let hop = 0; ; hop++) {
    const resp = await fetch(current, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
    })
    const isRedirect = resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)
    if (!isRedirect) {
      if (!resp.ok) return { kind: 'failed' }
      return { kind: 'ok', body: Buffer.from(await resp.arrayBuffer()) }
    }

    resp.body?.cancel().catch(() => {})
    if (hop >= MAX_DOWNLOAD_REDIRECTS) return { kind: 'refused', reason: 'too-many-redirects' }
    const location = resp.headers.get('location')
    if (!location) return { kind: 'failed' }
    let next: string
    try {
      next = new URL(location, current).href
    } catch {
      return { kind: 'failed' }
    }
    if (!isSlackHostedFileUrl(next)) return { kind: 'refused', reason: 'offsite' }
    current = next
  }
}

const MCP_INSTRUCTIONS = [
  'The sender reads Slack, not this session. Anything you want them to see must go through the reply tool.',
  '',
  'Messages from Slack arrive as <channel source="slack" chat_id="C..." message_id="1234567890.123456" user="display name" user_id="U..." thread_ts="..." ts="..." via="mention">.',
  'user_id is the author\'s Slack user ID. When a bot or integration without a user posted the message, the tag carries bot_id instead of user_id.',
  'via says how the message reached you: dm (a direct message to you), mention (you were @mentioned), broadcast (@here or @channel), ' +
    'receive_all_shared (a channel where you and at least one other persona receive every message), ' +
    'receive_all (a channel where you alone receive every message).',
  '<@ID> in message text mentions a Slack user or another persona. Mention another persona the same way, with <@ID>, to address it.',
  'A message without via is an injected prompt (a scheduled prompt or an /interject message). It needs no reply unless it asks for one.',
  'If the tag has attachment_count, call download_attachment(chat_id, message_id) to fetch them.',
  'Reply with the reply tool — pass chat_id back. Use thread_ts to reply in a thread.',
  'Where you may act: any channel your persona is configured into, which covers the chat_id of every channel message you receive.',
  'When your persona\'s DMs are on, you may also reply in a DM conversation you are part of (a D... chat_id), ' +
    'and use react, edit_message, fetch_messages and download_attachment there. ' +
    'To start a DM, pass a user ID (U... or W...) as reply\'s chat_id: the server opens the conversation, ' +
    'and the result names the conversation ID (D...) to use for later edits, reactions, reads and thread replies. ' +
    'The other tools do not take a user ID.',
  'When your persona\'s DMs are off, you have no DM target.',
  'Any other target is refused with an error.',
  'Pass message_id (the triggering message ts) to reply to automatically remove the ack reaction when done.',
  'reply accepts file paths (files: ["/abs/path.png"]) for attachments.',
  'Use react to add emoji reactions, edit_message to update a previously sent message.',
  'fetch_messages pulls real Slack history from conversations.history.',
].join('\n')

/**
 * Build a new MCP Server instance for a single session.
 * The tools close over the session entry and read its persona key on every
 * call, so a pending stub promoted in place scopes its tools to the persona
 * it was matched to.
 */
export function createSessionServer(
  entry: SessionEntry,
  deps: SessionToolDeps,
): Server {
  const { assertSendable, getReplySettings, getPersona, clientFor, resolveUserName, inboxDir, consumeAck } = deps

  const server = new Server(
    { name: MCP_SERVER_NAME, version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: MCP_INSTRUCTIONS,
    },
  )

  // -------------------------------------------------------------------------
  // Tool list
  // -------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Send a message to a Slack channel or DM. Auto-chunks long text. Supports file attachments.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: {
              type: 'string',
              description:
                'A channel ID or a DM conversation ID (D...); with DMs on, a user ID (U... or W...) opens a DM with that user',
            },
            text: { type: 'string', description: 'Message text (mrkdwn supported)' },
            thread_ts: {
              type: 'string',
              description: 'Thread timestamp to reply in-thread (optional)',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute paths of files to upload (optional)',
            },
            message_id: {
              type: 'string',
              description: 'Message timestamp (ts) of the triggering message — removes ack reaction when provided (optional)',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description: 'Add an emoji reaction to a Slack message.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'A channel ID or a DM conversation ID (D...)' },
            message_id: { type: 'string', description: 'Message timestamp (ts)' },
            emoji: {
              type: 'string',
              description: 'Emoji name without colons (e.g. "thumbsup")',
            },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'edit_message',
        description: "Edit a previously sent message (bot's own messages only).",
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'A channel ID or a DM conversation ID (D...)' },
            message_id: { type: 'string', description: 'Message timestamp (ts)' },
            text: { type: 'string', description: 'New message text' },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
      {
        name: 'fetch_messages',
        description:
          'Fetch message history from a channel, DM conversation or thread. Returns oldest-first.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            channel: { type: 'string', description: 'A channel ID or a DM conversation ID (D...)' },
            limit: {
              type: 'number',
              description: 'Max messages to fetch (default 20, max 100)',
            },
            thread_ts: {
              type: 'string',
              description: 'If set, fetch replies in this thread',
            },
          },
          required: ['channel'],
        },
      },
      {
        name: 'download_attachment',
        description:
          'Download attachments from a Slack message. Returns local file paths.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'A channel ID or a DM conversation ID (D...)' },
            message_id: {
              type: 'string',
              description: 'Message timestamp (ts) containing the files',
            },
          },
          required: ['chat_id', 'message_id'],
        },
      },
    ],
  }))

  // -------------------------------------------------------------------------
  // Tool execution — persona-scoped (b.av2 SR-5.1, SR-3.1)
  //
  // Every call resolves the session's persona at call time from the entry
  // this server closes over, checks the tool's target against the persona's
  // current channels and DM switch (`checkPersonaTarget`, before the dry-run
  // branch), and outside dry run makes every Slack call on the persona's own
  // client, with no username or icon override. A refusal is a tool error
  // (`isError: true`), never a protocol error, and makes no Slack call.
  //
  // A user-ID target (`reply` only) is opened with `conversations.open` on the
  // persona's client on every call (no cache), and the reply goes to the
  // returned conversation; the user ID itself never reaches a Slack write,
  // which would open a DM implicitly.
  // -------------------------------------------------------------------------

  /** Today's dry-run result for a tool whose target passed the scope check. */
  function dryRunResult(name: string, args: Record<string, any>, kind: PersonaTargetKind) {
    switch (name) {
      case 'reply':
        console.error(`[slack] dry-run: reply to ${args.chat_id} (${args.text.length} chars)`)
        if (kind === 'user') {
          return {
            content: [{ type: 'text', text: `[dry-run] Would open a DM with ${args.chat_id} and send message there` }],
          }
        }
        return { content: [{ type: 'text', text: `[dry-run] Would send message to ${args.chat_id}` }] }
      case 'react':
        console.error(`[slack] dry-run: react :${args.emoji}: on ${args.message_id}`)
        return { content: [{ type: 'text', text: `[dry-run] Would react :${args.emoji}: to ${args.message_id}` }] }
      case 'edit_message':
        console.error(`[slack] dry-run: edit_message ${args.message_id} in ${args.chat_id}`)
        return { content: [{ type: 'text', text: `[dry-run] Would edit message ${args.message_id}` }] }
      case 'fetch_messages':
        console.error(`[slack] dry-run: fetch_messages from ${args.channel}`)
        return { content: [{ type: 'text', text: `[dry-run] Would fetch messages from ${args.channel}` }] }
      default: // download_attachment (runs only for a tool in TOOL_TARGET)
        console.error(`[slack] dry-run: download_attachment from ${args.chat_id} msg=${args.message_id}`)
        return { content: [{ type: 'text', text: `[dry-run] Would download attachments from ${args.message_id}` }] }
    }
  }

  /**
   * Open (or find) the DM between the persona's app and user `userId` with
   * `conversations.open` on the persona's client. Returns the conversation
   * ID, or the tool error to return when Slack refused the open or answered
   * without an ID; nothing is posted after a failed open.
   */
  async function openDmConversation(
    name: string,
    persona: Persona,
    web: WebClient,
    userId: string,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const failed = `Tool "${name}" failed for persona ${renderPersonaRef(persona.name, persona.key)}: ` +
      `could not open a DM with ${JSON.stringify(userId)}`
    try {
      const res = await web.conversations.open({ users: userId })
      const id = res.channel?.id
      if (typeof id === 'string' && id !== '') return { ok: true, id }
      console.error(`[slack] ${failed}: Slack returned no conversation ID`)
      return { ok: false, message: `${failed} (Slack returned no conversation ID).` }
    } catch (err) {
      // Token-safe: a Slack library error's message and headers can hold a token.
      console.error(`[slack] ${failed}${describeSlackCallFailure(err)}`)
      const reason = slackPlatformReason(err)
      const scopeHint = reason === MISSING_SCOPE_ERROR
        ? ` The persona's Slack app lacks the ${DM_OPEN_SCOPE} scope; add it and re-install the app.`
        : ''
      return { ok: false, message: `${failed}${reason ? ` (${reason})` : ''}.${scopeHint}` }
    }
  }

  /**
   * Run one tool on the persona's client. `kind` is the target's kind from
   * the scope check; a `user` target (reply only) is opened first, and the
   * opened conversation ID is set on `dm.opened` right away so the caller can
   * name it when a later call fails. Thrown failures (Slack or otherwise)
   * propagate to the caller.
   */
  async function runTool(
    name: string,
    args: Record<string, any>,
    persona: Persona,
    web: WebClient,
    kind: PersonaTargetKind,
    dm: { opened?: string },
  ) {
    switch (name) {
      // ---------------------------------------------------------------------
      // reply
      // ---------------------------------------------------------------------
      case 'reply': {
        let chatId: string = args.chat_id
        const text: string = args.text
        const threadTs: string | undefined = args.thread_ts
        const files: string[] | undefined = args.files
        const messageId: string | undefined = args.message_id

        // File exfiltration guard, for every file before any Slack call.
        for (const filePath of files ?? []) {
          try {
            assertSendable(filePath)
          } catch (err) {
            return toolError(err instanceof Error ? err.message : String(err))
          }
        }

        // A user ID is never posted to: open the DM, then act only in it.
        let where = chatId
        if (kind === 'user') {
          const opened = await openDmConversation(name, persona, web, chatId)
          if (!opened.ok) return toolError(opened.message)
          dm.opened = opened.id
          where = `${opened.id} (the DM with ${chatId})`
          chatId = opened.id
        }

        const settings = getReplySettings()
        const chunks = chunkText(text, settings.reply_chunk_limit, settings.reply_chunk_mode)

        let lastTs = ''
        let firstChunk = true
        for (const chunk of chunks) {
          const res = await web.chat.postMessage({
            channel: chatId,
            text: chunk,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false,
          })
          lastTs = (res.ts as string) || lastTs

          if (firstChunk) {
            firstChunk = false
            const reaction = settings.ack_reaction
            if (messageId && consumeAck(chatId, messageId) && reaction) {
              try {
                await web.reactions.remove({
                  channel: chatId,
                  timestamp: messageId,
                  name: reaction,
                })
              } catch { /* non-critical */ }
            }
          }
        }

        // Check each file again right before its upload: the text posts above
        // widen the window in which a symlink could be re-pointed at a file
        // the up-front pass would have refused.
        let uploaded = 0
        for (const filePath of files ?? []) {
          try {
            assertSendable(filePath)
          } catch (err) {
            const posted = `${chunks.length} message(s) to ${where}${lastTs ? ` [ts: ${lastTs}]` : ''}`
            return toolError(
              `${err instanceof Error ? err.message : String(err)} ` +
                `The reply text was already posted (${posted}); ` +
                `${uploaded} of ${files!.length} file(s) were uploaded before this refusal.`,
            )
          }
          const uploadArgs: Record<string, any> = {
            channel_id: chatId,
            file: resolve(filePath),
          }
          if (threadTs) uploadArgs.thread_ts = threadTs
          await web.filesUploadV2(uploadArgs as any)
          uploaded++
        }

        return {
          content: [
            {
              type: 'text',
              text: `Sent ${chunks.length} message(s)${files?.length ? ` + ${files.length} file(s)` : ''} to ${where}${lastTs ? ` [ts: ${lastTs}]` : ''}`,
            },
          ],
        }
      }

      // ---------------------------------------------------------------------
      // react
      // ---------------------------------------------------------------------
      case 'react': {
        await web.reactions.add({
          channel: args.chat_id,
          timestamp: args.message_id,
          name: args.emoji,
        })
        return {
          content: [{ type: 'text', text: `Reacted :${args.emoji}: to ${args.message_id}` }],
        }
      }

      // ---------------------------------------------------------------------
      // edit_message
      // ---------------------------------------------------------------------
      case 'edit_message': {
        await web.chat.update({
          channel: args.chat_id,
          ts: args.message_id,
          text: args.text,
        })
        return {
          content: [{ type: 'text', text: `Edited message ${args.message_id}` }],
        }
      }

      // ---------------------------------------------------------------------
      // fetch_messages
      // ---------------------------------------------------------------------
      case 'fetch_messages': {
        const channel: string = args.channel
        const limit = Math.min(args.limit || 20, 100)
        const threadTs: string | undefined = args.thread_ts

        let messages: any[]
        if (threadTs) {
          const res = await web.conversations.replies({ channel, ts: threadTs, limit })
          messages = res.messages || []
        } else {
          const res = await web.conversations.history({ channel, limit })
          messages = (res.messages || []).reverse()
        }

        const formatted = await Promise.all(
          messages.map(async (m: any) => {
            const userName = m.user ? await resolveUserName(persona.key, m.user) : 'unknown'
            return {
              ts: m.ts,
              user: userName,
              user_id: m.user,
              text: m.text,
              thread_ts: m.thread_ts,
              files: m.files?.map((f: any) => ({
                name: f.name,
                mimetype: f.mimetype,
                size: f.size,
              })),
            }
          }),
        )

        return {
          content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        }
      }

      // ---------------------------------------------------------------------
      // download_attachment — file fetches authorised with the persona's own
      // bot token, read from its client at call time, never logged, and sent
      // only to https://files.slack.com (see fetchSlackHostedFile).
      // ---------------------------------------------------------------------
      case 'download_attachment': {
        const channel: string = args.chat_id
        const messageTs: string = args.message_id

        const token = web.token
        if (!token) {
          return toolError(
            `Tool "${name}" refused: the Slack bot token for persona ${renderPersonaRef(persona.name, persona.key)} is not available.`,
          )
        }

        const res = await web.conversations.replies({
          channel,
          ts: messageTs,
          limit: 1,
          inclusive: true,
        })

        const msg = res.messages?.[0]
        if (!msg?.files?.length) {
          return { content: [{ type: 'text', text: 'No files found on that message.' }] }
        }

        // The bearer token goes only to https://files.slack.com. Every file is
        // checked before any download; an external (remote) file or any other
        // URL refuses the whole call. Refusals never echo the URL.
        const ref = renderPersonaRef(persona.name, persona.key)
        const files = msg.files as any[]
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const url = file.url_private_download || file.url_private
          const external = file.is_external === true || file.mode === 'external'
          if (!external && !url) continue
          if (external || !isSlackHostedFileUrl(url)) {
            return toolError(
              `Tool "${name}" refused: file ${fileLabel(file, i)} is not hosted by Slack, so persona ${ref}'s ` +
                `bot token is not sent for it (only ${SLACK_FILES_ORIGIN} is trusted).`,
            )
          }
        }

        const paths: string[] = []
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const url = file.url_private_download || file.url_private
          if (!url) continue

          const safeName = sanitizeFilename(file.name || `file_${Date.now()}`)
          const outPath = join(inboxDir, `${messageTs.replace('.', '_')}_${safeName}`)

          const fetched = await fetchSlackHostedFile(url, token)
          if (fetched.kind === 'failed') continue
          if (fetched.kind === 'refused') {
            const why =
              fetched.reason === 'offsite'
                ? `redirected away from ${SLACK_FILES_ORIGIN}, so it is not hosted by Slack`
                : `redirected more than ${MAX_DOWNLOAD_REDIRECTS} times`
            const already = paths.length
              ? ` Already downloaded before this refusal:\n${paths.join('\n')}`
              : ''
            return toolError(
              `Tool "${name}" refused: file ${fileLabel(file, i)} ${why}; persona ${ref}'s ` +
                `bot token is only sent to ${SLACK_FILES_ORIGIN}.${already}`,
            )
          }

          writeFileSync(outPath, fetched.body)
          paths.push(outPath)
        }

        return {
          content: [
            {
              type: 'text',
              text: paths.length
                ? `Downloaded ${paths.length} file(s):\n${paths.join('\n')}`
                : 'Failed to download any files.',
            },
          ],
        }
      }

      default:
        return toolError(`Unknown tool: ${name}`)
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const args = (request.params.arguments || {}) as Record<string, any>

    const toolTarget = Object.hasOwn(TOOL_TARGET, name) ? TOOL_TARGET[name] : undefined
    if (!toolTarget) return toolError(`Unknown tool: ${name}`)

    // The calling instance's persona, resolved now (not at session creation).
    const key = entry.personaKey
    if (!key) return toolError(`Tool "${name}" refused: this session is not matched to a persona.`)
    const persona = getPersona(key)
    if (!persona) return toolError(`Tool "${name}" refused: persona key=${key} is not an applied persona.`)

    // Posting scope, before the dry-run branch (b.av2 SR-5.1).
    const rawTarget = args[toolTarget.arg]
    const target = typeof rawTarget === 'string' ? rawTarget : ''
    const scope = checkPersonaTarget(persona, target, toolTarget.action)
    if (!scope.allowed) return toolError(scope.message)

    if (isDryRun()) return dryRunResult(name, args, scope.kind)

    const ref = renderPersonaRef(persona.name, persona.key)
    const web = clientFor(key)
    if (!web) return toolError(`Tool "${name}" refused: the Slack client for persona ${ref} is not available.`)

    const dm: { opened?: string } = {}
    try {
      return await runTool(name, args, persona, web, scope.kind, dm)
    } catch (err) {
      // A DM target is named, so a refusal of a D… conversation the persona's
      // app is not in (or of the DM opened for a user) says where it failed;
      // for a user target, the conversation opened for it is named too.
      const failedFor = `Tool "${name}" failed for persona ${ref}` +
        (scope.kind === 'channel' ? '' : ` on DM target ${JSON.stringify(target)}`) +
        (dm.opened ? ` (conversation ${dm.opened})` : '')
      // Token-safe: a Slack library error's message and headers can hold a token.
      console.error(`[slack] ${failedFor}: ${describeThrownValue(err)}`)
      // Not every failure here is a Slack call (a missing argument, a file
      // write, a network error), so the wording is generic; a Slack platform
      // error code is kept when there is one.
      const reason = slackPlatformReason(err)
      return toolError(`${failedFor}: the tool call failed${reason ? ` (${reason})` : ''}.`)
    }
  })

  return server
}

// ---------------------------------------------------------------------------
// Expose registry internals for testing / shutdown
// ---------------------------------------------------------------------------

/** Iterate all registered sessions (for graceful shutdown). */
export function getAllSessions(): IterableIterator<SessionEntry> {
  return registry.values()
}

/** For testing: reset all state. */
export function _resetRegistry(): void {
  registry.clear()
  mcpSessionIdToPersonaKey.clear()
  pendingSessionMap.clear()
}
