/**
 * registry.ts — Persona-keyed MCP session registry and the per-session MCP
 * Server with its persona-scoped Slack tools.
 *
 * Session identity (b.av2 SR-6.3): an MCP session is identified by the working
 * directory its client reports through `roots/list`. That directory is
 * compared by real path (`resolveRealPath`) with the applied personas' working
 * directories and maps to exactly one persona (`matchPersonaByRootsPath`),
 * except that a session opened from the working directory of an old life
 * that may still be running is registered as no persona's session until
 * that wait ends (b.av2 SR-6.3 as amended by b.jg5 SRJ-1505; SRJ-809,
 * SRJ-810): `decideSessionAdmission` asks the injected held-directory query
 * before it matches any persona, and refuses such a session (`held`). A
 * session is admitted only while that persona is up (b.av2 SR-6.4,
 * `decideSessionAdmission`, with the up check injected), and a persona that
 * stops being up has its session dropped (`dropPersonaSession`). The
 * registry is keyed by persona key; a newer session for a persona replaces the
 * older one. A session sits in the pending map from its MCP init request until
 * its roots are matched, and its entry stub is promoted in place so the tool
 * handlers that closed over it read the persona key it is promoted under.
 *
 * Tool scope (b.av2 SR-5.1, b.deo SRI-501, SRI-601; b.av2 SR-3.1): every
 * session lists six tools in both modes. The five Slack tools (`reply`,
 * `react`, `edit_message`, `fetch_messages`, `download_attachment`) keep
 * their names and inputs. Each call resolves the calling session's persona,
 * the channel mode and that persona's Slack client at call time, and posts as
 * the persona with no username or icon override. While its `dm.enabled` is on,
 * it may target its DM conversations and (for `reply`) user IDs in both modes
 * (`checkPersonaTarget`). Its channel targets depend on the mode: in
 * declarative mode only the channels in the persona's current applied
 * configuration; in fungible mode any channel ID, with Slack enforcing
 * membership, and Slack's refusal returned as a tool error naming the
 * persona, the channel and Slack's error code (b.deo SRI-602,
 * `slackRefusalToolErrorText`).
 *
 * The sixth tool, `set_channel_delivery` (b.deo SRI-501 to SRI-507), has no
 * Slack target and makes no Slack call, in or out of dry run. It stores the
 * persona's channel delivery (`mentions` or `all`) for one channel it heard
 * in fungible mode, or already holds a choice for, in the one stored-choice
 * store (`src/channel-delivery.ts`), and the choice applies from the next
 * event under the loop guard. It resolves the persona at call time as the
 * other tools do, also refusing a retiring key and a session that is not the
 * one the registry holds for its key (b.deo SRI-502), then checks SRI-503's rules in
 * order; in declarative mode every call is refused.
 *
 * Instructions: `MCP_INSTRUCTIONS` is exported as the exact string every
 * session server sends as its MCP `instructions`, in both modes (b.deo
 * SRI-604), so the shipped-docs audit reads what instances receive.
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
import {
  CHANNEL_DELIVERY_FILE_NAME,
  CHANNEL_DELIVERY_SET_STORED,
  CHANNEL_DELIVERY_SET_UNREADABLE,
  CHANNEL_DELIVERY_SET_WRITE_FAILED,
  channelDeliveryDeclarationOf,
  SET_CHANNEL_DELIVERY_TOOL,
  type ChannelDeliverySetInvalidField,
  type ChannelDeliveryStore,
} from './channel-delivery.ts'
import {
  CHANNEL_ID_RE,
  DM_CONTACT_RE,
  ECHOABLE_KEY_NAME_RE,
  MCP_SERVER_NAME,
  resolveRealPath,
  type ChannelMode,
  type DeliveryMode,
  type Persona,
  type ReplySettings,
} from './config.ts'
import { channelDeliveryFor, type ChannelDeliveryResult } from './delivery-decision.ts'
import { chunkText, sanitizeFilename } from './lib.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { describeSlackCallFailure, describeThrownValue, renderLogMessageText, slackPlatformReason } from './persona-connection-errors.ts'
import { DM_OPEN_SCOPE, MISSING_SCOPE_ERROR, fungibleDestinationsOf } from './persona-destination.ts'
import { channelDeliverySetCause, formatPersonaDiagnostic, PERSONA_CHANNEL_DELIVERY_SET } from './persona-diagnostics.ts'
import { isDryRun } from './tokens.ts'

export { SET_CHANNEL_DELIVERY_TOOL }
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
// Session admission (b.av2 SR-6.3 as amended by b.jg5 SRJ-1505, SR-6.4)
// ---------------------------------------------------------------------------

/**
 * A directory held for an old life that may still be running (b.jg5
 * SRJ-809, SRJ-810), as the held-directory query answers it: the held
 * directory and every held old instance id on it (two holds on one
 * directory give two ids).
 */
