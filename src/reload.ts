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
 * holds, and keeps `config.json.pending` (the SR-8.4 preview, rendered from
 * the change plan of `reload-plan.ts`, behind a fingerprint,
 * `reload-fingerprint.ts`) in step: written while a change is pending,
 * deleted when nothing is. Its first pass after a start from the record is
 * the SR-8.7 comparison, so an unconfirmed edit stays pending.
 *
 * Confirmation and apply (b.av2 SR-8.5, SR-8.6): each pass first processes
 * `config.json.apply` (the operator's rename of the pending file), deleting it
 * before anything is applied. A confirmation whose fingerprint matches the
 * pass's applies the bytes and the change plan that pass derived: an invalid
 * candidate logs `reload-invalid` and changes nothing; a valid one runs step
 * 1 (rewrite the record, then swap the applied state and tell `onApplied`),
 * then steps 2–6 of `reload-apply.ts` in order (by default step 2 tears down
 * each removed persona and step 6 brings up each added one, through the
 * lifecycle operations), and logs
 * `reload-applied`, or `reload-noop` when nothing effective changed. A
 * mismatched, unreadable or malformed confirmation applies nothing and logs
 * `reload-stale-confirmation`. The pending state is then refreshed against
 * what is applied.
 *
 * The controller (`createReloadController`) is built with every dependency
 * injected, as `createCronScheduler` is: the SR-8.1 paths, the durable
 * writer and delete, the log sink, the lifecycle operations (the start
 * bring-up pass, and the apply's teardown and bring-up), the tick driver, the dry-run flag, the held
 * credentials digests and bring-up states, and the Slack client factory that later work binds
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

import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  DurableWriteUnsyncedError,
} from './atomic-write.ts'
import {
  configFileReadFailureMessage,
  configReadFailurePredicate,
  credentialsFilesToProtect,
  isMissingConfigCode,
  parsePersonaConfigBytes,
  PersonaConfigReadError,
  readPersonaConfigBytes,
  referencedCredentialsPaths,
  resolveRealPath,
  type Persona,
  type PersonaConfig,
  type PersonaConfigFs,
} from './config.ts'
import { checkPersonaWorkingDirectory, type WorkingDirectoryFs } from './persona-bringup.ts'
import type { PersonaBringUpState } from './persona-bringup-controller.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import {
  credentialsDigest,
  credentialsReadProblem,
  errnoSuffix,
  readCredentialsFile,
  type CredentialsDigest,
  type CredentialsFileRead,
  type CredentialsFs,
} from './persona-credentials.ts'
import { expandTilde, renderPersonaRef } from './persona-identity.ts'
import type { PersonaSlackClientFactory } from './persona-slack-clients.ts'
import {
  applyStepInputs,
  applyStepNumber,
  applyStepsFor,
  lifecycleApplySlots,
  RELOAD_APPLIED,
  RELOAD_NOOP,
  RELOAD_STALE_CONFIRMATION,
  renderAppliedLogLine,
  renderConfirmedInvalidLogLine,
  renderNoopLogLine,
  renderStaleConfirmationLogLine,
  runApplySteps,
  type ApplyStepSlots,
  type InPlaceApplyInput,
  type StaleConfirmationReason,
} from './reload-apply.ts'
import {
  composePendingFile,
  FINGERPRINT_MISSING,
  FINGERPRINT_UNREADABLE,
  parsePendingFingerprint,
  reloadFingerprint,
  type FingerprintContent,
  type FingerprintCredentialsEntry,
} from './reload-fingerprint.ts'
import {
  addedPersonas,
  buildChangePlan,
  FACT_UNKNOWN,
  RELOAD_INVALID,
  RELOAD_PREVIEW,
  renderInvalidLogLine,
  renderPreview,
  renderPreviewLogLines,
  type AddedPersonaCause,
  type ChangePlan,
  type ChangePlanCandidate,
  type ChangePlanFacts,
  type FactUnknown,
} from './reload-plan.ts'

