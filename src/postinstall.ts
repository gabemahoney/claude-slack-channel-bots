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
 * Skill links are managed only for an installed copy of the package (b.669):
 * its root (the directory above src/) holds no .git entry and lies inside a
 * node_modules directory (a global install such as
 * ~/.bun/install/global/node_modules/claude-slack-channel-bots), and CI is
 * not set (any value but empty, 0 or false). A `bun install` in a repo
 * checkout or git worktree (a .git directory or file at the root, outside
 * node_modules) or a CI run leaves ~/.claude/skills/ untouched (not even
 * created), with one `skipped:` line saying why, so the user-wide link never
 * points into a checkout that may later be deleted. The config.json and
 * slack-mcp.json skeletons are written either way. The decision is
 * path-based: Bun sets no npm_config_global for a global install.
 * `PostinstallOptions.linkSkills` overrides it ({@link skillLinkSkipReason}).
 *
 * For an installed copy, it links the debugging skill
 * (debug-slack-channel-bots) into ~/.claude/skills/, replacing only a
 * symbolic link that points elsewhere (dangling included); a real directory
 * or regular file at that name is left in place with a `skipped:` line. It
 * removes the link it created in earlier releases for the retired
 * claude-slack-channels-config skill: only a symbolic link whose target
 * resolves to this package's own skills/claude-slack-channels-config
 * (existing or dangling). A real directory, a regular file or a link to any
 * other path at that name is left untouched.
 *
 * The config.json skeleton is the empty persona configuration
 * `{"personas": []}` (b.av2 SR-1.7): it loads with zero personas. An existing
 * config.json is never touched, whatever its shape; a pre-persona one gets
 * the conversion error when the server starts.
 *
 * The entry point then runs the agent-director probe
 * ({@link runAgentDirectorPostinstallProbe}): the install check
 * (`src/install-check.ts`) once, with one OK line (and the Phase 1 note when
 * the check carries one) or one warning. It builds no agent-director client
 * and opens no agent-director store (b.jg5 SRJ-121), and it never fails the
 * install.
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, unlinkSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { MCP_SERVER_NAME, resolveServerStateDir } from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { InstallCheckResult } from './install-check.ts'

/** The skills postinstall links into the skills target. */
const LINKED_SKILLS = ['debug-slack-channel-bots']

/** The retired skill whose link from earlier releases postinstall removes. */
const RETIRED_SKILL = 'claude-slack-channels-config'

/** This copy of the package's root: the directory above src/. */
const DEFAULT_PACKAGE_DIR = resolve(dirname(import.meta.filename), '..')

/** The directory an installed package lies inside. */
const NODE_MODULES_DIR = 'node_modules'

/** CI values (trimmed, lower-cased) that mean "not a CI run"; any other value means one. */
const CI_OFF_VALUES: ReadonlySet<string> = new Set(['', '0', 'false'])

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
  /**
   * Override the package root (defaults to this copy's, the directory above
   * src/): the skills are linked from its skills/ directory, and
   * {@link skillLinkSkipReason} judges it.
   */
  packageDir?: string
  /**
   * Override whether the skill links are managed: true links them, false
   * skips them, whatever {@link skillLinkSkipReason} says. Unset: that
   * function decides.
   */
  linkSkills?: boolean
  /** The environment the CI check reads (defaults to process.env); only CI is read. */
  env?: NodeJS.ProcessEnv
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

/** True when `env` marks a CI run: CI set to anything but empty, 0 or false (case-insensitive). */
function isCiRun(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI
  return value !== undefined && !CI_OFF_VALUES.has(value.trim().toLowerCase())
}

/**
 * Why postinstall must leave the skill links in ~/.claude/skills/ alone for
 * the package rooted at `packageDir`, or undefined when it manages them
 * (b.669). The first rule that applies wins:
 * - a .git entry (directory, worktree file or link) at the root: a repo
 *   checkout or git worktree, not an installed package;
 * - the root does not lie inside a node_modules directory: not an installed
 *   package (a global install lives under `<global dir>/node_modules/`);
 * - `env` marks a CI run ({@link isCiRun}).
 */
function skillLinkSkipReason(packageDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = resolve(packageDir)
  if (entryExists(join(root, '.git'))) return `${root} is a git checkout, not an installed package`
  if (!root.split(sep).includes(NODE_MODULES_DIR)) return `${root} is not inside a ${NODE_MODULES_DIR} directory`
  if (isCiRun(env)) return 'CI is set'
  return undefined
}

/**
 * Links {@link LINKED_SKILLS} from `packageSkillsDir` into `skillsTarget` and
 * removes the retired skill's link when this package created it.
 */