export interface SessionHeldDirectory {
  /** The held directory, as its real path. */
  readonly directory: string
  /** Every held old instance id on it, in the hold set's begin order. */
  readonly instanceIds: readonly string[]
}

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
  /**
   * The held-directory query (b.jg5 SRJ-810, SRJ-1505): given the session's
   * roots real path, the held directory and every held old instance id on
   * it, or undefined when that path is not held (production: the session
   * manager's `oldLifeHeldDirectory`, which answers undefined before `main()`
   * has installed the hold set). Asked before any persona is matched. A
   * query that throws counts as held (fail safe), with no id known. Absent:
   * nothing is held.
   */
  heldDirectory?: (rootsRealPath: string) => SessionHeldDirectory | undefined
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
   * The roots working directory is held for an old life that may still be
   * running (b.jg5 SRJ-810, SRJ-1505): refuse the session, whichever persona
   * names the directory; register it as no persona's.
   */
  | { kind: 'held'; directory: string; instanceIds: readonly string[] }

/**
 * The one line `decideSessionAdmission` logs when it refuses a session
 * opened from a held directory (b.jg5 SRJ-810, SRJ-1505): the held directory
 * and every held old instance id, each JSON-quoted, with, when the query
 * threw, what it threw:
 *
 *   [slack] Session refused: its working directory "<D>" is held for an old life that may still be running (instanceId="<id>"[, instanceId="<id>" …]) — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)
 *   [slack] Session refused: its working directory "<D>" is held for an old life that may still be running (the held-directory query failed: <thrown> — taken as held) — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)
 *
 * Carries no token. Pure.
 */
export function sessionHeldRefusalLine(directory: string, instanceIds: readonly string[], failure?: string): string {
  const quote = (text: string): string => JSON.stringify(renderLogMessageText(text))
  const what =
    failure !== undefined
      ? `the held-directory query failed: ${failure} — taken as held`
      : instanceIds.length === 0
        ? 'no instance id given'
        : instanceIds.map((id) => `instanceId=${quote(id)}`).join(', ')
  return (
    `[slack] Session refused: its working directory ${quote(directory)} is held for an old life that may still be running ` +
    `(${what}) — registered as no persona's session until the hold ends (b.jg5 SRJ-810, SRJ-1505)`
  )
}

/**
 * Decide whether a session whose roots working directory is `rootsPath` may
 * register (b.av2 SR-6.3 as amended by b.jg5 SRJ-1505, SR-6.4): "MCP sessions
 * still identify by the roots/list working directory, compared by real path,
 * which maps to exactly one persona, except that a session opened from the
 * working directory of an old life that may still be running (a retired
 * key's, or a live pre-persona row's or any other swept row's whose
 * start-sweep kill did not succeed) is registered as no persona's session
 * until that wait ends (b.jg5 SRJ-809, SRJ-810)."
 *
 * First, before any persona is matched, the held-directory query
 * (`options.heldDirectory`) is asked with the roots real path
 * (`resolveRealPath`: a symlink resolves, and a missing directory compares by
 * its lexical path): a held directory answers `held`, whichever persona now
 * names it, up or not, and when none does, with one line naming the
 * directory and every held old instance id (`sessionHeldRefusalLine`). Then
 * the session is matched to one persona by real path
 * (`matchPersonaByRootsPath`) and admitted only when that persona is up.
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
  const log = options.log ?? ((line: string) => console.error(line))
  const held = heldDirectoryReading(rootsPath, options)
  if (held !== undefined) {
    log(sessionHeldRefusalLine(held.directory, held.instanceIds, held.failure))
    return { kind: 'held', directory: held.directory, instanceIds: held.instanceIds }
  }
  const persona = matchPersonaByRootsPath(rootsPath, personas, options)
  if (!persona) return { kind: 'unmatched' }
  if (options.isPersonaUp(persona.key)) return { kind: 'admitted', persona }
  const why = options.describeNotUp ? ` (${options.describeNotUp(persona.key)})` : ''
  log(
    `[slack] Session refused: persona ${renderPersonaRef(persona.name, persona.key)} is not up${why} — ` +
      'not registered; its instance is kept and may register once the persona is up',
  )
  return { kind: 'not-up', persona }
}

/**
 * The held-directory query's reading of `rootsPath` (b.jg5 SRJ-810): asked
 * with its real path; an answer naming at least one instance id is held
 * (its directory, or the real path when the answer names none); undefined,
 * an answer with no id, or no query is not held. A query that throws counts
 * as held, at the real path, with no id and `failure` set. Never throws.
 */
