/**
 * test-helpers/host-safe-env.ts — The one way a unit test builds the
 * environment of a child process it starts, and the agent-director checks the
 * `bun test` preload guard shares (b.jg5 SRJ-1301, SRJ-1302, SRJ-1304).
 *
 * The agent-director 0.10.0 client finds its binary at the standard install
 * path under `HOME` (`AGENT_DIRECTOR_INSTALL_PATH`), then as the first file or
 * symlink named `agent-director` (`AGENT_DIRECTOR_BINARY_NAME`) in a `PATH`
 * directory. It exports neither, so both are written once, here. A child that
 * gets its environment from `hostSafeChildEnv` has a temp HOME holding no
 * install and a `PATH` on which no directory holds an `agent-director` entry,
 * so a regression that reaches agent-director's discovery in the child finds
 * nothing and runs nothing.
 *
 * The call shape (the only one the host-safety audit accepts): the child
 * process call's `env` option is a direct `hostSafeChildEnv(...)` call.
 *
 *   spawnSync('bash', [script], { env: hostSafeChildEnv(home, { tools: ['bash', 'grep'] }), timeout: 5_000 })
 *   spawnSync(process.execPath, [CLI_SOURCE], { env: hostSafeChildEnv(home, { tools: [], extras: { SLACK_STATE_DIR: stateDir } }) })
 *   Bun.spawn(['bash', script], { env: hostSafeChildEnv(home, { pathDirs: [stubBin] }) })
 *
 * Not accepted: the environment built earlier and passed by name
 * (`const env = hostSafeChildEnv(home); spawn(cmd, { env })`), spread or
 * merged (`{ ...hostSafeChildEnv(home), X: '1' }`; pass `extras` instead),
 * built by a wrapper function, or no `env` option at all (the child would
 * inherit the parent's environment).
 *
 * `hostSafeChildEnv(home, options?)` returns an environment holding exactly:
 * - `HOME`: `home`, as given;
 * - `PATH`: `options.pathDirs` first, in order (test-owned stub or shim bin
 *   directories), then the directory of each tool in `options.tools`
 *   (default `DEFAULT_CHILD_TOOLS`: `bun`, `bash`, `sh`), resolved on the
 *   current `process.env.PATH` (first match, as a shell would find it),
 *   duplicates dropped. With no directory at all (an empty tool list and no
 *   `pathDirs`) it is `EMPTY_CHILD_PATH`, a path that is not a directory, so
 *   no lookup finds anything (an empty `PATH` would make a shell search the
 *   working directory);
 * - `TMUX_TMPDIR`: one directory under the OS temp directory whose name
 *   starts with `CHILD_TMUX_TMPDIR_PREFIX`, fixed on the first call in this
 *   process and returned by every later call in it, so a tmux the child starts
 *   never reaches the host's tmux server. When this process was itself started
 *   with such a `TMUX_TMPDIR` (a parent's `hostSafeChildEnv` set it:
 *   `inheritedChildTmuxTmpDir`), that directory is reused; otherwise one is
 *   made with `mkdtempSync`. A `bun` child that loads this helper again (a
 *   harness run in a child, say) therefore hands its own children the parent's
 *   directory instead of making another. The directory is never removed: a
 *   child may still be running tmux when this process ends, and tmux falls
 *   back to `/tmp` (the host's default socket directory) when `TMUX_TMPDIR`
 *   does not exist. That leaves at most one such directory per `bun test` run
 *   (one more for each child whose OS temp directory differs from its
 *   parent's, since only a directory directly under the child's own OS temp
 *   directory is reused);
 * - `options.extras`, as given. An extra cannot set `HOME`, `PATH`,
 *   `TMUX_TMPDIR`, `TMUX` or `TMUX_PANE` (`RESERVED_CHILD_ENV_NAMES`).
 * Nothing else is copied from `process.env`: no Slack token or other ambient
 * credential reaches the child.
 *
 * It throws a `HostSafetyError` (its `reason` one of `HOST_SAFETY_REFUSAL`),
 * whose message names the reason and the path or name at fault and never
 * prints the environment, when:
 * - `home` is not absolute, or is the real home (`isRealHome`);
 * - `home` holds an agent-director install (`homeHoldsAgentDirectorInstall`);
 * - a tool name is empty or holds a `/` or the `PATH` delimiter, or a tool
 *   cannot be found on the current `PATH`;
 * - a `pathDirs` entry is not absolute or holds the `PATH` delimiter;
 * - any directory on the `PATH` it builds, caller-supplied or tool-derived,
 *   holds an `agent-director` entry (`dirHoldsAgentDirector`);
 * - an extra is reserved or its value is not a string.
 *
 * The real home is the account's passwd home: the `/etc/passwd` entry for
 * this process's user ID (`passwdHome()`, which reads the file once and
 * parses it with the pure `passwdHomeFrom`). Bun fixes `os.homedir()` and
 * `os.userInfo().homedir` at start-up from the launch-time `HOME` (not from
 * the passwd database), and the preload guard replaces `process.env.HOME`, so
 * neither is the real home on its own. `isRealHome` also matches the
 * launch-time home, so a HOME the run started with is never handed to a child
 * either. `realHome()` falls back to the launch-time home only when
 * `passwdHome()` is `undefined` (no usable entry for the user).
 *
 * The `bun test` preload guard's refusal, redirect and check live here too,
 * so the guard and the tests share one implementation:
 * `launchHomeRefusal(launchHome, passwdHome, probe)` decides, without side
 * effects, whether a launch-time home (`launchTimeHomes()`) is one the guard
 * must refuse to start with (labels in `LAUNCH_HOME_REFUSAL`);
 * `preloadRedirectedEnv(inherited, home, tmuxTmpDir)` computes the guard's
 * variables (`PRELOAD_ENV_NAMES`) without side effects, and
 * `preloadCheckFailures(env)` lists what is wrong with them (labels in
 * `PRELOAD_CHECK`). "Directly under the OS temp directory" always means
 * directly under `osTempDir()`, the normalized `os.tmpdir()`.
 *
 * Isolation: it starts no process and imports nothing from `agent-director`.
 * It reads only the entries it checks (lstat under `home`, each `PATH`
 * directory and an inherited `TMUX_TMPDIR`; through `LIVE_LAUNCH_HOME_PROBE`,
 * lstat, realpath and readlink of the launch-time home, the paths
 * `launchHomeRefusal` names under it, the passwd home itself and the OS temp
 * directory) and `/etc/passwd`, and creates nothing under `home`: its only
 * write is the one `TMUX_TMPDIR` directory under the OS temp directory, made
 * only when none was inherited. Callers may snapshot their HOME tree around
 * the call.
 *
 * SPDX-License-Identifier: MIT
 */

