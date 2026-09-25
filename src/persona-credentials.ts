/**
 * persona-credentials.ts — Persona credentials-file reader and local validity
 * check (b.av2 SR-1.4; step 1 of the SR-6.1 bring-up).
 *
 * A persona's Slack tokens live only in its own credentials file: a JSON
 * object with exactly two string keys, `bot_token` (prefix `xoxb-`) and
 * `app_token` (prefix `xapp-`). The file is locally valid when its real path
 * is no other applied persona's credentials file, and it exists, is readable,
 * parses and has that shape. Outcomes map to the b.av2 SR-10.3 classes
 * `persona-credentials-missing` / `-unreadable` / `-invalid`.
 *
 * Secrets rules:
 * - Never reads an environment variable (in particular no Slack token
 *   variable).
 * - Never writes, copies, caches or persists the file or any value from it,
 *   and never checks or changes the file mode. Only a digest of the bytes
 *   leaves the check, for the bring-up to hold in memory.
 * - Causes and diagnostic lines name a bad token by its key and the rule it
 *   breaks, never its value; a JSON parse failure is described generically
 *   (the runtime's parse message can quote file contents); unexpected keys
 *   are counted, not named (a stray key could itself be a token).
 * - The success value (`PersonaSlackTokens`) redacts itself when
 *   JSON-stringified, string-converted or inspected, so logging it by
 *   accident prints no token.
 *
 * Logging contract: the check always returns the formatted diagnostic line in
 * its failure result. When a `log` is passed it emits that line through it
 * exactly once per call; with none it emits nothing. The module never writes
 * to `console`, `logging.ts` or `startup-errors.log` itself.
 *
 * File-system seam: every file-system access goes through a `CredentialsFs`
 * (`openFile`, `fstatFile`, `readFileFd`, `closeFile`, `realpath`); the real
 * file system (`DEFAULT_CREDENTIALS_FS`) is the default and callers may
 * override any subset via `options.fs`. Tests use it to simulate unreadable
 * files even when running as root: make `openFile` or `readFileFd` throw an
 * error whose `code` is `EACCES`, `EISDIR`, `ENOENT`, …, or make `fstatFile`
 * report a FIFO or a device. The file is opened once, read-only and
 * non-blocking (following symlinks), and its descriptor is stat'ed, read and
 * closed, so the file checked is the file read. Anything but a regular file
 * is refused unread: a FIFO would block the read forever and a device such as
 * `/dev/zero` would never end.
 *
 * Reader and digest (b.av2 SR-8.3): the stat-first read is its own export,
 * `readCredentialsFile`, and `credentialsDigest` turns a read into what is
 * held for it: the SHA-256 of the exact bytes, or a marker for a missing or an
 * unreadable file. The check returns that digest beside its result, whatever
 * the outcome (`checkPersonaCredentialsAndDigest`), so the bring-up can hold
 * it; a file whose real path another applied persona shares is read only to
 * be hashed there, never parsed, and no token is taken from it. The
 * reload detection tick reads and digests each referenced file the same way.
 * A digest is held in memory only and never logged.
 *
 * Pure module (b.av2 SR-13.1): nothing runs at import and no token is read at
 * module scope. The server runs it as step 1 of each persona's start
 * (`checkPersonaLocalSteps` in `persona-start.ts`).
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'

import { resolveRealPath, type Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import {
  PERSONA_CREDENTIALS_INVALID,
  PERSONA_CREDENTIALS_MISSING,
  PERSONA_CREDENTIALS_UNREADABLE,
  personaCheckFailure,
  type PersonaCheckFailure,
  type PersonaDiagnosticLogger,
} from './persona-diagnostics.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Required prefix of `bot_token`. */
export const BOT_TOKEN_PREFIX = 'xoxb-'

/** Required prefix of `app_token`. */
export const APP_TOKEN_PREFIX = 'xapp-'

/** The credentials file's keys, each with its required prefix, in the order they are checked. */
const CREDENTIALS_KEYS = [
  ['bot_token', BOT_TOKEN_PREFIX],
  ['app_token', APP_TOKEN_PREFIX],
] as const

/** What a redacted token renders as. */
const REDACTED = '[redacted]'

