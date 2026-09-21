/**
 * agent-director-template.ts — SR-3.2 boot-time template install.
 *
 * Builds the SR-3.1 `MakeTemplateParams` from RoutingConfig and calls
 * `client.makeTemplate({ ..., overwrite: true })`, giving us "ensure
 * post-state" semantics — the slack-channel-bot template exists with
 * the right contents after every boot, regardless of prior state.
 *
 * Atomic replacement is the library's responsibility (sibling-tempfile +
 * rename(2), shipped in agent-director v0.4.3).
 *
 * On any rejection — `ErrTemplateMalformed`, `ErrTemplateNameUnsafe`, any
 * other `AgentDirectorError`, or a non-typed throw — this module records a
 * fatal startup error and exits non-zero. The template is load-bearing.
 *
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import { posix as pathPosix } from 'node:path'
import type { MakeTemplateParams, MakeTemplateResult } from 'agent-director'

import {
  AgentDirectorError,
} from './agent-director-errors.ts'
import { getClient, DEFAULT_TEMPLATE_NAME } from './agent-director-client.ts'
import { recordStartupError } from './startup-errors.ts'
import type { RoutingConfig } from './config.ts'

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
 * routes and emit one memory-subdir Read allow rule per dir (the emitted rule
 * is `Read(//<abs-config-dir>/projects/[STAR]/memory/[STARSTAR])`, scoped to
 * the per-project memory subdirectory only — see the security note at the call
 * site for why the config-dir root is deliberately excluded).
 *
 * Resolution mirrors session-manager.ts:928-929 buildSpawnParams EXACTLY, which
 * is what sets `CLAUDE_CONFIG_DIR` at spawn time:
 *   per-route `claude_config_dir` ?? top-level `claude_config_dir` ?? default.
 * When neither is configured, no `CLAUDE_CONFIG_DIR` is exported and Claude
 * Code falls back to its own default config dir, `~/.claude` — so that same
 * default must appear here (built from `os.homedir()`, not hardcoded), or a
 * subscription-seat route that relies on the default would get no rule.
 *
 * Config-dir values in a resolved RoutingConfig are already tilde-expanded and
 * `resolve()`d to absolute (config.ts resolveConfig), so no `~` can leak into
 * the emitted rule; the default we add here is likewise built with an absolute
 * homedir. The emitted rule uses Claude Code's `//` absolute-path anchor.
 *
 * The set is de-duplicated so N routes sharing one config dir yield one rule.
 */
export function deriveMemoryReadAllowRules(routingConfig: RoutingConfig): string[] {
  const defaultConfigDir = pathPosix.join(os.homedir(), '.claude')
  const dirs = new Set<string>()
  const topLevel = routingConfig.claude_config_dir
  for (const route of Object.values(routingConfig.routes)) {
    dirs.add(route.claude_config_dir ?? topLevel ?? defaultConfigDir)
  }
  // Guard: a config with zero routes still gets the default-dir rule, matching
  // the spawn-time fallback for any route that would use the default.
  if (dirs.size === 0) dirs.add(defaultConfigDir)
  return [...dirs].sort().map((dir) => {
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
  routingConfig: RoutingConfig,
  deps?: Partial<TemplateInstallDeps>,
): MakeTemplateParams {
  const d = mergeDeps(deps)

  const claude_args: string[] = [
    '--dangerously-load-development-channels',
    'server:slack-channel-router',
    '--mcp-config',
    routingConfig.mcp_config_path,
  ]

  if (
    routingConfig.system_prompt_mode === 'append' &&
    routingConfig.append_system_prompt_file !== undefined
  ) {
    const filePath = routingConfig.append_system_prompt_file
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
    // at boot and used by every route, so we emit ONE rule per DISTINCT
    // effective config dir across all routes. b.fae F5 code-review fix: the
    // dirs are DERIVED from `routingConfig` (which already carries the
    // top-level and per-route `claude_config_dir` values — see src/config.ts)
    // by `deriveMemoryReadAllowRules`, mirroring the exact spawn-time
    // resolution in session-manager.ts buildSpawnParams (per-route ?? top-level
    // ?? Claude's default `~/.claude`). The prior implementation's claim that
    // the per-route config dir "is only known at spawn time" was factually
    // wrong; and its hardcoded `/home/horde` paths silently matched nothing on
    // any other user's host (this package is published to npm). All paths are
    // built from `os.homedir()` / already-absolute resolved config values, so
    // no `~` leaks into an emitted rule.
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
    allow: deriveMemoryReadAllowRules(routingConfig),
    claude_args,
    overwrite: true,
    // `extra_env` is omitted: no installation-wide env-var source in today's
    // config schema. Per-route CLAUDE_CONFIG_DIR is supplied at spawn time
    // via SpawnParams.extra_env (SR-1.1; see buildSpawnParams in
    // session-manager.ts, landed in Epic 2).
  }
}

// ---------------------------------------------------------------------------
// SR-3.2 installer
// ---------------------------------------------------------------------------

/**
 * Install the slack-channel-bot template at boot. Fatal on any rejection
 * from `client.makeTemplate(...)`.
 */
export async function installSlackChannelBotTemplate(
  routingConfig: RoutingConfig,
  deps?: Partial<TemplateInstallDeps>,
): Promise<MakeTemplateResult> {
  const d = mergeDeps(deps)
  const client = d.getClient() as {
    makeTemplate: (p: MakeTemplateParams) => Promise<MakeTemplateResult>
  }
  const params = buildTemplateParams(routingConfig, deps)
  try {
    return await client.makeTemplate(params)
  } catch (err) {
    const detail =
      err instanceof AgentDirectorError
        ? `${err.errName}: ${err.errDescription}`
        : err instanceof Error
        ? err.message
        : String(err)
    d.recordStartupError(
      'ad-template-install',
      `Failed to install agent-director template '${params.name}'. Detail: ${detail}`,
    )
    d.exit(1)
    // unreachable; placates TS when exit() is mocked in tests
    return { path: '' }
  }
}
