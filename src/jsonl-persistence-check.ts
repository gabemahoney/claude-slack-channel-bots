/**
 * jsonl-persistence-check.ts — Startup safeguard: detect JSONL transcript loss
 * BEFORE the resume path silently throws ErrJsonlMissing and wipes a persona's memory.
 *
 * Two layers, both fire-safe (never throw, never block startup), run over the
 * applied personas (b.av2 SR-6.2):
 *
 *   Layer 1 — non-persistent storage check (ported from b.a3g design):
 *     resolveJsonlRoots(config, home?)                    — deduped <configDir>/projects roots
 *     checkMountFstype(dirPath, readMountinfo?)           — longest-prefix mount fstype or null
 *     checkJsonlPersistence(config, readMountinfo?, home?) — { nonPersistent[], warnings[] }
 *   A root on tmpfs/ramfs means resume is structurally impossible on this host.
 *   A persona a confirmed apply brings up gets Layer 1 for its own root only
 *   (`runPersonaStorageCheck`).
 *
 *   Layer 2 — per-persona missing-transcript check (the 2026-09-20 incident class):
 *     For each persona, fetch the AD row and stat the persisted vs fallback
 *     JSONL path. If the persisted path is gone but a transcript exists
 *     (fallback path or archived messages since spawn), the resume path WILL
 *     wipe the persona's memory — say so loudly. Idle-since-spawn personas stay
 *     quiet. A row the collision ladder will replace rather than resume (its
 *     `cwd` or `config_dir` label does not match the persona) is only logged.
 *
 * Archive evidence follows b.av2 SR-7.4 (`personaArchiveEvidenceScope`): only
 * the persona's `delivery: all` channels are counted, and a zero count proves
 * nothing when the persona has a `mentions` channel or DMs on. The
 * session manager's transcript-loss diagnosis uses the same helper and count.
 *
 * Warnings reach Slack only through the persona-keyed notice seam (production:
 * the per-persona notifier, b.av2 SR-7.2), which posts to the persona's
 * destination and adds the persona reference.
 *
 * Every external effect (mountinfo read, stat, AD get, archive query, error
 * record, notice, home directory) is injectable so the Test Writer needs no
 * mock.module.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { Database } from 'bun:sqlite'
import type { GetResult } from 'agent-director'
import { resolveRealPathStrict, type Persona, type PersonaConfig, type ServerSettings, type StrictRealPathFs } from './config.ts'
import { recordStartupError as defaultRecordStartupError } from './startup-errors.ts'
import { withOutageDetection } from './outage-state.ts'
import { ErrSpawnNotFound } from './agent-director-errors.ts'
import { isAdErrorInstance } from './ad-error-class.ts'
import { personaInstanceId, renderPersonaRef, resolveClaudeConfigDir } from './persona-identity.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { resolveJsonlPath } from './cozempic.ts'
import { notifySafely, type PersonaNotify } from './persona-notifier.ts'
// Import cycle with session-manager.ts: use these imports only inside functions, never at module top level.
import { compareRowToPersona } from './session-manager.ts'

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

/**
 * Counts archived messages in any of `channelIds` with timestamp strictly
 * after `sinceEpochSeconds`. Returns null when the archive is unconfigured or
 * unreadable. `ref` is the persona reference its log lines name.
 */
export type ArchiveCountSince = (
  channelIds: readonly string[],
  sinceEpochSeconds: number,
  ref: string,
) => number | null

