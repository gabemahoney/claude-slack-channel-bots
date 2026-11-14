/**
 * reload.ts — The reload controller: the last-applied record and the start
 * rules, and apply step 1's retired keys
 *
 *
 * Saving config.json does not change what runs. config.json.last-applied
 * holds the sole shared authority: the exact reviewed bytes, the applied
 * configuration and its ordered channel/identity evidence. Startup validates
 * and recovers that authority; a missing record permits a valid configuration
 * to establish it durably. A malformed or unreadable record stops startup
 * without consuming prepared input or guessing a replacement. The CLI reads
 * this same validated applied state. No removed delivery store is consulted.
 *
 * Detection compares config.json with the reviewed source bytes and compares
 * referenced credentials with the in-memory digests held by bring-up (never
 * in dry run). It renders the merged candidate without applying it. The
 * confirmation fingerprint also includes the authority revision, so intervening
 * automatic assignments invalidate older reviews without changing config.json.
 *
 * Confirmation applies exact reviewed bytes and the plan derived from them.
 * Step 1 prepares retirement, durably applies one mode/list/identity/destination
 * combination, then stops retired delivery workers and publishes to consumers.
 * A definite failure restores retirement and retains the input and confirmation;
 * an uncertain post-rename outcome retains its evidence and blocks more writes.
 * Successful application consumes the confirmation. Steps 2–6 tear down,
 * update in place, reconnect, refresh templates and bring up, using the existing
 * per-persona lifecycle; once they settle, `onApplySettled` is told the applied
 * configuration, not awaited. Shutdown prevents further operations from starting.
 * No path deletes or reselects accepted queue items.
 *
 * The controller (`createReloadController`) is built with every dependency
 * injected, as `createCronScheduler` is: the paths, the durable
 * writer and delete, the server's retired-key store (`retired-keys.ts`,
 * whose writes go through the same writer), an accessor over the server's
 * stored-choice store (`channel-delivery.ts`,
 *), which only a confirmed apply calls, the dialog approver stop that
 * step 1 calls for each key it records, the server's
 * old-life hold set step 1 begins holds in, the log sink, the
 * lifecycle operations (the start bring-up pass, and the apply's per-step
 * operations), the tick driver, the dry-run flag, the held credentials
 * digests and bring-up states, and the Slack client factory that later work binds
 * (applying a confirmed change). The start resolution records no retired
 * key. It keeps the applied bytes and configuration in memory.
 * `readAppliedPersonaConfig` is the CLI's read-only resolver over the same
 * rules.
 *
 * Importable without side effects: importing it creates no
 * timer or Slack client, reads no file or environment variable and logs
 * nothing. No line it logs carries a token or file content. Its output goes
 * to the server log only, never to Slack.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from 'node:crypto'
import { beginReviewAttempt, createReviewObserver, rejectReviewAttempt, reviewLedger, reviewMatches, reviewOutcomeLine, reviewRecoveryLine, reviewRecoveredBringUpFailedLine, reviewRecoveredLifecycleFailedLine, sharedReviewDependency, RELOAD_REVIEW_OUTCOME, RELOAD_REVIEW_RECOVERY, type DurableReview } from './reload-review.ts'
import { parseReviewRequestBytes, REVIEW_REQUEST_SUFFIX, reviewRequestDiagnostic, REVIEW_REQUEST_INVALID, REVIEW_REQUEST_RECORDED, REVIEW_REQUEST_STORAGE } from './reload-request.ts'
import { readSharedRecoveryRequest } from './shared-recovery.ts'
import { runStartupRecovery, sharedRecoveryLine } from './reload-recovery.ts'
import type { ChannelMembership } from './channel-membership.ts'
import type { ReviewedAssignment, ReviewedChannelEffect } from './shared-channels.ts'
import { createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState, sharedAppliedConfig, serializeSharedChannelState, type SharedChannelAuthority, type SharedChannelState, type SharedMutationResult } from './shared-channels.ts'
import { dirname, resolve } from 'node:path'
import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  DurableWriteUnsyncedError,
} from './atomic-write.ts'
import {
  type ChannelDeliveryStore,
} from './channel-delivery.ts'
import {
  configFileReadFailureMessage,
  configReadFailurePredicate,
  credentialsFilesToProtect,
  DEFAULT_PERSONA_CONFIG_FS,
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
import {
  checkPersonaConfigDir,
  checkPersonaWorkingDirectory,
  type ConfigDirCheckResult,
  type WorkingDirectoryFs,
} from './persona-bringup.ts'
import { isCredentialsBroken, type PersonaBringUpState } from './persona-bringup-controller.ts'
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
import { expandTilde, personaInstanceId, renderPersonaRef } from './persona-identity.ts'
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
  type ApplyBringUpOptions,
  type ApplyStepName,
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
  reloadReviewBinding,
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
  type ValidChangePlan,
} from './reload-plan.ts'
import {
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  RETIRED_KEY_CAUSE_ABSENT_AT_START,
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY,
  RETIRED_KEY_CAUSE_REMOVED,
  RETIRED_KEYS_WRITE_FAILED,
  type OldLifeHoldBegin,
  type OldLifeHoldSet,
  type RetiredKeyStore,
  type RetiredKeysRestoreOutcome,
  type RetiredKeyToRecord,
  retiredReviewRecovery,
  restoreReviewedRetirement,
} from './retired-keys.ts'

export { RELOAD_INVALID, RELOAD_PREVIEW } from './reload-plan.ts'
export { RELOAD_APPLIED, RELOAD_NOOP, RELOAD_STALE_CONFIRMATION } from './reload-apply.ts'

// ---------------------------------------------------------------------------
// Diagnostic classes
// ---------------------------------------------------------------------------

/**
 * The last-applied record could not be written. At a start without a record,
 * the server does not start and nothing is applied; at a confirmed apply,
 * nothing is applied and the change stays pending. At a confirmed apply the
 * same class names a failed write of the retired-key record at step 1, and
 * a failed rewrite's line says how the retired-key record's restore went
 *. An unresolved durable write preserves authority evidence
 * for recovery rather than claiming the old state was restored.
 */
export const RELOAD_RECORD_WRITE_FAILED = 'reload-record-write-failed'

/**
 * How the restore went, in the `reload-record-write-failed` line of a failed
 * write of the retired-key record at step 1: the restore
 * succeeded. True whether the restore wrote the record held before the apply
 * back or wrote a key held only in memory to the file for the first time.
 */
export const RELOAD_RETIRED_KEYS_RESTORED =
  'the retired-key record holds what this server held as retired before this apply'

/**
 * How the restore went, in the same line as {@link RELOAD_RETIRED_KEYS_RESTORED}:
 * the restore failed too.
 */
export const RELOAD_RETIRED_KEYS_RESTORE_FAILED =
  'putting the retired-key record back to what it held before this apply failed too, so a key this apply ' +
  'recorded that reached the file stays retired'

/**
 * What a failed rewrite's `reload-record-write-failed` line adds once step 1
 * wrote the retired-key record and putting it back succeeded,
 * for the record at `path` (quoted as JSON in the line):
 *
 * ; the retired-key record "<path>" is put back to what it held before this apply: the keys this apply recorded are removed again, and keys recorded before it stay
 */
export function reloadRetiredKeysPutBackClause(path: string): string {
  return (
    `; the retired-key record ${JSON.stringify(path)} is put back to what it held before this apply: the keys this apply ` +
    'recorded are removed again, and keys recorded before it stay'
  )
}

