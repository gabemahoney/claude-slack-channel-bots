/**
 * reload.ts — The reload controller: the last-applied record and the start
 * rules (b.av2 SR-8.1, SR-8.7, SR-13.1).
 *
 * Saving `config.json` does not change what runs. The server keeps a byte
 * copy of the last applied configuration, `config.json.last-applied` (the
 * record), beside the configuration file, and every start runs it:
 *
 * - record present: its bytes are read once and validated in record mode
 *   (`parsePersonaConfigBytes`), where a real-path collision is left to the
 *   bring-up (b.av2 SR-1.5). The configuration file is not read to decide
 *   what runs. A record that cannot be read or validated stops the start; the
 *   line names the record and says that deleting it makes the next start
 *   apply the configuration file;
 * - no record: the configuration file's bytes are read once and validated in
 *   default mode. A missing, unreadable or invalid file (a pre-persona file
 *   gets the SR-1.7 conversion error) stops the start. A valid file's bytes
 *   are written to the record with the durable writer before anything is
 *   applied; a failed write stops the start (`reload-record-write-failed`),
 *   including one whose record reached the disk but whose directory could
 *   not be synced (that line says the next start will run the record).
 *
 * The start reads no credentials file: the start bring-up reads them as they
 * stand, so a credentials change made while the server was down takes effect
 * at the start. An empty `personas` array is a valid applied set.
 *
 * Detection (b.av2 SR-8.2, SR-8.3, SR-8.7): once the start bring-up pass has
 * returned, `startDetection` hands the detection tick to the injected tick
 * driver (every 5 s in production). Each pass compares the configuration
 * file's bytes with the applied bytes and, unless in dry run, each
 * referenced credentials file's digest with the one the persona's bring-up
 * holds, and keeps `config.json.pending` (the preview behind a fingerprint,
 * `reload-fingerprint.ts`) in step: written while a change is pending,
 * deleted when nothing is. Its first pass after a start from the record is
 * the SR-8.7 comparison, so an unconfirmed edit stays pending. Nothing is
 * applied: no pass calls a lifecycle operation.
 *
 * The controller (`createReloadController`) is built with every dependency
 * injected, as `createCronScheduler` is: the SR-8.1 paths, the durable
 * writer and delete, the log sink, the lifecycle operations (the start
 * bring-up pass today), the tick driver, the dry-run flag, the held
 * credentials digests, and the Slack client factory that later work binds
 * (applying a confirmed change). It keeps the applied bytes and configuration
 * in memory. `readAppliedPersonaConfig` is the CLI's read-only resolver over
 * the same rules.
 *
 * Importable without side effects (b.av2 SR-13.1): importing it creates no
 * timer or Slack client, reads no file or environment variable and logs
 * nothing. No line it logs carries a token or file content. Its output goes
 * to the server log only, never to Slack (b.av2 SR-7.2).
 *
 * SPDX-License-Identifier: MIT
 */

import { dirname, resolve } from 'node:path'

import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  DurableWriteUnsyncedError,
} from './atomic-write.ts'
import {
  configFileReadFailureMessage,
  credentialsFilesToProtect,
  isMissingConfigCode,
  parsePersonaConfigBytes,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  referencedCredentialsPaths,
  type Persona,
  type PersonaConfig,
  type PersonaConfigFs,
} from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import {
  credentialsDigest,
  errnoSuffix,
  readCredentialsFile,
  type CredentialsDigest,
  type CredentialsFileRead,
  type CredentialsFs,
} from './persona-credentials.ts'
import { escapeCause } from './persona-diagnostics.ts'
import { expandTilde, renderPersonaRef } from './persona-identity.ts'
import type { PersonaSlackClientFactory } from './persona-slack-clients.ts'
import {
  composePendingFile,
  FINGERPRINT_MISSING,
  FINGERPRINT_UNREADABLE,
  reloadFingerprint,
  type FingerprintContent,
  type FingerprintCredentialsEntry,
} from './reload-fingerprint.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/**
 * The last-applied record could not be written. At a start without a record,
 * the server does not start and nothing is applied.
 */
export const RELOAD_RECORD_WRITE_FAILED = 'reload-record-write-failed'

/**
 * Nothing is pending any more: the configuration file and the credentials
 * files it references match what is applied again (a revert, or a leftover
 * `config.json.pending` found obsolete at the first check after a start), and
 * no pending file is left: it was deleted, or there was none (e.g. its write
 * had failed). Logged once per change to nothing pending.
 */
export const RELOAD_NOTHING_PENDING = 'reload-nothing-pending'

