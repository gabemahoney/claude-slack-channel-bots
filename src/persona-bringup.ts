/**
 * persona-bringup.ts — Working-directory check and the local bring-up checks
 * (b.av2 SR-6.1 steps 1 and 2).
 *
 * Step 1 is the local credentials check (`checkPersonaCredentials` in
 * `persona-credentials.ts`); step 2 is the working-directory check here: the
 * directory exists, is a directory, is readable and searchable, and its real
 * path is no other applied persona's working directory. Outcomes map to the
 * b.av2 SR-10.3 classes `persona-directory-missing` / `-unusable`.
 *
 * `checkPersonaLocalBringUp` always runs both steps, so when both fail both
 * causes are reported. `checkPersonaWorkingDirectory` also runs on its own
 * and reads no credentials file, for a dry-run bring-up (b.av2 SR-3.4).
 *
 * These are pure checks: no Slack call, no agent-director call, no
 * environment access, no writes, no lock, queue, timer or module-scope state.
 * The server runs them as steps 1 and 2 of each persona's start
 * (`checkPersonaLocalSteps` in `persona-start.ts`); the broken/retrying
 * outcomes and the directory-retry timers are the bring-up controller's
 * (`persona-bringup-controller.ts`).
 *
 * `checkPersonaConfigDir` (bug b.g57) checks a persona's effective
 * claude_config_dir: its real path with no lexical fallback
 * (`resolveRealPathStrict`), or `persona-config-dir-unresolvable`. The
 * session manager runs it before every launch; the bring-up controller runs
 * it right before a persona's Slack step and re-checks it while the persona
 * is held, with no Slack connection, for the directory; the reload preview
 * runs it on each added persona.
 *
 * Logging contract (same as `persona-credentials.ts`): every failure's
 * formatted line is returned; when a `log` is passed each failure line is
 * emitted through it exactly once per call; with none nothing is emitted.
 *
 * File-system seam: every file-system access goes through a
 * `WorkingDirectoryFs` (`stat`, `access`, `realpath`); the real file system
 * (`DEFAULT_WORKING_DIRECTORY_FS`) is the default and callers may override
 * any subset via `options.fs`. Tests use it to simulate unreadable or
 * unsearchable directories even when running as root: make `access` throw an
 * error with `code: 'EACCES'` for `fs.constants.R_OK` or `X_OK`. The combined
 * check takes a `PersonaBringUpFs`, the union of both seams; the credentials
 * seam stats through a descriptor (`fstatFile`), so a `stat` override reaches
 * only this check.
 *
 * Pure module (b.av2 SR-13.1): nothing runs at import.
 *
 * SPDX-License-Identifier: MIT
 */

import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs'