/** errno codes meaning the path does not exist (ENOTDIR: an ancestor is not a directory). */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/** An errno code that is safe to echo: `E` plus upper-case letters and digits. */
const ERRNO_CODE_RE = /^E[A-Z0-9]+$/

/**
 * Any whitespace (`\s`, which includes U+2028/U+2029) or control character
 * (`\p{Cc}`: C0, DEL, C1). A token containing one — e.g. a trailing newline —
 * would make the Slack client throw locally rather than reach Slack.
 */
const TOKEN_FORBIDDEN_CHAR_RE = /[\s\p{Cc}]/u

// ---------------------------------------------------------------------------
// File-system seam
// ---------------------------------------------------------------------------

/**
 * The file-system operations the credentials check performs. The file is
 * opened once and then stat'ed, read and closed through its descriptor, so
 * the type check and the read see the same file. The names deliberately
 * differ from the working-directory check's (`stat`, `access`): the combined
 * bring-up seam (`PersonaBringUpFs`) carries both, and an override of one
 * must never reach the other. `realpath` is shared.
 */
export interface CredentialsFs {
  /**
   * Open the credentials path read-only and non-blocking (`O_RDONLY |
   * O_NONBLOCK`, following symlinks), so opening a FIFO never waits for a
   * writer. Returns the descriptor. Throws an errno-style error (with `code`)
   * on failure.
   */
  openFile(path: string): number
  /** Stat an open descriptor. Throws an errno-style error (with `code`) on failure. */
  fstatFile(fd: number): { isFile(): boolean; isDirectory(): boolean }
  /**
   * Read the whole file behind an open descriptor as bytes (decoded as UTF-8
   * only for validation, so the digest covers exactly the bytes read). Throws
   * an errno-style error (with `code`) on failure.
   */
  readFileFd(fd: number): Buffer
  /** Close a descriptor opened by `openFile`. The check ignores a failure. */
  closeFile(fd: number): void
  /** Resolve a path's real path. Throws on failure; callers fall back to the lexical form. */
  realpath(path: string): string
}

/** The real file system, looked up at call time. */
export const DEFAULT_CREDENTIALS_FS: CredentialsFs = {
  openFile: path => openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK),
  fstatFile: fd => fstatSync(fd),
  readFileFd: fd => readFileSync(fd),
  closeFile: fd => closeSync(fd),
  realpath: path => realpathSync(path),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The persona whose credentials file is checked. */
export type CredentialsPersona = Pick<Persona, 'index' | 'name' | 'key' | 'credentials_file'>

/** Another applied persona, as far as the credentials collision rule needs it. */
export type OtherCredentialsPersona = Pick<Persona, 'name' | 'key' | 'credentials_file'>

/** A credentials-check failure class. */
export type CredentialsDiagnosticClass =
  | typeof PERSONA_CREDENTIALS_MISSING
  | typeof PERSONA_CREDENTIALS_UNREADABLE
  | typeof PERSONA_CREDENTIALS_INVALID

/** A persona's two Slack tokens. Redacts itself on JSON, string conversion and inspection. */
export class PersonaSlackTokens {
  readonly #botToken: string
  readonly #appToken: string

  constructor(botToken: string, appToken: string) {
    this.#botToken = botToken
    this.#appToken = appToken
    Object.freeze(this)
  }

  /** The `xoxb-` bot token. */
  get botToken(): string {
    return this.#botToken
  }

  /** The `xapp-` app-level token. */
  get appToken(): string {
    return this.#appToken
  }

  toJSON(): { bot_token: string; app_token: string } {
    return { bot_token: REDACTED, app_token: REDACTED }
  }

  toString(): string {
    return `PersonaSlackTokens ${REDACTED}`
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }
}

/** A locally valid credentials file. */
export interface CredentialsCheckSuccess {
  ok: true
  tokens: PersonaSlackTokens
}

/** Result of `checkPersonaCredentials`. A failure never carries a token. */
export type CredentialsCheckResult = CredentialsCheckSuccess | PersonaCheckFailure<CredentialsDiagnosticClass>

