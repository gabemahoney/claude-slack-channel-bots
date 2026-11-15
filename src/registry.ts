/**
 * registry.ts — Persona-keyed MCP session registry and the per-session MCP
 * Server with its persona-scoped Slack tools.
 *
 * Session identity: an MCP session is identified by the working
 * directory its client reports through `roots/list`. That directory is
 * compared by real path (`resolveRealPath`) with the applied personas' working
 * directories and maps to exactly one persona (`matchPersonaByRootsPath`),
 * except that a session opened from the working directory of an old life
 * that may still be running is registered as no persona's session until
 * that wait ends: `decideSessionAdmission` asks the injected held-directory query
 * before it matches any persona, and refuses such a session (`held`). A
 * session is admitted only while that persona is up (
 * `decideSessionAdmission`, with the up check injected), and a persona that
 * stops being up has its session dropped (`dropPersonaSession`). The
 * registry is keyed by persona key; a newer session for a persona replaces the
 * older one. A session sits in the pending map from its MCP init request until
 * its roots are matched, and its entry stub is promoted in place so the tool
 * handlers that closed over it read the persona key it is promoted under.
 *
 * Tool scope: every
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
 * persona, the channel and Slack's error code (
 * `slackRefusalToolErrorText`).
 *
 * The sixth tool, `set_channel_delivery`, makes no Slack call. It binds a
 * caller-retained identifier to the current persona incarnation/channel/value.
 * Fresh assignments require open mode and authenticated current membership;
 * duplicate assignment and retry intents read retained outcomes only. Strict
 * and dry-run sessions can read their own history but cannot create a write.
 *
 * Instructions: `MCP_INSTRUCTIONS` is exported as the exact string every
 * session server sends as its MCP `instructions`, in both modes, so the shipped-docs audit reads what instances receive.
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
import { statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { claimReactAnswer } from './ack-tracker.ts'
import {
  CHANNEL_DELIVERY_FILE_NAME,
  currentChannelDeliveryFacts,
  SET_CHANNEL_DELIVERY_TOOL,
  type ChannelDeliveryCurrentFacts,
  type ChannelDeliveryUnavailableReason,
  type ChannelDeliverySetInvalidField,
  type ChannelDeliveryStore,
} from './channel-delivery.ts'
import { CHANNEL_DELIVERY_INTENTS, validChannelDeliveryAttempt, validChannelDeliveryAttemptId, type BotAttemptResult, type ChannelDeliveryAttemptRequest } from './channel-delivery-attempt.ts'
import type { MembershipReading } from './channel-membership.ts'
import {
  CHANNEL_ID_RE,
  DELIVERY_MODES,
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
import { DM_OPEN_SCOPE, MISSING_SCOPE_ERROR } from './persona-destination.ts'
import { channelDeliverySetCause, formatPersonaDiagnostic, PERSONA_CHANNEL_DELIVERY_SET } from './persona-diagnostics.ts'
import { isDryRun } from './tokens.ts'
import { completionFiles, ownPostAnswerOfError, ownPostAnswerOfPost, type OwnPostAnswer, type OwnPostObserver, type OwnPostStart } from './own-post.ts'
import { withFileCompletions } from './file-upload-observation.ts'

export { SET_CHANNEL_DELIVERY_TOOL }
/** An upload refused by the final file guard before any upload call. */
export const OWN_POST_UPLOAD_REFUSED = 'upload_refused'
// Peer-PID + sessions.json registry have been deleted. The
// agent-director library owns session state.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  /** Real path of the session's roots working directory — the session identity */
  cwd: string
  /** Key of the persona this session is matched to; empty on a pending stub until promotion */
  personaKey: string
  /** Shared authority life captured at registration; a key or cwd alone
   * cannot give an old MCP session access to a replacement. */
  personaIncarnation?: string
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
// Roots cwd → persona matching
// ---------------------------------------------------------------------------

/** Options for `matchPersonaByRootsPath`. */
export interface MatchPersonaOptions {
  /** Realpath function passed to `resolveRealPath`; defaults to `fs.realpathSync`. */
  realpath?: (path: string) => string
  /** Writes the one log line for an ambiguous match; defaults to `console.error`. */
  log?: (line: string) => void
}

/**
 * The persona a session's roots working directory maps to:
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
// Session admission
// ---------------------------------------------------------------------------

/**
 * A directory held for an old life that may still be running, as the held-directory query answers it: the held
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
   * Whether the persona with this key is up. Production passes
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
   * The held-directory query: given the session's
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
   * running: refuse the session, whichever persona
   * names the directory; register it as no persona's.
   */
  | { kind: 'held'; directory: string; instanceIds: readonly string[] }

