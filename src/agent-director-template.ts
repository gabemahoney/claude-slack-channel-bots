/**
 * agent-director-template.ts — SR-3.2 boot-time template install, and its
 * apply-time refresh (b.av2 SR-8.6 step 5).
 *
 * Builds the SR-3.1 `MakeTemplateParams` from the resolved PersonaConfig and calls
 * `client.makeTemplate({ ..., overwrite: true })`, giving us "ensure
 * post-state" semantics — the slack-channel-bot template exists with
 * the right contents after every boot, regardless of prior state.
 *
 * Atomic replacement is the library's responsibility (sibling-tempfile +
 * rename(2), shipped in agent-director v0.4.3).
 *
 * On any rejection — `ErrTemplateMalformed`, `ErrTemplateNameUnsafe`, any
 * other `AgentDirectorError`, or a non-typed throw — the boot install records
 * a fatal startup error and exits non-zero. The template is load-bearing.
 *
 * The refresh (`refreshSlackChannelBotTemplate`) rewrites the same template
 * after a confirmed configuration change whose set of effective config
 * directories changed (the reload apply runs it only then, from the change
 * plan's `configDirsChanged`). Only the memory-read `allow` rules follow the
 * new persona set; every other field, the server-wide `claude_args`
 * included, is what the boot install wrote (they take effect at the next
 * start). A rejection is logged in one line and is not fatal, and nothing
 * retries it: the rules stay as last installed until the next refresh or
 * start.
 *
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { posix as pathPosix } from 'node:path'
import type { MakeTemplateParams, MakeTemplateResult } from 'agent-director'

import {
  AgentDirectorError,
} from './agent-director-errors.ts'
import { getClient, DEFAULT_TEMPLATE_NAME } from './agent-director-client.ts'
import { recordStartupError } from './startup-errors.ts'
import type { PersonaConfig } from './config.ts'
import { effectiveClaudeConfigDirs } from './persona-identity.ts'
import { describeThrownValue, isSafeIdentifier } from './persona-connection-errors.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

// ---------------------------------------------------------------------------
// Injectable dependency surface
// ---------------------------------------------------------------------------

export interface TemplateInstallDeps {
  /** Hook that returns the live singleton Client. */
  getClient: () => unknown
  /** R_OK readability probe for the append-system-prompt file. */
  accessSync: (path: string, mode?: number) => void
  /** Hook for diagnostic stderr lines (single line, no trailing newline appended). */
  stderrWrite: (msg: string) => void
  /** Startup-error sink (same shape as recordStartupError). */
  recordStartupError: typeof recordStartupError
  /** Process exit hook. */
  exit: (code: number) => never
}

const prodDeps: TemplateInstallDeps = {
  getClient: () => getClient(),
  accessSync: (p, mode) => fs.accessSync(p, mode),
  stderrWrite: (msg) => {
    try {
      process.stderr.write(msg + '\n')
    } catch {
      // best-effort diagnostic; never escalate
    }
  },
  recordStartupError,
  exit: (code) => process.exit(code),
}

function mergeDeps(overrides?: Partial<TemplateInstallDeps>): TemplateInstallDeps {
  return overrides ? { ...prodDeps, ...overrides } : prodDeps
}

// ---------------------------------------------------------------------------
// b.fae F5 — memory-read allow-rule derivation
// ---------------------------------------------------------------------------

