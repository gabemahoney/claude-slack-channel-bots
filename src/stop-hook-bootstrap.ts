/**
 * stop-hook-bootstrap.ts — Patch <claude_config_dir>/settings.json for every
 * routed dir at startup to install (or remove) a CSCB-managed Stop hook that
 * routes reply-guard events back through slack-reply-guard.sh.
 *
 * SR-3 of SRD t1.2qu.u6:
 *   - Iterate routes; effective dir = route.claude_config_dir ?? top-level.
 *   - Group by dir. Ensure the managed entry if >=1 resolving route is
 *     enabled (route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap);
 *     remove (and prune emptied groups) only if none of the routes for that
 *     dir are enabled.
 *   - Refuse the operator's personal ~/.claude dir (compared via realpathSync
 *     with a lexical resolve() fallback for non-existent paths): skip, warn,
 *     recordStartupError.
 *   - Skip routes with no effective dir; treat empty/whitespace-only dirs as
 *     absent (guards against resolve("") landing in cwd).
 *   - jq absent at boot: warn + recordStartupError, still install entries
 *     (the hook script uses jq at hook time).
 *   - Never throws to the caller. Per-dir failures are logged via
 *     recordStartupError; remaining dirs are still processed.
 *
 * Managed entry shape (SR-3.7):
 *   { "hooks": [ { "type": "command", "command": "<abs slack-reply-guard.sh>" } ] }
 * — own group, NO matcher field. Recognition rule: any Stop hook whose
 * `command` string contains `slack-reply-guard.sh` is treated as CSCB-managed.
 *
 * Idempotent: if exactly one canonical managed group is present and no stale/
 * duplicate managed entries exist, no write occurs. Otherwise the file is
 * atomically rewritten via .tmp + rename (trust-bootstrap precedent).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { type RoutingConfig } from './config.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Canonical path resolution
// ---------------------------------------------------------------------------

/**
 * Absolute on-disk path to the packaged stop-hooks/slack-reply-guard.sh,
 * resolved from this module's own location (import.meta idiom — the same
 * pattern src/install-skill-pointer.ts uses to find package.json). Works from
 * both the published `src/*.ts` layout and from a repo checkout.
 */
function resolveManagedCommand(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return join(moduleDir, '..', 'stop-hooks', 'slack-reply-guard.sh')
}

/** Substring that identifies a CSCB-managed Stop-hook entry (SR-3.7). */
const MANAGED_MARKER = 'slack-reply-guard.sh'

// ---------------------------------------------------------------------------
// Types for settings.json shape (minimal — we only touch hooks.Stop)
// ---------------------------------------------------------------------------

interface HookCommand {
  type?: string
  command?: string
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
  [key: string]: unknown
}

interface HooksBlock {
  Stop?: HookGroup[]
  [key: string]: unknown
}

interface SettingsJson {
  hooks?: HooksBlock
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Per-directory patch engine (subtask t3.osj.72.xf.m2)
// ---------------------------------------------------------------------------

/** Result of scanning a Stop-group list for managed entries. */
interface ManagedScan {
  /** Total managed commands found across all groups (dups included). */
  managedCount: number
  /**
   * True iff the file contains exactly one Stop group whose sole hook entry
   * is a canonical managed entry (no matcher, no extra hooks, correct command),
   * AND no other groups contain any managed entry.
   */
  hasSingleCanonicalGroup: boolean
}

/** Deep-inspect Stop groups to decide whether an ensure write is needed. */
function scanStopGroups(groups: HookGroup[], canonicalCmd: string): ManagedScan {
  let managedCount = 0
  let canonicalGroupIdx = -1
  let canonicalGroupIsSole = false

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (!g || typeof g !== 'object') continue
    const hooks = Array.isArray(g.hooks) ? g.hooks : []
    let groupManaged = 0
    let groupCanonicalExact = false
    for (const h of hooks) {
      if (h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(MANAGED_MARKER)) {
        managedCount++
        groupManaged++
        if (h.type === 'command' && h.command === canonicalCmd) {
          groupCanonicalExact = true
        }
      }
    }
    if (groupManaged > 0 && canonicalGroupIdx === -1) {
      // Candidate for the sole canonical group: exactly one hook, no matcher,
      // that one hook is the canonical entry.
      const noMatcher = !('matcher' in g) || g.matcher === undefined
      const noExtraKeys = Object.keys(g).every((k) => k === 'hooks' || k === 'matcher')
      if (
        groupCanonicalExact &&
        groupManaged === 1 &&
        hooks.length === 1 &&
        noMatcher &&
        noExtraKeys
      ) {
        canonicalGroupIdx = i
        canonicalGroupIsSole = true
      }
    } else if (groupManaged > 0) {
      // A second group also contains a managed entry — not canonical-single.
      canonicalGroupIsSole = false
    }
  }
  return {
    managedCount,
    hasSingleCanonicalGroup: canonicalGroupIdx !== -1 && canonicalGroupIsSole && managedCount === 1,
  }
}

