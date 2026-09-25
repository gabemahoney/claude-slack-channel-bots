#!/usr/bin/env bun
/**
 * postinstall.ts — Scaffold skeleton config files for the Slack Channel Router.
 *
 * Creates STATE_DIR and the MCP config parent if missing, then writes
 * config.json and slack-mcp.json only when they do not already exist.
 * Safe to re-run: existing files are never modified. Migrates
 * routing.json → config.json if the old file is present. The retired
 * access-control file of earlier releases is neither created nor touched
 * (b.av2 SR-10.1).
 *
 * Links the debugging skill (debug-slack-channel-bots) into
 * ~/.claude/skills/, replacing only a symbolic link that points elsewhere
 * (dangling included); a real directory or regular file at that name is left
 * in place with a `skipped:` line. Removes the link it created in earlier releases for
 * the retired claude-slack-channels-config skill: only a symbolic link whose
 * target resolves to this package's own skills/claude-slack-channels-config
 * (existing or dangling). A real directory, a regular file or a link to any
 * other path at that name is left untouched.
 *
 * The config.json skeleton is the empty persona configuration
 * `{"personas": []}` (b.av2 SR-1.7): it loads with zero personas. An existing
 * config.json is never touched, whatever its shape; a pre-persona one gets
 * the conversion error when the server starts.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, unlinkSync, renameSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { MCP_SERVER_NAME, resolveServerStateDir } from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'

/** The skills postinstall links into the skills target. */
const LINKED_SKILLS = ['debug-slack-channel-bots']

/** The retired skill whose link from earlier releases postinstall removes. */
const RETIRED_SKILL = 'claude-slack-channels-config'

/**
 * Read the agent-director dependency range from the shipping package.json.
 * One source of truth for the AD version requirement; used in the
 * postinstall-probe failure warning to point operators at the right pin.
 */
export function readAdDependencyRange(): string {
  const pkgPath = resolve(dirname(import.meta.filename), '..', 'package.json')
  const raw = readFileSync(pkgPath, 'utf-8')
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
  const range = pkg.dependencies?.['agent-director']
  if (typeof range !== 'string' || range.length === 0) {
    throw new Error(
      `postinstall: package.json dependencies['agent-director'] is missing or empty`,
    )
  }
  return range
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostinstallOptions {
  /** Override the state directory (defaults to the server's: a non-empty SLACK_STATE_DIR, else ~/.claude/channels/slack/) */
  stateDir?: string
  /** Override the MCP config path (defaults to ~/.claude/slack-mcp.json) */
  mcpConfigPath?: string
  /**
   * Override the home directory (defaults to the OS home, read only when this
   * is absent). The `~` of every default: the state directory when
   * SLACK_STATE_DIR is unset, the MCP config path and the skills link target
   * `~/.claude/skills/`.
   */
  homeDir?: string
}

/** The link's target, resolved against the link's own directory; undefined when `path` is not a symbolic link. */
function symlinkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return undefined
  }
}

