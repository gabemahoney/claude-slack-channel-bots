/**
 * cron-table-migration.ts — The start's preparation of the default crontable
 * location, and the move of a crontable left at the old default (bug b.avm).
 *
 * Before b.avm the crontable's default was `<config dir>/crontab`, which is
 * `~/.claude/channels/slack/crontab` for a default install. Claude Code asks
 * the user before every write under `.claude`, and bots edit the crontable
 * often, so each self-scheduled line cost the user a permission prompt. The
 * default now sits outside `~/.claude` (`resolveDefaultCronTablePath` in
 * `config.ts`: `$XDG_CONFIG_HOME/cscb/crontab`, `~/.config/cscb/crontab`
 * by default, when `SLACK_STATE_DIR` is unset).
 *
 * `prepareDefaultCronTable` runs once per start, in `main()`, after the start
 * resolved its configuration and before the start sweep, the start bring-up
 * (so before any persona launch takes `CSCB_CRONTABLE_PATH` from the
 * configuration) and the scheduler's bootstrap. It acts only when the
 * start-time configuration left `cron_table_path` out, so the loader filled
 * in the default (`cron_table_path_defaulted`), and that default is not the
 * old one:
 *
 * - A `cron_table_path` the operator wrote is the operator's choice, even
 *   when it names the default's file: nothing is created, moved or linked,
 *   and `cron-bootstrap.ts`'s rule that the server never makes a missing
 *   parent directory (D-Q1) stands for it.
 * - With `SLACK_STATE_DIR` set the default is still `<config dir>/crontab`,
 *   so there is nothing to move.
 *
 * Otherwise it creates the default's directory (`mkdir -p`), so the
 * scheduler's bootstrap can create the file there, then looks at the old
 * default (the legacy path) and the new one:
 *
 * - Nothing at the legacy path: nothing to move (`no-legacy`). A dangling
 *   symbolic link there counts as nothing: it holds no schedules.
 * - A regular file at the new path that is the same file as the legacy one
 *   (one inode under both names): an earlier move stopped between placing the
 *   file and swapping the legacy name, so the swap is finished now (`moved`).
 * - Otherwise both paths, symbolic links followed, name the same file (the
 *   legacy path is the symbolic link an earlier move left, or any other
 *   combination of links naming one file): `already-migrated`, nothing
 *   logged. Running the preparation again is therefore a no-op.
 * - A regular file at the legacy path and nothing at the new one: the file
 *   moves (`moved`). First a symbolic link to the new path is made beside the
 *   legacy path under a temporary name, so a legacy directory that cannot
 *   take it stops the move before anything changed. Then the file is
 *   hard-linked to the new path, or, when the two are on different file
 *   systems, copied (with its mode) to a temporary name beside the new path
 *   and hard-linked from there into place. Finally the temporary symbolic link
 *   is renamed over the legacy path. The bytes are never changed (a copy
 *   reproduces them exactly), and the rename swaps the name in one step. A
 *   bot whose session still carries the old `CSCB_CRONTABLE_PATH` (a resumed
 *   row keeps the environment of its spawn) therefore appends to the live
 *   file after the move, and, with the hard link, during it too. A copy is
 *   checked before it is placed: the legacy file's inode, size and
 *   modification time are taken before the copy and again after it, and a
 *   file that changed meanwhile (a line appended) is not placed: the copy is
 *   removed and the move fails, so nothing is lost. The new path is never
 *   overwritten: both hard links fail on an existing file, and only the
 *   temporary copy is ever removed.
 * - A symbolic link at the legacy path to a regular file elsewhere (not the
 *   new path), and nothing at the new path: the new path becomes a symbolic
 *   link to that same file (its real path), and the legacy link is left as it
 *   is (`linked`).
 * - Anything at both paths that is not the same file: one WARN, the new path
 *   is used, and the legacy file is left untouched (`both-exist`). Its lines
 *   are not scheduled until the operator merges them.
 * - Anything else at the legacy path (a directory, a FIFO, a link to one):
 *   one WARN, nothing moved (`not-regular`).
 *
 * A step that fails before the file is in place at the new path (making the
 * default's directory, the move itself, or an entry that cannot be looked
 * at) changes nothing, and this start runs on the legacy path instead:
 * `cronTablePathForStart` names it, and `main()` replaces `cron_table_path`
 * with it in the server's start-time configuration (`personaConfig` and
 * `appliedConfig`). The scheduler reads it from there, and every launch of
 * this server life exports it as `CSCB_CRONTABLE_PATH`: the start bring-up's
 * launches (over `configInEffect(appliedConfig, …)`) and every later one
 * (over `personaConfig`, which a confirmed apply rebuilds with
 * `configInEffect`, so the path holds until the next start). The reload
 * controller's own applied configuration keeps the default, as `config.json`
 * does, so the fallback alone is never a pending change. Its schedules keep
 * firing, the scheduler's bootstrap never creates an empty crontable at the
 * new path beside it, and the next start tries the move again. A failed swap
 * (the file is in place, the legacy name could not be replaced) runs on the
 * new path.
 *
 * Relative prompt paths resolve against the crontable's own directory, as
 * given (`resolvePromptPath` in `cron-dispatch.ts`), so a move changes where
 * they point. Whenever the start then runs on the new path (moved, linked,
 * or a failed swap) it therefore:
 *
 * - moves `<legacy dir>/prompts` to `<new dir>/prompts` when the former is a
 *   directory and nothing is at the latter: a symbolic link to the new
 *   directory is made beside the old one under a temporary name, the
 *   directory is renamed into the new folder, and the link is renamed to the
 *   old name. The README's convention keeps prompts there and names them
 *   `prompts/<file>`, so those lines resolve to the same files as before, a
 *   path through the old name still works, and a bot writing a prompt file
 *   writes outside `~/.claude`. When the rename fails with `EXDEV` (the two
 *   folders on different file systems), `<new dir>/prompts` becomes a
 *   symbolic link to the old directory instead, with a WARN: prompt files
 *   written through it still land under `~/.claude`. When `<legacy
 *   dir>/prompts` is itself a symbolic link to a directory, the new name
 *   links to that directory (its real path) and the old link is left as it is;
 * - writes one WARN for each crontable line whose relative prompt path named
 *   an existing file before the move and names none after it (a prompt kept
 *   beside the crontable itself, say), naming the absolute path to write in
 *   that line. The line itself is never rewritten.
 *
 * No crontable line is written or rewritten here: a copy reproduces the
 * legacy file's bytes exactly, and `cron-bootstrap.ts`'s create stays the
 * server's only write of new crontable content. The rename over the legacy
 * path replaces only that name, never the new file. Nothing here
 * throws: every failure is one logged line and an outcome, and the start
 * goes on (the scheduler reports a crontable it cannot create or read).
 *
 * File system access goes through `CronTableMigrationFs`, which tests
 * override in part; paths and the log come from the caller, so tests run it
 * under a scratch home.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  constants as fsConstants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { resolvePromptPath } from './cron-dispatch.ts'
import { parseCrontable } from './crontable.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The prompts directory the README's convention keeps beside the crontable. */
export const CRON_PROMPTS_DIR_NAME = 'prompts'

