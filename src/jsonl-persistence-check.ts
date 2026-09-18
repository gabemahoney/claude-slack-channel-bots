/**
 * jsonl-persistence-check.ts — Startup safeguard: detect non-persistent JSONL storage.
 *
 * Pure logic module with injectable /proc/self/mountinfo reader. No filesystem
 * access at import time. All exported functions are independently testable
 * with a fixture readMountinfo seam.
 *
 * Exported API:
 *   resolveJsonlRoots(config)                      — deduplicated JSONL root dirs
 *   checkMountFstype(dirPath, readMountinfo?)       — longest-prefix mount fstype or null
 *   checkJsonlPersistence(config, readMountinfo?)   — { nonPersistent[], warnings[] }
 *   _runJsonlPersistenceSafeguard(config, web, deps?) — injectable startup helper
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { WebClient } from '@slack/web-api'
import type { RoutingConfig } from './config.ts'
import { recordStartupError as defaultRecordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of checkJsonlPersistence: roots confirmed non-persistent, and roots that warned. */
export interface JsonlPersistenceCheckResult {
  /** Roots whose mount fstype is tmpfs or ramfs — resume is structurally impossible. */
  nonPersistent: string[]
  /** Roots whose fstype could not be determined (unreadable/unparseable/unresolvable). */
  warnings: string[]
}