/**
 * The one line `decideSessionAdmission` logs when it refuses a session
 * opened from a held directory: the held directory
 * and every held old instance id, each JSON-quoted, with, when the query
 * threw, what it threw:
 *
 * [slack] Session refused: its working directory "<D>" is held for an old life that may still be running (instanceId="<id>"[, instanceId="<id>" …]) — registered as no persona's session until the hold ends
 * [slack] Session refused: its working directory "<D>" is held for an old life that may still be running (the held-directory query failed: <thrown> — taken as held) — registered as no persona's session until the hold ends
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
    `(${what}) — registered as no persona's session until the hold ends`
  )
}

/**
 * Decide whether a session whose roots working directory is `rootsPath` may
 * register: "MCP sessions
 * still identify by the roots/list working directory, compared by real path,
 * which maps to exactly one persona, except that a session opened from the
 * working directory of an old life that may still be running (a retired
 * key's, or a live pre-persona row's or any other swept row's whose
 * start-sweep kill did not succeed) is registered as no persona's session
 * until that wait ends."
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
 * The held-directory query's reading of `rootsPath`: asked
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
  personaIncarnation?: string,
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
    if (personaIncarnation !== undefined) stub.personaIncarnation = personaIncarnation
    else delete stub.personaIncarnation
    stub.transport = transport
    stub.server = resolvedServer
    stub.connected = true
    // peerPort intentionally left as-is (stays 0 until first HTTP request)
    entry = stub
  } else {
    entry = {
      cwd,
      personaKey,
      ...(personaIncarnation !== undefined ? { personaIncarnation } : {}),
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

/** What `closePendingSession` acts through, injected. */
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
 * `handleInitialized`: a persona that is not up, a roots
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
 * Drop the session registered for a persona (a session is
 * registered only while its persona is up; the teardown can reuse it):
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
  /** Records an attempted reply or react using CSCB records, before any scope or Slack outcome. */
  onReplyCall?(key: string): void | Promise<void>
  /** File exfiltration guard — throws when the file must not be sent */
  assertSendable: (filePath: string) => void
  /**
   * The server-wide reply settings: reply chunking and the
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
   * Record a successful correlated reply and clean up its captured ack stage.
   * The removal fallback is only for legacy entries without a captured reaction;
   * `kept` is a react's emoji, never removed.
   */
  consumeAck: (personaKey: string, channelId: string, messageTs: string, removeLegacy?: () => Promise<unknown>, kept?: string) => boolean | Promise<void>
  /**
   * Record a successful react as consumeAck does, with its emoji kept, and
   * answer in the same step whether the persona already held that answer
   * (true) or this one is the first (false). Absent: the ack tracker's own
   * `claimReactAnswer`.
   */
  claimReactAnswer?: typeof claimReactAnswer
  /**
   * The persona's confirmed bot user ID from its serving connection, or
   * undefined when unavailable; read with `clientFor` before a react's add.
   * Absent: unavailable.
   */
  getBotUserId?: (key: string) => string | undefined
  /**
   * Told synchronously of each react whose claim was the first, when the
   * persona's bot user ID was available before the add. Absent: nothing.
   */
  onReactClaimed?: (claim: ReactClaimContext) => void
  /** TCP port the MCP HTTP server is listening on (retained for diagnostics). */
  serverPort: number
  /**
   * The channel mode of the configuration in effect, read on every tool call together with the persona and never
   * copied at session creation (production: `channelModeOf` over the applied
   * configuration). Absent: declarative mode.
   */
  getChannelMode?: () => ChannelMode
  /**
   * The one stored-choice store `main()` loads,
   * read at each `set_channel_delivery` call (production: the server's
   * module-scope holder). Undefined while no store is bound (before `main()`
   * loads it): the call is refused and nothing is written. Absent: the same.
   */
  getChannelDelivery?(): SessionChannelDeliveryStore | undefined
  /** Current applied/up status, including shutdown. Required for attempt access. */
  isPersonaUp?(key: string): boolean
  /** Read current authenticated evidence; this never performs a network lookup. */
  readChannelMembership?(key: string, channel: string, mode: ChannelMode): MembershipReading
  /**
   * Receives the `persona-channel-delivery-set` line of each newly applied
   * `set_channel_delivery` call: the `[slack]`
   * stream of `server.log`, as the routing's `log` receives
   * `persona-invited-channel` (production: `console.error`). Absent:
   * `console.error`.
   */
  log?: (line: string) => void
  /**
   * Observes each reply chunk and upload's intent and answer. Absent:
   * nothing is observed and posting is unchanged.
   */
  ownPosts?: OwnPostObserver
}

/**
 * A react whose claim was the first: the persona, the client that made the
 * add and the bot user ID read with it before the add, never re-resolved
 * after it, with the add's validated target and emoji.
 */
export interface ReactClaimContext {
  persona: Persona
  client: WebClient
  botUserId: string
  chatId: string
  messageId: string
  emoji: string
}

/**
 * What `set_channel_delivery` uses of the stored-choice store:
 * current readability, incarnation and the single
 * authority's attempt API. `ChannelDeliveryStore` satisfies it as it is.
 */
export type SessionChannelDeliveryStore = Pick<
  ChannelDeliveryStore,
  'path' | 'readable' | 'readableFor' | 'storedChoice' | 'lookupAttempt' | 'attempt' | 'isRetiring' | 'incarnation'
>

// ---------------------------------------------------------------------------
// Posting scope
// ---------------------------------------------------------------------------

/** A DM conversation ID. A group DM (`G…`, `mpim`) never matches. */
const DM_CONVERSATION_ID_RE = /^D[A-Z0-9]+$/

/**
 * What a tool target is, for one persona in one channel mode:
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
 * `channels` is never read and the channel-ID shape decides.
 * Pure: no Slack call, logging or state.
 */
function classifyPersonaTarget(persona: Persona, target: string, mode: ChannelMode): PersonaTargetKind {
  if (mode === 'open') {
    if (CHANNEL_ID_RE.test(target)) return 'channel'
  } else if (target !== '' && persona.channels.some((c) => c.id === target && c.delivery !== 'off')) {
    return 'channel'
  }
  if (DM_CONVERSATION_ID_RE.test(target)) return 'dm'
  if (DM_CONTACT_RE.test(target)) return 'user'
  return 'other'
}

/**
 * The reason a fungible-mode refusal of a target that is neither a channel ID
 * nor a DM target gives, after `checkPersonaTarget`'s lead
 * naming the persona and the target.
 */