/** The start of every information line this module logs. */
export const CRON_MIGRATE_LOG_PREFIX = '[slack] cron-migrate:'

/** The start of every WARN line this module logs. */
export const CRON_MIGRATE_WARN_PREFIX = '[slack] Warning: cron-migrate:'

/**
 * The cause of a failed move whose copy was not placed because the legacy
 * file changed (its inode, size or modification time) while it was copied.
 */
export const CRON_TABLE_CHANGED_DURING_COPY_CAUSE = 'it changed while it was being copied, so the copy was discarded'

/**
 * errno codes meaning a hard link cannot be made here, though a copy can:
 * another file system (`EXDEV`), or one without hard links.
 */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])

/** errno codes meaning no entry is there (`ENOTDIR`: an ancestor is not a directory). */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** What the preparation reads of an entry's status. */
export type CronTableEntryStat = Pick<
  Stats,
  'dev' | 'ino' | 'size' | 'mtimeMs' | 'isFile' | 'isDirectory' | 'isSymbolicLink'
>

/**
 * The file system the preparation uses. Each operation throws an errno-style
 * error (with `code`) on failure. Tests override some of them.
 */
export interface CronTableMigrationFs {
  /** The entry itself; a symbolic link is not followed. */
  lstat(path: string): CronTableEntryStat
  /** The entry a path names, symbolic links followed. */
  stat(path: string): CronTableEntryStat
  /** The real path, every symbolic link followed. */
  realpath(path: string): string
  /** Make a directory and its missing ancestors (`mkdir -p`). */
  mkdirp(path: string): void
  /** Make `newPath` a hard link to `existingPath`; fails when `newPath` exists. */
  link(existingPath: string, newPath: string): void
  /** Copy a file's bytes and mode to `dest`; fails when `dest` exists. */
  copyExclusive(src: string, dest: string): void
  /** Make `path` a symbolic link to `target`; fails when `path` exists. */
  symlink(target: string, path: string): void
  /** Rename `from` to `to`, replacing `to`. */
  rename(from: string, to: string): void
  /** Remove a file or a symbolic link. */
  unlink(path: string): void
  /** Read a file as UTF-8 text. */
  readText(path: string): string
}

