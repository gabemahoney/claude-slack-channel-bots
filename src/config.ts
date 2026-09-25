/**
 * config.ts — The persona configuration loader and validator for the Slack
 * Channel Router.
 *
 * The loader (`loadPersonaConfig` / `resolvePersonaConfig`) reads the persona
 * shape of b.av2 SR-1: a `personas` array plus the server-wide settings
 * (b.av2 SR-1.6). It rejects the pre-persona shape before any other check
 * with the conversion message (b.av2 SR-1.7) and never writes or converts
 * the file. Errors name the setting and the rule and never echo a rejected
 * value, and name an unknown key only when it is a plain setting name
 * (`describeUnknownKeys`), so a pasted token never reaches an error
 * (b.av2 SR-10.3).
 *
 * The configuration file is `config.json` in the state directory, at the path
 * `resolveServerConfigPath` returns (b.av2 SR-8.7). Which configuration a
 * start runs (the last-applied record or this file) is decided by the reload
 * controller (`src/reload.ts`), which validates the bytes it read through
 * `parsePersonaConfigBytes`; a record is validated in record mode, where a
 * real-path collision is left to the bring-up (b.av2 SR-1.5).
 *
 * Pure functions (expandTilde, resolvePersonaConfig, parsePersonaConfigBytes,
 * resolveRealPath) are side-effect-free and importable by tests without
 * performing any I/O (b.av2 SR-13.1); importing this module touches no file
 * and reads no environment variable. resolvePersonaConfig and resolveRealPath
 * resolve real paths (b.av2 SR-1.5) but never open, read, create or write a
 * file. The I/O wrapper (loadPersonaConfig) reads the JSON file once and
 * delegates to them.
 *
 * SPDX-License-Identifier: MIT
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'

import { jsonSyntaxErrorOffset, positionAt } from './json-position.ts'
import { expandTilde as expandTildeWith, personaKey, renderPersonaRef } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The environment variable that overrides the server's state directory. */
export const STATE_DIR_ENV = 'SLACK_STATE_DIR'

/** The configuration file's name inside the state directory (b.av2 SR-1.1). */
export const CONFIG_FILE_NAME = 'config.json'

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
 * The top-level keys of the pre-persona shape that the loader rejects with
 * the conversion message before any other check (b.av2 SR-1.7), in the order
 * they are looked for.
 */
export const PRE_PERSONA_KEYS = ['routes', 'default_route', 'default_dm_session'] as const

/**
 * Server-wide top-level keys (b.av2 SR-1.6): the settings the persona shape
 * kept from the pre-persona shape.
 */
const SHARED_TOP_LEVEL_KEYS = [
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
] as const

/**
 * The server-wide settings that hold a path, in the order of the top-level
 * keys: the ones `resolveServerPaths` expands, and the ones a reload compares
 * by real path (b.av2 SR-1.5, SR-8.4).
 */
export const SERVER_PATH_SETTINGS = [
  'mcp_config_path',
  'append_system_prompt_file',
  'message_archive_db',
  'claude_config_dir',
  'cron_table_path',
  'cron_log_path',
] as const

/** A server-wide setting that holds a path. */
export type ServerPathSetting = (typeof SERVER_PATH_SETTINGS)[number]

/**
 * The pre-rename name of `agent_director_poll_interval_ms`: rejected with a
 * message naming the new name (SR-4.1), never accepted as an alias.
 */
const RENAMED_POLL_INTERVAL_KEY = 'claude_director_poll_interval_ms'

// ---------------------------------------------------------------------------
// Persona schema constants (b.av2 SR-1.1 to SR-1.3, SR-1.6)
// ---------------------------------------------------------------------------

/** Default `reply_chunk_limit` (b.av2 SR-1.6): today's reply-tool default. */
export const DEFAULT_REPLY_CHUNK_LIMIT = 4000

/** Allowed `reply_chunk_mode` values (b.av2 SR-1.6). */
export const REPLY_CHUNK_MODES = ['length', 'newline'] as const

/** Default `reply_chunk_mode` (b.av2 SR-1.6): today's reply-tool default. */
export const DEFAULT_REPLY_CHUNK_MODE: ReplyChunkMode = 'newline'

/** Top-level keys that only the persona shape accepts (b.av2 SR-1.6). */
const PERSONA_ONLY_SERVER_KEYS = ['ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode'] as const

/**
 * Every top-level key the persona shape accepts (b.av2 SR-1.1, SR-1.6):
 * `personas`, the shared server-wide keys and the three persona-only ones.
 */
export const PERSONA_TOP_LEVEL_KEYS: readonly string[] = [
  'personas',
  ...SHARED_TOP_LEVEL_KEYS,
  ...PERSONA_ONLY_SERVER_KEYS,
]

/** Keys allowed in a persona entry (b.av2 SR-1.2). */
export const PERSONA_ENTRY_KEYS: readonly (keyof PersonaInput)[] = [
  'name',
  'credentials_file',
  'working_directory',
  'channels',
  'dm',
  'permission_prompts',
  'claude_config_dir',
  'stop_hook_bootstrap',
]

/** Keys allowed in a persona's `dm` object (b.av2 SR-1.2). */
export const PERSONA_DM_KEYS: readonly (keyof PersonaDmInput)[] = ['enabled', 'contact']

/** Keys allowed in a channel entry (b.av2 SR-1.3); both are required. */
export const CHANNEL_ENTRY_KEYS: readonly (keyof ChannelEntryInput)[] = ['id', 'delivery']

/** Allowed channel `delivery` values (b.av2 SR-1.3). */
export const DELIVERY_MODES = ['all', 'mentions'] as const

/** The `permission_prompts` value that sends prompts and notices by DM to `dm.contact`. */
export const DM_DESTINATION = 'dm'

/** Channel IDs in channel entries and `permission_prompts` (b.av2 SR-1.3, SR-1.5). */
export const CHANNEL_ID_RE = /^[CG][A-Z0-9]+$/

/** `dm.contact` Slack user IDs (b.av2 SR-1.2, SR-1.5). */
export const DM_CONTACT_RE = /^[UW][A-Z0-9]+$/

/** Prefix of every error the persona loader's validation raises. */
const PERSONA_ERROR_PREFIX = 'Persona config validation error: '

/**
 * The b.av2 SR-1.7 conversion message for a pre-persona key found in a
 * configuration: names the key and says the configuration must be rewritten
 * as personas, and that nothing is converted automatically.
 */
