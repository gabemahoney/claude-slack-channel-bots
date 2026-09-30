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
 *   spawnSync('mkfifo', [path], { env: hostSafeChildEnv(home, { tools: ['mkfifo'] }), timeout: 5_000 })
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
 * - `TMUX_TMPDIR`: one `mkdtempSync` directory under the OS temp directory
 *   (`CHILD_TMUX_TMPDIR_PREFIX`), created on the first call in this process
 *   and returned by every later call in it, so a tmux the child starts never
 *   reaches the host's tmux server. It is never removed: a child may still be
 *   running tmux when this process ends, and tmux falls back to `/tmp` (the
 *   host's default socket directory) when `TMUX_TMPDIR` does not exist. That
 *   leaves at most one such directory per process (one per `bun test` run);
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
 * this process's user ID. Bun fixes `os.homedir()` and `os.userInfo().homedir`
 * at start-up from the launch-time `HOME` (not from the passwd database), and
 * the preload guard replaces `process.env.HOME`, so neither is the real home
 * on its own. `isRealHome` also matches the launch-time home, so a HOME the
 * run started with is never handed to a child either. `realHome()` falls back
 * to the launch-time home only when the passwd file has no entry for the user.
 *
 * Isolation: it starts no process and imports nothing from `agent-director`.
 * It reads only the entries it checks (lstat under `home` and each `PATH`
 * directory) and `/etc/passwd`, and creates nothing under `home`: its only
 * write is the one `TMUX_TMPDIR` directory per process under the OS temp
 * directory. Callers may snapshot their HOME tree around the call.
 *
 * SPDX-License-Identifier: MIT
 */

import { accessSync, constants as fsConstants, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

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

/** Prefix of the per-process `TMUX_TMPDIR` directory under the OS temp directory. */
export const CHILD_TMUX_TMPDIR_PREFIX = 'host-safe-tmux-'

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

let passwdHomeCache: { value: string | undefined } | undefined

/**
 * This process's user's home from `/etc/passwd` (the account's passwd home),
 * or `undefined` when the file has no entry for its user ID or cannot be read.
 * Read once per process.
 */
export function passwdHome(): string | undefined {
  if (passwdHomeCache === undefined) {
    let value: string | undefined
    const uid = process.getuid?.()
    if (uid !== undefined) {
      try {
        for (const line of readFileSync('/etc/passwd', 'utf-8').split('\n')) {
          const fields = line.split(':')
          if (fields.length >= 7 && fields[2] === String(uid) && isAbsolute(fields[5]!)) {
            value = fields[5]!
            break
          }
        }
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
 * This process's `TMUX_TMPDIR` directory under the OS temp directory: created
 * on the first call, the same one on every later call, never removed (see the
 * module header).
 */
function childTmuxTmpDir(): string {
  if (childTmuxTmpDirCache === undefined) {
    childTmuxTmpDirCache = mkdtempSync(join(tmpdir(), CHILD_TMUX_TMPDIR_PREFIX))
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