/** The real file system, looked up at call time. */
export const NODE_CRON_TABLE_MIGRATION_FS: CronTableMigrationFs = {
  lstat: (path) => lstatSync(path),
  stat: (path) => statSync(path),
  realpath: (path) => realpathSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  link: (existingPath, newPath) => linkSync(existingPath, newPath),
  copyExclusive: (src, dest) => copyFileSync(src, dest, fsConstants.COPYFILE_EXCL),
  symlink: (target, path) => symlinkSync(target, path),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  readText: (path) => readFileSync(path, 'utf-8'),
}

/** The crontable paths the preparation compares, each absolute, and whether the default is in effect. */
export interface CronTablePaths {
  /** The crontable in effect: the start-time configuration's `cron_table_path`. */
  inEffect: string
  /**
   * Whether the start-time configuration left `cron_table_path` out, so
   * `inEffect` is the default the loader filled in
   * (`cron_table_path_defaulted`, config.ts). False for any path the
   * operator wrote, the default's own included: nothing is then prepared.
   */
  defaulted: boolean
  /** The default (`resolveDefaultCronTablePath`, config.ts). */
  defaultPath: string
  /** The pre-b.avm default, `<config dir>/crontab` (`legacyCronTablePath`, config.ts). */
  legacyPath: string
}

/** The preparation's dependencies. */
export interface CronTableMigrationDeps {
  /** Writes one server-log line. */
  log: (line: string) => void
  /** File-system overrides; unset operations use the real file system. */
  fs?: Partial<CronTableMigrationFs>
}

/** What the preparation did. */
export type CronTableMigrationOutcome =
  /** `cron_table_path` was written in the configuration (or is not the default): nothing done. */
  | { kind: 'not-default' }
  /** The default is the legacy path (`SLACK_STATE_DIR` set): nothing done. */
  | { kind: 'legacy-is-default' }
  /** Nothing (or a dangling symbolic link) at the legacy path. */
  | { kind: 'no-legacy' }
  /** Both paths already name the same file. */
  | { kind: 'already-migrated' }
  /**
   * The legacy file now lives at the new path and the legacy path links to
   * it: hard-linked (`link`), copied across file systems (`copy`), or an
   * interrupted move finished (`resumed`).
   */
  | { kind: 'moved'; via: 'link' | 'copy' | 'resumed' }
  /** The legacy path links to `target`; the new path now links there too. */
  | { kind: 'linked'; target: string }
  /** Files at both paths: the new one is used, the legacy one left untouched. */
  | { kind: 'both-exist' }
  /** The legacy path holds something other than a regular file: left alone. */
  | { kind: 'not-regular' }
  /**
   * A step failed, logged as one WARN. Before the file was in place at the
   * new path, nothing changed and this start runs on the legacy path
   * (`cronTablePathForStart`): making the default's directory (`mkdir`),
   * placing the file at the new path (`move`, a copy that changed while it was
   * made included) or looking at an entry (`unexpected`). After it was in
   * place, replacing the legacy path with a symbolic link (`swap`): the start
   * runs on the new path.
   */
  | { kind: 'failed'; step: 'mkdir' | 'move' | 'swap' | 'unexpected'; cause: string }

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

/** What every line naming the legacy path as the one this start runs on says. */
function runsOnLegacyClause(legacyPath: string): string {
  return (
    `This start runs on ${legacyPath}, the old location: the scheduler reads it and sessions launched now are ` +
    `given it as CSCB_CRONTABLE_PATH, so its schedules keep firing. The next start tries again.`
  )
}

/** The move's information line. */
export function cronTableMovedLine(legacyPath: string, defaultPath: string): string {
  return (
    `${CRON_MIGRATE_LOG_PREFIX} moved the crontable from ${legacyPath} to ${defaultPath}, its new default ` +
    `location outside ~/.claude; its lines are unchanged. ${legacyPath} is now a symbolic link to it, so a ` +
    `session whose CSCB_CRONTABLE_PATH still names the old path writes the same file.`
  )
}

/** The information line when the legacy path is a symbolic link to another file. */
export function cronTableLinkedLine(legacyPath: string, defaultPath: string, target: string): string {
  return (
    `${CRON_MIGRATE_LOG_PREFIX} ${legacyPath} is a symbolic link to ${target}; ${defaultPath}, the crontable's ` +
    `new default location, now links to the same file, and ${legacyPath} is left as it is.`
  )
}