/**
 * b.fae F5 — derive the distinct effective Claude config directories across all
 * personas and emit one memory-subdir Read allow rule per dir (the emitted rule
 * is `Read(//<abs-config-dir>/projects/[STAR]/memory/[STARSTAR])`, scoped to
 * the per-project memory subdirectory only — see the security note at the call
 * site for why the config-dir root is deliberately excluded).
 *
 * Each persona contributes its effective `claude_config_dir` (per-persona,
 * else top-level — already resolved on the `Persona`), the directory
 * session-manager.ts buildSpawnParams exports as `CLAUDE_CONFIG_DIR` at spawn
 * time. When a persona has none, no `CLAUDE_CONFIG_DIR` is exported and
 * Claude Code falls back to its own default config dir, `~/.claude` — so that
 * same default must appear here (`resolveClaudeConfigDir`, built from the
 * home directory at call time, not hardcoded), or a subscription-seat persona
 * that relies on the default would get no rule.
 *
 * Persona config dirs are already tilde-expanded and absolute (config.ts), so
 * no `~` can leak into the emitted rule; the default is likewise absolute. The
 * emitted rule uses Claude Code's `//` absolute-path anchor.
 *
 * The set is de-duplicated and sorted, so N personas sharing one config dir
 * yield one rule.
 *
 * @param home  Home directory for the default; the OS home, read at call time.
 */
export function deriveMemoryReadAllowRules(personaConfig: PersonaConfig, home: string = homedir()): string[] {
  // `effectiveClaudeConfigDirs` also carries the guard: a config with zero
  // personas still gets the default-dir rule, matching the spawn-time fallback
  // for any persona that would use the default.
  return effectiveClaudeConfigDirs(personaConfig.personas, home).map((dir) => {
    // `dir` is an absolute POSIX path (leading `/`). Claude Code's absolute
    // anchor is `//<abs-without-leading-slash>`, i.e. exactly two leading
    // slashes total — so join first, then strip the single leading slash and
    // re-prefix `//`.
    const abs = pathPosix.join(dir, 'projects/*/memory/**')
    return `Read(//${abs.replace(/^\/+/, '')})`
  })
}

// ---------------------------------------------------------------------------
// SR-3.1 params builder
// ---------------------------------------------------------------------------

/**
 * Build the `MakeTemplateParams` for the slack-channel-bot template per
 * SR-3.1. Exported for direct testing.
 *
 * Always includes `--dangerously-load-development-channels` in `claude_args`:
 * the template is a per-installation artifact owned by agent-director; CSCB's
 * dry-run mode is a CSCB-side testing concern that does not propagate to AD.
 * (Session-manager spawn-time logic that omits this flag in dry-run is its
 * own decision and is unchanged in Epic 1.)
 *
 * Conditionally appends `--append-system-prompt-file <path>` when
 * `system_prompt_mode === 'append'` and the path is R_OK-readable. An
 * unreadable path produces a single stderr warning and the flag is omitted.
 */
