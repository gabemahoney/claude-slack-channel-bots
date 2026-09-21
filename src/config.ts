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
import { dirname, resolve } from 'path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default path to config.json. Also the source of the fallback config
 * directory used by default resolution when no loaded-config path is known
 * (direct pure-function callers): the expanded dirname of this path
 * (`~/.claude/channels/slack`).
 */
const DEFAULT_CONFIG_PATH = '~/.claude/channels/slack/config.json'

export const MCP_SERVER_NAME = 'slack-channel-router'
export const ALLOWED_PRESCRIPTIONS = ['gentle', 'standard', 'aggressive']
export const ALLOWED_SYSTEM_PROMPT_MODES = ['append', 'none']

/** Default agent-director poll interval (SR-4.1), milliseconds. */
export const DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS = 1000

/** Inclusive lower bound on agent_director_poll_interval_ms (SR-4.1). */
export const MIN_AGENT_DIRECTOR_POLL_INTERVAL_MS = 200

/** Inclusive upper bound on agent_director_poll_interval_ms (SR-4.1). */
export const MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS = 3_600_000

/**
 * The canonical set of top-level keys allowed in config.json. Anything else
 * is rejected at startup per SR-4.2; the rename of
 * claude_director_poll_interval_ms → agent_director_poll_interval_ms (SR-4.1)
 * relies on this rejection to surface stale operator configs loudly.
 */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'routes',
  'default_route',
  'default_dm_session',
  'bind',
  'port',
  'session_restart_delay',
  'health_check_interval',
  'exit_timeout',
  'stop_timeout',
  'mcp_config_path',
  'append_system_prompt_file',
  'cozempic_prescription',
  'system_prompt_mode',
  'message_archive_db',
  'claude_config_dir',
  'resume_enabled',
  'agent_director_poll_interval_ms',
  'stop_hook_bootstrap',
  'cron_table_path',
  'cron_log_path',
  'cron_log_max_bytes',
])

/** The canonical set of per-route keys allowed inside a routes[<channel>] entry. */
const KNOWN_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'cwd',
  'claude_config_dir',
  'stop_hook_bootstrap',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteEntry {
  cwd: string
  /**
   * Optional path to a Claude on-disk config directory for this route.
   * When set, sessions for this route launch with `CLAUDE_CONFIG_DIR=<path>`,
   * letting different routes authenticate against different Claude accounts.
   * `~` is expanded and the path is resolved to absolute. When omitted, the
   * top-level `claude_config_dir` is used (and Claude's own default applies
   * if neither is set).
   */
  claude_config_dir?: string
  /**
   * Per-route override for the Stop-hook bootstrap guard (SR-4.1–SR-4.5).
   * Optional (undefined = inherit): when unset, the effective value is the
   * top-level `stop_hook_bootstrap`. Per-route wins via
   * `route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap`,
   * mirroring the existing claude_config_dir precedence.
   */
  stop_hook_bootstrap?: boolean
  /**
   * Runtime-resolved Slack channel name (e.g. "horde-agent-director").
   * Populated by the startup `conversations.info` resolver and refreshed
   * opportunistically by event handlers. Never read from config.json — these
   * fields exist on the in-memory record only and the validator rejects them
   * if present in the JSON payload.
   */
  name?: string
  /**
   * Runtime-resolved normalized channel name suitable for use in tmux
   * session names and agent-director `claude_instance_id`. Produced by
   * `normalizeChannelName(name)` whenever `name` is set.
   */
  normalizedName?: string
}

/**
 * Normalize a Slack channel name into a token safe for tmux session names
 * and agent-director `claude_instance_id` values: lowercased, all non
 * `[a-z0-9]` runs collapsed to a single `_`, and any leading or trailing
 * underscores stripped. Returns `''` when the input contains no alnum chars.
 */