/**
 * What the same line adds when putting the record at `path` back failed
 *
 *
 * ; putting the retired-key record "<path>" back to what it held before this apply failed, so the keys this apply recorded stay retired
 */
export function reloadRetiredKeysPutBackFailedClause(path: string): string {
  return (
    `; putting the retired-key record ${JSON.stringify(path)} back to what it held before this apply failed, so the keys this ` +
    'apply recorded stay retired'
  )
}

/** Startup refusal when establishing the shared authority fails. Echoes only safe errno, never error text. */
export function reloadSharedAuthorityStartFailedLine(path: string, error: unknown): string {
  const outcome = error instanceof DurableWriteUnsyncedError
    ? '; the authority was renamed but its directory could not be synced, so the durable outcome is unresolved' : ''
  return (
    `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot durably establish the shared channel authority ${JSON.stringify(path)}${errnoSuffix(error)}${outcome}; ` +
    'preserve the prepared configuration and authority evidence; the server does not start'
  )
}

/** Startup uses the recovered shared authority at this revision. */
export function reloadSharedAuthorityStartLine(path: string, revision: number): string {
  return `[slack] Starting from the shared channel authority "${path}" at revision ${revision}`
}

/**
 * A failed reviewed application keeps its input and authority evidence.
 * `failure` is the authority's echo-safe errno suffix; `restored` is a clause
 * from the retired-key restore builders above. Neither carries raw errors.
 */
export function reloadSharedAuthorityApplyFailedLine(
  path: string,
  outcome: Exclude<SharedMutationResult['kind'], 'applied'>,
  failure: string,
  restored = '',
): string {
  return (
    `[slack] ${RELOAD_RECORD_WRITE_FAILED}: cannot write the shared channel authority ${JSON.stringify(path)}${failure}; ` +
    `application ${outcome}; preserve the prepared input and authority evidence; the change remains pending${restored}`
  )
}

/**
 * The line logged when `onApplySettled`, told that a confirmed apply's steps
 * 2–6 have settled, throws or its returned promise rejects; the apply goes
 * on. `description` is the thrown value as `describeThrownValue` renders it.
 * Pure.
 *
 * [slack] reload: the server's post-apply work failed: <thrown value>
 */
export function reloadPostApplyFailedLine(description: string): string {
  return `[slack] reload: the server's post-apply work failed: ${description}`
}

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
  REVIEW_REQUEST_INVALID,
  REVIEW_REQUEST_RECORDED,
  REVIEW_REQUEST_STORAGE,
  RELOAD_REVIEW_RECOVERY,
  RELOAD_REVIEW_OUTCOME,
] as const

/** A reload diagnostic class label (closed set). */
export type ReloadDiagnosticClass = (typeof RELOAD_DIAGNOSTIC_CLASSES)[number]

// ---------------------------------------------------------------------------
// Reload files
// ---------------------------------------------------------------------------

/** Appended to the configuration file's name: the pending-change preview. */
export const PENDING_FILE_SUFFIX = '.pending'

/** Appended to the configuration file's name: the confirmation name. */
export const APPLY_FILE_SUFFIX = '.apply'

/** Appended to the configuration file's name: the last-applied record. */
export const LAST_APPLIED_FILE_SUFFIX = '.last-applied'

/** The configuration file and the three reload files beside it. */
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
 * each removed persona and the old half of each destructive modify),
 * `updateInPlace` (step 3, each persona modified in place),
 * `reconnectCredentials` (step 4, each persona whose credentials changed and
 * that is not broken by its credentials), `refreshTemplate` (step 5, once,
 * when the config directories changed) and `bringUp` (step 6, each added
 * persona and the new half of each destructive modify, and as a recovery
 * each persona broken by its credentials whose credentials changed);
 * production binds all five through `persona-lifecycle.ts`.
 */
