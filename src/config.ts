/**
 * config.ts — Routing configuration loader and validator for the Slack Channel Router.
 *
 * Pure functions (applyDefaults, validateConfig, expandTilde, resolveConfig) are
 * side-effect-free and importable by tests without performing any I/O.
 * The single I/O wrapper (loadConfig) reads the JSON file and delegates to resolveConfig.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'slack-channel-router'
export const ALLOWED_PRESCRIPTIONS = ['gentle', 'standard', 'aggressive']
export const ALLOWED_SYSTEM_PROMPT_MODES = ['append', 'none']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteEntry {
  cwd: string
}

/** Raw shape of config.json as parsed from disk. All optional fields may be absent. */
export interface RoutingConfigInput {
  routes: Record<string, RouteEntry>
  /** CWD path to use when a message arrives on a channel with no explicit entry in routes. */
  default_route?: string
  /** CWD path of the session that handles direct messages. */
  default_dm_session?: string
  bind?: string
  port?: number
  session_restart_delay?: number
  health_check_interval?: number
  exit_timeout?: number
  stop_timeout?: number
  mcp_config_path?: string
  append_system_prompt_file?: string
  cozempic_prescription?: string
  system_prompt_mode?: string
}

/** Validated, fully-resolved routing configuration with all defaults applied. */
export interface RoutingConfig {
  routes: Record<string, RouteEntry>
  default_route?: string
  default_dm_session?: string
  bind: string
  port: number
  session_restart_delay: number
  health_check_interval: number
  exit_timeout: number
  stop_timeout: number
  mcp_config_path: string
  append_system_prompt_file?: string
  cozempic_prescription: string
  system_prompt_mode: string
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Returns a new config object with all optional fields filled in with defaults.
 * Does not mutate the input.
 */
export function applyDefaults(input: RoutingConfigInput): RoutingConfig {
  return {
    routes: input.routes,
    default_route: input.default_route,
    default_dm_session: input.default_dm_session,
    bind: input.bind ?? '127.0.0.1',
    port: input.port ?? 3100,
    session_restart_delay: input.session_restart_delay ?? 60,
    health_check_interval: input.health_check_interval ?? 120,
    exit_timeout: input.exit_timeout ?? 120,
    stop_timeout: input.stop_timeout ?? 30,
    mcp_config_path: input.mcp_config_path ?? '~/.claude/slack-mcp.json',
    append_system_prompt_file: input.append_system_prompt_file,
    cozempic_prescription: input.cozempic_prescription ?? 'standard',
    system_prompt_mode: input.system_prompt_mode ?? 'append',
  }
}

/**
 * Replaces a leading ~ in a path string with the current user's home directory.
 * Paths without a leading ~ are returned unchanged.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

/**
 * Validates the cross-references and invariants of a routing config.
 * Throws a descriptive Error on the first violation found.
 * Does not mutate the input.
 */
export function validateConfig(config: RoutingConfig): void {
  // At least one route must be defined
  const cwds = Object.values(config.routes).map((r) => r.cwd)
  if (cwds.length === 0) {
    throw new Error('Routing config validation error: routes must contain at least one entry.')
  }

  // Duplicate CWDs across different channels are not allowed (CWD is the session identity)
  const seen = new Set<string>()
  for (const cwd of cwds) {
    if (seen.has(cwd)) {
      throw new Error(
        `Routing config validation error: duplicate CWD "${cwd}" found across multiple channels. Each route CWD must be unique.`,
      )
    }
    seen.add(cwd)
  }

  // default_route must reference an existing route CWD
  if (config.default_route !== undefined) {
    if (!seen.has(config.default_route)) {
      throw new Error(
        `Routing config validation error: default_route "${config.default_route}" does not match any defined route CWD.`,
      )
    }
  }

  // session_restart_delay must not be negative
  if (config.session_restart_delay < 0) {
    throw new Error(
      'Routing config validation error: session_restart_delay must be a non-negative number.',
    )
  }

  // health_check_interval must not be negative
  if (config.health_check_interval < 0) {
    throw new Error(
      'Routing config validation error: health_check_interval must be a non-negative number.',
    )
  }

  // exit_timeout must not be negative
  if (config.exit_timeout < 0) {
    throw new Error(
      'Routing config validation error: exit_timeout must be a non-negative number.',
    )
  }

  // stop_timeout must not be negative
  if (config.stop_timeout < 0) {
    throw new Error(
      'Routing config validation error: stop_timeout must be a non-negative number.',
    )
  }

  // cozempic_prescription must be one of the allowed values
  if (!ALLOWED_PRESCRIPTIONS.includes(config.cozempic_prescription)) {
    throw new Error(
      `Routing config validation error: cozempic_prescription "${config.cozempic_prescription}" is invalid. Allowed values are: ${ALLOWED_PRESCRIPTIONS.join(', ')}.`,
    )
  }

  // system_prompt_mode must be one of the allowed values
  if (!ALLOWED_SYSTEM_PROMPT_MODES.includes(config.system_prompt_mode)) {
    throw new Error(
      `Routing config validation error: system_prompt_mode "${config.system_prompt_mode}" is invalid. Allowed values are: ${ALLOWED_SYSTEM_PROMPT_MODES.join(', ')}.`,
    )
  }

  // default_dm_session must reference an existing route CWD
  if (config.default_dm_session !== undefined) {
    if (!seen.has(config.default_dm_session)) {
      throw new Error(
        `Routing config validation error: default_dm_session "${config.default_dm_session}" does not match any defined route CWD.`,
      )
    }
  }
}

/**
 * Applies defaults, expands tildes on all CWD paths, then validates.
 * Returns a fully resolved RoutingConfig or throws on invalid input.
 */
export function resolveConfig(input: RoutingConfigInput): RoutingConfig {
  const withDefaults = applyDefaults(input)

  // Expand tildes on every route's cwd
  const expandedRoutes: Record<string, RouteEntry> = {}
  for (const [channelId, entry] of Object.entries(withDefaults.routes)) {
    expandedRoutes[channelId] = {
      cwd: resolve(expandTilde(entry.cwd)),
    }
  }

  const config: RoutingConfig = {
    ...withDefaults,
    routes: expandedRoutes,
    // Expand tildes on default_route and default_dm_session so they match
    // the normalized route CWDs in the routes map.
    default_route: withDefaults.default_route !== undefined
      ? resolve(expandTilde(withDefaults.default_route))
      : undefined,
    default_dm_session: withDefaults.default_dm_session !== undefined
      ? resolve(expandTilde(withDefaults.default_dm_session))
      : undefined,
    mcp_config_path: resolve(expandTilde(withDefaults.mcp_config_path)),
    append_system_prompt_file: withDefaults.append_system_prompt_file !== undefined
      ? resolve(expandTilde(withDefaults.append_system_prompt_file))
      : undefined,
  }

  validateConfig(config)
  return config
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = '~/.claude/channels/slack/config.json'

/**
 * Reads routing configuration from disk, parses it, and returns a validated
 * RoutingConfig. Throws a descriptive error for missing files, malformed JSON,
 * or validation failures.
 *
 * @param path  Path to config.json. Defaults to ~/.claude/channels/slack/config.json.
 */
export function loadConfig(path?: string): RoutingConfig {
  const configPath = resolve(expandTilde(path ?? DEFAULT_CONFIG_PATH))

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`loadConfig: cannot read routing config at "${configPath}": ${cause}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`loadConfig: malformed JSON in "${configPath}": ${cause}`)
  }

  // Basic shape check before handing off to resolveConfig
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `loadConfig: routing config in "${configPath}" must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
    )
  }

  const input = parsed as RoutingConfigInput

  if (typeof input.routes !== 'object' || input.routes === null || Array.isArray(input.routes)) {
    throw new Error(
      `loadConfig: routing config in "${configPath}" is missing a valid "routes" object.`,
    )
  }

  try {
    return resolveConfig(input)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`loadConfig: invalid routing config in "${configPath}": ${cause}`)
  }
}