export function normalizeChannelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
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
  /** Optional path to a SQLite DB where every inbound Slack message will be archived. */
  message_archive_db?: string
  /**
   * Top-level Claude on-disk config directory for routes that do not specify
   * their own `claude_config_dir`. When set, managed sessions launch with
   * `CLAUDE_CONFIG_DIR=<path>`. When omitted, Claude's own default applies.
   * `~` is expanded and the path is resolved to absolute.
   */
  claude_config_dir?: string
  /**
   * When false, disables --resume on startup so bots always launch fresh.
   * Defaults to true. Set to false to work around `--resume` regressions
   * (e.g. Claude Code v2.1.120 "sandbox required but unavailable").
   */
  resume_enabled?: boolean
  /**
   * Stop-hook bootstrap guard opt-out (SR-4.1–SR-4.5). Defaults to true when
   * absent at the top level. Per-route override stays optional (undefined =
   * inherit). The effective value for a given route is
   * `route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap`.
   */
  stop_hook_bootstrap?: boolean
  /**
   * Poll interval (ms) for the SR-2.1 permission-relay tick. Must be a
   * positive integer in the closed range [200, 3_600_000]; defaults to 1000.
   * Replaces the old `claude_director_poll_interval_ms` field — the old name
   * is rejected explicitly at startup per SR-4.1.
   */
  agent_director_poll_interval_ms?: number
  /**
   * Path to the cscb_cron crontable file (b.he5 PD-5). Optional: when omitted,
   * defaults to `<config dir>/crontab`, where `<config dir>` is the directory
   * of the config file actually loaded. `~` is expanded and the path resolved
   * to absolute. Config carries only this pointer, never schedules.
   */
  cron_table_path?: string
  /**
   * Path to the cscb_cron log file (b.he5 PD-5). Optional: when omitted,
   * defaults to `<config dir>/cron.log`. `~` is expanded and the path resolved
   * to absolute.
   */
  cron_log_path?: string
  /**
   * Maximum size in bytes of the cron log before pruning (b.he5 PD-5). Optional
   * with NO default: absent means pruning is disabled. When set, must be a
   * positive integer (finite, integer, >= 1) — no upper bound.
   */
  cron_log_max_bytes?: number
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
  /** Absolute path to SQLite archive DB. Undefined disables the feature. */
  message_archive_db?: string
  claude_config_dir?: string
  /** When false, --resume is skipped on startup and bots always launch fresh. Defaults to true. */
  resume_enabled: boolean
  /**
   * Resolved Stop-hook bootstrap guard flag (SR-4.1–SR-4.5). Defaults to true
   * when absent at the top level. Per-route override lives on RouteEntry and
   * remains optional (undefined = inherit); the effective value for a route is
   * `route.stop_hook_bootstrap ?? routingConfig.stop_hook_bootstrap`.
   */
  stop_hook_bootstrap: boolean
  /** Poll interval (ms) for the SR-2.1 permission-relay tick. */
  agent_director_poll_interval_ms: number
  /**
   * Absolute path to the cscb_cron crontable file (b.he5 PD-5). Always present:
   * defaults to `<config dir>/crontab` when omitted from input.
   */
  cron_table_path: string
  /**
   * Absolute path to the cscb_cron log file (b.he5 PD-5). Always present:
   * defaults to `<config dir>/cron.log` when omitted from input.
   */
  cron_log_path: string
  /**
   * Maximum size in bytes of the cron log before pruning (b.he5 PD-5). Optional
   * with no default: undefined means pruning is disabled.
   */
  cron_log_max_bytes?: number
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Resolve the directory used to derive config-dir-relative defaults
 * (`cron_table_path`, `cron_log_path`). When `configDir` is provided (the
 * directory of the config file actually loaded — including non-default paths),
 * it is used verbatim. Direct pure-function callers with no path context pass
 * nothing and fall back to the expanded dirname of DEFAULT_CONFIG_PATH
 * (`~/.claude/channels/slack`).
 */
function resolveConfigDir(configDir?: string): string {
  if (configDir !== undefined) return configDir
  return dirname(resolve(expandTilde(DEFAULT_CONFIG_PATH)))
}

/**
 * Returns a new config object with all optional fields filled in with defaults.
 * Does not mutate the input.
 *
 * @param configDir  Directory of the loaded config file, used to derive the
 *   config-dir-relative cron path defaults. Omit for direct pure-function
 *   callers with no path context (falls back to dirname of DEFAULT_CONFIG_PATH).
 */
