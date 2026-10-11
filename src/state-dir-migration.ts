/**
 * state-dir-migration.ts — The move of the server's state directory from its
 * old default, under `~/.claude`, to its new one, `<XDG config home>/cscb`
 * (bug b.fc4), and the state directory the commands that run before that move
 * must act on.
 *
 * Before b.fc4 the state directory defaulted to `slack` under
 * `~/.claude/channels` (the "legacy directory", `legacyServerStateDir`). Claude
 * Code asks the user before every write under `~/.claude`, and allow rules
 * cannot turn that off, so every unattended change of `config.json`,
 * `config.json.pending` / `.apply`, `channel-delivery.json` and the rest
 * stalled on a permission prompt. The default now sits outside it
 * (`resolveServerStateDir`, `config.ts`: `~/.config/cscb`, or
 * `$XDG_CONFIG_HOME/cscb`), in the folder the crontable and `prompts/` already
 * moved to in b.avm.
 *
 * `prepareStateDir` runs once per start, first in `main()`: before the state
 * directory is made, and so before anything reads or writes it (the PID check,
 * the retired-key record, the last-applied record and `config.json`,
 * `channel-delivery.json`, the logs, the permission trail, the
 * reply-guard records, the crontable). It acts only when `SLACK_STATE_DIR` is
 * unset or empty: a set variable names the state directory outright, so
 * nothing moves (`overridden`, as in b.avm's legacy-is-default case). It never
 * throws, and it never overwrites a file at the new location.
 *
 * What it does with the legacy directory `L` and the new one `N`:
 *
 * - Nothing at `L`, or a dangling link: `no-legacy`.
 * - `L` is a symbolic link to `N`, or `N` to `L`, or both reach one directory:
 *   `already-migrated`, nothing logged. Running it again is therefore a no-op.
 * - `L` is a symbolic link to some other directory (an operator's own
 *   arrangement) or not a directory: one WARN, nothing moved. The start goes
 *   on and, finding no `config.json` at `N`, refuses with its own message; the
 *   WARN says how to keep using that directory (`SLACK_STATE_DIR`). A link to
 *   another directory whose `server.pid` names a live process is the
 *   `legacy-server-running` stop instead (the CLI acts on that directory, so
 *   an old server may run there, and a second one on `N` must not start).
 * - A server of the old release is running (`L/server.pid` is a regular file
 *   naming a live process): `legacy-server-running`, and the start stops.
 *   Moving files out from under a running server would split its state, and
 *   the PID check would not see its PID file at `N` to refuse a second server.
 * - `L` is a directory and nothing is at `N`: `L` is renamed to `N` as a whole
 *   (one atomic step), and `L` becomes a symbolic link to `N` (`moved`). When
 *   the two are on different file systems the rename fails with `EXDEV` and
 *   the entry-by-entry move below runs instead.
 * - `L` is a directory and `N` exists (it does on every 0.14.0 host: the
 *   crontable and `prompts/` are there, and `L/crontab` and `L/prompts` may be
 *   symbolic links into it from b.avm; a pre-0.14.0 host has a real crontable
 *   in `L` and no `N`): each entry of `L` is looked at by name.
 *     - Absent at `N`: it moves there. A file is hard-linked to `N` (or copied,
 *       checked, across file systems), never renamed, so an entry that
 *       appeared at `N` since it was looked at is never overwritten; a
 *       directory is renamed (copied across file systems, to a temporary name
 *       beside the destination and renamed into place); a symbolic link is
 *       re-made at `N` with an absolute target (a link whose absolute target
 *       is its own destination, b.avm's `L/crontab` -> `N/crontab` after
 *       `N/crontab` was deleted, is dropped instead: re-made it would point
 *       at itself). The old name is first
 *       swapped, in one rename, for a symbolic link to the new one, so a
 *       writer that still uses the old name (a bot launched before the
 *       upgrade, a script, an operator's habit) never finds a gap.
 *     - Present at `N` and the same thing (one inode, a link into `N`, a
 *       file with identical bytes, an empty directory): `redundant`, covering
 *       what b.avm's links left behind. Links are compared by what they
 *       resolve to, and, when they do not resolve (dangling), by their
 *       absolute target, so a dangling link moved to `N` settles.
 *     - Present at `N` as a symbolic link back to the entry in `L` (b.avm's
 *       cross-file-system fallback leaves `N/prompts` -> `L/prompts`): the
 *       entry in `L` is the only copy, so it is moved over the link (a file
 *       is linked or copied under a temporary name and renamed over it; a
 *       directory is renamed, or copied and checked, to a temporary name, the
 *       link removed and the directory renamed into place).
 *     - Present at `N` and different: a `conflict`. The new one wins and the
 *       old one is left untouched.
 *   A tree copied across file systems is checked against changes while it is
 *   copied; one that changed is discarded and the move of that entry fails.
 *   With no conflict and no failure, the entries left in `L` (redundant, and
 *   the links just made) are each checked again, and removed only if still
 *   the same as at `N` (a swap link, a duplicate: a write through the old
 *   name since, by a temporary file plus rename, makes it `leftover`), and `L`
 *   itself becomes a symbolic link to `N` (`moved`), so every write through the old directory name lands in the
 *   new folder, temporary-file-plus-rename writes included: a per-file link at
 *   the old name would be replaced by a regular file by such a write. With a
 *   conflict, `L` stays a directory holding the conflicting entries, and the
 *   entries that did move keep their per-file links (so paths in
 *   `config.json` that name the old directory still resolve); outcome
 *   `pending`, one WARN naming each conflicting entry and how to settle it by
 *   hand. The start goes on, on `N`. A later start tries again and finishes
 *   the move once the operator resolved the conflicts. In `pending`, a writer
 *   that replaces a file through its old name (temporary file plus rename)
 *   replaces the link and writes into the old directory, which is why the
 *   WARN says to settle it.
 * - A step that fails (an entry that cannot be moved or looked at, `N` that
 *   cannot be made): `failed`, and the start stops with the failure's line.
 *   Every step leaves things whole (the source stays until the destination is
 *   in place), so nothing is lost and a later start continues; the fix is
 *   stated in the line. Failing to remove a leftover or to place the final
 *   link is only a WARN (`pending`): the data is at `N`.
 *
 * The line for the move sorts of entries names the entries by file name only;
 * nothing logged carries file contents.
 *
 * b.avm's crontable migration (`cron-table-migration.ts`) is subsumed for the
 * default install: the crontable and `prompts/` are entries of `L` like the
 * rest, so they move with it, relative prompt paths keep resolving (both move
 * together), and `CSCB_CRONTABLE_PATH` of a session launched before the
 * upgrade (`L/crontab`) resolves through the link. Its start-time call stays
 * in `main()` but is dormant: the default crontable now lies in the state
 * directory, so its default and legacy paths are the same path.
 *
 * Commands other than the server's start (`cscb stop`,
 * `clean_restart`, `clear-latch`, `credentials`, and postinstall, which npm
 * runs on an upgrade) may run after the upgrade and before the server's first
 * start on the new default, while the real configuration, and perhaps a
 * running old server, is still in `L`. Moving files from there while an old
 * server may be running is unsafe, so they do not migrate; `resolveCliStateDir`
 * returns `L` whenever `L/server.pid` is a regular file naming a live process
 * (whatever `N` holds, so `stop` and `clean_restart` reach the old server and
 * the legacy-server-running line's advice to run `stop` works), and otherwise
 * while `L` is a directory (a real one, or a link to another directory, an
 * operator's arrangement) holding a configuration (or a PID file) and `N`
 * holds no configuration, so they find the config and the PID file the old
 * server uses and postinstall does not write an empty skeleton into `N`. Once
 * the server has migrated, `L` is a link to `N`, and they use `N`.
 *
 * File system access goes through `StateDirMigrationFs`, which tests override
 * in part; paths and the log come from the caller, so tests run it under a
 * scratch home.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE_NAME, isStateDirOverridden, resolveServerStateDir } from './config.ts'
import { isProcessRunning } from './pid.ts'
import { describeThrownValueWithoutStack } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The start of every information line this module logs. */
export const STATE_MIGRATE_LOG_PREFIX = '[slack] state-migrate:'