/** Options for `checkPersonaCredentials`. */
export interface CheckPersonaCredentialsOptions {
  /**
   * The other applied personas. An entry with the checked persona's own key is
   * skipped, so the full applied list may be passed.
   */
  others: readonly OtherCredentialsPersona[]
  /** File-system overrides; unset operations use `DEFAULT_CREDENTIALS_FS`. */
  fs?: Partial<CredentialsFs>
  /** When given, a failure's line is emitted through it exactly once. */
  log?: PersonaDiagnosticLogger
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the working-directory check)
// ---------------------------------------------------------------------------

/** The `code` of an errno-style error, if it has one. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Whether an errno-style error means the path does not exist. */
export function isMissingPathError(err: unknown): boolean {
  const code = errnoCode(err)
  return code !== undefined && MISSING_PATH_CODES.has(code)
}

/** ` (<code>)` for an echo-safe errno code, otherwise nothing. */
export function errnoSuffix(err: unknown): string {
  const code = errnoCode(err)
  return code !== undefined && ERRNO_CODE_RE.test(code) ? ` (${code})` : ''
}

/**
 * Cause text when `path` has the same comparison form (`resolveRealPath`) as
 * `setting` of another applied persona, else undefined. Others with `ownKey`
 * are skipped. Resolves paths only; opens nothing.
 */
