#!/usr/bin/env bun
/**
 * postinstall.ts — Scaffold skeleton config files for the Slack Channel Router.
 *
 * Creates STATE_DIR and the MCP config parent if missing, then writes
 * routing.json, access.json, and slack-mcp.json only when they do not
 * already exist.  Safe to re-run: existing files are never modified.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { defaultAccess } from './lib.ts'
import { MCP_SERVER_NAME } from './config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostinstallOptions {
  /** Override the state directory (defaults to SLACK_STATE_DIR env var or ~/.claude/channels/slack/) */
  stateDir?: string
  /** Override the MCP config path (defaults to ~/.claude/slack-mcp.json) */
  mcpConfigPath?: string
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export function runPostinstall(options: PostinstallOptions = {}): void {
  const stateDir =
    options.stateDir ??
    process.env['SLACK_STATE_DIR'] ??
    join(homedir(), '.claude', 'channels', 'slack')

  const mcpConfigPath =
    options.mcpConfigPath ?? join(homedir(), '.claude', 'slack-mcp.json')

  // Ensure directories exist
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(dirname(mcpConfigPath), { recursive: true })

  // routing.json
  const routingPath = join(stateDir, 'routing.json')
  if (existsSync(routingPath)) {
    console.log(`skipped: ${routingPath}`)
  } else {
    writeFileSync(routingPath, JSON.stringify({ routes: {} }, null, 2) + '\n')
    console.log(`created: ${routingPath}`)
  }

  // access.json (permissions 0o600)
  const accessPath = join(stateDir, 'access.json')
  if (existsSync(accessPath)) {
    console.log(`skipped: ${accessPath}`)
  } else {
    writeFileSync(
      accessPath,
      JSON.stringify(defaultAccess(), null, 2) + '\n',
      { mode: 0o600 },
    )
    console.log(`created: ${accessPath}`)
  }

  // Symlink skills into ~/.claude/skills/
  const skillsTarget = join(homedir(), '.claude', 'skills')
  mkdirSync(skillsTarget, { recursive: true })

  const skillNames = ['claude-slack-channels-config']
  const packageSkillsDir = resolve(dirname(import.meta.filename), '..', 'skills')
  for (const name of skillNames) {
    const src = join(packageSkillsDir, name)
    const dest = join(skillsTarget, name)
    if (existsSync(src)) {
      try {
        // Remove stale symlink or directory if it points elsewhere
        if (existsSync(dest)) {
          try {
            const current = readlinkSync(dest)
            if (resolve(current) === resolve(src)) {
              console.log(`skipped: ${dest} (already linked)`)
              continue
            }
          } catch { /* not a symlink — remove it */ }
          unlinkSync(dest)
        }
        symlinkSync(src, dest)
        console.log(`linked: ${dest} -> ${src}`)
      } catch (err) {
        console.log(`warning: could not symlink ${name}: ${err}`)
      }
    }
  }

  // slack-mcp.json
  if (existsSync(mcpConfigPath)) {
    console.log(`skipped: ${mcpConfigPath}`)
  } else {
    const skeleton = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:3100/mcp',
        },
      },
    }
    writeFileSync(mcpConfigPath, JSON.stringify(skeleton, null, 2) + '\n')
    console.log(`created: ${mcpConfigPath}`)
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  runPostinstall()
}
