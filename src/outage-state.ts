/**
 * outage-state.ts — Channel-scoped outage-flag state machine + Slack emit surface.
 *
 * Tracks three orthogonal outage classes per routed Slack channel and emits
 * onset / all-clear messages via the injected `postToChannel` hook. The module
 * is intentionally free of Date / timestamp logic — operators scroll back to
 * the onset message for timing context.
 *
 * Public API surface (all exported):
 *   - initOutageState(deps)                — install production dependencies
 *   - getOutageFlags(channelId)            — read live flag set
 *   - setOutageFlag(channelId, cls, detail?)  — raise flag + emit onset message
 *   - clearOutageFlag(channelId, cls)      — lower flag; emits all-clear when set empties
 *   - resetAllToHealthy(channelIds)        — silent bulk wipe (boot-time reset)
 *   - withOutageDetection(ch, cwd, fn)     — AD verb wrapper; raises/clears flags on error/success
 *   - withSpawnDetection(ch, cwd, fn)      — like withOutageDetection + clears cwd-unreachable on success
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

/** Per-channel state entry. */
interface ChannelEntry {
  /** Currently active outage flags. */
  flags: Set<OutageClass>
  /** Class → detail record for the current bad stretch. Reset to empty Map on all-clear. */
  badStretchClasses: Map<OutageClass, ClassRecord>
}