/** The WARN when a crontable is at both paths. */
export function cronTableBothExistLine(legacyPath: string, defaultPath: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} a crontable exists both at ${defaultPath}, its default location, and at ` +
    `${legacyPath}, the old one. Using ${defaultPath}; ${legacyPath} is left untouched and its lines are not ` +
    `scheduled. Copy any line you still need into ${defaultPath}, then replace ${legacyPath} with a symbolic ` +
    `link to it (ln -sfn ${defaultPath} ${legacyPath}), so sessions that still name the old path write the ` +
    `file that is read.`
  )
}

/** The WARN when the legacy path holds something other than a regular file. */
export function cronTableNotRegularLine(legacyPath: string, defaultPath: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} ${legacyPath} is not a regular file, so nothing was moved to ${defaultPath}, ` +
    `the crontable's default location.`
  )
}

/** The WARN when the default's directory cannot be made; this start runs on the legacy path. */
export function cronTableMkdirFailedLine(dir: string, legacyPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} could not create ${dir}, the crontable's default directory: ${cause}. ` +
    `Nothing was moved. ${runsOnLegacyClause(legacyPath)} Create the directory, or set cron_table_path in ` +
    `config.json.`
  )
}

/**
 * The WARN when the file cannot be placed at the new path (or an entry cannot
 * be looked at); nothing changed, and this start runs on the legacy path.
 */
export function cronTableMoveFailedLine(legacyPath: string, defaultPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} could not move the crontable from ${legacyPath} to ${defaultPath}: ${cause}. ` +
    `Nothing was moved. ${runsOnLegacyClause(legacyPath)} To move it by hand: mv ${legacyPath} ${defaultPath} ` +
    `&& ln -s ${defaultPath} ${legacyPath}.`
  )
}

/**
 * The WARN when the file is at the new path but the legacy path could not be
 * replaced with a symbolic link. `sameFile`: the two names are one file (a
 * hard link), so appends at either are scheduled and the next start finishes
 * the swap; otherwise the legacy path holds a separate copy.
 */
export function cronTableSwapFailedLine(legacyPath: string, defaultPath: string, cause: string, sameFile: boolean): string {
  const state = sameFile
    ? `Both names are the same file for now, so a line appended at either is scheduled; the next start tries the link again.`
    : `${legacyPath} is a separate copy: a line appended there is not scheduled. Replace it with a symbolic link ` +
      `(ln -sfn ${defaultPath} ${legacyPath}).`
  return (
    `${CRON_MIGRATE_WARN_PREFIX} moved the crontable to ${defaultPath}, which is in use, but could not replace ` +
    `${legacyPath} with a symbolic link to it: ${cause}. ${state}`
  )
}

/** The information line when the prompts directory moved beside the crontable. */
export function cronPromptsMovedLine(legacyPromptsPath: string, newPromptsPath: string): string {
  return (
    `${CRON_MIGRATE_LOG_PREFIX} moved ${legacyPromptsPath} to ${newPromptsPath}, beside the crontable, so ` +
    `relative prompt paths such as ${CRON_PROMPTS_DIR_NAME}/<file> name the same files as before the move. ` +
    `${legacyPromptsPath} is now a symbolic link to it.`
  )
}

/** The WARN when the prompts directory cannot be moved; nothing was moved or linked. */
export function cronPromptsMoveFailedLine(legacyPromptsPath: string, newPromptsPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} could not move ${legacyPromptsPath} to ${newPromptsPath}: ${cause}. Nothing ` +
    `was moved or linked, so a crontable line whose prompt path starts with ${CRON_PROMPTS_DIR_NAME}/ no longer ` +
    `finds its prompt. Move it by hand (mv ${legacyPromptsPath} ${newPromptsPath} && ln -s ${newPromptsPath} ` +
    `${legacyPromptsPath}), or write the prompt's absolute path.`
  )
}

/**
 * The WARN when the prompts directory moved but no symbolic link could be
 * left at its old name.
 */
export function cronPromptsOldNameLinkFailedLine(legacyPromptsPath: string, newPromptsPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} moved ${legacyPromptsPath} to ${newPromptsPath}, but could not leave a ` +
    `symbolic link at ${legacyPromptsPath}: ${cause}. Relative prompt paths such as ` +
    `${CRON_PROMPTS_DIR_NAME}/<file> name the same files as before; a prompt path naming the old directory ` +
    `no longer finds its prompt. Link it by hand (ln -s ${newPromptsPath} ${legacyPromptsPath}).`
  )
}

/**
 * The WARN when the prompts directory could not be moved because the two
 * folders are on different file systems, so the new name links to the old
 * directory instead.
 */
export function cronPromptsLinkedAcrossFileSystemsLine(newPromptsPath: string, legacyPromptsPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} could not move ${legacyPromptsPath} to ${newPromptsPath}, which is on another ` +
    `file system: ${cause}. Linked ${newPromptsPath} to ${legacyPromptsPath} instead, so relative prompt paths ` +
    `such as ${CRON_PROMPTS_DIR_NAME}/<file> name the same files as before the move; a prompt file written ` +
    `through either name still lands in ${legacyPromptsPath}, under ~/.claude. To move it by hand: ` +
    `rm ${newPromptsPath} && mv ${legacyPromptsPath} ${newPromptsPath} && ln -s ${newPromptsPath} ${legacyPromptsPath}.`
  )
}

