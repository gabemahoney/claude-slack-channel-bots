/**
 * secrets.ts — reading and writing /ci-live's host-side secrets.
 *
 * Rules (b.1cx design, "Secrets & state"):
 * - A secret file, and the directory holding it, must not be group- or
 *   other-accessible; otherwise the run refuses (exit 2), names the path and
 *   the `chmod` that fixes it, and says a VM reboot can loosen these modes
 *   (the pod re-applies its group at boot). The runner never changes a mode
 *   itself. Before a real run, every loose path is reported at once.
 * - Secrets are written only to mode-600 files in mode-700 directories, via a
 *   temp file in the same directory whose mode is set before the rename; the
 *   real file system fsyncs the file before the rename and the directory
 *   after it, so a rewrite (a rotated token pair above all) survives a crash.
 * - Every value read or written is registered with the redactor first.
 * - A dry run reads none of the real files: its store points at a temporary
 *   directory, ignores the environment overrides, and refuses (throws) any
 *   access under the real config directory.
 * - live.json's optional `second_user` is one of two kinds: a password
 *   account (its email, and a `password_file` or `password_env`) or a
 *   code-only account (its email and neither password key), which signs in
 *   by a code Slack emails to it and the run reads from the test mailbox.
 *   An entry whose password keys are all malformed is dropped, never taken
 *   as code-only.
 *
 * File-system access goes through the injected `SecureFs`, so tests can
 * drive every branch with an in-memory fake.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { MailboxConfigError, parseMailboxFile, serializeMailboxFile, type MailboxConfig } from './mailbox.ts'
import { hostCredentialsFile, PASSWORD_ENV, TEST_EMAIL_ENV, WORKSPACE_ENV, type LivePaths } from './paths.ts'
import type { PersonaLetter } from './personas.ts'
import type { Redactor } from './redact.ts'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The run can't proceed for a reason the operator must fix (exit 2). The
 * message names the file or environment variable to fix, never a value.
 */
export class NotRunnableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotRunnableError'
  }
}

/**
 * Slack asked for a sign-in code it emailed (a new device). The operator
 * answers it once with `bun ci-live/run.ts login` (the test human) or
 * `login --second` (the second workspace user).
 */
export class SignInCodeNeededError extends NotRunnableError {
  constructor(readonly who: 'human' | 'second') {
    super(
      who === 'human'
        ? 'Slack asked for an emailed sign-in code (a new device): run `bun ci-live/run.ts login` once, then rerun'
        : 'Slack asked the second account for an emailed sign-in code: run `bun ci-live/run.ts login --second` once, then rerun',
    )
    this.name = 'SignInCodeNeededError'
  }
}

/**
 * A secret file the operator writes is missing or empty (not runnable). The
 * configuration token's absence is not always fatal: the apps stage goes on
 * without it when apps.json records every app (provision/apps.ts).
 */
export class MissingSecretError extends NotRunnableError {
  constructor(message: string) {
    super(message)
    this.name = 'MissingSecretError'
  }
}

/** A dry run tried to touch the real secrets directory. Always a bug in the runner. */
export class DryRunSecretAccessError extends Error {
  constructor(path: string) {
    super(`dry run refused to access ${path}: a dry run reads no real secret or state file`)
    this.name = 'DryRunSecretAccessError'
  }
}

// ---------------------------------------------------------------------------
// File system seam
// ---------------------------------------------------------------------------

export interface FileStat {
  mode: number
  size: number
  isFile: boolean
  isDirectory: boolean
}

export interface SecureFs {
  /** `null` when the path does not exist. */
  stat(path: string): FileStat | null
  readFile(path: string): string
  /** Create or truncate `path` with `mode` (the mode applies on creation). */
  writeFile(path: string, data: string, mode: number): void
  chmod(path: string, mode: number): void
  rename(from: string, to: string): void
  mkdir(path: string, mode: number): void
  unlink(path: string): void
  readdir(path: string): string[]
}

