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
 * - Never reads an environment variable (in particular not `SLACK_BOT_TOKEN`
 *   or `SLACK_APP_TOKEN`).
 * - Never writes, copies, caches or persists the file or any value from it,
 *   and never checks or changes the file mode.
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
 * (`readFile`, `realpath`); the real file system (`DEFAULT_CREDENTIALS_FS`)
 * is the default and callers may override any subset via `options.fs`. Tests
 * use it to simulate unreadable files even when running as root: make
 * `readFile` throw an error whose `code` is `EACCES`, `EISDIR`, `ENOENT`, ….
 *
 * Pure module (b.av2 SR-13.1): nothing runs at import and no token is read at
 * module scope. Nothing in the server calls it yet; E3 wires it.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, realpathSync } from 'node:fs'

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

/** The file-system operations the credentials check performs. */
export interface CredentialsFs {
  /** Read a whole file as UTF-8. Throws an errno-style error (with `code`) on failure. */
  readFile(path: string): string
  /** Resolve a path's real path. Throws on failure; callers fall back to the lexical form. */
  realpath(path: string): string
}

/** The real file system, looked up at call time. */
export const DEFAULT_CREDENTIALS_FS: CredentialsFs = {
  readFile: path => readFileSync(path, 'utf8'),
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

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Read a persona's credentials file and check it is locally valid
 * (b.av2 SR-1.4, SR-6.1 step 1). Checks, in order:
 *
 *   1. its real path (`resolveRealPath`, lexical fallback) is no other
 *      applied persona's credentials file → else `persona-credentials-invalid`,
 *      naming the other persona. Checked first so another persona's tokens
 *      are never read on this persona's behalf;
 *   2. it exists → else `persona-credentials-missing`;
 *   3. it can be read (not a directory, permitted) → else
 *      `persona-credentials-unreadable`;
 *   4. it is a JSON object with exactly `bot_token` (`xoxb-…`) and
 *      `app_token` (`xapp-…`) as strings, each with at least one character
 *      after its prefix and no whitespace or control character anywhere →
 *      else `persona-credentials-invalid`.
 *
 * `persona.credentials_file` must already be absolute and tilde-expanded (as
 * the persona loader stores it). Filesystem errors are returned as failures,
 * never thrown; the only exception that propagates is one thrown by the
 * injected `options.log`.
 */
export function checkPersonaCredentials(
  persona: CredentialsPersona,
  options: CheckPersonaCredentialsOptions,
): CredentialsCheckResult {
  const fs: CredentialsFs = { ...DEFAULT_CREDENTIALS_FS, ...options.fs }
  const path = persona.credentials_file
  const fail = (cls: CredentialsDiagnosticClass, cause: string) =>
    personaCheckFailure({ class: cls, name: persona.name, key: persona.key, index: persona.index, path, cause }, options.log)

  const collision = describeRealPathCollision(path, persona.key, options.others, 'credentials_file', p => fs.realpath(p))
  if (collision !== undefined) return fail(PERSONA_CREDENTIALS_INVALID, collision)

  let content: string
  try {
    content = fs.readFile(path)
  } catch (err) {
    if (isMissingPathError(err)) return fail(PERSONA_CREDENTIALS_MISSING, 'credentials file does not exist')
    const code = errnoCode(err)
    if (code === 'EISDIR') return fail(PERSONA_CREDENTIALS_UNREADABLE, 'credentials file is a directory')
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(PERSONA_CREDENTIALS_UNREADABLE, `credentials file cannot be read: permission denied${errnoSuffix(err)}`)
    }
    return fail(PERSONA_CREDENTIALS_UNREADABLE, `credentials file cannot be read${errnoSuffix(err)}`)
  }

  const validated = validateCredentialsContent(content)
  if (typeof validated === 'string') return fail(PERSONA_CREDENTIALS_INVALID, `credentials file is invalid: ${validated}`)
  return { ok: true, tokens: validated }
}