export function applyDefaults(input: RoutingConfigInput, configDir?: string): RoutingConfig {
  const dir = resolveConfigDir(configDir)
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
    message_archive_db: input.message_archive_db,
    claude_config_dir: input.claude_config_dir,
    resume_enabled: input.resume_enabled ?? true,
    stop_hook_bootstrap: input.stop_hook_bootstrap ?? true,
    agent_director_poll_interval_ms:
      input.agent_director_poll_interval_ms ?? DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS,
    cron_table_path: input.cron_table_path ?? resolve(dir, 'crontab'),
    cron_log_path: input.cron_log_path ?? resolve(dir, 'cron.log'),
    cron_log_max_bytes: input.cron_log_max_bytes,
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

  // Top-level claude_config_dir, when set, must be a non-empty (post-trim) string
  if (config.claude_config_dir !== undefined) {
    if (typeof config.claude_config_dir !== 'string' || config.claude_config_dir.trim() === '') {
      throw new Error(
        'Routing config validation error: claude_config_dir must be a non-empty string when set.',
      )
    }
  }

  // Per-route claude_config_dir, when set, must also be a non-empty (post-trim) string
  for (const [channelId, route] of Object.entries(config.routes)) {
    if (route.claude_config_dir !== undefined) {
      if (typeof route.claude_config_dir !== 'string' || route.claude_config_dir.trim() === '') {
        throw new Error(
          `Routing config validation error: routes["${channelId}"].claude_config_dir must be a non-empty string when set.`,
        )
      }
    }
  }

  // Top-level stop_hook_bootstrap must be a boolean (SR-4.1–SR-4.5).
  if (typeof config.stop_hook_bootstrap !== 'boolean') {
    throw new Error(
      `Routing config validation error: stop_hook_bootstrap must be a boolean; got ${JSON.stringify(config.stop_hook_bootstrap)}.`,
    )
  }

  // Per-route stop_hook_bootstrap, when set, must also be a boolean.
  for (const [channelId, route] of Object.entries(config.routes)) {
    if (route.stop_hook_bootstrap !== undefined && typeof route.stop_hook_bootstrap !== 'boolean') {
      throw new Error(
        `Routing config validation error: routes["${channelId}"].stop_hook_bootstrap must be a boolean when set; got ${JSON.stringify(route.stop_hook_bootstrap)}.`,
      )
    }
  }

  // SR-4.1: agent_director_poll_interval_ms must be a positive integer in
  // the closed range [200, 3_600_000].
  const pollMs = config.agent_director_poll_interval_ms
  if (
    typeof pollMs !== 'number' ||
    !Number.isFinite(pollMs) ||
    !Number.isInteger(pollMs) ||
    pollMs < MIN_AGENT_DIRECTOR_POLL_INTERVAL_MS ||
    pollMs > MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `Routing config validation error: agent_director_poll_interval_ms must be a positive integer in [${MIN_AGENT_DIRECTOR_POLL_INTERVAL_MS}, ${MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS}]; got ${JSON.stringify(pollMs)}.`,
    )
  }

  // cron_table_path must be a non-empty (post-trim) string (b.he5 PD-5).
  if (typeof config.cron_table_path !== 'string' || config.cron_table_path.trim() === '') {
    throw new Error(
      'Routing config validation error: cron_table_path must be a non-empty string.',
    )
  }

  // cron_log_path must be a non-empty (post-trim) string (b.he5 PD-5).
  if (typeof config.cron_log_path !== 'string' || config.cron_log_path.trim() === '') {
    throw new Error(
      'Routing config validation error: cron_log_path must be a non-empty string.',
    )
  }

  // cron_log_max_bytes, when set, must be a positive integer (finite, integer,
  // >= 1) — no upper bound (b.he5 PD-5). Absent disables pruning.
  if (config.cron_log_max_bytes !== undefined) {
    const maxBytes = config.cron_log_max_bytes
    if (
      typeof maxBytes !== 'number' ||
      !Number.isFinite(maxBytes) ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw new Error(
        `Routing config validation error: cron_log_max_bytes must be a positive integer (>= 1) when set; got ${JSON.stringify(maxBytes)}.`,
      )
    }
  }
}