export function prePersonaConversionMessage(key: string): string {
  return (
    `${JSON.stringify(key)} belongs to the pre-persona configuration shape, which is no longer accepted. ` +
    'The configuration must be converted to personas: rewrite it by hand as a "personas" array. ' +
    'Nothing is converted automatically and the file has not been changed.'
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Server-wide settings as parsed from disk (b.av2 SR-1.6). All fields may be
 * absent.
 */
export interface ServerSettingsInput {
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
   * Top-level Claude on-disk config directory for personas that do not
   * specify their own `claude_config_dir`. When set, managed sessions launch
   * with `CLAUDE_CONFIG_DIR=<path>`. When omitted, Claude's own default
   * applies. `~` is expanded and the path is resolved to absolute.
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
   * absent at the top level. A persona entry may override it; a persona that
   * does not inherits this value (`Persona.stop_hook_bootstrap`).
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

/**
 * Validated, fully-resolved server-wide settings with all defaults applied
 * (b.av2 SR-1.6).
 */
export interface ServerSettings {
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
   * when absent at the top level. The effective value for a persona is
   * `Persona.stop_hook_bootstrap`: its own value, else this one.
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
// Persona configuration types (b.av2 SR-1.1 to SR-1.3, SR-1.6)
// ---------------------------------------------------------------------------

/** Channel `delivery`: `all` delivers every message, `mentions` only those that mention the persona. */
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

/** How a long reply is split into chunks (b.av2 SR-1.6). */
export type ReplyChunkMode = (typeof REPLY_CHUNK_MODES)[number]

/** A channel entry as written in the file (b.av2 SR-1.3). Both keys are required. */
export interface ChannelEntryInput {
  /** Slack channel ID matching `CHANNEL_ID_RE`. */
  id: string
  delivery: DeliveryMode
}

/** A persona's `dm` object as written in the file (b.av2 SR-1.2). */
export interface PersonaDmInput {
  /** The DMs switch. Defaults to false. */
  enabled?: boolean
  /** Slack user ID (`DM_CONTACT_RE`) that receives prompts and notices when `permission_prompts` is `dm`. */
  contact?: string
}

/** A persona entry as written in the file (b.av2 SR-1.2). */
export interface PersonaInput {
  /** Persona identity: a non-empty string with no format rule. */
  name: string
  /** Path to the persona's credentials file: absolute, `~` or `~/…`. */
  credentials_file: string
  /** The instance's working directory: absolute, `~` or `~/…`. */
  working_directory: string
  /** Channels the persona is in. Defaults to none. */
  channels?: ChannelEntryInput[]
  dm?: PersonaDmInput
  /** Destination of prompts and notices: `dm` or one of the persona's channel IDs. Required. */
  permission_prompts: string
  /** Per-persona Claude config dir: absolute, `~` or `~/…`. Defaults to the top-level value. */
  claude_config_dir?: string
  /** Per-persona Stop-hook bootstrap flag. Defaults to the top-level value. */
  stop_hook_bootstrap?: boolean
}

/** The persona configuration file as parsed from disk (b.av2 SR-1.1, SR-1.6). */
export interface PersonaConfigInput extends ServerSettingsInput {
  /** Required; may be empty. */
  personas: PersonaInput[]
  /** Emoji name of the acknowledgement reaction. Absent means no acknowledgement. */
  ack_reaction?: string
  /** Largest reply chunk, in characters. Positive integer; defaults to 4000. */
  reply_chunk_limit?: number
  /** How replies are split. Defaults to `newline`. */
  reply_chunk_mode?: ReplyChunkMode
}

/** A resolved channel entry (b.av2 SR-1.3). */
export interface ChannelEntry {
  id: string
  delivery: DeliveryMode
}

/** A resolved `dm` object (b.av2 SR-1.2). */
export interface PersonaDm {
  enabled: boolean
  contact?: string
}

/** A resolved persona with defaults applied and settings inherited (b.av2 SR-1.2, SR-10.2). */
export interface Persona {
  /** Position of the entry in the file's `personas` array, for `personas[i]` in diagnostics. */
  index: number
  name: string
  /** Persona key derived from `name` (b.av2 SR-2.1). */
  key: string
  /** Absolute, tilde-expanded path. Not checked for existence at load time. */
  credentials_file: string
  /** Absolute, tilde-expanded path. Not checked for existence at load time. */
  working_directory: string
  /** Empty when the file lists none. */
  channels: ChannelEntry[]
  dm: PersonaDm
  /** `dm` or one of `channels`' IDs. */
  permission_prompts: string
  /**
   * Effective Claude config dir: the per-persona value, else the top-level
   * value, else absent (Claude's own default applies). Absolute.
   */
  claude_config_dir?: string
  /** Effective Stop-hook bootstrap flag: the per-persona value, else the top-level value. */
  stop_hook_bootstrap: boolean
}

/** Validated, fully-resolved persona configuration (b.av2 SR-1.1, SR-1.6). */
export interface PersonaConfig extends ServerSettings {
  /** In file order. */
  personas: Persona[]
  /** Absent means no acknowledgement reaction. */
  ack_reaction?: string
  reply_chunk_limit: number
  reply_chunk_mode: ReplyChunkMode
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Fill in the defaults of the server-wide settings (b.av2 SR-1.6). Paths are returned as given (defaults unexpanded, except
 * the cron paths, which are absolute under `configDir`); `resolveServerPaths`
 * expands them. Does not mutate the input.
 */
function applyServerDefaults(input: ServerSettingsInput, configDir: string): ServerSettings {
  return {
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
    cron_table_path: input.cron_table_path ?? resolve(configDir, 'crontab'),
    cron_log_path: input.cron_log_path ?? resolve(configDir, 'cron.log'),
    cron_log_max_bytes: input.cron_log_max_bytes,
  }
}

/**
 * Replaces a leading ~ in a path string with the current user's home directory.
 * Paths without a leading ~ are returned unchanged. Delegates to the one tilde
 * rule in `persona-identity.ts` (imported here as `expandTildeWith`, which
 * also takes an injected home directory).
 */
export function expandTilde(path: string): string {
  return expandTildeWith(path)
}

// ---------------------------------------------------------------------------
// Real-path comparison (b.av2 SR-1.5), shared with later bring-up checks
// ---------------------------------------------------------------------------

/**
 * The comparison form of a configured path (b.av2 SR-1.5): its real path
 * when `realpath` succeeds, otherwise its lexical `path.resolve`. Any realpath
 * failure (missing path or ancestor, permission error, symlink loop) falls
 * back to the lexical form, so this never throws for a string path. Two paths
 * name the same file or directory when their comparison forms are `===`.
 *
 * Resolves only: it never opens, reads or creates anything and does not
 * require the path to exist. The input must already be tilde-expanded; `~`
 * is not expanded here.
 *
 * @param path      The path to compare, already tilde-expanded.
 * @param realpath  Realpath function; defaults to `fs.realpathSync`, looked up
 *   at call time. Tests inject one to simulate file-system behaviour.
 */
export function resolveRealPath(path: string, realpath: (path: string) => string = realpathSync): string {
  return tryResolveRealPath(path, realpath) ?? resolve(path)
}

/**
 * The real path of `path`, or undefined when realpath fails (a missing path
 * or ancestor, a permission error, a symlink loop): `resolveRealPath` without
 * its lexical fallback, for a check that must know the path could not be
 * resolved (b.av2 SR-6.4: a directory-broken persona's rows are not compared
 * by `cwd`). Never throws for a string path; the input must already be
 * tilde-expanded.
 *
 * @param path      The path to resolve, already tilde-expanded.
 * @param realpath  Realpath function; defaults to `fs.realpathSync`, looked up
 *   at call time.
 */
export function tryResolveRealPath(
  path: string,
  realpath: (path: string) => string = realpathSync,
): string | undefined {
  try {
    return realpath(path)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Credentials files protected by the file guard (b.av2 SR-5.2)
// ---------------------------------------------------------------------------

/**
 * The persona credentials files that `assertSendable` must refuse (b.av2
 * SR-5.2): every applied persona's `credentials_file`, plus every string
 * `personas[i].credentials_file` named by the configuration file currently at
 * `configPath`, tilde-expanded under `home` and made absolute.
 *
 * The current file is read tolerantly and not validated, so a file with an
 * invalid edit still protects the paths it names. It is read through
 * `readPersonaConfigBytes`, so a path that is not a regular file (a FIFO or a
 * device) is never read. It is the one read of that reader without the 64 KiB
 * cap (`uncapped`): a configuration file larger than `MAX_RELOAD_FILE_BYTES`
 * still protects the paths it names, so the cap never shrinks what the guard
 * refuses. An unreadable or non-regular file, unparseable JSON, or a file
 * without a `personas` array contributes nothing; this never throws. The
 * file's contents never appear in the result beyond
 * the paths themselves. Callers compare the returned paths by
 * `resolveRealPath`.
 *
 * @param appliedPersonas  The applied personas; their `credentials_file` is
 *   already absolute and tilde-expanded.
 * @param configPath       Path to the configuration file; `~` is expanded under `home`.
 * @param home             Home directory for every `~`; defaults to the OS home,
 *   read at call time and only when a path needs it.
 * @param fs               File-system overrides for reading the configuration
 *   file (`PersonaConfigFs`); unset operations use the real file system.
 */
export function credentialsFilesToProtect(
  appliedPersonas: readonly Persona[],
  configPath: string,
  home?: string,
  fs?: Partial<PersonaConfigFs>,
): string[] {
  const paths = appliedPersonas.map((p) => p.credentials_file)
  let bytes: Buffer
  try {
    bytes = readPersonaConfigBytes(resolve(expandTildeWith(configPath, home)), fs, { uncapped: true })
  } catch {
    return paths
  }
  return [...paths, ...referencedCredentialsPaths(bytes, home)]
}

/**
 * Every string `personas[i].credentials_file` named by the configuration
 * `bytes`, in declaration order (duplicates kept), tilde-expanded under
 * `home` and made absolute, as the persona loader expands persona paths.
 *
 * Tolerant and never throws: the bytes are parsed but not validated, so a
 * file that fails other validation still yields the paths it names, and
 * unparseable JSON, a value that is not an object, or a missing or non-array
 * `personas` yields none; a parse error is discarded, never reported. Pure:
 * reads no file. Only the paths leave it, never other content. The one
 * extraction of referenced credentials paths: the SR-5.2 file guard
 * (`credentialsFilesToProtect`) and the reload detection tick's fingerprint
 * (b.av2 SR-8.3) both use it.
 *
 * @param bytes  The configuration's bytes, or its text.
 * @param home   Home directory for every `~`; defaults to the OS home, read at
 *   call time and only when a path needs it.
 */
export function referencedCredentialsPaths(bytes: Uint8Array | string, home?: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf-8'))
  } catch {
    return []
  }
  const personas = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)['personas']
    : undefined
  if (!Array.isArray(personas)) return []
  const paths: string[] = []
  for (const entry of personas) {
    const file = typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)['credentials_file']
      : undefined
    if (typeof file === 'string' && file !== '') paths.push(resolve(expandTildeWith(file, home)))
  }
  return paths
}

// ---------------------------------------------------------------------------
// Server-wide rules (b.av2 SR-1.6)
// ---------------------------------------------------------------------------

/**
 * How a validation rule words its error: the prefix it starts with. No rule
 * echoes a rejected value, and an unknown key's name is echoed only when it
 * is a plain setting name (`describeUnknownKeys`), so a token pasted into
 * any setting or as a key name cannot reach an error (b.av2 SR-10.3).
 */
interface RuleStyle {
  prefix: string
}

const PERSONA_RULE_STYLE: RuleStyle = { prefix: PERSONA_ERROR_PREFIX }

function ruleError(style: RuleStyle, message: string): Error {
  return new Error(`${style.prefix}${message}`)
}

function checkNonNegative(value: number, key: string, style: RuleStyle): void {
  if (value < 0) throw ruleError(style, `${key} must be a non-negative number.`)
}

function checkAllowedValue(value: unknown, key: string, allowed: readonly string[], style: RuleStyle): void {
  if (allowed.includes(value as string)) return
  throw ruleError(style, `${key} is invalid. Allowed values are: ${allowed.join(', ')}.`)
}

/** A string that is non-empty after trimming. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Absent, or a string that is non-empty after trimming. */
function checkOptionalNonEmptyString(value: unknown, key: string, style: RuleStyle): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw ruleError(style, `${key} must be a non-empty string when set.`)
  }
}

function checkNonEmptyString(value: unknown, key: string, style: RuleStyle): void {
  if (!isNonEmptyString(value)) throw ruleError(style, `${key} must be a non-empty string.`)
}

function checkBoolean(value: unknown, key: string, style: RuleStyle): void {
  if (typeof value !== 'boolean') {
    throw ruleError(style, `${key} must be a boolean.`)
  }
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1
}

/** Absent, or a positive integer (finite, integer, >= 1) with no upper bound. */
function checkOptionalPositiveInteger(value: unknown, key: string, style: RuleStyle): void {
  if (value === undefined || isPositiveInteger(value)) return
  throw ruleError(style, `${key} must be a positive integer (>= 1) when set.`)
}

/**
 * The server-wide rules that come first: the non-negative timings and the two
 * enumerated modes.
 */
function validateServerTimingsAndModes(config: ServerSettings, style: RuleStyle): void {
  checkNonNegative(config.session_restart_delay, 'session_restart_delay', style)
  checkNonNegative(config.health_check_interval, 'health_check_interval', style)
  checkNonNegative(config.exit_timeout, 'exit_timeout', style)
  checkNonNegative(config.stop_timeout, 'stop_timeout', style)
  checkAllowedValue(config.cozempic_prescription, 'cozempic_prescription', ALLOWED_PRESCRIPTIONS, style)
  checkAllowedValue(config.system_prompt_mode, 'system_prompt_mode', ALLOWED_SYSTEM_PROMPT_MODES, style)
}

/**
 * The server-wide rules that come last: the SR-4.1 poll interval range
 * [200, 3_600_000] and the b.he5 PD-5 cron settings (absent
 * `cron_log_max_bytes` disables pruning).
 */
function validateServerPollAndCron(config: ServerSettings, style: RuleStyle): void {
  const pollMs = config.agent_director_poll_interval_ms
  if (
    !isPositiveInteger(pollMs) ||
    pollMs < MIN_AGENT_DIRECTOR_POLL_INTERVAL_MS ||
    pollMs > MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS
  ) {
    throw ruleError(
      style,
      `agent_director_poll_interval_ms must be a positive integer in [${MIN_AGENT_DIRECTOR_POLL_INTERVAL_MS}, ${MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS}].`,
    )
  }
  checkNonEmptyString(config.cron_table_path, 'cron_table_path', style)
  checkNonEmptyString(config.cron_log_path, 'cron_log_path', style)
  checkOptionalPositiveInteger(config.cron_log_max_bytes, 'cron_log_max_bytes', style)
}

/**
 * Today's resolution of the server-wide path settings: `~` expanded and the
 * result made absolute with `path.resolve`. Empty or whitespace
 * `claude_config_dir` and cron paths are kept verbatim so validation rejects
 * them. Defaults from `applyServerDefaults` resolve the same way. Resolves
 * exactly the `SERVER_PATH_SETTINGS` (the `satisfies` keeps the two in step).
 *
 * @param home  Home directory for `~`; the OS home, read only when needed, if omitted.
 */
function resolveServerPaths(settings: ServerSettings, home?: string): Pick<ServerSettings, ServerPathSetting> {
  const expand = (path: string): string => resolve(expandTildeWith(path, home))
  const expandUnlessBlank = (path: string): string => (path.trim() === '' ? path : expand(path))
  const resolved = {
    mcp_config_path: expand(settings.mcp_config_path),
    append_system_prompt_file:
      settings.append_system_prompt_file !== undefined ? expand(settings.append_system_prompt_file) : undefined,
    message_archive_db:
      settings.message_archive_db !== undefined ? expand(settings.message_archive_db) : undefined,
    claude_config_dir:
      settings.claude_config_dir !== undefined ? expandUnlessBlank(settings.claude_config_dir) : undefined,
    cron_table_path:
      typeof settings.cron_table_path === 'string'
        ? expandUnlessBlank(settings.cron_table_path)
        : settings.cron_table_path,
    cron_log_path:
      typeof settings.cron_log_path === 'string'
        ? expandUnlessBlank(settings.cron_log_path)
        : settings.cron_log_path,
  } satisfies Record<ServerPathSetting, unknown>
  return resolved
}

/**
 * Reject top-level keys outside `known` (SR-4.2), naming only the keys that
 * are safe to echo (`describeUnknownKeys`) and never a value. The
 * pre-rename `claude_director_poll_interval_ms` gets a targeted message naming
 * its new name (SR-4.1).
 *
 * Operates on the raw parsed object so we can see fields that would otherwise
 * be dropped by structural casting.
 */
function rejectUnknownTopLevelKeys(
  parsed: Record<string, unknown>,
  known: ReadonlySet<string>,
  style: RuleStyle,
): void {
  const unknown: string[] = []
  for (const key of Object.keys(parsed)) {
    if (known.has(key)) continue
    if (key === RENAMED_POLL_INTERVAL_KEY) {
      throw ruleError(
        style,
        `${RENAMED_POLL_INTERVAL_KEY} has been renamed to agent_director_poll_interval_ms (SR-4.1). Rename the field in config.json — the old name is not accepted as an alias.`,
      )
    }
    unknown.push(key)
  }
  if (unknown.length > 0) {
    throw ruleError(style, `unknown top-level field(s) in config.json: ${describeUnknownKeys(unknown)}.`)
  }
}

/**
 * An unknown key name the loader may echo: ASCII letters and underscores
 * only, at most 48 characters, as every setting name is. Anything else (a
 * digit, a dash, a dot, a space, a longer name) is not echoed: a token or
 * other secret pasted as a key name would otherwise reach the start's log,
 * `config.json.pending` and the reload log lines (b.av2 SR-10.3). Letters
 * only, so a hex or base64 secret, a Slack token (`xoxb-…`) and a
 * `ghp_…`-style token all fail it, while a typo such as `chanels` passes.
 */
export const ECHOABLE_KEY_NAME_RE = /^[A-Za-z_]{1,48}$/

/**
 * Unknown key names for an error, echoing only the names that pass
 * `ECHOABLE_KEY_NAME_RE` (JSON-quoted, comma-separated, in order); the rest
 * are counted, never shown:
 *   `"chanels", "extra"`
 *   `"chanels", plus 1 field whose name is not shown (it is not a plain setting name, so it could be a pasted secret)`
 *   `2 fields whose names are not shown (they are not plain setting names, so they could be pasted secrets)`
 */
export function describeUnknownKeys(keys: readonly string[]): string {
  const shown = keys.filter((k) => ECHOABLE_KEY_NAME_RE.test(k)).map((k) => JSON.stringify(k))
  const hidden = keys.length - shown.length
  if (hidden === 0) return shown.join(', ')
  const count =
    hidden === 1
      ? '1 field whose name is not shown (it is not a plain setting name, so it could be a pasted secret)'
      : `${hidden} fields whose names are not shown (they are not plain setting names, so they could be pasted secrets)`
  return shown.length === 0 ? count : `${shown.join(', ')}, plus ${count}`
}

// ---------------------------------------------------------------------------
// Persona loader: server-wide settings (b.av2 SR-1.6, SR-10.2)
// ---------------------------------------------------------------------------

/** Lookup form of PERSONA_TOP_LEVEL_KEYS. */
const PERSONA_TOP_LEVEL_KEY_SET: ReadonlySet<string> = new Set(PERSONA_TOP_LEVEL_KEYS)

/**
 * Top-level path settings that today's resolution expands without a type
 * check (a non-string there would crash rather than be rejected), so the
 * persona loader checks their type first.
 */
const UNCHECKED_TOP_LEVEL_PATH_KEYS = [
  'mcp_config_path',
  'append_system_prompt_file',
  'message_archive_db',
  'claude_config_dir',
] as const

/** The resolved persona configuration without its personas. */
type PersonaServerSettings = Omit<PersonaConfig, 'personas'>

/**
 * Default, resolve and validate the server-wide settings of a persona-shape
 * object with today's rules (b.av2 SR-1.6): top-level paths keep today's
 * resolution (not the persona path rule), with `~` expanded under `home`,
 * and the cron path defaults sit under `configDir`. Adds the persona-only
 * `ack_reaction`, `reply_chunk_limit` and `reply_chunk_mode`. Errors name the
 * key and the rule, never the rejected value.
 */
function resolvePersonaServerSettings(
  parsed: Record<string, unknown>,
  configDir: string,
  home: string,
): PersonaServerSettings {
  for (const key of UNCHECKED_TOP_LEVEL_PATH_KEYS) {
    const value = parsed[key]
    if (value !== undefined && typeof value !== 'string') {
      throw ruleError(PERSONA_RULE_STYLE, `${key} must be a string when set.`)
    }
  }
  const input = parsed as Partial<PersonaConfigInput>
  const withDefaults = applyServerDefaults(input, configDir)
  const settings: PersonaServerSettings = {
    ...withDefaults,
    ...resolveServerPaths(withDefaults, home),
    ack_reaction: input.ack_reaction,
    reply_chunk_limit: input.reply_chunk_limit ?? DEFAULT_REPLY_CHUNK_LIMIT,
    reply_chunk_mode: input.reply_chunk_mode ?? DEFAULT_REPLY_CHUNK_MODE,
  }
  validatePersonaServerSettings(settings)
  return settings
}

/** The server-wide rules in their fixed order, then the persona-only keys. */
function validatePersonaServerSettings(settings: PersonaServerSettings): void {
  const style = PERSONA_RULE_STYLE
  validateServerTimingsAndModes(settings, style)
  checkOptionalNonEmptyString(settings.claude_config_dir, 'claude_config_dir', style)
  checkBoolean(settings.stop_hook_bootstrap, 'stop_hook_bootstrap', style)
  validateServerPollAndCron(settings, style)
  checkOptionalNonEmptyString(settings.ack_reaction, 'ack_reaction', style)
  checkOptionalPositiveInteger(settings.reply_chunk_limit, 'reply_chunk_limit', style)
  checkAllowedValue(settings.reply_chunk_mode, 'reply_chunk_mode', REPLY_CHUNK_MODES, style)
}

// ---------------------------------------------------------------------------
// Persona loader: persona and channel entries (b.av2 SR-1.2, SR-1.3, SR-1.5)
// ---------------------------------------------------------------------------

/** Top-level values a persona inherits when its entry omits them (b.av2 SR-1.2, SR-10.2). */
interface InheritedPersonaSettings {
  claude_config_dir?: string
  stop_hook_bootstrap: boolean
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON type name of a value, for shape errors that must not echo the value itself. */
function jsonTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Error style for one persona entry. Every message starts with `personas[i]`
 * and, when the name is valid, the persona reference of b.av2 SR-2.2
 * (JSON-quoted name with its key), and never echoes a rejected value.
 */
function personaEntryStyle(name: unknown, index: number): RuleStyle {
  const ref = isNonEmptyString(name) ? ` ${renderPersonaRef(name)}` : ''
  return { prefix: `${PERSONA_ERROR_PREFIX}personas[${index}]${ref}: ` }
}

function rejectUnknownEntryKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  style: RuleStyle,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw ruleError(style, `unknown field(s) in ${where}: ${describeUnknownKeys(unknown)}.`)
}

/**
 * Stage 1 of an entry: the shapes of the `dm` object and the `channels`
 * array and its entries, and unknown keys at every level (key names only,
 * and only those safe to echo: `describeUnknownKeys`).
 */
function checkPersonaEntryShape(entry: Record<string, unknown>, style: RuleStyle): void {
  rejectUnknownEntryKeys(entry, PERSONA_ENTRY_KEYS, 'the persona entry', style)
  const dm = entry['dm']
  if (dm !== undefined) {
    if (!isJsonObject(dm)) throw ruleError(style, `dm must be a JSON object, got ${jsonTypeName(dm)}.`)
    rejectUnknownEntryKeys(dm, PERSONA_DM_KEYS, 'dm', style)
  }
  const channels = entry['channels']
  if (channels === undefined) return
  if (!Array.isArray(channels)) {
    throw ruleError(style, `channels must be an array, got ${jsonTypeName(channels)}.`)
  }
  channels.forEach((channel: unknown, j) => {
    if (!isJsonObject(channel)) {
      throw ruleError(style, `channels[${j}] must be a JSON object, got ${jsonTypeName(channel)}.`)
    }
    rejectUnknownEntryKeys(channel, CHANNEL_ENTRY_KEYS, `channels[${j}]`, style)
  })
}

/**
 * The persona path rule (b.av2 SR-1.2): a string that is absolute, exactly
 * `~`, or starts with `~/`. Returns it tilde-expanded under `home` and made
 * absolute. No file-system access.
 */
function parsePersonaPath(value: unknown, setting: string, home: string, style: RuleStyle): string {
  if (typeof value !== 'string' || !(isAbsolute(value) || value === '~' || value.startsWith('~/'))) {
    throw ruleError(style, `${setting} must be an absolute path, "~" or a path starting with "~/".`)
  }
  return resolve(expandTildeWith(value, home))
}

function requirePersonaPath(entry: Record<string, unknown>, setting: string, home: string, style: RuleStyle): string {
  if (entry[setting] === undefined) throw ruleError(style, `${setting} is required.`)
  return parsePersonaPath(entry[setting], setting, home, style)
}

/** Channel entries (b.av2 SR-1.3): shapes already checked in stage 1. */
function parseChannels(channels: Record<string, unknown>[], style: RuleStyle): ChannelEntry[] {
  const firstIndexById = new Map<string, number>()
  return channels.map((channel, j) => {
    const { id, delivery } = channel
    if (id === undefined) throw ruleError(style, `channels[${j}].id is required.`)
    if (typeof id !== 'string' || !CHANNEL_ID_RE.test(id)) {
      throw ruleError(style, `channels[${j}].id must be a Slack channel ID matching ${CHANNEL_ID_RE.source}.`)
    }
    if (delivery === undefined) throw ruleError(style, `channels[${j}].delivery is required.`)
    checkAllowedValue(delivery, `channels[${j}].delivery`, DELIVERY_MODES, style)
    const first = firstIndexById.get(id)
    if (first !== undefined) {
      throw ruleError(style, `channel ${id} is listed more than once (channels[${first}] and channels[${j}]).`)
    }
    firstIndexById.set(id, j)
    return { id, delivery: delivery as DeliveryMode }
  })
}

/** The `dm` object (b.av2 SR-1.2): shape already checked in stage 1. */
function parseDm(dm: Record<string, unknown> | undefined, style: RuleStyle): PersonaDm {
  const enabled = dm?.['enabled']
  const contact = dm?.['contact']
  if (enabled !== undefined) checkBoolean(enabled, 'dm.enabled', style)
  if (contact === undefined) return { enabled: enabled === true }
  if (typeof contact !== 'string' || !DM_CONTACT_RE.test(contact)) {
    throw ruleError(style, `dm.contact must be a Slack user ID matching ${DM_CONTACT_RE.source}.`)
  }
  return { enabled: enabled === true, contact }
}

function parsePermissionPrompts(value: unknown, style: RuleStyle): string {
  if (value === undefined) {
    throw ruleError(style, `permission_prompts is required: set it to "${DM_DESTINATION}" or one of the persona's channel IDs.`)
  }
  if (value === DM_DESTINATION || (typeof value === 'string' && CHANNEL_ID_RE.test(value))) return value
  throw ruleError(style, `permission_prompts must be "${DM_DESTINATION}" or a Slack channel ID matching ${CHANNEL_ID_RE.source}.`)
}

/**
 * Stage 3 of an entry: the cross-setting rules of b.av2 SR-1.5. Zero channels
 * with DMs off comes first: every destination would otherwise fail one of the
 * later rules, so AC 42 could never be reported. Then a channel destination
 * not among `channels`, then a `dm` destination without `dm.contact` or with
 * `dm.enabled` not true (both named when both are wrong). Values named here
 * (channel IDs) have already passed their format rule.
 */
function checkPersonaCrossSettings(persona: Persona, style: RuleStyle): void {
  const { permission_prompts: destination, channels, dm } = persona
  if (channels.length === 0 && !dm.enabled) {
    throw ruleError(
      style,
      'the persona has no channels and dm.enabled is not true, so it can receive no messages. Add a channel or set dm.enabled to true.',
    )
  }
  if (destination !== DM_DESTINATION && !channels.some((channel) => channel.id === destination)) {
    throw ruleError(style, `permission_prompts names channel ${destination}, which is not in the persona's channels.`)
  }
  if (destination === DM_DESTINATION) {
    const problems: string[] = []
    if (dm.contact === undefined) problems.push('dm.contact is not set')
    if (!dm.enabled) problems.push('dm.enabled is not true')
    if (problems.length > 0) {
      throw ruleError(style, `permission_prompts is "${DM_DESTINATION}" but ${problems.join(' and ')}.`)
    }
  }
}

/**
 * Parse, default and validate one persona entry (b.av2 SR-1.2, SR-1.3 and
 * the per-entry rules of SR-1.5), throwing on the first violation.
 *
 * Check order, so "first violation" is reproducible:
 *   0. the entry is a JSON object;
 *   1. shape and unknown keys: persona entry, `dm`, `channels` and each
 *      channel entry (stage 1);
 *   2. types and formats, in this order: `name`, `credentials_file`,
 *      `working_directory`, `claude_config_dir`, `stop_hook_bootstrap`,
 *      `channels` (in array order: `id`, `delivery`, duplicate ID), `dm.enabled`,
 *      `dm.contact`, `permission_prompts` (required);
 *   3. cross-setting rules (see `checkPersonaCrossSettings`): zero channels
 *      with `dm.enabled` not true, then a destination channel not among
 *      `channels`, then a `dm` destination without `dm.contact` / with
 *      `dm.enabled` not true.
 *
 * Errors name `personas[i]` and, once the name is valid, the persona
 * reference, plus the setting's key path; they never echo a rejected value.
 * Pure: no file-system access, and the OS home is never read (`home` is given).
 */
function parsePersonaEntry(
  raw: unknown,
  index: number,
  inherited: InheritedPersonaSettings,
  home: string,
): Persona {
  if (!isJsonObject(raw)) {
    throw ruleError(PERSONA_RULE_STYLE, `personas[${index}] must be a JSON object, got ${jsonTypeName(raw)}.`)
  }
  const style = personaEntryStyle(raw['name'], index)
  checkPersonaEntryShape(raw, style)

  const name = raw['name']
  if (name === undefined) throw ruleError(style, 'name is required.')
  if (!isNonEmptyString(name)) throw ruleError(style, 'name must be a non-empty string.')
  const credentials_file = requirePersonaPath(raw, 'credentials_file', home, style)
  const working_directory = requirePersonaPath(raw, 'working_directory', home, style)
  const ownConfigDir = raw['claude_config_dir']
  const claude_config_dir =
    ownConfigDir !== undefined
      ? parsePersonaPath(ownConfigDir, 'claude_config_dir', home, style)
      : inherited.claude_config_dir
  const ownStopHook = raw['stop_hook_bootstrap']
  if (ownStopHook !== undefined) checkBoolean(ownStopHook, 'stop_hook_bootstrap', style)
  const channels = parseChannels((raw['channels'] as Record<string, unknown>[] | undefined) ?? [], style)
  const dm = parseDm(raw['dm'] as Record<string, unknown> | undefined, style)
  const permission_prompts = parsePermissionPrompts(raw['permission_prompts'], style)

  const persona: Persona = {
    index,
    name,
    key: personaKey(name),
    credentials_file,
    working_directory,
    channels,
    dm,
    permission_prompts,
    ...(claude_config_dir !== undefined ? { claude_config_dir } : {}),
    stop_hook_bootstrap: (ownStopHook as boolean | undefined) ?? inherited.stop_hook_bootstrap,
  }
  checkPersonaCrossSettings(persona, style)
  return persona
}

// ---------------------------------------------------------------------------
// Persona loader: cross-persona rules (b.av2 SR-1.5)
// ---------------------------------------------------------------------------

/** `personas[i]` plus the persona reference, naming the other persona in a cross-persona error. */
function renderIndexedPersonaRef(persona: Persona): string {
  return `personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}`
}

const UNIQUE_NAMES_HINT = 'Persona names and keys must be unique.'

/**
 * How `later`'s name or key collides with `earlier`'s, as the error text
 * after the later persona's prefix, or undefined when they do not collide.
 * Compared by exact string equality. Names are JSON-quoted; keys are bare
 * (they are drawn from `a-z0-9_` only).
 */
function describeNameKeyCollision(earlier: Persona, later: Persona): string | undefined {
  const other = renderIndexedPersonaRef(earlier)
  if (later.name === earlier.name) {
    return `name ${JSON.stringify(later.name)} is duplicated: ${other} has the same name. ${UNIQUE_NAMES_HINT}`
  }
  if (later.key === earlier.key) {
    return `key ${later.key} is duplicated: ${other} has the same key. ${UNIQUE_NAMES_HINT}`
  }
  if (later.name === earlier.key) {
    return `name ${JSON.stringify(later.name)} equals the key of ${other}. ${UNIQUE_NAMES_HINT}`
  }
  if (later.key === earlier.name) {
    return `key ${later.key} equals the name of ${other}. ${UNIQUE_NAMES_HINT}`
  }
  return undefined
}

/**
 * b.av2 SR-1.5, first row: no persona's name or key (SR-2.1) may equal
 * another persona's name or key. A persona whose own name is its own key
 * does not collide with itself.
 *
 * Order: personas are scanned in array order; the first one whose name or
 * key equals an earlier persona's name or key is reported, against the
 * earliest such persona. Within a pair, a shared name is reported first, then
 * a shared key, then the later name equal to the earlier key, then the later
 * key equal to the earlier name. No file-system access.
 */
function checkUniqueNamesAndKeys(personas: readonly Persona[]): void {
  personas.forEach((later, j) => {
    for (const earlier of personas.slice(0, j)) {
      const collision = describeNameKeyCollision(earlier, later)
      if (collision !== undefined) throw ruleError(personaEntryStyle(later.name, later.index), collision)
    }
  })
}

/** The per-persona paths that no two personas may share (b.av2 SR-1.5), in the order they are checked. */
const UNIQUE_PERSONA_PATH_SETTINGS = ['working_directory', 'credentials_file'] as const

type UniquePersonaPathSetting = (typeof UNIQUE_PERSONA_PATH_SETTINGS)[number]

/**
 * Reject the first persona whose `setting` has the same comparison form
 * (`resolveRealPath`) as an earlier persona's, against the earliest such
 * persona. Persona paths are stored tilde-expanded and `path.resolve`d
 * (`parsePersonaPath`), so `~/x` against its absolute form, a trailing slash
 * or `..` already yield the same string and get the short message. Only when
 * the two stored paths differ, which only a symlink can cause, does the error
 * show both and the shared real path. Paths are the one value these errors
 * echo: they have already passed the persona path rule.
 */
function rejectSharedRealPath(personas: readonly Persona[], setting: UniquePersonaPathSetting): void {
  const firstByRealPath = new Map<string, Persona>()
  for (const persona of personas) {
    const path = persona[setting]
    const realPath = resolveRealPath(path)
    const earlier = firstByRealPath.get(realPath)
    if (earlier === undefined) {
      firstByRealPath.set(realPath, persona)
      continue
    }
    const other = renderIndexedPersonaRef(earlier)
    const why =
      earlier[setting] === path
        ? `${setting} ${JSON.stringify(path)} is also the ${setting} of ${other}.`
        : `${setting} ${JSON.stringify(path)} is also the ${setting} of ${other}: its ${setting} ` +
          `${JSON.stringify(earlier[setting])} and this one both resolve to ${JSON.stringify(realPath)}.`
    throw ruleError(personaEntryStyle(persona.name, persona.index), `${why} Each persona needs its own ${setting}.`)
  }
}

/**
 * The real-path collision step (b.av2 SR-1.5): no two personas may share a
 * `working_directory`, then no two may share a `credentials_file`, each
 * compared by real path with a lexical fallback (`resolveRealPath`), so a
 * symlink to another persona's path, or `~/x` against its absolute form, is a
 * duplicate. Per setting, personas are scanned in array order and the first
 * collision is reported against the earliest persona sharing the path. One
 * persona's working directory against another's credentials file, or a
 * persona's own two paths, is not a collision.
 *
 * Resolves paths only: never requires them to exist and never opens, reads,
 * creates or writes a file. Kept as its own step so a start from the record
 * (E11) can treat these collisions differently without restructuring the
 * loader.
 */
function checkRealPathCollisions(personas: readonly Persona[]): void {
  for (const setting of UNIQUE_PERSONA_PATH_SETTINGS) rejectSharedRealPath(personas, setting)
}

/** How `resolvePersonaConfig` validates. */
export interface ResolvePersonaConfigOptions {
  /**
   * Record mode (b.av2 SR-1.5, record-start part): validate a start's
   * `config.json.last-applied`. Skips only the real-path collision step
   * (step 8): at a start from the record, two personas sharing a
   * `working_directory` or a `credentials_file` are a bring-up failure of each
   * persona involved, not a validation error. Every other rule runs
   * unchanged. Default false.
   */
  record?: boolean
}

// ---------------------------------------------------------------------------
// Persona loader: entry point (b.av2 SR-1.1, SR-1.7)
// ---------------------------------------------------------------------------

/**
 * Resolve an already-parsed persona configuration: apply defaults, expand
 * paths and validate, throwing on the first violation. It resolves persona
 * paths to real paths for the collision rules (step 8) but never opens, reads,
 * creates or writes a file and never requires a path to exist, so the reload
 * path can validate pending content with it.
 *
 * Check order:
 *   1. the value is a JSON object;
 *   2. b.av2 SR-1.7: `routes` (any value), `default_route` or
 *      `default_dm_session` present → the conversion message, before any
 *      other check;
 *   3. unknown top-level keys (key names only, and only plain setting names:
 *      `describeUnknownKeys`; the SR-4.1 rename message);
 *   4. `personas` present and an array (it may be empty);
 *   5. server-wide settings defaulted and validated (b.av2 SR-1.6);
 *   6. each persona entry in array order (see `parsePersonaEntry`),
 *      inheriting the resolved top-level `claude_config_dir` and
 *      `stop_hook_bootstrap`;
 *   7. the cross-persona name/key rule (b.av2 SR-1.5, see
 *      `checkUniqueNamesAndKeys`): no name or key equal to another persona's
 *      name or key;
 *   8. the real-path collision step (b.av2 SR-1.5, see
 *      `checkRealPathCollisions`): no shared `working_directory`, then no
 *      shared `credentials_file`, compared by `resolveRealPath`. Skipped in
 *      record mode (`options.record`).
 *
 * Steps 7 and 8 run only after every entry has parsed, so a per-entry
 * violation anywhere is reported before any cross-persona one.
 *
 * @param raw        The parsed JSON value of the configuration file.
 * @param configDir  Directory of the configuration file; the cron path defaults sit under it.
 * @param home       Home directory for every `~` (persona and top-level paths and the
 *   `mcp_config_path` default). Defaults to the OS home, read at call time only.
 * @param options    Record mode; see `ResolvePersonaConfigOptions`.
 */
export function resolvePersonaConfig(
  raw: unknown,
  configDir: string,
  home: string = homedir(),
  options: ResolvePersonaConfigOptions = {},
): PersonaConfig {
  const style = PERSONA_RULE_STYLE
  if (!isJsonObject(raw)) {
    throw ruleError(style, `the configuration must be a JSON object, got ${jsonTypeName(raw)}.`)
  }
  for (const key of PRE_PERSONA_KEYS) {
    if (Object.hasOwn(raw, key)) throw ruleError(style, prePersonaConversionMessage(key))
  }
  rejectUnknownTopLevelKeys(raw, PERSONA_TOP_LEVEL_KEY_SET, style)

  const entries = raw['personas']
  if (entries === undefined) {
    throw ruleError(style, 'personas is required: an array of persona entries, which may be empty.')
  }
  if (!Array.isArray(entries)) {
    throw ruleError(style, `personas must be an array, got ${jsonTypeName(entries)}.`)
  }

  const settings = resolvePersonaServerSettings(raw, configDir, home)
  const inherited: InheritedPersonaSettings = {
    claude_config_dir: settings.claude_config_dir,
    stop_hook_bootstrap: settings.stop_hook_bootstrap,
  }
  const personas = entries.map((entry: unknown, index) => parsePersonaEntry(entry, index, inherited, home))

  // Cross-persona rules (b.av2 SR-1.5), only once every entry has parsed so
  // per-entry violations are reported first.
  checkUniqueNamesAndKeys(personas)
  if (options.record !== true) checkRealPathCollisions(personas)

  return { ...settings, personas }
}

// ---------------------------------------------------------------------------
// Server paths (b.av2 SR-1.1, SR-8.7)
// ---------------------------------------------------------------------------

/**
 * The server's state directory: `SLACK_STATE_DIR` (made absolute) when it is
 * set and non-empty, otherwise `<home>/.claude/channels/slack`. The variable
 * and the home directory are read at call time, never at import.
 *
 * @param home  Home directory; defaults to the OS home, read only when needed.
 * @param env   Environment to read `SLACK_STATE_DIR` from; defaults to `process.env`.
 */
export function resolveServerStateDir(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[STATE_DIR_ENV]
  if (fromEnv) return resolve(fromEnv)
  return join(home ?? homedir(), '.claude', 'channels', 'slack')
}

/**
 * The configuration file the server loads (b.av2 SR-1.1): `config.json` in
 * the state directory (`resolveServerStateDir`). With `SLACK_STATE_DIR` unset
 * this is `~/.claude/channels/slack/config.json`. The one definition of the
 * location: the server and the CLI both use it. Computed at call time.
 *
 * @param home  Home directory; defaults to the OS home, read only when needed.
 * @param env   Environment to read `SLACK_STATE_DIR` from; defaults to `process.env`.
 */
export function resolveServerConfigPath(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveServerStateDir(home, env), CONFIG_FILE_NAME)
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

/**
 * `PersonaConfigReadError.code` for a path that exists but is not a regular
 * file (a FIFO, socket or device, after following symlinks). Not an errno
 * code: worded so that the start's "cannot be read (<code>)" reads as the
 * reason.
 */
export const CONFIG_NOT_REGULAR_FILE_CODE = 'not a regular file'

/**
 * The largest file the shared readers read, in bytes (64 KiB): the persona
 * configuration file, the last-applied record, `config.json.pending` and
 * `config.json.apply` (`readPersonaConfigBytes`), and a credentials file
 * (`readCredentialsFile` in `persona-credentials.ts`). A larger file is
 * refused as unreadable and never read past `MAX_RELOAD_FILE_BYTES + 1`
 * bytes. No legitimate file comes near it; the cap bounds the memory and
 * hashing work a file grown by mistake could cost. Applied in the readers
 * rather than by one caller, so the start, the bring-up and the reload tick
 * see the same outcome (and the same credentials digest marker) for one file.
 * One read is exempt: the SR-5.2 file guard's read of the configuration file
 * (`credentialsFilesToProtect`, `readPersonaConfigBytes` with `uncapped`).
 */
export const MAX_RELOAD_FILE_BYTES = 64 * 1024

/** `MAX_RELOAD_FILE_BYTES` as worded in messages: `64 KiB`. */
export const MAX_RELOAD_FILE_SIZE_TEXT = `${MAX_RELOAD_FILE_BYTES / 1024} KiB`

/**
 * The code of a read refused because the file is larger than
 * `MAX_RELOAD_FILE_BYTES` (`PersonaConfigReadError.code`). An errno name, so
 * it passes the safe-code check wherever a code is echoed; messages word it
 * as "larger than the 64 KiB limit" rather than echoing the bare code.
 */
export const FILE_TOO_LARGE_CODE = 'EFBIG'

/**
 * Read at most `maxBytes` bytes from the start of the file behind an open
 * descriptor, stopping at end of file. Never reads more than `maxBytes`, so a
 * file that is larger (or grows while it is read) costs at most that much.
 * Returns a buffer of exactly the bytes read. Throws an errno-style error
 * (with `code`) on failure. The real-fs bounded read of both shared readers;
 * `maxBytes` defaults to one byte more than the readers' limit. A `maxBytes`
 * of `Infinity` is the one unbounded read: the whole file, to end of file
 * (`readPersonaConfigBytes` with `uncapped`).
 */
export function readFdAtMost(fd: number, maxBytes: number = MAX_RELOAD_FILE_BYTES + 1): Buffer {
  if (maxBytes === Infinity) return readFileSync(fd)
  const scratch = Buffer.alloc(maxBytes)
  let filled = 0
  while (filled < maxBytes) {
    const n = readSync(fd, scratch, filled, maxBytes - filled, filled)
    if (n === 0) break
    filled += n
  }
  return Buffer.from(scratch.subarray(0, filled))
}

/**
 * `readPersonaConfigBytes` could not read the file (missing, unreadable, a
 * directory, not a regular file, larger than the limit, …). The message names
 * the path; `code` is the errno code when the read error carried a safe one
 * (`EISDIR` for a directory), `FILE_TOO_LARGE_CODE` for a file larger than
 * `MAX_RELOAD_FILE_BYTES`, or `CONFIG_NOT_REGULAR_FILE_CODE` for a FIFO,
 * socket or device.
 */
export class PersonaConfigReadError extends Error {
  readonly code: string | undefined

  constructor(message: string, code: string | undefined) {
    super(message)
    this.name = 'PersonaConfigReadError'
    this.code = code
  }
}

/**
 * The file-system calls `readPersonaConfigBytes` makes. The real file system
 * (`DEFAULT_PERSONA_CONFIG_FS`) is the default; callers may override any
 * subset. Tests use it to simulate a FIFO or a device (`fstatFile` reporting
 * neither a file nor a directory) or a failing open or read (throw an
 * errno-style error with `code`) without creating one.
 */
export interface PersonaConfigFs {
  /**
   * Open the path read-only and non-blocking (`O_RDONLY | O_NONBLOCK`,
   * following symlinks), so opening a FIFO never waits for a writer. Returns
   * the descriptor. Throws an errno-style error (with `code`) on failure.
   */
  openFile(path: string): number
  /**
   * Stat an open descriptor. `size` is the file's size in bytes; the reader
   * refuses a file larger than `MAX_RELOAD_FILE_BYTES` before reading it. An
   * override may omit `size`: the bounded read (`readFileFd`) enforces the
   * limit either way. Throws an errno-style error (with `code`) on failure.
   */
  fstatFile(fd: number): { isFile(): boolean; isDirectory(): boolean; size?: number }
  /**
   * Read at most `maxBytes` bytes from the start of the file behind an open
   * descriptor (`readFdAtMost`). The reader asks for one byte more than the
   * limit, so it can tell a file over the limit (even one that grew after the
   * stat) and never reads the rest. An override that returns more than
   * `maxBytes` bytes is still refused as over the limit. `maxBytes` defaults
   * to `MAX_RELOAD_FILE_BYTES + 1`, so a caller that omits it still gets a
   * bounded read. An uncapped read (`ReadPersonaConfigBytesOptions.uncapped`)
   * passes `Infinity`: read the whole file. Throws an errno-style error (with
   * `code`) on failure.
   */
  readFileFd(fd: number, maxBytes?: number): Buffer
  /** Close a descriptor opened by `openFile`. A failure is ignored. */
  closeFile(fd: number): void
}

/** How `readPersonaConfigBytes` reads. */
export interface ReadPersonaConfigBytesOptions {
  /**
   * Read the whole file, with no `MAX_RELOAD_FILE_BYTES` cap. Only the SR-5.2
   * file guard's read (`credentialsFilesToProtect`) sets it; every other
   * caller stays capped. Stat-first is unchanged: a directory or a
   * non-regular file is still refused and never read.
   */
  uncapped?: boolean
}

/** The real file system for `readPersonaConfigBytes`, looked up at call time. */
export const DEFAULT_PERSONA_CONFIG_FS: PersonaConfigFs = {
  openFile: (path) => openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK),
  fstatFile: (fd) => fstatSync(fd),
  readFileFd: (fd, maxBytes) => readFdAtMost(fd, maxBytes),
  closeFile: (fd) => closeSync(fd),
}

/** How `parsePersonaConfigBytes` resolves and validates. */
export interface ParsePersonaConfigBytesOptions extends ResolvePersonaConfigOptions {
  /** Home directory for every `~`; defaults to the OS home, read at call time only. */
  home?: string
}

/**
 * The malformed-JSON error for `text`: names `source` and where the text
 * first stops being JSON, and echoes none of it (b.av2 SR-10.3).
 */
function malformedJsonMessage(text: string, source: string): string {
  const offset = jsonSyntaxErrorOffset(text)
  // `JSON.parse` failed, so the scan finds an offset; without one (never
  // expected) the message names no position rather than a wrong one.
  if (offset === undefined) return `loadPersonaConfig: malformed JSON in "${source}".`
  const { line, column } = positionAt(text, offset)
  return `loadPersonaConfig: malformed JSON in "${source}" at line ${line}, column ${column}.`
}

/**
 * Parse and validate a persona configuration from the exact bytes (or text)
 * that were read, so the bytes that get recorded or applied are the bytes
 * that were checked (b.av2 SR-8.7). The one JSON-parse path of the persona
 * loader: `loadPersonaConfig` reads a file and delegates here, and the
 * start's record and configuration file are validated here from bytes read
 * once.
 *
 * Errors name `source` (the file the bytes came from):
 * - malformed JSON: `loadPersonaConfig: malformed JSON in "<source>" at line
 *   <L>, column <C>.`, a 1-based position of the first invalid character and
 *   none of the parser's text, which can quote file content such as a pasted
 *   token (b.av2 SR-10.3);
 * - any validation failure: `loadPersonaConfig: invalid persona config in
 *   "<source>": <cause>` (see `resolvePersonaConfig`).
 *
 * Bytes are decoded as UTF-8 exactly as `readFileSync(path, 'utf-8')` does
 * (a byte order mark is kept, and rejected by the parser). Free of side
 * effects: never reads, writes or creates a file, and never reads a
 * credentials file.
 *
 * @param bytes      The configuration's bytes, or its text.
 * @param source     The path to name in errors; used only as a label.
 * @param configDir  Directory of the configuration file; the cron path defaults sit under it.
 * @param options    `home` for `~`, and record mode (`ResolvePersonaConfigOptions`).
 */
export function parsePersonaConfigBytes(
  bytes: Uint8Array | string,
  source: string,
  configDir: string,
  options: ParsePersonaConfigBytesOptions = {},
): PersonaConfig {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(malformedJsonMessage(text, source))
  }

  try {
    return resolvePersonaConfig(parsed, configDir, options.home, { record: options.record })
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`loadPersonaConfig: invalid persona config in "${source}": ${cause}`)
  }
}