/** Injectable deps for _runJsonlPersistenceSafeguard. */
export interface JsonlPersistenceSafeguardDeps {
  readMountinfo?: () => string
  recordStartupError?: typeof defaultRecordStartupError
  postFn?: (web: WebClient, channelId: string, text: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Non-persistent filesystem types
// ---------------------------------------------------------------------------

/** Filesystem types that cannot persist data across reboots. */
const NON_PERSISTENT_FSTYPES = new Set(['tmpfs', 'ramfs'])

// ---------------------------------------------------------------------------
// resolveJsonlRoots
// ---------------------------------------------------------------------------

/**
 * Returns the deduplicated set of JSONL root directories across all configured
 * routes. Each root is <effectiveConfigDir>/projects — the same composition
 * resolveJsonlPath uses — where effectiveConfigDir is resolved using the same
 * precedence as buildSpawnParams: route.claude_config_dir ?? global
 * claude_config_dir ?? homedir()/.claude.
 *
 * Config values are already tilde-expanded and resolve()d at load time (via
 * resolveConfig in config.ts). Only the homedir default and the /projects
 * suffix are added here. Never double-expands configured dirs.
 */
export function resolveJsonlRoots(config: RoutingConfig): string[] {
  const seen = new Set<string>()
  const roots: string[] = []

  const defaultConfigDir = `${homedir()}/.claude`

  for (const [channelId, route] of Object.entries(config.routes)) {
    const effectiveConfigDir =
      config.routes[channelId]?.claude_config_dir ??
      config.claude_config_dir ??
      defaultConfigDir
    const root = `${effectiveConfigDir}/projects`
    if (!seen.has(root)) {
      seen.add(root)
      roots.push(root)
    }
    void route // satisfy linter — we only need channelId for the lookup above
  }

  // If no routes at all (shouldn't happen post-validation but be safe),
  // fall back to the homedir default.
  if (roots.length === 0) {
    const fallback = `${defaultConfigDir}/projects`
    roots.push(fallback)
  }

  return roots
}

// ---------------------------------------------------------------------------
// checkMountFstype
// ---------------------------------------------------------------------------

/**
 * Default reader: reads /proc/self/mountinfo synchronously. Never called at
 * import time — only when the returned function is invoked.
 */
function defaultReadMountinfo(): string {
  return readFileSync('/proc/self/mountinfo', 'utf-8')
}

/**
 * Parses a single line of /proc/self/mountinfo and returns the mount point
 * and fstype, or null if the line is malformed.
 *
 * Format (kernel docs):
 *   <mountid> <parentid> <major:minor> <root> <mountpoint> <mountopts>
 *   [optional fields] - <fstype> <mountsource> <superopts>
 */
function parseMountinfoLine(line: string): { mountPoint: string; fstype: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Find the separator ' - ' that terminates optional fields
  const sepIdx = trimmed.indexOf(' - ')
  if (sepIdx === -1) return null

  const beforeSep = trimmed.slice(0, sepIdx)
  const afterSep = trimmed.slice(sepIdx + 3)

  const beforeParts = beforeSep.split(' ')
  // Minimum required fields before separator: mountid parentid major:minor root mountpoint mountopts
  if (beforeParts.length < 6) return null

  const mountPoint = beforeParts[4]

  const afterParts = afterSep.split(' ')
  if (afterParts.length < 1) return null
  const fstype = afterParts[0]

  if (!mountPoint || !fstype) return null
  return { mountPoint, fstype }
}

/**
 * Finds the fstype of the mount covering dirPath by longest-prefix matching
 * over /proc/self/mountinfo content. Returns null on unresolvable or malformed input.
 * Never throws.
 *
 * Uses string-prefix matching — does NOT stat dirPath or any subdirectory.
 * A not-yet-created directory classifies by its parent mount.
 *
 * @param dirPath      The directory path to classify (absolute).
 * @param readMountinfo  Injectable reader (default: reads real /proc/self/mountinfo).
 */
export function checkMountFstype(
  dirPath: string,
  readMountinfo?: () => string,
): string | null {
  const reader = readMountinfo ?? defaultReadMountinfo

  let content: string
  try {
    content = reader()
  } catch {
    return null
  }

  // Normalise the path: strip trailing slash, except root '/'
  const normalised = dirPath === '/' ? '/' : dirPath.replace(/\/+$/, '')

  let bestMatchLength = -1
  let bestFstype: string | null = null

  for (const line of content.split('\n')) {
    const parsed = parseMountinfoLine(line)
    if (!parsed) continue

    const { mountPoint, fstype } = parsed

    // Normalise mount point
    const mp = mountPoint === '/' ? '/' : mountPoint.replace(/\/+$/, '')

    // Check prefix match: normalised path must equal mp, or start with mp + '/'
    const isMatch =
      normalised === mp ||
      (mp !== '/' && normalised.startsWith(mp + '/')) ||
      mp === '/'

    if (isMatch && mp.length > bestMatchLength) {
      bestMatchLength = mp.length
      bestFstype = fstype
    }
  }

  return bestFstype
}

// ---------------------------------------------------------------------------
// checkJsonlPersistence
// ---------------------------------------------------------------------------

/**
 * Checks all JSONL root directories for persistence. Returns:
 * - nonPersistent: roots on tmpfs/ramfs (resume is structurally impossible)
 * - warnings: roots whose fstype could not be determined
 *
 * One warning entry per unresolvable root (per-root, not collapsed).
 * Never throws.
 */
export function checkJsonlPersistence(
  config: RoutingConfig,
  readMountinfo?: () => string,
): JsonlPersistenceCheckResult {
  const roots = resolveJsonlRoots(config)
  const nonPersistent: string[] = []
  const warnings: string[] = []

  for (const root of roots) {
    let fstype: string | null = null
    try {
      fstype = checkMountFstype(root, readMountinfo)
    } catch {
      warnings.push(root)
      continue
    }

    if (fstype === null) {
      warnings.push(root)
    } else if (NON_PERSISTENT_FSTYPES.has(fstype)) {
      nonPersistent.push(root)
    }
    // else: persistent (ext4, overlay, etc.) — no action
  }

  return { nonPersistent, warnings }
}

// ---------------------------------------------------------------------------
// _runJsonlPersistenceSafeguard
// ---------------------------------------------------------------------------

/**
 * Default Slack post function: fire-and-forget chat.postMessage.
 */
async function defaultPostFn(web: WebClient, channelId: string, text: string): Promise<void> {
  await web.chat.postMessage({ channel: channelId, text })
}

/**
 * Injectable startup helper: checks JSONL persistence and records errors /
 * posts to Slack for non-persistent roots. Designed to be called fire-and-
 * forget between trustBootstrap and startupSessionManager in main().
 *
 * - Non-persistent root: recordStartupError('jsonl-non-persistent', ...) + one
 *   chat.postMessage per configured route channel (when web is provided).
 * - Unresolvable root: recordStartupError('jsonl-persistence-check-warning', ...)
 *   once per root. No Slack post.
 * - web undefined (dry-run): no Slack posts, loud errors still recorded.
 * - Own unexpected failure: logs a single warning line and returns (never throws).
 *
 * Exported for testing with stub deps — no mock.module needed.
 */
export async function _runJsonlPersistenceSafeguard(
  config: RoutingConfig,
  web: WebClient | undefined,
  deps?: JsonlPersistenceSafeguardDeps,
): Promise<void> {
  const recordError = deps?.recordStartupError ?? defaultRecordStartupError
  const postFn = deps?.postFn ?? defaultPostFn
  const readMountinfo = deps?.readMountinfo

  try {
    const { nonPersistent, warnings } = checkJsonlPersistence(config, readMountinfo)

    const channelIds = Object.keys(config.routes)

    for (const root of nonPersistent) {
      recordError(
        'jsonl-non-persistent',
        `JSONL storage root is on a non-persistent filesystem (tmpfs/ramfs) — resume is structurally impossible on this host. root="${root}"`,
      )

      if (web !== undefined) {
        for (const channelId of channelIds) {
          postFn(web, channelId, `⚠️ CSCB startup warning: JSONL storage at \`${root}\` is on a non-persistent filesystem (tmpfs/ramfs). Session resume will not work on this host.`)
            .catch((err: unknown) => {
              console.error(`[slack] jsonl-persistence-check: failed to post to channel=${channelId}:`, err)
            })
        }
      }
    }

    for (const root of warnings) {
      recordError(
        'jsonl-persistence-check-warning',
        `Could not determine filesystem type for JSONL storage root — persistence unverified. root="${root}"`,
      )
    }
  } catch (err) {
    console.error('[slack] Warning: jsonl-persistence-check failed unexpectedly — startup continues:', err)
  }
}