export const FUNGIBLE_TARGET_REFUSAL = 'it is neither a channel ID nor an allowed DM target.'
export const CHANNEL_TARGET_STATE_UNRESOLVED = 'The current channel choice is unresolved; retry after reviewed state recovery.'

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
 * The posting scope of a persona, decided from
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
  mode: ChannelMode = 'strict',
): PersonaTargetCheck {
  const kind = classifyPersonaTarget(persona, target, mode)
  const refuse = (why: string): PersonaTargetCheck => ({
    allowed: false,
    message: `Persona ${renderPersonaRef(persona.name, persona.key)} may not target ${JSON.stringify(target)}: ${why}`,
  })
  if (kind === 'channel') return { allowed: true, kind }
  if (kind === 'other') {
    return refuse(mode === 'open' ? FUNGIBLE_TARGET_REFUSAL : `it is not one of the persona's configured channels.`)
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

/** What a `reply` had already posted when a later part failed; that prefix is never posted again. */
export interface ReplyPostedPrefix {
  where: string
  sent: number
  total: number
  lastTs?: string
  uploaded: number
  files: number
}
/** The `reply` tool error after a later Slack call failed following confirmed posts. */
export function replyPartialFailureText(prefix: ReplyPostedPrefix, reason?: string): string {
  return `Tool "reply" stopped after a partial post${reason ? ` (${reason})` : ''}: ` +
    `${prefix.sent} of ${prefix.total} message(s) were posted to ${prefix.where}${prefix.lastTs ? ` [ts: ${prefix.lastTs}]` : ''}` +
    `${prefix.files ? ` and ${prefix.uploaded} of ${prefix.files} file(s) were uploaded` : ''}. ` +
    'The posted part stays in Slack and is not posted again; send only what is missing.'
}
/** The `[slack]` line for that failure; the thrown value goes through the safe describer. */
export function replyPartialFailureLogLine(ref: string, prefix: ReplyPostedPrefix, err: unknown): string {
  return `[slack] Tool "reply" stopped after a partial post for persona ${ref}: ` +
    `sent=${prefix.sent}/${prefix.total} uploaded=${prefix.uploaded}/${prefix.files}: ${describeThrownValue(err)}`
}

/**
 * The tool error for a failed call on a channel target in fungible mode
 * where Slack enforces membership: it names
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
// Resolution refusals
// ---------------------------------------------------------------------------

/**
 * The tool error for a call from a session matched to no persona, the same for every tool:
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
 * the same for every tool. `set_channel_delivery`
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
// set_channel_delivery
// ---------------------------------------------------------------------------

/** The actual advertised request and direct-handler validation share this contract. */
export const SET_CHANNEL_DELIVERY_DESCRIPTION =
  'Set listening in a currently verified public or private member channel to off, mentions, all, or thread_hybrid. ' +
  'Call it when someone in that channel asks. New assignments require open mode and a current eligible membership. ' +
  'Create and retain attempt_id before first submission. Each fresh deliberate assignment uses a fresh identifier, even for the same value. ' +
  'A retry keeps the original identifier, channel and delivery and only reads its outcome. Known identifiers never assign again. ' +
  'A current session of the same persona incarnation may read historical results in strict mode or dry run.'
export const SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION =
  'A public or private channel ID (C... or G...). New assignments require authenticated current membership and explicit non-external-sharing evidence.'
export const SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION =
  '"off", "mentions" (@mentions and broadcasts), "all" (every message), or "thread_hybrid" (mentions and replies in threads the bot is in). Keep the original value on retry.'
export const SET_CHANNEL_DELIVERY_ATTEMPT_DESCRIPTION =
  'A nonempty identifier you create and retain before first submission. Use a fresh identifier for each deliberate assignment; retain it across response loss, reconnect and restart. Never change it on retry.'
export const SET_CHANNEL_DELIVERY_INTENT_DESCRIPTION =
  '"assignment" for a fresh deliberate choice; "retry" to read the original outcome without applying. Retry keeps attempt_id, channel and delivery. An unknown retry remains unresolved.'
export const SET_CHANNEL_DELIVERY_VALUES = DELIVERY_MODES
export const SET_CHANNEL_DELIVERY_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    channel: { type: 'string', pattern: CHANNEL_ID_RE.source, description: SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION },
    delivery: { type: 'string', enum: [...SET_CHANNEL_DELIVERY_VALUES], description: SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION },
    attempt_id: { type: 'string', minLength: 1, pattern: '\\S', description: SET_CHANNEL_DELIVERY_ATTEMPT_DESCRIPTION },
    intent: { type: 'string', enum: [...CHANNEL_DELIVERY_INTENTS], description: SET_CHANNEL_DELIVERY_INTENT_DESCRIPTION },
  },
  required: ['channel', 'delivery', 'attempt_id', 'intent'],
  additionalProperties: false,
}
function isChannelDeliveryValue(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (SET_CHANNEL_DELIVERY_VALUES as readonly string[]).includes(value)
}

/**
 * A channel value a `set_channel_delivery` error may echo:
 * a string of 1 to 24 characters from `A-Z0-9`. Any other value is not shown.
 */
export const ECHOABLE_CHANNEL_RE = /^[A-Z0-9]{1,24}$/

/** Refusal categories; attempt outcomes have their own typed result union. */
export const SET_CHANNEL_DELIVERY_REFUSALS = [
  'session-inactive',
  'input-invalid',
  'binding-conflict',
  'strict-mode',
  'dry-run',
  'outcome-unresolved',
] as const

/** One of `SET_CHANNEL_DELIVERY_REFUSALS`. */
export type SetChannelDeliveryRefusal = (typeof SET_CHANNEL_DELIVERY_REFUSALS)[number]