function heldDirectoryReading(
  rootsPath: string,
  options: SessionAdmissionOptions,
): { directory: string; instanceIds: readonly string[]; failure?: string } | undefined {
  const query = options.heldDirectory
  if (query === undefined) return undefined
  const target = resolveRealPath(rootsPath, options.realpath)
  let answer: SessionHeldDirectory | undefined
  try {
    answer = query(target)
  } catch (err) {
    return { directory: target, instanceIds: [], failure: describeThrownValue(err) }
  }
  const ids = Array.isArray(answer?.instanceIds) ? answer.instanceIds.filter((id) => typeof id === 'string' && id !== '') : []
  if (ids.length === 0) return undefined
  const directory = typeof answer?.directory === 'string' && answer.directory !== '' ? answer.directory : target
  return { directory, instanceIds: ids }
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
  /**
   * Consume persona `personaKey`'s pending ack entry for the conversation and
   * message — returns true if that persona's own entry existed
   */
  consumeAck: (personaKey: string, channelId: string, messageTs: string) => boolean
  /** TCP port the MCP HTTP server is listening on (retained for diagnostics). */
  serverPort: number
  /**
   * The channel mode of the configuration in effect (b.deo SRI-201,
   * SRI-601), read on every tool call together with the persona and never
   * copied at session creation (production: `channelModeOf` over the applied
   * configuration). Absent: declarative mode.
   */
  getChannelMode?: () => ChannelMode
  /**
   * The one stored-choice store `main()` loads (b.deo SRI-403, SRI-502),
   * read at each `set_channel_delivery` call (production: the server's
   * module-scope holder). Undefined while no store is bound (before `main()`
   * loads it): the call is refused and nothing is written. Absent: the same.
   */
  getChannelDelivery?(): SessionChannelDeliveryStore | undefined
  /**
   * A read-only view of persona `key`'s heard set (b.deo SRI-307, SRI-503),
   * read at each `set_channel_delivery` call (production: the one routing's
   * `heardChannels`). Absent: the heard set is empty.
   */
  heardChannels?(key: string): ReadonlySet<string>
  /**
   * The applied personas of the configuration in effect (b.deo SRI-305,
   * SRI-504), read at each `set_channel_delivery` call for the loop guard's
   * input. Absent: only the calling persona.
   */
  getAppliedPersonas?(): readonly Persona[]
  /**
   * Receives the `persona-channel-delivery-set` line of each accepted
   * `set_channel_delivery` call (b.deo SRI-505, SRI-901): the `[slack]`
   * stream of `server.log`, as the routing's `log` receives
   * `persona-invited-channel` (production: `console.error`). Absent:
   * `console.error`.
   */
  log?: (line: string) => void
}

/**
 * What `set_channel_delivery` uses of the stored-choice store (b.deo
 * SRI-502 to SRI-506): its path, readability, lookups, the retiring keys and
 * the one write of a choice. `ChannelDeliveryStore` satisfies it as it is.
 */
export type SessionChannelDeliveryStore = Pick<
  ChannelDeliveryStore,
  'path' | 'readable' | 'storedChoice' | 'storedChannels' | 'set' | 'isRetiring'
>

// ---------------------------------------------------------------------------
// Posting scope (b.av2 SR-5.1, b.deo SRI-601)
// ---------------------------------------------------------------------------

/** A DM conversation ID. A group DM (`G…`, `mpim`) never matches. */
const DM_CONVERSATION_ID_RE = /^D[A-Z0-9]+$/

/**
 * What a tool target is, for one persona in one channel mode (b.av2 SR-5.1,
 * b.deo SRI-601):
 * - `channel`: in declarative mode, the `id` of one of the persona's
 *   configured channels; in fungible mode, any value matching
 *   `CHANNEL_ID_RE` (a `C…` or `G…` ID);
 * - `dm`: a DM conversation ID (`D…`);
 * - `user`: a Slack user ID (`U…`/`W…`, the `dm.contact` format);
 * - `other`: anything else (in declarative mode another channel or a group
 *   DM; in either mode a malformed ID, an empty value …).
 */
type PersonaTargetKind = 'channel' | 'dm' | 'user' | 'other'

/**
 * Classify `target` for `persona` in `mode`. In declarative mode a
 * configured channel wins over the ID shapes; in fungible mode the persona's
 * `channels` is never read (b.deo SRI-202) and the channel-ID shape decides.
 * Pure: no Slack call, logging or state.
 */
function classifyPersonaTarget(persona: Persona, target: string, mode: ChannelMode): PersonaTargetKind {
  if (mode === 'fungible') {
    if (CHANNEL_ID_RE.test(target)) return 'channel'
  } else if (target !== '' && persona.channels.some((c) => c.id === target)) {
    return 'channel'
  }
  if (DM_CONVERSATION_ID_RE.test(target)) return 'dm'
  if (DM_CONTACT_RE.test(target)) return 'user'
  return 'other'
}

/**
 * The reason a fungible-mode refusal of a target that is neither a channel ID
 * nor a DM target gives (b.deo SRI-601), after `checkPersonaTarget`'s lead
 * naming the persona and the target.
 */
