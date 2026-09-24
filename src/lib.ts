/**
 * lib.ts — Pure, testable functions extracted from the Slack Channel MCP server.
 *
 * All functions here are side-effect-free (or accept their dependencies as
 * parameters) so they can be imported by tests without starting the Slack
 * socket or loading credentials: the stream-presence check, the `access.json`
 * settings model (ack reaction and reply chunking, until E9), the file
 * exfiltration guard, text chunking and attachment-name sanitising.
 *
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'path'
import { resolveRealPath } from './config.ts'

// ---------------------------------------------------------------------------
// MCP transport stream presence
// ---------------------------------------------------------------------------

// True iff the standalone GET SSE stream entry "_GET_stream" is present in the
// MCP SDK transport's internal _streamMapping. Used by persona-routing.ts's
// dispatch path (on the exact session it sends to) and its stream-presence
// probe (`hasSessionStream`) to detect silent-drop conditions before
// forwarding a Slack message.
export function hasGetStreamKey(transport: unknown): boolean {
  const mapping = (transport as any)?._streamMapping
  return typeof mapping?.has === 'function' && mapping.has('_GET_stream')
}

// ---------------------------------------------------------------------------
// Access model (access.json)
//
// Kept as stored until E9 removes it. Only `ackReaction` and the chunk
// settings are read; the other fields no longer affect delivery.
// ---------------------------------------------------------------------------

export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'

export interface ChannelPolicy {
  requireMention: boolean
  allowFrom: string[]
}

export interface PendingEntry {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export interface Access {
  dmPolicy: DmPolicy
  allowFrom: string[]
  channels: Record<string, ChannelPolicy>
  pending: Record<string, PendingEntry>
  ackReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    channels: {},
    pending: {},
  }
}

// ---------------------------------------------------------------------------
// Security — assertSendable (file exfiltration guard)
// ---------------------------------------------------------------------------

/**
 * Throws if `filePath` must not be sent (b.av2 SR-5.2):
 *
 * - it resolves to inside `stateDir` but outside `inboxDir` (a lexical prefix
 *   test; both directory paths should be absolute, already resolved); or
 * - its real path equals the real path of any of `protectedPaths`, the persona
 *   credentials files named by the applied or current configuration (see
 *   `credentialsFilesToProtect` in `config.ts`). Both sides are compared through
 *   `resolveRealPath`, so a symlink to a credentials file or a non-normalised
 *   path to one is refused too. `protectedPaths` must be tilde-expanded and is
 *   required, so a caller cannot silently skip the credentials rule (pass an
 *   empty list only when there really is nothing to protect).
 *
 * Never opens or reads the file; the error names only the blocked path.
 */
export function assertSendable(
  filePath: string,
  stateDir: string,
  inboxDir: string,
  protectedPaths: readonly string[],
): void {
  const resolved = resolve(filePath)

  if (resolved.startsWith(stateDir) && !resolved.startsWith(inboxDir)) {
    throw new Error(
      `Blocked: cannot send files from state directory (${stateDir}). ` +
        'Only files in inbox/ are sendable.',
    )
  }

  if (protectedPaths.length === 0) return
  const real = resolveRealPath(resolved)
  if (protectedPaths.some((p) => resolveRealPath(p) === real)) {
    throw new Error(`Blocked: cannot send ${resolved} — it is a persona credentials file.`)
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

export function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []

  if (mode === 'newline') {
    let current = ''
    for (const line of text.split('\n')) {
      if (current.length + line.length + 1 > limit && current.length > 0) {
        chunks.push(current)
        current = ''
      }
      current += (current ? '\n' : '') + line
    }
    if (current) chunks.push(current)
  } else {
    for (let i = 0; i < text.length; i += limit) {
      chunks.push(text.slice(i, i + limit))
    }
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Attachment sanitization
// ---------------------------------------------------------------------------

export function sanitizeFilename(name: string): string {
  return name.replace(/[\[\]\n\r;]/g, '_').replace(/\.\./g, '_')
}