/**
 * Read a persona configuration file's bytes once. A read failure is a
 * `PersonaConfigReadError` naming the path, with the errno code when the
 * error carried a safe one.
 *
 * Stat-first, as `checkPersonaCredentials` reads a credentials file: the file
 * is opened once, read-only and non-blocking, its descriptor is stat'ed, and
 * only a regular file is read, through the same descriptor (so the file
 * checked is the file read). A directory fails with `EISDIR`; any other
 * non-regular file (a FIFO, socket or device, after following symlinks) fails
 * with `CONFIG_NOT_REGULAR_FILE_CODE` and is never read: a FIFO would block
 * the read forever and a device such as `/dev/zero` would never end.
 *
 * Size cap: a regular file larger than `MAX_RELOAD_FILE_BYTES` (64 KiB) fails
 * with `FILE_TOO_LARGE_CODE`, worded "larger than the 64 KiB limit" and
 * carrying no file content. It is refused on the stat's size before any read,
 * and the read itself is bounded (at most `MAX_RELOAD_FILE_BYTES + 1` bytes),
 * so a file that grows after the stat, or a stat that under-reports, is still
 * refused and never read in full.
 *
 * The one exception is `options.uncapped`, set only by the SR-5.2 file guard
 * (`credentialsFilesToProtect`): the file guard must never protect fewer
 * credentials files because the configuration file grew past the cap, so
 * that read has no size limit and reads the whole file (stat-first still
 * applies). Every other caller (the start, the record, the pending and apply
 * files, the reload tick) is capped.
 *
 * @param configPath  Absolute path of the file.
 * @param fs          File-system overrides; unset operations use `DEFAULT_PERSONA_CONFIG_FS`.
 * @param options     `uncapped` for the file guard's read only.
 */