/**
 * Every reload diagnostic class label, in a fixed order. Kept apart from the
 * persona classes (`PERSONA_DIAGNOSTIC_CLASSES`): a reload line is about the
 * configuration, not one persona.
 */
export const RELOAD_DIAGNOSTIC_CLASSES = [RELOAD_RECORD_WRITE_FAILED, RELOAD_NOTHING_PENDING] as const

/** A reload diagnostic class label (closed set). */
export type ReloadDiagnosticClass = (typeof RELOAD_DIAGNOSTIC_CLASSES)[number]

// ---------------------------------------------------------------------------
// Reload files (b.av2 SR-8.1)
// ---------------------------------------------------------------------------

/** Appended to the configuration file's name: the pending-change preview. */
export const PENDING_FILE_SUFFIX = '.pending'

/** Appended to the configuration file's name: the confirmation name. */
export const APPLY_FILE_SUFFIX = '.apply'

/** Appended to the configuration file's name: the last-applied record. */
export const LAST_APPLIED_FILE_SUFFIX = '.last-applied'

/** The configuration file and the three reload files beside it (b.av2 SR-8.1). */
export interface ReloadFilePaths {
  /** The configuration file, e.g. `<dir>/config.json`. */
  config: string
  /** `<dir>/config.json.pending`: the preview, present only while a change is pending. */
  pending: string
  /** `<dir>/config.json.apply`: the confirmation name. */
  apply: string
  /** `<dir>/config.json.last-applied`: a byte copy of the last applied configuration. */
  lastApplied: string
}

/**
 * The reload files for the configuration file at `configPath`: in the same
 * directory, named by appending `.pending`, `.apply` and `.last-applied` to
 * its name. Pure: touches no file.
 */