/** The information line when the new prompts name links to the directory the legacy prompts link names. */
export function cronPromptsLinkedLine(newPromptsPath: string, targetPath: string): string {
  return (
    `${CRON_MIGRATE_LOG_PREFIX} linked ${newPromptsPath} to ${targetPath}, so relative prompt paths ` +
    `such as ${CRON_PROMPTS_DIR_NAME}/<file> name the same files as before the move.`
  )
}

/** The WARN when the new prompts name cannot be linked. */
export function cronPromptsLinkFailedLine(newPromptsPath: string, targetPath: string, cause: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} could not link ${newPromptsPath} to ${targetPath}: ${cause}. A crontable ` +
    `line whose prompt path starts with ${CRON_PROMPTS_DIR_NAME}/ no longer finds its prompt; write its absolute path.`
  )
}

/** The WARN for a crontable line whose relative prompt path no longer names its file. */
export function cronRelativePromptMovedLine(lineNumber: number, promptPath: string, before: string, after: string): string {
  return (
    `${CRON_MIGRATE_WARN_PREFIX} crontable line ${lineNumber}: the relative prompt path ${promptPath} named ` +
    `${before} before the move and now names ${after}, which does not exist, so it fires prompt-missing. ` +
    `Write the absolute path ${before} in that line.`
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The entry at `path` (not followed), or undefined when there is none. Other errors are thrown. */
function lstatIfPresent(fs: CronTableMigrationFs, path: string): CronTableEntryStat | undefined {
  try {
    return fs.lstat(path)
  } catch (err) {
    if (ABSENT_CODES.has(errnoCode(err) ?? '')) return undefined
    throw err
  }
}

/** The entry at `path` (not followed), or undefined when it cannot be read. */
function lstatOrUndefined(fs: CronTableMigrationFs, path: string): CronTableEntryStat | undefined {
  try {
    return fs.lstat(path)
  } catch {
    return undefined
  }
}

/** The entry `path` names (followed), or undefined when it cannot be read. */
function statOrUndefined(fs: CronTableMigrationFs, path: string): CronTableEntryStat | undefined {
  try {
    return fs.stat(path)
  } catch {
    return undefined
  }
}

/** The real path, or undefined when it cannot be resolved (a dangling link, say). */
function realpathOrUndefined(fs: CronTableMigrationFs, path: string): string | undefined {
  try {
    return fs.realpath(path)
  } catch {
    return undefined
  }
}

/** Remove a name this module made under a temporary name; one that cannot be removed is left. */
function removeTemporary(fs: CronTableMigrationFs, path: string): void {
  try {
    fs.unlink(path)
  } catch {
    // Left behind: a temporary name, which names only this module's own link or copy.
  }
}

/** Whether two entries are one file (the same inode on the same device). */
function isSameInode(a: CronTableEntryStat, b: CronTableEntryStat): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Whether a file is unchanged between two looks: the same inode, size and modification time. */
function isUnchanged(before: CronTableEntryStat, after: CronTableEntryStat | undefined): boolean {
  return after !== undefined && isSameInode(before, after) && before.size === after.size && before.mtimeMs === after.mtimeMs
}

/** A name beside `path` for a link or copy that is later renamed or linked into place. */
function tempNameBeside(path: string): string {
  return join(dirname(path), `.${basename(path)}.cscb-migrate-${process.pid}-${randomBytes(4).toString('hex')}`)
}

// ---------------------------------------------------------------------------
// The move's steps
// ---------------------------------------------------------------------------

/** Where `placeAtNewPath` left the file. */
type Placement =
  | { ok: true; via: 'link' }
  /** `copyTemp`: the copy's temporary name, a second name of the placed copy, removed once the swap is done. */
  | { ok: true; via: 'copy'; copyTemp: string }
  | { ok: false; exists: boolean; cause: string }

/**
 * Place the legacy file at the new path without touching either's bytes: a
 * hard link, or, where a hard link cannot be made, a copy. Neither replaces
 * an existing file.
 */
function placeAtNewPath(fs: CronTableMigrationFs, paths: CronTablePaths): Placement {
  try {
    fs.link(paths.legacyPath, paths.defaultPath)
    return { ok: true, via: 'link' }
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'EEXIST') return { ok: false, exists: true, cause: describe(err) }
    if (!LINK_UNSUPPORTED_CODES.has(code ?? '')) return { ok: false, exists: false, cause: describe(err) }
  }
  return copyToNewPath(fs, paths)
}

/**
 * Copy the legacy file (bytes and mode) to a temporary name beside the new
 * path, check that the legacy file did not change while it was copied, then
 * hard-link the copy into place, which fails on an existing file. Only the
 * temporary name is ever removed: a failed or stale copy is discarded there,
 * before it is placed.
 */
function copyToNewPath(fs: CronTableMigrationFs, paths: CronTablePaths): Placement {
  let before: CronTableEntryStat
  try {
    before = fs.lstat(paths.legacyPath)
  } catch (err) {
    return { ok: false, exists: false, cause: describe(err) }
  }
  const copyTemp = tempNameBeside(paths.defaultPath)
  try {
    fs.copyExclusive(paths.legacyPath, copyTemp)
  } catch (err) {
    // A copy that failed after it created its file leaves a partial one under
    // the temporary name, which is this copy's own (EEXIST: the name was
    // another's, so it is left).
    if (errnoCode(err) !== 'EEXIST') removeTemporary(fs, copyTemp)
    return { ok: false, exists: false, cause: describe(err) }
  }
  // A line appended at the legacy path while it was copied is not in the copy.
  if (!isUnchanged(before, lstatOrUndefined(fs, paths.legacyPath))) {
    removeTemporary(fs, copyTemp)
    return { ok: false, exists: false, cause: CRON_TABLE_CHANGED_DURING_COPY_CAUSE }
  }
  try {
    fs.link(copyTemp, paths.defaultPath)
  } catch (err) {
    removeTemporary(fs, copyTemp)
    return { ok: false, exists: errnoCode(err) === 'EEXIST', cause: describe(err) }
  }
  return { ok: true, via: 'copy', copyTemp }
}

/**
 * The file is in place at the new path, and `legacyLink`, beside the legacy
 * path, links to it: rename the link over the legacy path, which swaps the
 * name in one step, then carry the prompts.
 */
function swapLegacyName(
  fs: CronTableMigrationFs,
  paths: CronTablePaths,
  log: (line: string) => void,
  legacyLink: string,
  via: 'link' | 'copy' | 'resumed',
): CronTableMigrationOutcome {
  let outcome: CronTableMigrationOutcome = { kind: 'moved', via }
  try {
    fs.rename(legacyLink, paths.legacyPath)
  } catch (err) {
    removeTemporary(fs, legacyLink)
    const cause = describe(err)
    log(cronTableSwapFailedLine(paths.legacyPath, paths.defaultPath, cause, via !== 'copy'))
    outcome = { kind: 'failed', step: 'swap', cause }
  }
  if (outcome.kind === 'moved') log(cronTableMovedLine(paths.legacyPath, paths.defaultPath))
  carryRelativePrompts(fs, paths, log)
  return outcome
}

/** Move a regular legacy file to the new path (nothing is at the new path). */
function moveLegacyFile(fs: CronTableMigrationFs, paths: CronTablePaths, log: (line: string) => void): CronTableMigrationOutcome {
  // The link that replaces the legacy path is made first, so a legacy
  // directory that cannot take it stops the move before anything changed.
  const legacyLink = tempNameBeside(paths.legacyPath)
  try {
    fs.symlink(paths.defaultPath, legacyLink)
  } catch (err) {
    const cause = describe(err)
    log(cronTableMoveFailedLine(paths.legacyPath, paths.defaultPath, cause))
    return { kind: 'failed', step: 'move', cause }
  }
  const placed = placeAtNewPath(fs, paths)
  if (!placed.ok) {
    removeTemporary(fs, legacyLink)
    if (placed.exists) {
      log(cronTableBothExistLine(paths.legacyPath, paths.defaultPath))
      return { kind: 'both-exist' }
    }
    log(cronTableMoveFailedLine(paths.legacyPath, paths.defaultPath, placed.cause))
    return { kind: 'failed', step: 'move', cause: placed.cause }
  }
  const outcome = swapLegacyName(fs, paths, log, legacyLink, placed.via)
  if (placed.via === 'copy') removeTemporary(fs, placed.copyTemp)
  return outcome
}

/** An earlier move placed the file (one inode under both names) and stopped before the swap: finish it. */
function finishInterruptedMove(fs: CronTableMigrationFs, paths: CronTablePaths, log: (line: string) => void): CronTableMigrationOutcome {
  const legacyLink = tempNameBeside(paths.legacyPath)
  try {
    fs.symlink(paths.defaultPath, legacyLink)
  } catch (err) {
    const cause = describe(err)
    log(cronTableSwapFailedLine(paths.legacyPath, paths.defaultPath, cause, true))
    carryRelativePrompts(fs, paths, log)
    return { kind: 'failed', step: 'swap', cause }
  }
  return swapLegacyName(fs, paths, log, legacyLink, 'resumed')
}

/**
 * The legacy prompts directory is a symbolic link to a directory (its real
 * path `target`): the new name links to that same directory, and the legacy
 * link is left as it is.
 */
function linkPromptsToTarget(
  fs: CronTableMigrationFs,
  newPrompts: string,
  target: string,
  log: (line: string) => void,
): void {
  try {
    fs.symlink(target, newPrompts)
  } catch (err) {
    log(cronPromptsLinkFailedLine(newPrompts, target, describe(err)))
    return
  }
  log(cronPromptsLinkedLine(newPrompts, target))
}

/**
 * Move the legacy prompts directory into the new folder, leaving a symbolic
 * link at its old name (see the module header). Nothing is at `newPrompts`.
 */
function movePromptsDir(
  fs: CronTableMigrationFs,
  legacyPrompts: string,
  newPrompts: string,
  log: (line: string) => void,
): void {
  // The old name's link is made first, so a directory that cannot take it
  // stops the move before anything changed.
  const oldNameLink = tempNameBeside(legacyPrompts)
  try {
    fs.symlink(newPrompts, oldNameLink)
  } catch (err) {
    log(cronPromptsMoveFailedLine(legacyPrompts, newPrompts, describe(err)))
    return
  }
  try {
    fs.rename(legacyPrompts, newPrompts)
  } catch (err) {
    removeTemporary(fs, oldNameLink)
    if (errnoCode(err) !== 'EXDEV') {
      log(cronPromptsMoveFailedLine(legacyPrompts, newPrompts, describe(err)))
      return
    }
    // Another file system: the directory stays, and the new name links to it.
    const crossCause = describe(err)
    try {
      fs.symlink(legacyPrompts, newPrompts)
    } catch (linkErr) {
      log(cronPromptsLinkFailedLine(newPrompts, legacyPrompts, describe(linkErr)))
      return
    }
    log(cronPromptsLinkedAcrossFileSystemsLine(newPrompts, legacyPrompts, crossCause))
    return
  }
  try {
    fs.rename(oldNameLink, legacyPrompts)
  } catch (err) {
    removeTemporary(fs, oldNameLink)
    log(cronPromptsOldNameLinkFailedLine(legacyPrompts, newPrompts, describe(err)))
    return
  }
  log(cronPromptsMovedLine(legacyPrompts, newPrompts))
}

/**
 * The start runs on the new path after the crontable moved or was linked
 * there: carry the prompts directory, then WARN for each line whose relative
 * prompt path no longer names an existing file (see the module header).
 */
function carryRelativePrompts(fs: CronTableMigrationFs, paths: CronTablePaths, log: (line: string) => void): void {
  const legacyPrompts = join(dirname(paths.legacyPath), CRON_PROMPTS_DIR_NAME)
  const newPrompts = join(dirname(paths.defaultPath), CRON_PROMPTS_DIR_NAME)
  const legacyEntry = lstatOrUndefined(fs, legacyPrompts)
  if (legacyEntry !== undefined) {
    let newPromptsTaken = true
    try {
      newPromptsTaken = lstatIfPresent(fs, newPrompts) !== undefined
    } catch {
      // Cannot be looked at: treat it as taken and leave it alone.
    }
    if (!newPromptsTaken) {
      if (legacyEntry.isSymbolicLink()) {
        const target = realpathOrUndefined(fs, legacyPrompts)
        if (target !== undefined && statOrUndefined(fs, target)?.isDirectory() === true) {
          linkPromptsToTarget(fs, newPrompts, target, log)
        }
      } else if (legacyEntry.isDirectory()) {
        movePromptsDir(fs, legacyPrompts, newPrompts, log)
      }
    }
  }

  let text: string
  try {
    text = fs.readText(paths.defaultPath)
  } catch {
    return // The scheduler reports a crontable it cannot read.
  }
  for (const schedule of parseCrontable(text).schedules) {
    const before = resolvePromptPath(schedule.promptPath, paths.legacyPath)
    const after = resolvePromptPath(schedule.promptPath, paths.defaultPath)
    if (before === after) continue
    if (statOrUndefined(fs, before) !== undefined && statOrUndefined(fs, after) === undefined) {
      log(cronRelativePromptMovedLine(schedule.lineNumber, schedule.promptPath, before, after))
    }
  }
}

/**
 * The legacy path is a symbolic link whose real path is `target`, and nothing
 * is at the new path.
 */
function linkToLegacyTarget(
  fs: CronTableMigrationFs,
  paths: CronTablePaths,
  log: (line: string) => void,
  target: string,
): CronTableMigrationOutcome {
  if (statOrUndefined(fs, target)?.isFile() !== true) {
    log(cronTableNotRegularLine(paths.legacyPath, paths.defaultPath))
    return { kind: 'not-regular' }
  }
  try {
    fs.symlink(target, paths.defaultPath)
  } catch (err) {
    const cause = describe(err)
    if (errnoCode(err) === 'EEXIST') {
      log(cronTableBothExistLine(paths.legacyPath, paths.defaultPath))
      return { kind: 'both-exist' }
    }
    log(cronTableMoveFailedLine(paths.legacyPath, paths.defaultPath, cause))
    return { kind: 'failed', step: 'move', cause }
  }
  log(cronTableLinkedLine(paths.legacyPath, paths.defaultPath, target))
  carryRelativePrompts(fs, paths, log)
  return { kind: 'linked', target }
}

/** Decide and run the move once the default's directory exists. */
function migrate(fs: CronTableMigrationFs, paths: CronTablePaths, log: (line: string) => void): CronTableMigrationOutcome {
  const legacy = lstatIfPresent(fs, paths.legacyPath)
  if (legacy === undefined) return { kind: 'no-legacy' }
  // The file the legacy path names, links followed.
  const legacyFile = statOrUndefined(fs, paths.legacyPath)
  // A dangling symbolic link holds no schedules (the link an earlier move
  // left, whose crontable was deleted since, is one: the bootstrap re-creates it).
  if (legacyFile === undefined && legacy.isSymbolicLink()) return { kind: 'no-legacy' }
  const current = lstatIfPresent(fs, paths.defaultPath)

  if (current !== undefined) {
    // One file under both names, neither a link: an earlier move stopped after placing it.
    if (legacy.isFile() && current.isFile() && isSameInode(legacy, current)) {
      return finishInterruptedMove(fs, paths, log)
    }
    // Both names reach one file through links, whichever way they point.
    const currentFile = statOrUndefined(fs, paths.defaultPath)
    if (legacyFile !== undefined && currentFile !== undefined && isSameInode(legacyFile, currentFile)) {
      return { kind: 'already-migrated' }
    }
    log(cronTableBothExistLine(paths.legacyPath, paths.defaultPath))
    return { kind: 'both-exist' }
  }

  // A link that resolves (its target's real path; a failure here is unexpected,
  // since the link was just followed).
  if (legacy.isSymbolicLink()) return linkToLegacyTarget(fs, paths, log, fs.realpath(paths.legacyPath))
  if (!legacy.isFile()) {
    log(cronTableNotRegularLine(paths.legacyPath, paths.defaultPath))
    return { kind: 'not-regular' }
  }
  return moveLegacyFile(fs, paths, log)
}

// ---------------------------------------------------------------------------
// prepareDefaultCronTable
// ---------------------------------------------------------------------------

/**
 * Prepare the default crontable location at a start, and move a crontable
 * left at the old default (see the module header). Never throws. The
 * crontable the start runs on is `cronTablePathForStart(paths, outcome)`.
 */
export function prepareDefaultCronTable(paths: CronTablePaths, deps: CronTableMigrationDeps): CronTableMigrationOutcome {
  const fs: CronTableMigrationFs = { ...NODE_CRON_TABLE_MIGRATION_FS, ...deps.fs }
  const { log } = deps
  if (!paths.defaulted || paths.inEffect !== paths.defaultPath) return { kind: 'not-default' }
  if (paths.defaultPath === paths.legacyPath) return { kind: 'legacy-is-default' }

  const dir = dirname(paths.defaultPath)
  try {
    fs.mkdirp(dir)
  } catch (err) {
    const cause = describe(err)
    log(cronTableMkdirFailedLine(dir, paths.legacyPath, cause))
    return { kind: 'failed', step: 'mkdir', cause }
  }

  try {
    return migrate(fs, paths, log)
  } catch (err) {
    // An entry that could not be looked at (EACCES on an lstat, say); nothing changed.
    const cause = describe(err)
    log(cronTableMoveFailedLine(paths.legacyPath, paths.defaultPath, cause))
    return { kind: 'failed', step: 'unexpected', cause }
  }
}

/**
 * The crontable this start runs on, from the preparation's outcome: the
 * legacy path when a step failed before the file was in place at the new
 * path (`failed` with step `mkdir`, `move` or `unexpected`: nothing changed,
 * so the schedules are still there), otherwise the crontable in effect. The
 * caller puts it in the server's start-time configuration, which the
 * scheduler reads and every launch, the start bring-up's included, exports as
 * `CSCB_CRONTABLE_PATH` (see the module header). Pure.
 */
export function cronTablePathForStart(paths: CronTablePaths, outcome: CronTableMigrationOutcome): string {
  return outcome.kind === 'failed' && outcome.step !== 'swap' ? paths.legacyPath : paths.inEffect
}