export function describeRealPathCollision<S extends 'credentials_file' | 'working_directory'>(
  path: string,
  ownKey: string,
  others: readonly (Pick<Persona, 'name' | 'key'> & Record<S, string>)[],
  setting: S,
  realpath: (path: string) => string,
): string | undefined {
  const realPath = resolveRealPath(path, realpath)
  for (const other of others) {
    if (other.key === ownKey) continue
    if (resolveRealPath(other[setting], realpath) !== realPath) continue
    const shared = realPath === path ? '' : ` (both resolve to ${JSON.stringify(realPath)})`
    return `real path is also the ${setting} of ${renderPersonaRef(other.name, other.key)}${shared}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

/**
 * Validate parsed credentials-file content. Returns the tokens, or the causes
 * (key names and rules only; never a value, never an unexpected key's name).
 */
function validateCredentialsContent(content: string): PersonaSlackTokens | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'not valid JSON'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'not a JSON object'

  const obj = parsed as Record<string, unknown>
  const problems: string[] = []
  for (const [key, prefix] of CREDENTIALS_KEYS) {
    const value = obj[key]
    if (!Object.hasOwn(obj, key)) problems.push(`${key} is missing`)
    else if (typeof value !== 'string') problems.push(`${key} must be a string`)
    else if (TOKEN_FORBIDDEN_CHAR_RE.test(value)) problems.push(`${key} contains whitespace or control characters`)
    else if (!value.startsWith(prefix)) problems.push(`${key} must start with ${prefix}`)
    else if (value.length === prefix.length) problems.push(`${key} has nothing after ${prefix}`)
  }
  const allowed: readonly string[] = CREDENTIALS_KEYS.map(([key]) => key)
  const unexpected = Object.keys(obj).filter(key => !allowed.includes(key)).length
  if (unexpected > 0) {
    problems.push(`${unexpected} unexpected key${unexpected === 1 ? '' : 's'} (only bot_token and app_token are allowed)`)
  }
  if (problems.length > 0) return problems.join('; ')
  return new PersonaSlackTokens(obj['bot_token'] as string, obj['app_token'] as string)
}

/** Start of the cause of a credentials file whose content is invalid. */
const INVALID_CONTENT_CAUSE_PREFIX = 'credentials file is invalid: '

/**
 * Why a credentials read (`readCredentialsFile`) is not locally valid
 * (b.av2 SR-1.4, SR-6.1 step 1), or undefined when it is: the read's own
 * cause for a missing or unreadable file, otherwise the content check's
 * cause, worded as `checkPersonaCredentials` words it. For a caller that
 * already holds the bytes (the reload tick's check of an added persona), so
 * the file is not read a second time. Checks content only: the real-path
 * collision rule is the caller's. Returns no token; the causes name keys and
 * rules only. Pure.
 */
export function credentialsReadProblem(read: CredentialsFileRead): string | undefined {
  if (!read.ok) return read.cause
  const validated = validateCredentialsContent(read.bytes.toString('utf-8'))
  return typeof validated === 'string' ? INVALID_CONTENT_CAUSE_PREFIX + validated : undefined
}

// ---------------------------------------------------------------------------
// Stat-first read and digest (b.av2 SR-8.3)
// ---------------------------------------------------------------------------

/**
 * One read of a credentials file (`readCredentialsFile`): its exact bytes, or
 * why there are none. A failure's `cause` is the token-free text the check
 * reports (`credentials file does not exist`, `… is a directory`, …).
 */
export type CredentialsFileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; missing: boolean; cause: string }

/**
 * Read a credentials file's bytes once, stat-first: open it read-only and
 * non-blocking (so a FIFO never waits for a writer), fstat the descriptor and
 * read only a regular file, through that same descriptor, so the file cannot
 * be swapped between the check and the read. Anything but a regular file (a
 * directory, FIFO, socket or device) is refused unread: a FIFO blocks a read
 * forever and a device such as `/dev/zero` never ends. There is no size cap.
 *
 * The one reader of a credentials file: the bring-up's credentials check and
 * the reload detection tick both use it. Never throws for a string path; the
 * bytes are returned to the caller only and never logged.
 *
 * @param path  The credentials file, absolute and tilde-expanded.
 * @param fs    File-system overrides; unset operations use `DEFAULT_CREDENTIALS_FS`.
 */
export function readCredentialsFile(path: string, fs?: Partial<CredentialsFs>): CredentialsFileRead {
  const io: CredentialsFs = { ...DEFAULT_CREDENTIALS_FS, ...fs }
  const unreadable = (cause: string): CredentialsFileRead => ({ ok: false, missing: false, cause })

  // A failed open, stat or read: missing, a directory, permission denied, or other.
  const failAccess = (err: unknown): CredentialsFileRead => {
    if (isMissingPathError(err)) return { ok: false, missing: true, cause: 'credentials file does not exist' }
    const code = errnoCode(err)
    if (code === 'EISDIR') return unreadable('credentials file is a directory')
    if (code === 'EACCES' || code === 'EPERM') {
      return unreadable(`credentials file cannot be read: permission denied${errnoSuffix(err)}`)
    }
    return unreadable(`credentials file cannot be read${errnoSuffix(err)}`)
  }

  let fd: number
  try {
    fd = io.openFile(path)
  } catch (err) {
    return failAccess(err)
  }
  try {
    let stats: { isFile(): boolean; isDirectory(): boolean }
    try {
      stats = io.fstatFile(fd)
    } catch (err) {
      return failAccess(err)
    }
    if (stats.isDirectory()) return unreadable('credentials file is a directory')
    if (!stats.isFile()) return unreadable('credentials file is not a regular file')
    try {
      return { ok: true, bytes: io.readFileFd(fd) }
    } catch (err) {
      return failAccess(err)
    }
  } finally {
    try {
      io.closeFile(fd)
    } catch {
      // Nothing to report: the descriptor is gone either way.
    }
  }
}

/** The held value of a credentials file that does not exist (b.av2 SR-8.3). */
export const CREDENTIALS_MISSING_MARKER = 'missing'

/** The held value of a credentials file that exists but cannot be read (b.av2 SR-8.3). */
export const CREDENTIALS_UNREADABLE_MARKER = 'unreadable'

/** Start of a credentials digest: `sha256:` then 64 lower-case hex digits. */
const CREDENTIALS_DIGEST_PREFIX = 'sha256:'

/**
 * What is held for the content of a credentials file: `sha256:<hex>` over the
 * exact bytes read, or `CREDENTIALS_MISSING_MARKER` /
 * `CREDENTIALS_UNREADABLE_MARKER`. A marker never equals a digest, so a
 * missing or unreadable file never compares equal to any content (an empty
 * file included). Compared by `===`. Held in memory only and never logged.
 */
export type CredentialsDigest = string

/**
 * The digest or marker of one read (`readCredentialsFile`): SHA-256 of the
 * exact bytes, or the missing or unreadable marker. Pure.
 */
export function credentialsDigest(read: CredentialsFileRead): CredentialsDigest {
  if (!read.ok) return read.missing ? CREDENTIALS_MISSING_MARKER : CREDENTIALS_UNREADABLE_MARKER
  return CREDENTIALS_DIGEST_PREFIX + createHash('sha256').update(read.bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** `checkPersonaCredentialsAndDigest`'s result: the check, and the digest of what it read. */
export interface CredentialsCheckWithDigest {
  result: CredentialsCheckResult
  /**
   * The digest or marker of the bytes of the persona's own
   * `credentials_file` (`credentialsDigest`), whatever the check's outcome.
   * For a real-path collision with another applied persona the file is read
   * only to be hashed: it is never parsed and no token is taken from it.
   * Never logged.
   */
  digest: CredentialsDigest
}

/**
 * Read a persona's credentials file and check it is locally valid
 * (b.av2 SR-1.4, SR-6.1 step 1), returning the check's result and the digest
 * of the bytes it read (b.av2 SR-8.3). Checks, in order:
 *
 *   1. its real path (`resolveRealPath`, lexical fallback) is no other
 *      applied persona's credentials file → else `persona-credentials-invalid`,
 *      naming the other persona. Checked first so another persona's tokens
 *      are never parsed or used on this persona's behalf: the file is read
 *      (by `readCredentialsFile`, stat-first) only to hash it, and the
 *      digest or marker is returned beside the failure, so a re-save of the
 *      file can make a change pending once the collision is gone
 *      (b.av2 SR-8.3);
 *   2. it exists → else `persona-credentials-missing` (the missing marker);
 *   3. it is a regular file (after following symlinks; not a directory, FIFO,
 *      socket or device) and can be read (permitted) → else
 *      `persona-credentials-unreadable` (the unreadable marker). The file is
 *      read by `readCredentialsFile`, so a FIFO or a device is never read and
 *      cannot be swapped in after the check;
 *   4. it is a JSON object with exactly `bot_token` (`xoxb-…`) and
 *      `app_token` (`xapp-…`) as strings, each with at least one character
 *      after its prefix and no whitespace or control character anywhere →
 *      else `persona-credentials-invalid`. From step 4 on the digest is that
 *      of the bytes read, valid or not.
 *
 * `persona.credentials_file` must already be absolute and tilde-expanded (as
 * the persona loader stores it). Filesystem errors are returned as failures,
 * never thrown; the only exception that propagates is one thrown by the
 * injected `options.log`.
 */
export function checkPersonaCredentialsAndDigest(
  persona: CredentialsPersona,
  options: CheckPersonaCredentialsOptions,
): CredentialsCheckWithDigest {
  const fs: CredentialsFs = { ...DEFAULT_CREDENTIALS_FS, ...options.fs }
  const path = persona.credentials_file
  const fail = (cls: CredentialsDiagnosticClass, cause: string) =>
    personaCheckFailure({ class: cls, name: persona.name, key: persona.key, index: persona.index, path, cause }, options.log)

  const collision = describeRealPathCollision(path, persona.key, options.others, 'credentials_file', p => fs.realpath(p))
  const read = readCredentialsFile(path, fs)
  const digest = credentialsDigest(read)
  if (collision !== undefined) return { result: fail(PERSONA_CREDENTIALS_INVALID, collision), digest }

  if (!read.ok) {
    return { result: fail(read.missing ? PERSONA_CREDENTIALS_MISSING : PERSONA_CREDENTIALS_UNREADABLE, read.cause), digest }
  }

  const validated = validateCredentialsContent(read.bytes.toString('utf-8'))
  if (typeof validated === 'string') {
    return { result: fail(PERSONA_CREDENTIALS_INVALID, INVALID_CONTENT_CAUSE_PREFIX + validated), digest }
  }
  return { result: { ok: true, tokens: validated }, digest }
}

/**
 * Read a persona's credentials file and check it is locally valid
 * (b.av2 SR-1.4, SR-6.1 step 1): `checkPersonaCredentialsAndDigest` without
 * the digest. See it for the checks, their order and the failure classes.
 */
export function checkPersonaCredentials(
  persona: CredentialsPersona,
  options: CheckPersonaCredentialsOptions,
): CredentialsCheckResult {
  return checkPersonaCredentialsAndDigest(persona, options).result
}