/** Build the canonical managed group. */
function canonicalGroup(canonicalCmd: string): HookGroup {
  return { hooks: [{ type: 'command', command: canonicalCmd }] }
}

/** Atomic write via .tmp + rename (trust-bootstrap precedent). */
function atomicWrite(path: string, contents: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, contents, 'utf-8')
  renameSync(tmp, path)
}

/**
 * Ensure the canonical managed Stop-hook entry exists in <dir>/settings.json.
 * Creates the file if missing. Idempotent (no write when already canonical).
 * Soft-fails on malformed JSON without clobbering.
 */
export function ensureManagedEntry(dir: string, canonicalCmd: string): void {
  const settingsPath = join(dir, 'settings.json')

  // Read; if legitimately missing (ENOENT), create fresh. Any other read
  // error (e.g. EACCES on an existing file) must NOT clobber — soft-fail.
  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // File genuinely missing. Create it with just the managed group.
      const fresh: SettingsJson = { hooks: { Stop: [canonicalGroup(canonicalCmd)] } }
      atomicWrite(settingsPath, JSON.stringify(fresh, null, 2))
      return
    }
    recordStartupError(
      'stop-hook-bootstrap-settings-read',
      `could not read ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }

  // Parse — malformed JSON: log and leave the file untouched.
  let doc: SettingsJson
  try {
    doc = JSON.parse(raw) as SettingsJson
  } catch (err) {
    recordStartupError(
      'stop-hook-bootstrap-settings-parse',
      `malformed JSON in ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    recordStartupError(
      'stop-hook-bootstrap-settings-shape',
      `top-level of ${settingsPath} is not a JSON object — leaving file untouched`,
    )
    return
  }

  const hooks: HooksBlock =
    typeof doc.hooks === 'object' && doc.hooks !== null && !Array.isArray(doc.hooks)
      ? (doc.hooks as HooksBlock)
      : {}
  const stopGroups: HookGroup[] = Array.isArray(hooks.Stop) ? hooks.Stop : []

  const scan = scanStopGroups(stopGroups, canonicalCmd)
  if (scan.hasSingleCanonicalGroup) {
    // Already canonical — no write.
    return
  }

  // Strip every managed entry (all dups), prune emptied groups, then append
  // one canonical group.
  const rebuilt: HookGroup[] = []
  for (const g of stopGroups) {
    if (!g || typeof g !== 'object') continue
    const hooksArr = Array.isArray(g.hooks) ? g.hooks : []
    const kept = hooksArr.filter(
      (h) => !(h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(MANAGED_MARKER)),
    )
    if (kept.length === 0 && hooksArr.length > 0) {
      // Group had only managed entries — prune it entirely.
      continue
    }
    rebuilt.push({ ...g, hooks: kept })
  }
  rebuilt.push(canonicalGroup(canonicalCmd))

  const newHooks: HooksBlock = { ...hooks, Stop: rebuilt }
  const newDoc: SettingsJson = { ...doc, hooks: newHooks }

  atomicWrite(settingsPath, JSON.stringify(newDoc, null, 2))
}

/**
 * Remove every CSCB-managed Stop-hook entry from <dir>/settings.json and
 * prune any group left with an empty hooks array. Soft-fails on malformed
 * JSON without clobbering. No-op if the file is missing or has no managed
 * entries.
 */
export function removeManagedEntry(dir: string): void {
  const settingsPath = join(dir, 'settings.json')

  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Nothing to remove.
      return
    }
    recordStartupError(
      'stop-hook-bootstrap-settings-read',
      `could not read ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }

  let doc: SettingsJson
  try {
    doc = JSON.parse(raw) as SettingsJson
  } catch (err) {
    recordStartupError(
      'stop-hook-bootstrap-settings-parse',
      `malformed JSON in ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    recordStartupError(
      'stop-hook-bootstrap-settings-shape',
      `top-level of ${settingsPath} is not a JSON object — leaving file untouched`,
    )
    return
  }

  const hooks = doc.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return
  const stopGroups = (hooks as HooksBlock).Stop
  if (!Array.isArray(stopGroups) || stopGroups.length === 0) return

  let changed = false
  const rebuilt: HookGroup[] = []
  for (const g of stopGroups) {
    if (!g || typeof g !== 'object') {
      rebuilt.push(g)
      continue
    }
    const hooksArr = Array.isArray(g.hooks) ? g.hooks : []
    const kept = hooksArr.filter(
      (h) => !(h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(MANAGED_MARKER)),
    )
    if (kept.length !== hooksArr.length) changed = true
    if (kept.length === 0 && hooksArr.length > 0) {
      // Managed-only group — prune.
      changed = true
      continue
    }
    if (kept.length !== hooksArr.length) {
      rebuilt.push({ ...g, hooks: kept })
    } else {
      rebuilt.push(g)
    }
  }

  if (!changed) return

  const newHooks: HooksBlock = { ...(hooks as HooksBlock), Stop: rebuilt }
  const newDoc: SettingsJson = { ...doc, hooks: newHooks }
  atomicWrite(settingsPath, JSON.stringify(newDoc, null, 2))
}

