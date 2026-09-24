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

import type { Persona } from './config.ts'
import {
  checkPersonaCredentials,
  describeRealPathCollision,
  errnoSuffix,
  isMissingPathError,
  type CredentialsCheckResult,
  type CredentialsFs,
  type CredentialsPersona,
  type OtherCredentialsPersona,
} from './persona-credentials.ts'
import {
  PERSONA_DIRECTORY_MISSING,
  PERSONA_DIRECTORY_UNUSABLE,
  personaCheckFailure,
  type PersonaCheckFailure,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'

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
  const credentials = checkPersonaCredentials(persona, { others, fs })
  const directory = checkPersonaWorkingDirectory(persona, { others, fs })
  const failures: PersonaCheckFailure[] = []
  if (!credentials.ok) failures.push(credentials)
  if (!directory.ok) failures.push(directory)
  for (const failure of failures) options.log?.(failure.line)
  return { ok: failures.length === 0, credentials, directory, failures }
}