/** The start of every WARN line this module logs. */
export const STATE_MIGRATE_WARN_PREFIX = '[slack] Warning: state-migrate:'

/** The class label of the startup-errors.log entry for a stop caused by the migration. */
export const STATE_MIGRATE_STARTUP_ERROR_CLASS = 'state-dir-migration'

/** The PID file's name in the state directory (`server.pid`). */
const PID_FILE_NAME = 'server.pid'

/**
 * The last-applied record's name: `config.json` plus the suffix
 * `LAST_APPLIED_FILE_SUFFIX` in `reload.ts` (not imported: that module is
 * large, and this one is loaded by postinstall).
 */
const LAST_APPLIED_FILE_NAME = `${CONFIG_FILE_NAME}.last-applied`

/** The files whose presence shows a state directory holds a configuration. */
const CONFIG_MARKER_NAMES: readonly string[] = [CONFIG_FILE_NAME, LAST_APPLIED_FILE_NAME]

/** The largest two files compared by their bytes to tell a duplicate from a conflict (64 MiB). */
const MAX_COMPARE_BYTES = 64 * 1024 * 1024

/**
 * errno codes meaning a hard link cannot be made here, though a copy can:
 * another file system (`EXDEV`), or one without hard links.
 */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])

/** errno codes meaning no entry is there (`ENOTDIR`: an ancestor is not a directory). */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The state directory every release before b.fc4 defaulted to: `slack` in
 * `channels` in `.claude` under the home directory. Pure.
 *
 * @param home  Home directory; defaults to the OS home, read only when needed.
 */
export function legacyServerStateDir(home?: string): string {
  return join(home ?? homedir(), '.claude', 'channels', 'slack')
}

/** The two directories the migration compares, each absolute. */
export interface StateDirPaths {
  /** The old default (`legacyServerStateDir`). */
  legacyDir: string
  /** The new default (`resolveServerStateDir`). */
  newDir: string
}

/**
 * The directories to migrate between, or undefined when `SLACK_STATE_DIR` is
 * set and non-empty (the variable names the state directory, so there is
 * nothing to move). Pure: touches no file.
 */
export function stateDirPaths(home?: string, env: NodeJS.ProcessEnv = process.env): StateDirPaths | undefined {
  if (isStateDirOverridden(env)) return undefined
  return { legacyDir: legacyServerStateDir(home), newDir: resolveServerStateDir(home, env) }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** What the migration reads of an entry's status. */
export type StateEntryStat = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>

/**
 * The file system the migration uses. Each operation throws an errno-style
 * error (with `code`) on failure. Tests override some of them.
 */
export interface StateDirMigrationFs {
  /** The entry itself; a symbolic link is not followed. */
  lstat(path: string): StateEntryStat
  /** The entry a path names, symbolic links followed. */
  stat(path: string): StateEntryStat
  /** The real path, every symbolic link followed. */
  realpath(path: string): string
  /** The names in a directory. */
  readdir(path: string): string[]
  /** The target a symbolic link holds, as written. */
  readlink(path: string): string
  /** Make a directory and its missing ancestors (`mkdir -p`). */
  mkdirp(path: string): void
  /** Make `newPath` a hard link to `existingPath`; fails when `newPath` exists. */
  link(existingPath: string, newPath: string): void
  /** Make `path` a symbolic link to `target`; fails when `path` exists. */
  symlink(target: string, path: string): void
  /** Rename `from` to `to`, replacing `to` (a directory only when empty). */
  rename(from: string, to: string): void
  /** Remove a file or a symbolic link. */
  unlink(path: string): void
  /** Remove an empty directory. */
  rmdir(path: string): void
  /** Remove a file or a directory tree; no error when absent. */
  rmrf(path: string): void
  /** Copy a file's bytes and mode to `dest`; fails when `dest` exists. */
  copyFileExclusive(src: string, dest: string): void
  /** Copy a directory tree to `dest`, which does not exist; fails on a name that exists. */
  copyDirExclusive(src: string, dest: string): void
  /** Read a file's bytes. */
  readBytes(path: string): Buffer
}

/** The real file system, looked up at call time. */
export const NODE_STATE_DIR_MIGRATION_FS: StateDirMigrationFs = {
  lstat: (path) => lstatSync(path),
  stat: (path) => statSync(path),
  realpath: (path) => realpathSync(path),
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
  symlink: (target, path) => symlinkSync(target, path),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  rmdir: (path) => rmdirSync(path),
  rmrf: (path) => rmSync(path, { recursive: true, force: true }),
  copyFileExclusive: (src, dest) => copyFileSync(src, dest, fsConstants.COPYFILE_EXCL),
  copyDirExclusive: (src, dest) =>
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }),
  readBytes: (path) => readFileSync(path),
}

