/**
 * lib.ts — Pure, testable functions extracted from the Slack Channel MCP server.
 *
 * All functions here are side-effect-free (or accept their dependencies as
 * parameters) so they can be imported by tests without starting the Slack
 * socket or loading credentials: the file
 * exfiltration guard, text chunking and attachment-name sanitising.
 *
 * SPDX-License-Identifier: MIT
 */

import { resolve, sep } from 'path'
import { resolveRealPath, tryResolveRealPath } from './config.ts'

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
 * Throws if `filePath` must not be sent:
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

/**
 * Split into at most `limit` Unicode code points per chunk, without changing
 * text: joining the chunks with '' recovers the input exactly. Empty input
 * returns ['']. Newline mode prefers a boundary after the last newline that
 * fits, retaining that newline; lines longer than the limit are hard-split.
 * Surrogate pairs stay together, including when the limit is one.
 */
export function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('Text chunk limit must be a positive integer.')
  }
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let newlineEnd = start
    for (let count = 0; count < limit && end < text.length; count++) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1
      if (text[end - 1] === '\n') newlineEnd = end
    }
    if (mode === 'newline' && end < text.length && newlineEnd > start) {
      end = newlineEnd
    }
    chunks.push(text.slice(start, end))
    start = end
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Attachment sanitization
// ---------------------------------------------------------------------------

export function sanitizeFilename(name: string): string {
  return name.replace(/[\[\]\n\r;]/g, '_').replace(/\.\./g, '_')
}