export const FUNGIBLE_TARGET_REFUSAL = 'it is neither a channel ID nor an allowed DM target.'

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
 * The posting scope of a persona (b.av2 SR-5.1, b.deo SRI-601), decided from
 * the persona and the channel mode as applied now (callers pass both,
 * resolved at call time). `mode` absent is declarative mode.
 * - Declarative mode: a configured channel is allowed, whatever its delivery
 *   mode.
 * - Fungible mode: any target matching `CHANNEL_ID_RE` is allowed, whatever
 *   any persona lists (Slack enforces membership); the persona's `channels`
 *   is not read.
 * - In both modes, a `D…` conversation is allowed only while `dm.enabled` is
 *   on (Slack itself refuses one the persona's app is not in), and a user ID
 *   only for `post` and only while `dm.enabled` is on, as `kind: 'user'`
 *   (open the DM first); for `act` a user ID is refused whatever the switch,
 *   so no read, edit or reaction ever opens a DM.
 * - Everything else is refused: in declarative mode as not a configured
 *   channel, in fungible mode with `FUNGIBLE_TARGET_REFUSAL`.
 * A refusal message names the persona (`renderPersonaRef` with its stored
 * key) and the target. While `dm.enabled` is off, every `D…`/`U…`/`W…`
 * target on any tool gets the DMs-off reason, so the model is never steered
 * to a DM conversation that would be refused too. Pure: no Slack call.
 */
export function checkPersonaTarget(
  persona: Persona,
  target: string,
  action: PersonaTargetAction,
  mode: ChannelMode = 'declarative',
): PersonaTargetCheck {
  const kind = classifyPersonaTarget(persona, target, mode)
  const refuse = (why: string): PersonaTargetCheck => ({
    allowed: false,
    message: `Persona ${renderPersonaRef(persona.name, persona.key)} may not target ${JSON.stringify(target)}: ${why}`,
  })
  if (kind === 'channel') return { allowed: true, kind }
  if (kind === 'other') {
    return refuse(mode === 'fungible' ? FUNGIBLE_TARGET_REFUSAL : `it is not one of the persona's configured channels.`)
  }
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

/**
 * The tool error for a failed call on a channel target in fungible mode
 * (b.deo SRI-602; b.av2 SR-5.1), where Slack enforces membership: it names
 * the tool, the persona (`renderPersonaRef`), the channel and Slack's error
 * code (`slackPlatformReason` of the thrown value, e.g. `not_in_channel` or
 * `channel_not_found`):
 *
 *   Tool "<tool>" failed for persona "<name>" (key=<key>) on channel "<channel>": Slack refused the call (<code>).
 *   Tool "<tool>" failed for persona "<name>" (key=<key>) on channel "<channel>": the tool call failed.
 *
 * The second form is for a failure with no platform code (a network or local
 * failure): no code is named. Only the platform code comes from the thrown
 * value, so the text carries no token. Pure.
 */
export function slackRefusalToolErrorText(
  tool: string,
  persona: Pick<Persona, 'name' | 'key'>,
  channel: string,
  code: string | undefined,
): string {
  const lead = `Tool ${JSON.stringify(tool)} failed for persona ${renderPersonaRef(persona.name, persona.key)} ` +
    `on channel ${JSON.stringify(channel)}`
  return code !== undefined && code !== '' ? `${lead}: Slack refused the call (${code}).` : `${lead}: the tool call failed.`
}

// ---------------------------------------------------------------------------
// Resolution refusals (b.av2 SR-5.1, b.deo SRI-502)
// ---------------------------------------------------------------------------

/**
 * The tool error for a call from a session matched to no persona (b.av2
 * SR-5.1, b.deo SRI-502), the same for every tool:
 *
 *   Tool "<tool>" refused: this session is not matched to a persona.
 *
 * Pure.
 */
export function sessionNotMatchedRefusal(tool: string): string {
  return `Tool "${tool}" refused: this session is not matched to a persona.`
}

/**
 * The tool error for a call whose persona key is not an applied persona's
 * (b.av2 SR-5.1, b.deo SRI-502), the same for every tool. `set_channel_delivery`
 * also gives it for a retiring key and for a session that is not the one the
 * registry holds for its key:
 *
 *   Tool "<tool>" refused: persona key=<key> is not an applied persona.
 *
 * Pure.
 */
export function personaNotAppliedRefusal(tool: string, key: string): string {
  return `Tool "${tool}" refused: persona key=${key} is not an applied persona.`
}

// ---------------------------------------------------------------------------
// set_channel_delivery (b.deo SRI-501 to SRI-507)
// ---------------------------------------------------------------------------

/**
 * The tool's description (b.deo SRI-501): it sets how closely the persona
 * listens in one channel its Slack app was invited to, between @mentions and
 * broadcasts only (`mentions`) and every message (`all`); it is called when
 * someone in that channel asks for it; it works only when the operator has
 * turned invited channels on.
 */
export const SET_CHANNEL_DELIVERY_DESCRIPTION =
  "Set how closely your persona listens in one channel its Slack app was invited to: mentions (only @mentions of you and @here or @channel broadcasts) or all (every message). " +
  'Call it when someone in that channel asks for it. ' +
  'It works only when the operator has turned invited channels on; otherwise every call is refused. ' +
  'The choice applies from the next message in that channel and is kept across server restarts.'

/** The description of the tool's `channel` input (b.deo SRI-501). */
export const SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION =
  'The channel ID (C... or G...) of a channel your persona has heard a message from, or already holds a choice for'

/** The description of the tool's `delivery` input (b.deo SRI-501). */
export const SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION =
  '"mentions" (only @mentions of you and @here or @channel broadcasts) or "all" (every message in the channel)'

/** The values the tool's `delivery` input takes, in the order its schema lists them (b.deo SRI-501). */
const SET_CHANNEL_DELIVERY_VALUES: readonly DeliveryMode[] = ['mentions', 'all']

/** Whether `value` is a value the tool's `delivery` input takes: `"mentions"` or `"all"`. */
function isChannelDeliveryValue(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (SET_CHANNEL_DELIVERY_VALUES as readonly string[]).includes(value)
}

/**
 * A channel value a `set_channel_delivery` error may echo (b.deo SRI-503):
 * a string of 1 to 24 characters from `A-Z0-9`. Any other value is not shown.
 */
export const ECHOABLE_CHANNEL_RE = /^[A-Z0-9]{1,24}$/

/**
 * The tool's refusals (b.deo SRI-503), in the order a call is checked; the
 * first rule a call breaks gives its tool error:
 * - `declarative-mode`: the configuration in effect is in declarative mode
 *   (`channelDeliveryDeclarativeRefusal`);
 * - `store-unreadable`: the stored-choice file was unreadable at start, or no
 *   store is bound (`channelDeliveryUnreadableRefusal`);
 * - `delivery-invalid`: `delivery` is not `"mentions"` or `"all"`, a missing
 *   value included (`channelDeliveryValueRefusal`);
 * - `channel-unknown`: the channel is neither in the persona's heard set nor
 *   among its stored choices (`channelDeliveryChannelRefusal`).
 * Every one is checked after the resolution refusals (b.deo SRI-502).
 */
export const SET_CHANNEL_DELIVERY_REFUSALS = [
  'declarative-mode',
  'store-unreadable',
  'delivery-invalid',
  'channel-unknown',
] as const

/** One of `SET_CHANNEL_DELIVERY_REFUSALS`. */
export type SetChannelDeliveryRefusal = (typeof SET_CHANNEL_DELIVERY_REFUSALS)[number]

/** The lead every `set_channel_delivery` refusal shares: the tool and the persona (`renderPersonaRef`). */
function channelDeliveryRefusalLead(name: string, key: string): string {
  return `Tool "${SET_CHANNEL_DELIVERY_TOOL}" refused for persona ${renderPersonaRef(name, key)}`
}

/**
 * Rule 1's tool error (b.deo SRI-503): declarative mode.
 *
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): invited channels are off, and in declarative mode channel delivery is set by the operator in config.json.
 *
 * Pure.
 */
export function channelDeliveryDeclarativeRefusal(name: string, key: string): string {
  return (
    `${channelDeliveryRefusalLead(name, key)}: invited channels are off, and in declarative mode ` +
    'channel delivery is set by the operator in config.json.'
  )
}

/**
 * Rule 2's tool error (b.deo SRI-503): the stored-choice file is unreadable,
 * or no store is bound. `path` is the store's path, or
 * `CHANNEL_DELIVERY_FILE_NAME` when no store is bound.
 *
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): the stored-choice file "<path>" is not readable, so no channel delivery can be stored. To fix: the operator moves the file aside, then restarts the server.
 *
 * Pure.
 */
export function channelDeliveryUnreadableRefusal(name: string, key: string, path: string): string {
  return (
    `${channelDeliveryRefusalLead(name, key)}: the stored-choice file ${JSON.stringify(path)} is not readable, ` +
    'so no channel delivery can be stored. To fix: the operator moves the file aside, then restarts the server.'
  )
}

/**
 * Rule 3's tool error (b.deo SRI-503): `delivery` is not `"mentions"` or
 * `"all"`. The value is named, JSON-encoded, only when it is a string
 * matching `ECHOABLE_KEY_NAME_RE` (`src/config.ts`); otherwise the error
 * says it is not shown.
 *
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): delivery "<value>" is not "mentions" or "all".
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): delivery is not "mentions" or "all" (the value given is not shown).
 *
 * Pure.
 */
export function channelDeliveryValueRefusal(name: string, key: string, value: unknown): string {
  const allowed = SET_CHANNEL_DELIVERY_VALUES.map((v) => JSON.stringify(v)).join(' or ')
  const lead = channelDeliveryRefusalLead(name, key)
  return typeof value === 'string' && ECHOABLE_KEY_NAME_RE.test(value)
    ? `${lead}: delivery ${JSON.stringify(value)} is not ${allowed}.`
    : `${lead}: delivery is not ${allowed} (the value given is not shown).`
}

/**
 * Rule 4's tool error (b.deo SRI-503): the channel is not known, neither in
 * the persona's heard set nor among its stored choices. The channel is
 * named, JSON-encoded, only when it matches `ECHOABLE_CHANNEL_RE`; otherwise
 * the error says it is not shown.
 *
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): channel "<channel>" is not known: it is not a channel this persona has heard a message from in fungible mode, or holds a choice for. Only a public or private channel that is not externally shared can be set.
 *   Tool "set_channel_delivery" refused for persona "<name>" (key=<key>): the channel is not known (the value given is not shown): it is not a channel this persona has heard a message from in fungible mode, or holds a choice for. Only a public or private channel that is not externally shared can be set.
 *
 * Pure.
 */
export function channelDeliveryChannelRefusal(name: string, key: string, channel: unknown): string {
  const what = typeof channel === 'string' && ECHOABLE_CHANNEL_RE.test(channel)
    ? `channel ${JSON.stringify(channel)} is not known`
    : 'the channel is not known (the value given is not shown)'
  return (
    `${channelDeliveryRefusalLead(name, key)}: ${what}: it is not a channel this persona has heard a message from ` +
    'in fungible mode, or holds a choice for. Only a public or private channel that is not externally shared can be set.'
  )
}

/**
 * The result of an accepted call (b.deo SRI-504): the channel, the stored
 * choice, and the persona's channel delivery there from the next event,
 * `result` (`channelDeliveryFor` with the choice just stored). When the loop
 * guard holds the channel at `mentions`, it says so and that the channel is
 * another persona's fungible destination.
 *
 *   Stored <stored> as your channel delivery for channel <channel>. From the next message in that channel, your channel delivery there is <delivery>.
 *   Stored <stored> as your channel delivery for channel <channel>. From the next message in that channel, your channel delivery there is mentions: the channel is another persona's fungible destination, where its permission prompts and notices go, so the loop guard holds it at mentions whatever is stored.
 *
 * Pure.
 */
export function channelDeliverySetResultText(channel: string, stored: DeliveryMode, result: ChannelDeliveryResult): string {
  const lead = `Stored ${stored} as your channel delivery for channel ${channel}. ` +
    `From the next message in that channel, your channel delivery there is ${result.delivery}`
  return result.heldByLoopGuard
    ? `${lead}: the channel is another persona's fungible destination, where its permission prompts and notices go, ` +
      `so the loop guard holds it at ${result.delivery} whatever is stored.`
    : `${lead}.`
}

/**
 * The tool error of a failed write (b.deo SRI-404, SRI-506): names the
 * persona and the file. Memory is unchanged; the store logs its own
 * `[slack] channel-delivery:` line.
 *
 *   Tool "set_channel_delivery" failed for persona "<name>" (key=<key>): the stored-choice file "<path>" could not be written, so the choice was not stored and channel delivery is unchanged.
 *
 * Pure.
 */
export function channelDeliveryWriteFailedText(name: string, key: string, path: string): string {
  return (
    `Tool "${SET_CHANNEL_DELIVERY_TOOL}" failed for persona ${renderPersonaRef(name, key)}: the stored-choice file ` +
    `${JSON.stringify(path)} could not be written, so the choice was not stored and channel delivery is unchanged.`
  )
}

/**
 * The tool error when the store refuses an input it would not write (its
 * `invalid` answer, such as a clock that gives no timestamp): nothing is
 * written and memory is unchanged.
 *
 *   Tool "set_channel_delivery" failed for persona "<name>" (key=<key>): the choice was not stored (the store refused its <field>), so channel delivery is unchanged.
 *
 * Pure.
 */
export function channelDeliveryNotStoredText(name: string, key: string, field: ChannelDeliverySetInvalidField): string {
  return (
    `Tool "${SET_CHANNEL_DELIVERY_TOOL}" failed for persona ${renderPersonaRef(name, key)}: the choice was not stored ` +
    `(the store refused its ${field}), so channel delivery is unchanged.`
  )
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

/**
 * The MCP instructions handed to every bot instance. `createSessionServer`
 * passes this exact value as the server's `instructions`, so a test importing
 * it reads the string instances receive. The example tag's `source` is the MCP
 * server name (`MCP_SERVER_NAME`), which the Claude Code harness renders on
 * every delivered `<channel>` tag.
 */
export const MCP_INSTRUCTIONS = [
  'The sender reads Slack, not this session. Anything you want them to see must go through the reply tool.',
  '',
  `Messages from Slack arrive as <channel source="${MCP_SERVER_NAME}" chat_id="C..." message_id="1234567890.123456" user="display name" user_id="U..." thread_ts="..." ts="..." via="mention">.`,
  'user_id is the author\'s Slack user ID. When a bot or integration without a user posted the message, the tag carries bot_id instead of user_id.',
  'via says how the message reached you: dm (a direct message to you), mention (you were @mentioned), broadcast (@here or @channel), ' +
    'receive_all_shared (a channel where you and at least one other persona receive every message), ' +
    'receive_all (a channel where you alone receive every message).',
  '<@ID> in message text mentions a Slack user or another persona. Mention another persona the same way, with <@ID>, to address it.',
  'A message without via is an injected prompt (a scheduled prompt or an /interject message). It needs no reply unless it asks for one.',
  'If the tag has attachment_count, call download_attachment(chat_id, message_id) to fetch them.',
  'Reply with the reply tool — pass chat_id back. Use thread_ts to reply in a thread.',
  'Where you may act: every channel message you receive comes from a channel you may act in. ' +
    'With invited channels off, those are the channels your persona is configured into. ' +
    'With invited channels on, they are any channel your persona\'s Slack app is a member of, and Slack refuses the others.',
  `${SET_CHANNEL_DELIVERY_TOOL} sets how closely you listen in a channel: mentions (only @mentions of you and @here or @channel broadcasts) or all (every message). ` +
    'Call it when someone in that channel asks for it. It works only with invited channels on.',
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
      {
        name: SET_CHANNEL_DELIVERY_TOOL,
        description: SET_CHANNEL_DELIVERY_DESCRIPTION,
        inputSchema: {
          type: 'object' as const,
          properties: {
            channel: { type: 'string', description: SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION },
            delivery: {
              type: 'string',
              enum: [...SET_CHANNEL_DELIVERY_VALUES],
              description: SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION,
            },
          },
          required: ['channel', 'delivery'],
        },
      },
    ],
  }))

  // -------------------------------------------------------------------------
  // Tool execution — persona-scoped (b.av2 SR-5.1, b.deo SRI-601; b.av2
  // SR-3.1)
  //
  // Every call resolves the session's persona and the channel mode at call
  // time (the persona from the entry this server closes over, the mode
  // through `deps.getChannelMode`, declarative when it is absent), checks the
  // tool's target against them (`checkPersonaTarget`, before the dry-run
  // branch), and outside dry run makes every Slack call on the persona's own
  // client, with no username or icon override. A refusal is a tool error
  // (`isError: true`), never a protocol error, and makes no Slack call. In
  // fungible mode, a failed call on a channel target returns
  // `slackRefusalToolErrorText` (b.deo SRI-602).
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

          // The calling persona's own ack reaction, removed through its own
          // client at most once (first chunk), only when its own entry for
          // this message existed. `chatId` is the conversation posted to (for
          // a user target, the DM just opened).
          if (firstChunk) {
            firstChunk = false
            const reaction = settings.ack_reaction
            if (messageId && consumeAck(persona.key, chatId, messageId) && reaction) {
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

  // -------------------------------------------------------------------------
  // set_channel_delivery (b.deo SRI-501 to SRI-507; resolution as b.av2
  // SR-5.1 and SR-6.5 as amended by b.jg5 SRJ-1507, beside b.deo SRI-307 and
  // SRI-502)
  //
  // One synchronous stretch from reading the entry's persona key to the
  // store's write, with no await, so no confirmed apply's step 1 comes
  // between the persona resolved and the declaration stored (b.deo SRI-502).
  // Resolution first: a session matched to no persona, a key that is not an
  // applied persona's, a retiring key (the store's `isRetiring`), and a
  // session entry that is not the one the registry holds for its key (dropped
  // by `dropPersonaSession` or replaced by a newer registration) each get the
  // other tools' refusal. Then SRI-503's rules, in order. A refused call
  // stores, writes and logs nothing. An accepted call makes one store write
  // and logs one `persona-channel-delivery-set` line after it. The tool never
  // passes `checkPersonaTarget`, never reads a client and never makes a Slack
  // call; dry run is not consulted, so it stores as outside dry run (b.deo
  // SRI-507).
  // -------------------------------------------------------------------------

  function setChannelDelivery(name: string, args: Record<string, unknown>) {
    const key = entry.personaKey
    if (!key) return toolError(sessionNotMatchedRefusal(name))
    const persona = getPersona(key)
    if (!persona) return toolError(personaNotAppliedRefusal(name, key))
    const store = deps.getChannelDelivery?.()
    if (store?.isRetiring(key) === true) return toolError(personaNotAppliedRefusal(name, key))
    if (getSessionByPersona(key) !== entry) return toolError(personaNotAppliedRefusal(name, key))

    // b.deo SRI-503's rules, in order; the first broken gives the error.
    const mode: ChannelMode = deps.getChannelMode?.() ?? 'declarative'
    if (mode !== 'fungible') return toolError(channelDeliveryDeclarativeRefusal(persona.name, key))
    if (store === undefined || !store.readable) {
      return toolError(channelDeliveryUnreadableRefusal(persona.name, key, store?.path ?? CHANNEL_DELIVERY_FILE_NAME))
    }
    const delivery = args['delivery']
    if (!isChannelDeliveryValue(delivery)) return toolError(channelDeliveryValueRefusal(persona.name, key, delivery))
    const channel = args['channel']
    const known = typeof channel === 'string' && channel !== '' &&
      ((deps.heardChannels?.(key).has(channel) ?? false) || store.storedChannels(key).includes(channel))
    if (!known) return toolError(channelDeliveryChannelRefusal(persona.name, key, channel))

    // b.deo SRI-504: one write, with P's declaration from the configuration in effect.
    const outcome = store.set(key, channel, delivery, channelDeliveryDeclarationOf(persona))
    switch (outcome.kind) {
      case CHANNEL_DELIVERY_SET_STORED:
        break
      case CHANNEL_DELIVERY_SET_WRITE_FAILED:
        // b.deo SRI-506: the store logged its own failed-write line; memory is unchanged.
        return toolError(channelDeliveryWriteFailedText(persona.name, key, outcome.path))
      case CHANNEL_DELIVERY_SET_UNREADABLE:
        return toolError(channelDeliveryUnreadableRefusal(persona.name, key, outcome.path))
      default:
        return toolError(channelDeliveryNotStoredText(persona.name, key, outcome.field))
    }

    // P's channel delivery there from the next event (b.deo SRI-305, SRI-504):
    // the one loop guard over the applied personas' destinations, built as the
    // routing builds them, with the choice just stored. Rule 1 passed, so the
    // mode read above is fungible, and the destination rule is given that
    // switch.
    const applied = deps.getAppliedPersonas?.() ?? [persona]
    const result = channelDeliveryFor(key, channel, {
      fungibleDestinations: fungibleDestinationsOf({ allow_invited_channels: true }, applied),
      storedChoices: store,
    })
    // b.deo SRI-505, SRI-901, SRI-902: one line per accepted call, after the
    // write, to the `[slack]` stream only.
    const log = deps.log ?? ((line: string) => console.error(line))
    log(formatPersonaDiagnostic({
      class: PERSONA_CHANNEL_DELIVERY_SET,
      name: persona.name,
      key,
      index: persona.index,
      cause: channelDeliverySetCause(channel, outcome.previous, delivery, result.delivery),
    }))
    return { content: [{ type: 'text', text: channelDeliverySetResultText(channel, delivery, result) }] }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const args = (request.params.arguments || {}) as Record<string, any>

    // set_channel_delivery has no Slack target, so it never reaches the
    // target lookup, the scope check or the dry-run branch (b.deo SRI-502).
    if (name === SET_CHANNEL_DELIVERY_TOOL) return setChannelDelivery(name, args)

    const toolTarget = Object.hasOwn(TOOL_TARGET, name) ? TOOL_TARGET[name] : undefined
    if (!toolTarget) return toolError(`Unknown tool: ${name}`)

    // The calling instance's persona, resolved now (not at session creation).
    const key = entry.personaKey
    if (!key) return toolError(sessionNotMatchedRefusal(name))
    const persona = getPersona(key)
    if (!persona) return toolError(personaNotAppliedRefusal(name, key))
    // The channel mode, read now with the persona (b.deo SRI-201, SRI-601).
    const mode: ChannelMode = deps.getChannelMode?.() ?? 'declarative'

    // Posting scope, before the dry-run branch (b.av2 SR-5.1, b.deo SRI-601).
    const rawTarget = args[toolTarget.arg]
    const target = typeof rawTarget === 'string' ? rawTarget : ''
    const scope = checkPersonaTarget(persona, target, toolTarget.action, mode)
    if (!scope.allowed) return toolError(scope.message)

    if (isDryRun()) return dryRunResult(name, args, scope.kind)

    const ref = renderPersonaRef(persona.name, persona.key)
    const web = clientFor(key)
    if (!web) return toolError(`Tool "${name}" refused: the Slack client for persona ${ref} is not available.`)

    const dm: { opened?: string } = {}
    try {
      return await runTool(name, args, persona, web, scope.kind, dm)
    } catch (err) {
      // Fungible mode, channel target (b.deo SRI-602): Slack enforces
      // membership, so its refusal names the persona, the channel and
      // Slack's error code. The log line stays token-safe.
      if (mode === 'fungible' && scope.kind === 'channel') {
        console.error(
          `[slack] Tool "${name}" failed for persona ${ref} on channel ${JSON.stringify(target)}: ${describeThrownValue(err)}`,
        )
        return toolError(slackRefusalToolErrorText(name, persona, target, slackPlatformReason(err)))
      }
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
