/**
 * trust-bootstrap.ts — Pre-acceptance of Claude Code's folder-trust dialog.
 *
 * Ensures that every configured route's CWD has `hasTrustDialogAccepted` and
 * `hasCompletedProjectOnboarding` set to true in the relevant
 * `<claude_config_dir>/.claude.json`, so Claude Code never shows the
 * "Do you trust the files in this folder?" dialog during managed-bot startup.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type RoutingConfig, expandTilde } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeProjectEntry {
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  [key: string]: unknown
}

interface ClaudeJson {
  projects?: Record<string, ClaudeProjectEntry>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective claude_config_dir for a given channelId, applying
 * the same precedence as the launcher: per-route → top-level → ~/.claude.
 */
function resolveConfigDir(routingConfig: RoutingConfig, channelId: string): string {
  const perRoute = routingConfig.routes[channelId]?.claude_config_dir
  if (perRoute) return perRoute
  if (routingConfig.claude_config_dir) return routingConfig.claude_config_dir
  return expandTilde('~/.claude')
}

/**
 * Patches the `.claude.json` at `configDir` so that `projects[cwd]` has both
 * trust flags set to true. No-ops if they are already true. Atomic write.
 */
function patchClaudeJson(configDir: string, cwd: string): void {
  const filePath = join(configDir, '.claude.json')

  // --- Read ---
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    console.error(`[slack] trust-bootstrap: ${filePath} not found — skip (account not configured?)`)
    return
  }

  let parsed: ClaudeJson
  try {
    const tmp = JSON.parse(raw)
    if (typeof tmp !== 'object' || tmp === null || Array.isArray(tmp)) {
      console.error(`[slack] trust-bootstrap: ${filePath} is not a JSON object — skip`)
      return
    }
    parsed = tmp as ClaudeJson
  } catch {
    console.error(`[slack] trust-bootstrap: ${filePath} malformed JSON — skip`)
    return
  }

  // --- Check idempotency ---
  const existing = parsed.projects?.[cwd]
  if (
    existing !== undefined &&
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true
  ) {
    console.error(`[slack] trust-bootstrap: ${filePath} projects[${cwd}] already accepted — skip`)
    return
  }

  // --- Patch ---
  if (typeof parsed.projects !== 'object' || parsed.projects === null) {
    parsed.projects = {}
  }
  parsed.projects[cwd] = {
    ...(parsed.projects[cwd] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  }

  // --- Atomic write ---
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)

  console.error(`[slack] trust-bootstrap: ${filePath} projects[${cwd}] marked trusted`)
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Walks every route in `routingConfig` and ensures the corresponding
 * `<claude_config_dir>/.claude.json` has `projects[<cwd>].hasTrustDialogAccepted`
 * and `projects[<cwd>].hasCompletedProjectOnboarding` set to true.
 *
 * Routes that share the same config dir are grouped so each `.claude.json` is
 * read and written at most once. Silently skips missing, unreadable, or
 * malformed files — the file is never auto-created.
 *
 * @param routingConfig  Fully resolved routing config (cwds are absolute).
 */
export function bootstrapTrust(routingConfig: RoutingConfig): void {
  // Group routes by their effective config dir so we only touch each file once.
  // Map<configDir, Set<cwd>>
  const dirToCwds = new Map<string, Set<string>>()

  for (const [channelId, route] of Object.entries(routingConfig.routes)) {
    const configDir = resolveConfigDir(routingConfig, channelId)
    if (!dirToCwds.has(configDir)) {
      dirToCwds.set(configDir, new Set())
    }
    dirToCwds.get(configDir)!.add(route.cwd)
  }

  for (const [configDir, cwds] of dirToCwds) {
    for (const cwd of cwds) {
      patchClaudeJson(configDir, cwd)
    }
  }
}
