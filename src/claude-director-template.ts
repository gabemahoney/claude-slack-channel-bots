/**
 * claude-director-template.ts — TOML template writer for claude-director.
 *
 * Exports three pieces:
 *   1. serializeTemplate  — pure TOML string builder (DE1)
 *   2. buildTemplateInput — in-memory object builder from RoutingConfig (DE2)
 *   3. writeTemplate      — composer: build + serialize + atomic write (DE3)
 *
 * No new runtime dependency is added; TOML is hand-rolled for the narrow
 * fixed shape this module emits.
 *
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type RoutingConfig } from './config.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// DE1: Types + TOML serializer
// ---------------------------------------------------------------------------

/**
 * Typed shape of the claude-director template.
 * The serializer is the authority on which fields appear in the file;
 * unknown extra properties on the input are not emitted.
 */
export interface TemplateInput {
  relay_mode: string
  labels: Record<string, string>
  permissions: { deny: string[] }
  claude_args: string[]
  extra_env?: Record<string, string>
}

/** Options accepted by serializeTemplate. */
export interface SerializeOptions {
  /**
   * ISO-8601 timestamp injected into the `# Written:` header line.
   * Defaults to `new Date().toISOString()` when omitted.
   * Inject a fixed string in tests for deterministic output.
   */
  writtenAt?: string
}

// ---------------------------------------------------------------------------
// TOML escaping helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string value per TOML basic-string rules.
 * Handles: `\`, `"`, and C0 control characters (0x00–0x1F) + DEL (0x7F).
 */
function escapeTomlString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\x00/g, '\\u0000')
    .replace(/\x01/g, '\\u0001')
    .replace(/\x02/g, '\\u0002')
    .replace(/\x03/g, '\\u0003')
    .replace(/\x04/g, '\\u0004')
    .replace(/\x05/g, '\\u0005')
    .replace(/\x06/g, '\\u0006')
    .replace(/\x07/g, '\\u0007')
    .replace(/\x08/g, '\\b')
    .replace(/\x09/g, '\\t')
    .replace(/\x0a/g, '\\n')
    .replace(/\x0b/g, '\\u000b')
    .replace(/\x0c/g, '\\f')
    .replace(/\x0d/g, '\\r')
    .replace(/\x0e/g, '\\u000e')
    .replace(/\x0f/g, '\\u000f')
    .replace(/\x10/g, '\\u0010')
    .replace(/\x11/g, '\\u0011')
    .replace(/\x12/g, '\\u0012')
    .replace(/\x13/g, '\\u0013')
    .replace(/\x14/g, '\\u0014')
    .replace(/\x15/g, '\\u0015')
    .replace(/\x16/g, '\\u0016')
    .replace(/\x17/g, '\\u0017')
    .replace(/\x18/g, '\\u0018')
    .replace(/\x19/g, '\\u0019')
    .replace(/\x1a/g, '\\u001a')
    .replace(/\x1b/g, '\\u001b')
    .replace(/\x1c/g, '\\u001c')
    .replace(/\x1d/g, '\\u001d')
    .replace(/\x1e/g, '\\u001e')
    .replace(/\x1f/g, '\\u001f')
    .replace(/\x7f/g, '\\u007f')
}

/** Wrap an escaped value in double quotes. */
function tomlStr(s: string): string {
  return `"${escapeTomlString(s)}"`
}

/**
 * Emit a TOML inline table: `{ k1 = "v1", k2 = "v2" }`
 */
function tomlInlineTable(record: Record<string, string>): string {
  const pairs = Object.entries(record)
    .map(([k, v]) => `${k} = ${tomlStr(v)}`)
    .join(', ')
  return `{ ${pairs} }`
}

/**
 * Emit a TOML inline table with a single array-of-strings value:
 * `{ deny = ["AskUserQuestion"] }`
 */
function tomlInlineTableWithStringArray(key: string, arr: string[]): string {
  const items = arr.map(tomlStr).join(', ')
  return `{ ${key} = [${items}] }`
}

/**
 * Emit a TOML array of strings on one line: `["a", "b", "c"]`
 */
