/**
 * outage-state.ts — Persona-keyed outage-flag state machine + notice emit surface.
 *
 * Tracks three orthogonal outage classes per persona (b.av2 SR-6.3), keyed by
 * persona key, and emits onset / all-clear notices via the injected `notify`
 * hook, which production wires to the per-persona notifier
 * (`src/persona-notifier.ts`): the notice goes to that persona's destination
 * and the notifier adds the persona reference (b.av2 SR-7.2). The module is
 * intentionally free of Date / timestamp logic — operators scroll back to the
 * onset message for timing context.
 *
 * Public API surface (all exported):
 *   - initOutageState(deps)                — install production dependencies
 *   - getOutageFlags(key)                  — read live flag set
 *   - setOutageFlag(key, cls, detail?)     — raise flag + emit onset notice
 *   - clearOutageFlag(key, cls)            — lower flag; emits all-clear when set empties
 *   - resetAllToHealthy(keys)              — silent wipe (boot-time reset; one key at a teardown)
 *   - withOutageDetection(key, dir, fn)    — AD verb wrapper; raises/clears flags on error/success
 *   - withSpawnDetection(key, dir, fn)     — like withOutageDetection + clears cwd-unreachable on success
 *   - _resetOutageState()                  — test-only state reset
 *
 * Template exports (used by tests):
 *   - ONSET_TEMPLATES
 *   - ALL_CLEAR_TEMPLATE
 *
 * SPDX-License-Identifier: MIT
 */

import type { Client } from 'agent-director'
import {
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
} from './agent-director-errors.ts'

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Union of all outage classifications. No 'healthy' member — absence == healthy. */
export type OutageClass = 'ad-unreachable' | 'cwd-unreachable' | 'tmux-unavailable'

/**
 * Detail record for a single outage class in a bad stretch.
 * No `enteredAtIso` — timestamps are intentionally absent from the all-clear template.
 */
export interface ClassRecord {
  detail?: string
}

/** Per-persona state entry. */
interface PersonaEntry {
  /** Currently active outage flags. */
  flags: Set<OutageClass>
  /** Class → detail record for the current bad stretch. Reset to empty Map on all-clear. */
  badStretchClasses: Map<OutageClass, ClassRecord>
}

/** Dependencies injected via `initOutageState` — wires the module to production Slack + AD. */
export interface OutageStateDeps {
  /**
   * Fire-and-forget notice for the persona with this key: synchronous, and
   * errors MUST be handled internally by the caller. Production wires the
   * per-persona notifier, which adds the persona reference to `text`.
   */
  notify(key: string, text: string): void
  /** Return the singleton AD Client. Same semantics as getClient() in agent-director-client.ts. */
  getClient(): Client
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: OutageStateDeps | undefined
const entries = new Map<string, PersonaEntry>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazy-create a PersonaEntry for persona `key` on first access. */
function entryFor(key: string): PersonaEntry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { flags: new Set(), badStretchClasses: new Map() }
    entries.set(key, entry)
  }
  return entry
}

// ---------------------------------------------------------------------------
// Notice templates
// ---------------------------------------------------------------------------

/** Stable iteration order for the all-clear template. */
const STABLE_CLASS_ORDER: OutageClass[] = [
  'ad-unreachable',
  'cwd-unreachable',
  'tmux-unavailable',
]

/**
 * ONSET_TEMPLATES — one template function per outage class.
 * The optional `detail` parameter carries class-specific context
 * (binary path for ad-unreachable; the persona's working directory for
 * cwd-unreachable). The templates carry no persona reference: the notifier
 * adds it.
 */
export const ONSET_TEMPLATES: Record<OutageClass, (detail?: string) => string> = {
  'ad-unreachable': (binaryPath?: string) =>
    `:rotating_light: *agent-director unreachable* — affects every persona.\nBinary: \`${binaryPath ?? '<unknown>'}\`\nRemediation: reinstall agent-director.`,

  'tmux-unavailable': (_detail?: string) =>
    `:rotating_light: *tmux unavailable* — affects every persona.\nRemediation: install or repair tmux.`,

  'cwd-unreachable': (workingDirectory?: string) =>
    `:rotating_light: *Working directory unreachable* — \`${workingDirectory ?? '<unknown>'}\`\nRemediation: restore the directory or correct this persona's \`working_directory\` in \`config.json\`.`,
}

/**
 * ALL_CLEAR_TEMPLATE — renders an all-clear notice from the bad-stretch
 * history snapshot. Entries are emitted in the stable class order regardless
 * of the order flags were raised. No timestamps.
 */
export function ALL_CLEAR_TEMPLATE(resolved: Map<OutageClass, ClassRecord>): string {
  const parts: string[] = []
  for (const cls of STABLE_CLASS_ORDER) {
    const rec = resolved.get(cls)
    if (rec === undefined) continue
    const detailSuffix = rec.detail !== undefined ? ` (\`${rec.detail}\`)` : ''
    parts.push(`\`${cls}\`${detailSuffix}`)
  }
  return `:white_check_mark: *All clear.* Resolved: ${parts.join(', ')}.`
}

// ---------------------------------------------------------------------------
// Public API — init + accessors
// ---------------------------------------------------------------------------

/**
 * initOutageState — installs production dependencies. Called once from
 * `src/server.ts:main()` after the config is loaded, before the Socket Mode
 * connect block.
 */
export function initOutageState(d: OutageStateDeps): void {
  deps = d
}