/** The migration's dependencies. */
export interface StateDirMigrationDeps {
  /** Writes one server-log line. */
  log: (line: string) => void
  /** File-system overrides; unset operations use the real file system. */
  fs?: Partial<StateDirMigrationFs>
  /** Whether a process is running; defaults to `isProcessRunning` (pid.ts). */
  isProcessRunning?: (pid: number) => boolean
  /** The process's own PID, never taken for an old server's; defaults to `process.pid`. */
  ownPid?: number
}

/** What the migration did. */
export type StateDirMigrationOutcome =
  /** `SLACK_STATE_DIR` is set: the state directory is what it names, nothing done. */
  | { kind: 'overridden' }
  /** Nothing (or a dangling symbolic link) at the legacy directory. */
  | { kind: 'no-legacy' }
  /** The two names already reach one directory. */
  | { kind: 'already-migrated' }
  /**
   * The legacy directory's contents are at the new one and the old name is a
   * symbolic link to it: the directory renamed (`rename`), or merged into
   * the existing one entry by entry (`merge`, with the names moved).
   */
  | { kind: 'moved'; via: 'rename' | 'merge'; entries: string[] }
  /**
   * The legacy directory stays a directory: `conflicts` hold different files
   * at both places (the new one is used, the old one untouched), `leftover`
   * could not be removed or appeared during the move. What did move is at the
   * new directory (`entries`). A later start merges again while the legacy
   * name is still a directory; a link that could not be placed is the
   * operator's to make (the WARN says how). The start goes on.
   */
  | { kind: 'pending'; entries: string[]; conflicts: string[]; leftover: string[] }
  /** The legacy name links to a directory other than the new one, or is not a directory: one WARN, nothing moved. */
  | { kind: 'legacy-unusable'; reason: 'link-elsewhere' | 'not-directory' }
  /** An old server runs on the legacy directory (its PID file names a live process): the start stops. */
  | { kind: 'legacy-server-running'; pid: number }
  /**
   * A step failed, and the start stops; `failures` are the entries that could
   * not be moved (name and cause); `newDirExists` is whether the new directory
   * is there (which decides the hand-fix the line gives, `stateDirFailedLine`;
   * every failure this module returns sets it, unset counts as absent).
   */
  | {
      kind: 'failed'
      step: 'mkdir' | 'move' | 'unexpected'
      cause: string
      failures: { name: string; cause: string }[]
      newDirExists?: boolean
    }

/** Whether the start must stop on this outcome (a refused start, never a guess). */
export function stateDirMigrationStopsStart(outcome: StateDirMigrationOutcome): boolean {
  return outcome.kind === 'failed' || outcome.kind === 'legacy-server-running'
}

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

function entriesText(entries: readonly string[]): string {
  return entries.map((name) => JSON.stringify(name)).join(', ')
}

/** The information line when the whole directory was renamed. */
export function stateDirRenamedLine(legacyDir: string, newDir: string): string {
  return (
    `${STATE_MIGRATE_LOG_PREFIX} moved the state directory from ${legacyDir} to ${newDir}, its new default ` +
    `location outside ~/.claude, where Claude Code does not ask before a write. ${legacyDir} is now a symbolic ` +
    `link to it, so a session, script or configuration path that still names the old directory reaches the same files.`
  )
}

/** The information line when the entries were merged into the existing new directory. */
export function stateDirMergedLine(legacyDir: string, newDir: string, entries: readonly string[]): string {
  const moved = entries.length === 0 ? 'nothing needed to move' : `moved ${entriesText(entries)}`
  return (
    `${STATE_MIGRATE_LOG_PREFIX} the state directory's new default location is ${newDir}, outside ~/.claude, where ` +
    `Claude Code does not ask before a write; ${moved} from ${legacyDir}. ${legacyDir} is now a symbolic link to ` +
    `${newDir}, so a session, script or configuration path that still names the old directory reaches the same files.`
  )
}

/** The WARN when entries conflict (or could not be settled) and the legacy directory stays a directory. */
export function stateDirPendingLine(
  legacyDir: string,
  newDir: string,
  entries: readonly string[],
  conflicts: readonly string[],
  leftover: readonly string[],
): string {
  const parts: string[] = []
  if (conflicts.length > 0) {
    parts.push(
      `${entriesText(conflicts)} exist${conflicts.length === 1 ? 's' : ''} both in ${legacyDir} and in ${newDir} ` +
        `with different contents. Using ${newDir}'s; ${legacyDir}'s ${conflicts.length === 1 ? 'is' : 'are'} left untouched`,
    )
  }
  if (leftover.length > 0) {
    parts.push(`${entriesText(leftover)} could not be removed from ${legacyDir}, or appeared in it during the move`)
  }
  const moved = entries.length === 0 ? '' : ` Moved ${entriesText(entries)} to ${newDir}; their old names are links to the new files.`
  return (
    `${STATE_MIGRATE_WARN_PREFIX} the state directory could not be moved completely from ${legacyDir} to its new ` +
    `default location ${newDir}: ${parts.join('; ')}.${moved} Compare the files and keep what you need in ${newDir}, ` +
    `remove them from ${legacyDir}, then remove ${legacyDir} and run ln -s ${newDir} ${legacyDir} (or restart: the ` +
    `next start finishes the move). Until then a program that rewrites a file through ${legacyDir} (temporary file ` +
    `plus rename) writes into the old directory, not ${newDir}.`
  )
}