/** The lead every `set_channel_delivery` refusal shares: the tool and the persona (`renderPersonaRef`). */
function channelDeliveryRefusalLead(name: string, key: string): string {
  return `Tool "${SET_CHANNEL_DELIVERY_TOOL}" refused for persona ${renderPersonaRef(name, key)}`
}
export function channelDeliveryAttemptInputRefusal(name: string, key: string): string {
  return `${channelDeliveryRefusalLead(name, key)}: provide channel, delivery, a nonempty caller-retained attempt_id and intent "assignment" or "retry", with no extra fields. Input values are not shown.`
}
export function channelDeliveryDryRunRefusal(name: string, key: string): string {
  return `${channelDeliveryRefusalLead(name, key)}: dry run cannot create assignments or attempt records. Retained same-incarnation history can be read without writing.`
}
export function channelDeliveryCurrentFactsText(current: ChannelDeliveryCurrentFacts): string {
  if (current.kind === 'available') {
    const { facts } = current
    return `Current saved ${facts.saved}, effective ${facts.effective} in ${current.mode} mode.`
  }
  const reason: Record<ChannelDeliveryUnavailableReason, string> = {
    'shared-state-unreadable': 'the shared state is not trustworthy',
    'channel-removed': 'there is no currently saved channel entry',
    'absent': 'current membership is absent',
    'external-sharing': 'external sharing makes the channel ineligible in open mode',
    'invalid-channel': 'the channel identity is invalid',
    'installation-unverified': 'the current installation is unverified',
    'current-membership-missing': 'current membership is unverified',
    'event-order-conflict': 'membership event order is unresolved',
    'history-unresolved': 'membership history is unresolved',
    'event-not-durable': 'membership evidence is not durable',
    'eligibility-missing': 'channel type or non-external-sharing evidence is missing',
  }
  return (current.saved === undefined ? 'Current saved/effective facts are unavailable' : `Current saved ${current.saved}; effective delivery is unavailable`) +
    `: ${reason[current.reason]}.`
}
export function channelDeliveryAttemptResultText(
  name: string, key: string, channel: string, result: BotAttemptResult, current?: ChannelDeliveryCurrentFacts,
): string {
  const lead = `Channel delivery for persona ${renderPersonaRef(name, key)}, channel ${channel}: `
  const now = current ? ` ${channelDeliveryCurrentFactsText(current)}` : ''
  if (result.kind === 'applied') {
    const facts = result.outcome.facts
    return lead + `${result.historical ? 'previously applied' : 'newly applied'} at position ${result.outcome.resolvedOrder}; original saved ${facts.saved}, effective ${facts.effective}.` +
      (result.historical ? ' This history read made no new assignment.' : '') + now
  }
  if (result.kind === 'not-applied') {
    const reason = {
      membership: 'current eligible membership was not verified', inactive: 'the session or persona became inactive',
      strict: 'strict mode did not authorize an assignment', 'dry-run': 'dry run did not authorize an assignment',
      'write-failed': 'the application failed before durable activation',
    }[result.reason]
    return lead + `this attempt did not apply and changed no choice: ${reason}. Its retained outcome cannot be retried as a new assignment.` + now
  }
  if (result.kind === 'binding-conflict') return channelDeliveryRefusalLead(name, key) + ': the identifier cannot be used for these inputs. No assignment was made; original inputs are not disclosed.'
  if (result.kind === 'pending') return lead + 'the retained attempt is pending; no duplicate application was made. Its outcome requires recovery.' + now
  if (result.kind === 'inactive' || result.kind === 'invalid') return channelDeliveryRefusalLead(name, key) + ': this request cannot access or change channel delivery.'
  return lead + 'the durable outcome is unresolved; application or nonapplication cannot be established. Preserve the identifier and seek recovery; retry cannot create an assignment.' + now
}

/** Strict refuses fresh assignments; existing history is resolved first. */
export function channelDeliveryDeclarativeRefusal(name: string, key: string): string {
  return (
    `${channelDeliveryRefusalLead(name, key)}: strict mode is active, so ` +
    'new assignments are unavailable. A retained same-incarnation attempt can still be read without writing.'
  )
}

/** Unavailable authority cannot prove application or nonapplication. */
export function channelDeliveryUnreadableRefusal(name: string, key: string, path: string): string {
  return (
    `${channelDeliveryRefusalLead(name, key)}: the shared channel authority ${JSON.stringify(path)} is not trustworthy, ` +
    'so the outcome is unresolved and no channel delivery can be stored. The operator must preserve the evidence and restore trustworthy shared state before retrying.'
  )
}

/** Echo only a safe delivery label; never render arbitrary inputs. */
export function channelDeliveryValueRefusal(name: string, key: string, value: unknown): string {
  const allowed = SET_CHANNEL_DELIVERY_VALUES.map((v) => JSON.stringify(v)).join(' or ')
  const lead = channelDeliveryRefusalLead(name, key)
  return typeof value === 'string' && ECHOABLE_KEY_NAME_RE.test(value)
    ? `${lead}: delivery ${JSON.stringify(value)} is not ${allowed}.`
    : `${lead}: delivery is not ${allowed} (the value given is not shown).`
}

/** Listing or heard traffic never supplies current membership authority. */
export function channelDeliveryChannelRefusal(name: string, key: string, channel: unknown): string {
  const what = typeof channel === 'string' && ECHOABLE_CHANNEL_RE.test(channel)
    ? `channel ${JSON.stringify(channel)}` : 'the channel (the value given is not shown)'
  return `${channelDeliveryRefusalLead(name, key)}: ${what} needs a valid public or private channel ID and authenticated current eligible membership for a new assignment.`
}

/** Render a new application only, using its original effective facts. */
export function channelDeliverySetResultText(channel: string, stored: DeliveryMode, result: ChannelDeliveryResult): string {
  return `Stored ${stored} as your channel delivery for channel ${channel}. ` +
    `From the next message in that channel, your channel delivery there is ${result.delivery}.`
}

/** Only for a proven pre-rename failure; ambiguous outcomes use attempt results. */
export function channelDeliveryWriteFailedText(name: string, key: string, path: string): string {
  return (
    `Tool "${SET_CHANNEL_DELIVERY_TOOL}" failed for persona ${renderPersonaRef(name, key)}: the shared channel authority ` +
    `${JSON.stringify(path)} could not be written, so the choice was not stored and channel delivery is unchanged.`
  )
}

/** Only for a proven input refusal; not an ambiguous durability outcome. */
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

// ---------------------------------------------------------------------------
// Reply file uploads
// ---------------------------------------------------------------------------

