/**
 * lib.ts — Pure, testable functions extracted from the Slack Channel MCP server.
 *
 * All functions here are side-effect-free (or accept their dependencies as
 * parameters) so they can be imported by tests without starting the Slack
 * socket or loading credentials: the stream-presence check, the file
 * exfiltration guard, text chunking and attachment-name sanitising.
 *
 * SPDX-License-Identifier: MIT
 */

import { resolve, sep } from 'path'
import { resolveRealPath, tryResolveRealPath } from './config.ts'

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
// Security — assertSendable (file exfiltration guard)
// ---------------------------------------------------------------------------

/**
 * True when `path` is `dir` itself or lies under it: a prefix test that
 * respects path-component boundaries, so `/a/inbox-old/x` is not under
 * `/a/inbox` and `/a/state2/x` is not under `/a/state`. Both strings are
 * taken as given (no resolving); a trailing separator on `dir` is tolerated.
 */
function isWithinDir(path: string, dir: string): boolean {
  if (path === dir) return true
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * True when `path` is within `stateDir` but not within `inboxDir`
 * (`isWithinDir` on the three strings as given).
 */
function inStateDirOutsideInbox(path: string, stateDir: string, inboxDir: string): boolean {
  return isWithinDir(path, stateDir) && !isWithinDir(path, inboxDir)
}

/**
 * Throws if `filePath` must not be sent (b.av2 SR-5.2):
 *
 * - it resolves to inside `stateDir` but outside `inboxDir`, by either of two
 *   path-boundary-aware prefix tests (`isWithinDir`: `<stateDir>/inbox-old/`
 *   is not in the inbox, `<stateDir>2/` is not in the state directory): the
 *   lexical one (both directory paths should be absolute, already resolved)
 *   and the same test on the real paths of the file and
 *   both directories (`resolveRealPath`). So a symlink outside the state
 *   directory that points into it is refused, and one that points into the
 *   inbox is allowed. The real-path test applies only when the file's real
 *   path resolves: a path that does not exist gets the lexical test alone; or
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
  const real = tryResolveRealPath(resolved)

  if (
    inStateDirOutsideInbox(resolved, stateDir, inboxDir) ||
    (real !== undefined && inStateDirOutsideInbox(real, resolveRealPath(stateDir), resolveRealPath(inboxDir)))
  ) {
    throw new Error(
      `Blocked: cannot send files from state directory (${stateDir}). ` +
        'Only files in inbox/ are sendable.',
    )
  }

  if (protectedPaths.length === 0) return
  const comparable = real ?? resolved
  if (protectedPaths.some((p) => resolveRealPath(p) === comparable)) {
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
