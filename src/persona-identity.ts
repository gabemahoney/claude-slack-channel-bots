/**
 * persona-identity.ts — Persona key rule and the identifiers derived from it.
 *
 * A persona is addressed everywhere by its key (b.av2 SR-2.1). This module
 * owns the key rule, the persona-reference rendering used by logs, previews
 * and errors (b.av2 SR-2.2, SR-10.3), and the pure derivations of every
 * agent-director and tmux identifier a persona gets (b.av2 SR-2.2): instance
 * ID, tmux session name, labels (including the `config_dir` label) and the
 * spawn-environment values.
 *
 * Pure module (b.av2 SR-13.1): no module-scope side effects, no file-system
 * or environment access, and nothing reads the home directory at import.
 * Only the `config_dir` derivations consult a home directory, which callers
 * may inject; the OS home is read at call time only when none is given.
 * Must not import `config.ts` (the persona config loader imports this
 * module), the server, the session manager or the agent-director client.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Persona key constants (b.av2 SR-2.1)
// ---------------------------------------------------------------------------

/** Longest name that is its own key, and the length a normalised stem is truncated to. */
export const PERSONA_KEY_MAX_STEM_LENGTH = 40

/** Number of lowercase hex digits of SHA-256 appended to a normalised key. */
export const PERSONA_KEY_SUFFIX_LENGTH = 8

/** Longest possible key: a full stem, `_`, and the hex suffix (49). */
export const PERSONA_KEY_MAX_LENGTH = PERSONA_KEY_MAX_STEM_LENGTH + 1 + PERSONA_KEY_SUFFIX_LENGTH

/** A name matching this pattern is its own key. */
export const PERSONA_KEY_IN_FORM_RE: RegExp = new RegExp(`^[a-z0-9_]{1,${PERSONA_KEY_MAX_STEM_LENGTH}}$`)

// ---------------------------------------------------------------------------
// Derived-identifier constants (b.av2 SR-2.2)
// ---------------------------------------------------------------------------

/** Prefix of every persona's agent-director `claude_instance_id`; the `cscb_` anchor of `PERMISSION_ACTION_ID_RE`. */
export const PERSONA_INSTANCE_ID_PREFIX = 'cscb_'

/** Prefix of every persona's tmux session name. */
export const PERSONA_TMUX_SESSION_PREFIX = 'slack_bot_'

/** Label marking an agent-director row as owned by this server. */
export const SERVICE_LABEL = 'service=cscb'

/** Prefix of the label carrying the persona key. */
export const PERSONA_LABEL_PREFIX = 'persona='

/** Prefix of the label carrying the hashed effective claude_config_dir. */
export const CONFIG_DIR_LABEL_PREFIX = 'config_dir='

/** Number of lowercase hex digits of SHA-256 used as the `config_dir` label value. */
export const CONFIG_DIR_HASH_LENGTH = 12

/** Directory, relative to the home directory, that an unconfigured claude_config_dir resolves to. */
export const DEFAULT_CLAUDE_CONFIG_SUBDIR = '.claude'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Same tilde rule as `expandTilde` in `config.ts` (exactly `~`, or a leading
 * `~/`; any other `~` form is left unchanged), but with the home directory
 * injected rather than read.
 */
function expandTildeWithHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  return path
}

// ---------------------------------------------------------------------------
// Persona key and reference rendering
// ---------------------------------------------------------------------------

/**
 * Derive a persona's key from its name (b.av2 SR-2.1).
 *
 * A name of 1–40 characters drawn only from `a-z`, `0-9` and `_` is returned
 * unchanged. Any other name is lower-cased, each run of characters outside
 * `a-z0-9_` is replaced by one `_`, leading and trailing `_` are trimmed, the
 * result is truncated to 40 characters, and `_` plus the first 8 hex digits
 * of the SHA-256 of the original UTF-8 name is appended. When nothing remains
 * after trimming, the key is the 8 hex digits alone. The stem is not trimmed
 * again after truncation, so a truncation ending in `_` yields `__` before
 * the suffix.
 *
 * Never throws and never validates: rejecting an empty name is the loader's job.
 */
export function personaKey(name: string): string {
  if (PERSONA_KEY_IN_FORM_RE.test(name)) return name
  const suffix = sha256Hex(name).slice(0, PERSONA_KEY_SUFFIX_LENGTH)
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, PERSONA_KEY_MAX_STEM_LENGTH)
  return stem === '' ? suffix : `${stem}_${suffix}`
}