export function buildTemplateParams(
  personaConfig: PersonaConfig,
  deps?: Partial<TemplateInstallDeps>,
): MakeTemplateParams {
  const d = mergeDeps(deps)

  const claude_args: string[] = [
    '--dangerously-load-development-channels',
    'server:slack-channel-router',
    '--mcp-config',
    personaConfig.mcp_config_path,
  ]

  if (
    personaConfig.system_prompt_mode === 'append' &&
    personaConfig.append_system_prompt_file !== undefined
  ) {
    const filePath = personaConfig.append_system_prompt_file
    try {
      d.accessSync(filePath, fs.constants.R_OK)
      claude_args.push('--append-system-prompt-file', filePath)
    } catch {
      d.stderrWrite(
        `[slack] template: append_system_prompt_file not readable, omitting flag: ${filePath}`,
      )
    }
  }

  return {
    name: DEFAULT_TEMPLATE_NAME,
    relay_mode: 'on',
    label: ['service=cscb'],
    deny: ['AskUserQuestion'],
    // Pre-allow Read of the per-project MEMORY subdirectory only, so
    // memory-note reads (which always require confirmation) never round-trip
    // to a human as a native TUI prompt — the prompt class that wedged the
    // relay in b.fae. This template is a single shared artifact installed once
    // at boot and used by every persona, so we emit ONE rule per DISTINCT
    // effective config dir across all personas. b.fae F5 code-review fix: the
    // dirs are DERIVED from `personaConfig` (each persona carries its
    // effective `claude_config_dir`: per-persona, else top-level — see
    // src/config.ts) by `deriveMemoryReadAllowRules`, the same directory
    // session-manager.ts buildSpawnParams exports at spawn time (or Claude's
    // default `~/.claude` when a persona has none). The prior implementation's
    // claim that the config dir "is only known at spawn time" was factually
    // wrong; and its hardcoded `/home/horde` paths silently matched nothing on
    // any other user's host (this package is published to npm). All paths are
    // built from the home directory / already-absolute resolved config values,
    // so no `~` leaks into an emitted rule.
    //
    // Syntax: `//` is Claude Code's absolute-path-from-filesystem-root anchor
    // for Read/Edit rules (a single leading `/` would instead anchor at the
    // settings source). `**` is a gitignore-style cross-directory glob.
    // Verified against https://code.claude.com/docs/en/permissions
    // ("//path — Absolute path from filesystem root", e.g.
    // `Read(//Users/alice/secrets/**)`).
    //
    // SECURITY — SCOPE IS DELIBERATELY NARROW. Do NOT widen this to the
    // config-dir ROOT (e.g. `Read(//<config-dir>/**)`), which the b.fae ticket
    // originally proposed. That root holds LIVE CREDENTIALS: `settings.json`
    // carries a real ANTHROPIC_API_KEY (the InferenceHub gateway key that bills
    // the account) and `.claude.json` carries credential-shaped OAuth/token
    // content, alongside history.jsonl, sessions/, shell-snapshots/ and
    // backups/. Pre-allowing the root would silently turn "agent reads its own
    // notes" into "agent reads the API key with no prompt." Every derived rule
    // is therefore scoped to the `projects/*/memory/**` subdirectory — which
    // holds innocuous markdown notes — and NEVER the config-dir root.
    allow: deriveMemoryReadAllowRules(personaConfig),
    claude_args,
    overwrite: true,
    // `extra_env` is omitted: no installation-wide env-var source in today's
    // config schema. Per-persona CLAUDE_CONFIG_DIR and CSCB_CRONTABLE_PATH are
    // supplied at spawn time via SpawnParams.extra_env (SR-1.1; see
    // buildSpawnParams in session-manager.ts, landed in Epic 2).
  }
}

// ---------------------------------------------------------------------------
// SR-3.2 installer
// ---------------------------------------------------------------------------

/** What the boot install wrote: agent-director's result and the params it installed. */
export interface InstalledTemplate extends MakeTemplateResult {
  /**
   * The params the boot install passed to `makeTemplate`: its server-wide
   * arguments (`claude_args`, with or without the append-system-prompt flag
   * as the boot probe decided) are what every apply-time refresh keeps.
   */
  params: MakeTemplateParams
}

/**
 * The boot install's one-line detail of a rejected `makeTemplate`: a typed
 * agent-director error's name and description, else the thrown value's
 * message. It goes to the fatal startup error, not a Slack or
 * agent-director log line.
 */
function describeTemplateFailure(err: unknown): string {
  return err instanceof AgentDirectorError ? `${err.errName}: ${err.errDescription}` : untypedMessage(err)
}

/**
 * The refresh's one-line detail of a rejected `makeTemplate`, safe to log: a
 * typed agent-director error's `errName` when it passes `isSafeIdentifier`,
 * then its description through `redactSlackLogText` (URL-like and token-like
 * text replaced); any other throw, or a typed error whose `errName` fails the
 * check, only through `describeThrownValue`. Never throws.
 */
function describeRefreshFailure(err: unknown): string {
  try {
    if (err instanceof AgentDirectorError && isSafeIdentifier(err.errName)) {
      return `${err.errName}: ${redactSlackLogText(String(err.errDescription))}`
    }
  } catch {
    /* an unreadable typed error falls back to the describer */
  }
  return describeThrownValue(err)
}

/** The boot install's detail of an untyped throw: its message. */
function untypedMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Install the slack-channel-bot template at boot. Fatal on any rejection
 * from `client.makeTemplate(...)`. Resolves with agent-director's result and
 * the params it installed (`InstalledTemplate`), which the apply-time
 * refresh keeps its server-wide arguments from.
 */
