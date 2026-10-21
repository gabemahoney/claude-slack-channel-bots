/**
 * jsonl-persistence-check.ts — Storage persistence and AD transcript references.
 *
 * The storage check reads mountinfo for configured directories. The transcript
 * check reports only agent-director's current-session and history fields; it
 * does not reconstruct native paths or infer agent history from Slack traffic.
 * Both checks are isolated per persona and never block startup.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { GetResult } from 'agent-director'
import {
  resolveRealPathStrict,
  type Persona,
  type PersonaConfig,
  type StrictRealPathFs,
} from './config.ts'
import { recordStartupError as defaultRecordStartupError } from './startup-errors.ts'
import { withOutageDetection } from './outage-state.ts'
import { ErrSpawnNotFound } from './agent-director-errors.ts'
import { isAdErrorInstance } from './ad-error-class.ts'
import { personaInstanceId, renderPersonaRef, resolveClaudeConfigDir } from './persona-identity.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { describeTranscriptReference, type TranscriptRowFields } from './session-transcript.ts'
import { notifySafely, type PersonaNotify } from './persona-notifier.ts'
// Import cycle with session-manager.ts: use these imports only inside functions, never at module top level.
import { compareRowToPersona } from './session-manager.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of checkJsonlPersistence: roots confirmed non-persistent, and roots that warned. */
export interface JsonlPersistenceCheckResult {
  /** Configured directories whose mount fstype is tmpfs or ramfs. */
  nonPersistent: string[]
  /** Roots whose fstype could not be determined (unreadable/unparseable/unresolvable). */
  warnings: string[]
}