function manageSkillLinks(skillsTarget: string, packageSkillsDir: string): void {
  mkdirSync(skillsTarget, { recursive: true })

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

  // Skill links in ~/.claude/skills/: only for an installed copy of the package
  const skillsTarget = join(home(), '.claude', 'skills')
  const packageDir = resolve(options.packageDir ?? DEFAULT_PACKAGE_DIR)
  let skipReason: string | undefined
  if (options.linkSkills === undefined) skipReason = skillLinkSkipReason(packageDir, options.env)
  else if (!options.linkSkills) skipReason = 'the linkSkills option is false'
  if (skipReason === undefined) {
    manageSkillLinks(skillsTarget, join(packageDir, 'skills'))
  } else {
    console.log(`skipped: ${skillsTarget} (skill links left alone: ${skipReason})`)
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

/** Runs the agent-director install check once (`runInstallCheck` in `src/install-check.ts`). */
export type PostinstallInstallCheck = () => Promise<InstallCheckResult>

/** Dependencies of {@link runAgentDirectorPostinstallProbe}. */
export interface AgentDirectorPostinstallProbeDeps {
  /**
   * The install check; default: `runInstallCheck` from `src/install-check.ts`
   * with its own defaults, loaded when the probe runs so a missing or
   * unloadable agent-director package is one warning, not a failed import of
   * this module.
   */
  runInstallCheck?: PostinstallInstallCheck
}

/** Where every probe warning points the operator. */
const INSTALL_CHECK_POINTER = 'run `bun run install-check` for the full diagnosis'

/** The default install check, loaded on first use. */
async function loadInstallCheck(): Promise<PostinstallInstallCheck> {
  const { runInstallCheck } = await import('./install-check.ts')
  return () => runInstallCheck()
}

/** The install check's result, or the thrown value when it could not run (load or call). */
async function settleInstallCheck(
  deps: AgentDirectorPostinstallProbeDeps,
): Promise<{ ran: true; result: InstallCheckResult } | { ran: false; thrown: unknown }> {
  try {
    const check = deps.runInstallCheck ?? (await loadInstallCheck())
    return { ran: true, result: await check() }
  } catch (thrown) {
    return { ran: false, thrown }
  }
}

/**
 * Best-effort agent-director probe at npm install time (b.jg5 SRJ-121): runs
 * the install check once and logs what it found. It builds no client, opens
 * no agent-director store and resolves the host binary only through the
 * install check.
 *
 * - Success: one `postinstall: agent-director <version> OK` line, then one
 *   `postinstall: note: <note>` line when the check carries the Phase 1 note.
 * - Failure: one `postinstall warning:` line with the class label and the
 *   check's own message, pointing at `bun run install-check`.
 * - A missing or unloadable agent-director package, or a check that throws:
 *   one `postinstall warning:` line with the thrown value described by
 *   `describeThrownValue`.
 *
 * The probe adds no install, upgrade or `bun add` advice of its own; a
 * failure line carries the install check's message. Never throws, never
 * exits and never fails the install.
 */
export async function runAgentDirectorPostinstallProbe(deps: AgentDirectorPostinstallProbeDeps = {}): Promise<void> {
  const settled = await settleInstallCheck(deps)
  if (!settled.ran) {
    console.warn(
      `postinstall warning: the agent-director install check could not run (${describeThrownValue(settled.thrown)}); ` +
        `${INSTALL_CHECK_POINTER}.`,
    )
    return
  }
  const { result } = settled
  if (result.ok) {
    console.log(`postinstall: agent-director ${result.binaryVersion} OK`)
    if (result.note !== undefined) console.log(`postinstall: note: ${result.note}`)
    return
  }
  console.warn(
    `postinstall warning: agent-director install check failed (${result.classLabel}): ${result.message} ` +
      `The server's startup gate refuses to start until this is resolved; ${INSTALL_CHECK_POINTER}.`,
  )
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  runPostinstall()
  // SR-5.2: best-effort agent-director probe through the install check
  // (b.jg5 SRJ-121: no client built, no store opened). Bun blocks
  // postinstall by default — this script only runs when the operator has
  // added claude-slack-channel-bots to `trustedDependencies`. A failure is
  // one warning line and does NOT fail the install; the startup gate at
  // server start is what refuses a binary.
  runAgentDirectorPostinstallProbe().catch(() => {
    // The probe itself swallows all errors and logs a warning; this
    // .catch is a belt-and-suspenders defensive layer for any future
    // refactor that lets an error escape.
  })
}