/** The WARN when the legacy name is not usable as a source. */
export function stateDirLegacyUnusableLine(legacyDir: string, newDir: string, reason: 'link-elsewhere' | 'not-directory', target?: string): string {
  const why =
    reason === 'link-elsewhere'
      ? `a symbolic link to ${target ?? 'another directory'}, not to ${newDir}`
      : 'not a directory'
  const fix =
    reason === 'link-elsewhere' && target !== undefined
      ? `To keep using ${target}, set SLACK_STATE_DIR=${target}. To use ${newDir}, move that directory's files into it.`
      : `Nothing was moved to ${newDir}, the state directory's new default location.`
  return `${STATE_MIGRATE_WARN_PREFIX} ${legacyDir}, the state directory's old default location, is ${why}. ${fix}`
}

/** The stop line when an old server is running on the legacy directory. */
export function stateDirLegacyServerRunningLine(legacyDir: string, newDir: string, pid: number): string {
  return (
    `${STATE_MIGRATE_LOG_PREFIX} a server is still running on the old state directory ${legacyDir} (PID ${pid}). ` +
    `The state directory's new default location is ${newDir}; its files are moved there at a start, which is not ` +
    `done under a running server. Stop that server (claude-slack-channel-bots stop), then start again.`
  )
}

/**
 * The stop line when a step failed. `newDirExists` is whether `newDir` is
 * there: `mv <legacy> <new>` is the hand-fix only when it is not (with `newDir`
 * a directory, mv puts the old one inside it as `<new>/<name>`), otherwise
 * the entries left in `legacyDir` are moved one at a time.
 */
export function stateDirFailedLine(
  legacyDir: string,
  newDir: string,
  step: 'mkdir' | 'move' | 'unexpected',
  cause: string,
  failures: readonly { name: string; cause: string }[],
  newDirExists = false,
): string {
  const what =
    step === 'mkdir'
      ? `could not create ${newDir}`
      : step === 'move'
        ? `could not move ${failures.map((f) => `${JSON.stringify(f.name)} (${f.cause})`).join(', ')}`
        : `could not look at an entry`
  const byHand = newDirExists
    ? `move each entry still in ${legacyDir} that is not in ${newDir} by hand (mv ${legacyDir}/<name> ${newDir}/<name>)`
    : `move it by hand (mv ${legacyDir} ${newDir} && ln -s ${newDir} ${legacyDir})`
  return (
    `${STATE_MIGRATE_LOG_PREFIX} could not move the state directory from ${legacyDir} to its new default location ` +
    `${newDir}: ${what}${step === 'move' ? '' : ` (${cause})`}. Nothing was lost: what did not move is still in ` +
    `${legacyDir}. Fix the cause and start again, or ${byHand}, or set SLACK_STATE_DIR=${legacyDir} to keep the old ` +
    `location.`
  )
}

/** The message a stopping outcome records and logs. Pure. */
export function stateDirStopMessage(paths: StateDirPaths, outcome: StateDirMigrationOutcome): string {
  if (outcome.kind === 'legacy-server-running') {
    return stateDirLegacyServerRunningLine(paths.legacyDir, paths.newDir, outcome.pid)
  }
  if (outcome.kind === 'failed') {
    return stateDirFailedLine(paths.legacyDir, paths.newDir, outcome.step, outcome.cause, outcome.failures, outcome.newDirExists)
  }
  return `${STATE_MIGRATE_LOG_PREFIX} the state directory migration stopped the start.`
}

