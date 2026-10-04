/**
 * stop-hook-bootstrap.ts — Install (or remove) the CSCB-managed Stop hook
 * that runs slack-reply-guard.sh, in <claude_config_dir>/settings.json of the
 * applied personas' config dirs, and run the per-persona reply-guard steps
 * before each launch (b.av2 SR-9.4, SR-6.2).
 *
 * The record (src/reply-guard-record.ts): before each launch the server
 * writes the persona's effective stop_hook_bootstrap as `true` or `false` to
 * `<stateDir>/reply-guard/<key>`. The guard reads `<record dir>/<CSCB_PERSONA>`
 * and reminds only on `true`, so one persona can opt out in a config dir it
 * shares with others.
 *
 * Command shape: the managed command is the guard's absolute path followed by
 * the record directory, each POSIX single-quoted (`shellSingleQuote`), because
 * Claude Code runs a hook command through a shell:
 *   '<abs>/stop-hooks/slack-reply-guard.sh' '<stateDir>/reply-guard'
 * Managed entry shape (SR-3.7): own group, NO matcher field:
 *   { "hooks": [ { "type": "command", "command": "<managed command>" } ] }
 * Recognition rule: any Stop hook whose `command` contains
 * `slack-reply-guard.sh` is CSCB-managed. Only the exact current command is
 * canonical, so an old bare-path entry, or one naming another record
 * directory, is replaced by exactly one canonical group.
 *
 * Install rule, per directory: the directory's personas are every applied
 * persona whose effective claude_config_dir it is, plus every applied persona
 * whose running instance launched with it (the launched-with directory, kept
 * in memory per persona key: set by each launch, cleared by
 * `teardownPersonaReplyGuard`, empty at server start). Ensure the managed
 * entry if any of them has an effective stop_hook_bootstrap of true or a
 * record reading `true`; otherwise remove it and prune emptied groups.
 * Directories are grouped by real path (config.ts's resolveRealPath), so two
 * spellings of one directory are one group. The operator's own ~/.claude is
 * never written (a persona resolving there gets no reminder). A persona with
 * no configured dir (or an empty/whitespace one) is skipped with a server-log
 * line only.
 *
 * Two passes, both taking the state directory explicitly:
 *   - `stopHookBootstrap(personaConfig, stateDir)` — the start pass, over every
 *     applied persona before any launch. jq missing and a dir resolving to
 *     ~/.claude (`stop-hook-bootstrap-refuse-home`) are recorded once per
 *     start; per-dir failures are recorded with recordStartupError.
 *   - `stopHookLaunchPass(dirs, personas, stateDir)` — re-evaluates only the
 *     given dirs (one persona's new effective dir and its previous launched-with
 *     dir). No jq check; failures, the ~/.claude refusal included, are
 *     server-log lines only, never startup-errors.log records.
 * `preLaunchReplyGuard` runs a launch's steps in order: write the launching
 * persona's record, update its launched-with dir, run the launch pass. The
 * session manager calls it (through its pre-launch seam) immediately before
 * each agent-director spawn or resume. Its undo (for an optimistic spawn that
 * met a live instance) restores the record and launched-with dir, each only
 * while it is still what the step set, then re-runs the launch pass against
 * the applied set read afresh, re-evaluating the hook rather than restoring it.
 *
 * Idempotent: a file already holding exactly one canonical managed group and
 * no other managed entry is not written. Otherwise it is rewritten atomically
 * (.tmp + rename). Malformed JSON, a non-object top level or an unreadable
 * file is left untouched. Every read-modify-write is synchronous, so two
 * personas launching at once cannot interleave on one settings.json. No
 * entry point ever throws.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { atomicWriteFileSync } from './atomic-write.ts'
import { type Persona, type PersonaConfig, resolveRealPath } from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  deleteReplyGuardRecord,
  readReplyGuardRecord,
  readReplyGuardRecordText,
  replyGuardRecordDir,
  replyGuardRecordPath,
  writeReplyGuardRecord,
} from './reply-guard-record.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Canonical command
// ---------------------------------------------------------------------------

/**
 * Absolute on-disk path to the packaged stop-hooks/slack-reply-guard.sh,
 * resolved from this module's own location (import.meta idiom — the same
 * pattern src/install-skill-pointer.ts uses to find package.json). Works from
 * both the published `src/*.ts` layout and from a repo checkout.
 */
function resolveGuardPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return join(moduleDir, '..', 'stop-hooks', 'slack-reply-guard.sh')
}