function tomlStringArray(arr: string[]): string {
  return `[${arr.map(tomlStr).join(', ')}]`
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Pure function: takes a TemplateInput and returns a TOML string.
 *
 * Emits exactly the five fields defined in TemplateInput, in this order:
 *   relay_mode, labels, permissions, claude_args, extra_env (only when non-empty).
 * No unknown extra fields are emitted.
 *
 * The output begins with a two-line managed-file header and ends with a
 * trailing newline.
 */
export function serializeTemplate(input: TemplateInput, opts?: SerializeOptions): string {
  const writtenAt = opts?.writtenAt ?? new Date().toISOString()

  const lines: string[] = [
    '# Managed by claude-slack-channel-bots — do not edit by hand.',
    `# Written: ${writtenAt}`,
    '',
    `relay_mode = ${tomlStr(input.relay_mode)}`,
    `labels = ${tomlInlineTable(input.labels)}`,
    `permissions = ${tomlInlineTableWithStringArray('deny', input.permissions.deny)}`,
    `claude_args = ${tomlStringArray(input.claude_args)}`,
  ]

  if (input.extra_env !== undefined && Object.keys(input.extra_env).length > 0) {
    lines.push(`extra_env = ${tomlInlineTable(input.extra_env)}`)
  }

  lines.push('') // trailing newline
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// DE2: Template object builder
// ---------------------------------------------------------------------------

/**
 * Injection points for buildTemplateInput (primarily for testing).
 */
export interface BuildTemplateInputDeps {
  /**
   * Substitute for `fs.accessSync`. Receives (path, mode) and should throw if
   * the file is not accessible. Tests can inject a controlled stub.
   */
  accessSync?: (path: string, mode?: number) => void
  /**
   * Substitute for `process.stderr.write`. Receives the full line string
   * (without a trailing newline — the implementation appends one).
   * Tests can capture or suppress the diagnostic message.
   */
  stderrWrite?: (msg: string) => void
}

/**
 * Build the in-memory TemplateInput object from a resolved RoutingConfig.
 *
 * NOTE — deliberate departure from src/session-manager.ts:
 *   session-manager.ts omits `--dangerously-load-development-channels` when
 *   SLACK_DRY_RUN is set (that flag requires OAuth which is unavailable in
 *   Docker/CI). The template is a *per-installation* artifact consumed by
 *   claude-director, not a per-spawn command line. Dry-run is a CSCB testing
 *   concern; claude-director always runs in production mode. Therefore the
 *   template ALWAYS includes `--dangerously-load-development-channels`.
 *
 * @param routingConfig  Fully resolved config (mcp_config_path already absolute).
 * @param deps           Optional injection points for testing.
 */
export function buildTemplateInput(
  routingConfig: RoutingConfig,
  deps?: BuildTemplateInputDeps,
): TemplateInput {
  const accessSyncFn = deps?.accessSync ?? fs.accessSync
  const stderrWriteFn =
    deps?.stderrWrite ?? ((msg: string) => process.stderr.write(msg + '\n'))

  const claude_args: string[] = [
    '--dangerously-load-development-channels',
    'server:slack-channel-router',
    '--mcp-config',
    routingConfig.mcp_config_path,
  ]

  // Conditionally append --append-system-prompt-file:
  //   1. system_prompt_mode must be "append"  (short-circuit first — skip accessSync otherwise)
  //   2. append_system_prompt_file must be defined
  //   3. the file must be readable (accessSync R_OK)
  if (
    routingConfig.system_prompt_mode === 'append' &&
    routingConfig.append_system_prompt_file !== undefined
  ) {
    const filePath = routingConfig.append_system_prompt_file
    try {
      accessSyncFn(filePath, fs.constants.R_OK)
      claude_args.push('--append-system-prompt-file', filePath)
    } catch {
      // File is not readable — omit the flag and emit a mandatory diagnostic.
      stderrWriteFn(
        `[slack] template: append_system_prompt_file not readable, omitting flag: ${filePath}`,
      )
    }
  }

  return {
    relay_mode: 'on',
    labels: { service: 'cscb' },
    permissions: { deny: ['AskUserQuestion'] },
    claude_args,
    // extra_env is intentionally absent: no installation-wide env-var source
    // exists in the config schema today. Extend via a future T-B subtask if needed.
  }
}

// ---------------------------------------------------------------------------
// DE3: Composer + atomic writer
// ---------------------------------------------------------------------------

/**
 * Injection points for writeTemplate (primarily for testing).
 * Extends BuildTemplateInputDeps with I/O and path overrides.
 */
export interface WriteTemplateDeps extends BuildTemplateInputDeps {
  /**
   * Override the resolved templates directory.
   * When supplied, `os.homedir()` is NOT consulted — the value is used verbatim.
   * Tests should pass a `mkdtempSync` temp dir here to avoid touching
   * `~/.claude-director/templates/`.
   */
  templatesDir?: string
  /**
   * Inject a fixed ISO-8601 timestamp for deterministic test output.
   * Passed through to serializeTemplate's `opts.writtenAt`.
   */
  writtenAt?: string
  /**
   * Override `recordStartupError`. Tests can capture calls instead of writing
   * to the real startup-errors log.
   */
  recordStartupError?: typeof recordStartupError
  /**
   * Override `process.exit`. Tests can capture the exit code instead of
   * terminating the process.
   */
  processExit?: (code: number) => never
}

/** Filename of the template on disk. */
const TEMPLATE_FILENAME = 'slack-channel-bot.toml'

/**
 * Build, serialize, and atomically write the claude-director template to
 * `~/.claude-director/templates/slack-channel-bot.toml`.
 *
 * Directory is created with mode 0o700 (only newly-created dirs are affected;
 * existing directories are left untouched by the `recursive: true` option).
 *
 * On any error from mkdir / serialize / writeFileSync / renameSync:
 *   - Records a T-A startup error with class label "template-write".
 *   - Calls process.exit(1).
 *
 * @param routingConfig  Fully resolved routing config.
 * @param deps           Optional injection points for testing.
 */
export function writeTemplate(routingConfig: RoutingConfig, deps?: WriteTemplateDeps): void {
  const recordErr = deps?.recordStartupError ?? recordStartupError
  const exitFn = deps?.processExit ?? ((code: number) => process.exit(code) as never)

  // Resolve templates directory: injection point first, then canonical path.
  const templatesDir =
    deps?.templatesDir ?? path.join(os.homedir(), '.claude-director', 'templates')

  const tomlPath = path.join(templatesDir, TEMPLATE_FILENAME)
  const tomlPathTmp = `${tomlPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`

  try {
    // 1. Ensure directory exists (idempotent; mode only applied to new dirs).
    fs.mkdirSync(templatesDir, { recursive: true, mode: 0o700 })

    // 2. Build template object.
    const input = buildTemplateInput(routingConfig, deps)

    // 3. Serialize to TOML string.
    const body = serializeTemplate(input, { writtenAt: deps?.writtenAt })

    // 4. Atomic write: write to .tmp then rename.
    fs.writeFileSync(tomlPathTmp, body, 'utf-8')
    fs.renameSync(tomlPathTmp, tomlPath)
  } catch (err) {
    const message = `template-write failed for ${tomlPath}: ${err instanceof Error ? err.message : String(err)}`
    recordErr('template-write', message, err)
    exitFn(1)
  }
}