/** Dependencies injected via `initOutageState` — wires the module to production Slack + AD. */
export interface OutageStateDeps {
  /** Fire-and-forget Slack post; errors MUST be handled internally by the caller. */
  postToChannel(channelId: string, text: string): void
  /** Return the singleton AD Client. Same semantics as getClient() in agent-director-client.ts. */
  getClient(): Client
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

let deps: OutageStateDeps | undefined
const entries = new Map<string, ChannelEntry>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazy-create a ChannelEntry for `channelId` on first access. */
function entryFor(channelId: string): ChannelEntry {
  let entry = entries.get(channelId)
  if (!entry) {
    entry = { flags: new Set(), badStretchClasses: new Map() }
    entries.set(channelId, entry)
  }
  return entry
}

// ---------------------------------------------------------------------------
// Slack message templates
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
 * (binary path for ad-unreachable; cwd path for cwd-unreachable).
 */
export const ONSET_TEMPLATES: Record<OutageClass, (detail?: string) => string> = {
  'ad-unreachable': (binaryPath?: string) =>
    `:rotating_light: *agent-director unreachable* — affects every routed channel.\nBinary: \`${binaryPath ?? '<unknown>'}\`\nRemediation: reinstall agent-director.`,

  'tmux-unavailable': (_detail?: string) =>
    `:rotating_light: *tmux unavailable* — affects every routed channel.\nRemediation: install or repair tmux.`,

  'cwd-unreachable': (cwd?: string) =>
    `:rotating_light: *Route cwd unreachable* — \`${cwd ?? '<unknown>'}\`\nRemediation: restore the directory or remove this route from \`config.json\`.`,
}

/**
 * ALL_CLEAR_TEMPLATE — renders a Slack all-clear message from the bad-stretch
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
 * `src/server.ts:main()` after `routingConfig` is loaded, before the
 * Socket Mode connect block.
 */
export function initOutageState(d: OutageStateDeps): void {
  deps = d
}

/**
 * getOutageFlags — returns the live read-only flag set for `channelId`.
 * Returns an empty `ReadonlySet` sentinel when no entry exists yet.
 */
export function getOutageFlags(channelId: string): ReadonlySet<OutageClass> {
  return entries.get(channelId)?.flags ?? (new Set<OutageClass>() as ReadonlySet<OutageClass>)
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/**
 * setOutageFlag — raises `cls` for `channelId` and emits an onset Slack
 * message. Same-flag re-raise is a silent no-op (dedupe).
 *
 * State mutates BEFORE the emit so a synchronous throw in `postToChannel`
 * cannot cause double-emission on the next observation.
 */
export function setOutageFlag(channelId: string, cls: OutageClass, detail?: string): void {
  if (!deps) return
  const entry = entryFor(channelId)
  if (entry.flags.has(cls)) return // same-flag dedupe
  // Mutate state BEFORE emit (SR-V-2.x state-before-emit contract).
  entry.flags.add(cls)
  entry.badStretchClasses.set(cls, { detail })
  deps.postToChannel(channelId, ONSET_TEMPLATES[cls](detail))
}

/**
 * clearOutageFlag — lowers `cls` for `channelId`. Emits the all-clear Slack
 * message ONLY when the clear leaves the flag set empty and there is a
 * non-empty bad-stretch history (i.e., at least one onset was recorded).
 * Intermediate clears (flag set still non-empty after removal) are silent.
 *
 * State mutates BEFORE the emit (same contract as setOutageFlag).
 */
export function clearOutageFlag(channelId: string, cls: OutageClass): void {
  if (!deps) return
  const entry = entries.get(channelId)
  if (!entry) return
  if (!entry.flags.has(cls)) return // same-state dedupe
  // Mutate state BEFORE emit.
  entry.flags.delete(cls)
  if (entry.flags.size === 0 && entry.badStretchClasses.size > 0) {
    // Snapshot history and reset BEFORE the postToChannel call.
    const snapshot = new Map(entry.badStretchClasses)
    entry.badStretchClasses = new Map()
    deps.postToChannel(channelId, ALL_CLEAR_TEMPLATE(snapshot))
  }
}

/**
 * resetAllToHealthy — silently wipes every channel's flag set and bad-stretch
 * history to a clean slate. No `postToChannel` calls. Used at boot time
 * after `socket.start()` as a defensive boundary for pre-auth observations
 * (boot-time call is added by Epic 2).
 */
export function resetAllToHealthy(channelIds: string[]): void {
  for (const channelId of channelIds) {
    entries.set(channelId, { flags: new Set(), badStretchClasses: new Map() })
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
 *   - ErrCwdNotFound / ErrCwdNotADirectory → raises 'cwd-unreachable' (detail = routeCwd)
 *     UNLESS routeCwd is undefined, in which case logs loudly and rethrows
 *     WITHOUT raising the flag (defensive carve-out for verb-class drift).
 *   - Other errors → no flag change; rethrow unchanged.
 *
 * On success: clears 'ad-unreachable' and 'tmux-unavailable', returns result.
 *
 * The original error is always rethrown so callers can handle it normally.
 */
export async function withOutageDetection<T>(
  channelId: string,
  routeCwd: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  if (!deps) {
    throw new Error(
      'outage-state: withOutageDetection called before initOutageState — caller-site bug',
    )
  }
  try {
    const result = await fn(deps.getClient())
    clearOutageFlag(channelId, 'ad-unreachable')
    clearOutageFlag(channelId, 'tmux-unavailable')
    return result
  } catch (err) {
    if (err instanceof ErrSystemInstallDisappeared) {
      setOutageFlag(channelId, 'ad-unreachable', err.binaryPath)
    } else if (err instanceof ErrTmuxNotAvailable) {
      setOutageFlag(channelId, 'tmux-unavailable')
    } else if (err instanceof ErrCwdNotFound || err instanceof ErrCwdNotADirectory) {
      if (routeCwd !== undefined) {
        setOutageFlag(channelId, 'cwd-unreachable', routeCwd)
      } else {
        console.error(
          `[slack] outage-state: withOutageDetection: cwd error on channel=${channelId} but routeCwd is undefined — verb-class drift; rethrowing without raising flag`,
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
 * that actually exercise the route's cwd, so cwd health is only confirmed
 * by a successful spawn/resume.
 */
export async function withSpawnDetection<T>(
  channelId: string,
  routeCwd: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const result = await withOutageDetection(channelId, routeCwd, fn)
  clearOutageFlag(channelId, 'cwd-unreachable')
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