export async function installSlackChannelBotTemplate(
  personaConfig: PersonaConfig,
  deps?: Partial<TemplateInstallDeps>,
): Promise<InstalledTemplate> {
  const d = mergeDeps(deps)
  const client = d.getClient() as {
    makeTemplate: (p: MakeTemplateParams) => Promise<MakeTemplateResult>
  }
  const params = buildTemplateParams(personaConfig, deps)
  try {
    return { ...(await client.makeTemplate(params)), params }
  } catch (err) {
    d.recordStartupError(
      'ad-template-install',
      `Failed to install agent-director template '${params.name}'. Detail: ${describeTemplateFailure(err)}`,
    )
    d.exit(1)
    // unreachable; placates TS when exit() is mocked in tests
    return { path: '', params }
  }
}

// ---------------------------------------------------------------------------
// b.av2 SR-8.6 step 5 — apply-time refresh
// ---------------------------------------------------------------------------

/** Dependencies of `refreshSlackChannelBotTemplate`. */
export interface TemplateRefreshDeps {
  /** Returns the agent-director client (production: the singleton `getClient`). */
  getClient: () => unknown
  /** Receives the refresh's one `[slack]` line (the server log). */
  log: (line: string) => void
  /** Home directory for the default config dir's rule; the OS home, read at call time, by default. */
  home?: string
}

/** How a refresh ended. */
export type TemplateRefreshResult =
  | { kind: 'refreshed'; path: string }
  /** `makeTemplate` rejected or threw; the line is logged, the template stays as last installed. */
  | { kind: 'failed' }

/**
 * Refresh the slack-channel-bot template after a confirmed configuration
 * change (b.av2 SR-8.6 step 5): `installed` with its memory-read `allow`
 * rules derived afresh from `applied`'s personas (`deriveMemoryReadAllowRules`,
 * the boot install's derivation, so the rule shape and its per-project
 * memory scope are the same, never a config-dir root). Every other field is
 * `installed`'s: `claude_args` keeps the start-time MCP config and
 * system-prompt flags (the append file is not probed again), and `name`,
 * `label`, `deny` and `relay_mode` are unchanged. `applied`'s server-wide
 * values are not read. Always overwrites. The caller decides when to refresh
 * (the apply: when the change plan's `configDirsChanged`); this makes the
 * call every time it is asked.
 *
 * Never rejects and never exits: a rejection (a typed agent-director error
 * or any throw) logs one line and resolves `{ kind: 'failed' }`. The line
 * names a typed error by its `errName` (only when it passes
 * `isSafeIdentifier`) and its description with URL-like and token-like text
 * redacted (`redactSlackLogText`), and any other throw, or a typed error
 * with an unsafe `errName`, only through `describeThrownValue` (its type, a
 * safe `code` and its stack frames, never its message), so a message holding
 * a token never reaches the log. No startup
 * error is recorded, nothing is posted and no persona's state is touched,
 * and nothing retries it. A success logs one line too.
 */
export async function refreshSlackChannelBotTemplate(
  applied: PersonaConfig,
  installed: MakeTemplateParams,
  deps: TemplateRefreshDeps,
): Promise<TemplateRefreshResult> {
  const allow = deriveMemoryReadAllowRules(applied, deps.home)
  const params: MakeTemplateParams = { ...installed, allow, overwrite: true }
  const log = (line: string): void => {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not fail the refresh */
    }
  }
  try {
    const client = deps.getClient() as { makeTemplate: (p: MakeTemplateParams) => Promise<MakeTemplateResult> }
    const result = await client.makeTemplate(params)
    log(
      `[slack] template refresh: rewrote the agent-director template '${params.name}' with the memory-read rules ` +
        `of the applied config directories (${allow.length} rule(s)); its other arguments are the start's`,
    )
    return { kind: 'refreshed', path: result.path }
  } catch (err) {
    log(
      `[slack] template refresh: refreshing the agent-director template '${params.name}' failed ` +
        `(${describeRefreshFailure(err)}); its memory-read rules stay as last installed until the config ` +
        `directories change again or the server restarts`,
    )
    return { kind: 'failed' }
  }
}
