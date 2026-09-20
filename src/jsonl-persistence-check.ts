/**
 * jsonl-persistence-check.ts — Startup safeguard: detect JSONL transcript loss
 * BEFORE the resume path silently throws ErrJsonlMissing and wipes a channel.
 *
 * Two layers, both fire-safe (never throw, never block startup):
 *
 *   Layer 1 — non-persistent storage check (ported from b.a3g design):
 *     resolveJsonlRoots(config)                    — deduped <configDir>/projects roots
 *     checkMountFstype(dirPath, readMountinfo?)     — longest-prefix mount fstype or null
 *     checkJsonlPersistence(config, readMountinfo?) — { nonPersistent[], warnings[] }
 *   A root on tmpfs/ramfs means resume is structurally impossible on this host.
 *
 *   Layer 2 — per-channel missing-transcript check (the 2026-09-20 incident class):
 *     For each route, fetch the AD row and stat the persisted vs fallback JSONL
 *     path. If the persisted path is gone but a transcript exists (fallback path
 *     or archived messages since spawn), the resume path WILL wipe the channel —
 *     say so loudly. Idle-since-spawn channels stay quiet.
 *
 * Every external effect (mountinfo read, stat, AD get, archive query, error
 * record, Slack post) is injectable so the Test Writer needs no mock.module.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { Database } from 'bun:sqlite'
import type { WebClient } from '@slack/web-api'
import type { GetResult } from 'agent-director'
import type { RoutingConfig } from './config.ts'
import { recordStartupError as defaultRecordStartupError } from './startup-errors.ts'
import { withOutageDetection } from './outage-state.ts'
import { ErrSpawnNotFound } from './agent-director-errors.ts'
import {
  instanceIdFor,
  getNormalizedNameForChannel,
} from './session-manager.ts'
import { resolveJsonlPath } from './cozempic.ts'

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

/** Injectable deps for runJsonlPersistenceSafeguard — every real-world effect is a seam. */
export interface JsonlPersistenceSafeguardDeps {
  /** Reads /proc/self/mountinfo (Layer 1). Default: real read. */
  readMountinfo?: () => string
  /** Stats a path; returns true when it exists and is non-empty. Default: real statSync. */
  statFn?: (path: string) => boolean
  /**
   * Fetches the AD row for a channel's instance id (Layer 2). Default routes
   * through withOutageDetection so AD-unreachable is flagged per channel.
   */
  getRow?: (channelId: string, claudeInstanceId: string) => Promise<GetResult>
  /**
   * Counts archived messages for a channel with timestamp strictly after
   * `sinceEpochSeconds`. Returns null when the archive is unconfigured or
   * unreadable. Default: opens config.message_archive_db read-only per query.
   */
  archiveCountSince?: (channelId: string, sinceEpochSeconds: number) => number | null
  recordStartupError?: typeof defaultRecordStartupError
  postFn?: (web: WebClient, channelId: string, text: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Non-persistent filesystem types
// ---------------------------------------------------------------------------

/** Filesystem types that cannot persist data across reboots. */
const NON_PERSISTENT_FSTYPES = new Set(['tmpfs', 'ramfs'])

/** Distinct startup-error keys — grep anchors, kept together for discoverability. */
const ERR_KEY_NON_PERSISTENT = 'jsonl-non-persistent'
const ERR_KEY_PERSISTENCE_WARNING = 'jsonl-persistence-check-warning'
const ERR_KEY_STALE_PATH = 'jsonl-transcript-stale-path'
const ERR_KEY_LOST = 'jsonl-transcript-lost'

// ---------------------------------------------------------------------------
// resolveEffectiveConfigDir — shared precedence for Layer 1 and Layer 2
// ---------------------------------------------------------------------------

/**
 * Effective on-disk Claude config dir for a route, using the same precedence as
 * buildSpawnParams: route.claude_config_dir ?? global claude_config_dir. Returns
 * undefined when neither is set (the homedir default), so callers can pass it
 * straight to resolveJsonlPath (which defaults to homedir on undefined).
 */
function resolveEffectiveConfigDir(
  config: RoutingConfig,
  channelId: string,
): string | undefined {
  return config.routes[channelId]?.claude_config_dir ?? config.claude_config_dir
}

// ---------------------------------------------------------------------------
// resolveJsonlRoots
// ---------------------------------------------------------------------------

/**
 * Returns the deduplicated set of JSONL root directories across all configured
 * routes. Each root is <effectiveConfigDir>/projects — the same composition
 * resolveJsonlPath uses. Config values are already tilde-expanded and
 * resolve()d at load time; only the homedir default and the /projects suffix
 * are added here.
 */
export function resolveJsonlRoots(config: RoutingConfig): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const defaultConfigDir = `${homedir()}/.claude`

  for (const channelId of Object.keys(config.routes)) {
    const effectiveConfigDir = resolveEffectiveConfigDir(config, channelId) ?? defaultConfigDir
    const root = `${effectiveConfigDir}/projects`
    if (!seen.has(root)) {
      seen.add(root)
      roots.push(root)
    }
  }

  // If no routes at all (shouldn't happen post-validation but be safe),
  // fall back to the homedir default.
  if (roots.length === 0) {
    roots.push(`${defaultConfigDir}/projects`)
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

  const sepIdx = trimmed.indexOf(' - ')
  if (sepIdx === -1) return null

  const beforeSep = trimmed.slice(0, sepIdx)
  const afterSep = trimmed.slice(sepIdx + 3)

  const beforeParts = beforeSep.split(' ')
  // Minimum fields before separator: mountid parentid major:minor root mountpoint mountopts
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
 * over /proc/self/mountinfo content. Returns null on unresolvable or malformed
 * input. Never throws. Uses string-prefix matching — does NOT stat dirPath, so
 * a not-yet-created directory classifies by its parent mount.
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

  const normalised = dirPath === '/' ? '/' : dirPath.replace(/\/+$/, '')

  let bestMatchLength = -1
  let bestFstype: string | null = null

  for (const line of content.split('\n')) {
    const parsed = parseMountinfoLine(line)
    if (!parsed) continue

    const { mountPoint, fstype } = parsed
    const mp = mountPoint === '/' ? '/' : mountPoint.replace(/\/+$/, '')

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
 * - warnings: roots whose fstype could not be determined (one entry per root)
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
// Default effect implementations (Layer 2)
// ---------------------------------------------------------------------------

/** Default stat: true when the path exists and is a non-empty regular file. */
function defaultStatFn(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/**
 * Default AD row fetch — routed through withOutageDetection (the sanctioned
 * single CSCB→AD entry point) so an AD outage is flagged against this channel.
 */
function defaultGetRow(channelId: string, claudeInstanceId: string): Promise<GetResult> {
  return withOutageDetection(channelId, undefined, (client) =>
    client.get({ claude_instance_id: claudeInstanceId }),
  )
}

/**
 * Builds a default archive-count function bound to config.message_archive_db.
 * Opens the existing DB read-only per query (never creates, migrates, or writes
 * it) and counts messages for the channel with timestamp strictly after
 * `sinceEpochSeconds`. Returns null when the archive is unconfigured, the DB
 * file does not yet exist (no evidence — do not fabricate an empty archive), or
 * any error occurs (unreadable, bad schema, etc.).
 *
 * The archive stores `timestamp` as REAL epoch seconds (parseFloat of the
 * Slack ts); `started_at` is RFC3339, converted to epoch seconds by the caller.
 */
function makeDefaultArchiveCount(
  config: RoutingConfig,
): (channelId: string, sinceEpochSeconds: number) => number | null {
  return (channelId: string, sinceEpochSeconds: number): number | null => {
    const dbPath = config.message_archive_db
    if (!dbPath) return null
    // Absent file → no evidence. Opening read-write would silently create an
    // empty archive and mask a real transcript loss as "count 0".
    if (!existsSync(dbPath)) return null
    let db: Database | undefined
    try {
      db = new Database(dbPath, { readonly: true })
      const row = db
        .query('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND timestamp > ?')
        .get(channelId, sinceEpochSeconds) as { n: number } | null
      return row ? Number(row.n) : 0
    } catch (err) {
      console.error(
        `[slack] jsonl-persistence-check: archive count failed for channel=${channelId}:`,
        err,
      )
      return null
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Default Slack post: fire-and-forget chat.postMessage. */
async function defaultPostFn(web: WebClient, channelId: string, text: string): Promise<void> {
  await web.chat.postMessage({ channel: channelId, text })
}

/** Parse an RFC3339 timestamp to epoch seconds; null on unparseable input. */
function rfc3339ToEpochSeconds(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms / 1000
}

// ---------------------------------------------------------------------------
// Layer 2 — per-channel transcript check
// ---------------------------------------------------------------------------

/**
 * Classifies one channel's transcript health and fires the appropriate loud /
 * quiet signal. Isolated per channel — any thrown error is caught by the
 * caller's per-channel try/catch, never aborting the sweep.
 */
async function checkChannelTranscript(
  config: RoutingConfig,
  channelId: string,
  web: WebClient | undefined,
  statFn: (path: string) => boolean,
  getRow: (channelId: string, id: string) => Promise<GetResult>,
  archiveCountSince: (channelId: string, sinceEpochSeconds: number) => number | null,
  recordError: typeof defaultRecordStartupError,
  postFn: (web: WebClient, channelId: string, text: string) => Promise<void>,
): Promise<void> {
  const normalizedName = getNormalizedNameForChannel(channelId, config)
  const claudeInstanceId = instanceIdFor(channelId, normalizedName)

  let row: GetResult
  try {
    row = await getRow(channelId, claudeInstanceId)
  } catch (err) {
    if (err instanceof ErrSpawnNotFound) {
      // Case 1: no row — nothing to lose.
      console.error(`[slack] jsonl-persistence-check: no AD row for channel=${channelId} — nothing to resume`)
      return
    }
    // Case 6: any other AD/get error — warn and move on.
    console.error(`[slack] jsonl-persistence-check: AD get failed for channel=${channelId} — skipping:`, err)
    return
  }

  // Case 1 (cont.): row exists but never produced a session — nothing to lose.
  if (!row.claude_session_id) {
    console.error(`[slack] jsonl-persistence-check: channel=${channelId} has no claude_session_id — nothing to resume`)
    return
  }

  const effectiveConfigDir = resolveEffectiveConfigDir(config, channelId)
  const persistedPath = row.jsonl_path
  const fallbackPath = resolveJsonlPath(row.cwd, row.claude_session_id, effectiveConfigDir)

  const persistedExists = persistedPath ? statFn(persistedPath) : false

  // Case 3: persisted path present and non-empty — healthy, quiet.
  if (persistedExists) return

  const fallbackExists = statFn(fallbackPath)

  // Case 4: persisted gone but fallback exists — the transcript is on disk and
  // AD 0.8.0 only stats the persisted path on resume, so it WILL throw
  // ErrJsonlMissing and the resume path will wipe this channel. LOUD.
  if (fallbackExists) {
    const detail =
      `channel=${channelId} instance=${claudeInstanceId}: AD persisted jsonl_path is missing/empty ` +
      `("${persistedPath}") but the transcript EXISTS at the resolved fallback path ("${fallbackPath}"). ` +
      `Resume will throw ErrJsonlMissing and fresh-spawn, destroying conversation history that is on disk.`
    recordError(ERR_KEY_STALE_PATH, detail)
    if (web !== undefined) {
      postFn(
        web,
        channelId,
        `⚠️ CSCB startup warning: my saved conversation transcript exists on disk (\`${fallbackPath}\`) but ` +
          `agent-director's recorded path (\`${persistedPath || '(empty)'}\`) points elsewhere. On resume this ` +
          `would be treated as missing and my memory would be wiped. An operator should reconcile the path ` +
          `before the next restart.`,
      ).catch((err: unknown) => {
        console.error(`[slack] jsonl-persistence-check: failed to post stale-path warning to channel=${channelId}:`, err)
      })
    }
    return
  }

  // Case 5: transcript does not exist anywhere. Distinguish lost vs never-created
  // using the message archive as evidence.
  const startedAtEpoch = rfc3339ToEpochSeconds(row.started_at)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : archiveCountSince(channelId, startedAtEpoch)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // Conversation provably happened since spawn, yet no transcript survives. LOST.
    const detail =
      `channel=${channelId} instance=${claudeInstanceId}: no transcript at persisted ("${persistedPath}") ` +
      `or fallback ("${fallbackPath}") path, but the message archive holds ${archivedSinceSpawn} message(s) ` +
      `since spawn (started_at=${row.started_at}). Conversation history has been LOST; resume will fresh-spawn.`
    recordError(ERR_KEY_LOST, detail)
    if (web !== undefined) {
      postFn(
        web,
        channelId,
        `⚠️ CSCB startup warning: my conversation transcript file is gone from disk, but the message archive ` +
          `shows ${archivedSinceSpawn} message(s) since I started. My memory of this channel has been lost and ` +
          `resume will start me fresh. An operator should investigate the transcript storage.`,
      ).catch((err: unknown) => {
        console.error(`[slack] jsonl-persistence-check: failed to post lost-transcript warning to channel=${channelId}:`, err)
      })
    }
    return
  }

  // Quiet-but-informative: no transcript anywhere and no archived activity since
  // spawn (or archive unavailable). Expected for a channel idle since spawn —
  // Claude creates the .jsonl lazily on first message. No loud error, no Slack.
  console.error(
    `[slack] jsonl-persistence-check: channel=${channelId} has no transcript yet ` +
      `(persisted="${persistedPath}", fallback="${fallbackPath}") and no archived activity since spawn — ` +
      `expected for an idle-since-spawn channel; resume will fresh-spawn.`,
  )
}

// ---------------------------------------------------------------------------
// runJsonlPersistenceSafeguard — orchestrating entry point
// ---------------------------------------------------------------------------

/**
 * Startup safeguard: runs Layer 1 (non-persistent storage) then Layer 2
 * (per-channel transcript loss detection). Designed to be awaited between
 * trustBootstrap and startupSessionManager in main(), wrapped so a rejection
 * can never kill startup.
 *
 * - Non-persistent root: recordStartupError(jsonl-non-persistent) + one
 *   chat.postMessage per routed channel (when web is provided).
 * - Unresolvable root fstype: recordStartupError(jsonl-persistence-check-warning),
 *   no Slack post.
 * - Per-channel stale-path / lost-transcript: loud (record + Slack to that channel).
 * - Idle-since-spawn channel: single quiet console line, no loud signal.
 * - web undefined (dry-run): no Slack posts; loud errors still recorded.
 * - Own unexpected failure: one warning line, returns (never throws).
 */
export async function runJsonlPersistenceSafeguard(
  config: RoutingConfig,
  web: WebClient | undefined,
  deps?: JsonlPersistenceSafeguardDeps,
): Promise<void> {
  const recordError = deps?.recordStartupError ?? defaultRecordStartupError
  const postFn = deps?.postFn ?? defaultPostFn
  const readMountinfo = deps?.readMountinfo
  const statFn = deps?.statFn ?? defaultStatFn
  const getRow = deps?.getRow ?? defaultGetRow
  const archiveCountSince = deps?.archiveCountSince ?? makeDefaultArchiveCount(config)

  try {
    // Layer 1 — non-persistent storage.
    const { nonPersistent, warnings } = checkJsonlPersistence(config, readMountinfo)
    const channelIds = Object.keys(config.routes)

    for (const root of nonPersistent) {
      recordError(
        ERR_KEY_NON_PERSISTENT,
        `JSONL storage root is on a non-persistent filesystem (tmpfs/ramfs) — resume is structurally impossible on this host. root="${root}"`,
      )
      if (web !== undefined) {
        // Roots are per-channel (resolveEffectiveConfigDir), so post only to the
        // channels whose effective JSONL root is this flagged non-persistent root.
        const defaultConfigDir = `${homedir()}/.claude`
        for (const channelId of channelIds) {
          const effectiveConfigDir = resolveEffectiveConfigDir(config, channelId) ?? defaultConfigDir
          if (`${effectiveConfigDir}/projects` !== root) continue
          postFn(
            web,
            channelId,
            `⚠️ CSCB startup warning: my conversation storage at \`${root}\` is on a non-persistent filesystem ` +
              `(tmpfs/ramfs). Session resume will not survive a reboot on this host.`,
          ).catch((err: unknown) => {
            console.error(`[slack] jsonl-persistence-check: failed to post non-persistent warning to channel=${channelId}:`, err)
          })
        }
      }
    }

    for (const root of warnings) {
      recordError(
        ERR_KEY_PERSISTENCE_WARNING,
        `Could not determine filesystem type for JSONL storage root — persistence unverified. root="${root}"`,
      )
    }

    // Layer 2 — per-channel transcript loss. Isolated per channel.
    for (const channelId of channelIds) {
      try {
        await checkChannelTranscript(
          config,
          channelId,
          web,
          statFn,
          getRow,
          archiveCountSince,
          recordError,
          postFn,
        )
      } catch (err) {
        console.error(`[slack] jsonl-persistence-check: unexpected error checking channel=${channelId} — continuing:`, err)
      }
    }
  } catch (err) {
    console.error('[slack] Warning: jsonl-persistence-check failed unexpectedly — startup continues:', err)
  }
}