export function readPersonaConfigBytes(
  configPath: string,
  fs?: Partial<PersonaConfigFs>,
  options: ReadPersonaConfigBytesOptions = {},
): Buffer {
  const io: PersonaConfigFs = { ...DEFAULT_PERSONA_CONFIG_FS, ...fs }
  const failure = (cause: string, code: string | undefined) =>
    new PersonaConfigReadError(`loadPersonaConfig: cannot read persona config at "${configPath}": ${cause}`, code)
  const errnoFailure = (err: unknown) => failure(err instanceof Error ? err.message : String(err), readErrnoCode(err))
  const tooLarge = () => failure(`it is larger than the ${MAX_RELOAD_FILE_SIZE_TEXT} limit`, FILE_TOO_LARGE_CODE)

  let fd: number
  try {
    fd = io.openFile(configPath)
  } catch (err) {
    throw errnoFailure(err)
  }
  try {
    let stats: ReturnType<PersonaConfigFs['fstatFile']>
    try {
      stats = io.fstatFile(fd)
    } catch (err) {
      throw errnoFailure(err)
    }
    if (stats.isDirectory()) throw failure('it is a directory', 'EISDIR')
    if (!stats.isFile()) throw failure(`it is ${CONFIG_NOT_REGULAR_FILE_CODE}`, CONFIG_NOT_REGULAR_FILE_CODE)
    const uncapped = options.uncapped === true
    if (!uncapped && typeof stats.size === 'number' && stats.size > MAX_RELOAD_FILE_BYTES) throw tooLarge()
    let bytes: Buffer
    try {
      bytes = io.readFileFd(fd, uncapped ? Infinity : MAX_RELOAD_FILE_BYTES + 1)
    } catch (err) {
      throw errnoFailure(err)
    }
    if (!uncapped && bytes.length > MAX_RELOAD_FILE_BYTES) throw tooLarge()
    return bytes
  } finally {
    try {
      io.closeFile(fd)
    } catch {
      // Nothing to report: the descriptor is gone either way.
    }
  }
}