/** A `<@ID>` user or persona mention token in message text. */
const USER_MENTION_TOKEN_RE = /<@[^>]+>/g

/**
 * The refusal reason of the first of `files` that `assertSendable` refuses,
 * or undefined when every file may be sent.
 */
function firstUnsendableReason(
  files: readonly string[],
  assertSendable: (filePath: string) => void,
): string | undefined {
  for (const filePath of files) {
    try {
      assertSendable(filePath)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  return undefined
}

/**
 * The `filesUploadV2` arguments for a reply's files: one upload sharing every
 * file in one message under its own name, in `threadTs` if given, otherwise
 * threaded under the reply's first message (`firstTs`, empty when none was
 * posted or Slack returned no ts), with the text's distinct mentions repeated
 * so mention-only bots get it. Pure.
 */
function replyUploadArgs(
  chatId: string,
  files: readonly string[],
  threadTs: string | undefined,
  firstTs: string,
  text: string,
): Record<string, any> {
  const args: Record<string, any> = {
    channel_id: chatId,
    file_uploads: files.map((p) => ({ file: resolve(p), filename: basename(p) })),
  }
  const uploadThreadTs = threadTs || firstTs
  if (uploadThreadTs) args.thread_ts = uploadThreadTs
  const mentions = [...new Set(text.match(USER_MENTION_TOKEN_RE) ?? [])]
  if (mentions.length > 0) args.initial_comment = mentions.join(' ')
  return args
}

/**
 * The tool error text for a reply whose files the pre-upload check refused
 * with `reason`: `posted` describes the text already posted, or is undefined
 * when the reply had no text. Pure.
 */
function buildFilesRefusedText(reason: string, fileCount: number, posted?: string): string {
  if (posted === undefined) return `${reason} None of the ${fileCount} file(s) were uploaded.`
  return (
    `${reason} The reply text was already posted (${posted}); ` +
    `none of the ${fileCount} file(s) were uploaded.`
  )
}

export const FETCH_MESSAGES_DESCRIPTION = 'Fetch message history from a channel, DM conversation or thread. Returns a JSON array, oldest first. In a thread_hybrid channel with thread_ts, returns { messages, next_cursor } instead: one page of the thread, its channel message on the first page only; pass next_cursor back as cursor for the next page until none is returned.'
export const FETCH_MESSAGES_CURSOR_DESCRIPTION = 'In a thread_hybrid channel with thread_ts: the next_cursor from the previous page, to read the next page (optional)'

export function fetchMessagesCursorRefusal(): string {
  return 'Tool "fetch_messages" refused: cursor must be a string.'
}

/** Every session receives these eleven points in order. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 2048
export const MCP_INSTRUCTIONS = [
  'The sender reads Slack, not your terminal. Answer with reply, using chat_id and thread_ts for a thread; end a turn with no terminal text unless a terminal reader needs it.',
  'Messages arrive as the <channel> tag described in the system prompt, carrying channel_name and, for a long message, part.',
  'via: dm = a direct message; mention = you were @mentioned; broadcast = @here or @channel; thread = a reply in a thread the bot is in; receive_all_shared = a channel where you and another persona receive every message; receive_all = a channel where you, and no other persona on this server, receive every message.',
  '<@ID> mentions a Slack user or persona. Use <@ID> to address another persona.',
  'If attachment_count is present, use download_attachment(chat_id, message_id) to fetch attachments.',
  'In strict mode you may act in your configured non-off channels. In open mode Slack enforces channel access.',
  `${SET_CHANNEL_DELIVERY_TOOL} sets listening to off, mentions (@mentions and broadcasts), all (every message), or thread_hybrid (mentions and replies in threads the bot is in). Use it when someone in that channel asks; new assignments require open mode. Retain attempt_id before submission; fresh assignments use fresh IDs. Retry keeps ID/channel/value and only reads history.`,
  'Thread Memory notices (including Joins lost) in your notice destination are for the operator; do not act on them.',
  'With DMs on, you may reply, react, edit_message, fetch_messages and download_attachment in a DM you belong to (D... chat_id). To start a DM, reply takes a user ID (U... or W...) as chat_id and returns the D... ID for later calls. Other tools take no user ID. With DMs off you have no DM target. Any other target is refused.',
  'To remove the ack reaction, reply with message_id (the triggering message ts) or react to that message.',
  'reply accepts files: ["/abs/path.png"] for attachments. react adds emoji reactions; edit_message updates a sent message; fetch_messages reads Slack history; in a thread_hybrid channel, pass its next_cursor back as cursor to read a whole thread.',
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
  const currentSessionLife = (): boolean => {
    const store = deps.getChannelDelivery?.()
    return !store || (!store.isRetiring(entry.personaKey) &&
      entry.personaIncarnation !== undefined && entry.personaIncarnation === store.incarnation(entry.personaKey) &&
      getSessionByPersona(entry.personaKey) === entry)
  }

  const server = new Server(
    { name: MCP_SERVER_NAME, version: '0.1.0' },
    {
      capabilities: {
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
              description:
                'Absolute paths of files to upload (optional). All files share one message under their own names: in thread_ts if given, otherwise threaded under the text, or in the conversation when text is ""; the text\'s <@ID> mentions are repeated with them.',
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
            message_id: { type: 'string', description: 'Message timestamp (ts); reacting to the triggering message removes its ack reaction' },
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
        description: FETCH_MESSAGES_DESCRIPTION,
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
            cursor: { type: 'string', description: FETCH_MESSAGES_CURSOR_DESCRIPTION },
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
        inputSchema: SET_CHANNEL_DELIVERY_INPUT_SCHEMA,
      },
    ],
  }))

  // -------------------------------------------------------------------------
  // Tool execution — persona-scoped
  //
  // Every call resolves the session's persona and the channel mode at call
  // time (the persona from the entry this server closes over, the mode
  // through `deps.getChannelMode`, declarative when it is absent), checks the
  // tool's target against them (`checkPersonaTarget`, before the dry-run
  // branch), and outside dry run makes every Slack call on the persona's own
  // client, with no username or icon override. A refusal is a tool error
  // (`isError: true`), never a protocol error, and makes no Slack call. In
  // fungible mode, a failed call on a channel target returns
  // `slackRefusalToolErrorText`.
  //
  // A user-ID target (`reply` only) is opened with `conversations.open` on the
  // persona's client on every call (no cache), and the reply goes to the
  // returned conversation; the user ID itself never reaches a Slack write,
  // which would open a DM implicitly.
  // -------------------------------------------------------------------------

  function checkCurrentTarget(persona: Persona, target: string, action: PersonaTargetAction, mode: ChannelMode): PersonaTargetCheck {
    const scope = checkPersonaTarget(persona, target, action, mode)
    // Open ordinary tools use Slack access, independently of channel choices.
    // Strict must not use an old non-off projection during an uncertain write.
    if (scope.allowed && scope.kind === 'channel' && mode === 'strict' &&
        deps.getChannelDelivery?.()?.readableFor(persona.key, target) === false) {
      return { allowed: false, message: CHANNEL_TARGET_STATE_UNRESOLVED }
    }
    return scope
  }

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

  /** A legacy tracked ack's removal through the caller's client; `kept` (a react's emoji) is never removed. */
  function legacyAckRemoval(web: WebClient, chatId: string, messageId: string, ackReaction: string | undefined, kept?: string): () => Promise<unknown> {
    return async () => {
      if (ackReaction && ackReaction !== kept) await web.reactions.remove({ channel: chatId, timestamp: messageId, name: ackReaction })
    }
  }

  /**
   * Record a successful correlated reply and detach removal of the persona's
   * own ack reaction, so a held reaction call never delays the remaining
   * content or the tool result.
   */
  function releaseAck(persona: Persona, web: WebClient, chatId: string, messageId: string, ackReaction: string | undefined): void {
    try {
      void Promise.resolve(consumeAck(persona.key, chatId, messageId, legacyAckRemoval(web, chatId, messageId, ackReaction))).catch(() => {})
    } catch { /* reaction cleanup cannot fail a successful tool call */ }
  }

  /**
   * Claim a successful react's answer, which also releases the persona's ack
   * as releaseAck does, keeping the emoji. Only a first answer with the bot
   * user ID read before the add reaches `onReactClaimed`. Cleanup is
   * detached, and neither a claim failure nor the callback can delay or
   * change the tool result.
   */
  function claimReact(persona: Persona, web: WebClient, botUserId: string | undefined, chatId: string, messageId: string, emoji: string): void {
    const removeLegacy = legacyAckRemoval(web, chatId, messageId, getReplySettings().ack_reaction, emoji)
    let alreadyHeld = true
    try {
      alreadyHeld = (deps.claimReactAnswer ?? claimReactAnswer)(persona.key, chatId, messageId, emoji, removeLegacy)
    } catch { /* a failed claim is never a first answer */ }
    if (alreadyHeld !== false || !botUserId || !deps.onReactClaimed) return
    try {
      deps.onReactClaimed({ persona, client: web, botUserId, chatId, messageId, emoji })
    } catch { /* the hand-off cannot fail a successful react */ }
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
    botUserId: string | undefined,
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
        const refused = firstUnsendableReason(files ?? [], assertSendable)
        if (refused !== undefined) return toolError(refused)

        // A user ID is never posted to: open the DM, then act only in it.
        let where = chatId
        if (kind === 'user') {
          const opened = await openDmConversation(name, persona, web, chatId)
          if (!opened.ok) return toolError(opened.message)
          const current = getPersona(persona.key)
          if (!current || !currentSessionLife()) return toolError(personaNotAppliedRefusal(name, persona.key))
          const mode = deps.getChannelMode?.() ?? 'strict'
          for (const target of [chatId, opened.id]) {
            const scope = checkCurrentTarget(current, target, 'post', mode)
            if (!scope.allowed) return toolError(scope.message)
          }
          persona = current
          dm.opened = opened.id
          where = `${opened.id} (the DM with ${chatId})`
          chatId = opened.id
        }

        const settings = getReplySettings()
        const hasFiles = (files?.length ?? 0) > 0
        const filesOnly = text === '' && hasFiles
        const chunks = filesOnly ? [] : chunkText(text, settings.reply_chunk_limit, settings.reply_chunk_mode)
        const clearAck = () => {
          if (messageId) releaseAck(persona, web, chatId, messageId, settings.ack_reaction)
        }

        let lastTs = ''
        let firstTs = ''
        let firstChunk = true
        // The calling persona's own ack reaction, removed through its own
        // client at most once (first success), only when its own entry for
        // this message existed. `chatId` is the conversation posted to (for
        // a user target, the DM just opened). Shared by text and file successes.
        const succeeded = () => {
          if (!firstChunk) return
          firstChunk = false
          clearAck()
        }
        const target = { channel: chatId, ...(threadTs ? { parent: threadTs } : {}) }
        // Confirmed parts survive any later failure; none is posted again.
        let sent = 0
        let uploaded = 0
        const prefix = (): ReplyPostedPrefix => ({ where, sent, total: chunks.length, ...(lastTs ? { lastTs } : {}), uploaded, files: files?.length ?? 0 })
        const partialFailure = (err: unknown) => {
          const log = deps.log ?? ((line: string) => console.error(line))
          log(replyPartialFailureLogLine(renderPersonaRef(persona.name, persona.key), prefix(), err))
          return toolError(replyPartialFailureText(prefix(), slackPlatformReason(err)))
        }
        for (const chunk of chunks) {
          // Each call captures its own intent and waits only for that append.
          let op: OwnPostStart | undefined
          try {
            op = deps.ownPosts?.start(persona.key, 'text', target, { kind: 'text', text: chunk })
            if (op?.ready) await op.ready
          } catch { /* join bookkeeping cannot stop the remaining parts */ }
          let res: Awaited<ReturnType<WebClient['chat']['postMessage']>>
          try {
            res = await web.chat.postMessage({
              channel: chatId,
              text: chunk,
              thread_ts: threadTs,
              unfurl_links: false,
              unfurl_media: false,
            })
          } catch (err) {
            try {
              deps.ownPosts?.end(op?.operation, ownPostAnswerOfError(err))
            } catch { /* join bookkeeping cannot stop the remaining parts */ }
            if (sent === 0) throw err
            return partialFailure(err)
          }
          // Settle before reaction cleanup and before any other await.
          try {
            deps.ownPosts?.end(op?.operation, ownPostAnswerOfPost(chatId, res))
          } catch { /* join bookkeeping cannot stop the remaining parts */ }
          const ts = typeof res.ts === 'string' && res.ts !== '' ? res.ts : undefined
          if (sent === 0) firstTs = ts ?? ''
          sent++
          lastTs = ts ?? lastTs
          succeeded()
        }

        if (hasFiles) {
          // One upload shares every file in one message; each file is still
          // its own operation, under the parent the upload is threaded in and
          // digested by the name the upload sends.
          const uploadParent = threadTs || firstTs
          const fileTarget = { channel: chatId, ...(uploadParent ? { parent: uploadParent } : {}) }
          const ops: (OwnPostStart | undefined)[] = []
          for (const filePath of files!) {
            let op: OwnPostStart | undefined
            try {
              const size = statSync(resolve(filePath)).size
              op = deps.ownPosts?.start(persona.key, 'file', fileTarget, { kind: 'file', name: basename(filePath), size })
              if (op?.ready) await op.ready
            } catch { /* missing metadata or join bookkeeping cannot stop the upload */ }
            ops.push(op)
          }
          const ended = new Set<number>()
          const endUpload = (at: number, answer: OwnPostAnswer) => {
            if (ended.has(at)) return
            ended.add(at)
            try {
              deps.ownPosts?.end(ops[at]?.operation, answer)
            } catch { /* join bookkeeping cannot stop the remaining parts */ }
          }
          const endRemaining = (answer: OwnPostAnswer) => { for (let at = 0; at < ops.length; at++) endUpload(at, answer) }
          // Check every file again right before the upload: the text posts
          // above widen the window in which a symlink could be re-pointed at
          // a file the up-front pass would have refused.
          const reason = firstUnsendableReason(files!, assertSendable)
          if (reason !== undefined) {
            endRemaining({ kind: 'failed', code: OWN_POST_UPLOAD_REFUSED })
            const posted = filesOnly
              ? undefined
              : `${sent} message(s) to ${where}${lastTs ? ` [ts: ${lastTs}]` : ''}`
            return toolError(buildFilesRefusedText(reason, files!.length, posted))
          }
          // Each nested completion is confirmed in its own reaction, so files
          // a group completed stay uploaded when the aggregate rejects.
          // Confirmed files end the operations in file order.
          let completed = 0
          const onCompletion = (response: unknown) => {
            for (const file of completionFiles(response)) {
              if (completed < ops.length) endUpload(completed, { kind: 'confirmed', channel: chatId, file: file.id })
              completed++
            }
            if (completed) succeeded()
          }
          try {
            const result: unknown = await withFileCompletions(onCompletion, () => web.filesUploadV2(replyUploadArgs(chatId, files!, threadTs, firstTs, text) as any))
            // A client built without the observation reports its completions only in the aggregate.
            const responses = (result as { files?: unknown } | undefined)?.files
            if (!completed && Array.isArray(responses)) for (const response of responses) onCompletion(response)
            endRemaining({ kind: 'no-answer' })
          } catch (err) {
            endRemaining(ownPostAnswerOfError(err))
            uploaded = Math.min(completed, files!.length)
            if (uploaded < files!.length) {
              if (sent === 0 && uploaded === 0) throw err
              return partialFailure(err)
            }
          }
          uploaded = files!.length
          succeeded()
        }

        return {
          content: [
            {
              type: 'text',
              text: `Sent ${chunks.length} message(s)${hasFiles ? ` + ${files!.length} file(s)` : ''} to ${where}${lastTs ? ` [ts: ${lastTs}]` : ''}`,
            },
          ],
        }
      }

      // ---------------------------------------------------------------------
      // react
      // ---------------------------------------------------------------------
      case 'react': {
        const chatId: string = args.chat_id, messageId: string = args.message_id, emoji: string = args.emoji
        try {
          await web.reactions.add({ channel: chatId, timestamp: messageId, name: emoji })
        } catch (err) {
          // The persona's own reaction is already there, as when it matches its ack.
          if (slackPlatformReason(err) !== 'already_reacted') throw err
        }
        claimReact(persona, web, botUserId, chatId, messageId, emoji)
        return {
          content: [{ type: 'text', text: `Reacted :${emoji}: to ${messageId}` }],
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

        const paged = kind === 'channel' && !!threadTs && channelDeliveryFor(persona.key, channel, {
          storedChoices: deps.getChannelDelivery?.(),
        }).delivery === 'thread_hybrid'
        if (paged && Object.hasOwn(args, 'cursor') && typeof args.cursor !== 'string') {
          return toolError(fetchMessagesCursorRefusal())
        }
        const cursor = paged && args.cursor ? args.cursor as string : undefined

        let messages: any[]
        let nextCursor: string | undefined
        if (threadTs) {
          const res = await web.conversations.replies({ channel, ts: threadTs, limit, ...(cursor ? { cursor } : {}) })
          messages = res.messages || []
          if (paged) {
            if (cursor) messages = messages.filter(m => m.ts !== threadTs)
            const next = res.response_metadata?.next_cursor
            if (typeof next === 'string' && next !== '') nextCursor = next
          }
        } else {
          const res = await web.conversations.history({ channel, limit })
          messages = (res.messages || []).reverse()
        }

        const formatMessage = async (m: any) => {
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
        }
        const formatted = await Promise.all(messages.map(formatMessage))
        const result = paged ? { messages: formatted, ...(nextCursor ? { next_cursor: nextCursor } : {}) } : formatted

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
  // Logical attempt access and application stay synchronous. No admitted
  // session/membership fact crosses an await, and the authority rechecks at
  // its final turn after retaining the attempt binding.
  function setChannelDelivery(name: string, args: Record<string, unknown>) {
    const key = entry.personaKey
    if (!key) return toolError(sessionNotMatchedRefusal(name))
    const access = () => entry.connected && !!getPersona(key) && currentSessionLife() &&
      getSessionByPersona(key) === entry && deps.isPersonaUp?.(key) === true
    if (!access()) return toolError(personaNotAppliedRefusal(name, key))
    const persona = getPersona(key)!
    const store = deps.getChannelDelivery?.()
    if (!store || !entry.personaIncarnation) return toolError(channelDeliveryUnreadableRefusal(persona.name, key, store?.path ?? CHANNEL_DELIVERY_FILE_NAME))
    if (!isChannelDeliveryValue(args.delivery)) return toolError(channelDeliveryValueRefusal(persona.name, key, args.delivery))
    if (typeof args.channel !== 'string' || !CHANNEL_ID_RE.test(args.channel)) return toolError(channelDeliveryChannelRefusal(persona.name, key, args.channel))
    if (!validChannelDeliveryAttemptId(args.attempt_id) || !validChannelDeliveryAttempt(args)) {
      return toolError(channelDeliveryAttemptInputRefusal(persona.name, key))
    }
    const request: ChannelDeliveryAttemptRequest = args
    const history = store.lookupAttempt(key, entry.personaIncarnation, request)
    const answer = (outcome: BotAttemptResult) => {
      if (!access()) return toolError(personaNotAppliedRefusal(name, key))
      const mode = deps.getChannelMode?.() ?? 'strict'
      const current = ['binding-conflict', 'inactive', 'invalid'].includes(outcome.kind) ? undefined : currentChannelDeliveryFacts(
        key, request.channel, mode, store,
        deps.readChannelMembership?.(key, request.channel, mode),
      )
      const text = channelDeliveryAttemptResultText(persona.name, key, request.channel, outcome, current)
      return outcome.kind === 'applied' ? { content: [{ type: 'text', text }] } : toolError(text)
    }
    if (history) return answer(history)
    if (request.intent === 'retry') return answer({ kind: 'unresolved' })
    if ((deps.getChannelMode?.() ?? 'strict') !== 'open') return toolError(channelDeliveryDeclarativeRefusal(persona.name, key))
    if (isDryRun()) return toolError(channelDeliveryDryRunRefusal(persona.name, key))
    return answer(store.attempt(key, entry.personaIncarnation, request, () => {
      if (!access()) return 'inactive'
      if (isDryRun()) return 'dry-run'
      if ((deps.getChannelMode?.() ?? 'strict') !== 'open') return 'strict'
      const membership = deps.readChannelMembership?.(key, request.channel, 'open')
      if (membership?.kind !== 'eligible' || membership.lifetime.incarnation !== entry.personaIncarnation) return 'membership'
      return undefined
    }, outcome => {
      const log = deps.log ?? ((line: string) => console.error(line))
      log(formatPersonaDiagnostic({ class: PERSONA_CHANNEL_DELIVERY_SET,
        name: persona.name, key, index: persona.index,
        cause: channelDeliverySetCause(request.channel, outcome.previous, outcome.facts.saved, outcome.facts.effective),
      }))
    }))
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const args = (request.params.arguments || {}) as Record<string, any>

    // set_channel_delivery has no Slack target, so it never reaches the
    // target lookup, the scope check or the dry-run branch.
    if (name === SET_CHANNEL_DELIVERY_TOOL) return setChannelDelivery(name, args)

    const toolTarget = Object.hasOwn(TOOL_TARGET, name) ? TOOL_TARGET[name] : undefined
    if (!toolTarget) return toolError(`Unknown tool: ${name}`)

    // The calling instance's persona, resolved now (not at session creation).
    const key = entry.personaKey
    if (!key) return toolError(sessionNotMatchedRefusal(name))
    if (!getPersona(key) || !currentSessionLife()) return toolError(personaNotAppliedRefusal(name, key))
    if (name === 'reply' || name === 'react') await deps.onReplyCall?.(key)
    const persona = getPersona(key)
    if (!persona || !currentSessionLife()) return toolError(personaNotAppliedRefusal(name, key))
    // The channel mode, read now with the persona.
    const mode: ChannelMode = deps.getChannelMode?.() ?? 'strict'

    // Posting scope, before the dry-run branch.
    const rawTarget = args[toolTarget.arg]
    const target = typeof rawTarget === 'string' ? rawTarget : ''
    const scope = checkCurrentTarget(persona, target, toolTarget.action, mode)
    if (!scope.allowed) return toolError(scope.message)

    if (isDryRun()) return dryRunResult(name, args, scope.kind)

    const ref = renderPersonaRef(persona.name, persona.key)
    const web = clientFor(key)
    // Read with the client, before the add: an identity swap while the add is
    // pending cannot pair this client with another bot user ID.
    const botUserId = name === 'react' ? deps.getBotUserId?.(key) : undefined
    if (!web) return toolError(`Tool "${name}" refused: the Slack client for persona ${ref} is not available.`)

    const dm: { opened?: string } = {}
    try {
      return await runTool(name, args, persona, web, scope.kind, dm, botUserId)
    } catch (err) {
      // Fungible mode, channel target: Slack enforces
      // membership, so its refusal names the persona, the channel and
      // Slack's error code. The log line stays token-safe.
      if (mode === 'open' && scope.kind === 'channel') {
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
