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
// Types
// ---------------------------------------------------------------------------

export interface RouteEntry {
  cwd: string
  name: string
}

/** Raw shape of routing.json as parsed from disk. All optional fields may be absent. */
export interface RoutingConfigInput {
  routes: Record<string, RouteEntry>
  default_route?: string
  default_dm_session?: string
  bind?: string
  port?: number
  use_waggle?: boolean
  spawn_timeout?: number
}

/** Validated, fully-resolved routing configuration with all defaults applied. */
export interface RoutingConfig {
  routes: Record<string, RouteEntry>
  default_route?: string
  default_dm_session?: string
  bind: string
  port: number
  use_waggle: boolean
  spawn_timeout: number
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
    use_waggle: input.use_waggle ?? false,
    spawn_timeout: input.spawn_timeout ?? 60,
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
  const routeNames = Object.values(config.routes).map((r) => r.name)
  if (routeNames.length === 0) {
    throw new Error('Routing config validation error: routes must contain at least one entry.')
  }

  // Duplicate route names across different channels are not allowed
  const seen = new Set<string>()
  for (const name of routeNames) {
    if (seen.has(name)) {
      throw new Error(
        `Routing config validation error: duplicate route name "${name}" found across multiple channels. Each route name must be unique.`,
      )
    }
    seen.add(name)
  }

  // default_route must reference an existing route name
  if (config.default_route !== undefined) {
    if (!seen.has(config.default_route)) {
      throw new Error(
        `Routing config validation error: default_route "${config.default_route}" does not match any defined route name.`,
      )
    }
  }

  // default_dm_session must reference an existing route name
  if (config.default_dm_session !== undefined) {
    if (!seen.has(config.default_dm_session)) {
      throw new Error(
        `Routing config validation error: default_dm_session "${config.default_dm_session}" does not match any defined route name.`,
      )
    }
  }
}

/**
 * Applies defaults, expands tildes on all cwd paths, then validates.
 * Returns a fully resolved RoutingConfig or throws on invalid input.
 */
export function resolveConfig(input: RoutingConfigInput): RoutingConfig {
  const withDefaults = applyDefaults(input)

  // Expand tildes on every route's cwd
  const expandedRoutes: Record<string, RouteEntry> = {}
  for (const [channelId, entry] of Object.entries(withDefaults.routes)) {
    expandedRoutes[channelId] = {
      ...entry,
      cwd: resolve(expandTilde(entry.cwd)),
    }
  }

  const config: RoutingConfig = {
    ...withDefaults,
    routes: expandedRoutes,
  }

  validateConfig(config)
  return config
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = '~/.claude/channels/slack/routing.json'

/**
 * Reads routing configuration from disk, parses it, and returns a validated
 * RoutingConfig. Throws a descriptive error for missing files, malformed JSON,
 * or validation failures.
 *
 * @param path  Path to routing.json. Defaults to ~/.claude/channels/slack/routing.json.
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