/**
 * Reads a persona configuration file once, parses it and returns the
 * validated PersonaConfig (`parsePersonaConfigBytes` in default mode, over the
 * bytes read). Read, parse and validation failures are rethrown naming the
 * path; a read failure is a `PersonaConfigReadError`.
 *
 * Read-only (b.av2 SR-1.7, AC 45): the file is opened for reading only and
 * nothing is ever written, renamed, created or converted. A malformed-JSON
 * error gives the line and column and omits the parser's detail, which can
 * quote file content such as a pasted token (b.av2 SR-10.3).
 *
 * @param path  Path to the configuration file; `~` is expanded under `home`.
 * @param home  Home directory for every `~`; defaults to the OS home, read at call time only.
 */
export function loadPersonaConfig(path: string, home?: string): PersonaConfig {
  const configPath = resolve(expandTildeWith(path, home))
  return parsePersonaConfigBytes(readPersonaConfigBytes(configPath), configPath, dirname(configPath), { home })
}

/** errno codes meaning the configuration file does not exist (ENOTDIR: an ancestor is not a directory). */
const MISSING_CONFIG_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/** Whether a read error's errno code means the file does not exist. */
export function isMissingConfigCode(code: string | undefined): boolean {
  return code !== undefined && MISSING_CONFIG_CODES.has(code)
}