/**
 * POSIX single-quote `value` for a shell command line: wrap it in `'…'` and
 * write each `'` as `'\''`. The shell passes the result to the program as
 * one argument, verbatim (spaces, `$`, quotes and backslashes included).
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The canonical managed Stop-hook command for the server state directory
 * `stateDir`: the quoted guard path, a space, and the quoted record
 * directory `<stateDir>/reply-guard`.
 */
export function managedHookCommand(stateDir: string): string {
  return `${shellSingleQuote(resolveGuardPath())} ${shellSingleQuote(replyGuardRecordDir(stateDir))}`
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

/**
 * Where a pass reports a failure: `recordStartupError` in the start pass
 * (stderr plus startup-errors.log), a server-log line only in the launch pass.
 */
export type StopHookFailureSink = (errorClass: string, detail: string, cause?: unknown) => void

/** The launch pass's sink: one server-log line, never a startup-errors.log record. */
const logLaunchFailure: StopHookFailureSink = (errorClass, detail, cause) => {
  const suffix = cause === undefined ? '' : ` — ${describeThrownValue(cause)}`
  console.error(`[slack] stop-hook-bootstrap: pre-launch pass [${errorClass}] ${detail}${suffix}`)
}

/**
 * Ensure the canonical managed Stop-hook entry exists in <dir>/settings.json.
 * Creates the file if missing. Idempotent (no write when already canonical).
 * Soft-fails on malformed JSON without clobbering, reporting through `report`.
 */
export function ensureManagedEntry(
  dir: string,
  canonicalCmd: string,
  report: StopHookFailureSink = recordStartupError,
): void {
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
      atomicWriteFileSync(settingsPath, JSON.stringify(fresh, null, 2))
      return
    }
    report(
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
    report(
      'stop-hook-bootstrap-settings-parse',
      `malformed JSON in ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    report(
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

  atomicWriteFileSync(settingsPath, JSON.stringify(newDoc, null, 2))
}

/**
 * Remove every CSCB-managed Stop-hook entry from <dir>/settings.json and
 * prune any group left with an empty hooks array. Soft-fails on malformed
 * JSON without clobbering, reporting through `report`. No-op if the file is
 * missing or has no managed entries.
 */
export function removeManagedEntry(dir: string, report: StopHookFailureSink = recordStartupError): void {
  const settingsPath = join(dir, 'settings.json')

  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Nothing to remove.
      return
    }
    report(
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
    report(
      'stop-hook-bootstrap-settings-parse',
      `malformed JSON in ${settingsPath} — leaving file untouched`,
      err,
    )
    return
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    report(
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
  atomicWriteFileSync(settingsPath, JSON.stringify(newDoc, null, 2))
}

// ---------------------------------------------------------------------------
// Safety guards (subtask t3.osj.72.xf.57)
// ---------------------------------------------------------------------------

/**
 * True iff `dir` resolves to the operator's own ~/.claude directory. Compares
 * with the shared `resolveRealPath` (realpathSync, symlink-follow, with a
 * lexical resolve() fallback for non-existent paths) so ~/.claude is still
 * refused by name when it does not exist.
 */
function isForbiddenHomeClaudeDir(dir: string): boolean {
  const forbidden = resolveRealPath(join(homedir(), '.claude'))
  const candidate = resolveRealPath(dir)
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
// Launched-with directories
// ---------------------------------------------------------------------------

/**
 * The claude_config_dir each persona's running instance launched with, by
 * persona key, as configured. Set by `preLaunchReplyGuard` at each launch and
 * cleared by `teardownPersonaReplyGuard`. In memory only, so it is empty at
 * server start until launches fill it.
 */
const launchedWithDirs = new Map<string, LaunchedWith>()

/**
 * One launch's launched-with entry. Each `preLaunchReplyGuard` call sets a
 * fresh object, so its undo can tell by identity whether the entry is still
 * the one it set. `dir` is undefined for a launch with no usable dir (the
 * persona then counts toward no launched-with dir).
 */
interface LaunchedWith {
  readonly dir: string | undefined
}

/** The directory persona `key`'s running instance launched with, if known. */
export function getLaunchedWithDir(key: string): string | undefined {
  return launchedWithDirs.get(key)?.dir
}

/** Test-only seam: forget every launched-with directory. */
export function _resetLaunchedWithDirs(): void {
  launchedWithDirs.clear()
}

// ---------------------------------------------------------------------------
// Per-directory aggregation and patch
// ---------------------------------------------------------------------------

interface DirAggregate {
  /** The first contributing persona's configured dir: the path written to and logged. */
  dir: string
  /** True if at least one persona counting toward this dir is enabled or has a record reading `true`. */
  anyEnabled: boolean
  /** Rendered references of the personas counting toward this dir (for diagnostics). */
  personas: string[]
}

/** How a pass reports: its failure sink, and whether it records the ~/.claude refusal. */
interface PassMode {
  report: StopHookFailureSink
  /** Record `stop-hook-bootstrap-refuse-home` (start pass only); otherwise the refusal is only logged. */
  recordRefuseHome: boolean
}

const START_PASS: PassMode = { report: recordStartupError, recordRefuseHome: true }
const LAUNCH_PASS: PassMode = { report: logLaunchFailure, recordRefuseHome: false }

/**
 * A configured dir usable as a path, or undefined when absent or empty/
 * whitespace-only (guards against resolve("") landing in cwd).
 */
function usableDir(dir: string | undefined): string | undefined {
  return typeof dir === 'string' && dir.trim() !== '' ? dir : undefined
}

/** The server-log line for a persona with no usable configured dir (never a startup-error record). */
function logNoConfiguredDir(persona: Persona, ref: string): void {
  if (persona.claude_config_dir === undefined) {
    console.error(`[slack] stop-hook-bootstrap: ${ref} has no claude_config_dir — skipping`)
  } else {
    console.error(
      `[slack] stop-hook-bootstrap: ${ref} has empty/whitespace claude_config_dir — skipping (guard against resolve("") landing in cwd)`,
    )
  }
}

/**
 * Group the applied personas by directory, keyed on the real path: each
 * persona counts toward its effective dir and its launched-with dir. A
 * persona is enabled when its effective stop_hook_bootstrap is true or its
 * record reads `true`. `onNoDir` hears of each persona with no usable
 * effective dir.
 */
function aggregateByDir(
  personas: readonly Persona[],
  stateDir: string,
  onNoDir?: (persona: Persona, ref: string) => void,
): Map<string, DirAggregate> {
  const byDir = new Map<string, DirAggregate>()
  for (const persona of personas) {
    const ref = renderPersonaRef(persona.name, persona.key)
    const effective = usableDir(persona.claude_config_dir)
    if (effective === undefined) onNoDir?.(persona, ref)
    const dirs = [effective, getLaunchedWithDir(persona.key)].filter((d): d is string => d !== undefined)
    if (dirs.length === 0) continue
    const enabled = persona.stop_hook_bootstrap || readReplyGuardRecord(stateDir, persona.key) === 'true'
    const counted = new Set<string>()
    for (const dir of dirs) {
      const realDir = resolveRealPath(dir)
      if (counted.has(realDir)) continue
      counted.add(realDir)
      const agg = byDir.get(realDir) ?? { dir, anyEnabled: false, personas: [] }
      agg.personas.push(ref)
      if (enabled) agg.anyEnabled = true
      byDir.set(realDir, agg)
    }
  }
  return byDir
}

/**
 * Apply the install rule to one directory: refuse ~/.claude, skip a missing
 * dir or a non-directory, else ensure or remove the managed entry. Never
 * throws; failures go to the pass's sink.
 */
function applyDirAggregate(agg: DirAggregate, canonicalCmd: string, mode: PassMode): void {
  const { dir } = agg
  const personas = agg.personas.join(', ')
  try {
    // Refuse the operator's own ~/.claude — never install a CSCB hook into
    // the personal default config dir.
    if (isForbiddenHomeClaudeDir(dir)) {
      const msg = `refusing to touch operator's own ~/.claude (dir=${dir}, personas=${personas})`
      console.error(`[slack] stop-hook-bootstrap: ${msg}`)
      if (mode.recordRefuseHome) recordStartupError('stop-hook-bootstrap-refuse-home', msg)
      return
    }

    // The dir must exist and be a directory before we try to write into it.
    try {
      if (!statSync(dir).isDirectory()) {
        mode.report(
          'stop-hook-bootstrap-not-a-dir',
          `claude_config_dir ${dir} is not a directory — skipping (personas=${personas})`,
        )
        return
      }
    } catch (err) {
      // Missing dir: a hard skip for "ensure"; nothing to do for "remove".
      if (agg.anyEnabled) {
        mode.report(
          'stop-hook-bootstrap-dir-missing',
          `claude_config_dir ${dir} does not exist — skipping ensure (personas=${personas})`,
          err,
        )
      }
      return
    }

    if (agg.anyEnabled) {
      ensureManagedEntry(dir, canonicalCmd, mode.report)
    } else {
      removeManagedEntry(dir, mode.report)
    }
  } catch (err) {
    mode.report('stop-hook-bootstrap-dir', `unexpected error processing dir=${dir} personas=${personas}`, err)
  }
}

