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
    claude_args,
    overwrite: true,
    // `extra_env` is omitted: no installation-wide env-var source in today's
    // config schema. Per-route CLAUDE_CONFIG_DIR is supplied at spawn time
    // via SpawnParams.extra_env (SR-1.1) in Epic 2.
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