// ---------------------------------------------------------------------------
// Safety guards (subtask t3.osj.72.xf.57)
// ---------------------------------------------------------------------------

/**
 * Resolve a path lexically-then-physically for comparison. Uses realpathSync
 * when the path exists (follows symlinks); falls back to lexical resolve()
 * when the path does not exist so we can still refuse ~/.claude by name.
 */
function safeResolve(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * True iff `dir` resolves to the operator's own ~/.claude directory. Uses
 * realpathSync (symlink-follow) with a lexical resolve() fallback for
 * non-existent paths.
 */
function isForbiddenHomeClaudeDir(dir: string): boolean {
  const forbidden = safeResolve(join(homedir(), '.claude'))
  const candidate = safeResolve(dir)
  return candidate === forbidden
}

/** True iff `jq` is on PATH. Uses `command -v jq` under sh. */
function jqOnPath(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq >/dev/null 2>&1'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public entry point — route iteration + aggregation (subtask t3.osj.72.xf.57)
// ---------------------------------------------------------------------------

interface DirAggregate {
  /** True if at least one resolving route for this dir is enabled. */
  anyEnabled: boolean
  /** Route/channel IDs contributing to this dir (for diagnostics). */
  channels: string[]
}

/**
 * Boot-time entry point. Iterates the routing config, groups routes by their
 * effective claude_config_dir, and applies the ensure/remove patch engine
 * per dir. Never throws.
 */
export function stopHookBootstrap(routingConfig: RoutingConfig): void {
  try {
    // One-time jq availability check. The hook script needs jq at hook time;
    // if absent we still install so that installing jq later Just Works.
    if (!jqOnPath()) {
      recordStartupError(
        'stop-hook-bootstrap-jq-missing',
        'jq is not on PATH — the Stop hook needs jq at hook time; installing the entry anyway',
      )
    }

    let canonicalCmd: string
    try {
      canonicalCmd = resolveManagedCommand()
    } catch (err) {
      recordStartupError(
        'stop-hook-bootstrap-init',
        'could not resolve canonical slack-reply-guard.sh path — skipping all dirs',
        err,
      )
      return
    }

    // Group routes by effective dir.
    const byDir = new Map<string, DirAggregate>()
    for (const [channelId, route] of Object.entries(routingConfig.routes)) {
      const rawDir = route.claude_config_dir ?? routingConfig.claude_config_dir
      if (rawDir === undefined) {
        console.error(
          `[slack] stop-hook-bootstrap: channel=${channelId} has no claude_config_dir — skipping`,
        )
        continue
      }
      if (typeof rawDir !== 'string' || rawDir.trim() === '') {
        console.error(
          `[slack] stop-hook-bootstrap: channel=${channelId} has empty/whitespace claude_config_dir — skipping (guard against resolve("") landing in cwd)`,
        )
        continue
      }
      const dir = rawDir
      const enabled = route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap
      const agg = byDir.get(dir) ?? { anyEnabled: false, channels: [] }
      agg.channels.push(channelId)
      if (enabled) agg.anyEnabled = true
      byDir.set(dir, agg)
    }

    for (const [dir, agg] of byDir) {
      try {
        // Refuse the operator's own ~/.claude — never install a CSCB hook
        // into the personal default config dir.
        if (isForbiddenHomeClaudeDir(dir)) {
          const msg = `refusing to touch operator's own ~/.claude (dir=${dir}, channels=${agg.channels.join(',')})`
          console.error(`[slack] stop-hook-bootstrap: ${msg}`)
          recordStartupError('stop-hook-bootstrap-refuse-home', msg)
          continue
        }

        // The dir must exist and be a directory before we try to write into
        // it. If missing, log via recordStartupError and skip (settings.json
        // in a non-existent dir has nowhere to go).
        try {
          const st = statSync(dir)
          if (!st.isDirectory()) {
            recordStartupError(
              'stop-hook-bootstrap-not-a-dir',
              `claude_config_dir ${dir} is not a directory — skipping (channels=${agg.channels.join(',')})`,
            )
            continue
          }
        } catch (err) {
          // Directory doesn't exist. For "ensure" this is a hard skip; for
          // "remove" there's nothing to do anyway.
          if (agg.anyEnabled) {
            recordStartupError(
              'stop-hook-bootstrap-dir-missing',
              `claude_config_dir ${dir} does not exist — skipping ensure (channels=${agg.channels.join(',')})`,
              err,
            )
          }
          continue
        }

        if (agg.anyEnabled) {
          ensureManagedEntry(dir, canonicalCmd)
        } else {
          removeManagedEntry(dir)
        }
      } catch (err) {
        recordStartupError(
          'stop-hook-bootstrap-dir',
          `unexpected error processing dir=${dir} channels=${agg.channels.join(',')}`,
          err,
        )
      }
    }
  } catch (err) {
    // Absolute last-resort: never throw from this entry point.
    recordStartupError(
      'stop-hook-bootstrap',
      'unexpected top-level error in stopHookBootstrap',
      err,
    )
  }
}