/**
 * Reject config.json shapes that carry fields CSCB does not know about
 * (SR-4.2). The pre-rename field name `claude_director_poll_interval_ms`
 * gets a targeted error message that names the new field, per SR-4.1's
 * migration guidance.
 *
 * Operates on the raw parsed object so we can see fields that would otherwise
 * be dropped by RoutingConfigInput's structural casting.
 */
function rejectUnknownFields(parsed: Record<string, unknown>): void {
  const unknown: string[] = []
  for (const key of Object.keys(parsed)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue
    if (key === 'claude_director_poll_interval_ms') {
      throw new Error(
        `Routing config validation error: claude_director_poll_interval_ms has been renamed to agent_director_poll_interval_ms (SR-4.1). Rename the field in config.json — the old name is not accepted as an alias.`,
      )
    }
    unknown.push(key)
  }
  if (unknown.length > 0) {
    throw new Error(
      `Routing config validation error: unknown top-level field(s) in config.json: ${unknown.map((k) => JSON.stringify(k)).join(', ')}.`,
    )
  }

  // Per-route unknown-field check
  const routes = parsed['routes']
  if (routes !== null && typeof routes === 'object' && !Array.isArray(routes)) {
    for (const [channelId, entry] of Object.entries(routes as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const routeUnknown: string[] = []
      for (const key of Object.keys(entry as Record<string, unknown>)) {
        if (!KNOWN_ROUTE_KEYS.has(key)) routeUnknown.push(key)
      }
      if (routeUnknown.length > 0) {
        throw new Error(
          `Routing config validation error: unknown field(s) in routes["${channelId}"]: ${routeUnknown.map((k) => JSON.stringify(k)).join(', ')}.`,
        )
      }
    }
  }
}

/**
 * Applies defaults, expands tildes on all CWD paths, then validates.
 * Returns a fully resolved RoutingConfig or throws on invalid input.
 */
export function resolveConfig(input: RoutingConfigInput, configDir?: string): RoutingConfig {
  const withDefaults = applyDefaults(input, configDir)

  // Expand tildes on every route's cwd and claude_config_dir; preserve other fields verbatim.
  // Empty/whitespace claude_config_dir is preserved unchanged so validateConfig can reject it.
  const expandedRoutes: Record<string, RouteEntry> = {}
  for (const [channelId, entry] of Object.entries(withDefaults.routes)) {
    expandedRoutes[channelId] = {
      ...entry,
      cwd: resolve(expandTilde(entry.cwd)),
      ...(entry.claude_config_dir !== undefined
        ? {
            claude_config_dir: entry.claude_config_dir.trim() === ''
              ? entry.claude_config_dir
              : resolve(expandTilde(entry.claude_config_dir)),
          }
        : {}),
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
    message_archive_db: withDefaults.message_archive_db !== undefined
      ? resolve(expandTilde(withDefaults.message_archive_db))
      : undefined,
    claude_config_dir: withDefaults.claude_config_dir !== undefined
      ? (withDefaults.claude_config_dir.trim() === ''
          ? withDefaults.claude_config_dir
          : resolve(expandTilde(withDefaults.claude_config_dir)))
      : undefined,
    // Expand tildes on the cron paths; preserve empty/whitespace verbatim so
    // validateConfig can reject them (claude_config_dir convention). Defaults
    // applied by applyDefaults are already absolute and pass through unchanged.
    cron_table_path:
      typeof withDefaults.cron_table_path === 'string' && withDefaults.cron_table_path.trim() !== ''
        ? resolve(expandTilde(withDefaults.cron_table_path))
        : withDefaults.cron_table_path,
    cron_log_path:
      typeof withDefaults.cron_log_path === 'string' && withDefaults.cron_log_path.trim() !== ''
        ? resolve(expandTilde(withDefaults.cron_log_path))
        : withDefaults.cron_log_path,
  }

  validateConfig(config)
  return config
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

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
    rejectUnknownFields(parsed as Record<string, unknown>)
    return resolveConfig(input, dirname(configPath))
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`loadConfig: invalid routing config in "${configPath}": ${cause}`)
  }
}