/**
 * Render a persona reference for logs, previews and errors (b.av2 SR-2.2,
 * SR-10.3): the name JSON-quoted, with the key beside it.
 *
 * Format: `<JSON.stringify(name)> (key=<key>)`, e.g. `"Ops Bot" (key=ops_bot_1a2b3c4d)`.
 * JSON quoting makes quotes, backslashes, newlines and control characters safe.
 * Pass `key` when it is already known; otherwise it is derived from `name`.
 */
export function renderPersonaRef(name: string, key: string = personaKey(name)): string {
  return `${JSON.stringify(name)} (key=${key})`
}

// ---------------------------------------------------------------------------
// Derived identifiers
// ---------------------------------------------------------------------------

/** agent-director `claude_instance_id` for a persona key: `cscb_<key>`. */
export function personaInstanceId(key: string): string {
  return `${PERSONA_INSTANCE_ID_PREFIX}${key}`
}

/** tmux session name for a persona key: `slack_bot_<key>`. */
export function personaTmuxSessionName(key: string): string {
  return `${PERSONA_TMUX_SESSION_PREFIX}${key}`
}

/**
 * Resolve the effective claude_config_dir lexically.
 *
 * An absent (or empty) `configDir` means neither the persona nor the top level
 * configures one, and resolves to `<home>/.claude`. Otherwise the value is
 * tilde-expanded against `home` and made absolute with `path.resolve` (a
 * relative value resolves against the process working directory).
 * No file-system access: symlinks are not followed and existence is not
 * checked. A caller that needs real-path semantics (b.av2 SR-1.5) passes an
 * already real-pathed directory.
 *
 * @param home  Home directory for `~` and the default; defaults to the OS
 *   home directory, read at call time. Tests pass a temp directory.
 */
export function resolveClaudeConfigDir(configDir?: string, home: string = homedir()): string {
  if (!configDir) return resolve(home, DEFAULT_CLAUDE_CONFIG_SUBDIR)
  return resolve(expandTildeWithHome(configDir, home))
}

/**
 * Value of the `config_dir` label: the first 12 lowercase hex digits of the
 * SHA-256 of the resolved effective claude_config_dir (b.av2 SR-2.2).
 *
 * Hashes exactly the path returned by `resolveClaudeConfigDir(configDir, home)`
 * (lexical tilde expansion plus `path.resolve`); it never reads the file
 * system. So `~`, `~/x` and their absolute forms under the same `home` give
 * the same value, and an absent directory equals an explicit `<home>/.claude`.
 */
export function configDirLabelValue(configDir?: string, home: string = homedir()): string {
  return sha256Hex(resolveClaudeConfigDir(configDir, home)).slice(0, CONFIG_DIR_HASH_LENGTH)
}

/**
 * Full agent-director label list for a persona:
 * `service=cscb`, `persona=<key>`, `config_dir=<configDirLabelValue>`.
 * `configDir` and `home` are as for `configDirLabelValue`.
 */
export function personaLabels(key: string, configDir?: string, home: string = homedir()): string[] {
  return [
    SERVICE_LABEL,
    `${PERSONA_LABEL_PREFIX}${key}`,
    `${CONFIG_DIR_LABEL_PREFIX}${configDirLabelValue(configDir, home)}`,
  ]
}

/** Inputs to `personaSpawnEnv`. */
export interface PersonaSpawnEnvInput {
  /** Persona key (not the name). */
  key: string
  /** Resolved crontable path, passed through as `CSCB_CRONTABLE_PATH`. */
  crontablePath: string
  /**
   * Effective claude_config_dir (per-persona, else top-level) when one is
   * configured; passed through unchanged as `CLAUDE_CONFIG_DIR`, as today.
   * Absent or empty means none is configured and the variable is omitted.
   */
  claudeConfigDir?: string
}

/**
 * Spawn-environment values for a persona (b.av2 SR-2.2): `CSCB_PERSONA` and
 * `CLAUDE_MANAGED_CHANNEL` set to the key, `CSCB_CRONTABLE_PATH` always, and
 * `CLAUDE_CONFIG_DIR` only when a directory is configured. No variable name
 * uses agent-director's reserved `AGENT_DIRECTOR_` prefix.
 */
export function personaSpawnEnv(input: PersonaSpawnEnvInput): Record<string, string> {
  return {
    ...(input.claudeConfigDir ? { CLAUDE_CONFIG_DIR: input.claudeConfigDir } : {}),
    CSCB_PERSONA: input.key,
    CLAUDE_MANAGED_CHANNEL: input.key,
    CSCB_CRONTABLE_PATH: input.crontablePath,
  }
}