/** Injectable deps for runJsonlPersistenceSafeguard — every real-world effect is a seam. */
export interface JsonlPersistenceSafeguardDeps {
  /** Live startup shutdown query. A thrown query stops the pass as well. */
  isShuttingDown?: () => boolean
  /** Reads /proc/self/mountinfo (Layer 1). Default: real read. */
  readMountinfo?: () => string
  /**
   * Fetches the AD row for a persona's instance id (Layer 2). Default routes
   * through withOutageDetection so AD-unreachable is flagged per persona.
   */
  getRow?: (key: string, instanceId: string) => Promise<GetResult>
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
const ERR_KEY_TRANSCRIPT_REFERENCE = 'jsonl-transcript-reference-warning'

// ---------------------------------------------------------------------------
// resolveJsonlRoots
// ---------------------------------------------------------------------------

/**
 * The configured storage directory, without assuming a native transcript layout.
 * An absent directory means `<home>/.claude`.
 */
function personaJsonlRoot(persona: Pick<Persona, 'claude_config_dir'>, home: string): string {
  return resolveClaudeConfigDir(persona.claude_config_dir, home)
}

/**
 * Returns the deduplicated set of configured storage directories across the
 * applied personas: one effective `claude_config_dir` per distinct
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
 * - nonPersistent: configured directories on tmpfs/ramfs
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
// Default effect implementations (Layer 2)
// ---------------------------------------------------------------------------

/**
 * Default AD row fetch — routed through withOutageDetection (the sanctioned
 * single CSCB→AD entry point) so an AD outage is flagged against this persona.
 * b.jg5 SRJ-122: this `get` is not one of SRJ-114's sites, so none of the
 * decisions of `src/row-read-rules.ts` applies here: a liveness note on the
 * row, `provenance_conflict` included, and a `pending` row with no launch
 * start (SRJ-513) latch no one, and a retired key's row read live with its
 * mark set clears no retired-key entry (SRJ-807); they change nothing.
 */
function defaultGetRow(key: string, instanceId: string, isShuttingDown: () => boolean): Promise<GetResult> {
  return withOutageDetection(key, undefined, 'get', (client) =>
    client.get({ instance_id: instanceId }),
    { isShuttingDown },
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
// Layer 2 — agent-director transcript references
// ---------------------------------------------------------------------------

/** Layer 2's effects, resolved from the deps. */
interface Layer2Effects {
  notify: PersonaNotify | undefined
  isShuttingDown: () => boolean
  getRow: (key: string, id: string) => Promise<GetResult>
  recordError: typeof defaultRecordStartupError
  home: string
  configDirFs: Partial<StrictRealPathFs> | undefined
}

/**
 * Why the collision ladder will replace this row with a fresh spawn instead
 * of resuming it (the guards of `compareRowToPersona`), or undefined
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
  if (!cmp.tagPrompt) return 'row tag_prompt marker missing (b.omv SR-7.6)'
  if (cmp.configDirMatches === false) {
    const was = cmp.configDirLabel === undefined ? 'missing' : `was=${cmp.configDirLabel}`
    return `row config_dir label ${was}, now=${cmp.expectedConfigDirLabel}`
  }
  return undefined
}

/**
 * Reports one persona's AD transcript references without inferring disk loss. Isolated per persona — any thrown error is caught by the
 * caller's per-persona try/catch, never aborting the sweep.
 */
async function checkPersonaTranscript(persona: Persona, fx: Layer2Effects): Promise<void> {
  const { key } = persona
  const ref = personaRef(persona)
  const instanceId = personaInstanceId(key)

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

  let row: GetResult & TranscriptRowFields
  if (fx.isShuttingDown()) return
  try {
    row = await fx.getRow(key, instanceId)
  } catch (err) {
    if (fx.isShuttingDown()) return
    if (isAdErrorInstance(err, ErrSpawnNotFound)) {
      // No row to resume.
      console.error(`[slack] jsonl-persistence-check: no AD row for ${ref} — nothing to resume`)
      return
    }
    // Case 6: any other AD/get error — warn and move on.
    console.error(`[slack] jsonl-persistence-check: AD get failed for ${ref} — skipping: ${describeThrownValue(err)}`)
    return
  }
  if (fx.isShuttingDown()) return

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

  const detail = `${ref} instance=${instanceId}: ${describeTranscriptReference(row)}.`
  console.error(`[slack] jsonl-persistence-check: ${detail}`)
  if (row.transcript_status !== 'rotated') return

  if (fx.isShuttingDown()) return
  fx.recordError(ERR_KEY_TRANSCRIPT_REFERENCE, detail)
  if (fx.isShuttingDown()) return
  sendNotice(
    fx.notify,
    persona,
    `⚠️ CSCB startup warning: agent-director reports that my current session has no recorded transcript ` +
      `and my instance retains prior-session history (transcript_status=rotated). Resume may be unavailable; ` +
      `whether prior transcript files remain readable is unverified. An operator can inspect agent-director's session history.`,
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
      `Configured storage directory is on a non-persistent filesystem (tmpfs/ramfs); data on this mount will not survive a reboot. root="${root}"`,
    )
    // Roots are per persona, so notify only the personas whose effective
    // JSONL root is this flagged non-persistent root.
    for (const persona of personas) {
      if (personaJsonlRoot(persona, fx.home) !== root) continue
      sendNotice(
        fx.notify,
        persona,
        `⚠️ CSCB startup warning: my conversation storage at \`${root}\` is on a non-persistent filesystem ` +
          `(tmpfs/ramfs). Data on this mount will not survive a reboot; transcript storage on other mounts is unverified.`,
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
 * Report configured storage persistence and agent-director transcript references
 * before startupSessionManager. No native transcript lookup or archive queries.
 * Notices use the persona-keyed seam; each persona's failures stay local.
 */
export async function runJsonlPersistenceSafeguard(
  config: PersonaConfig,
  notify: PersonaNotify | undefined,
  deps?: JsonlPersistenceSafeguardDeps,
): Promise<void> {
  const recordError = deps?.recordStartupError ?? defaultRecordStartupError
  const readMountinfo = deps?.readMountinfo
  let stopped = false
  const isShuttingDown = (): boolean => {
    if (stopped) return true
    try {
      stopped = deps?.isShuttingDown?.() === true
    } catch {
      stopped = true
    }
    return stopped
  }

  try {
    if (isShuttingDown()) return
    const home = deps?.home ?? homedir()
    const fx: Layer2Effects = {
      notify,
      isShuttingDown,
      getRow: deps?.getRow ?? ((key, instanceId) => defaultGetRow(key, instanceId, isShuttingDown)),
      recordError,
      home,
      configDirFs: deps?.configDirFs,
    }

    // Layer 1 — non-persistent storage.
    reportStorageLayer(config.personas, resolveJsonlRoots(config, home), { notify, recordError, readMountinfo, home })

    // Layer 2 — agent-director transcript references. Isolated per persona.
    for (const persona of config.personas) {
      if (isShuttingDown()) return
      try {
        await checkPersonaTranscript(persona, fx)
      } catch (err) {
        if (isShuttingDown()) return
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