/** The WARN when the link at the old name could not be placed (the data is at the new directory). */
export function stateDirLinkFailedLine(legacyDir: string, newDir: string, cause: string): string {
  return (
    `${STATE_MIGRATE_WARN_PREFIX} the state directory is at ${newDir}, which is in use, but ${legacyDir} could not be ` +
    `replaced with a symbolic link to it: ${cause}. A session or script that still names ${legacyDir} does not ` +
    `reach it. The server itself uses ${newDir} and does not depend on the old name, and a later start does not ` +
    `restore the link. To restore it, make sure nothing is left at ${legacyDir} (if it is a directory, it should ` +
    `hold nothing that is not at ${newDir}), then run: ln -s ${newDir} ${legacyDir}`
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The entry at `path` (not followed), or undefined when there is none. Other errors are thrown. */
function lstatIfPresent(fs: StateDirMigrationFs, path: string): StateEntryStat | undefined {
  try {
    return fs.lstat(path)
  } catch (err) {
    if (ABSENT_CODES.has(errnoCode(err) ?? '')) return undefined
    throw err
  }
}

/** The real path, or undefined when it cannot be resolved (a dangling link, say). */
function realpathOrUndefined(fs: StateDirMigrationFs, path: string): string | undefined {
  try {
    return fs.realpath(path)
  } catch {
    return undefined
  }
}

/** Remove a name this module made under a temporary name; one that cannot be removed is left. */
function removeTemporary(fs: StateDirMigrationFs, path: string): void {
  try {
    fs.unlink(path)
  } catch {
    // Left behind: a temporary name, which names only this module's own link or copy.
  }
}

/** Whether two entries are one file (the same inode on the same device). */
function isSameInode(a: StateEntryStat, b: StateEntryStat): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** A name beside `path` for a link or copy that is later renamed or linked into place. */
function tempNameBeside(path: string): string {
  return join(dirname(path), `.${basename(path)}.cscb-migrate-${process.pid}-${randomBytes(4).toString('hex')}`)
}

/** Whether `path` is an empty directory. */
function isEmptyDirectory(fs: StateDirMigrationFs, path: string): boolean {
  return fs.readdir(path).length === 0
}

/** Whether two regular files hold the same bytes (never for one past `MAX_COMPARE_BYTES`). */
function sameBytes(fs: StateDirMigrationFs, a: string, b: string, aStat: StateEntryStat, bStat: StateEntryStat): boolean {
  if (aStat.size !== bStat.size || aStat.size > MAX_COMPARE_BYTES) return false
  return fs.readBytes(a).equals(fs.readBytes(b))
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

/**
 * How an entry of the legacy directory compares with the same name in the new one.
 * `link-back`: the new one is a symbolic link to the legacy entry itself (b.avm's
 * cross-file-system fallback leaves `N/prompts` -> `L/prompts`), so the legacy
 * entry is the only copy and is moved over the link.
 */
type EntryVerdict = 'absent' | 'redundant' | 'conflict' | 'link-back'

/** The absolute path the symbolic link `path` names (a relative target resolved against the link's directory). */
function absoluteLinkTarget(fs: StateDirMigrationFs, path: string): string {
  return resolve(dirname(path), fs.readlink(path))
}

/**
 * Compare the symbolic link `src` (in the legacy directory) with `dst` (the same
 * name in the new one; `dstStat` is its entry, undefined when absent).
 *
 * - A link whose absolute target is `dst` itself (b.avm's `L/crontab` ->
 *   `N/crontab`, left when `N/crontab` was deleted) is `redundant`, whether or
 *   not `dst` exists: re-made at `dst` it would point at itself.
 * - A link that resolves to what `dst` resolves to is `redundant`.
 * - A link that does not resolve (dangling) is compared by its absolute target
 *   with `dst`'s, when `dst` is a link too: the same target is `redundant`. So
 *   a dangling link moved to `dst` settles at once, and so does a relative link
 *   whose target moved before it did (`L/z.log` -> `a.log`, with `L/a.log`
 *   already a link to `N/a.log` and then removed).
 * - Anything else at `dst` is a `conflict`.
 */
function compareSymlinkEntry(fs: StateDirMigrationFs, src: string, dst: string, dstStat: StateEntryStat | undefined): EntryVerdict {
  const target = absoluteLinkTarget(fs, src)
  const dstIsLink = dstStat?.isSymbolicLink() === true
  if (target === dst) {
    // Two links naming each other hold no data: neither is dropped.
    return dstIsLink && absoluteLinkTarget(fs, dst) === src ? 'conflict' : 'redundant'
  }
  if (dstStat === undefined) return 'absent'
  const real = realpathOrUndefined(fs, src)
  if (real !== undefined && real === realpathOrUndefined(fs, dst)) return 'redundant'
  return dstIsLink && absoluteLinkTarget(fs, dst) === target ? 'redundant' : 'conflict'
}

/** Compare `src` (in the legacy directory) with `dst` (the same name in the new one). */
function compareEntry(fs: StateDirMigrationFs, src: string, dst: string): EntryVerdict {
  const dstStat = lstatIfPresent(fs, dst)
  const srcStat = fs.lstat(src)
  if (srcStat.isSymbolicLink()) return compareSymlinkEntry(fs, src, dst, dstStat)
  if (dstStat === undefined) return 'absent'
  if (dstStat.isSymbolicLink()) {
    const real = realpathOrUndefined(fs, src)
    const dstReal = realpathOrUndefined(fs, dst)
    return real !== undefined && real === dstReal && (srcStat.isFile() || srcStat.isDirectory()) ? 'link-back' : 'conflict'
  }
  if (isSameInode(srcStat, dstStat)) return 'redundant'
  if (srcStat.isFile() && dstStat.isFile()) return sameBytes(fs, src, dst, srcStat, dstStat) ? 'redundant' : 'conflict'
  if (srcStat.isDirectory() && dstStat.isDirectory()) return isEmptyDirectory(fs, src) ? 'redundant' : 'conflict'
  return 'conflict'
}

/**
 * Place the file at `src` at `dst` without touching either's bytes: a hard
 * link, or, where a hard link cannot be made, a copy checked against changes
 * and hard-linked into place from a temporary name. Neither replaces an
 * existing file.
 */
function placeFile(fs: StateDirMigrationFs, src: string, dst: string): void {
  try {
    fs.link(src, dst)
    return
  } catch (err) {
    if (!LINK_UNSUPPORTED_CODES.has(errnoCode(err) ?? '')) throw err
  }
  const before = fs.lstat(src)
  const copyTemp = tempNameBeside(dst)
  try {
    fs.copyFileExclusive(src, copyTemp)
    const after = fs.lstat(src)
    // A line appended at the old name while it was copied is not in the copy.
    if (!isSameInode(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('it changed while it was being copied, so the copy was discarded')
    }
    fs.link(copyTemp, dst)
  } finally {
    removeTemporary(fs, copyTemp)
  }
}

/**
 * Swap the old name for a link to the new one (see the module header): the
 * link is made first under a temporary name, so a directory that cannot take
 * it stops the move before anything changed; `place` puts the entry at
 * `dst`; then one rename puts the link over the old name.
 */
function moveWithSwap(fs: StateDirMigrationFs, src: string, dst: string, place: () => void): void {
  const swap = tempNameBeside(src)
  fs.symlink(dst, swap)
  try {
    place()
  } catch (err) {
    removeTemporary(fs, swap)
    throw err
  }
  try {
    fs.rename(swap, src)
  } catch (err) {
    removeTemporary(fs, swap)
    // The entry is at `dst`; the old name still holds its (now second) file or is gone.
    try {
      fs.symlink(dst, src)
    } catch {
      // Left: the next start finds the file at both names (one inode, or equal bytes) and settles it.
    }
    throw err
  }
}

/**
 * A string that differs when anything in the tree at `path` was added, removed,
 * resized, touched or replaced: each entry's relative name, kind, size, mtime,
 * inode. Used to tell that a tree did not change while it was being copied.
 */
function treeSignature(fs: StateDirMigrationFs, path: string, rel = ''): string {
  const stat = fs.lstat(path)
  const head = `${rel}\0${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f'}\0${stat.size}\0${stat.mtimeMs}\0${stat.ino}`
  if (!stat.isDirectory()) return head
  const parts = [head]
  for (const name of fs.readdir(path).sort()) parts.push(treeSignature(fs, join(path, name), `${rel}/${name}`))
  return parts.join('\n')
}

/**
 * Copy the directory `src` to `dest` across file systems, and throw, removing
 * the copy, when the source changed meanwhile: a write at the old name during
 * the copy is not in it, and removing the source would lose that write. `dest`
 * is a fresh temporary name (`tempNameBeside`) this module made, so removing it
 * removes only the partial copy.
 */
function copyDirectoryChecked(fs: StateDirMigrationFs, src: string, dest: string): void {
  const before = treeSignature(fs, src)
  try {
    fs.copyDirExclusive(src, dest)
    if (treeSignature(fs, src) !== before) throw new Error('it changed while it was being copied, so the copy was discarded')
  } catch (err) {
    fs.rmrf(dest) // Only the partial copy: `dest` is a temporary name that did not exist.
    throw err
  }
}

/**
 * Move a directory into the new folder (the rename; across file systems a
 * copy to a temporary name beside `dst`, checked, then renamed into place, so
 * nothing at `dst` is ever removed).
 */
function placeDirectory(fs: StateDirMigrationFs, src: string, dst: string): void {
  try {
    fs.rename(src, dst)
    return
  } catch (err) {
    if (errnoCode(err) !== 'EXDEV') throw err
  }
  const temp = tempNameBeside(dst)
  copyDirectoryChecked(fs, src, temp)
  try {
    fs.rename(temp, dst)
  } catch (err) {
    fs.rmrf(temp) // The copy this module made; `dst` is untouched.
    throw err
  }
  fs.rmrf(src)
}

/**
 * Place the file at `src` at `dst`, which is a symbolic link to `src` itself:
 * the file is placed (`placeFile`) under a temporary name beside `dst`, then one
 * rename replaces the link with it.
 */
function placeFileOverLink(fs: StateDirMigrationFs, src: string, dst: string): void {
  const temp = tempNameBeside(dst)
  try {
    placeFile(fs, src, temp)
    fs.rename(temp, dst)
  } finally {
    removeTemporary(fs, temp)
  }
}

/**
 * Place the directory at `src` at `dst`, which is a symbolic link to `src`
 * itself. A rename cannot replace a link with a directory, so the link is
 * removed first, with the directory already under a temporary name beside
 * `dst` (renamed, or copied and checked across file systems), and then renamed
 * into place. A failure puts the link back and the directory where it was.
 */
function placeDirectoryOverLink(fs: StateDirMigrationFs, src: string, dst: string): void {
  const temp = tempNameBeside(dst)
  let copied = false
  try {
    fs.rename(src, temp)
  } catch (err) {
    if (errnoCode(err) !== 'EXDEV') throw err
    copyDirectoryChecked(fs, src, temp)
    copied = true
  }
  const undo = (): void => {
    try {
      if (copied) fs.rmrf(temp)
      else fs.rename(temp, src)
    } catch {
      // Left under its temporary name, beside `dst`: the data is whole there.
    }
  }
  try {
    fs.unlink(dst)
  } catch (err) {
    undo()
    throw err
  }
  try {
    fs.rename(temp, dst)
  } catch (err) {
    try {
      fs.symlink(src, dst)
    } catch {
      // Left absent: the old name still names the data (or `temp` does).
    }
    undo()
    throw err
  }
  if (copied) fs.rmrf(src)
}

/**
 * Move one entry that is absent at the new folder (or, with `overLink`, there
 * as a symbolic link to the entry itself); throws on failure, leaving the
 * source whole.
 */
function moveEntry(fs: StateDirMigrationFs, src: string, dst: string, overLink: boolean): void {
  const stat = fs.lstat(src)
  if (stat.isSymbolicLink()) {
    // Re-made at the new folder with an absolute target: a relative one would point elsewhere from there.
    // The old link stays; it names the same target, so it is redundant afterwards (`compareSymlinkEntry`
    // compares the absolute targets, so this holds for a link that does not resolve too).
    fs.symlink(absoluteLinkTarget(fs, src), dst)
    return
  }
  if (stat.isDirectory()) {
    moveWithSwap(fs, src, dst, () => (overLink ? placeDirectoryOverLink(fs, src, dst) : placeDirectory(fs, src, dst)))
    return
  }
  moveWithSwap(fs, src, dst, () => (overLink ? placeFileOverLink(fs, src, dst) : placeFile(fs, src, dst)))
}

/**
 * Remove one entry of the legacy directory that was settled (a duplicate, or a
 * swap link just made), once it is checked again to be settled: a program that
 * wrote through the old name since (a temporary file plus rename replaces the
 * swap link with a file of its own) must not lose that write. Returns false,
 * removing nothing, when the entry is no longer the same as the one at `dst`.
 */
function removeIfStillSettled(fs: StateDirMigrationFs, src: string, dst: string): boolean {
  const stat = lstatIfPresent(fs, src)
  if (stat === undefined) return true
  if (compareEntry(fs, src, dst) !== 'redundant') return false
  if (stat.isDirectory()) fs.rmdir(src)
  else fs.unlink(src)
  return true
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

/**
 * Put a symbolic link to `newDir` at the legacy name. The legacy directory is
 * emptied: `swap` links to `newDir`, the directory is removed, and the link is
 * renamed into its place. When the directory cannot be removed (something
 * appeared in it) or the link cannot be placed, one WARN and false: the data
 * is at `newDir`. The WARN says what to run; a later start does not restore the
 * link (with the old name absent it finds no legacy directory; with a
 * directory still there it merges again).
 */
function replaceLegacyDirWithLink(fs: StateDirMigrationFs, paths: StateDirPaths, log: (line: string) => void): boolean {
  const swap = tempNameBeside(paths.legacyDir)
  try {
    fs.symlink(paths.newDir, swap)
  } catch (err) {
    log(stateDirLinkFailedLine(paths.legacyDir, paths.newDir, describeThrownValueWithoutStack(err)))
    return false
  }
  try {
    fs.rmdir(paths.legacyDir)
  } catch (err) {
    removeTemporary(fs, swap)
    log(stateDirLinkFailedLine(paths.legacyDir, paths.newDir, describeThrownValueWithoutStack(err)))
    return false
  }
  try {
    fs.rename(swap, paths.legacyDir)
  } catch (err) {
    removeTemporary(fs, swap)
    try {
      fs.symlink(paths.newDir, paths.legacyDir)
    } catch {
      log(stateDirLinkFailedLine(paths.legacyDir, paths.newDir, describeThrownValueWithoutStack(err)))
      return false
    }
  }
  return true
}

/** The PID of an old server running on the legacy directory, or undefined. */
function runningLegacyServer(fs: StateDirMigrationFs, paths: StateDirPaths, deps: StateDirMigrationDeps): number | undefined {
  const pidFile = join(paths.legacyDir, PID_FILE_NAME)
  let raw: string
  try {
    // A regular file only: a link left by an interrupted move names the new
    // folder's file, which the start's own PID check reads.
    if (!fs.lstat(pidFile).isFile()) return undefined
    raw = fs.readBytes(pidFile).toString('utf-8').trim()
  } catch {
    return undefined
  }
  const pid = parseInt(raw, 10)
  if (Number.isNaN(pid) || pid === (deps.ownPid ?? process.pid)) return undefined
  return (deps.isProcessRunning ?? isProcessRunning)(pid) ? pid : undefined
}

/** Merge the entries of the legacy directory into the existing new one (see the module header). */
function mergeEntries(fs: StateDirMigrationFs, paths: StateDirPaths, log: (line: string) => void): StateDirMigrationOutcome {
  if (!fs.stat(paths.newDir).isDirectory()) {
    const cause = `${paths.newDir} exists and is not a directory`
    log(stateDirFailedLine(paths.legacyDir, paths.newDir, 'mkdir', cause, [], true))
    return { kind: 'failed', step: 'mkdir', cause, failures: [], newDirExists: true }
  }
  const moved: string[] = []
  const redundant: string[] = []
  const conflicts: string[] = []
  const failures: { name: string; cause: string }[] = []
  for (const name of fs.readdir(paths.legacyDir).sort()) {
    const src = join(paths.legacyDir, name)
    const dst = join(paths.newDir, name)
    try {
      const verdict = compareEntry(fs, src, dst)
      if (verdict === 'redundant') redundant.push(name)
      else if (verdict === 'conflict') conflicts.push(name)
      else {
        moveEntry(fs, src, dst, verdict === 'link-back')
        moved.push(name)
      }
    } catch (err) {
      failures.push({ name, cause: describeThrownValueWithoutStack(err) })
    }
  }
  if (failures.length > 0) {
    const line = stateDirFailedLine(paths.legacyDir, paths.newDir, 'move', '', failures, true)
    log(line)
    return { kind: 'failed', step: 'move', cause: line, failures, newDirExists: true }
  }
  if (conflicts.length > 0) {
    log(stateDirPendingLine(paths.legacyDir, paths.newDir, moved, conflicts, []))
    return { kind: 'pending', entries: moved, conflicts, leftover: [] }
  }

  // Nothing conflicts: what is left in the legacy directory is the links just
  // made and the duplicates; remove them, then the directory becomes the link.
  const leftover: string[] = []
  for (const name of [...redundant, ...moved]) {
    try {
      if (!removeIfStillSettled(fs, join(paths.legacyDir, name), join(paths.newDir, name))) leftover.push(name)
    } catch (err) {
      if (!ABSENT_CODES.has(errnoCode(err) ?? '')) leftover.push(name)
    }
  }
  if (leftover.length > 0) {
    log(stateDirPendingLine(paths.legacyDir, paths.newDir, moved, [], leftover))
    return { kind: 'pending', entries: moved, conflicts: [], leftover }
  }
  if (!replaceLegacyDirWithLink(fs, paths, log)) {
    return { kind: 'pending', entries: moved, conflicts: [], leftover: [] }
  }
  log(stateDirMergedLine(paths.legacyDir, paths.newDir, moved))
  return { kind: 'moved', via: 'merge', entries: moved }
}

/** The legacy path is a symbolic link; decide what it means. */
function handleLegacyLink(fs: StateDirMigrationFs, paths: StateDirPaths, deps: StateDirMigrationDeps): StateDirMigrationOutcome {
  const { log } = deps
  const target = realpathOrUndefined(fs, paths.legacyDir)
  if (target === undefined) return { kind: 'no-legacy' } // dangling: it holds nothing
  if (target === realpathOrUndefined(fs, paths.newDir)) return { kind: 'already-migrated' }
  // An old server may run on the directory the link names (the CLI acts on it, `resolveCliStateDir`): a second
  // server on N with the same Slack tokens must not start.
  const pid = runningLegacyServer(fs, paths, deps)
  if (pid !== undefined) return { kind: 'legacy-server-running', pid }
  log(stateDirLegacyUnusableLine(paths.legacyDir, paths.newDir, 'link-elsewhere', target))
  return { kind: 'legacy-unusable', reason: 'link-elsewhere' }
}

/** Decide and run the move. */
function migrate(fs: StateDirMigrationFs, paths: StateDirPaths, deps: StateDirMigrationDeps): StateDirMigrationOutcome {
  const { log } = deps
  const legacy = lstatIfPresent(fs, paths.legacyDir)
  if (legacy === undefined) return { kind: 'no-legacy' }
  if (legacy.isSymbolicLink()) return handleLegacyLink(fs, paths, deps)
  if (!legacy.isDirectory()) {
    log(stateDirLegacyUnusableLine(paths.legacyDir, paths.newDir, 'not-directory'))
    return { kind: 'legacy-unusable', reason: 'not-directory' }
  }
  // The new name links to the legacy directory (the reverse arrangement): one directory.
  const legacyReal = realpathOrUndefined(fs, paths.legacyDir)
  if (legacyReal !== undefined && legacyReal === realpathOrUndefined(fs, paths.newDir)) return { kind: 'already-migrated' }

  const pid = runningLegacyServer(fs, paths, deps)
  if (pid !== undefined) return { kind: 'legacy-server-running', pid }

  const current = lstatIfPresent(fs, paths.newDir)
  if (current === undefined) {
    // Nothing at the new directory: one atomic rename of the whole directory.
    try {
      fs.mkdirp(dirname(paths.newDir))
    } catch (err) {
      const cause = describeThrownValueWithoutStack(err)
      log(stateDirFailedLine(paths.legacyDir, paths.newDir, 'mkdir', cause, []))
      return { kind: 'failed', step: 'mkdir', cause, failures: [], newDirExists: false }
    }
    try {
      fs.rename(paths.legacyDir, paths.newDir)
      // A writer that recreates the old name in this instant makes the link fail. The WARN says to run ln -s by
      // hand: with the old name absent, the next start finds no legacy directory and does not retry.
      try {
        fs.symlink(paths.newDir, paths.legacyDir)
      } catch (err) {
        log(stateDirLinkFailedLine(paths.legacyDir, paths.newDir, describeThrownValueWithoutStack(err)))
        return { kind: 'pending', entries: [], conflicts: [], leftover: [] }
      }
      log(stateDirRenamedLine(paths.legacyDir, paths.newDir))
      return { kind: 'moved', via: 'rename', entries: [] }
    } catch (err) {
      if (errnoCode(err) !== 'EXDEV') {
        const cause = describeThrownValueWithoutStack(err)
        const line = stateDirFailedLine(paths.legacyDir, paths.newDir, 'move', cause, [{ name: basename(paths.legacyDir), cause }])
        log(line)
        return {
          kind: 'failed',
          step: 'move',
          cause: line,
          failures: [{ name: basename(paths.legacyDir), cause }],
          newDirExists: false,
        }
      }
    }
    // Another file system: the entries are moved one by one into a new folder.
    try {
      fs.mkdirp(paths.newDir)
    } catch (err) {
      const cause = describeThrownValueWithoutStack(err)
      log(stateDirFailedLine(paths.legacyDir, paths.newDir, 'mkdir', cause, []))
      return { kind: 'failed', step: 'mkdir', cause, failures: [], newDirExists: false }
    }
  }
  return mergeEntries(fs, paths, log)
}

// ---------------------------------------------------------------------------
// prepareStateDir
// ---------------------------------------------------------------------------

/**
 * Move the legacy state directory to the new default (see the module header).
 * Never throws. The caller stops the start on `stateDirMigrationStopsStart`.
 */
export function prepareStateDir(paths: StateDirPaths, deps: StateDirMigrationDeps): StateDirMigrationOutcome {
  const fs: StateDirMigrationFs = { ...NODE_STATE_DIR_MIGRATION_FS, ...deps.fs }
  try {
    return migrate(fs, paths, deps)
  } catch (err) {
    // An entry that could not be looked at (EACCES on an lstat, say); nothing changed.
    const cause = describeThrownValueWithoutStack(err)
    // An unknown state counts as present: the mv hand-fix is only given for a new directory known to be absent.
    let newDirExists = true
    try {
      newDirExists = lstatIfPresent(fs, paths.newDir) !== undefined
    } catch {
      // Cannot be looked at: present.
    }
    deps.log(stateDirFailedLine(paths.legacyDir, paths.newDir, 'unexpected', cause, [], newDirExists))
    return { kind: 'failed', step: 'unexpected', cause, failures: [], newDirExists }
  }
}

/**
 * The server start's call: the directories from the environment
 * (`stateDirPaths`), `overridden` when `SLACK_STATE_DIR` is set, else
 * `prepareStateDir`.
 */
export function migrateStateDirAtStart(
  deps: StateDirMigrationDeps,
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
): { paths: StateDirPaths | undefined; outcome: StateDirMigrationOutcome } {
  const paths = stateDirPaths(home, env)
  if (paths === undefined) return { paths, outcome: { kind: 'overridden' } }
  return { paths, outcome: prepareStateDir(paths, deps) }
}

// ---------------------------------------------------------------------------
// The state directory for commands other than the server's start
// ---------------------------------------------------------------------------

/** Whether `dir` holds a configuration or the last-applied record, links followed. */
function holdsConfiguration(fs: StateDirMigrationFs, dir: string): boolean {
  return CONFIG_MARKER_NAMES.some((name) => {
    try {
      fs.stat(join(dir, name))
      return true
    } catch {
      return false
    }
  })
}

/**
 * The state directory for everything but the server's start: the new default
 * (`resolveServerStateDir`), except, with `SLACK_STATE_DIR` unset and the legacy
 * directory `L` a directory other than the new one `N` (a real directory, or a
 * link to another directory, an operator's arrangement):
 *
 * - `L` when `L/server.pid` is a regular file naming a live process (the test
 *   of `runningLegacyServer`), whatever `N` holds. An agent may have written
 *   `N/config.json` since the upgrade, and `stop` and `clean_restart` must
 *   still reach the old server, which is also what the start's
 *   legacy-server-running line tells the operator to run.
 * - else `L` when it holds a configuration (or a PID file) and `N` holds no
 *   configuration.
 *
 * That is the window between an upgrade and the server's first start on the new
 * default: the real configuration, and any running old server's PID file and
 * log, are in `L`, and acting on an empty `N` would report a missing
 * configuration (`start`), miss the running server (`stop`), or have postinstall
 * write an empty skeleton `config.json` there, which the migration would then
 * see as a conflict. Such a command does not migrate: an old server may be
 * running, and the move is the server's start's. Once the start has moved the
 * directory `L` is a link to `N`, and this is the new default. A link to
 * another directory is never moved by the start (`legacy-unusable`), so it
 * stays chosen while it holds the configuration, and the start's daemon prints
 * the line saying how to keep using it. Reads only; never throws.
 *
 * @param home  Home directory; defaults to the OS home, read only when needed.
 * @param env   Environment; defaults to `process.env`.
 * @param fs    File-system overrides, for tests.
 * @param isRunning  Whether a process is running; defaults to `isProcessRunning` (pid.ts).
 */
export function resolveCliStateDir(
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
  fs?: Partial<StateDirMigrationFs>,
  isRunning?: (pid: number) => boolean,
): string {
  const stateDir = resolveServerStateDir(home, env)
  if (isStateDirOverridden(env)) return stateDir
  const real: StateDirMigrationFs = { ...NODE_STATE_DIR_MIGRATION_FS, ...fs }
  const legacyDir = legacyServerStateDir(home)
  try {
    real.lstat(legacyDir) // throws when absent or unreadable: the new default
    const legacyReal = realpathOrUndefined(real, legacyDir)
    if (legacyReal === undefined) return stateDir // a dangling link
    if (!real.stat(legacyDir).isDirectory()) return stateDir // a file
    if (legacyReal === realpathOrUndefined(real, stateDir)) return stateDir // migrated (or the reverse link): one directory
    const paths: StateDirPaths = { legacyDir, newDir: stateDir }
    if (runningLegacyServer(real, paths, { log: () => {}, isProcessRunning: isRunning }) !== undefined) return legacyDir
    const legacyHolds = holdsConfiguration(real, legacyDir) || lstatIfPresent(real, join(legacyDir, PID_FILE_NAME)) !== undefined
    if (legacyHolds && !holdsConfiguration(real, stateDir)) return legacyDir
  } catch {
    // Cannot be looked at: the new default.
  }
  return stateDir
}

/** The configuration file for everything but the server's start: `config.json` in `resolveCliStateDir`. */
export function resolveCliConfigPath(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCliStateDir(home, env), CONFIG_FILE_NAME)
}