export interface ReloadLifecycleOps {
  /**
   * The start bring-up pass over the whole applied set: every persona's
   * bring-up and, for each persona that is up, its launch. Resolves once
   * every persona has an outcome (production: `startupSessionManager` over
   * the bring-up controller, launching over `configInEffect` of the server's
   * start-time configuration and `applied`, so its server-wide values, the
   * crontable the start runs on included, are the ones every later launch
   * uses).
   */
  startBringUp(applied: PersonaConfig): Promise<unknown>
  /**
   * Bring up one persona a confirmed change added, `applied` being the
   * configuration step 1 made current. Resolves once it has an outcome and,
   * when up, its launch settled. With `options.recovery` the persona is not
   * new: it is broken by its credentials and its credentials file changed
   * (step 6), and it is brought up afresh the same way;
   * one that is not broken by its credentials any more when the operation
   * runs gets its changed credentials applied as `reconnectCredentials`
   * would, so step 4 and step 6 never both skip a confirmed change.
   */
  bringUp(persona: Persona, applied: PersonaConfig, options?: ApplyBringUpOptions): Promise<unknown>
  /**
   * Tear down one persona a confirmed change removed, or the old half of a
   * destructive modify (declared as before the change; its key stays
   * applied, and step 6 brings its new declaration up fresh).
   */
  teardown(persona: Persona): Promise<unknown>
  /**
   * Apply one persona's changed credentials file (step 4,
   * credentials row), `applied` being the configuration step 1 made current:
   * reconnect it (up) or hand its retries the new content (retrying).
   * Resolves once its first attempt settled; resolves with
   * `CredentialsBrokenAtReconnect` when it is broken by its credentials by
   * the time it runs, and step 6 then brings it up instead.
   */
  reconnectCredentials(persona: Persona, applied: PersonaConfig): Promise<unknown>
  /**
   * Apply the in-place settings of one persona a confirmed change modified in
   * place, without tearing it down (its instance is kept): `change.persona`
   * is its entry in the configuration step 1 made current.
   */
  updateInPlace(change: InPlaceApplyInput): Promise<unknown>
  /**
   * Refresh the agent-director template's memory-read rules for the persona
   * set of `applied`, the configuration step 1 made current (
   * step 5), keeping the template's start-time server-wide arguments. Asked
   * only when the change plan's `configDirsChanged`. Resolves once the
   * refresh settled, whether it succeeded or failed: a failure is logged,
   * never fatal, and not retried.
   */
  refreshTemplate(applied: PersonaConfig): Promise<unknown>
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

export interface ReloadApplyFailure {
  fingerprint: string
  record: 'authority' | 'retired-keys'
  /** Echo-safe filesystem suffix, never a raw error. */
  failure: string
  personas: string[]
}

/** Dependencies of `createReloadController`. */
export interface ReloadControllerDeps {
  onApplyFailed?(failure: ReloadApplyFailure): void
  /** Per-controller review epoch; restart always requires a fresh review of
   * current membership. Injected for deterministic source-path fixtures. */
  reviewSession?: () => string
  now?: () => number
  /** Current authenticated evidence, supplied by the existing membership owner.
   * Reads only: review never starts a Slack lookup. */
  membership?: () => Pick<ChannelMembership, 'read' | 'generation' | 'isCurrent'> | undefined
  /** facts gathered outside the pure change planner. */
  queueOpenCount?(key: string): number
  /** Confirmation-time seam; no log or notice wording. */
  onQueueRetained?(key: string, count: number): void
  /** The configuration file and its reload files (`reloadFilePaths`). */
  paths: ReloadFilePaths
  /** The lifecycle operations. */
  lifecycle: ReloadLifecycleOps
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The durable writer; `durableWriteFileSync` by default. */
  write?: ReloadFileWriter
  /** The durable delete (of `config.json.pending` and `config.json.apply`); `durableUnlinkSync` by default. */
  remove?: ReloadFileRemover
  /**
   * The server's retired-key store (`src/retired-keys.ts`):
   * production passes the one store `main()` loaded at start. A confirmed
   * apply's step 1 records through it, and restores it after a failed
   * rewrite of the last-applied record. Its
   * writes must reach the disk through the same writer as `write`: production
   * builds it with the default `durableWriteFileSync`, the default of `write`
   * too, and a test builds it over the writer (and delete) it gives here.
   */
  retiredKeys: RetiredKeyStore
  /** The read/write adapter over this controller's recovered authority. It owns only the in-memory retiring-session guard; configuration and identity application use one atomic authority write. */
  channelDelivery: () => ChannelDeliveryStore
  /** Stop the retired key's delivery and reminder workers after durable
   * authority application, before any teardown. Called synchronously without
   * awaiting the returned work; throws/rejections are logged. Definite
   * pre-activation failure leaves the existing workers running. */
  stopDelivery: (key: string) => unknown
  /**
   * The server's old-life hold set (`createOldLifeHoldSet`,
   * `src/retired-keys.ts`): production passes the one set
   * `main()` builds, the set the session manager has installed. Once a
   * confirmed apply's last-applied rewrite has succeeded, step 1 begins one
   * hold in it for each removed persona's key (a renamed persona's old key
   * included) and each destructive modify's key, on `cscb_<key>`, at the
   * old declaration's working directory (`oldLifeHoldsToBegin`); an apply
   * that fails at its retired-key write or its rewrite begins none. A begin
   * on an id already held keeps its held directory.
   */
  oldLifeHolds: Pick<OldLifeHoldSet, 'begin'>
  /** The detection tick's driver; without one, `startDetection` arms nothing. */
  tickDriver?: ReloadTickDriver
  /**
   * Dry run: the detection tick reads no credentials
   * file, credentials never count as changed and the fingerprint covers the
   * configuration file alone. Default false.
   */
  dryRun?: boolean
  /**
   * The held credentials digests the detection tick compares against; production binds the bring-up controller's `credentialsDigest`.
   * Without it nothing is held, so credentials never count as changed.
   */
  heldCredentialsDigest?: HeldCredentialsDigestQuery
  /**
   * An applied persona's current bring-up state (production: the bring-up
   * controller's `state`), for the preview of a credentials change and again
   * when apply steps 4 and 6 run: a persona broken
   * by its credentials is brought up at apply rather than reconnected. Without it no persona counts as broken by its credentials in the
   * preview, and the steps follow the plan's split.
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
  /**
   * The detection tick's claude_config_dir check of an added persona and of
   * a persona whose effective claude_config_dir changed:
   * production passes the session manager's pre-launch check
   * (`checkLaunchConfigDir`), the one the bring-up controller checks with, so
   * the preview and the bring-up resolve the directory the same way. Default
   * `checkPersonaConfigDir` against `home` and the real file system.
   */
  checkConfigDir?: (persona: Persona) => ConfigDirCheckResult
  /** The Slack client factory; bound by the work that applies a confirmed change. */
  slackClientFactory?: PersonaSlackClientFactory
  /**
   * Told the configuration a confirmed apply's step 1 made the applied one,
   * right after the record was rewritten and in the same synchronous step as
   * the controller's own swap. Production
   * reassigns the server's `personaConfig` to `configInEffect`: the new
   * persona set and its `channel_mode` switch, with every other
   * server-wide value kept from start time; the bring-up controller's applied
   * set, the reply reminder and every consumer of the channel mode read it
   * from there. A throw is logged; the apply goes on. Work that must follow
   * the lifecycle steps belongs in `onApplySettled`.
   */
  onApplied?: (config: PersonaConfig) => void
  /**
   * Told the configuration a confirmed apply made the applied one once its
   * steps 2–6 have settled (each fulfilled, rejected, unbound or not run),
   * right before `reload-applied` or `reload-noop` is logged: on every path
   * that applied, a no-op or recorded-only change included, never after a
   * refused candidate or a step-1 write that applied nothing. Its returned
   * value is not awaited, so nothing it starts holds the apply or the next
   * tick; a throw or rejection is logged (`reloadPostApplyFailedLine`), and
   * the apply goes on. Production reclaims the applied persona keys' claimed
   * preparation work here (`DeliveryPreparation.reclaim`): a destructive modify's
   * teardown ended the preparation life that held the key's open work, and
   * only the key's next life, started after that teardown, can fix it.
   */
  onApplySettled?: (config: PersonaConfig) => unknown
  /**
   * Test override: the bodies of apply steps 2–6 (`reload-apply.ts`), used
   * instead of the default ones; an unbound step then does nothing. Without
   * it the controller runs `lifecycleApplySlots` over `lifecycle` (step 2
   * tears down each removed persona and the old half of each destructive
   * modify, step 3 updates each persona modified in place, step 4 reconnects
   * each persona whose credentials changed, step 5 refreshes the template,
   * step 6 brings up each added one, the new half of each destructive modify
   * and each credentials-broken one whose credentials changed).
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
// The configuration in effect
// ---------------------------------------------------------------------------

/**
 * The configuration the server runs once a confirmed apply's step 1 made
 * `applied` current (the server-wide row):
 * `applied`'s persona set and its `channel_mode` switch over every
 * other server-wide setting of `startTime`, the configuration the server
 * started with. A changed server-wide setting (the listener's `bind` and
 * `port`, the restart delay, `resume_enabled`, the cron paths, …) is
 * recorded by step 1 and takes effect only at the next start, which runs the
 * record. The switch is the one exception: it is applied in place at once,
 * so the channel mode every consumer reads (`channelModeOf`) is the
 * confirmed one from the next event, tool call, prompt and notice, and it
 * always matches the mode `applied`'s personas were resolved in. The
 * top-level `claude_config_dir` and `stop_hook_bootstrap` are not held back
 * by this either: they act only as inherited defaults, already resolved into
 * each of `applied`'s personas. The config directory applies at the next
 * launch; the legacy reminder opt-out applies immediately. The one place the server derives what it runs from an
 * applied configuration: after an apply (the `onApplied` of `main()` in
 * `server.ts`), and for the start bring-up pass (its `startBringUp`), whose
 * `startTime` is the server's start-time configuration. Pure: neither input
 * is mutated.
 */
export function configInEffect(startTime: PersonaConfig, applied: PersonaConfig): PersonaConfig {
  return { ...startTime, channel_mode: applied.channel_mode, personas: applied.personas }
}

// ---------------------------------------------------------------------------
// Apply step 1's retired keys
// ---------------------------------------------------------------------------

/**
 * The keys a confirmed apply's step 1 records as retired, one batch for one
 * write: the key of each removed persona as `removed` (a
 * key-changing rename is a removal of its old key and an addition of its new
 * one, so its old key is among them), the key of each destructive modify as
 * `destructive-modify` (a change of `name` that keeps the key,
 * `credentials_file` or `working_directory`), and the key of each persona
 * the plan adds (a key-changing rename's new key included) that `store`
 * holds only in memory after a failed start-sweep write, with the cause it
 * holds, so the batch writes it before the bring-up is applied. Empty when
 * there is none. Reads only `store`'s queries; writes nothing.
 */
export function retiredKeysToRecord(
  plan: ValidChangePlan,
  store: Pick<RetiredKeyStore, 'isHeldInMemory' | 'entry'>,
): RetiredKeyToRecord[] {
  return [
    ...plan.removed.map(({ key }): RetiredKeyToRecord => ({ key, cause: RETIRED_KEY_CAUSE_REMOVED })),
    ...plan.destructive.map(({ key }): RetiredKeyToRecord => ({ key, cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY })),
    ...plan.added
      .filter(({ key }) => store.isHeldInMemory(key))
      .map(({ key }): RetiredKeyToRecord => ({ key, cause: store.entry(key)?.cause ?? RETIRED_KEY_CAUSE_ABSENT_AT_START })),
  ]
}

/**
 * The old-life holds a confirmed apply's step 1 begins once its last-applied
 * rewrite has succeeded (first start): one per key the step
 * records whose old declaration `applied` (the configuration in effect
 * before the apply) holds, in the plan's order: each removed persona's key
 * (a key-changing rename's old key included) and each destructive modify's
 * key, the instance id `cscb_<key>`, the old key itself, the old
 * declaration's working directory (a session manager read of the row's
 * `cwd` replaces it later), and the apply-step-1 cause. A key recorded again
 * (already recorded with no mark, so nothing was written) and a destructive
 * modify whose working directory is unchanged still get theirs: only a
 * launch gate tells a same-key new half apart. A key the plan adds
 * that the store held only in memory gets none here: it has no old
 * declaration, and the start sweep held its live row already. Pure.
 */
export function oldLifeHoldsToBegin(plan: ValidChangePlan, applied: PersonaConfig): OldLifeHoldBegin[] {
  const begins: OldLifeHoldBegin[] = []
  for (const { key } of [...plan.removed, ...plan.destructive]) {
    const old = applied.personas.find((persona) => persona.key === key)
    if (old === undefined) continue
    begins.push({
      instanceId: personaInstanceId(key),
      oldKey: key,
      directory: old.working_directory,
      cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
    })
  }
  return begins
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
  sharedState?: SharedChannelState
}

/** The outcome of `resolveStart`. */
export type ReloadStartOutcome =
  | ({ kind: 'applied' } & AppliedConfiguration)
  | {
      kind: 'refused'
      /** Which file stopped the start. */
      source: AppliedConfigSource
      /** The class, when the refusal has one. */
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
 * `cause` followed by the recovery hint: retain both authority and prepared
 * input so an operator can restore trustworthy evidence without guessing.
 */
function recordFailureMessage(paths: ReloadFilePaths, cause: string): string {
  return (
    `${cause} Preserve the shared channel authority "${paths.lastApplied}" and prepared configuration ` +
    `"${paths.config}"; restore trustworthy authority evidence before starting again.`
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
      const sharedState = parseSharedChannelState(recordBytes, paths.lastApplied, { home })
      if (sharedState !== undefined) {
        if (sharedState.recovery?.phase === 'review') return { ok: false, source: 'record', message: 'The shared recovery stage is awaiting explicit review and confirmation; no staged configuration is applied.' }
        const config = sharedAppliedConfig(sharedState, paths.lastApplied, { home })
        const bytes = Buffer.from(sharedState.sourceBytesBase64, 'base64')
        return { ok: true, applied: { config, bytes, source: 'record', sharedState } }
      }
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
// Detection: the pending state
// ---------------------------------------------------------------------------

/** One read of the configuration file by the detection tick. */
type ConfigFileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; missing: boolean; code: string | undefined }

/** The pending state one detection pass derived. Holds no credentials content. */
interface PendingState {
  binding: string
  review?: DurableReview
  revalidate(): boolean
  assignments: ReviewedAssignment[]
  intentGeneration: number
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
  /** The fingerprint of the bytes this pass read. */
  fingerprint: string
  authorityRevision?: number
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
  recoverPending(): Promise<void>
  sharedChannels?(): SharedChannelAuthority | undefined
  /** The applied configuration now; read at the start of every derivation, so a swap is seen at once. */
  applied(): AppliedConfiguration
  /**
   * Apply the pass's state after a matching confirmation.
   * Resolves true when the applied state changed (step 1 succeeded), false
   * when nothing was applied. Rejects only on a programming error, before
   * anything is written.
   */
  applyConfirmed(state: PendingState): Promise<boolean>
}

/** The confirmation as the tick found it. */
type ConfirmationRead =
  | { kind: 'absent' }
  | { kind: 'bytes'; bytes: Buffer; fileIdentity: string }
  | { kind: 'unreadable'; code: string | undefined }

/**
 * The in-memory identity of a confirmation that could not be read: every
 * unreadable confirmation has this one, so it is ignored until it can be read.
 */
const UNREADABLE_CONFIRMATION_IDENTITY = 'unreadable'

/**
 * Build the detection tick over the applied
 * configuration, which it reads from `host` at the start of every derivation
 * (so a confirmed apply's swap is seen at once, with the logged state kept).
 * One pass reads the configuration file once and, unless in
 * dry run, each credentials file it references once (stat-first, so a FIFO
 * or a device reads as unreadable and never blocks), derives the pending
 * state through the change plan (`buildChangePlan` in `reload-plan.ts`),
 * then keeps `config.json.pending` in step: written durably, with the
 * preview rendered from the plan, when a change is pending and the
 * file is missing or differs from what the pass would write; deleted durably
 * when nothing is pending. The credentials bytes are dropped at the end of
 * the pass; only their digests are compared, with the held ones.
 *
 * The plan's facts come from what the pass already read, plus the least
 * extra I/O: real paths only for paths written differently in the two
 * configurations, for each added persona the credentials content check
 * over the bytes already read (none in dry run), the working-directory
 * check and the claude_config_dir check, and that claude_config_dir check
 * for each persona whose effective claude_config_dir changed. An unchanged
 * persona is not probed. The bring-up state is asked only for a persona
 * whose credentials changed.
 *
 * Confirmation: each pass first derives the state, then
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
  const reviewSession = (deps.reviewSession ?? randomUUID)()
  const observeReview = createReviewObserver()
  const configDir = dirname(paths.config)
  const checkConfigDir = deps.checkConfigDir ?? ((persona: Persona) => checkPersonaConfigDir(persona, { home: deps.home }))
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
  /**
   * Suppress a failed activation's retained confirmation in this controller
   * until a fresh gesture. Durable attempted/consumed outcomes and the next
   * server's review epoch also reject replay after restart.
   */
  let failedConfirmation: string | undefined
  let reviewAttempted = false

  let factFailureLatched = false
  /** A fact the preview needs could not be gathered in this pass. */
  let factFailed = false
  let requestEpisode: string | undefined
  let channelEffects: ReviewedChannelEffect[] = []
  let recoveryPending = false

  function processRequest(): boolean {
    const authority = host.sharedChannels?.()
    if (!authority) return false
    if (recoveryPending) return true
    const read = readConfigFile(paths.config + REVIEW_REQUEST_SUFFIX, deps.configFs)
    if (!read.ok && read.missing) { requestEpisode = undefined; return false }
    const request = read.ok ? parseReviewRequestBytes(read.bytes) : undefined
    const input = readConfigFile(paths.config, deps.configFs)
    const recovery = read.ok ? readSharedRecoveryRequest(read.bytes) : undefined
    if (recovery) {
      if (JSON.stringify(authority.snapshot().recovery?.request) === JSON.stringify(recovery)) return false
      const evidence = readConfigFile(paths.lastApplied, deps.configFs)
      const result = evidence.ok && input.ok ? authority.stageRestoration(recovery, evidence.bytes, input.bytes) : { kind: 'failed' }
      if (result.kind === 'unresolved') recoveryPending = true
      const episode = JSON.stringify([recovery.request_id, result.kind])
      if (episode !== requestEpisode) deps.log(sharedRecoveryLine(recoveryPending ? 'restoration staged' : 'request refused',
        recoveryPending ? 'The owned anchor and damaged evidence are retained for reviewed recovery. Restart to verify, review and confirm; accepted queues and unchanged projections remain available.' : 'Preserve input and evidence; only the current owner can stage trustworthy restoration.'))
      requestEpisode = episode
      return recoveryPending
    }
    const result = request && (input.ok || request.action === 'cancel')
      ? authority.requestReview(request, input.ok ? input.bytes : applied.bytes)
      : { kind: 'invalid' as const, generation: authority.operatorIntent().generation }
    const episode = JSON.stringify([read.ok ? createHash('sha256').update(read.bytes).digest('hex') : 'unreadable', result.kind, result.generation])
    if (episode !== requestEpisode && result.kind !== 'duplicate') deps.log(reviewRequestDiagnostic(result.kind, result.generation))
    requestEpisode = episode
    return false
  }

  /**
   * A persona named by key, as the logs name it: its
   * JSON-quoted name from the candidate (else the applied set), key beside it.
   */
  function personaRefOf(key: string, candidate: ChangePlanCandidate): string {
    const candidatePersonas = candidate.kind === 'valid' ? candidate.config.personas : []
    const persona = [...candidatePersonas, ...applied.config.personas].find((p) => p.key === key)
    return persona !== undefined ? renderPersonaRef(persona.name, persona.key) : `(key=${key})`
  }

  /** Resolve the reviewed candidate; only exact recorded input keeps record-mode validation. */
  function candidateOf(read: ConfigFileRead, assignments: readonly ReviewedAssignment[]): ChangePlanCandidate {
    if (!read.ok) return { kind: 'unreadable', path: paths.config, missing: read.missing, code: read.code }
    try {
      const authority = host.sharedChannels?.()
      if (authority) {
        const reviewed = authority.planReviewed(read.bytes, assignments)
        channelEffects = reviewed.channels
        return { kind: 'valid', config: reviewed.config }
      }
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
   * (steps 1 and 2, then its claude_config_dir): the
   * credentials content from the bytes this pass already read (no second
   * read; none in dry run, where no credentials file is read), the
   * working-directory check and the claude_config_dir check
   * (`resolveRealPathStrict`: a directory not created yet under a resolvable
   * ancestor passes). Every check runs, so one failure never hides another.
   * No other persona is probed: a valid candidate has no real-path
   * collision, so the directory check runs without the others.
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
        const configDirResult = checkConfigDir(persona)
        if (!configDirResult.ok) causes.push({ step: 'claude-config-dir', cause: configDirResult.problem })
        result.set(persona.key, causes)
      } catch (err) {
        noteFactFailure(`whether the added persona ${renderPersonaRef(persona.name, persona.key)} can come up`, err)
        result.set(persona.key, FACT_UNKNOWN)
      }
    }
    return result
  }

  /**
   * Why a persona whose effective claude_config_dir changed cannot come up
   * with the new one: the same check as an added persona's
   * (`checkConfigDir`, so the preview, the bring-up and the launch resolve
   * the directory the same way), its `problem` when the directory cannot be
   * resolved, undefined when it resolves. A check that throws is a fact that
   * could not be gathered (`FACT_UNKNOWN`). The plan asks only for such a
   * persona, so no unchanged persona is probed.
   */
  function changedConfigDirProblem(persona: Persona): string | FactUnknown | undefined {
    try {
      const result = checkConfigDir(persona)
      return result.ok ? undefined : result.problem
    } catch (err) {
      noteFactFailure(`the claude_config_dir of persona ${renderPersonaRef(persona.name, persona.key)}`, err)
      return FACT_UNKNOWN
    }
  }

  /**
   * One pass's pending state. Every credentials file is read and digested at
   * most once, and only outside dry run. The change plan decides whether any
   * credentials changed (`buildChangePlan`), from the digests of this pass's
   * reads and the held ones; the bytes are dropped when the pass returns.
   */
  function derive(persist = true): PendingState {
    applied = host.applied()
    const read = readConfigFile(paths.config, deps.configFs)
    const configChanged = !read.ok || !read.bytes.equals(Buffer.from(applied.bytes))
    const authority = host.sharedChannels?.()
    const intent = authority?.operatorIntent()
    let assignments: ReviewedAssignment[] = []
    let declarationError = false
    try { if (read.ok) assignments = authority?.declaredAssignments(read.bytes) ?? [] } catch { declarationError = true }
    channelEffects = []
    const candidate: ChangePlanCandidate = declarationError ? { kind: 'invalid', error: 'The declared assignment targets an obsolete persona life or declaration; revise the operator request.' } : candidateOf(read, assignments)

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
      sharedReview: { generation: intent?.generation ?? 0, channels: channelEffects },
      membership: (key, channel, mode) => deps.membership?.()?.read(key, channel, mode) ?? { kind: 'unresolved', reason: 'current-membership-missing' },
      realPath: realPathOf,
      queueOpenCount: key => deps.queueOpenCount?.(key) ?? 0,
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
      configDirProblem: changedConfigDirProblem,
    }
    const plan = buildChangePlan(applied.config, candidate, facts)
    if (!factFailed) factFailureLatched = false

    const contentFingerprint = reloadFingerprint(fingerprintContentOf(read), entries)
    const credentialsChanged = plan.valid && plan.credentials.length > 0
    const pending = configChanged || credentialsChanged || intent?.requested === true
    const membership = deps.membership?.()
    const memberFacts = applied.config.personas.map(persona => {
      const generation = membership?.generation(persona.key)
      return !generation || !membership?.isCurrent(generation) ? [persona.key, 'unverified'] : [
        persona.key, generation.incarnation, generation.generation, generation.identityKey, generation.complete,
        generation.observations, [...generation.positives].sort(), [...generation.absent].sort(), [...generation.holds].sort(),
      ]
    })
    const declarations = [...applied.config.personas, ...(candidate.kind === 'valid' ? candidate.config.personas : [])]
      .map(persona => [persona.key, persona.name, realPathOf(persona.credentials_file), realPathOf(persona.working_directory), persona.permission_prompts])
    const binding = reloadReviewBinding(contentFingerprint, authority ? sharedReviewDependency(authority.snapshot()) : '', reviewSession,
      intent?.generation ?? 0, [memberFacts, declarations])
    const observed = authority ? observeReview(authority, binding, pending, intent?.generation ?? 0,
      reloadFingerprint(fingerprintContentOf(read), []), persist) : undefined
    const review = observed?.review
    return {
      binding,
      review,
      revalidate: () => {
        if (stopped) return false
        const current = derive(false)
        return current.binding === binding && !!review && current.review?.fingerprint === review.fingerprint && !!authority?.readable
      },
      assignments,
      intentGeneration: intent?.generation ?? 0,
      bytes: read.ok ? read.bytes : undefined,
      candidate,
      configChanged,
      plan,
      fingerprint: review?.fingerprint ?? '',
      authorityRevision: host.sharedChannels?.()?.revision,
      pending,
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
   * Write the pending file (the preview behind the fingerprint) when it
   * is missing or differs from what this pass would write; log the preview
   * when the pending state changed: every `reload-preview` line of a valid
   * candidate, or the one `reload-invalid` line of an invalid one. The log
   * points at the pending file only when it holds this pass's preview.
   */
  function keepPending(state: PendingState, file: PendingFileRead): void {
    if (!state.review) {
      noteFileFailure(reviewRequestDiagnostic('unresolved', state.intentGeneration))
      return
    }
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
      let fileIdentity = ''
      const fstat = deps.configFs?.fstatFile ?? DEFAULT_PERSONA_CONFIG_FS.fstatFile
      const bytes = readPersonaConfigBytes(paths.apply, {
        ...deps.configFs,
        fstatFile(fd) {
          const stat = fstat(fd)
          fileIdentity = JSON.stringify([stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs])
          return stat
        },
      })
      return { kind: 'bytes', bytes, fileIdentity }
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
   * Process `config.json.apply` against this pass's `state`:
   * keep its evidence through activation, then consume it on success or an
   * invalid/stale review. A failed activation retains the file and waits for
   * a fresh file or content before another attempt. Resolves whether the
   * applied state changed.
   */
  async function processConfirmation(state: PendingState): Promise<boolean> {
    reviewAttempted = false
    const confirmation = readConfirmation()
    if (stopped) return false
    if (confirmation.kind === 'absent') {
      ignoredConfirmation = undefined
      failedConfirmation = undefined
      return false
    }
    const identity =
      confirmation.kind === 'bytes'
        ? createHash('sha256').update(confirmation.bytes).digest('hex')
        : UNREADABLE_CONFIRMATION_IDENTITY
    const attemptIdentity = confirmation.kind === 'bytes' ? identity + confirmation.fileIdentity : identity
    if (attemptIdentity === failedConfirmation) return false
    failedConfirmation = undefined
    if (identity === ignoredConfirmation) {
      // Acted on once already: only retry the delete, silently.
      if (removeConfirmation(true)) ignoredConfirmation = undefined
      return false
    }
    let stale: StaleConfirmationReason | undefined
    if (confirmation.kind === 'unreadable') {
      stale = { kind: 'unreadable', code: confirmation.code }
    } else {
      const fingerprint = parsePendingFingerprint(confirmation.bytes.toString('utf-8'))
      const authority = host.sharedChannels?.()
      const outcome = fingerprint && authority ? reviewLedger(authority.snapshot())?.outcomes[fingerprint] : undefined
      if (outcome) {
        ignoredConfirmation = removeConfirmation(false) ? undefined : identity
        deps.log(reviewOutcomeLine(outcome.status))
        return false
      }
      if (fingerprint === undefined) stale = { kind: 'malformed' }
      else if (!state.review || fingerprint !== state.fingerprint) stale = { kind: 'mismatch' }
    }
    if (stale !== undefined) {
      ignoredConfirmation = removeConfirmation(false) ? undefined : identity
      deps.log(renderStaleConfirmationLogLine(paths.apply, stale))
      return false
    }
    if (stopped) return false
    reviewAttempted = true
    const changed = await host.applyConfirmed(state)
    if (stopped) return changed
    if (changed || !state.plan.valid) ignoredConfirmation = removeConfirmation(false) ? undefined : identity
    else failedConfirmation = attemptIdentity
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
      await host.recoverPending()
      if (stopped) return
      if (processRequest()) return
      let state = derive()
      if (stopped) return
      const appliedNow = await processConfirmation(state)
      // Stopped at shutdown while an apply step ran: the pass ends there.
      if (stopped) return
      // The refresh after an apply: derived again against the swapped applied state.
      if (appliedNow || reviewAttempted) state = derive()
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

/**
 * Apply step 2, the teardowns: a confirmed apply runs it on its own, then
 * clears the retiring keys before steps 3–6.
 */
const TEARDOWNS_STEP: ApplyStepName = 'teardowns'

/** The reload controller handle. */
export interface ReloadController {
  /**
   * Resolve the start: choose the record or the configuration
   * file, write the record when there was none, and keep the applied bytes
   * and configuration. A refusal is logged here, as one line, and nothing is
   * applied. Reads no credentials file. Call once, before anything consumes
   * the configuration; a second call throws.
   */
  resolveStart(): ReloadStartOutcome
  /** Only this process's activation qualifies for a repair completion report. */
  repairActivated(): boolean
  sharedChannels(): SharedChannelAuthority | undefined
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
   * Start the detection tick: hand it to the injected tick
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
   * The credentials files the file guard must refuse: the
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
    lifecycleApplySlots(
      lifecycle,
      (step, persona, err) =>
        deps.log(
          `[slack] reload: apply step ${applyStepNumber(step)} (${step}) failed for persona ` +
            `${renderPersonaRef(persona.name, persona.key)}: ${describeThrownValue(err)}`,
        ),
      credentialsBrokenNow,
      () => !detectionStopped,
    )
  let phase: StartPhase = 'unresolved'
  let repairActivated = false
  let appliedState: AppliedConfiguration | undefined
  let sharedChannels: SharedChannelAuthority | undefined

  /**
   * Whether a persona is broken by its credentials now, for apply steps 4 and
   * 6: from the bring-up state when it can be
   * queried, else undefined (the plan's split decides).
   */
  function credentialsBrokenNow(key: string): boolean | undefined {
    if (deps.bringUpState === undefined) return undefined
    try {
      return isCredentialsBroken(deps.bringUpState(key))
    } catch {
      return undefined
    }
  }
  let detection: PendingDetection | undefined
  let detectionStopped = false
  let applyingReviewed = false
  let reviewedPublicationRevision: number | undefined
  let recoveredLifecycle: Promise<void> | undefined
  const withheldAtStart = new Set<string>()
  // The rejection can reach disk before directory fsync succeeds. Its exact
  // recovery removes the journal, but these local release duties still run.
  const retirementRecoveryKeys = new Set<string>()
  let recoveryReported = false

  function recoverRetirement(starting = false): void {
    if (!sharedChannels || detectionStopped) return
    if (!sharedChannels.readable && sharedChannels.recoverDurability().kind !== 'applied') return
    const interrupted = reviewLedger(sharedChannels.snapshot())?.retirement
    if (interrupted) {
      for (const key of interrupted.recovery.keys) retirementRecoveryKeys.add(key)
      const restored = restoreReviewedRetirement(deps.retiredKeys, interrupted.recovery)
      if (restored === RETIRED_KEYS_WRITE_FAILED || rejectReviewAttempt(sharedChannels, interrupted.fingerprint).kind !== 'applied') {
        if (starting) for (const key of retirementRecoveryKeys) withheldAtStart.add(key)
        if (!recoveryReported) deps.log(reviewRecoveryLine('unresolved'))
        recoveryReported = true
        return
      }
    }
    if (retirementRecoveryKeys.size === 0) return
    const keys = [...retirementRecoveryKeys]
    retirementRecoveryKeys.clear()
    recoveryReported = false
    deps.log(reviewRecoveryLine('recovered'))
    if (starting) return
    setRetiring(deps.channelDelivery(), keys, false)
    for (const key of keys) {
      if (!withheldAtStart.delete(key) || detectionStopped) continue
      const config = sharedChannels.config()
      const persona = config.personas.find(p => p.key === key)
      if (persona) void Promise.resolve().then(() => {
        if (!detectionStopped) return lifecycle.bringUp(persona, config)
      }).catch(err => {
        deps.log(reviewRecoveredBringUpFailedLine(err))
      })
    }
  }

  function refuse(source: AppliedConfigSource, cls: ReloadDiagnosticClass | undefined, line: string): ReloadStartOutcome {
    phase = 'refused'
    deps.log(line)
    return { kind: 'refused', source, class: cls, line }
  }

  function resolveStart(): ReloadStartOutcome {
    if (phase !== 'unresolved') throw new Error('reload: resolveStart may be called only once')
    let selection = selectConfiguration(paths, deps.home, deps.configFs)
    if (!selection.ok && selection.source === 'record') {
      const recovery = runStartupRecovery({ paths, home: deps.home, configFs: deps.configFs, credentialsFs: deps.credentialsFs,
        dryRun: deps.dryRun, now: deps.now, boundary: deps.reviewSession, write, remove: deps.remove ?? durableUnlinkSync,
        retiredKeys: deps.retiredKeys, log: deps.log })
      if (recovery === 'activated') {
        repairActivated = true
        selection = selectConfiguration(paths, deps.home, deps.configFs)
      }
      else if (recovery === 'unresolved') selection = { ok: false, source: 'record',
        message: 'The shared recovery outcome is unresolved. Preserve authority, retirement evidence, confirmation and input; restart to recover the retained outcome before any new review.' }
    }
    if (!selection.ok) {
      const prefix = selection.source === 'record' ? RECORD_REFUSAL_PREFIX : CONFIG_REFUSAL_PREFIX
      return refuse(selection.source, undefined, prefix + selection.message)
    }
    const { applied } = selection
    const sharedState = applied.sharedState ?? initialSharedChannelState(applied.bytes, applied.config)
    if (applied.sharedState === undefined) {
      try { write(paths.lastApplied, serializeSharedChannelState(sharedState)) }
      catch (err) {
        return refuse(applied.source, RELOAD_RECORD_WRITE_FAILED, reloadSharedAuthorityStartFailedLine(paths.lastApplied, err))
      }
    }
    sharedChannels = createSharedChannelAuthority(paths.lastApplied, sharedState, { write, home: deps.home, sourcePath: paths.config, now: deps.now, readFs: deps.configFs })
    recoverRetirement(true)
    sharedChannels.subscribe(config => {
      // Reviewed activation establishes old-life guards before notifying consumers.
      if (applyingReviewed || reviewedPublicationRevision === sharedChannels!.revision) return
      if (appliedState !== undefined) appliedState = { config, bytes: sharedChannels!.sourceBytes(), source: 'record' }
      if (!detectionStopped) notifyApplied(config)
    })
    deps.log(reloadSharedAuthorityStartLine(paths.lastApplied, sharedChannels.revision))
    if (sharedState.recovery?.phase === 'active') deps.log(sharedRecoveryLine('retained repair activation',
      `The installed authority retains the consumed repair at order=${sharedState.recovery.activation!.order}; it is not applied again. Current authenticated membership is still required before dependent intake or a recovery-complete claim.`))
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
      await lifecycle.startBringUp({ ...appliedState.config, personas: appliedState.config.personas.filter(persona => !withheldAtStart.has(persona.key)) })
    } finally {
      phase = 'brought-up'
    }
  }

  /**
   * What a failed rewrite's `reload-record-write-failed` line adds once step 1
   * wrote the retired-key record: the record put back to what
   * it held before the apply (`reloadRetiredKeysPutBackClause`), or, when that
   * restore failed, that the keys this apply recorded stay retired
   * (`reloadRetiredKeysPutBackFailedClause`).
   */
  function retiredKeysRestoredClause(store: RetiredKeyStore, restore: RetiredKeysRestoreOutcome): string {
    return restore === RETIRED_KEYS_WRITE_FAILED
      ? reloadRetiredKeysPutBackFailedClause(store.path)
      : reloadRetiredKeysPutBackClause(store.path)
  }

  /**
   * Stop delivery of `key`, which step 1 recorded as retired
   * `deps.stopDelivery`, not awaited; a throw or a
   * rejection is logged, never raised:
   *
   *   [slack] reload: stopping delivery of key=<key>, recorded as retired, failed: <thrown value>
   */
  function stopDeliveryOf(key: string): void {
    const failed = (err: unknown): void =>
      deps.log(`[slack] reload: stopping delivery of key=${key}, recorded as retired, failed: ${describeThrownValue(err)}`)
    try {
      void Promise.resolve(deps.stopDelivery(key)).catch(failed)
    } catch (err) {
      failed(err)
    }
  }

  /**
   * Begin apply step 1's old-life holds (`oldLifeHoldsToBegin`
   *) in the injected hold set, after the last-applied rewrite
   * succeeded; each begin logs its own line. A throw is logged, never
   * raised: the apply goes on.
   */
  function beginStepOneHolds(plan: ValidChangePlan, applied: PersonaConfig): void {
    const holds = deps.oldLifeHolds
    for (const begin of oldLifeHoldsToBegin(plan, applied)) {
      try {
        holds.begin(begin)
      } catch (err) {
        deps.log(`[slack] reload: beginning the old-life hold of ${begin.instanceId} failed: ${describeThrownValue(err)}`)
      }
    }
  }

  /**
   * Open or close the retiring window of `keys`: `begin`
   * marks them as retiring in `channelDelivery`, the end clears them. Memory
   * only. A throw is logged, never raised: the apply goes on.
   */
  function setRetiring(channelDelivery: ChannelDeliveryStore, keys: readonly string[], begin: boolean): void {
    if (keys.length === 0) return
    try {
      if (begin) channelDelivery.beginRetiring(keys)
      else channelDelivery.endRetiring(keys)
    } catch (err) {
      const what = begin ? 'marking' : 'clearing'
      deps.log(`[slack] reload: ${what} the retiring keys failed: ${describeThrownValue(err)}`)
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

  function notifyApplyFailed(failure: ReloadApplyFailure): void {
    try { deps.onApplyFailed?.(failure) }
    catch (err) {
      deps.log(`[slack] reload: reporting the failed configuration change failed: ${describeThrownValue(err)}`)
    }
  }

  /**
   * Tell the server the applied configuration's steps 2–6 have settled
   * (`deps.onApplySettled`), not awaited; a throw or a rejection is logged,
   * never raised.
   */
  function notifyApplySettled(config: PersonaConfig): void {
    const failed = (err: unknown): void => deps.log(reloadPostApplyFailedLine(describeThrownValue(err)))
    try {
      void Promise.resolve(deps.onApplySettled?.(config)).catch(failed)
    } catch (err) {
      failed(err)
    }
  }

  /** Apply exact reviewed bytes at their authority revision. Step 1 prepares
   * retirement, durably applies the shared authority, then stops retired
   * workers and publishes the whole combination. Definite failure restores
   * retirement without stopping accepted work; an unresolved durability
   * outcome retains both records for recovery. Steps 2–6 use the reviewed
   * plan and stop scheduling work when the controller stops; once they have
   * settled, `onApplySettled` is told the applied configuration before
   * `reload-applied` or `reload-noop` is logged. */
  async function applyConfirmed(state: PendingState): Promise<boolean> {
    const current = appliedState
    const { plan, candidate, bytes } = state
    if (current === undefined || detectionStopped) return false
    const review = state.review
    if (sharedChannels === undefined || !review || !reviewMatches(sharedChannels.snapshot(), review) || !state.revalidate()) return false
    if (!plan.valid) {
      if (beginReviewAttempt(sharedChannels, review).kind === 'applied') rejectReviewAttempt(sharedChannels, review.fingerprint)
      deps.log(renderConfirmedInvalidLogLine(plan))
      return false
    }
    // A valid plan always comes from bytes that were read and parsed.
    if (candidate.kind !== 'valid' || bytes === undefined) return false
    if (!sharedChannels.readable || state.authorityRevision !== sharedChannels.revision) return false
    const steps = applyStepsFor(plan)
    // Resolve every planned persona before any durable mutation. The candidate
    // already includes merged automatic choices at the reviewed revision.
    const mergedInputs = applyStepInputs(plan, current.config, candidate.config)
    const reportFailed = (record: ReloadApplyFailure['record'], failure: string): void => {
      const appliedKeys = new Set(current.config.personas.map(persona => persona.key))
      const named = [...new Set([...plan.removed, ...plan.destructive, ...plan.inPlace, ...plan.credentials, ...plan.nextLaunch]
        .map(persona => persona.key).filter(key => appliedKeys.has(key)))]
      notifyApplyFailed({ fingerprint: review.fingerprint, record, failure, personas: named.length ? named : [...appliedKeys] })
    }
    // The one file-free adapter owns the retiring-session guard.
    const channelDelivery = deps.channelDelivery()
    if (detectionStopped) return false

    // Retirement and the one authority application run without an await.
    // A definite failure restores retirement; an uncertain durable outcome
    // keeps its retirement evidence for recovery.
    const store = deps.retiredKeys
    const batch = retiredKeysToRecord(plan, store)
    const recovery = batch.length ? retiredReviewRecovery(store, batch.map(entry => entry.key)) : undefined
    const attempt = beginReviewAttempt(sharedChannels, review, recovery)
    if (attempt.kind !== 'applied') {
      deps.log(reloadSharedAuthorityApplyFailedLine(paths.lastApplied, attempt.kind, sharedChannels.failure, ''))
      if (attempt.kind === 'failed') reportFailed('authority', sharedChannels.failure)
      return false
    }
    const failAttempt = (): string => {
      const restore = recovery ? restoreReviewedRetirement(store, recovery) : undefined
      const rejected = restore !== RETIRED_KEYS_WRITE_FAILED ? rejectReviewAttempt(sharedChannels!, review.fingerprint) : undefined
      if (recovery && rejected?.kind !== 'applied') for (const key of recovery.keys) retirementRecoveryKeys.add(key)
      if (restore === RETIRED_KEYS_WRITE_FAILED) setRetiring(channelDelivery, batch.map(entry => entry.key), true)
      return restore === undefined ? '' : retiredKeysRestoredClause(store, restore)
    }
    const recorded = batch.length === 0 ? undefined : store.record(batch)
    if (recorded !== undefined && recorded.outcome === RETIRED_KEYS_WRITE_FAILED) {
      const restored = failAttempt()
      deps.log(reloadSharedAuthorityApplyFailedLine(paths.lastApplied, 'failed', sharedChannels.failure, restored))
      reportFailed('retired-keys', sharedChannels.failure)
      return false
    }
    if (detectionStopped || !state.revalidate() || sharedChannels.revision !== attempt.revision) {
      failAttempt()
      return false
    }
    let result
    let retiring = plan.destructive.map(({ key }) => key)
    let activationReturned = false
    let appliedConfig: PersonaConfig | undefined
    const onStepFailure = (step: ApplyStepName, err: unknown): void =>
      deps.log(`[slack] reload: apply step ${applyStepNumber(step)} (${step}) failed: ${describeThrownValue(err)}`)
    const finishLifecycle = async (): Promise<void> => {
      try {
        await runApplySteps(applySlots, mergedInputs, steps.filter(step => step === TEARDOWNS_STEP), onStepFailure, () => !detectionStopped)
      } finally {
        setRetiring(channelDelivery, retiring, false)
      }
      await runApplySteps(applySlots, mergedInputs, steps.filter(step => step !== TEARDOWNS_STEP), onStepFailure, () => !detectionStopped)
      if (detectionStopped) return
      // Only now: work started from here runs under lives no teardown of this
      // apply can end.
      if (appliedConfig !== undefined) notifyApplySettled(appliedConfig)
      deps.log(plan.noEffectiveChange ? renderNoopLogLine(paths.lastApplied) : renderAppliedLogLine(plan, paths.lastApplied))
    }
    applyingReviewed = true
    try {
      result = sharedChannels.commitReview(bytes, attempt.revision, review, state.assignments, merged => {
        reviewedPublicationRevision = sharedChannels!.revision
        appliedState = { config: merged, bytes: sharedChannels!.sourceBytes(), source: 'config' }
        appliedConfig = merged
        if (detectionStopped) return
        beginStepOneHolds(plan, current.config)
        setRetiring(channelDelivery, retiring, true)
        notifyApplied(merged)
        for (const { key } of batch) {
          if (detectionStopped) return
          stopDeliveryOf(key)
        }
        for (const persona of plan.removed) {
          try { deps.onQueueRetained?.(persona.key, deps.queueOpenCount?.(persona.key) ?? 0) } catch { /* observer cannot interrupt apply */ }
        }
        if (activationReturned) {
          // A directory-sync uncertainty completed at a later tick. Its one
          // committed outcome resumes the same lifecycle, never an assignment
          // retry. Queue it after the authority has released its write lock.
          recoveredLifecycle = Promise.resolve().then(finishLifecycle).catch(err => {
            deps.log(reviewRecoveredLifecycleFailedLine(err))
          })
        }
      })
    }
    finally { applyingReviewed = false; activationReturned = true }
    if (result?.kind !== 'applied') {
      // Preserve the safe activation cause before rejection metadata writes
      // clear or replace the authority's latest failure.
      const failure = sharedChannels?.failure ?? ''
      const restored = result?.kind !== 'unresolved' ? failAttempt() : ''
      if (result?.kind === 'unresolved') {
        // Recovery must release every guard acquired for this activation,
        // including removals and add-only retirement, after protected teardown.
        retiring = [...new Set([...retiring, ...batch.map(entry => entry.key)])]
        setRetiring(channelDelivery, retiring, true)
      }
      deps.log(reloadSharedAuthorityApplyFailedLine(paths.lastApplied, result?.kind ?? 'failed', failure, restored))
      if (result?.kind === 'failed') reportFailed('authority', failure)
      return false
    }
    if (detectionStopped) return true
    await finishLifecycle()
    return true
  }

  function startDetection(): boolean {
    if (phase !== 'brought-up' || appliedState === undefined) return false
    if (detection !== undefined || detectionStopped || deps.tickDriver === undefined) return false
    const initial = appliedState
    detection = createPendingDetection(deps, {
      recoverPending: async () => {
        recoverRetirement()
        const recovery = recoveredLifecycle
        if (recovery) {
          try { await recovery } finally { if (recoveredLifecycle === recovery) recoveredLifecycle = undefined }
        }
      },
      applied: () => appliedState ?? initial,
      sharedChannels: () => sharedChannels,
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
    repairActivated: () => repairActivated,
    runStartBringUp,
    startDetection,
    stopDetection,
    applied: () => appliedState,
    sharedChannels: () => sharedChannels,
    protectedCredentialsFiles: () =>
      credentialsFilesToProtect(appliedState?.config.personas ?? [], paths.config, deps.home, deps.configFs),
  }
}

// ---------------------------------------------------------------------------
// CLI resolver
// ---------------------------------------------------------------------------

/**
 * The configuration the CLI takes its settings and persona set from: the last-applied record beside `configPath` when it exists
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