/**
 * What is wrong with a file `readPersonaConfigBytes` could not read, as the
 * predicate after the file's name: `does not exist`, `is larger than the 64
 * KiB limit` (`FILE_TOO_LARGE_CODE`), or `cannot be read` with the code in
 * parentheses when there is one. Carries no file content. The one wording of
 * a read failure for the start, the reload tick's invalid candidate and any
 * other message that names a configuration, record, pending or apply file.
 */
export function configReadFailurePredicate(code: string | undefined): string {
  if (isMissingConfigCode(code)) return 'does not exist'
  if (code === FILE_TOO_LARGE_CODE) return `is larger than the ${MAX_RELOAD_FILE_SIZE_TEXT} limit`
  return `cannot be read${code !== undefined ? ` (${code})` : ''}`
}

/**
 * The start's message for a configuration file it cannot read (b.av2 SR-8.7):
 * names the path, says whether it does not exist, is larger than the 64 KiB
 * limit or cannot be read (with the errno code), and that the server requires
 * the configuration file to start.
 */
export function configFileReadFailureMessage(configPath: string, code: string | undefined): string {
  return `The configuration file "${configPath}" ${configReadFailurePredicate(code)}. The server requires the configuration file to start.`
}

/** An errno code that is safe to echo: `E` plus upper-case letters and digits. */
const SAFE_ERRNO_CODE_RE = /^E[A-Z0-9]+$/

/** The `code` of an errno-style error when it is a safe errno identifier. */
function readErrnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && SAFE_ERRNO_CODE_RE.test(code) ? code : undefined
}