/**
 * getOutageFlags — returns the live read-only flag set for persona `key`.
 * Returns an empty `ReadonlySet` sentinel when no entry exists yet.
 */
export function getOutageFlags(key: string): ReadonlySet<OutageClass> {
  return entries.get(key)?.flags ?? (new Set<OutageClass>() as ReadonlySet<OutageClass>)
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/**
 * setOutageFlag — raises `cls` for persona `key` and emits an onset notice.
 * Same-flag re-raise is a silent no-op (dedupe).
 *
 * State mutates BEFORE the emit so a synchronous throw in `notify`
 * cannot cause double-emission on the next observation.
 */
export function setOutageFlag(key: string, cls: OutageClass, detail?: string): void {
  if (!deps) return
  const entry = entryFor(key)
  if (entry.flags.has(cls)) return // same-flag dedupe
  // Mutate state BEFORE emit (SR-V-2.x state-before-emit contract).
  entry.flags.add(cls)
  entry.badStretchClasses.set(cls, { detail })
  deps.notify(key, ONSET_TEMPLATES[cls](detail))
}

/**
 * clearOutageFlag — lowers `cls` for persona `key`. Emits the all-clear
 * notice ONLY when the clear leaves the flag set empty and there is a
 * non-empty bad-stretch history (i.e., at least one onset was recorded).
 * Intermediate clears (flag set still non-empty after removal) are silent.
 *
 * State mutates BEFORE the emit (same contract as setOutageFlag).
 */
export function clearOutageFlag(key: string, cls: OutageClass): void {
  if (!deps) return
  const entry = entries.get(key)
  if (!entry) return
  if (!entry.flags.has(cls)) return // same-state dedupe
  // Mutate state BEFORE emit.
  entry.flags.delete(cls)
  if (entry.flags.size === 0 && entry.badStretchClasses.size > 0) {
    // Snapshot history and reset BEFORE the notify call.
    const snapshot = new Map(entry.badStretchClasses)
    entry.badStretchClasses = new Map()
    deps.notify(key, ALL_CLEAR_TEMPLATE(snapshot))
  }
}

/**
 * resetAllToHealthy — silently wipes each given persona's flag set and
 * bad-stretch history to a clean slate. No `notify` calls. Called at boot by
 * server.ts with the applied persona keys, before any persona is brought up,
 * as a defensive boundary for pre-start observations (added in Epic 2), and
 * with one key by a teardown (b.av2 SR-6.5), which clears that persona's
 * flags with no all-clear notice; other personas' entries are untouched.
 */
export function resetAllToHealthy(keys: string[]): void {
  for (const key of keys) {
    entries.set(key, { flags: new Set(), badStretchClasses: new Map() })
  }
}

// ---------------------------------------------------------------------------
// Public API — AD verb wrappers
// ---------------------------------------------------------------------------

/**
 * withOutageDetection — centralized wrapper for AD verb calls that should
 * participate in outage detection.
 *
 * On error:
 *   - ErrSystemInstallDisappeared → raises 'ad-unreachable' (detail = binaryPath)
 *   - ErrTmuxNotAvailable         → raises 'tmux-unavailable'
 *   - ErrCwdNotFound / ErrCwdNotADirectory → raises 'cwd-unreachable' (detail =
 *     workingDirectory, the persona's working directory) UNLESS
 *     workingDirectory is undefined, in which case logs loudly and rethrows
 *     WITHOUT raising the flag (defensive carve-out for verb-class drift).
 *   - Other errors → no flag change; rethrow unchanged.
 *
 * On success: clears 'ad-unreachable' and 'tmux-unavailable', returns result.
 *
 * The original error is always rethrown so callers can handle it normally.
 */
export async function withOutageDetection<T>(
  key: string,
  workingDirectory: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  if (!deps) {
    throw new Error(
      'outage-state: withOutageDetection called before initOutageState — caller-site bug',
    )
  }
  try {
    const result = await fn(deps.getClient())
    clearOutageFlag(key, 'ad-unreachable')
    clearOutageFlag(key, 'tmux-unavailable')
    return result
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared) {
      setOutageFlag(key, 'ad-unreachable', err.binaryPath)
    } else if (err instanceof ErrTmuxNotAvailable) {
      setOutageFlag(key, 'tmux-unavailable')
    } else if (err instanceof ErrCwdNotFound || err instanceof ErrCwdNotADirectory) {
      if (workingDirectory !== undefined) {
        setOutageFlag(key, 'cwd-unreachable', workingDirectory)
      } else {
        console.error(
          `[slack] outage-state: withOutageDetection: cwd error on persona=${key} but workingDirectory is undefined — verb-class drift; rethrowing without raising flag`,
          err,
        )
      }
    }
    throw err
  }
}

/**
 * withSpawnDetection — like `withOutageDetection` but also clears
 * 'cwd-unreachable' on success. Spawn and resume verbs are the only calls
 * that actually exercise the persona's working directory, so its health is
 * only confirmed by a successful spawn/resume.
 */
export async function withSpawnDetection<T>(
  key: string,
  workingDirectory: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const result = await withOutageDetection(key, workingDirectory, fn)
  clearOutageFlag(key, 'cwd-unreachable')
  return result
}

// ---------------------------------------------------------------------------
// Test-only
// ---------------------------------------------------------------------------

/**
 * _resetOutageState — clears all module-scoped state. For tests only.
 * Production code must not call this.
 */
export function _resetOutageState(): void {
  deps = undefined
  entries.clear()
}