export function reloadFilePaths(configPath: string): ReloadFilePaths {
  return {
    config: configPath,
    pending: configPath + PENDING_FILE_SUFFIX,
    apply: configPath + APPLY_FILE_SUFFIX,
    lastApplied: configPath + LAST_APPLIED_FILE_SUFFIX,
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** One pass of the detection tick. */
export type ReloadTick = () => Promise<void>

/**
 * Drives the detection tick: one serialized, self-re-arming timer in
 * production (`createReloadTickDriver` in `reload-timer.ts`), a manual driver
 * in tests. The controller hands it the tick from `startDetection`.
 */
export interface ReloadTickDriver {
  /** Run `tick` repeatedly, never two passes at once. */
  start(tick: ReloadTick): void
  /** Stop running it. Idempotent. */
  stop(): void
}

/**
 * The per-persona lifecycle operations the controller drives. `startBringUp`
 * is the start pass; the others are bound by the work that first applies a
 * confirmed change, and nothing calls them yet.
 */
export interface ReloadLifecycleOps {
  /**
   * The start bring-up pass over the whole applied set: every persona's
   * bring-up and, for each persona that is up, its launch. Resolves once
   * every persona has an outcome (production: `startupSessionManager` over
   * the bring-up controller).
   */
  startBringUp(applied: PersonaConfig): Promise<unknown>
  /** Bring up one persona a confirmed change added. */
  bringUp?(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /** Tear down one persona a confirmed change removed or destructively modified. */
  teardown?(persona: Persona): Promise<unknown>
  /** Reconnect one persona with its changed credentials file. */
  reconnectCredentials?(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /** Apply one persona's modified settings without tearing it down. */
  updateInPlace?(persona: Persona, previous: Persona, applied: PersonaConfig): Promise<unknown>
}

/**
 * Writes bytes atomically and durably (`durableWriteFileSync` in production).
 * Throws on failure: a `DurableWriteUnsyncedError` when the bytes reached the
 * path but its directory could not be synced, any other error when the path
 * was left unchanged.
 */
export type ReloadFileWriter = (path: string, bytes: Uint8Array) => void

/**
 * Deletes a file durably (`durableUnlinkSync` in production): returns true
 * when a file was removed, false when it was already absent. Throws on any
 * other failure: a `DurableUnlinkUnsyncedError` when the file was removed but
 * its directory could not be synced, any other error when the file is still
 * there.
 */
export type ReloadFileRemover = (path: string) => boolean

/**
 * The held credentials digest of an applied persona (the bring-up
 * controller's `credentialsDigest`): what its bring-up read, whatever its
 * outcome (a persona broken by a shared credentials file included), or
 * undefined when nothing is held.
 */
export type HeldCredentialsDigestQuery = (key: string) => CredentialsDigest | undefined

/** Dependencies of `createReloadController`. */
export interface ReloadControllerDeps {
  /** The configuration file and its reload files (`reloadFilePaths`). */
  paths: ReloadFilePaths
  /** The lifecycle operations; `startBringUp` is required. */
  lifecycle: ReloadLifecycleOps
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: ReloadFileWriter
  /** The durable delete (of `config.json.pending`); `durableUnlinkSync` by default. */
  remove?: ReloadFileRemover
  /** The detection tick's driver; without one, `startDetection` arms nothing. */
  tickDriver?: ReloadTickDriver
  /**
   * Dry run (b.av2 SR-3.4, SR-8.2): the detection tick reads no credentials
   * file, credentials never count as changed and the fingerprint covers the
   * configuration file alone. Default false.
   */
  dryRun?: boolean
  /**
   * The held credentials digests the detection tick compares against (b.av2
   * SR-8.3); production binds the bring-up controller's `credentialsDigest`.
   * Without it nothing is held, so credentials never count as changed.
   */
  heldCredentialsDigest?: HeldCredentialsDigestQuery
  /**
   * File-system overrides for the detection tick's credentials reads
   * (`readCredentialsFile`, which reads only a regular file); unset
   * operations use the real file system.
   */
  credentialsFs?: Partial<CredentialsFs>
  /** The Slack client factory; bound by the work that applies a confirmed change. */
  slackClientFactory?: PersonaSlackClientFactory
  /** Home directory for every `~` in the configuration; the OS home by default. */
  home?: string
  /**
   * File-system overrides for reading the record, the configuration file and
   * the pending file (`readPersonaConfigBytes`, which reads only a regular
   * file); unset operations use the real file system.
   */
  configFs?: Partial<PersonaConfigFs>
}

// ---------------------------------------------------------------------------
// Start resolution
// ---------------------------------------------------------------------------

/** Where the applied configuration came from. */
export type AppliedConfigSource = 'record' | 'config'

/** The applied configuration and the exact bytes it was validated from. */
export interface AppliedConfiguration {
  config: PersonaConfig
  /** The bytes that were read and validated; the record holds exactly these. */
  bytes: Uint8Array
  source: AppliedConfigSource
}

/** The outcome of `resolveStart`. */
export type ReloadStartOutcome =
  | ({ kind: 'applied' } & AppliedConfiguration)
  | {
      kind: 'refused'
      /** Which file stopped the start. */
      source: AppliedConfigSource
      /** The SR-10.3 class, when the refusal has one. */
      class: ReloadDiagnosticClass | undefined
      /** The line that was logged. */
      line: string
    }

/** Start of the line for a refused start whose configuration file cannot be used. */
const CONFIG_REFUSAL_PREFIX = '[slack] Fatal: configuration error — '

/** Start of the line for a refused start whose last-applied record cannot be used. */
const RECORD_REFUSAL_PREFIX = '[slack] Fatal: last-applied record error — '

/** A configuration chosen by the start rules, or why none can be. */
type Selection =
  | { ok: true; applied: AppliedConfiguration }
  | { ok: false; source: AppliedConfigSource; message: string }

/**
 * `cause` followed by the deletion hint: names the record and says that
 * deleting it makes the next start apply the configuration file.
 */
function recordFailureMessage(paths: ReloadFilePaths, cause: string): string {
  return (
    `${cause} Deleting the last-applied record "${paths.lastApplied}" makes the next start ` +
    `apply the configuration file "${paths.config}" as it stands.`
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The start rules' choice, reading each file at most once and writing
 * nothing: the record in record mode when it exists, otherwise the
 * configuration file in default mode. A record is absent only when reading
 * it fails because it (or an ancestor) does not exist; any other read failure
 * (a directory, a FIFO or a device included) is a record that cannot be read.
 * Each file is read through `readPersonaConfigBytes`, so a path that is not a
 * regular file is never read and cannot hang the start.
 */
function selectConfiguration(
  paths: ReloadFilePaths,
  home: string | undefined,
  fs: Partial<PersonaConfigFs> | undefined,
): Selection {
  const configDir = dirname(paths.config)

  let recordBytes: Buffer | undefined
  try {
    recordBytes = readPersonaConfigBytes(paths.lastApplied, fs)
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    if (!isMissingConfigCode(code)) {
      const cause = `The last-applied record "${paths.lastApplied}" cannot be read${code !== undefined ? ` (${code})` : ''}.`
      return { ok: false, source: 'record', message: recordFailureMessage(paths, cause) }
    }
  }
  if (recordBytes !== undefined) {
    try {
      const config = parsePersonaConfigBytes(recordBytes, paths.lastApplied, configDir, { home, record: true })
      return { ok: true, applied: { config, bytes: recordBytes, source: 'record' } }
    } catch (err) {
      return { ok: false, source: 'record', message: recordFailureMessage(paths, errorMessage(err)) }
    }
  }

  let configBytes: Buffer
  try {
    configBytes = readPersonaConfigBytes(paths.config, fs)
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    return { ok: false, source: 'config', message: configFileReadFailureMessage(paths.config, code) }
  }
  try {
    const config = parsePersonaConfigBytes(configBytes, paths.config, configDir, { home })
    return { ok: true, applied: { config, bytes: configBytes, source: 'config' } }
  } catch (err) {
    return { ok: false, source: 'config', message: errorMessage(err) }
  }
}

// ---------------------------------------------------------------------------
// Detection: the pending state (b.av2 SR-8.2, SR-8.3)
// ---------------------------------------------------------------------------

/**
 * Class of the line that logs the pending-change preview, once per change of
 * the pending state. Task 3 adds it (and `reload-invalid`) to
 * `RELOAD_DIAGNOSTIC_CLASSES` with the full SR-8.4 preview.
 */
export const RELOAD_PREVIEW = 'reload-preview'

/** One read of the configuration file by the detection tick. */
type ConfigFileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; missing: boolean; code: string | undefined }

/** What a confirmed apply would apply, as the tick sees it. */
type PendingCandidate =
  | { kind: 'valid'; config: PersonaConfig }
  /**
   * Fails validation (default mode); `error` is the loader's message, which
   * echoes no rejected value and no unknown key name that could be a token.
   */
  | { kind: 'invalid'; error: string }
  /** The configuration file is missing or cannot be read while a record exists. */
  | { kind: 'unreadable'; missing: boolean; code: string | undefined }

/** The pending state one detection pass derived. Holds no credentials content. */
interface PendingState {
  /** The configuration file's bytes differ from the applied bytes (or it cannot be read). */
  configChanged: boolean
  candidate: PendingCandidate
  /**
   * The personas present in both the applied set and a valid candidate, with
   * the same `credentials_file`, whose file's digest now differs from the one
   * held for them; in candidate order. Never set in dry run.
   */
  credentialsChanged: Persona[]
  /** The SR-8.3 fingerprint of the bytes this pass read. */
  fingerprint: string
  /** A change is pending: the configuration changed or any credentials changed. */
  pending: boolean
}

/** The configuration file's bytes, read stat-first, or why there are none. Never throws. */
function readConfigFile(path: string, fs: Partial<PersonaConfigFs> | undefined): ConfigFileRead {
  try {
    return { ok: true, bytes: readPersonaConfigBytes(path, fs) }
  } catch (err) {
    const code = err instanceof PersonaConfigReadError ? err.code : undefined
    return { ok: false, missing: isMissingConfigCode(code), code }
  }
}

/** A read as the fingerprint takes it: the bytes, or the missing/unreadable marker. */
function fingerprintContentOf(read: { ok: true; bytes: Uint8Array } | { ok: false; missing: boolean }): FingerprintContent {
  if (read.ok) return read.bytes
  return read.missing ? FINGERPRINT_MISSING : FINGERPRINT_UNREADABLE
}

/** A persona's settings as compared for "changed": everything but its position in the file. */
function personaSettings(persona: Persona): string {
  return JSON.stringify({ ...persona, index: undefined })
}

/** The server-wide setting names whose resolved values differ between two configurations. */
function changedServerSettings(before: PersonaConfig, after: PersonaConfig): string[] {
  const settings = (config: PersonaConfig): Record<string, unknown> => {
    const { personas: _personas, ...rest } = config
    return rest
  }
  const a = settings(before)
  const b = settings(after)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (name) => JSON.stringify(a[name]) !== JSON.stringify(b[name]),
  )
}

/** Suffix of an INVALID preview line. */
const NOTHING_WILL_BE_APPLIED = 'Nothing will be applied.'

/** First line of the preview body of a valid candidate. */
const PENDING_PREVIEW_TITLE = 'A configuration change is pending. Nothing has been applied.'

/**
 * The preview's change lines (minimal; b.av2 SR-8.4's full preview is Task
 * 3's): one INVALID line for an invalid candidate, otherwise one line per
 * persona added, changed or removed, per server-wide setting changed and per
 * persona whose credentials changed, or `no effective change`. Names personas
 * by name and key and credentials files by path, never any file content or
 * setting value. Pure.
 */
function renderPreviewLines(state: PendingState, applied: PersonaConfig, configPath: string): string[] {
  const { candidate } = state
  if (candidate.kind === 'invalid') return [`INVALID: ${candidate.error} ${NOTHING_WILL_BE_APPLIED}`]
  if (candidate.kind === 'unreadable') {
    const what = candidate.missing
      ? 'does not exist'
      : `cannot be read${candidate.code !== undefined ? ` (${candidate.code})` : ''}`
    return [`INVALID: the configuration file ${JSON.stringify(configPath)} ${what}. ${NOTHING_WILL_BE_APPLIED}`]
  }

  const next = candidate.config
  const lines: string[] = []
  for (const persona of next.personas) {
    const before = applied.personas.find((p) => p.key === persona.key)
    const ref = `personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}`
    if (before === undefined) lines.push(`added: ${ref}`)
    else if (personaSettings(before) !== personaSettings(persona)) lines.push(`changed: ${ref}`)
  }
  for (const persona of applied.personas) {
    if (!next.personas.some((p) => p.key === persona.key)) lines.push(`removed: ${renderPersonaRef(persona.name, persona.key)}`)
  }
  for (const name of changedServerSettings(applied, next)) lines.push(`server-wide setting changed: ${name}`)
  for (const persona of state.credentialsChanged) {
    lines.push(
      `credentials changed: ${renderPersonaRef(persona.name, persona.key)} ` +
        `credentials_file=${JSON.stringify(persona.credentials_file)}`,
    )
  }
  if (lines.length === 0) lines.push('no effective change')
  return lines
}

/** What the log last said about the pending state, for logging only its changes. */
type LoggedPendingState =
  /** Before the first pass: counts as nothing pending, but a leftover pending file may still be deleted. */
  | { kind: 'initial' }
  | { kind: 'nothing' }
  | { kind: 'pending'; fingerprint: string }

/** The pending file as the tick found it. */
type PendingFileRead = { kind: 'bytes'; bytes: Buffer } | { kind: 'absent' } | { kind: 'other' }

/** The detection tick over one applied configuration, and the switch that ends it. */
interface PendingDetection {
  tick: ReloadTick
  stop(): void
}

/**
 * Build the detection tick (b.av2 SR-8.2, SR-8.3) over the applied
 * configuration. One pass reads the configuration file once and, unless in
 * dry run, each credentials file it references once (stat-first, so a FIFO
 * or a device reads as unreadable and never blocks), derives the pending
 * state, then keeps `config.json.pending` in step: written durably when a
 * change is pending and the file is missing or stale, deleted durably when
 * nothing is pending. The credentials bytes are dropped at the end of the
 * pass; only their digests are compared, with the held ones.
 *
 * Logging, through `deps.log` only (the server log, never Slack):
 * - `reload-preview`, one line, when the pending state (nothing, or pending
 *   with fingerprint F) changes to pending with a new fingerprint; a rewrite
 *   of a missing or stale file with an unchanged state logs nothing;
 * - `reload-nothing-pending`, one line, when the state changes to nothing
 *   pending, or at the first pass after a start that deletes a leftover
 *   pending file; never at a clean start;
 * - a failed pending-file write or delete, once per episode (an episode ends
 *   at the next success or when the derived state changes), retried at the
 *   next pass; a delete whose directory sync failed is not retried (the file
 *   is gone) and is logged once, saying so;
 * - an unexpected failure of a pass, once per episode.
 *
 * Never reads, writes, renames or deletes `config.json.apply` or the record,
 * calls no lifecycle operation and creates no Slack client. Never throws.
 */
function createPendingDetection(deps: ReloadControllerDeps, applied: AppliedConfiguration): PendingDetection {
  const { paths } = deps
  const write = deps.write ?? durableWriteFileSync
  const remove = deps.remove ?? durableUnlinkSync
  const dryRun = deps.dryRun === true
  const configDir = dirname(paths.config)
  let logged: LoggedPendingState = { kind: 'initial' }
  /**
   * The state the last pass derived (`'nothing'`, or the fingerprint of the
   * pending change): a change of it starts a new file-failure episode.
   */
  let derivedState: string | undefined
  let fileFailureLatched = false
  let tickFailureLatched = false
  /** The last write reached the file but not its directory's fsync: write again. */
  let rewriteDue = false
  let running = false
  let stopped = false

  /** The candidate for bytes that differ from the applied bytes (default mode, so collisions are rejected). */
  function candidateOf(read: ConfigFileRead, configChanged: boolean): PendingCandidate {
    if (!read.ok) return { kind: 'unreadable', missing: read.missing, code: read.code }
    if (!configChanged) return { kind: 'valid', config: applied.config }
    try {
      return { kind: 'valid', config: parsePersonaConfigBytes(read.bytes, paths.config, configDir, { home: deps.home }) }
    } catch (err) {
      return { kind: 'invalid', error: errorMessage(err) }
    }
  }

  /**
   * One pass's pending state. Every credentials file is read and digested at
   * most once, and only outside dry run.
   */
  function derive(): PendingState {
    const read = readConfigFile(paths.config, deps.configFs)
    const configChanged = !read.ok || !read.bytes.equals(applied.bytes)
    const candidate = candidateOf(read, configChanged)

    const credentialsReads = new Map<string, CredentialsFileRead>()
    const readCredentials = (path: string): CredentialsFileRead => {
      let result = credentialsReads.get(path)
      if (result === undefined) {
        result = readCredentialsFile(path, deps.credentialsFs)
        credentialsReads.set(path, result)
      }
      return result
    }
    const digests = new Map<string, CredentialsDigest>()
    const digestOf = (path: string): CredentialsDigest => {
      let digest = digests.get(path)
      if (digest === undefined) {
        digest = credentialsDigest(readCredentials(path))
        digests.set(path, digest)
      }
      return digest
    }

    const entries: FingerprintCredentialsEntry[] = []
    if (!dryRun && read.ok) {
      for (const path of new Set(referencedCredentialsPaths(read.bytes, deps.home))) {
        entries.push({ path, content: fingerprintContentOf(readCredentials(path)) })
      }
    }

    const credentialsChanged: Persona[] = []
    if (!dryRun && candidate.kind === 'valid') {
      for (const persona of candidate.config.personas) {
        const before = applied.config.personas.find((p) => p.key === persona.key)
        if (before === undefined || before.credentials_file !== persona.credentials_file) continue
        // Nothing held (no query, or an unknown persona): never counts as changed.
        // A persona broken by a shared credentials file holds its own file's digest.
        const held = deps.heldCredentialsDigest?.(persona.key)
        if (held === undefined) continue
        if (digestOf(persona.credentials_file) !== held) credentialsChanged.push(persona)
      }
    }

    const fingerprint = reloadFingerprint(fingerprintContentOf(read), entries)
    return { configChanged, candidate, credentialsChanged, fingerprint, pending: configChanged || credentialsChanged.length > 0 }
  }

  function readPendingFile(): PendingFileRead {
    try {
      return { kind: 'bytes', bytes: readPersonaConfigBytes(paths.pending, deps.configFs) }
    } catch (err) {
      const code = err instanceof PersonaConfigReadError ? err.code : undefined
      return isMissingConfigCode(code) ? { kind: 'absent' } : { kind: 'other' }
    }
  }

  function noteFileFailure(line: string): void {
    if (fileFailureLatched) return
    fileFailureLatched = true
    deps.log(line)
  }

  /** Write the pending file when it is missing or stale; log the preview when the state changed. */
  function keepPending(state: PendingState, file: PendingFileRead): void {
    const lines = renderPreviewLines(state, applied.config, paths.config)
    const valid = state.candidate.kind === 'valid'
    const body = (valid ? [PENDING_PREVIEW_TITLE, ...lines] : lines).join('\n')
    const bytes = Buffer.from(composePendingFile(state.fingerprint, body), 'utf-8')
    if (rewriteDue || file.kind !== 'bytes' || !file.bytes.equals(bytes)) {
      try {
        write(paths.pending, bytes)
        rewriteDue = false
        fileFailureLatched = false
      } catch (err) {
        rewriteDue = err instanceof DurableWriteUnsyncedError
        noteFileFailure(
          rewriteDue
            ? `[slack] reload: wrote the pending-change file "${paths.pending}" but could not sync its directory${errnoSuffix(err)}; writing it again at the next check`
            : `[slack] reload: cannot write the pending-change file "${paths.pending}"${errnoSuffix(err)}; retrying at the next check`,
        )
      }
    }
    if (logged.kind === 'pending' && logged.fingerprint === state.fingerprint) return
    logged = { kind: 'pending', fingerprint: state.fingerprint }
    const summary = (valid ? 'a configuration change is pending, nothing has been applied: ' : '') + lines.join('; ')
    deps.log(`[slack] ${RELOAD_PREVIEW}: ${escapeCause(summary)} (preview in "${paths.pending}")`)
  }

  /**
   * Delete the pending file when present; once it is gone, log
   * `reload-nothing-pending` if the state changed to nothing pending (or the
   * first check removed a leftover file).
   */
  function keepNothingPending(file: PendingFileRead): void {
    rewriteDue = false
    let removed = false
    let gone = file.kind === 'absent'
    if (!gone) {
      try {
        removed = remove(paths.pending)
        gone = true
        fileFailureLatched = false
      } catch (err) {
        if (err instanceof DurableUnlinkUnsyncedError) {
          // The file is gone; only the removal's durability is in doubt, and
          // nothing retries it (the next start's first check removes a file
          // that reappears after a crash). Logged once per such removal: the
          // file is gone afterwards, so the next check does not remove it.
          removed = true
          gone = true
          fileFailureLatched = false
          deps.log(
            `[slack] reload: removed the pending-change file "${paths.pending}" but could not sync its directory` +
              `${errnoSuffix(err)}; it may reappear after a crash, and the next start removes it`,
          )
        } else {
          noteFileFailure(
            `[slack] reload: cannot remove the pending-change file "${paths.pending}"${errnoSuffix(err)}; retrying at the next check`,
          )
        }
      }
    }
    // A file that could not be removed keeps the logged state as it is, so the
    // line below follows the removal that succeeds at a later check.
    if (!gone) return
    if (logged.kind === 'pending' || (logged.kind === 'initial' && removed)) {
      deps.log(
        `[slack] ${RELOAD_NOTHING_PENDING}: the configuration file and the credentials files it references match ` +
          `what is applied; no change is pending` +
          (removed ? `, and the pending-change file "${paths.pending}" is removed` : ''),
      )
    }
    logged = { kind: 'nothing' }
  }

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      const state = derive()
      const stateId = state.pending ? state.fingerprint : 'nothing'
      if (stateId !== derivedState) {
        // A new pending state, or nothing pending: its first file failure is logged again.
        derivedState = stateId
        fileFailureLatched = false
      }
      const file = readPendingFile()
      if (state.pending) keepPending(state, file)
      else keepNothingPending(file)
      tickFailureLatched = false
    } catch (err) {
      if (!tickFailureLatched) {
        tickFailureLatched = true
        deps.log(`[slack] reload: detection check failed: ${describeThrownValue(err)}; checking again at the next tick`)
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    stop: () => {
      stopped = true
    },
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The reload controller handle. */
export interface ReloadController {
  /**
   * Resolve the start (b.av2 SR-8.7): choose the record or the configuration
   * file, write the record when there was none, and keep the applied bytes
   * and configuration. A refusal is logged here, as one line, and nothing is
   * applied. Reads no credentials file. Call once, before anything consumes
   * the configuration; a second call throws.
   */
  resolveStart(): ReloadStartOutcome
  /**
   * The start bring-up pass over the applied set, through the injected
   * `lifecycle.startBringUp`. Call once, after `resolveStart` returned
   * `applied` and after the server's pre-launch steps; any other call throws.
   * Resolves when the pass returns.
   */
  runStartBringUp(): Promise<void>
  /** The applied configuration and its bytes, once the start resolved `applied`. */
  applied(): AppliedConfiguration | undefined
  /**
   * Start the detection tick (b.av2 SR-8.2): hand it to the injected tick
   * driver. Arms it only once, and only after the start resolved `applied`
   * and the start bring-up pass returned (`runStartBringUp` settled, even by
   * a throw); called before that, after a refused start, a second time,
   * after `stopDetection` or without a tick driver, it arms nothing. Returns
   * whether it armed the tick. Resolution and the bring-up never start
   * detection on their own.
   */
  startDetection(): boolean
  /**
   * Stop the detection tick at shutdown: stop the tick driver, and make any
   * pass still due do nothing. Idempotent; safe before `startDetection`.
   */
  stopDetection(): void
  /**
   * The credentials files the file guard must refuse (b.av2 SR-5.2): the
   * applied set's `credentials_file` paths, plus every `credentials_file`
   * string in the `personas` entries of the configuration file as it stands
   * now (`credentialsFilesToProtect`). Reads the configuration file on every
   * call, whatever the start phase. A missing, non-regular or non-JSON file
   * adds none. Reads no credentials file and never throws.
   */
  protectedCredentialsFiles(): string[]
}

/** Where the controller is in the start. */
type StartPhase = 'unresolved' | 'refused' | 'applied' | 'bringing-up' | 'brought-up'

/**
 * Create the reload controller. Creating it reads, writes, logs and arms
 * nothing. `resolveStart` does the start's reads, write and log line;
 * `startDetection` arms the detection tick (`createPendingDetection`) once
 * the start bring-up pass has returned; `protectedCredentialsFiles` reads the
 * configuration file on each call, at any phase, and writes and logs nothing.
 */
export function createReloadController(deps: ReloadControllerDeps): ReloadController {
  const { paths, lifecycle } = deps
  const write = deps.write ?? durableWriteFileSync
  let phase: StartPhase = 'unresolved'
  let appliedState: AppliedConfiguration | undefined
  let detection: PendingDetection | undefined
  let detectionStopped = false

  function refuse(source: AppliedConfigSource, cls: ReloadDiagnosticClass | undefined, line: string): ReloadStartOutcome {
    phase = 'refused'
    deps.log(line)
    return { kind: 'refused', source, class: cls, line }
  }

  function resolveStart(): ReloadStartOutcome {
    if (phase !== 'unresolved') throw new Error('reload: resolveStart may be called only once')
    const selection = selectConfiguration(paths, deps.home, deps.configFs)
    if (!selection.ok) {
      const prefix = selection.source === 'record' ? RECORD_REFUSAL_PREFIX : CONFIG_REFUSAL_PREFIX
      return refuse(selection.source, undefined, prefix + selection.message)
    }
    const { applied } = selection
    if (applied.source === 'config') {
      try {
        write(paths.lastApplied, applied.bytes)
      } catch (err) {
        if (err instanceof DurableWriteUnsyncedError) {
          // The rename happened: the record is on disk and the next start runs
          // it. Say so, rather than "cannot write".
          return refuse(
            'config',
            RELOAD_RECORD_WRITE_FAILED,
            `[slack] ${RELOAD_RECORD_WRITE_FAILED}: the last-applied record "${paths.lastApplied}" was written but its ` +
              `directory could not be synced${errnoSuffix(err)}, so it may not survive a crash, and the next start ` +
              `will run it; the server does not start`,
          )
        }
        return refuse(
          'config',
          RELOAD_RECORD_WRITE_FAILED,
          `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write the last-applied record "${paths.lastApplied}"` +
            `${errnoSuffix(err)}; the server does not start and nothing is applied`,
        )
      }
      deps.log(`[slack] No last-applied record: recorded the configuration file "${paths.config}" as "${paths.lastApplied}"`)
    } else {
      deps.log(`[slack] Starting from the last-applied record "${paths.lastApplied}"`)
    }
    phase = 'applied'
    appliedState = applied
    return { kind: 'applied', ...applied }
  }

  async function runStartBringUp(): Promise<void> {
    if (phase !== 'applied' || appliedState === undefined) {
      throw new Error('reload: the start bring-up runs once, after the start resolved an applied configuration')
    }
    phase = 'bringing-up'
    try {
      await lifecycle.startBringUp(appliedState.config)
    } finally {
      phase = 'brought-up'
    }
  }

  function startDetection(): boolean {
    if (phase !== 'brought-up' || appliedState === undefined) return false
    if (detection !== undefined || detectionStopped || deps.tickDriver === undefined) return false
    detection = createPendingDetection(deps, appliedState)
    deps.tickDriver.start(detection.tick)
    return true
  }

  function stopDetection(): void {
    detectionStopped = true
    detection?.stop()
    deps.tickDriver?.stop()
  }

  return {
    resolveStart,
    runStartBringUp,
    startDetection,
    stopDetection,
    applied: () => appliedState,
    protectedCredentialsFiles: () =>
      credentialsFilesToProtect(appliedState?.config.personas ?? [], paths.config, deps.home, deps.configFs),
  }
}

// ---------------------------------------------------------------------------
// CLI resolver
// ---------------------------------------------------------------------------

/**
 * The configuration the CLI takes its settings and persona set from (b.av2
 * SR-8.7): the last-applied record beside `configPath` when it exists
 * (validated in record mode, so a record with a real-path collision still
 * resolves), otherwise the configuration file. Read-only: never writes,
 * rewrites or deletes the record or any other reload file. A record that
 * exists but cannot be read or validated throws, naming the record with the
 * deletion hint; it never falls back to the configuration file. A
 * configuration-file failure throws with the start's wording.
 *
 * @param configPath  The configuration file the server loads; `~` is expanded under `home`.
 * @param home        Home directory for every `~`; the OS home by default.
 * @param fs          File-system overrides for the reads (`readPersonaConfigBytes`);
 *   the real file system by default.
 */
export function readAppliedPersonaConfig(
  configPath: string,
  home?: string,
  fs?: Partial<PersonaConfigFs>,
): PersonaConfig {
  const selection = selectConfiguration(reloadFilePaths(resolve(expandTilde(configPath, home))), home, fs)
  if (!selection.ok) throw new Error(selection.message)
  return selection.applied.config
}