export { RELOAD_INVALID, RELOAD_PREVIEW } from './reload-plan.ts'
export { RELOAD_APPLIED, RELOAD_NOOP, RELOAD_STALE_CONFIRMATION } from './reload-apply.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes (b.av2 SR-10.3)
// ---------------------------------------------------------------------------

/**
 * The last-applied record could not be written. At a start without a record,
 * the server does not start and nothing is applied; at a confirmed apply,
 * nothing is applied and the change stays pending.
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
 * configuration, not one persona. `reload-preview` and `reload-invalid` are
 * defined beside the preview they log (`reload-plan.ts`); `reload-applied`,
 * `reload-noop` and `reload-stale-confirmation` beside the apply
 * (`reload-apply.ts`).
 */
export const RELOAD_DIAGNOSTIC_CLASSES = [
  RELOAD_RECORD_WRITE_FAILED,
  RELOAD_NOTHING_PENDING,
  RELOAD_PREVIEW,
  RELOAD_INVALID,
  RELOAD_APPLIED,
  RELOAD_NOOP,
  RELOAD_STALE_CONFIRMATION,
] as const

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
 * is the start pass. A confirmed apply's default step bodies
 * (`lifecycleApplySlots`, `reload-apply.ts`) fan out to `teardown` (step 2,
 * each removed persona), `updateInPlace` (step 3, each persona modified in
 * place) and `bringUp` (step 6, each added persona); production binds all
 * three through `persona-lifecycle.ts`. `reconnectCredentials` is bound by
 * the work that implements step 4, and nothing calls it yet.
 */
