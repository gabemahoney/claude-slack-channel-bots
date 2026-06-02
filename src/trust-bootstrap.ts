/**
 * trust-bootstrap.ts — Patch .claude.json for every routed cwd at startup.
 *
 * For each route in routingConfig, resolves the effective claude_config_dir
 * (per-route overrides top-level), then ensures that
 * `projects[<cwd>].hasTrustDialogAccepted` and
 * `projects[<cwd>].hasCompletedProjectOnboarding` are both `true` in
 * `<claude_config_dir>/.claude.json`. Idempotent: no write if both are already
 * set. Missing .claude.json is a soft failure: log + recordStartupError, do
 * NOT auto-create the file, do NOT throw.
 *
 * Never throws to the caller. Per-route errors are caught and recorded via
 * recordStartupError so one bad route cannot block the rest.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { type RoutingConfig } from './config.ts'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Types for .claude.json shape (minimal — we only care about projects[cwd])
// ---------------------------------------------------------------------------

interface ClaudeJsonProject {
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  [key: string]: unknown
}

interface ClaudeJson {
  projects?: Record<string, ClaudeJsonProject>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Patch `<claude_config_dir>/.claude.json` for every route in routingConfig
 * so that the trust dialog and project onboarding are pre-accepted. Idempotent.
 * Never throws.
 */
export async function trustBootstrap(routingConfig: RoutingConfig): Promise<void> {
  for (const [channelId, route] of Object.entries(routingConfig.routes)) {
    try {
      await bootstrapRoute(channelId, route.cwd, route.claude_config_dir ?? routingConfig.claude_config_dir)
    } catch (err) {
      // Catch-all: any per-route failure that slips past inner handlers
      recordStartupError(
        'trust-bootstrap',
        `unexpected error for channel=${channelId} cwd=${route.cwd}`,
        err,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function bootstrapRoute(
  channelId: string,
  cwd: string,
  claudeConfigDir: string | undefined,
): Promise<void> {
  // If no claude_config_dir is configured, Claude uses its own default and
  // there is nothing for us to patch.
  if (claudeConfigDir === undefined) {
    console.error(
      `[slack] trust-bootstrap: channel=${channelId} has no claude_config_dir — skipping`,
    )
    return
  }

  const configPath = join(claudeConfigDir, '.claude.json')

  // Read .claude.json — soft-fail if missing or unreadable
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    console.error(
      `[slack] trust-bootstrap: channel=${channelId} .claude.json not found or unreadable at ${configPath} — skipping`,
    )
    recordStartupError(
      'trust-bootstrap-config-missing',
      `channel=${channelId}: cannot read ${configPath}`,
      err,
    )
    return
  }

  // Parse JSON
  let doc: ClaudeJson
  try {
    doc = JSON.parse(raw) as ClaudeJson
  } catch (err) {
    recordStartupError(
      'trust-bootstrap-config-parse',
      `channel=${channelId}: malformed JSON in ${configPath}`,
      err,
    )
    return
  }

  // Locate or create projects[cwd]
  if (typeof doc.projects !== 'object' || doc.projects === null) {
    doc.projects = {}
  }
  const project: ClaudeJsonProject = doc.projects[cwd] ?? {}

  // Idempotency: skip write if both flags are already true
  if (project.hasTrustDialogAccepted === true && project.hasCompletedProjectOnboarding === true) {
    return
  }

  // Patch flags
  project.hasTrustDialogAccepted = true
  project.hasCompletedProjectOnboarding = true
  doc.projects[cwd] = project

  // Write atomically (match saveAccess pattern in server.ts: write to .tmp + rename)
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
  renameSync(tmp, configPath)
}