// ---------------------------------------------------------------------------
// Start pass and launch-time pass
// ---------------------------------------------------------------------------

/**
 * Start pass (b.av2 SR-6.2): over every applied persona, before any launch,
 * apply the install rule to every directory a persona counts toward. Records
 * jq missing and the ~/.claude refusal once, and per-dir failures, with
 * recordStartupError. Never throws.
 */
export function stopHookBootstrap(personaConfig: PersonaConfig, stateDir: string): void {
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
      canonicalCmd = managedHookCommand(stateDir)
    } catch (err) {
      recordStartupError(
        'stop-hook-bootstrap-init',
        'could not resolve canonical slack-reply-guard.sh command — skipping all dirs',
        err,
      )
      return
    }

    for (const agg of aggregateByDir(personaConfig.personas, stateDir, logNoConfiguredDir).values()) {
      applyDirAggregate(agg, canonicalCmd, START_PASS)
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

/**
 * Launch-time pass: apply the install rule, over the applied `personas`, to
 * the given dirs only (a launching persona's new effective dir and its
 * previous launched-with dir; undefined or blank entries are skipped, and two
 * spellings of one dir are evaluated once). No jq check; never records a
 * startup error (the ~/.claude refusal included): failures are server-log
 * lines. Synchronous from each settings.json read to its write. Never throws.
 */
export function stopHookLaunchPass(
  dirs: readonly (string | undefined)[],
  personas: readonly Persona[],
  stateDir: string,
): void {
  try {
    const canonicalCmd = managedHookCommand(stateDir)
    const byDir = aggregateByDir(personas, stateDir)
    const evaluated = new Set<string>()
    for (const raw of dirs) {
      const dir = usableDir(raw)
      if (dir === undefined) continue
      const realDir = resolveRealPath(dir)
      if (evaluated.has(realDir)) continue
      evaluated.add(realDir)
      // A dir no applied persona counts toward any more loses the entry.
      applyDirAggregate(byDir.get(realDir) ?? { dir, anyEnabled: false, personas: [] }, canonicalCmd, LAUNCH_PASS)
    }
  } catch (err) {
    logLaunchFailure('stop-hook-bootstrap', 'unexpected top-level error in stopHookLaunchPass', err)
  }
}

// ---------------------------------------------------------------------------
// Pre-launch reply-guard steps and teardown
// ---------------------------------------------------------------------------

/**
 * Undo one `preLaunchReplyGuard` call, for a launch that did not happen (the
 * optimistic spawn met a live instance). Each part is restored only while it
 * is still what that call set, so a change made in between (a teardown, or
 * another launch of the persona) is never overwritten:
 *   - the record is restored to its previous text (or deleted if there was
 *     none) only if its current text equals the text the call wrote;
 *   - the launched-with dir is restored only if the entry is still the one
 *     the call set.
 * Then the launch pass re-runs over the same dirs against the applied persona
 * set as it is now. Never throws.
 */
export type ReplyGuardUndo = () => void

/**
 * The applied persona set, as a snapshot or a getter read at each use (so a
 * reload between a launch and its undo is seen). A getter returning undefined
 * means no applied set: nothing is written or patched.
 */
export type AppliedPersonaSource = readonly Persona[] | (() => readonly Persona[] | undefined)

function readAppliedPersonas(source: AppliedPersonaSource): readonly Persona[] | undefined {
  return typeof source === 'function' ? source() : source
}

/** The record path for a log line; the record directory when the key is refused. */
function recordPathForLog(stateDir: string, key: string): string {
  try {
    return replyGuardRecordPath(stateDir, key)
  } catch {
    return `${replyGuardRecordDir(stateDir)} (refused key)`
  }
}

/**
 * Write the launching persona's record. On failure remove any stale record
 * (so the guard fails open to no reminder rather than act on an old value)
 * and log one line naming the persona and the path. Returns the text now in
 * the record when the write succeeded, else undefined. Never throws.
 */
function writeLaunchRecord(persona: Persona, stateDir: string, ref: string): string | undefined {
  try {
    writeReplyGuardRecord(stateDir, persona.key, persona.stop_hook_bootstrap)
    return readReplyGuardRecordText(stateDir, persona.key)
  } catch (err) {
    let stale = 'removed any stale record'
    try {
      deleteReplyGuardRecord(stateDir, persona.key)
    } catch (deleteErr) {
      stale = `could not remove a stale record (${describeThrownValue(deleteErr)})`
    }
    console.error(
      `[slack] reply-guard: could not write the record for ${ref} at ${recordPathForLog(stateDir, persona.key)} — ` +
        `${stale}; launching anyway: ${describeThrownValue(err)}`,
    )
    return undefined
  }
}

/** A no-op undo, for a call that changed nothing. */
const NOTHING_TO_UNDO: ReplyGuardUndo = () => {}

/**
 * The reply-guard steps before one persona's launch (b.av2 SR-9.4, SR-6.2),
 * in order:
 *   1. write the persona's record with its effective stop_hook_bootstrap
 *      (only this persona's record; a neighbour's is never rewritten);
 *   2. note its previous launched-with dir, then set it to its effective
 *      claude_config_dir;
 *   3. run the launch pass over the new effective dir and, when it differs,
 *      the previous launched-with dir.
 * `personas` is the applied persona set (a snapshot or a getter; see
 * `AppliedPersonaSource`) and `stateDir` the server's state directory;
 * nothing here resolves either itself. A getter returning undefined makes
 * this a no-op, and so does a persona whose key is not in the applied set
 * (b.av2 SR-8.6): a late launch of a removed persona must not re-create the
 * record its teardown deleted, nor run a launch pass that strips a hook.
 * Never throws and never blocks the launch. Returns the undo for a launch
 * that did not happen.
 */
export function preLaunchReplyGuard(
  persona: Persona,
  personas: AppliedPersonaSource,
  stateDir: string,
): ReplyGuardUndo {
  const { key } = persona
  const ref = renderPersonaRef(persona.name, key)
  const previousRecord = readReplyGuardRecordText(stateDir, key)
  const previousEntry = launchedWithDirs.get(key)
  const previousDir = previousEntry?.dir
  const effectiveDir = usableDir(persona.claude_config_dir)
  const entry: LaunchedWith = { dir: effectiveDir }
  let writtenRecord: string | undefined
  try {
    const applied = readAppliedPersonas(personas)
    if (applied === undefined || !applied.some((p) => p.key === key)) return NOTHING_TO_UNDO
    writtenRecord = writeLaunchRecord(persona, stateDir, ref)
    launchedWithDirs.set(key, entry)
    if (effectiveDir === undefined) logNoConfiguredDir(persona, ref)
    stopHookLaunchPass([effectiveDir, previousDir], applied, stateDir)
  } catch (err) {
    console.error(`[slack] reply-guard: pre-launch steps failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
  }
  return () => {
    try {
      // The record: only while it still holds exactly what this step wrote.
      if (writtenRecord !== undefined && writtenRecord !== previousRecord) {
        try {
          if (readReplyGuardRecordText(stateDir, key) === writtenRecord) {
            if (previousRecord === undefined) deleteReplyGuardRecord(stateDir, key)
            else atomicWriteFileSync(replyGuardRecordPath(stateDir, key), previousRecord)
          }
        } catch (err) {
          console.error(
            `[slack] reply-guard: could not restore the record for ${ref} at ${recordPathForLog(stateDir, key)}: ${describeThrownValue(err)}`,
          )
        }
      }
      // The launched-with dir: only while the entry is still the one this step set.
      if (launchedWithDirs.get(key) === entry) {
        if (previousEntry === undefined) launchedWithDirs.delete(key)
        else launchedWithDirs.set(key, previousEntry)
      }
      // Re-evaluate against the applied set as it is now (a reload may have landed).
      const applied = readAppliedPersonas(personas)
      if (applied !== undefined) stopHookLaunchPass([effectiveDir, previousDir], applied, stateDir)
    } catch (err) {
      console.error(`[slack] reply-guard: undoing the pre-launch steps failed for ${ref}: ${describeThrownValue(err)}`)
    }
  }
}

/**
 * Teardown helper for a removed persona (b.av2 SR-6.5; the persona's teardown calls it): delete
 * persona `key`'s record under `stateDir` (a record already gone is success)
 * and forget its launched-with dir. Does not re-run the hook patch. Never
 * throws; a failure is one server-log line naming the key and the path.
 */
export function teardownPersonaReplyGuard(stateDir: string, key: string): void {
  try {
    launchedWithDirs.delete(key)
    deleteReplyGuardRecord(stateDir, key)
  } catch (err) {
    try {
      console.error(
        `[slack] reply-guard: could not delete the record for persona=${JSON.stringify(key)} at ${recordPathForLog(stateDir, key)}: ${describeThrownValue(err)}`,
      )
    } catch {
      /* never throw from teardown */
    }
  }
}