/** Injectable deps for runJsonlPersistenceSafeguard — every real-world effect is a seam. */
export interface JsonlPersistenceSafeguardDeps {
  /** Reads /proc/self/mountinfo (Layer 1). Default: real read. */
  readMountinfo?: () => string
  /** Stats a path; returns true when it exists and is non-empty. Default: real statSync. */
  statFn?: (path: string) => boolean
  /**
   * Fetches the AD row for a persona's instance id (Layer 2). Default routes
   * through withOutageDetection so AD-unreachable is flagged per persona.
   */
  getRow?: (key: string, claudeInstanceId: string) => Promise<GetResult>
  /**
   * Counts archived messages in a persona's evidence channels (Layer 2).
   * Default: `makeDefaultArchiveCount(config)`, which opens
   * config.message_archive_db read-only per query.
   */
  archiveCountSince?: ArchiveCountSince
  recordStartupError?: typeof defaultRecordStartupError
  /**
   * Home directory an unset claude_config_dir resolves against
   * (`<home>/.claude`), also used for the row-vs-persona `config_dir` label.
   * Default: the OS home, read at call time.
   */
  home?: string
  /**
   * Realpath and lstat for resolving each persona's claude_config_dir (Layer
   * 2, bug b.g57): a persona whose directory cannot be resolved is skipped.
   * Default: the real file system.
   */
  configDirFs?: Partial<StrictRealPathFs>
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
// resolveJsonlRoots
// ---------------------------------------------------------------------------

/**
 * A persona's JSONL root: `<effective claude_config_dir>/projects`, the same
 * composition resolveJsonlPath uses. An absent directory means `<home>/.claude`.
 */
function personaJsonlRoot(persona: Pick<Persona, 'claude_config_dir'>, home: string): string {
  return `${resolveClaudeConfigDir(persona.claude_config_dir, home)}/projects`
}

/**
 * Returns the deduplicated set of JSONL root directories across the applied
 * personas: one `<effective claude_config_dir>/projects` per distinct
 * directory. Persona config dirs are already absolute and tilde-expanded; an
 * absent one means `<home>/.claude`. With no personas at all, the home default
 * root is returned.
 *
 * @param home  Home directory for the default; the OS home, read at call time.
 */
export function resolveJsonlRoots(config: PersonaConfig, home: string = homedir()): string[] {
  const roots = new Set<string>()
  for (const persona of config.personas) {
    roots.add(personaJsonlRoot(persona, home))
  }

  // No personas at all: fall back to the home default.
  if (roots.size === 0) {
    roots.add(personaJsonlRoot({}, home))
  }

  return [...roots]
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
 *
 * @param home  Home directory for the default root; the OS home, read at call time.
 */
export function checkJsonlPersistence(
  config: PersonaConfig,
  readMountinfo?: () => string,
  home: string = homedir(),
): JsonlPersistenceCheckResult {
  return classifyJsonlRoots(resolveJsonlRoots(config, home), readMountinfo)
}

/** Classify each root by its mount's fstype (see `checkJsonlPersistence`). Never throws. */
function classifyJsonlRoots(roots: readonly string[], readMountinfo?: () => string): JsonlPersistenceCheckResult {
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
// Archive evidence (b.av2 SR-7.4)
// ---------------------------------------------------------------------------

/** Which archived messages count as evidence of a persona's activity. */
export interface PersonaArchiveEvidenceScope {
  /** IDs of the persona's `delivery: all` channels — the only channels counted. */
  channelIds: string[]
  /**
   * Whether a zero count proves the persona was idle. False when the persona
   * has any `delivery: mentions` channel or `dm.enabled` on: the archive
   * cannot attribute messages from those to a persona, so zero proves nothing.
   */
  zeroIsAttributable: boolean
}

/**
 * A persona's archive-evidence scope (b.av2 SR-7.4). Both the start
 * safeguard's Layer 2 and the session manager's transcript-loss diagnosis
 * classify through this helper, so they agree. Pure.
 */
export function personaArchiveEvidenceScope(
  persona: Pick<Persona, 'channels' | 'dm'>,
): PersonaArchiveEvidenceScope {
  return {
    channelIds: persona.channels.filter((c) => c.delivery === 'all').map((c) => c.id),
    zeroIsAttributable: !persona.dm.enabled && persona.channels.every((c) => c.delivery !== 'mentions'),
  }
}

/**
 * Why a zero archive count is not evidence for a persona whose zero is not
 * attributable. Shared by Layer 2's log line and the diagnosis reason.
 */
export const UNATTRIBUTABLE_ZERO_REASON =
  'the persona has a `delivery: mentions` channel or DMs on, and the message archive cannot attribute ' +
  'messages from `mentions` channels or DMs to a persona, so 0 archived messages since spawn in its ' +
  '`delivery: all` channels proves nothing'

/**
 * Builds a default archive-count function bound to config.message_archive_db.
 * Reads only that setting, so any config carrying it (the persona config,
 * the server settings) satisfies the parameter.
 *
 * The returned function counts messages in any of the given channels with
 * timestamp strictly after `sinceEpochSeconds`. An empty channel set returns
 * 0 without touching the database. Otherwise it opens the existing DB
 * read-only per query (never creates, migrates, or writes it) and returns null
 * when the archive is unconfigured, the DB file does not yet exist (no
 * evidence — do not fabricate an empty archive), or any error occurs
 * (unreadable, bad schema, etc.).
 *
 * The archive stores `timestamp` as REAL epoch seconds (parseFloat of the
 * Slack ts); `started_at` is RFC3339, converted to epoch seconds by the caller.
 */
export function makeDefaultArchiveCount(
  config: Pick<ServerSettings, 'message_archive_db'>,
): ArchiveCountSince {
  return (channelIds: readonly string[], sinceEpochSeconds: number, ref: string): number | null => {
    const ids = [...new Set(channelIds)]
    if (ids.length === 0) return 0
    const dbPath = config.message_archive_db
    if (!dbPath) return null
    // Absent file → no evidence. Opening read-write would silently create an
    // empty archive and mask a real transcript loss as "count 0".
    if (!existsSync(dbPath)) return null
    let db: Database | undefined
    try {
      db = new Database(dbPath, { readonly: true })
      const placeholders = ids.map(() => '?').join(', ')
      const row = db
        .query(`SELECT COUNT(*) AS n FROM messages WHERE channel_id IN (${placeholders}) AND timestamp > ?`)
        .get(...ids, sinceEpochSeconds) as { n: number } | null
      return row ? Number(row.n) : 0
    } catch (err) {
      console.error(`[slack] jsonl-persistence-check: archive count failed for ${ref}: ${describeThrownValue(err)}`)
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

/** Parse an RFC3339 timestamp to epoch seconds; null on unparseable input. */
export function rfc3339ToEpochSeconds(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms / 1000
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
 * single CSCB→AD entry point) so an AD outage is flagged against this persona.
 * b.jg5 SRJ-122: this `get` is not one of SRJ-114's sites, so none of the
 * decisions of `src/row-read-rules.ts` applies here: a liveness note on the
 * row, `provenance_conflict` included, and a `pending` row with no launch
 * start (SRJ-513) latch no one, and a retired key's row read live with its
 * mark set clears no retired-key entry (SRJ-807); they change nothing.
 */
function defaultGetRow(key: string, claudeInstanceId: string): Promise<GetResult> {
  return withOutageDetection(key, undefined, 'get', (client) =>
    client.get({ claude_instance_id: claudeInstanceId }),
  )
}

// ---------------------------------------------------------------------------
// Notice seam
// ---------------------------------------------------------------------------

function personaRef(persona: Pick<Persona, 'name' | 'key'>): string {
  return renderPersonaRef(persona.name, persona.key)
}

/**
 * Send one warning for `persona` through the notice seam. Production always
 * passes the per-persona notifier, dry run included (the notifier then logs
 * instead of posting); no seam (a unit test) means nothing is sent. Never
 * throws.
 */
function sendNotice(notify: PersonaNotify | undefined, persona: Pick<Persona, 'name' | 'key'>, text: string): void {
  if (!notify) return
  notifySafely(notify, persona.key, text, undefined, (err) => {
    console.error(`[slack] jsonl-persistence-check: notice failed for ${personaRef(persona)}: ${describeThrownValue(err)}`)
  })
}

// ---------------------------------------------------------------------------
// Layer 2 — per-persona transcript check
// ---------------------------------------------------------------------------

/** Layer 2's effects, resolved from the deps. */
interface Layer2Effects {
  notify: PersonaNotify | undefined
  statFn: (path: string) => boolean
  getRow: (key: string, id: string) => Promise<GetResult>
  archiveCountSince: ArchiveCountSince
  recordError: typeof defaultRecordStartupError
  home: string
  configDirFs: Partial<StrictRealPathFs> | undefined
}

/**
 * Why the collision ladder will replace this row with a fresh spawn instead
 * of resuming it (E3 Task 3 guards, via `compareRowToPersona`), or undefined
 * when the row matches the persona. A claude_config_dir with no real path
 * gives no `config_dir` verdict, so no mismatch (bug b.g57).
 */
function rowReplacementReason(
  row: GetResult,
  persona: Persona,
  home: string,
  configDirFs: Partial<StrictRealPathFs> | undefined,
): string | undefined {
  const cmp = compareRowToPersona(row, persona, home, undefined, configDirFs)
  if (!cmp.cwdMatches) {
    return `row cwd=${row.cwd || '<none>'} differs from working_directory=${persona.working_directory}`
  }
  if (cmp.configDirMatches === false) {
    const was = cmp.configDirLabel === undefined ? 'missing' : `was=${cmp.configDirLabel}`
    return `row config_dir label ${was}, now=${cmp.expectedConfigDirLabel}`
  }
  return undefined
}

/**
 * Classifies one persona's transcript health and fires the appropriate loud /
 * quiet signal. Isolated per persona — any thrown error is caught by the
 * caller's per-persona try/catch, never aborting the sweep.
 */
async function checkPersonaTranscript(persona: Persona, fx: Layer2Effects): Promise<void> {
  const { key } = persona
  const ref = personaRef(persona)
  const claudeInstanceId = personaInstanceId(key)

  // Bug b.g57: a claude_config_dir with no real path (an unmounted drive, a
  // dropped mount, a symlink pointing to nothing) is not checked this pass:
  // its transcript can't be located, and its launch waits for the directory
  // with the row kept, so there is no lost history to report.
  const configDir = resolveClaudeConfigDir(persona.claude_config_dir, fx.home)
  const resolution = resolveRealPathStrict(configDir, fx.configDirFs)
  if (!resolution.resolved) {
    console.error(
      `[slack] jsonl-persistence-check: ${ref} claude_config_dir="${configDir}" cannot be resolved to a real path ` +
        `(${resolution.code}) — transcript not checked this pass`,
    )
    return
  }

  let row: GetResult
  try {
    row = await fx.getRow(key, claudeInstanceId)
  } catch (err) {
    if (isAdErrorInstance(err, ErrSpawnNotFound)) {
      // Case 1: no row — nothing to lose.
      console.error(`[slack] jsonl-persistence-check: no AD row for ${ref} — nothing to resume`)
      return
    }
    // Case 6: any other AD/get error — warn and move on.
    console.error(`[slack] jsonl-persistence-check: AD get failed for ${ref} — skipping: ${describeThrownValue(err)}`)
    return
  }

  // Case 7: the collision ladder will replace this row rather than resume or
  // reconnect it (b.av2 SR-6.2), so there is no resume to warn about.
  const replacement = rowReplacementReason(row, persona, fx.home, fx.configDirFs)
  if (replacement !== undefined) {
    console.error(
      `[slack] jsonl-persistence-check: ${ref} ${replacement} — the collision ladder will replace this row; ` +
        `transcript not checked`,
    )
    return
  }

  // Case 1 (cont.): row exists but never produced a session — nothing to lose.
  if (!row.claude_session_id) {
    console.error(`[slack] jsonl-persistence-check: ${ref} has no claude_session_id — nothing to resume`)
    return
  }

  const persistedPath = row.jsonl_path
  const fallbackPath = resolveJsonlPath(
    row.cwd,
    row.claude_session_id,
    resolveClaudeConfigDir(persona.claude_config_dir, fx.home),
  )

  const persistedExists = persistedPath ? fx.statFn(persistedPath) : false

  // Case 3: persisted path present and non-empty — healthy, quiet.
  if (persistedExists) return

  const fallbackExists = fx.statFn(fallbackPath)

  // Case 4: persisted gone but fallback exists — the transcript is on disk and
  // AD 0.8.0 only stats the persisted path on resume, so it WILL throw
  // ErrJsonlMissing and the resume path will wipe this persona's memory. LOUD.
  if (fallbackExists) {
    const detail =
      `${ref} instance=${claudeInstanceId}: AD persisted jsonl_path is missing/empty ` +
      `("${persistedPath}") but the transcript EXISTS at the resolved fallback path ("${fallbackPath}"). ` +
      `Resume will throw ErrJsonlMissing and fresh-spawn, destroying conversation history that is on disk.`
    fx.recordError(ERR_KEY_STALE_PATH, detail)
    sendNotice(
      fx.notify,
      persona,
      `⚠️ CSCB startup warning: my saved conversation transcript exists on disk (\`${fallbackPath}\`) but ` +
        `agent-director's recorded path (\`${persistedPath || '(empty)'}\`) points elsewhere. On resume this ` +
        `would be treated as missing and my memory would be wiped. An operator should reconcile the path ` +
        `before the next restart.`,
    )
    return
  }

  // Case 5: transcript does not exist anywhere. Distinguish lost vs never-created
  // using the message archive as evidence, counted over the persona's
  // `delivery: all` channels only (b.av2 SR-7.4).
  const scope = personaArchiveEvidenceScope(persona)
  const startedAtEpoch = rfc3339ToEpochSeconds(row.started_at)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : fx.archiveCountSince(scope.channelIds, startedAtEpoch, ref)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // Conversation provably happened since spawn, yet no transcript survives. LOST.
    const detail =
      `${ref} instance=${claudeInstanceId}: no transcript at persisted ("${persistedPath}") ` +
      `or fallback ("${fallbackPath}") path, but the message archive holds ${archivedSinceSpawn} message(s) ` +
      `since spawn (started_at=${row.started_at}). Conversation history has been LOST; resume will fresh-spawn.`
    fx.recordError(ERR_KEY_LOST, detail)
    sendNotice(
      fx.notify,
      persona,
      `⚠️ CSCB startup warning: my conversation transcript file is gone from disk, but the message archive ` +
        `shows ${archivedSinceSpawn} message(s) since I started. My conversation memory has been lost and ` +
        `resume will start me fresh. An operator should investigate the transcript storage.`,
    )
    return
  }

  // A zero count is not evidence of idleness when the archive cannot see all
  // of the persona's traffic: handled like unavailable evidence, quietly.
  if (archivedSinceSpawn === 0 && !scope.zeroIsAttributable) {
    console.error(
      `[slack] jsonl-persistence-check: ${ref} has no transcript yet ` +
        `(persisted="${persistedPath}", fallback="${fallbackPath}"); archive evidence is inconclusive because ` +
        `${UNATTRIBUTABLE_ZERO_REASON}; resume will fresh-spawn.`,
    )
    return
  }

  // Quiet-but-informative: no transcript anywhere and no archived activity since
  // spawn (or archive unavailable). Expected for a persona idle since spawn —
  // Claude creates the .jsonl lazily on first message. No loud error, no Slack.
  console.error(
    `[slack] jsonl-persistence-check: ${ref} has no transcript yet ` +
      `(persisted="${persistedPath}", fallback="${fallbackPath}") and no archived activity since spawn — ` +
      `expected for an idle-since-spawn persona; resume will fresh-spawn.`,
  )
}

// ---------------------------------------------------------------------------
// Layer 1 — non-persistent storage
// ---------------------------------------------------------------------------

/** Layer 1's effects. */
interface StorageLayerEffects {
  notify: PersonaNotify | undefined
  recordError: typeof defaultRecordStartupError
  readMountinfo: (() => string) | undefined
  home: string
}

/**
 * Layer 1 over `roots`: a non-persistent root is recorded
 * (`jsonl-non-persistent`) and warned about once to each of `personas` whose
 * effective JSONL root it is; a root whose fstype cannot be determined is
 * recorded (`jsonl-persistence-check-warning`), with no notice.
 */
function reportStorageLayer(personas: readonly Persona[], roots: readonly string[], fx: StorageLayerEffects): void {
  const { nonPersistent, warnings } = classifyJsonlRoots(roots, fx.readMountinfo)

  for (const root of nonPersistent) {
    fx.recordError(
      ERR_KEY_NON_PERSISTENT,
      `JSONL storage root is on a non-persistent filesystem (tmpfs/ramfs) — resume is structurally impossible on this host. root="${root}"`,
    )
    // Roots are per persona, so notify only the personas whose effective
    // JSONL root is this flagged non-persistent root.
    for (const persona of personas) {
      if (personaJsonlRoot(persona, fx.home) !== root) continue
      sendNotice(
        fx.notify,
        persona,
        `⚠️ CSCB startup warning: my conversation storage at \`${root}\` is on a non-persistent filesystem ` +
          `(tmpfs/ramfs). Session resume will not survive a reboot on this host.`,
      )
    }
  }

  for (const root of warnings) {
    fx.recordError(
      ERR_KEY_PERSISTENCE_WARNING,
      `Could not determine filesystem type for JSONL storage root — persistence unverified. root="${root}"`,
    )
  }
}

/**
 * The non-persistent-storage check (Layer 1) for one persona's effective
 * JSONL root only (b.av2 SR-6.2): a persona brought up by a confirmed apply.
 * Its warning goes to that persona alone, through `notify` (the per-persona
 * notifier, which holds it until the persona's client is validated), and is
 * recorded as at start; no other persona is checked or warned. Layer 2 does
 * not run: the launch's collision ladder handles the persona's row. Never
 * throws; its own unexpected failure is one warning line.
 */
export function runPersonaStorageCheck(
  persona: Persona,
  notify: PersonaNotify | undefined,
  deps?: Pick<JsonlPersistenceSafeguardDeps, 'readMountinfo' | 'recordStartupError' | 'home'>,
): void {
  try {
    const home = deps?.home ?? homedir()
    reportStorageLayer([persona], [personaJsonlRoot(persona, home)], {
      notify,
      recordError: deps?.recordStartupError ?? defaultRecordStartupError,
      readMountinfo: deps?.readMountinfo,
      home,
    })
  } catch (err) {
    console.error(
      `[slack] Warning: jsonl-persistence-check failed unexpectedly for ${personaRef(persona)} — continuing: ` +
        describeThrownValue(err),
    )
  }
}

// ---------------------------------------------------------------------------
// runJsonlPersistenceSafeguard — orchestrating entry point
// ---------------------------------------------------------------------------

/**
 * Startup safeguard: runs Layer 1 (non-persistent storage) then Layer 2
 * (per-persona transcript loss detection) over the applied personas. Designed
 * to be awaited between trustBootstrap and startupSessionManager in main(),
 * wrapped so a rejection can never kill startup.
 *
 * `notify` is the persona-keyed notice seam: it takes a persona key and a
 * notice body (production: the per-persona notifier).
 *
 * - Non-persistent root: recordStartupError(jsonl-non-persistent) + one
 *   notice per persona whose effective JSONL root is that root.
 * - Unresolvable root fstype: recordStartupError(jsonl-persistence-check-warning),
 *   no notice.
 * - Per-persona stale-path / lost-transcript: loud (record + notice to that persona).
 * - Idle-since-spawn persona, or a zero count the archive cannot attribute
 *   (b.av2 SR-7.4): single quiet console line, no loud signal.
 * - A row the collision ladder will replace rather than resume: single
 *   quiet console line, no loud signal.
 * - A persona whose claude_config_dir cannot be resolved to a real path (bug
 *   b.g57): skipped for this pass before any AD call, with one quiet console
 *   line; no lost-history, inconclusive or transcript-loss signal and no
 *   label mismatch (its launch waits for the directory, row kept).
 * - notify undefined (a unit test): no notices; loud errors still recorded.
 * - Own unexpected failure: one warning line, returns (never throws).
 */
export async function runJsonlPersistenceSafeguard(
  config: PersonaConfig,
  notify: PersonaNotify | undefined,
  deps?: JsonlPersistenceSafeguardDeps,
): Promise<void> {
  const recordError = deps?.recordStartupError ?? defaultRecordStartupError
  const readMountinfo = deps?.readMountinfo

  try {
    const home = deps?.home ?? homedir()
    const fx: Layer2Effects = {
      notify,
      statFn: deps?.statFn ?? defaultStatFn,
      getRow: deps?.getRow ?? defaultGetRow,
      archiveCountSince: deps?.archiveCountSince ?? makeDefaultArchiveCount(config),
      recordError,
      home,
      configDirFs: deps?.configDirFs,
    }

    // Layer 1 — non-persistent storage.
    reportStorageLayer(config.personas, resolveJsonlRoots(config, home), { notify, recordError, readMountinfo, home })

    // Layer 2 — per-persona transcript loss. Isolated per persona.
    for (const persona of config.personas) {
      try {
        await checkPersonaTranscript(persona, fx)
      } catch (err) {
        console.error(
          `[slack] jsonl-persistence-check: unexpected error checking ${personaRef(persona)} — continuing: ` +
            describeThrownValue(err),
        )
      }
    }
  } catch (err) {
    console.error(`[slack] Warning: jsonl-persistence-check failed unexpectedly — startup continues: ${describeThrownValue(err)}`)
  }
}