export interface ReloadLifecycleOps {
  /**
   * The start bring-up pass over the whole applied set: every persona's
   * bring-up and, for each persona that is up, its launch. Resolves once
   * every persona has an outcome (production: `startupSessionManager` over
   * the bring-up controller).
   */
  startBringUp(applied: PersonaConfig): Promise<unknown>
  /**
   * Bring up one persona a confirmed change added, `applied` being the
   * configuration step 1 made current. Resolves once it has an outcome and,
   * when up, its launch settled.
   */
  bringUp(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /** Tear down one persona a confirmed change removed (and, from E13, the old half of a destructive modify). */
  teardown(persona: Persona): Promise<unknown>
  /** Reconnect one persona with its changed credentials file. */
  reconnectCredentials?(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /**
   * Apply the in-place settings of one persona a confirmed change modified in
   * place, without tearing it down (its instance is kept): `change.persona`
   * is its entry in the configuration step 1 made current.
   */
  updateInPlace(change: InPlaceApplyInput): Promise<unknown>
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

/** An applied persona's current bring-up state (the bring-up controller's `state`), or undefined when unknown. */
export type BringUpStateQuery = (key: string) => PersonaBringUpState | undefined

/** Dependencies of `createReloadController`. */
export interface ReloadControllerDeps {
  /** The configuration file and its reload files (`reloadFilePaths`). */
  paths: ReloadFilePaths
  /** The lifecycle operations; all but `reconnectCredentials` are required. */
  lifecycle: ReloadLifecycleOps
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: ReloadFileWriter
  /** The durable delete (of `config.json.pending` and `config.json.apply`); `durableUnlinkSync` by default. */
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
   * An applied persona's current bring-up state (production: the bring-up
   * controller's `state`), for the preview of a credentials change: a
   * persona broken by its credentials is brought up at apply rather than
   * reconnected (b.av2 SR-8.6). Without it no persona counts as broken by its
   * credentials.
   */
  bringUpState?: BringUpStateQuery
  /**
   * File-system overrides for the detection tick's credentials reads
   * (`readCredentialsFile`, which reads only a regular file); unset
   * operations use the real file system.
   */
  credentialsFs?: Partial<CredentialsFs>
  /**
   * File-system overrides for the detection tick's working-directory check
   * of an added persona (`checkPersonaWorkingDirectory`); unset operations
   * use the real file system.
   */
  workingDirectoryFs?: Partial<WorkingDirectoryFs>
  /** The Slack client factory; bound by the work that applies a confirmed change. */
  slackClientFactory?: PersonaSlackClientFactory
  /**
   * Told the configuration a confirmed apply's step 1 made the applied one,
   * right after the record was rewritten and in the same synchronous step as
   * the controller's own swap (b.av2 SR-8.6). Production reassigns the
   * server's `personaConfig` to the new persona set with the start-time
   * server-wide values; the bring-up controller's applied set and the
   * reply-guard step read it from there. A throw is logged; the apply goes on.
   */
  onApplied?: (config: PersonaConfig) => void
  /**
   * Test override: the bodies of apply steps 2–6 (`reload-apply.ts`), used
   * instead of the default ones; an unbound step then does nothing. Without
   * it the controller runs `lifecycleApplySlots` over `lifecycle` (step 2
   * tears down each removed persona, step 3 updates each persona modified in
   * place, step 6 brings up each added one).
   * Production never sets it.
   */
  applySteps?: ApplyStepSlots
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
      const cause = `The last-applied record "${paths.lastApplied}" ${configReadFailurePredicate(code)}.`
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

/** One read of the configuration file by the detection tick. */
type ConfigFileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; missing: boolean; code: string | undefined }

/** The pending state one detection pass derived. Holds no credentials content. */
interface PendingState {
  /**
   * The configuration file's bytes this pass read and fingerprinted, or
   * undefined when it could not be read: what a matching confirmation applies.
   */
  bytes: Buffer | undefined
  /** The candidate the plan was built from (parsed from `bytes`). */
  candidate: ChangePlanCandidate
  /** The configuration file's bytes differ from the applied bytes (or it cannot be read). */
  configChanged: boolean
  /**
   * The change plan of the candidate against the applied configuration
   * (`buildChangePlan`): what the preview renders, and the one place a
   * credentials change is decided (never in dry run).
   */
  plan: ChangePlan
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

/** What the detection tick asks of the controller that owns the applied state. */
interface PendingDetectionHost {
  /** The applied configuration now; read at the start of every derivation, so a swap is seen at once. */
  applied(): AppliedConfiguration
  /**
   * Apply the pass's state after a matching confirmation (b.av2 SR-8.6).
   * Resolves true when the applied state changed (step 1 succeeded), false
   * when nothing was applied. Rejects only on a programming error, before
   * anything is written.
   */
  applyConfirmed(state: PendingState): Promise<boolean>
}

/** The confirmation as the tick found it. */
type ConfirmationRead =
  | { kind: 'absent' }
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'unreadable'; code: string | undefined }

/**
 * The in-memory identity of a confirmation that could not be read: every
 * unreadable confirmation has this one, so it is ignored until it can be read.
 */
const UNREADABLE_CONFIRMATION_IDENTITY = 'unreadable'

/**
 * Build the detection tick (b.av2 SR-8.2, SR-8.3, SR-8.5) over the applied
 * configuration, which it reads from `host` at the start of every derivation
 * (so a confirmed apply's swap is seen at once, with the logged state kept).
 * One pass reads the configuration file once and, unless in
 * dry run, each credentials file it references once (stat-first, so a FIFO
 * or a device reads as unreadable and never blocks), derives the pending
 * state through the change plan (`buildChangePlan` in `reload-plan.ts`),
 * then keeps `config.json.pending` in step: written durably, with the
 * SR-8.4 preview rendered from the plan, when a change is pending and the
 * file is missing or differs from what the pass would write; deleted durably
 * when nothing is pending. The credentials bytes are dropped at the end of
 * the pass; only their digests are compared, with the held ones.
 *
 * The plan's facts come from what the pass already read, plus the least
 * extra I/O: real paths only for paths written differently in the two
 * configurations, and for each added persona the credentials content check
 * over the bytes already read (none in dry run) and the working-directory
 * check. An unchanged persona is not probed. The bring-up state is asked
 * only for a persona whose credentials changed.
 *
 * Confirmation (b.av2 SR-8.5): each pass first derives the state, then
 * processes `config.json.apply` before refreshing the pending state. The
 * confirmation is read once (stat-first) and deleted durably before anything
 * is decided; its fingerprint (`parsePendingFingerprint`) is compared with
 * this pass's. On a match the pass's own bytes and plan go to
 * `host.applyConfirmed`, and the state is derived again against the new
 * applied state; a mismatch, an unreadable file or one with no fingerprint
 * applies nothing and logs one `reload-stale-confirmation` line. A deleted
 * confirmation is used once. One that cannot be deleted is acted on once, and
 * a SHA-256 of its bytes (or one fixed identity for an unreadable file) is
 * kept in memory: the same content is then ignored, silently, with its delete
 * retried, until it changes or is gone. The pending file is then kept in step
 * as usual, so a change still pending after a consumed confirmation has its
 * pending file written again on the same pass. A consumed confirmation of an
 * invalid candidate logs its `reload-invalid` line once, in the apply, and
 * counts as the logged pending state, so the same candidate never gets a
 * second, pending-time `reload-invalid` line.
 *
 * Logging, through `deps.log` only (the server log, never Slack):
 * - when the pending state (nothing, or pending with fingerprint F) changes
 *   to pending with a new fingerprint: for a valid candidate every line of
 *   the preview, each classed `reload-preview`; for an invalid one (a
 *   missing or unreadable configuration file included) the one
 *   `reload-invalid` line. A rewrite of a missing or stale file with an
 *   unchanged state logs nothing, even when the preview changed (an added
 *   persona's directory was created, say);
 * - a preview fact that could not be gathered, once until a pass gathers
 *   every fact again; the preview says the fact could not be checked
 *   (`FACT_UNKNOWN`) instead of claiming an answer;
 * - `reload-nothing-pending`, one line, when the state changes to nothing
 *   pending, or at the first pass after a start that deletes a leftover
 *   pending file; never at a clean start;
 * - a failed pending-file write or delete, once per episode (an episode ends
 *   at the next success or when the derived state changes), retried at the
 *   next pass; a delete whose directory sync failed is not retried (the file
 *   is gone) and is logged once, saying so;
 * - an unexpected failure of a pass, once per episode;
 * - after an apply that leaves nothing pending, no `reload-nothing-pending`
 *   line: the apply's own line says what happened;
 * - a confirmation that cannot be deleted, once, as a plain line naming it.
 *
 * Writes the record, and calls a lifecycle operation, only through
 * `host.applyConfirmed`. Creates no Slack client. Never throws.
 */
function createPendingDetection(deps: ReloadControllerDeps, host: PendingDetectionHost): PendingDetection {
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
  /** The applied configuration of the current derivation (`host.applied()`). */
  let applied = host.applied()
  /** The identity of a confirmation acted on once that could not be deleted. */
  let ignoredConfirmation: string | undefined

  let factFailureLatched = false
  /** A fact the preview needs could not be gathered in this pass. */
  let factFailed = false

  /**
   * A persona named by key, as the logs name it (b.av2 SR-2.2): its
   * JSON-quoted name from the candidate (else the applied set), key beside it.
   */
  function personaRefOf(key: string, candidate: ChangePlanCandidate): string {
    const candidatePersonas = candidate.kind === 'valid' ? candidate.config.personas : []
    const persona = [...candidatePersonas, ...applied.config.personas].find((p) => p.key === key)
    return persona !== undefined ? renderPersonaRef(persona.name, persona.key) : `(key=${key})`
  }

  /** The candidate for bytes that differ from the applied bytes (default mode, so collisions are rejected). */
  function candidateOf(read: ConfigFileRead, configChanged: boolean): ChangePlanCandidate {
    if (!read.ok) return { kind: 'unreadable', path: paths.config, missing: read.missing, code: read.code }
    if (!configChanged) return { kind: 'valid', config: applied.config }
    try {
      return { kind: 'valid', config: parsePersonaConfigBytes(read.bytes, paths.config, configDir, { home: deps.home }) }
    } catch (err) {
      return { kind: 'invalid', error: errorMessage(err) }
    }
  }

  /**
   * A preview fact that could not be gathered (an injected query or check
   * threw): logged once until a pass gathers every fact again; the plan
   * carries it as `FACT_UNKNOWN`, and the preview says it could not be
   * checked.
   */
  function noteFactFailure(what: string, err: unknown): void {
    factFailed = true
    if (factFailureLatched) return
    factFailureLatched = true
    deps.log(`[slack] reload: cannot check ${what}: ${describeThrownValue(err)}; the preview says it could not be checked`)
  }

  /**
   * Whether each added persona can come up, as its bring-up would check it
   * (b.av2 SR-6.1 steps 1 and 2): the credentials content from the bytes this
   * pass already read (no second read; none in dry run, where no credentials
   * file is read) and the working-directory check. No other persona is
   * probed: a valid candidate has no real-path collision, so the directory
   * check runs without the others.
   */
  function addedCannotComeUp(
    candidate: PersonaConfig,
    readCredentials: (path: string) => CredentialsFileRead,
  ): Map<string, AddedPersonaCause[] | FactUnknown> {
    const result = new Map<string, AddedPersonaCause[] | FactUnknown>()
    for (const persona of addedPersonas(applied.config, candidate)) {
      try {
        const causes: AddedPersonaCause[] = []
        const credentials = dryRun ? undefined : credentialsReadProblem(readCredentials(persona.credentials_file))
        if (credentials !== undefined) causes.push({ step: 'credentials', cause: credentials })
        const directory = checkPersonaWorkingDirectory(persona, { others: [], fs: deps.workingDirectoryFs })
        if (!directory.ok) causes.push({ step: 'working-directory', cause: directory.cause })
        result.set(persona.key, causes)
      } catch (err) {
        noteFactFailure(`whether the added persona ${renderPersonaRef(persona.name, persona.key)} can come up`, err)
        result.set(persona.key, FACT_UNKNOWN)
      }
    }
    return result
  }

  /**
   * One pass's pending state. Every credentials file is read and digested at
   * most once, and only outside dry run. The change plan decides whether any
   * credentials changed (`buildChangePlan`), from the digests of this pass's
   * reads and the held ones; the bytes are dropped when the pass returns.
   */
  function derive(): PendingState {
    applied = host.applied()
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
    const realPaths = new Map<string, string>()
    const realPathOf = (path: string): string => {
      let real = realPaths.get(path)
      if (real === undefined) {
        real = resolveRealPath(path)
        realPaths.set(path, real)
      }
      return real
    }

    const entries: FingerprintCredentialsEntry[] = []
    if (!dryRun && read.ok) {
      for (const path of new Set(referencedCredentialsPaths(read.bytes, deps.home))) {
        entries.push({ path, content: fingerprintContentOf(readCredentials(path)) })
      }
    }

    factFailed = false
    const facts: ChangePlanFacts = {
      realPath: realPathOf,
      home: deps.home,
      dryRun,
      currentCredentialsDigest: (path) => (dryRun ? undefined : digestOf(path)),
      // Nothing held (no query, or an unknown persona): never counts as changed.
      // A persona broken by a shared credentials file holds its own file's digest.
      heldCredentialsDigest: (key) => deps.heldCredentialsDigest?.(key),
      // The same bytes the digest came from: no second read, none in dry run.
      credentialsProblem: (path) => (dryRun ? undefined : credentialsReadProblem(readCredentials(path))),
      bringUpState: (key) => {
        try {
          return deps.bringUpState?.(key)
        } catch (err) {
          noteFactFailure(`the bring-up state of persona ${personaRefOf(key, candidate)}`, err)
          return FACT_UNKNOWN
        }
      },
      addedCannotComeUp: candidate.kind === 'valid' ? addedCannotComeUp(candidate.config, readCredentials) : undefined,
    }
    const plan = buildChangePlan(applied.config, candidate, facts)
    if (!factFailed) factFailureLatched = false

    const fingerprint = reloadFingerprint(fingerprintContentOf(read), entries)
    const credentialsChanged = plan.valid && plan.credentials.length > 0
    return {
      bytes: read.ok ? read.bytes : undefined,
      candidate,
      configChanged,
      plan,
      fingerprint,
      pending: configChanged || credentialsChanged,
    }
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

  /**
   * Write the pending file (the SR-8.4 preview behind the fingerprint) when it
   * is missing or differs from what this pass would write; log the preview
   * when the pending state changed: every `reload-preview` line of a valid
   * candidate, or the one `reload-invalid` line of an invalid one. The log
   * points at the pending file only when it holds this pass's preview.
   */
  function keepPending(state: PendingState, file: PendingFileRead): void {
    const bytes = Buffer.from(composePendingFile(state.fingerprint, renderPreview(state.plan)), 'utf-8')
    let current = !rewriteDue && file.kind === 'bytes' && file.bytes.equals(bytes)
    if (!current) {
      try {
        write(paths.pending, bytes)
        rewriteDue = false
        fileFailureLatched = false
        current = true
      } catch (err) {
        rewriteDue = err instanceof DurableWriteUnsyncedError
        // An unsynced write still put the preview in place.
        current = rewriteDue
        noteFileFailure(
          rewriteDue
            ? `[slack] reload: wrote the pending-change file "${paths.pending}" but could not sync its directory${errnoSuffix(err)}; writing it again at the next check`
            : `[slack] reload: cannot write the pending-change file "${paths.pending}"${errnoSuffix(err)}; retrying at the next check`,
        )
      }
    }
    if (logged.kind === 'pending' && logged.fingerprint === state.fingerprint) return
    logged = { kind: 'pending', fingerprint: state.fingerprint }
    const pendingFile = current ? paths.pending : undefined
    const lines = state.plan.valid
      ? renderPreviewLogLines(state.plan, pendingFile)
      : [renderInvalidLogLine(state.plan, pendingFile)]
    for (const line of lines) deps.log(line)
  }

  /**
   * Delete the pending file when present; once it is gone, log
   * `reload-nothing-pending` if the state changed to nothing pending (or the
   * first check removed a leftover file), unless `quiet` (an apply on this
   * pass already said what happened).
   */
  function keepNothingPending(file: PendingFileRead, quiet: boolean): void {
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
    if (!quiet && (logged.kind === 'pending' || (logged.kind === 'initial' && removed))) {
      deps.log(
        `[slack] ${RELOAD_NOTHING_PENDING}: the configuration file and the credentials files it references match ` +
          `what is applied; no change is pending` +
          (removed ? `, and the pending-change file "${paths.pending}" is removed` : ''),
      )
    }
    logged = { kind: 'nothing' }
  }

  /** The confirmation, read once and stat-first, or why there is none. Never throws. */
  function readConfirmation(): ConfirmationRead {
    try {
      return { kind: 'bytes', bytes: readPersonaConfigBytes(paths.apply, deps.configFs) }
    } catch (err) {
      const code = err instanceof PersonaConfigReadError ? err.code : undefined
      return isMissingConfigCode(code) ? { kind: 'absent' } : { kind: 'unreadable', code }
    }
  }

  /**
   * Delete the confirmation durably. True when it is gone (removed, already
   * absent, or removed with a directory sync that failed); false when it is
   * still there. Logs a failure only when `quietly` is false.
   */
  function removeConfirmation(quietly: boolean): boolean {
    try {
      remove(paths.apply)
      return true
    } catch (err) {
      if (err instanceof DurableUnlinkUnsyncedError) {
        if (!quietly) {
          deps.log(
            `[slack] reload: removed the confirmation "${paths.apply}" but could not sync its directory` +
              `${errnoSuffix(err)}; it may reappear after a crash`,
          )
        }
        return true
      }
      if (!quietly) {
        deps.log(
          `[slack] reload: cannot remove the confirmation "${paths.apply}"${errnoSuffix(err)}; it was acted on ` +
            'once and is ignored until its content changes',
        )
      }
      return false
    }
  }

  /**
   * Process `config.json.apply` (b.av2 SR-8.5) against this pass's `state`:
   * read it, delete it, then apply on a fingerprint match or log one
   * `reload-stale-confirmation` line. Resolves whether the applied state
   * changed.
   */
  async function processConfirmation(state: PendingState): Promise<boolean> {
    const confirmation = readConfirmation()
    if (confirmation.kind === 'absent') {
      ignoredConfirmation = undefined
      return false
    }
    const identity =
      confirmation.kind === 'bytes'
        ? createHash('sha256').update(confirmation.bytes).digest('hex')
        : UNREADABLE_CONFIRMATION_IDENTITY
    if (identity === ignoredConfirmation) {
      // Acted on once already: only retry the delete, silently.
      if (removeConfirmation(true)) ignoredConfirmation = undefined
      return false
    }
    ignoredConfirmation = removeConfirmation(false) ? undefined : identity

    let stale: StaleConfirmationReason | undefined
    if (confirmation.kind === 'unreadable') {
      stale = { kind: 'unreadable', code: confirmation.code }
    } else {
      const fingerprint = parsePendingFingerprint(confirmation.bytes.toString('utf-8'))
      if (fingerprint === undefined) stale = { kind: 'malformed' }
      else if (fingerprint !== state.fingerprint) stale = { kind: 'mismatch' }
    }
    if (stale !== undefined) {
      deps.log(renderStaleConfirmationLogLine(paths.apply, stale))
      return false
    }
    const changed = await host.applyConfirmed(state)
    // A confirmed invalid candidate has had its one `reload-invalid` line:
    // count it as logged, so this pass's pending refresh does not log the
    // pending-time line for the same candidate (the first pass after a start
    // with the confirmation already present).
    if (!state.plan.valid && state.pending) logged = { kind: 'pending', fingerprint: state.fingerprint }
    return changed
  }

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      let state = derive()
      const appliedNow = await processConfirmation(state)
      // Stopped at shutdown while an apply step ran: the pass ends there.
      if (stopped) return
      // The refresh after an apply: derived again against the swapped applied state.
      if (appliedNow) state = derive()
      const stateId = state.pending ? state.fingerprint : 'nothing'
      if (stateId !== derivedState) {
        // A new pending state, or nothing pending: its first file failure is logged again.
        derivedState = stateId
        fileFailureLatched = false
      }
      const file = readPendingFile()
      if (state.pending) keepPending(state, file)
      else keepNothingPending(file, appliedNow)
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
  /**
   * The applied configuration and its bytes, once the start resolved
   * `applied`; after a confirmed apply's step 1, the confirmed candidate
   * (source `config`).
   */
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
  // Steps 2–6: the test override, else the fan-outs over the lifecycle
  // members, which log each persona's rejected operation.
  const applySlots =
    deps.applySteps ??
    lifecycleApplySlots(lifecycle, (step, persona, err) =>
      deps.log(
        `[slack] reload: apply step ${applyStepNumber(step)} (${step}) failed for persona ` +
          `${renderPersonaRef(persona.name, persona.key)}: ${describeThrownValue(err)}`,
      ),
    )
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

  /**
   * Step 1's record write (b.av2 SR-8.6): the candidate bytes, byte for byte,
   * through the durable writer. True when it succeeded. On a failure before
   * the rename the old record is intact; on a directory-sync failure after it
   * the previous bytes are written back (best effort). Either way one
   * `reload-record-write-failed` line is logged and false returned, and the
   * caller leaves the applied state as it was, so the change stays pending.
   */
  function writeRecord(bytes: Uint8Array, previous: Uint8Array): boolean {
    const record = JSON.stringify(paths.lastApplied)
    const notApplied = 'the confirmed change is not applied and stays pending'
    try {
      write(paths.lastApplied, bytes)
      return true
    } catch (err) {
      if (!(err instanceof DurableWriteUnsyncedError)) {
        deps.log(
          `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write the last-applied record ${record}${errnoSuffix(err)}; ${notApplied}`,
        )
        return false
      }
      let restored: string
      try {
        write(paths.lastApplied, previous)
        restored = 'the previous record was written back'
      } catch (restoreErr) {
        restored =
          restoreErr instanceof DurableWriteUnsyncedError
            ? 'the previous record was written back, though its directory could not be synced either'
            : `writing the previous record back failed too${errnoSuffix(restoreErr)}, so the next start may run the unapplied change`
      }
      deps.log(
        `[slack] ${RELOAD_RECORD_WRITE_FAILED}: wrote the last-applied record ${record} but could not sync its ` +
          `directory${errnoSuffix(err)}; ${restored}; ${notApplied}`,
      )
      return false
    }
  }

  /** Tell the server the new applied configuration; a throw is logged, never raised. */
  function notifyApplied(config: PersonaConfig): void {
    try {
      deps.onApplied?.(config)
    } catch (err) {
      deps.log(`[slack] reload: updating the server's applied configuration failed: ${describeThrownValue(err)}`)
    }
  }

  /**
   * Apply a confirmed candidate (b.av2 SR-8.6): the exact bytes and the plan
   * the tick derived from them, never a second read or diff. An invalid
   * candidate logs one `reload-invalid` line and changes nothing. A valid one
   * runs step 1 (record rewrite, then the applied-state swap and `onApplied`
   * in the same synchronous step), then the bound steps 2–6 in order
   * (`applyStepsFor`: none but the template refresh for a no-op, and that
   * only when the config directories changed), then logs `reload-applied`
   * or `reload-noop`. Resolves whether the applied state changed. Rejects
   * only on a programming error (a plan naming a key its configuration
   * lacks), before anything is written; the tick logs it as a failed pass.
   */
  async function applyConfirmed(state: PendingState): Promise<boolean> {
    const current = appliedState
    const { plan, candidate, bytes } = state
    if (current === undefined) return false
    if (!plan.valid) {
      deps.log(renderConfirmedInvalidLogLine(plan))
      return false
    }
    // A valid plan always comes from bytes that were read and parsed.
    if (candidate.kind !== 'valid' || bytes === undefined) return false
    const inputs = applyStepInputs(plan, current.config, candidate.config)

    if (!writeRecord(bytes, current.bytes)) return false
    appliedState = { config: candidate.config, bytes, source: 'config' }
    notifyApplied(candidate.config)

    await runApplySteps(applySlots, inputs, applyStepsFor(plan), (step, err) =>
      deps.log(`[slack] reload: apply step ${applyStepNumber(step)} (${step}) failed: ${describeThrownValue(err)}`),
    )
    deps.log(plan.noEffectiveChange ? renderNoopLogLine(paths.lastApplied) : renderAppliedLogLine(plan, paths.lastApplied))
    return true
  }

  function startDetection(): boolean {
    if (phase !== 'brought-up' || appliedState === undefined) return false
    if (detection !== undefined || detectionStopped || deps.tickDriver === undefined) return false
    const initial = appliedState
    detection = createPendingDetection(deps, {
      applied: () => appliedState ?? initial,
      applyConfirmed,
    })
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