/** fsync a directory, so a rename in it survives a crash (best effort: some file systems refuse it). */
function syncDir(dir: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* ignore: the rename itself has happened */
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export const nodeSecureFs: SecureFs = {
  stat(path) {
    try {
      const st = statSync(path)
      return { mode: st.mode & 0o7777, size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory() }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  readFile: (path) => readFileSync(path, 'utf-8'),
  writeFile: (path, data, mode) => {
    const fd = openSync(path, 'wx', mode)
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  },
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => {
    renameSync(from, to)
    syncDir(dirname(to))
  },
  mkdir: (path, mode) => mkdirSync(path, { mode, recursive: true }),
  unlink: (path) => unlinkSync(path),
  readdir: (path) => readdirSync(path),
}

// ---------------------------------------------------------------------------
// Mode checks and private writes
// ---------------------------------------------------------------------------

/** Group and other permission bits. */
const GROUP_OTHER_BITS = 0o077

/** Why secret modes can be loose on a path the runner wrote private, told with every mode refusal. */
export const LOOSE_MODES_NOTE =
  'a VM reboot can loosen these modes, as the pod re-applies its group to the files at boot; the runner never changes them itself'

/** A path as a shell argument: as it is when plain, else single-quoted. */
function shellArg(path: string): string {
  return /^[A-Za-z0-9_./~+@%=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/** The mode a secret path should have, as `chmod` takes it. */
function privateMode(kind: 'file' | 'dir'): string {
  return kind === 'file' ? '600' : '700'
}

/** The group and other bits' mode text (with any setgid bit, as a reboot leaves it: `2770`), or `null` when private. */
function looseMode(st: FileStat): string | null {
  return (st.mode & GROUP_OTHER_BITS) !== 0 ? (st.mode & 0o7777).toString(8).padStart(3, '0') : null
}

/**
 * A reason `path` is not private, or `null` when it is. A loose mode names
 * the fix (`chmod 600 <file>` / `chmod 700 <dir>`, with `path` when given)
 * and that a VM reboot can loosen modes.
 */
export function privacyProblem(st: FileStat, kind: 'file' | 'dir', path?: string): string | null {
  if (kind === 'file' && !st.isFile) return 'is not a regular file'
  if (kind === 'dir' && !st.isDirectory) return 'is not a directory'
  const mode = looseMode(st)
  if (mode !== null) {
    return `is group- or other-accessible (mode ${mode}): run chmod ${privateMode(kind)} ${path === undefined ? 'on it' : shellArg(path)} (${LOOSE_MODES_NOTE})`
  }
  return null
}

export function assertPrivate(fs: SecureFs, path: string, kind: 'file' | 'dir'): void {
  const st = fs.stat(path)
  if (!st) throw new NotRunnableError(`${path} does not exist`)
  const problem = privacyProblem(st, kind, path)
  if (problem) throw new NotRunnableError(`${path} ${problem}`)
}

/** Create `dir` with mode 700 when missing; refuse one that exists and is not private. */
export function ensurePrivateDir(fs: SecureFs, dir: string): void {
  const st = fs.stat(dir)
  if (!st) {
    fs.mkdir(dir, 0o700)
    fs.chmod(dir, 0o700)
    return
  }
  const problem = privacyProblem(st, 'dir', dir)
  if (problem) throw new NotRunnableError(`${dir} ${problem}`)
}

interface LayoutProblem {
  path: string
  kind: 'file' | 'dir'
  st: FileStat
}

/**
 * One message for every path of the layout that is not private: the loose
 * ones with their modes and the `chmod` commands that fix them all, and any
 * path of the wrong type.
 */
export function layoutProblemsMessage(problems: readonly LayoutProblem[]): string {
  const [only] = problems
  if (problems.length === 1 && only) return `${only.path} ${privacyProblem(only.st, only.kind, only.path)}`
  const loose = problems.filter((p) => looseMode(p.st) !== null && (p.kind === 'file' ? p.st.isFile : p.st.isDirectory))
  const wrongType = problems.filter((p) => !loose.includes(p))
  const parts: string[] = []
  if (loose.length > 0) {
    const listed = loose.map((p) => `${p.path} (mode ${looseMode(p.st)})`).join(', ')
    const fixes = (['dir', 'file'] as const).flatMap((kind) => {
      const paths = loose.filter((p) => p.kind === kind).map((p) => shellArg(p.path))
      return paths.length > 0 ? [`chmod ${privateMode(kind)} ${paths.join(' ')}`] : []
    })
    parts.push(`${loose.length} secret paths are group- or other-accessible: ${listed}. Run ${fixes.join(' && ')} (${LOOSE_MODES_NOTE})`)
  }
  for (const p of wrongType) parts.push(`${p.path} ${privacyProblem(p.st, p.kind, p.path)}`)
  return parts.join('; ')
}

let tempCounter = 0

/**
 * Write `data` to `path` as a mode-600 file: a temp file in the same
 * directory, created with mode 600 and chmod-ed to 600 before the rename, so
 * the target never exists with a wider mode or partial content.
 */
export function writePrivateFile(fs: SecureFs, path: string, data: string): void {
  ensurePrivateDir(fs, dirname(path))
  tempCounter += 1
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${tempCounter}`)
  try {
    fs.writeFile(tmp, data, 0o600)
    fs.chmod(tmp, 0o600)
    fs.rename(tmp, path)
  } catch (err) {
    try {
      fs.unlink(tmp)
    } catch {
      /* ignore: the temp file may not exist */
    }
    throw err
  }
}

/** Read a private file; refuse one that is missing or group/other-accessible. */
export function readPrivateFile(fs: SecureFs, path: string): string {
  assertPrivate(fs, dirname(path), 'dir')
  assertPrivate(fs, path, 'file')
  return fs.readFile(path)
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * live.json's `second_user`, of either kind: a password account names where
 * its password is (`password_file`, `password_env` or both); a code-only
 * account names neither, and `readSecondPassword` gives `null` for it (its
 * sign-in requests an emailed code, read from the test mailbox). Either
 * kind's emailed code is read only from Slack mail sent exactly to `email`.
 */
export interface SecondUserConfig {
  /** The second workspace user's email (config, never logged: registered with the redactor). */
  email: string
  /**
   * Where its password is: a file path (mode 600) or an environment variable
   * name. Neither: the account has no password and signs in by emailed code.
   */
  password_file?: string
  password_env?: string
}

/**
 * live.json with its overrides applied: the workspace, the test human's
 * email, and the second workspace user (a password account or a code-only
 * one, see `SecondUserConfig`), or `null` when none is configured or the
 * entry is unusable (no valid email, or only malformed password keys).
 */
export interface LiveConfig {
  workspaceDomain: string
  testEmail: string
  secondUser: SecondUserConfig | null
}

export interface PersonaCredentials {
  bot_token: string
  app_token: string
}

export interface ConfigTokens {
  token: string
  refreshToken: string | null
}

export interface SecretStoreOptions {
  fs: SecureFs
  paths: LivePaths
  /** Environment overrides (`CSCB_LIVE_*`); a dry run passes `{}`. */
  env: Record<string, string | undefined>
  redactor: Redactor
  /** In a dry run, `paths.configDir` must not be inside `realConfigDir`, and nothing under it is touched. */
  dryRun: boolean
  realConfigDir: string
}

/**
 * True when `path` is `dir` or inside it (lexically). A name that only starts
 * with two dots (`<dir>/..foo`) is inside; `..` as a whole path component, or
 * another root, is not.
 */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class SecretStore {
  readonly paths: LivePaths
  /** Every path this store read or wrote, in order (for the dry-run assertion in tests). */
  readonly accessed: string[] = []
  private readonly o: SecretStoreOptions

  constructor(options: SecretStoreOptions) {
    this.o = options
    this.paths = options.paths
    if (options.dryRun && isInside(options.paths.configDir, options.realConfigDir)) {
      throw new DryRunSecretAccessError(options.paths.configDir)
    }
  }

  private touch(path: string): void {
    if (this.o.dryRun && isInside(path, this.o.realConfigDir)) throw new DryRunSecretAccessError(path)
    this.accessed.push(path)
  }

  /**
   * The store's file system with the dry-run guard and the access record on
   * every path, for the other writers of the config dir (apps.json).
   */
  guardedFs(): SecureFs {
    const fs = this.o.fs
    const touch = (path: string): void => this.touch(path)
    return {
      stat: (p) => (touch(p), fs.stat(p)),
      readFile: (p) => (touch(p), fs.readFile(p)),
      writeFile: (p, d, m) => (touch(p), fs.writeFile(p, d, m)),
      chmod: (p, m) => (touch(p), fs.chmod(p, m)),
      rename: (a, b) => (touch(a), touch(b), fs.rename(a, b)),
      mkdir: (p, m) => (touch(p), fs.mkdir(p, m)),
      unlink: (p) => (touch(p), fs.unlink(p)),
      readdir: (p) => (touch(p), fs.readdir(p)),
    }
  }

  /** Make sure the config dir exists and is private (mode 700). */
  ensureConfigDir(): void {
    this.touch(this.paths.configDir)
    ensurePrivateDir(this.o.fs, this.paths.configDir)
  }

  private readSecret(path: string, what: string): string {
    this.touch(path)
    if (!this.o.fs.stat(path)) throw new MissingSecretError(`${what} is missing: write it to ${path} (mode 600)`)
    const value = readPrivateFile(this.o.fs, path).trim()
    if (value === '') throw new MissingSecretError(`${what} in ${path} is empty`)
    this.o.redactor.addSecret(value)
    return value
  }

  private writeSecret(path: string, data: string): void {
    this.touch(path)
    writePrivateFile(this.o.fs, path, data)
  }

  /** The app configuration token, and its refresh token when that file exists. */
  readConfigTokens(): ConfigTokens {
    const token = this.readSecret(this.paths.configTokenFile, 'the Slack app configuration token')
    this.touch(this.paths.refreshTokenFile)
    const refreshToken = this.o.fs.stat(this.paths.refreshTokenFile)
      ? this.readSecret(this.paths.refreshTokenFile, 'the configuration refresh token')
      : null
    return { token, refreshToken }
  }

  /**
   * Rewrite both configuration token files after a rotation (each mode 600,
   * atomically, fsynced), the refresh token first: it is the one a lost write
   * could not replace, since the old one is spent.
   */
  writeConfigTokens(tokens: { token: string; refreshToken: string }): void {
    this.o.redactor.addSecret(tokens.token)
    this.o.redactor.addSecret(tokens.refreshToken)
    this.writeSecret(this.paths.refreshTokenFile, `${tokens.refreshToken}\n`)
    this.writeSecret(this.paths.configTokenFile, `${tokens.token}\n`)
  }

  /** The test human's password: `CSCB_LIVE_TEST_PASSWORD`, else the `test_password` file. */
  readPassword(): string {
    const fromEnv = this.o.env[PASSWORD_ENV]
    if (fromEnv !== undefined && fromEnv !== '') {
      this.o.redactor.addSecret(fromEnv)
      return fromEnv
    }
    return this.readSecret(this.paths.passwordFile, `the test human's password (or env ${PASSWORD_ENV})`)
  }

  /** Whether a password is available, by stat only (no read). */
  hasPassword(): boolean {
    const fromEnv = this.o.env[PASSWORD_ENV]
    if (fromEnv !== undefined && fromEnv !== '') return true
    this.touch(this.paths.passwordFile)
    return this.o.fs.stat(this.paths.passwordFile) !== null
  }

  /** `live.json` with the `CSCB_LIVE_WORKSPACE` / `CSCB_LIVE_TEST_EMAIL` overrides applied. */
  readLiveConfig(): LiveConfig {
    const path = this.paths.liveJson
    this.touch(path)
    let raw: Record<string, unknown> = {}
    if (this.o.fs.stat(path)) {
      try {
        const parsed: unknown = JSON.parse(readPrivateFile(this.o.fs, path))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
        else throw new Error('not an object')
      } catch (err) {
        if (err instanceof NotRunnableError) throw err
        throw new NotRunnableError(`${path} is not a JSON object`)
      }
    }
    const domain = this.o.env[WORKSPACE_ENV] || (typeof raw.workspace_domain === 'string' ? raw.workspace_domain : '')
    const email = this.o.env[TEST_EMAIL_ENV] || (typeof raw.test_email === 'string' ? raw.test_email : '')
    if (!DOMAIN_RE.test(domain)) {
      throw new NotRunnableError(`workspace_domain is missing or not a Slack workspace domain: set it in ${path} or env ${WORKSPACE_ENV}`)
    }
    if (!EMAIL_RE.test(email)) {
      throw new NotRunnableError(`test_email is missing or not an email address: set it in ${path} or env ${TEST_EMAIL_ENV}`)
    }
    return { workspaceDomain: domain, testEmail: email, secondUser: parseSecondUser(raw.second_user) }
  }

  /** A persona's credentials, or `null` when the file is missing or not the two-key JSON object. */
  readCredentials(letter: PersonaLetter): PersonaCredentials | null {
    const path = hostCredentialsFile(this.paths, letter)
    return this.readCredentialsAt(path)
  }

  /** Credentials at an explicit path (Check 25 reads D's moved file). */
  readCredentialsAt(path: string): PersonaCredentials | null {
    this.touch(path)
    if (!this.o.fs.stat(path)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readPrivateFile(this.o.fs, path))
    } catch (err) {
      if (err instanceof NotRunnableError) throw err
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const { bot_token, app_token } = parsed as Record<string, unknown>
    if (typeof bot_token !== 'string' || typeof app_token !== 'string') return null
    this.o.redactor.addSecret(bot_token)
    this.o.redactor.addSecret(app_token)
    return { bot_token, app_token }
  }

  /** Write a persona's credentials file (mode 600, dir 700, temp + rename). */
  writeCredentials(letter: PersonaLetter, creds: PersonaCredentials): void {
    this.writeCredentialsAt(hostCredentialsFile(this.paths, letter), creds)
  }

  writeCredentialsAt(path: string, creds: PersonaCredentials): void {
    this.o.redactor.addSecret(creds.bot_token)
    this.o.redactor.addSecret(creds.app_token)
    this.writeSecret(path, `${JSON.stringify({ bot_token: creds.bot_token, app_token: creds.app_token }, null, 2)}\n`)
  }

  /** Move a file between two paths in the store (Check 25's D move, and its undo). */
  move(from: string, to: string): void {
    this.touch(from)
    this.touch(to)
    ensurePrivateDir(this.o.fs, dirname(to))
    this.o.fs.rename(from, to)
  }

  exists(path: string): boolean {
    this.touch(path)
    return this.o.fs.stat(path) !== null
  }

  /**
   * A browser's saved storageState (session cookies: a secret): exists (stat
   * only), load (after its mode check; the driver registers the cookie
   * values) and save (mode 600, temp + rename).
   */
  storageState(which: 'human' | 'second'): { exists(): boolean; load(): string; save(json: string): void } {
    const path = which === 'human' ? this.paths.storageState : this.paths.secondStorageState
    return {
      exists: () => this.exists(path),
      load: () => {
        this.touch(path)
        return readPrivateFile(this.o.fs, path)
      },
      save: (json) => this.writeSecret(path, json),
    }
  }

  /**
   * The second user's password: its `password_env` variable, else its
   * `password_file` (mode 600); `null` when it names neither (it signs in by
   * emailed code).
   */
  readSecondPassword(second: SecondUserConfig): string | null {
    if (!second.password_env && !second.password_file) return null
    if (second.password_env) {
      const value = this.o.env[second.password_env]
      if (value !== undefined && value !== '') {
        this.o.redactor.addSecret(value)
        return value
      }
    }
    if (!second.password_file) throw new NotRunnableError(`the second user's password is missing: set env ${second.password_env ?? '(none)'} or live.json second_user.password_file`)
    return this.readSecret(second.password_file, "the second user's password")
  }

  /**
   * The test mailbox (`mailbox.json`), or `null` when the file does not
   * exist. A group- or other-accessible file (or dir), or one that is not a
   * usable mailbox, is not runnable (the message names the file and the key,
   * never a value). The password and the saved token are registered with the
   * redactor.
   */
  readMailbox(): MailboxConfig | null {
    const path = this.paths.mailboxJson
    this.touch(path)
    if (!this.o.fs.stat(path)) return null
    let config: MailboxConfig
    try {
      config = parseMailboxFile(readPrivateFile(this.o.fs, path))
    } catch (err) {
      if (err instanceof MailboxConfigError) throw new NotRunnableError(`${path} ${err.message}`)
      throw err
    }
    this.o.redactor.addSecret(config.password)
    this.o.redactor.addSecret(config.token)
    return config
  }

  /** Rewrite `mailbox.json` (a fresh token): mode 600, temp + rename; the secrets registered first. */
  writeMailbox(config: MailboxConfig): void {
    this.o.redactor.addSecret(config.password)
    this.o.redactor.addSecret(config.token)
    this.writeSecret(this.paths.mailboxJson, serializeMailboxFile(config))
  }

  /**
   * Dry run only: seed the temporary config dir with the stub's secrets (the
   * configuration token, its refresh token when given), a live.json and
   * (when given) a mailbox.json pointing at the stub's mailbox.
   */
  seedDryRun(seed: { configToken: string; refreshToken?: string; password: string; workspaceDomain: string; testEmail: string; mailbox?: MailboxConfig }): void {
    if (!this.o.dryRun) throw new Error('seedDryRun is for a dry run only')
    this.ensureConfigDir()
    this.writeSecret(this.paths.configTokenFile, `${seed.configToken}\n`)
    if (seed.refreshToken) this.writeSecret(this.paths.refreshTokenFile, `${seed.refreshToken}\n`)
    this.writeSecret(this.paths.passwordFile, `${seed.password}\n`)
    this.writeSecret(this.paths.liveJson, `${JSON.stringify({ workspace_domain: seed.workspaceDomain, test_email: seed.testEmail })}\n`)
    if (seed.mailbox) this.writeMailbox(seed.mailbox)
  }

  /**
   * The secrets-bearing directories and files that must stay private,
   * checked before a real run: every one that is not is reported in one
   * not-runnable message, with the `chmod` commands that fix them all.
   */
  assertLayoutPrivate(): void {
    const problems: LayoutProblem[] = []
    const check = (path: string, kind: 'file' | 'dir'): FileStat | null => {
      this.touch(path)
      const st = this.o.fs.stat(path)
      if (st && privacyProblem(st, kind) !== null) problems.push({ path, kind, st })
      return st
    }
    const credentialDirs = [this.paths.credentialsDir, this.paths.stagedCredentialsDir]
    check(this.paths.configDir, 'dir')
    const present = credentialDirs.filter((dir) => check(dir, 'dir')?.isDirectory === true)
    for (const file of [
      this.paths.configTokenFile,
      this.paths.refreshTokenFile,
      this.paths.passwordFile,
      this.paths.storageState,
      this.paths.secondStorageState,
      this.paths.liveJson,
      this.paths.mailboxJson,
    ]) {
      check(file, 'file')
    }
    // The personas' credentials files (read later, one at a time).
    for (const dir of present) {
      for (const name of this.o.fs.readdir(dir).sort()) {
        const path = join(dir, name)
        this.touch(path)
        const st = this.o.fs.stat(path)
        if (st?.isFile && looseMode(st) !== null) problems.push({ path, kind: 'file', st })
      }
    }
    if (problems.length > 0) throw new NotRunnableError(layoutProblemsMessage(problems))
  }
}

/**
 * live.json's `second_user`: a password account (at least one well-formed
 * password key), a code-only account (a valid email and neither key), or
 * `null` (no valid email, or password keys given but all malformed).
 */
function parseSecondUser(value: unknown): SecondUserConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.email !== 'string' || !EMAIL_RE.test(v.email)) return null
  const out: SecondUserConfig = { email: v.email }
  if (typeof v.password_file === 'string' && v.password_file !== '') out.password_file = v.password_file
  if (typeof v.password_env === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(v.password_env)) out.password_env = v.password_env
  // A password source given but unusable is a mistyped entry, not a code-only account.
  if (!out.password_file && !out.password_env && (v.password_file !== undefined || v.password_env !== undefined)) return null
  return out
}