/** True when anything, a dangling symbolic link included, exists at `path`. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export function runPostinstall(options: PostinstallOptions = {}): void {
  // The server's state directory (resolveServerStateDir): an empty
  // SLACK_STATE_DIR means unset, and a relative one resolves the same way.
  const home = (): string => options.homeDir ?? homedir()
  const stateDir = options.stateDir ?? resolveServerStateDir(options.homeDir)

  const mcpConfigPath =
    options.mcpConfigPath ?? join(home(), '.claude', 'slack-mcp.json')

  // Ensure directories exist
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(dirname(mcpConfigPath), { recursive: true })

  // config.json — migrate from routing.json if needed
  const configPath = join(stateDir, 'config.json')
  const legacyPath = join(stateDir, 'routing.json')
  if (existsSync(legacyPath) && !existsSync(configPath)) {
    renameSync(legacyPath, configPath)
    console.log(`Migrated routing.json → config.json`)
  }

  // Create the empty persona skeleton if neither old nor new file exists
  if (existsSync(configPath)) {
    console.log(`skipped: ${configPath}`)
  } else {
    writeFileSync(configPath, JSON.stringify({ personas: [] }, null, 2) + '\n')
    console.log(`created: ${configPath}`)
  }

  // Symlink skills into ~/.claude/skills/
  const skillsTarget = join(home(), '.claude', 'skills')
  mkdirSync(skillsTarget, { recursive: true })

  const packageSkillsDir = resolve(dirname(import.meta.filename), '..', 'skills')
  for (const name of LINKED_SKILLS) {
    const src = join(packageSkillsDir, name)
    const dest = join(skillsTarget, name)
    if (existsSync(src)) {
      try {
        // Replace only a symbolic link pointing elsewhere (dangling included).
        // A real directory or file at the name is the operator's: left in place.
        if (entryExists(dest)) {
          const current = symlinkTarget(dest)
          if (current === undefined) {
            console.log(`skipped: ${dest} (not a link; left in place — remove it to let postinstall link the skill)`)
            continue
          }
          if (current === resolve(src)) {
            console.log(`skipped: ${dest} (already linked)`)
            continue
          }
          unlinkSync(dest)
        }
        symlinkSync(src, dest)
        console.log(`linked: ${dest} -> ${src}`)
      } catch (err) {
        console.log(`warning: could not symlink ${name}: ${describeThrownValue(err)}`)
      }
    }
  }

  // Remove the retired skill's link, only when postinstall created it
  const retiredSrc = resolve(packageSkillsDir, RETIRED_SKILL)
  const retiredDest = join(skillsTarget, RETIRED_SKILL)
  if (entryExists(retiredDest)) {
    if (symlinkTarget(retiredDest) === retiredSrc) {
      try {
        unlinkSync(retiredDest)
        console.log(`removed: ${retiredDest} (retired skill link)`)
      } catch (err) {
        console.log(`warning: could not remove ${RETIRED_SKILL} link: ${describeThrownValue(err)}`)
      }
    } else {
      console.log(`skipped: ${retiredDest} (not created by postinstall; left in place)`)
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

/**
 * Best-effort import + Client construction + version() probe. Logs success
 * or a one-line warning; never throws, never exits non-zero.
 *
 * The probe is deliberately wrapped in a top-level try/catch so a missing
 * `agent-director` package (ENOENT during dynamic import) surfaces as a
 * remediation message rather than crashing the postinstall script.
 */
export async function runAgentDirectorPostinstallProbe(): Promise<void> {
  try {
    const ad = await import('agent-director')
    // AD 0.7.0+ exposes an async `Client.create()` factory; the constructor
    // is protected. Any platform / Bun / subprocess-resolution error fires
    // here (Err* subclasses + system-install errors) and is caught below.
    const client = await ad.Client.create({
      storePath: '~/.agent-director/state.db',
      createIfMissing: true,
    })
    try {
      // Now that Client.create() has resolved, the binary version is on the
      // Client itself (binaryVersion getter, AD 0.7.0+). Skip the verb-call
      // probe — the factory already enforced the floor.
      const adVersion = client.binaryVersion.replace(/^v/, '')
      console.log(`postinstall: agent-director ${adVersion} OK`)
    } finally {
      try { client.close() } catch { /* defensive */ }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const adRange = readAdDependencyRange()
    console.warn(
      `postinstall warning: agent-director probe failed (${detail}). ` +
      `Install agent-director (\`bun add agent-director@${adRange}\`) before running ` +
      `\`claude-slack-channel-bots start\`; the startup gate will fail otherwise.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  runPostinstall()
  // SR-5.2: best-effort agent-director presence probe. Bun blocks
  // postinstall by default — this script only runs when the operator has
  // added claude-slack-channel-bots to `trustedDependencies`. Probe
  // failures emit a one-line warning but do NOT fail the install; the
  // real dependency enforcement is the SR-5.1 startup gate at server boot.
  runAgentDirectorPostinstallProbe().catch(() => {
    // The probe itself swallows all errors and logs a warning; this
    // .catch is a belt-and-suspenders defensive layer for any future
    // refactor that lets an error escape.
  })
}