import { resolveRealPathStrict, type Persona, type StrictRealPathFs } from './config.ts'
import {
  checkPersonaCredentialsAndDigest,
  describeRealPathCollision,
  errnoSuffix,
  isMissingPathError,
  type CredentialsCheckResult,
  type CredentialsDigest,
  type CredentialsFs,
  type CredentialsPersona,
  type OtherCredentialsPersona,
} from './persona-credentials.ts'
import {
  PERSONA_CONFIG_DIR_UNRESOLVABLE,
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  personaCheckFailure,
  type PersonaCheckFailure,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'
import { resolveClaudeConfigDir } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// File-system seam
// ---------------------------------------------------------------------------

/** The file-system operations the working-directory check performs. */
export interface WorkingDirectoryFs {
  /** Stat a path, following symlinks. Throws an errno-style error (with `code`) on failure. */
  stat(path: string): { isDirectory(): boolean }
  /** Check access for `mode` (`fs.constants.R_OK` or `X_OK`). Throws an errno-style error when denied. */
  access(path: string, mode: number): void
  /** Resolve a path's real path. Throws on failure; callers fall back to the lexical form. */
  realpath(path: string): string
}

/** The real file system, looked up at call time. */
export const DEFAULT_WORKING_DIRECTORY_FS: WorkingDirectoryFs = {
  stat: path => statSync(path),
  access: (path, mode) => accessSync(path, mode),
  realpath: path => realpathSync(path),
}

/** Both checks' file-system operations. */
export type PersonaBringUpFs = CredentialsFs & WorkingDirectoryFs

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The persona whose working directory is checked. */
export type WorkingDirectoryPersona = Pick<Persona, 'index' | 'name' | 'key' | 'working_directory'>

/** Another applied persona, as far as the working-directory collision rule needs it. */
export type OtherWorkingDirectoryPersona = Pick<Persona, 'name' | 'key' | 'working_directory'>

/** A working-directory failure class. */
export type WorkingDirectoryDiagnosticClass = typeof PERSONA_DIRECTORY_MISSING | typeof PERSONA_DIRECTORY_UNUSABLE

/** Result of `checkPersonaWorkingDirectory`. */
export type WorkingDirectoryCheckResult = { ok: true } | PersonaCheckFailure<WorkingDirectoryDiagnosticClass>

/** Options for `checkPersonaWorkingDirectory`. */
export interface CheckPersonaWorkingDirectoryOptions {
  /**
   * The other applied personas. An entry with the checked persona's own key is
   * skipped, so the full applied list may be passed.
   */
  others: readonly OtherWorkingDirectoryPersona[]
  /** File-system overrides; unset operations use `DEFAULT_WORKING_DIRECTORY_FS`. */
  fs?: Partial<WorkingDirectoryFs>
  /** When given, a failure's line is emitted through it exactly once. */
  log?: PersonaDiagnosticLogger
}

/** The persona brought up: identity plus both paths. */
export type BringUpPersona = CredentialsPersona & WorkingDirectoryPersona

/** Another applied persona, as far as both collision rules need it. */
export type OtherBringUpPersona = OtherCredentialsPersona & OtherWorkingDirectoryPersona

/** Options for `checkPersonaLocalBringUp`. */
export interface CheckPersonaLocalBringUpOptions {
  /** The other applied personas; an entry with the persona's own key is skipped. */
  others: readonly OtherBringUpPersona[]
  /** File-system overrides; unset operations use the real file system. */
  fs?: Partial<PersonaBringUpFs>
  /** When given, each failure line is emitted through it exactly once, credentials first. */
  log?: PersonaDiagnosticLogger
}

/** Result of `checkPersonaLocalBringUp`: both steps' outcomes, never short-circuited. */
export interface LocalBringUpResult {
  /** True when both steps passed. */
  ok: boolean
  /** Step 1; carries the tokens on success. */
  credentials: CredentialsCheckResult
  /** Step 2. */
  directory: WorkingDirectoryCheckResult
  /** Every failure, credentials first then directory; empty when `ok`. */
  failures: PersonaCheckFailure[]
  /**
   * The digest or marker of the persona's own credentials file as step 1
   * read it (`credentialsDigest`), for the bring-up to hold (b.av2 SR-8.3),
   * whatever step 1's outcome, a real-path collision included (the file is
   * then only hashed, never parsed). Always set by
   * `checkPersonaLocalBringUp`; optional so an injected check may omit it.
   * Never logged.
   */
  credentialsDigest?: CredentialsDigest
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Check a persona's working directory (b.av2 SR-6.1 step 2). Checks, in order:
 *
 *   1. its real path (`resolveRealPath`, lexical fallback) is no other
 *      applied persona's working directory → else `persona-directory-unusable`,
 *      naming the other persona;
 *   2. it exists → else `persona-directory-missing`;
 *   3. it is a directory (after following symlinks), is readable and is
 *      searchable → else `persona-directory-unusable`.
 *
 * `persona.working_directory` must already be absolute and tilde-expanded.
 * Reads no credentials file. Never throws for a string path.
 */
export function checkPersonaWorkingDirectory(
  persona: WorkingDirectoryPersona,
  options: CheckPersonaWorkingDirectoryOptions,
): WorkingDirectoryCheckResult {
  const fs: WorkingDirectoryFs = { ...DEFAULT_WORKING_DIRECTORY_FS, ...options.fs }
  const path = persona.working_directory
  const fail = (cls: WorkingDirectoryDiagnosticClass, cause: string) =>
    personaCheckFailure({ class: cls, name: persona.name, key: persona.key, index: persona.index, path, cause }, options.log)

  const collision = describeRealPathCollision(path, persona.key, options.others, 'working_directory', p => fs.realpath(p))
  if (collision !== undefined) return fail(PERSONA_DIRECTORY_UNUSABLE, collision)

  let isDirectory: boolean
  try {
    isDirectory = fs.stat(path).isDirectory()
  } catch (err) {
    if (isMissingPathError(err)) return fail(PERSONA_DIRECTORY_MISSING, 'working directory does not exist')
    return fail(PERSONA_DIRECTORY_UNUSABLE, `working directory cannot be inspected${errnoSuffix(err)}`)
  }
  if (!isDirectory) return fail(PERSONA_DIRECTORY_UNUSABLE, 'working directory is not a directory')

  try {
    fs.access(path, fsConstants.R_OK)
  } catch (err) {
    return fail(PERSONA_DIRECTORY_UNUSABLE, `working directory is not readable${errnoSuffix(err)}`)
  }
  try {
    fs.access(path, fsConstants.X_OK)
  } catch (err) {
    return fail(PERSONA_DIRECTORY_UNUSABLE, `working directory is not searchable${errnoSuffix(err)}`)
  }
  return { ok: true }
}

/** The persona whose effective claude_config_dir is checked (`checkPersonaConfigDir`). */
export type ConfigDirPersona = Pick<Persona, 'index' | 'name' | 'key' | 'claude_config_dir'>

/**
 * Result of `checkPersonaConfigDir`: the directory's real path (or the one it
 * will have once created), or the failure. A failure's `problem` is its cause
 * without the consequence for a held persona (`claude_config_dir cannot be
 * resolved to a real path (<errno>)`), for a reader that words the
 * consequence itself (the reload preview of an added persona).
 */
export type ConfigDirCheckResult =
  | { ok: true; realPath: string }
  | (PersonaCheckFailure<typeof PERSONA_CONFIG_DIR_UNRESOLVABLE> & { problem: string })

/** Options for `checkPersonaConfigDir`. */
export interface CheckPersonaConfigDirOptions {
  /** Home directory for `~` and an unset directory (`<home>/.claude`); defaults to the OS home, read at call time. */
  home?: string
  /** File-system overrides for the resolution; unset operations use the real file system. */
  fs?: Partial<StrictRealPathFs>
  /** When given, a failure's line is emitted through it exactly once. */
  log?: PersonaDiagnosticLogger
}

/** What a `persona-config-dir-unresolvable` cause says after the resolution failure. */
const CONFIG_DIR_UNRESOLVABLE_CONSEQUENCE = 'its Slack connection is closed and its launch waits until it resolves'

/**
 * Check that a persona's effective claude_config_dir can be resolved to a
 * real path before it connects to Slack and before it is launched (bug
 * b.g57), with `resolveRealPathStrict`:
 * no lexical fallback. A directory not created yet under a resolvable
 * ancestor passes, with the real path it will have. A symlink on its path
 * that points to nothing, or any other resolution failure, is
 * `persona-config-dir-unresolvable`, naming the configured directory
 * (tilde-expanded and absolute; `<home>/.claude` when none is configured) as
 * its path and the errno code in its cause. Never throws; opens nothing.
 */
export function checkPersonaConfigDir(
  persona: ConfigDirPersona,
  options: CheckPersonaConfigDirOptions = {},
): ConfigDirCheckResult {
  const path = resolveClaudeConfigDir(persona.claude_config_dir, options.home)
  const resolution = resolveRealPathStrict(path, options.fs)
  if (resolution.resolved) return { ok: true, realPath: resolution.path }
  const reason = resolution.danglingSymlink
    ? `${resolution.code}: a symlink on its path points to nothing`
    : resolution.code
  const problem = `claude_config_dir cannot be resolved to a real path (${reason})`
  const failure = personaCheckFailure(
    {
      class: PERSONA_CONFIG_DIR_UNRESOLVABLE,
      name: persona.name,
      key: persona.key,
      index: persona.index,
      path,
      cause: `${problem}; ${CONFIG_DIR_UNRESOLVABLE_CONSEQUENCE}`,
    },
    options.log,
  )
  return { ...failure, problem }
}

/**
 * Run the local bring-up checks (b.av2 SR-6.1 steps 1 and 2): the credentials
 * check and the working-directory check, always both, so a failure in one
 * never hides the other. Makes no Slack or agent-director call and reads no
 * environment variable. With a `log`, each failure line is emitted exactly
 * once (the sub-checks run without it, so none is emitted twice).
 */
export function checkPersonaLocalBringUp(
  persona: BringUpPersona,
  options: CheckPersonaLocalBringUpOptions,
): LocalBringUpResult {
  const { others, fs } = options
  const { result: credentials, digest } = checkPersonaCredentialsAndDigest(persona, { others, fs })
  const directory = checkPersonaWorkingDirectory(persona, { others, fs })
  const failures: PersonaCheckFailure[] = []
  if (!credentials.ok) failures.push(credentials)
  if (!directory.ok) failures.push(directory)
  for (const failure of failures) options.log?.(failure.line)
  return { ok: failures.length === 0, credentials, directory, failures, credentialsDigest: digest }
}