import { accessSync, constants as fsConstants, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// agent-director discovery names (written once, here)
// ---------------------------------------------------------------------------

/** The file name the agent-director client looks for in each `PATH` directory. */
export const AGENT_DIRECTOR_BINARY_NAME = 'agent-director'

/** The install directory under a home, relative to it. */
export const AGENT_DIRECTOR_INSTALL_DIR = '.agent-director'

/** The standard install path the client tries first, relative to `HOME`. */
export const AGENT_DIRECTOR_INSTALL_PATH = join(AGENT_DIRECTOR_INSTALL_DIR, 'bin', AGENT_DIRECTOR_BINARY_NAME)

// ---------------------------------------------------------------------------
// Child environment shape
// ---------------------------------------------------------------------------

/** The tools a child gets on `PATH` when the caller names none. */
export const DEFAULT_CHILD_TOOLS: readonly string[] = Object.freeze(['bun', 'bash', 'sh'])

/**
 * `PATH` when the child needs no directory: not a directory, so every lookup
 * fails (`ENOTDIR`) and nothing can ever be placed there.
 */
export const EMPTY_CHILD_PATH = '/dev/null'

/** Names `extras` may not set: the helper's own and tmux's session variables. */
export const RESERVED_CHILD_ENV_NAMES: readonly string[] = Object.freeze(['HOME', 'PATH', 'TMUX_TMPDIR', 'TMUX', 'TMUX_PANE'])

/** Prefix of the `TMUX_TMPDIR` directory's name under the OS temp directory. */
export const CHILD_TMUX_TMPDIR_PREFIX = 'host-safe-tmux-'

/**
 * Prefix of the temp HOME the `bun test` preload guard
 * (`tests/test-helpers/host-safety-preload.ts`) makes under the OS temp
 * directory, one per run.
 */
export const PRELOAD_HOME_PREFIX = 'host-safety-preload-home-'

export interface HostSafeChildEnvOptions {
  /**
   * Tools the child runs by name; each one's directory on the current `PATH`
   * goes on the child's `PATH`. Defaults to `DEFAULT_CHILD_TOOLS`. An empty
   * list is allowed (a child started by absolute path that runs nothing by
   * name, such as `process.execPath`).
   */
  tools?: readonly string[]
  /**
   * Absolute, caller-owned directories (test stub or shim bins) placed first
   * on the child's `PATH`, in order. Each is checked like every other `PATH`
   * directory.
   */
  pathDirs?: readonly string[]
  /** Further variables for the child, such as `SLACK_STATE_DIR`. */
  extras?: Readonly<Record<string, string>>
}

/** What `hostSafeChildEnv` returns: its three variables plus the extras. */
export type HostSafeChildEnv = {
  HOME: string
  PATH: string
  TMUX_TMPDIR: string
} & Record<string, string>

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Why `hostSafeChildEnv` refused; `HostSafetyError.reason` is one of these. */
export const HOST_SAFETY_REFUSAL = Object.freeze({
  homeNotAbsolute: 'home-not-absolute',
  realHome: 'real-home',
  homeHoldsInstall: 'home-holds-install',
  invalidToolName: 'invalid-tool-name',
  toolNotFound: 'tool-not-found',
  invalidPathDir: 'invalid-path-dir',
  pathDirHoldsAgentDirector: 'path-dir-holds-agent-director',
  reservedExtra: 'reserved-extra',
  invalidExtra: 'invalid-extra',
} as const)

export type HostSafetyRefusal = (typeof HOST_SAFETY_REFUSAL)[keyof typeof HOST_SAFETY_REFUSAL]

/** A refusal: `reason` says which rule, the message names the path or name at fault. */
export class HostSafetyError extends Error {
  readonly reason: HostSafetyRefusal

  constructor(reason: HostSafetyRefusal, detail: string) {
    super(`hostSafeChildEnv: ${reason}: ${detail}`)
    this.name = 'HostSafetyError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Predicates (shared with the preload guard)
// ---------------------------------------------------------------------------

/** Whether a file system error means "no such entry" rather than "could not look". */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Whether anything exists at `path` (lstat: a dangling symlink counts). An
 * entry that cannot be looked at (e.g. `EACCES`) counts as present, since it
 * cannot be ruled out.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    return !isAbsent(err)
  }
}

/**
 * Whether `dir` holds an entry named `agent-director` of any kind: a file
 * (executable or not), a directory, a symlink or a dangling symlink. A
 * directory that does not exist holds nothing; one that cannot be looked
 * into counts as holding one.
 */
export function dirHoldsAgentDirector(dir: string): boolean {
  return entryExists(join(dir, AGENT_DIRECTOR_BINARY_NAME))
}

/**
 * Whether `home` holds an agent-director install: an entry at the standard
 * install path, or any entry named `.agent-director` (directory, file or
 * symlink) directly in it.
 */
export function homeHoldsAgentDirectorInstall(home: string): boolean {
  return entryExists(join(home, AGENT_DIRECTOR_INSTALL_DIR)) || entryExists(join(home, AGENT_DIRECTOR_INSTALL_PATH))
}

/** How many `:`-separated fields a passwd entry has: name, password, uid, gid, GECOS, home, shell. */
const PASSWD_ENTRY_FIELDS = 7

/** The index of the uid field in a passwd entry. */
const PASSWD_UID_FIELD = 2

/** The index of the home field in a passwd entry. */
const PASSWD_HOME_FIELD = 5

/**
 * The home of the passwd entry for `uid` in `passwdText` (the text of a
 * passwd file, lines separated by `\n`), or `undefined`. Pure: it reads
 * nothing but its arguments. The lines are scanned in order, and the first
 * line whose third `:`-separated field (the uid field) equals `String(uid)`
 * exactly decides (so `01000` or ` 1000` is not uid 1000); a line too short
 * to have a uid field cannot match. That line gives its sixth field (the home
 * field) as written when the line has at least seven fields and the home
 * field is an absolute path, and `undefined` otherwise (fewer than seven
 * fields, or an empty or relative home field). The scan stops at that first
 * match whatever it gives: a later line with the same uid is never used, so a
 * malformed first match leaves the home unknown, and the preload guard then
 * fails closed, instead of taking another line's home. It is `undefined` too
 * when no line matches, and when `uid` is not a non-negative safe integer.
 */
export function passwdHomeFrom(passwdText: string, uid: number): string | undefined {
  if (typeof passwdText !== 'string' || !Number.isSafeInteger(uid) || uid < 0) return undefined
  const wanted = String(uid)
  for (const line of passwdText.split('\n')) {
    const fields = line.split(':')
    if (fields[PASSWD_UID_FIELD] !== wanted) continue
    const home = fields[PASSWD_HOME_FIELD]
    return fields.length >= PASSWD_ENTRY_FIELDS && home !== undefined && isAbsolute(home) ? home : undefined
  }
  return undefined
}

let passwdHomeCache: { value: string | undefined } | undefined

/**
 * This process's user's home from `/etc/passwd` (the account's passwd home):
 * `passwdHomeFrom` over the file's text and this process's user ID. It is
 * `undefined` when `passwdHomeFrom` gives `undefined`, when the process has
 * no user ID, or when the file cannot be read. The file is read once per
 * process; later calls return the cached value.
 */
export function passwdHome(): string | undefined {
  if (passwdHomeCache === undefined) {
    let value: string | undefined
    const uid = process.getuid?.()
    if (uid !== undefined) {
      try {
        value = passwdHomeFrom(readFileSync('/etc/passwd', 'utf-8'), uid)
      } catch {
        value = undefined
      }
    }
    passwdHomeCache = { value }
  }
  return passwdHomeCache.value
}

/** The real home: the account's passwd home, else the launch-time home. */
export function realHome(): string {
  return passwdHome() ?? userInfo().homedir
}

/** `path` with symlinks resolved when it exists, else resolved lexically. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether `dir` is the real home: the account's passwd home, or the
 * launch-time home Bun fixed at start-up (`os.homedir()`,
 * `os.userInfo().homedir`), compared lexically and with symlinks resolved.
 */
export function isRealHome(dir: string): boolean {
  const candidates = new Set<string>()
  for (const h of [passwdHome(), userInfo().homedir, homedir()]) {
    if (h !== undefined && h !== '' && isAbsolute(h)) {
      candidates.add(resolve(h))
      candidates.add(canonical(h))
    }
  }
  return candidates.has(resolve(dir)) || candidates.has(canonical(dir))
}

/**
 * The OS temp directory (`os.tmpdir()`, read at call time) made absolute and
 * normalized, so `TMPDIR=/tmp//` or `TMPDIR=/tmp/.` names the same directory
 * as `TMPDIR=/tmp`. Every "directly under the OS temp directory" comparison
 * uses it: a path built with `join` is normalized, the raw `tmpdir()` is not.
 */
export function osTempDir(): string {
  return resolve(tmpdir())
}

/** Whether `path` is `parent` or lies under it (both compared as given). */
export function isUnder(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * The absolute entries of a `PATH` value, in order. Empty and relative
 * entries are dropped: a lookup resolves them against the working directory.
 */
export function absolutePathEntries(pathEnv: string | undefined): string[] {
  if (pathEnv === undefined || pathEnv === '') return []
  return pathEnv.split(delimiter).filter((d) => d !== '' && isAbsolute(d))
}

/**
 * The directory of the first executable regular file named `tool` among the
 * absolute entries of `pathEnv` (default: the current `process.env.PATH`), or
 * `undefined` when there is none. The directory is returned as the `PATH`
 * entry spells it.
 */
export function resolveToolDir(tool: string, pathEnv: string | undefined = process.env['PATH']): string | undefined {
  for (const dir of absolutePathEntries(pathEnv)) {
    const candidate = join(dir, tool)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, fsConstants.X_OK)
      return dir
    } catch {
      continue
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// hostSafeChildEnv
// ---------------------------------------------------------------------------

let childTmuxTmpDirCache: string | undefined

/**
 * `value` when it names a `TMUX_TMPDIR` a parent's `hostSafeChildEnv` made: an
 * absolute path directly under the OS temp directory whose name starts with
 * `CHILD_TMUX_TMPDIR_PREFIX` and is longer than it, naming a directory (not a
 * symlink) owned by this process's user. Otherwise `undefined`. `value`
 * defaults to this process's own `TMUX_TMPDIR`.
 */
export function inheritedChildTmuxTmpDir(value: string | undefined = process.env['TMUX_TMPDIR']): string | undefined {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined
  const name = basename(value)
  if (dirname(value) !== osTempDir() || !name.startsWith(CHILD_TMUX_TMPDIR_PREFIX) || name.length <= CHILD_TMUX_TMPDIR_PREFIX.length) {
    return undefined
  }
  try {
    const st = lstatSync(value)
    const uid = process.getuid?.()
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return undefined
  } catch {
    return undefined
  }
  return value
}

/**
 * This process's `TMUX_TMPDIR` directory under the OS temp directory: the
 * inherited one (`inheritedChildTmuxTmpDir`) or else a new `mkdtempSync` one,
 * fixed on the first call, the same one on every later call, never removed
 * (see the module header). `hostSafeChildEnv` hands it to every child, and the
 * `bun test` preload guard sets its own `TMUX_TMPDIR` to it, so a run makes
 * one such directory.
 */
export function childTmuxTmpDir(): string {
  if (childTmuxTmpDirCache === undefined) {
    childTmuxTmpDirCache = inheritedChildTmuxTmpDir() ?? mkdtempSync(join(osTempDir(), CHILD_TMUX_TMPDIR_PREFIX))
  }
  return childTmuxTmpDirCache
}

/**
 * The environment for a child process a unit test starts: `HOME`, `PATH`,
 * `TMUX_TMPDIR` and `options.extras`, and nothing else. Throws a
 * `HostSafetyError` instead of returning an environment that could reach the
 * real home or an agent-director binary. See the module header for the rules
 * and the one call shape the host-safety audit accepts.
 */
export function hostSafeChildEnv(home: string, options: HostSafeChildEnvOptions = {}): HostSafeChildEnv {
  const tools = options.tools ?? DEFAULT_CHILD_TOOLS
  const pathDirs = options.pathDirs ?? []
  const extras = options.extras ?? {}

  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new HostSafetyError(HOST_SAFETY_REFUSAL.homeNotAbsolute, `HOME must be an absolute path, got ${JSON.stringify(home)}`)
  }
  if (isRealHome(home)) {
    throw new HostSafetyError(HOST_SAFETY_REFUSAL.realHome, `HOME ${home} is the real home; pass the test's own mkdtempSync directory`)
  }
  if (homeHoldsAgentDirectorInstall(home)) {
    throw new HostSafetyError(HOST_SAFETY_REFUSAL.homeHoldsInstall, `HOME ${home} holds ${AGENT_DIRECTOR_INSTALL_DIR} or ${AGENT_DIRECTOR_INSTALL_PATH}`)
  }

  for (const [name, value] of Object.entries(extras)) {
    if (RESERVED_CHILD_ENV_NAMES.includes(name)) {
      throw new HostSafetyError(HOST_SAFETY_REFUSAL.reservedExtra, `extras may not set ${name}`)
    }
    if (typeof value !== 'string') {
      throw new HostSafetyError(HOST_SAFETY_REFUSAL.invalidExtra, `extra ${name} must be a string`)
    }
  }

  const dirs: string[] = []
  for (const dir of pathDirs) {
    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes(delimiter)) {
      throw new HostSafetyError(HOST_SAFETY_REFUSAL.invalidPathDir, `PATH directory ${JSON.stringify(dir)} must be absolute and hold no ${JSON.stringify(delimiter)}`)
    }
    dirs.push(dir)
  }
  for (const tool of tools) {
    if (typeof tool !== 'string' || tool === '' || tool.includes('/') || tool.includes(delimiter)) {
      throw new HostSafetyError(HOST_SAFETY_REFUSAL.invalidToolName, `tool name ${JSON.stringify(tool)} must be a bare command name`)
    }
    const dir = resolveToolDir(tool)
    if (dir === undefined) {
      throw new HostSafetyError(HOST_SAFETY_REFUSAL.toolNotFound, `tool ${tool} is not on PATH`)
    }
    dirs.push(dir)
  }

  const unique = [...new Set(dirs)]
  for (const dir of unique) {
    if (dirHoldsAgentDirector(dir)) {
      throw new HostSafetyError(
        HOST_SAFETY_REFUSAL.pathDirHoldsAgentDirector,
        `PATH directory ${dir} holds ${AGENT_DIRECTOR_BINARY_NAME}; remove it from PATH before running the tests`,
      )
    }
  }

  return {
    ...extras,
    HOME: home,
    PATH: unique.length === 0 ? EMPTY_CHILD_PATH : unique.join(delimiter),
    TMUX_TMPDIR: childTmuxTmpDir(),
  }
}

// ---------------------------------------------------------------------------
// The bun test preload guard: its redirect and its check
// ---------------------------------------------------------------------------

/** The variables the preload guard sets or unsets, and nothing else. */
export const PRELOAD_ENV_NAMES = Object.freeze(['HOME', 'PATH', 'TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'SLACK_STATE_DIR', 'CLAUDE_CONFIG_DIR'] as const)

export type PreloadEnvName = (typeof PRELOAD_ENV_NAMES)[number]

/** Where the preload guard points `SLACK_STATE_DIR`, relative to the new HOME: the server's default state directory. */
export const PRELOAD_STATE_DIR_PATH = join('.claude', 'channels', 'slack')

/** The preload guard's variables; a missing name is unset. */
export type PreloadEnv = { [Name in PreloadEnvName]?: string }

/** What the redirect and the check read: the guard's variables, or a whole environment such as `process.env`. */
export type PreloadEnvSource = Readonly<PreloadEnv> | Readonly<NodeJS.ProcessEnv>

/**
 * The preload guard's variables after the redirect, computed from the
 * `inherited` environment, the new `home` and the fenced `tmuxTmpDir`. Pure:
 * it changes nothing (not `inherited`, not `process.env`), writes nothing and
 * starts no process; its only reads are the `lstat`s of
 * `dirHoldsAgentDirector`. The result holds exactly:
 * - `HOME`: `home`;
 * - `PATH`: the absolute entries of the inherited `PATH`
 *   (`absolutePathEntries`: empty and relative entries, `.` among them, are
 *   dropped because a lookup resolves them against the working directory), in
 *   order, duplicates dropped, without every directory that holds an
 *   `agent-director` entry (`dirHoldsAgentDirector`, a dangling symlink
 *   included); `EMPTY_CHILD_PATH` when no entry is left;
 * - `TMUX_TMPDIR`: `tmuxTmpDir`;
 * - `SLACK_STATE_DIR`: `<home>/PRELOAD_STATE_DIR_PATH`
 *   (`<home>/.claude/channels/slack`), the server's default state directory
 *   under the new HOME.
 * `TMUX`, `TMUX_PANE` and `CLAUDE_CONFIG_DIR` are absent (unset):
 * `CLAUDE_CONFIG_DIR` names a Claude configuration directory (a run started
 * from a bot's session can inherit its persona's), and Claude Code, a hook
 * or any code that honours it would read and write that directory. Nothing
 * else is read from `inherited`.
 */
export function preloadRedirectedEnv(inherited: PreloadEnvSource, home: string, tmuxTmpDir: string): PreloadEnv {
  const dirs = [...new Set(absolutePathEntries(inherited.PATH))].filter((dir) => !dirHoldsAgentDirector(dir))
  return {
    HOME: home,
    PATH: dirs.length === 0 ? EMPTY_CHILD_PATH : dirs.join(delimiter),
    TMUX_TMPDIR: tmuxTmpDir,
    SLACK_STATE_DIR: join(home, PRELOAD_STATE_DIR_PATH),
  }
}

/** Why an environment is not one the preload guard produced (`preloadCheckFailures`). */
export const PRELOAD_CHECK = Object.freeze({
  homeNotAbsolute: 'home-not-absolute',
  homeNotPreloadTemp: 'home-not-preload-temp',
  homeNotDirectory: 'home-not-directory',
  realHome: 'real-home',
  homeHoldsInstall: 'home-holds-install',
  pathUnset: 'path-unset',
  pathEntryNotAbsolute: 'path-entry-not-absolute',
  pathDirHoldsAgentDirector: 'path-dir-holds-agent-director',
  tmuxSet: 'tmux-set',
  tmuxPaneSet: 'tmux-pane-set',
  claudeConfigDirSet: 'claude-config-dir-set',
  tmuxTmpDirNotFenced: 'tmux-tmpdir-not-fenced',
  tmuxTmpDirNotProcess: 'tmux-tmpdir-not-process',
  stateDirUnset: 'state-dir-unset',
  stateDirNotUnderHome: 'state-dir-not-under-home',
} as const)

export type PreloadCheckFailure = (typeof PRELOAD_CHECK)[keyof typeof PRELOAD_CHECK]

/**
 * Why `env` is not an environment the preload guard produced, or `[]` when it
 * is. The preload guard throws when this is not empty, and the host-safety
 * test runs it on the live environment. HOME must be an absolute, real
 * directory (not a symlink) directly under the OS temp directory
 * (`osTempDir()`) whose name carries `PRELOAD_HOME_PREFIX`, not the real home
 * (passwd or launch-time) nor under it, and hold no agent-director install; it
 * need not be empty (every test file shares it). `PATH` must be set and every
 * entry absolute and holding no `agent-director` entry. `TMUX`, `TMUX_PANE`
 * and `CLAUDE_CONFIG_DIR` must be unset. `TMUX_TMPDIR` must be a directory
 * `inheritedChildTmuxTmpDir` accepts and this process's one
 * (`childTmuxTmpDir()`). `SLACK_STATE_DIR` must be set and non-empty (unset,
 * the state-directory resolvers fall back to the launch-time home) and the
 * directory it names (made absolute, as the resolvers do) must lie strictly
 * under HOME. Only `lstat`s (none under the real home: a HOME that is or lies
 * under it fails before any): it starts no process.
 */
export function preloadCheckFailures(env: PreloadEnvSource): PreloadCheckFailure[] {
  const failures: PreloadCheckFailure[] = []
  const home = env.HOME
  if (home === undefined || !isAbsolute(home)) failures.push(PRELOAD_CHECK.homeNotAbsolute)
  else {
    const name = basename(home)
    if (dirname(home) !== osTempDir() || !name.startsWith(PRELOAD_HOME_PREFIX) || name.length <= PRELOAD_HOME_PREFIX.length) {
      failures.push(PRELOAD_CHECK.homeNotPreloadTemp)
    }
    // The real home (or a path under it) is refused before anything under it is looked at.
    if (isRealHome(home) || isUnder(resolve(home), realHome())) failures.push(PRELOAD_CHECK.realHome)
    else {
      let isDirectory = false
      try {
        isDirectory = lstatSync(home).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) failures.push(PRELOAD_CHECK.homeNotDirectory)
      if (homeHoldsAgentDirectorInstall(home)) failures.push(PRELOAD_CHECK.homeHoldsInstall)
    }
  }
  const path = env.PATH
  if (path === undefined) failures.push(PRELOAD_CHECK.pathUnset)
  else {
    for (const dir of path.split(delimiter)) {
      if (dir === '' || !isAbsolute(dir)) failures.push(PRELOAD_CHECK.pathEntryNotAbsolute)
      else if (dirHoldsAgentDirector(dir)) failures.push(PRELOAD_CHECK.pathDirHoldsAgentDirector)
    }
  }
  if (env.TMUX !== undefined) failures.push(PRELOAD_CHECK.tmuxSet)
  if (env.TMUX_PANE !== undefined) failures.push(PRELOAD_CHECK.tmuxPaneSet)
  if (env.CLAUDE_CONFIG_DIR !== undefined) failures.push(PRELOAD_CHECK.claudeConfigDirSet)
  const tmuxTmpDir = env.TMUX_TMPDIR
  if (tmuxTmpDir === undefined || inheritedChildTmuxTmpDir(tmuxTmpDir) !== tmuxTmpDir) failures.push(PRELOAD_CHECK.tmuxTmpDirNotFenced)
  else if (tmuxTmpDir !== childTmuxTmpDir()) failures.push(PRELOAD_CHECK.tmuxTmpDirNotProcess)
  const stateDir = env.SLACK_STATE_DIR
  if (stateDir === undefined || stateDir === '') failures.push(PRELOAD_CHECK.stateDirUnset)
  else {
    const resolved = resolve(stateDir)
    if (home === undefined || !isAbsolute(home) || resolved === resolve(home) || !isUnder(resolved, resolve(home))) {
      failures.push(PRELOAD_CHECK.stateDirNotUnderHome)
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// The bun test preload guard: its launch-home refusal
// ---------------------------------------------------------------------------

/** The Claude configuration directory under a home, relative to it. */
export const CLAUDE_DIR = '.claude'

/**
 * The paths under a home that `src/` and the agent-director client it loads
 * derive from `homedir()`, relative to the home. `launchHomeRefusal` follows
 * the symlinks on each one:
 * - `.claude`: Claude's default configuration directory
 *   (`resolveClaudeConfigDir`, the directory the Stop-hook patcher refuses,
 *   the default transcript root in `cozempic.ts`);
 * - `.claude/channels/slack`: the server's default state directory
 *   (`PRELOAD_STATE_DIR_PATH`);
 * - `.claude/projects`: the default JSONL transcript root
 *   (`resolveJsonlRoots`, `resolveJsonlPath`) and the root of the memory Read
 *   rules;
 * - `.claude/skills`: where postinstall links the shipped skills;
 * - `.claude/slack-mcp.json`: postinstall's MCP configuration and the default
 *   `mcp_config_path`;
 * - `.agent-director` and, under it, `state.db` (the start gate's same-user
 *   probe and the client's store), `config.toml` (agent-director's settings
 *   file) and `bin/agent-director` (`AGENT_DIRECTOR_INSTALL_PATH`).
 */
export const LAUNCH_HOME_DERIVED_PATHS: readonly string[] = Object.freeze([
  CLAUDE_DIR,
  PRELOAD_STATE_DIR_PATH,
  join(CLAUDE_DIR, 'projects'),
  join(CLAUDE_DIR, 'skills'),
  join(CLAUDE_DIR, 'slack-mcp.json'),
  AGENT_DIRECTOR_INSTALL_DIR,
  join(AGENT_DIRECTOR_INSTALL_DIR, 'state.db'),
  join(AGENT_DIRECTOR_INSTALL_DIR, 'config.toml'),
  AGENT_DIRECTOR_INSTALL_PATH,
])

/** Why the preload guard refuses to start (`launchHomeRefusal`). */
export const LAUNCH_HOME_REFUSAL = Object.freeze({
  notAbsolute: 'launch-home-not-absolute',
  inRealHome: 'launch-home-in-real-home',
  tempDirIsRoot: 'launch-home-temp-dir-is-root',
  notUnderTempDir: 'launch-home-not-under-temp-dir',
  holdsSlackState: 'launch-home-holds-slack-state',
  derivedPathInRealHome: 'launch-home-derived-path-in-real-home',
  derivedPathNotUnderTempDir: 'launch-home-derived-path-not-under-temp-dir',
  holdsAgentDirector: 'launch-home-holds-agent-director',
} as const)

export type LaunchHomeRefusal = (typeof LAUNCH_HOME_REFUSAL)[keyof typeof LAUNCH_HOME_REFUSAL]

/**
 * The exit code of a run the preload guard refused to start: sysexits'
 * `EX_CONFIG`, so a refusal is told apart from a failing test (exit code 1).
 * `scripts/preflight.sh` names the same code.
 */
export const LAUNCH_HOME_REFUSED_EXIT_CODE = 78

/** The host reads `launchHomeRefusal` makes, injected so the decision stays pure. */
export interface LaunchHomeProbe {
  /**
   * Whether anything exists at `path` (lstat: a dangling symlink counts, and
   * an entry that cannot be looked at counts as present).
   */
  exists(path: string): boolean
  /**
   * `path` made absolute with every symlink on it followed as far as the
   * path exists: the real path of its deepest existing part, a dangling
   * symlink followed to its target, with the rest appended. It names the
   * entry a write to `path` would reach.
   */
  canonical(path: string): string
  /** The OS temp directory (`osTempDir()`). */
  tempDir(): string
}

/** How many symlinks `resolveLinks` follows before it stops (Linux's own limit). */
const MAX_LINK_HOPS = 40

/** `LIVE_LAUNCH_HOME_PROBE.canonical`: `path`, absolute, with every symlink on it followed as far as it exists. */
function resolveLinks(path: string): string {
  return resolveLinksWithin(resolve(path), { hops: 0 })
}

/**
 * `resolveLinks` for an absolute `path`, sharing one symlink budget across the
 * walk: once `MAX_LINK_HOPS` symlinks (a loop, say) have been followed, the
 * rest of the path is appended as it stands.
 */
function resolveLinksWithin(path: string, budget: { hops: number }): string {
  try {
    return realpathSync(path)
  } catch {
    // Absent, a dangling symlink on the way, or not readable: resolve the parent, then look at the last entry.
  }
  const parent = dirname(path)
  if (parent === path) return path
  const realParent = resolveLinksWithin(parent, budget)
  const entry = join(realParent, basename(path))
  if (budget.hops >= MAX_LINK_HOPS) return entry
  let target: string
  try {
    target = readlinkSync(entry)
  } catch {
    return entry // Absent, not a symlink, or not readable.
  }
  budget.hops += 1
  return resolveLinksWithin(resolve(realParent, target), budget)
}

/** The live host's `LaunchHomeProbe`, the one the preload guard passes. */
export const LIVE_LAUNCH_HOME_PROBE: LaunchHomeProbe = Object.freeze({ exists: entryExists, canonical: resolveLinks, tempDir: osTempDir })

/**
 * The homes this process was launched with, as Bun fixed them at start-up:
 * `os.homedir()` and `os.userInfo().homedir`, in that order, duplicates
 * dropped (`userInfo()` is skipped when it throws). Setting or deleting
 * `process.env.HOME` later changes neither, so code that calls `homedir()`
 * during a run resolves its paths against one of these.
 */
export function launchTimeHomes(): string[] {
  const homes = [homedir()]
  try {
    homes.push(userInfo().homedir)
  } catch {
    // No passwd entry for this user: os.homedir() is the only launch-time home.
  }
  return [...new Set(homes)]
}

/**
 * Why the preload guard must refuse a run launched with `launchHome` (a
 * launch-time home, `launchTimeHomes()`), or `undefined` when it may start.
 * `passwdHome` is the account's passwd home (`passwdHome()`), the real home
 * the rules keep the run out of. When it is `undefined` or not absolute (no
 * `/etc/passwd` entry, as for an account served by NSS or LDAP), the real
 * home is unknown, so the guard fails closed: the run must then stay strictly
 * under the OS temp directory (`probe.tempDir()`), which must not be the file
 * system root. Pure: its only reads are `probe`'s, and it changes nothing.
 * Below, a path "resolves" to `probe.canonical` of it (every symlink on it
 * followed as far as it exists), and the temp directory is compared
 * resolved. The first rule that applies wins:
 * - `notAbsolute`: `launchHome` is not an absolute path (empty included);
 * - `inRealHome` (passwd home known): `launchHome` is the real home or lies
 *   under it, compared lexically first (nothing is probed for a home that
 *   matches) and then with both resolved;
 * - `tempDirIsRoot` (passwd home unknown): the temp directory resolves to the
 *   file system root (`/`), under which every absolute path lies, so the
 *   temp-directory rules would accept any home. Nothing about `launchHome` is
 *   probed. The root is the only ancestor of a home refused as the temp
 *   directory: with the temp directory set to another one (`TMPDIR=/home`,
 *   say), a home under it, the real one included, passes `notUnderTempDir`,
 *   and passes `derivedPathNotUnderTempDir` unless one of its derived paths
 *   resolves out of that directory, so it is then refused only by
 *   `holdsSlackState` or `holdsAgentDirector`;
 * - `notUnderTempDir` (passwd home unknown): `launchHome` does not resolve
 *   to a path strictly under the temp directory;
 * - `holdsSlackState`: anything exists at `<launchHome>/.claude/channels/slack`
 *   (`PRELOAD_STATE_DIR_PATH`, the server's default state directory), a
 *   dangling symlink or an entry that cannot be looked at included;
 * - `derivedPathInRealHome` (passwd home known): one of
 *   `LAUNCH_HOME_DERIVED_PATHS` under `launchHome` resolves to the real home
 *   (as given or resolved) or a path under it;
 * - `derivedPathNotUnderTempDir` (passwd home unknown): one of them does not
 *   resolve to a path strictly under the temp directory;
 * - `holdsAgentDirector`: `launchHome` holds an agent-director install
 *   (`.agent-director`, or an entry at `AGENT_DIRECTOR_INSTALL_PATH`).
 * For a home none of these apply to, no path in `LAUNCH_HOME_DERIVED_PATHS`
 * resolves into the real home (with the passwd home unknown: each resolves
 * strictly under the temp directory, which is not the root), and nothing
 * exists at its `.claude/channels/slack` or its agent-director install paths.
 */
export function launchHomeRefusal(launchHome: string, passwdHome: string | undefined, probe: LaunchHomeProbe): LaunchHomeRefusal | undefined {
  if (typeof launchHome !== 'string' || !isAbsolute(launchHome)) return LAUNCH_HOME_REFUSAL.notAbsolute
  const real = typeof passwdHome === 'string' && isAbsolute(passwdHome) ? passwdHome : undefined
  // Whether a resolved path leaves where the run may reach: into the real home, or, with it unknown, out of the temp directory.
  let leaves: (resolved: string) => boolean
  if (real !== undefined) {
    if (isUnder(resolve(launchHome), resolve(real))) return LAUNCH_HOME_REFUSAL.inRealHome
    const realForms = [resolve(real), probe.canonical(real)]
    leaves = (resolved) => realForms.some((form) => isUnder(resolved, form))
    if (leaves(probe.canonical(launchHome))) return LAUNCH_HOME_REFUSAL.inRealHome
  } else {
    const temp = probe.canonical(probe.tempDir())
    // Every absolute path lies under the root, so a root temp directory would let any home through.
    if (dirname(temp) === temp) return LAUNCH_HOME_REFUSAL.tempDirIsRoot
    leaves = (resolved) => resolved === temp || !isUnder(resolved, temp)
    if (leaves(probe.canonical(launchHome))) return LAUNCH_HOME_REFUSAL.notUnderTempDir
  }
  if (probe.exists(join(launchHome, PRELOAD_STATE_DIR_PATH))) return LAUNCH_HOME_REFUSAL.holdsSlackState
  if (LAUNCH_HOME_DERIVED_PATHS.some((path) => leaves(probe.canonical(join(launchHome, path))))) {
    return real !== undefined ? LAUNCH_HOME_REFUSAL.derivedPathInRealHome : LAUNCH_HOME_REFUSAL.derivedPathNotUnderTempDir
  }
  if (probe.exists(join(launchHome, AGENT_DIRECTOR_INSTALL_DIR)) || probe.exists(join(launchHome, AGENT_DIRECTOR_INSTALL_PATH))) {
    return LAUNCH_HOME_REFUSAL.holdsAgentDirector
  }
  return undefined
}

/**
 * The one line the preload guard writes to stderr when it refuses: the
 * reason and the launch-time home (JSON-quoted), never the environment.
 */
export function launchHomeRefusalMessage(reason: LaunchHomeRefusal, launchHome: string): string {
  return (
    `host-safety preload: refusing to start: ${reason} (launch-time home ${JSON.stringify(launchHome)}). ` +
    'Start bun test with a scratch HOME and SLACK_STATE_DIR, as tests/README.md shows.'
  )
}
