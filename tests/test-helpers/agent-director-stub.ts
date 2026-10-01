/**
 * agent-director-stub.ts — Test helper that mints fake `agent-director`
 * `Client` instances for unit tests (SR-8.3).
 *
 * Epic 1 scope: only the verbs the foundation needs are wired up — the
 * typed Err* classes the SR-5.1 startup gate branches on (`ErrBunVersionTooOld`
 * for the Bun-version gate, plus the AD 0.7.0 system-install discovery trio
 * `ErrSystemInstallNotFound` / `ErrSystemInstallTooOld` /
 * `ErrSystemInstallUnreachable` thrown by `Client.create` and
 * `resolveSystemBinary`), `version()` for the version-gate sub-case matrix,
 * and `makeTemplate()` for the SR-3.2 template install path. Epic 2 extends
 * this helper to cover the full spawn / list / get / decide surface CSCB uses
 * at runtime.
 *
 * Beyond `Client` instances, this module also exports `makeStubCreateClient`
 * and `makeStubResolveSystemBinary` — stub factories shaped like
 * `Client.create()` and `resolveSystemBinary()` respectively, used to drive
 * the SR-5.1 startup gate's catch ladder for the three system-install errors
 * and the runtime version re-check. `makeStubResolveSystemBinary` resolves
 * with `PHASE1_RC_VERSION` at `STUB_RESOLVE_DEFAULT_PATH` by default, takes
 * an ordered `outcomes` list (each entry a version, an error to reject with,
 * or a call that never settles; the last entry repeats) and records every
 * call in `calls`. `makeCloseCountingStubClient` gives a stub client whose
 * `close()` counts its calls, and `makePassingGateDeps` the startup-gate
 * seams of a run that passes every step.
 *
 * The stub does NOT extend `Client` — instantiating the real class would call
 * Bun FFI. Instead it satisfies the structural-typed verb surface CSCB calls,
 * including the AD 0.7.0 readonly getters `binaryPath` / `binaryVersion`.
 * Production code under test injects the stub via the `getClient` factory
 * passed to the startup gate (see src/agent-director-startup.ts).
 *
 * `makeStubCallLog` / `stubCallCount` give a capture list for every verb and
 * their total, and `installStubSpawnPath` / `resetStubSpawnPath` route the
 * real persona launch path (`spawnForPersona`) to a fresh stub client with
 * the dialog and tmux seams faked and a temp spawn home.
 *
 * Phase 1 errors and results (b.jg5 SRJ-1303):
 *   - Every error builder uses the 0.10.0 client's own class, except:
 *       - `errGeneric`, which builds the base `AgentDirectorError` for any
 *         `errName`;
 *       - `errAmbiguousRequest` and `errPermissionRequestNotFound`, which
 *         build the base `AgentDirectorError` with the error's `errName`
 *         although 0.10.0 exports a class for each, because the code under
 *         test recognises both by `errName`;
 *       - the three for the errors only the Phase 1 client declares
 *         (`errTmuxUnresponsive*`, `errTmuxKillFailed`,
 *         `errTmuxSessionConflict`).
 *     Under the interim rule (b.jg5 SRJ-101) no file names a Phase-1-only
 *     export in a named import or re-export, since a missing named export
 *     fails every module that loads it; those three builders build the
 *     client's base `AgentDirectorError` whose `name` and `errName` are the
 *     error's name, taken from the string constants in
 *     `src/agent-director-errors.ts`. Once the Phase 1 client is adopted
 *     (b.jg5 E37) they switch to its classes.
 *   - `ErrInternal`, `ErrConfigMalformed` and the three store-open names
 *     (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`, `ErrStoreOpen`)
 *     have no class in any client and arrive as `ErrUnknownErrorName`;
 *     `errInternal`, `errUnusableName`, `errConfigMalformed`,
 *     `errSchemaMismatch` and `errUnknownErrorName` build that class the way
 *     the client does, with the name in `unknownName` and the binary's
 *     `{ err_name, err_description }` envelope in `envelope`
 *     (`ErrSchemaMigrationRequired` and `ErrStoreOpen` through
 *     `errUnknownErrorName`).
 *   - `UNAVAILABLE_FORMS` is the one table of UNAVAILABLE forms (label,
 *     builder by verb, cause kind); `unavailableForms` picks a subset.
 *   - The description words CSCB matches come from
 *     `src/ad-description-phrases.ts`; the Phase 1 result fields
 *     (`kill_sent`, `launch_started_at`, `liveness_note`, `pre_trust`) are
 *     typed by `src/ad-phase1-types.ts`, never imported from `agent-director`.
 *   - Liveness notes (b.jg5 SRJ-114): `provenanceNote` is the only note that
 *     latches; `nonLatchingNotes` is every other note agent-director names,
 *     the list a `test.each` iterates for "no other note latches", typed as
 *     the 0.10.0 client's free text; `unknownNote` is a note CSCB does not
 *     know. Tests take note values from here and never type them.
 *
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AgentDirectorError,
  ErrAlreadyDecided,
  ErrBunVersionTooOld,
  ErrCallTimeout,
  ErrInstanceIdCollision,
  ErrInvalidFlags,
  ErrJsonlMissing,
  ErrJsonlNeverWritten,
  ErrNoOpenPermissionRequest,
  ErrNoSessionId,
  ErrPauseTimeout,
  ErrRelayFallenBack,
  ErrRelayModeOff,
  ErrSpawnNotFound,
  ErrSpawnNotInteractive,
  ErrSpawnNotPausable,
  ErrSpawnNotResumable,
  ErrSystemInstallDisappeared,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
  ErrTmuxCaptureFailed,
  ErrTmuxNotAvailable,
  ErrTmuxSendKeys,
  ErrTmuxSessionCreate,
  ErrTemplateExists,
  ErrTemplateMalformed,
  ErrTemplateNameUnsafe,
  ErrUnknownErrorName,
} from 'agent-director'
import type { UnreachableReason } from 'agent-director'
import type {
  ClientOptions,
  DecideParams,
  DecideResult,
  DeleteParams,
  DeleteResult,
  FindMissingParams,
  FindMissingResult,
  GetParams,
  KillParams,
  ListParams,
  MakeTemplateParams,
  MakeTemplateResult,
  PauseParams,
  PauseResult,
  ReadPaneParams,
  ReadPaneResult,
  ResumeParams,
  SendKeysParams,
  SendKeysResult,
  SpawnParams,
  SpawnResult,
  StatusParams,
  VersionParams,
  VersionResult,
} from 'agent-director'
import type { PermissionRequestRow } from '../../src/permission-poller.ts'
import type {
  GetPermissionParams,
  GetPermissionResult,
} from '../../src/agent-director-client.ts'
import type { Persona } from '../../src/config.ts'
import {
  PERSONA_INSTANCE_ID_PREFIX,
  personaInstanceId,
  personaTmuxSessionName,
} from '../../src/persona-identity.ts'
import {
  _resetDialogPollIntervalMs,
  _resetDialogReadyTimeoutMs,
  _resetInFlightLaunches,
  _resetSpawnHomeDir,
  _resetTmuxDialogHelpers,
  _resetTmuxSessionProber,
  _setDialogPollIntervalMs,
  _setDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _setTmuxSessionProber,
  personaConfigDirLabelValue,
} from '../../src/session-manager.ts'
import { resetClientForTests, setClientForTests } from '../../src/agent-director-client.ts'
import {
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  type Phase1OnlyErrName,
} from '../../src/agent-director-errors.ts'
import {
  CONFLICT_ANOTHER_STORE_PHRASE,
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  DIFFERENT_TMUX_SERVER_PHRASE,
  LAUNCH_TIMEOUT_PHRASE,
  NEVER_DELETE_ROW_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  RETRY_KILL_LATER_PHRASE,
  STILL_STARTING_PHRASE,
  STILL_STOPPING_PHRASE,
  UNUSABLE_RECORDED_NAME_PHRASE,
  survivorPids,
} from '../../src/ad-description-phrases.ts'
import type {
  LivenessNote,
  Phase1GetResult,
  Phase1KillResult,
  Phase1ListResult,
  Phase1ListRow,
  Phase1ResumeResult,
  Phase1SpawnResult,
  Phase1StatusResult,
  PreTrust,
} from '../../src/ad-phase1-types.ts'
import type { StartupGateDeps } from '../../src/agent-director-startup.ts'
import { CSCB_UNKNOWN_ERROR_NAME } from '../../src/ad-error-class.ts'
import { UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE } from '../../src/unavailable-retry.ts'
import { PHASE1_RC_VERSION } from './agent-director-versions.ts'
import { makePersona } from './persona-config.ts'

// ---------------------------------------------------------------------------
// Canned-result and canned-rejection factories
// ---------------------------------------------------------------------------

/** Build a canned VersionResult. */
export function cannedVersion(version: string, commit: string = 'deadbeef'): VersionResult {
  return { version, commit }
}

/** Build a canned MakeTemplateResult. */
export function cannedMakeTemplate(path: string): MakeTemplateResult {
  return { path }
}

/**
 * Build a canned `FindMissingResult` in the agent-director 0.8.0 shape
 * (b.4dk / plan b.93m: `{ count, ids, unverified, unverified_ids }`). All
 * four fields are read by the CSCB findMissing-before-resume log line. The
 * default is the empty/zero result (count 0, empty id arrays); tests that need
 * missing rows pass overrides.
 *
 * The placement form, `cannedFindMissing({ rows: { <id>: <placement> } })`,
 * puts each given row id where a sweep would report it: `'ids'` (the row was
 * marked `missing`), `'unverified_ids'` (its liveness could not be
 * established) or `'neither'` (the sweep did not judge it, e.g. the row is
 * inside the host's grace period, or it was found alive). Both id lists are
 * sorted, as agent-director gives them, and `count` / `unverified` equal
 * their lengths.
 */
export function cannedFindMissing(placement: FindMissingPlacement): FindMissingResult
export function cannedFindMissing(overrides?: Partial<FindMissingResult>): FindMissingResult
export function cannedFindMissing(
  arg: Partial<FindMissingResult> | FindMissingPlacement = {},
): FindMissingResult {
  if ('rows' in arg) {
    const entries = Object.entries(arg.rows)
    const ids = entries.filter(([, where]) => where === 'ids').map(([id]) => id).sort()
    const unverifiedIds = entries.filter(([, where]) => where === 'unverified_ids').map(([id]) => id).sort()
    return { count: ids.length, ids, unverified: unverifiedIds.length, unverified_ids: unverifiedIds }
  }
  return {
    count: 0,
    ids: [],
    unverified: 0,
    unverified_ids: [],
    ...arg,
  }
}

/** Where a `find-missing` sweep reports a row: marked missing, unverified, or not judged. */
export type FindMissingRowPlacement = 'ids' | 'unverified_ids' | 'neither'

/** The placement form of `cannedFindMissing`: each row id and where the sweep reports it. */
export interface FindMissingPlacement {
  rows: Readonly<Record<string, FindMissingRowPlacement>>
}

/**
 * Build a canned `kill` result. `killSent` is the Phase 1 `kill_sent` field
 * (whether agent-director sent a kill); omit it for a result from a binary
 * older than Phase 1, which has no such field (the key is then absent).
 */
export function cannedKillResult(killSent?: boolean): Phase1KillResult {
  return killSent === undefined ? {} : { kill_sent: killSent }
}

/**
 * Sample launch starts (`launch_started_at`, ADSRD SR-22.2: RFC 3339 UTC with
 * millisecond precision, the fraction shown only when it is not zero): one
 * with fractional seconds and one without. For a row with no launch start,
 * pass `SAMPLE_LAUNCH_START_NONE` (`undefined`): the canned builders then omit
 * the key.
 */
export const SAMPLE_LAUNCH_START_FRACTIONAL = '2026-05-24T12:00:00.123Z'
export const SAMPLE_LAUNCH_START_WHOLE = '2026-05-24T12:00:00Z'
export const SAMPLE_LAUNCH_START_NONE = undefined

/** The three sample launch starts by form, for `test.each`. */
export const SAMPLE_LAUNCH_STARTS: Readonly<Record<'fractional' | 'whole' | 'none', string | undefined>> = {
  fractional: SAMPLE_LAUNCH_START_FRACTIONAL,
  whole: SAMPLE_LAUNCH_START_WHOLE,
  none: SAMPLE_LAUNCH_START_NONE,
}

/**
 * A `liveness_note` as the 0.10.0 client types it: free text, since
 * agent-director has notes CSCB does not tell apart.
 */
type ClientLivenessNote = NonNullable<Phase1GetResult['liveness_note']>

/**
 * The `liveness_note` that latches a persona with the CONFLICT case
 * "conflicting labels" (b.jg5 SRJ-114, SRJ-501, SRJ-507), and the only note
 * that latches. Set it on a `get` or `list` row with
 * `cannedGetResult({ ..., liveness_note: provenanceNote })` or
 * `cannedListRow(...)`. It is the stub's own spelling of agent-director's
 * wire value, not a re-export of `src/`'s constant, so a misspelt constant
 * fails a test.
 */
export const provenanceNote: LivenessNote = 'provenance_conflict'

/**
 * Every `liveness_note` agent-director names besides `provenanceNote`, as
 * HO rev 22 spells them; none ever latches a persona (b.jg5 SRJ-114:
 * `tmux_server_changed`, `process_not_seen_*`, `probe_eacces`,
 * `tmux_session_name_*`). This is the list a `test.each` iterates for "no
 * other note latches". Neither `provenanceNote` nor `unknownNote` is in it.
 */
export const nonLatchingNotes: readonly ClientLivenessNote[] = [
  'tmux_server_changed',
  'process_not_seen_session_present',
  'process_not_seen_tmux_unchecked',
  'probe_eacces',
  'tmux_session_name_empty',
  'tmux_session_name_control_char',
  'tmux_session_name_rewritten',
]

/**
 * A `liveness_note` agent-director might send that CSCB does not know, for
 * the "an unknown note latches no one" cases (b.jg5 SRJ-114). It starts with
 * `provenanceNote`'s spelling, so a prefix match of the latching note (in
 * place of exact equality) latches on it and fails the case.
 */
export const unknownNote: ClientLivenessNote = `${provenanceNote}_cleared`

/**
 * The Phase 1 row fields `cannedGetResult` and `cannedListRow` take as
 * overrides; given as `undefined`, the key is left out of the row.
 */
const PHASE1_ROW_FIELDS = ['launch_started_at', 'liveness_note'] as const

/** Drop the listed keys whose value is `undefined`, so "none" means absent. */
function omitUndefined<T extends object>(row: T, keys: readonly string[]): T {
  const rec = row as Record<string, unknown>
  for (const key of keys) {
    if (key in rec && rec[key] === undefined) delete rec[key]
  }
  return row
}

/**
 * Build a canned `status` result (default `{ state: 'waiting' }`). A Phase 1
 * `status` result carries only `state` and `launch_started_at`, so
 * `launch_started_at` is its one Phase 1 override; `liveness_note` belongs on
 * `cannedGetResult` and `cannedListRow`. A `launch_started_at` of `undefined`
 * omits the key.
 */
export function cannedStatusResult(overrides: Partial<Phase1StatusResult> = {}): Phase1StatusResult {
  return omitUndefined({ state: 'waiting', ...overrides }, ['launch_started_at'])
}

/**
 * Build a canned spawn result (plain or reuse). `preTrust` is the Phase 1
 * `pre_trust` field (`ok`, `skipped`, `failed`); omit it for a result from a
 * binary older than Phase 1 (the key is then absent).
 */
export function cannedSpawnResult(claudeInstanceId: string = 'cscb_test', preTrust?: PreTrust): Phase1SpawnResult {
  return preTrust === undefined
    ? { claude_instance_id: claudeInstanceId }
    : { claude_instance_id: claudeInstanceId, pre_trust: preTrust }
}

/** Build a canned `resume` result, with `pre_trust` as `cannedSpawnResult` takes it. */
export function cannedResumeResult(claudeInstanceId: string = 'cscb_test', preTrust?: PreTrust): Phase1ResumeResult {
  return preTrust === undefined
    ? { claude_instance_id: claudeInstanceId }
    : { claude_instance_id: claudeInstanceId, pre_trust: preTrust }
}

/** Build an ErrBunVersionTooOld (Client-constructor failure mode). */
export function errBunVersionTooOld(actual: string = '0.9.0', minimum: string = '1.0.21'): ErrBunVersionTooOld {
  return new ErrBunVersionTooOld(actual, minimum)
}

/** Build an ErrSystemInstallNotFound (Client.create / resolveSystemBinary failure mode). */
export function errSystemInstallNotFound(checkedLocations: ReadonlyArray<{kind: 'standard-install-path'|'path-lookup'; detail: string|null}> = []): ErrSystemInstallNotFound {
  return new ErrSystemInstallNotFound(checkedLocations)
}

/** Build an ErrSystemInstallTooOld with detected + required version strings (Client.create floor failure). */
export function errSystemInstallTooOld(detected: string = '0.5.0', required: string = '0.7.0', binaryPath: string = '/usr/local/bin/agent-director'): ErrSystemInstallTooOld {
  return new ErrSystemInstallTooOld(detected, required, binaryPath)
}

/** Build an ErrSystemInstallUnreachable with a UnreachableReason value. */
export function errSystemInstallUnreachable(reason: UnreachableReason = 'other', diagnostic: string | null = null, binaryPath: string = '/usr/local/bin/agent-director'): ErrSystemInstallUnreachable {
  return new ErrSystemInstallUnreachable(binaryPath, reason, { diagnostic })
}

/** Build an ErrCallTimeout (any verb; per-call timeout exceeded). */
export function errCallTimeout(verb: string = 'version', elapsedMs: number = 35000, timeoutMs: number = 30000): ErrCallTimeout {
  return new ErrCallTimeout(verb, elapsedMs, timeoutMs)
}

/** Build an ErrTemplateExists (makeTemplate failure mode pre-overwrite). */
export function errTemplateExists(): ErrTemplateExists {
  return new ErrTemplateExists('make-template', 'ErrTemplateExists', 'template already exists')
}

/** Build an ErrTemplateMalformed (makeTemplate fatal failure mode). */
export function errTemplateMalformed(): ErrTemplateMalformed {
  return new ErrTemplateMalformed('make-template', 'ErrTemplateMalformed', 'template malformed')
}

/** Build an ErrTemplateNameUnsafe (makeTemplate fatal failure mode). */
export function errTemplateNameUnsafe(): ErrTemplateNameUnsafe {
  return new ErrTemplateNameUnsafe('make-template', 'ErrTemplateNameUnsafe', 'unsafe template name')
}

/** Build a plain AgentDirectorError (catch-all path). */
export function errGeneric(verb: string, errName: string, message: string = 'oops'): AgentDirectorError {
  return new AgentDirectorError(verb, errName, message)
}

/** Build an ErrSpawnNotFound (spawn/get/decide on missing row). */
export function errSpawnNotFound(): ErrSpawnNotFound {
  return new ErrSpawnNotFound('get', 'ErrSpawnNotFound', 'spawn not found')
}

/** Build an ErrSpawnNotInteractive (readPane/sendKeys while spawn is still pending). */
export function errSpawnNotInteractive(verb: string = 'read-pane'): ErrSpawnNotInteractive {
  return new ErrSpawnNotInteractive(verb, 'ErrSpawnNotInteractive', 'spawn not interactive — not in pending/waiting state')
}

/**
 * Build an ErrSpawnNotInteractive for a session that is a leftover's: the
 * session holding the row's name carries an earlier launch's label, so
 * nothing was sent (default verb `send-keys`).
 */
export function errSpawnNotInteractiveLeftover(
  sessionName: string = STUB_TMUX_SESSION_NAME,
  verb: string = 'send-keys',
): ErrSpawnNotInteractive {
  return new ErrSpawnNotInteractive(
    verb,
    'ErrSpawnNotInteractive',
    `tmux session ${JSON.stringify(sessionName)} is a leftover of an earlier launch of this row (its label carries an earlier launch's token); nothing was sent`,
  )
}

/**
 * Build an ErrSpawnNotInteractive for a `pending` row with no launch start,
 * which is always refused (default verb `send-keys`).
 */
export function errSpawnNotInteractiveNoLaunchStart(verb: string = 'send-keys'): ErrSpawnNotInteractive {
  return new ErrSpawnNotInteractive(
    verb,
    'ErrSpawnNotInteractive',
    'the pending row has no launch start; nothing was sent',
  )
}

/** Build an ErrInstanceIdCollision (spawn / SR-1.4 collision path). */
export function errInstanceIdCollision(): ErrInstanceIdCollision {
  return new ErrInstanceIdCollision('spawn', 'ErrInstanceIdCollision', 'claude_instance_id already in use')
}

/**
 * Build an ErrTmuxSessionCreate (spawn/resume / b.vub orphan-tmux collision).
 * The `verb` defaults to 'resume' — the observed field failure path — but
 * callers pass 'spawn' to exercise the fresh-spawn self-heal branch.
 */
export function errTmuxSessionCreate(verb: string = 'resume'): ErrTmuxSessionCreate {
  return new ErrTmuxSessionCreate(verb, 'ErrTmuxSessionCreate', 'tmux: new-session failed: tmux session already exists')
}

/**
 * Build an ErrTmuxSendKeys (sendKeys / b.rmy post-reboot reconnect failure).
 * The message mirrors the observed field failure: no tmux server exists at
 * all after a container restart wipes /tmp.
 */
export function errTmuxSendKeys(): ErrTmuxSendKeys {
  return new ErrTmuxSendKeys('send-keys', 'ErrTmuxSendKeys', 'tmux: send-keys failed: no server running on /tmp/tmux-1000/default: exit status 1')
}

/** Build an ErrNoSessionId (resume / SR-1.3 fall-through). */
export function errNoSessionId(): ErrNoSessionId {
  return new ErrNoSessionId('resume', 'ErrNoSessionId', 'no session id available')
}

/**
 * Build an ErrJsonlMissing (resume / SR-1.3 fall-through).
 *
 * The optional `description` maps to `errDescription`, the human-readable
 * detail string AD attaches to the error envelope. b.wrb's diagnostic parses
 * this for the rich `<source> <path> (<stat error>)` enumeration; pass a plain
 * string (the installed 0.8.0 shape) to exercise the locally-computed
 * degradation path.
 */
export function errJsonlMissing(description: string = 'jsonl missing'): ErrJsonlMissing {
  return new ErrJsonlMissing('resume', 'ErrJsonlMissing', description)
}

/**
 * Build an ErrJsonlNeverWritten (resume / AD 0.10.0). Distinct from
 * ErrJsonlMissing: the session never wrote a transcript at all, so there is
 * provably no history to lose and the recovery is lossless (b.jgf).
 */
export function errJsonlNeverWritten(): ErrJsonlNeverWritten {
  return new ErrJsonlNeverWritten(
    'resume',
    'ErrJsonlNeverWritten',
    'spawn cscb_general_C session aaca1537 has produced no transcript',
  )
}

/** Build an ErrSpawnNotResumable (resume / SR-1.4 collision-recovery). */
export function errSpawnNotResumable(): ErrSpawnNotResumable {
  return new ErrSpawnNotResumable('resume', 'ErrSpawnNotResumable', 'row is non-terminal')
}

/** Build an ErrAlreadyDecided (decide; treated-as-success). */
export function errAlreadyDecided(): ErrAlreadyDecided {
  return new ErrAlreadyDecided('decide', 'ErrAlreadyDecided', 'permission request already decided')
}

/**
 * Build an ErrInvalidFlags, the client's own class (default verb `decide`: a
 * missing required flag such as `--request-token`; pass `spawn` or `resume`
 * for the launch verbs' refusal). Its `errName` is `ErrInvalidFlags`, so a
 * match on `err.errName` fires as well as `instanceof`.
 */
export function errInvalidFlags(verb: string = 'decide'): ErrInvalidFlags {
  return new ErrInvalidFlags(verb, 'ErrInvalidFlags', 'invalid flags')
}

/**
 * Build an ErrAmbiguousRequest (decide; defense-in-depth backstop, should be
 * unreachable under contract). Built as a base `AgentDirectorError` with the
 * canonical `errName`, not the 0.10.0 client's `ErrAmbiguousRequest` class;
 * callers match on `errName`.
 */
export function errAmbiguousRequest(): AgentDirectorError {
  return new AgentDirectorError('decide', 'ErrAmbiguousRequest', 'ambiguous request')
}

/**
 * Build the AD `ErrPermissionRequestNotFound` sentinel returned by the
 * paired-release `get-permission` verb when the row has aged out of AD's
 * store. The 0.10.0 client exports an `ErrPermissionRequestNotFound` class,
 * but this builder keeps the base `AgentDirectorError`: the poller's
 * `isErrPermissionRequestNotFound` predicate matches on
 * `errName === 'ErrPermissionRequestNotFound'`, so a base error with that
 * `errName` routes the same way as the client's class; the builder stays
 * unchanged so its callers behave as before.
 */
export function errPermissionRequestNotFound(): AgentDirectorError {
  return new AgentDirectorError('get-permission', 'ErrPermissionRequestNotFound', 'permission request not found')
}

/** Build an ErrNoOpenPermissionRequest (decide / poller race). */
export function errNoOpenPermissionRequest(): ErrNoOpenPermissionRequest {
  return new ErrNoOpenPermissionRequest('decide', 'ErrNoOpenPermissionRequest', 'no open permission request')
}

/** Build an ErrRelayModeOff (spawn / SR-1.2 abort). */
export function errRelayModeOff(): ErrRelayModeOff {
  return new ErrRelayModeOff('spawn', 'ErrRelayModeOff', 'relay_mode is off')
}

/**
 * Build an ErrRelayFallenBack (decide / AD 0.10.0). Distinct from
 * ErrRelayModeOff: relay was on, but this request's relay window elapsed, so
 * Claude already fell back to asking at its own tmux pane and AD refuses to
 * record a verdict nothing would read. The spawn stays alive (b.qi1).
 */
export function errRelayFallenBack(): ErrRelayFallenBack {
  return new ErrRelayFallenBack(
    'decide',
    'ErrRelayFallenBack',
    'relay window elapsed; the prompt fell back to the tmux pane',
  )
}

/** Build an ErrPauseTimeout (pause budget exceeded). */
export function errPauseTimeout(): ErrPauseTimeout {
  return new ErrPauseTimeout('pause', 'ErrPauseTimeout', 'pause timed out')
}

// ---------------------------------------------------------------------------
// Phase 1 error builders (b.jg5 SRJ-1303)
// ---------------------------------------------------------------------------

/** The tmux session name the Phase 1 error builders name by default: the default persona fixture's. */
export const STUB_TMUX_SESSION_NAME = personaTmuxSessionName('test_bot')

/** The instance id the Phase 1 error builders name by default: the default persona fixture's. */
export const STUB_INSTANCE_ID = personaInstanceId('test_bot')

/** The default socket path of `errTmuxNotAvailable` / `errTmuxNotAvailableDifferentServer`. */
export const STUB_TMUX_SOCKET_PATH = '/tmp/tmux-1000/default'

/** The config file path `errConfigMalformed`'s description names. */
const STUB_AD_CONFIG_PATH = '/home/agent/.agent-director/config.toml'

/**
 * A Phase-1-only error by name (interim rule, b.jg5 SRJ-101): the 0.10.0
 * client's base `AgentDirectorError` whose `errName` and `name` are `name`,
 * so it classifies by name exactly as the Phase 1 class would. Switches to
 * the Phase 1 client's classes once that client is adopted (b.jg5 E37).
 */
function phase1OnlyError(name: Phase1OnlyErrName, verb: string, description: string): AgentDirectorError {
  const err = new AgentDirectorError(verb, name, description)
  err.name = name
  return err
}

/**
 * Build an `ErrTmuxUnresponsive` (by name): a tmux call that did not answer
 * (default verb `resume`; `status` only reads the store and never returns
 * it). The default description is a call timeout that did nothing; pass
 * `description` for another. See `errTmuxUnresponsiveLaunchTimeout`,
 * `errTmuxUnresponsiveStillStopping` and `errTmuxUnresponsiveStillStarting`
 * for the variants CSCB tells apart.
 */
export function errTmuxUnresponsive(
  verb: string = 'resume',
  description: string = 'tmux display-message did not answer within 5 s; nothing was done; retry later',
): AgentDirectorError {
  return phase1OnlyError(ERR_TMUX_UNRESPONSIVE_NAME, verb, description)
}

/**
 * Build an `ErrTmuxUnresponsive` (by name) that ends a launch call as a launch
 * timeout: its description carries "the session may have been created"
 * (default verb `spawn`; pass `resume` for a resume).
 */
export function errTmuxUnresponsiveLaunchTimeout(
  verb: string = 'spawn',
  instanceId: string = STUB_INSTANCE_ID,
): AgentDirectorError {
  return phase1OnlyError(
    ERR_TMUX_UNRESPONSIVE_NAME,
    verb,
    `${verb} of ${instanceId}: tmux new-session did not answer within 5 s; ${LAUNCH_TIMEOUT_PHRASE} and the row stays pending; do not retry until get shows the row ended or missing`,
  )
}

/**
 * Build an `ErrTmuxUnresponsive` (by name) for a row that "appears to still be
 * stopping": it ended less than the stopping window (90 s) ago and its own
 * session still runs. The description names the quoted session name, as
 * agent-director's does (default verb `resume`; reuse and
 * `kill --include-finished` also return it).
 */
export function errTmuxUnresponsiveStillStopping(
  verb: string = 'resume',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): AgentDirectorError {
  return phase1OnlyError(
    ERR_TMUX_UNRESPONSIVE_NAME,
    verb,
    `the agent in tmux session ${JSON.stringify(sessionName)} ${STILL_STOPPING_PHRASE}: its row ended less than the stopping window (90 s) ago; nothing was done; retry later`,
  )
}

/**
 * Build an `ErrTmuxUnresponsive` (by name) for a row that "appears to still be
 * starting": its own session is younger than the starting-session bound
 * (300 s). The description names the quoted session name, as
 * agent-director's does (default verb `resume`; reuse also returns it).
 */
export function errTmuxUnresponsiveStillStarting(
  verb: string = 'resume',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): AgentDirectorError {
  return phase1OnlyError(
    ERR_TMUX_UNRESPONSIVE_NAME,
    verb,
    `the agent in tmux session ${JSON.stringify(sessionName)} ${STILL_STARTING_PHRASE}: the session is younger than the starting-session bound (300 s); nothing was done; retry later`,
  )
}

/**
 * The four `ErrTmuxKillFailed` descriptions:
 *   - `'outlived-exit-wait'`: a kill was sent and the agent process outlived
 *     the kill exit wait;
 *   - `'pane-process-survived'`: a kill was sent and another process of the
 *     labelled session's panes outlived it, each such process named as
 *     `pid <n>` (the survivor-naming form `SURVIVOR_PID_PATTERN` matches);
 *   - `'unverifiable-session-present'`: a kill was sent, the process cannot be
 *     checked and the labelled session is still there;
 *   - `'no-session-no-kill'`: no session or pane of this launch was found
 *     while the process runs, and no kill was sent.
 */
export type KillFailedDescription =
  | 'outlived-exit-wait'
  | 'pane-process-survived'
  | 'unverifiable-session-present'
  | 'no-session-no-kill'

/** Every `KillFailedDescription`, for `test.each`. */
export const KILL_FAILED_DESCRIPTIONS: readonly KillFailedDescription[] = [
  'outlived-exit-wait',
  'pane-process-survived',
  'unverifiable-session-present',
  'no-session-no-kill',
]

/**
 * The pids `errTmuxKillFailed`'s `'pane-process-survived'` description names
 * by default: one fake pid, above Linux's largest pid (2^22), so it can never
 * be a real process.
 */
export const STUB_SURVIVOR_PIDS: readonly number[] = [4194400]

/**
 * Build an `ErrTmuxKillFailed` (by name; verb `kill`) with one of its four
 * descriptions, each carrying the quoted session name, "retry kill later" and
 * "never delete this row". Only `'pane-process-survived'` names a pid: each of
 * `pids` (one or more) as `pid <n>`, joined with ", "; the other three ignore
 * `pids` and name none. The builder checks its own text with `survivorPids`
 * and throws when the pids it names are not exactly `pids` (none for the
 * other three).
 */
export function errTmuxKillFailed(
  sessionName: string = STUB_TMUX_SESSION_NAME,
  description: KillFailedDescription = 'outlived-exit-wait',
  pids: readonly number[] = STUB_SURVIVOR_PIDS,
): AgentDirectorError {
  const quoted = JSON.stringify(sessionName)
  const tail = `${RETRY_KILL_LATER_PHRASE}; ${NEVER_DELETE_ROW_PHRASE}`
  const named = pids.map((pid) => `pid ${pid}`).join(', ')
  const text: Record<KillFailedDescription, string> = {
    'outlived-exit-wait':
      `a kill was sent to tmux session ${quoted} and the agent process outlived the kill exit wait (5 s); the row stays live and nothing was marked; ${tail}`,
    'pane-process-survived':
      `a kill was sent to tmux session ${quoted} and the agent process exited, but another process of the labelled session's panes outlived it (${named}); the row stays live; ${tail}`,
    'unverifiable-session-present':
      `a kill was sent to tmux session ${quoted}; the agent process cannot be checked and the labelled session is still there; the row stays live; ${tail}`,
    'no-session-no-kill':
      `no session or pane of this launch was found (tmux session ${quoted}) while the agent process runs; ${NO_KILL_SENT_PHRASE}; ${tail}`,
  }
  const expected = description === 'pane-process-survived' ? [...pids] : []
  if (description === 'pane-process-survived' && pids.length === 0) {
    throw new Error("errTmuxKillFailed: 'pane-process-survived' names one or more pids")
  }
  if (JSON.stringify(survivorPids(text[description])) !== JSON.stringify(expected)) {
    throw new Error(`errTmuxKillFailed (${description}): the description does not name exactly the pids ${JSON.stringify(expected)}`)
  }
  return phase1OnlyError(ERR_TMUX_KILL_FAILED_NAME, 'kill', text[description])
}

/**
 * The `ErrTmuxSessionConflict` cases the stub builds (ADSRD SR-1.4), each
 * named for its case words; `unrecognised` carries none of them.
 */
export type ConflictCase =
  | 'no-valid-id'
  | 'different-id'
  | 'another-store'
  | 'own-id'
  | 'leftover'
  | 'scan-leftover'
  | 'duplicate-session-leftover'
  | 'not-this-launch'
  | 'pane-not-found'
  | 'conflicting-labels'
  | 'never-reported-in'
  | 'unrecognised'

/** Every `ConflictCase`, for `test.each`. */
export const CONFLICT_CASES: readonly ConflictCase[] = [
  'no-valid-id',
  'different-id',
  'another-store',
  'own-id',
  'leftover',
  'scan-leftover',
  'duplicate-session-leftover',
  'not-this-launch',
  'pane-not-found',
  'conflicting-labels',
  'never-reported-in',
  'unrecognised',
]

/**
 * The variants of `errTmuxSessionConflict` the positional form cannot select.
 * Each is valid on its own cases only:
 *   - `plainSpawn`: `different-id` or `another-store` met by a plain spawn at
 *     "duplicate session";
 *   - `notAdopted`: `pane-not-found` after a lost create reply whose pane was
 *     not adopted;
 *   - `scan`: `conflicting-labels` from the pre-spawn scan.
 */
export type ConflictOptions = {
  readonly plainSpawn?: boolean
  readonly notAdopted?: boolean
  readonly scan?: boolean
}

/** The cases each `ConflictOptions` key may be set on. */
const CONFLICT_OPTION_CASES: Readonly<Record<keyof ConflictOptions, readonly ConflictCase[]>> = {
  plainSpawn: ['different-id', 'another-store'],
  notAdopted: ['pane-not-found'],
  scan: ['conflicting-labels'],
}

/** The fake tmux session id `scan-leftover` names beside the quoted session name. */
export const STUB_TMUX_SESSION_ID = '$7'

/**
 * Build an `ErrTmuxSessionConflict` (by name) for `conflictCase`. Each
 * description carries the quoted session name and the case words of ADSRD
 * SR-1.4 (from `src/ad-description-phrases.ts`), with that table's extras,
 * and ends with the `list --tmux-session-name` line naming the session:
 * agent-director puts that line in every CONFLICT message.
 *   - `different-id` and `another-store`: that the session is another row's
 *     (another store's) agent and must not be ended; these two alone do not
 *     point to "Operator actions". With `{ plainSpawn: true }`, also "its
 *     label does not name this instance id" and "the new row was ended";
 *   - `scan-leftover` (the pre-spawn scan's refusal): "left over from an
 *     earlier life", the session's tmux id and "nothing was written and no
 *     row was created";
 *   - `duplicate-session-leftover` (a plain spawn at "duplicate session"):
 *     "its label names this instance id", "left over from an earlier life"
 *     and "the new row was ended";
 *   - `not-this-launch` from `kill`: also "this row's own id" and "no kill
 *     was sent"; from any other verb, only "not this launch's session";
 *   - `pane-not-found`: also "this row's own id"; with
 *     `{ notAdopted: true }`, also "the agent's pane was not adopted";
 *   - `conflicting-labels`: with `{ scan: true }`, also "nothing was written
 *     and no row was created";
 *   - `never-reported-in`: also "this row's own id" and "no kill was sent";
 *   - `unrecognised`: none of the case words.
 * Every other description also points a human to "Operator actions". No
 * description names a command that ends a session; "no kill was sent" is the
 * one mention of a kill. An option set on a case it does not apply to throws.
 */
export function errTmuxSessionConflict(
  verb: string,
  conflictCase: ConflictCase,
  sessionName: string = STUB_TMUX_SESSION_NAME,
  options: ConflictOptions = {},
): AgentDirectorError {
  for (const key of Object.keys(CONFLICT_OPTION_CASES) as (keyof ConflictOptions)[]) {
    if (options[key] === true && !CONFLICT_OPTION_CASES[key].includes(conflictCase)) {
      throw new Error(`errTmuxSessionConflict: option ${key} does not apply to case ${conflictCase}`)
    }
  }
  const quoted = JSON.stringify(sessionName)
  const session = `tmux session ${quoted}`
  const humanMustLook = 'a human must look (see "Operator actions" in the agent-director README)'
  const listLine = `agent-director list --tmux-session-name ${quoted} shows the rows that name it`
  const plainSpawnExtras = options.plainSpawn === true
    ? `; ${PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE}; ${NEW_ROW_ENDED_PHRASE}`
    : ''
  const text: Record<ConflictCase, string> = {
    'no-valid-id': `${session} holds the row's session name but carries ${CONFLICT_NO_VALID_ID_PHRASE}; ${humanMustLook}; ${listLine}`,
    'different-id':
      `${session} holds the row's session name but carries ${CONFLICT_DIFFERENT_ID_PHRASE}${plainSpawnExtras}; it is another row's agent and must not be ended; ${listLine}`,
    'another-store':
      `${session} holds the row's session name but its label was written by ${CONFLICT_ANOTHER_STORE_PHRASE}${plainSpawnExtras}; it is that store's agent and must not be ended; ${listLine}`,
    'own-id': `${session} carries ${CONFLICT_OWN_ID_PHRASE} but cannot be confirmed as the row's session; ${humanMustLook}; ${listLine}`,
    'leftover': `${session} is ${CONFLICT_LEFTOVER_PHRASE} of this row; ${humanMustLook}; ${listLine}`,
    'scan-leftover':
      `the pre-spawn scan found ${session} (tmux id ${STUB_TMUX_SESSION_ID}) ${CONFLICT_LEFTOVER_PHRASE} of this instance id; ${NOTHING_WRITTEN_PHRASE}; ${humanMustLook}; ${listLine}`,
    'duplicate-session-leftover':
      `${session} holds the session name and ${PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE}: it is ${CONFLICT_LEFTOVER_PHRASE}; ${NEW_ROW_ENDED_PHRASE}; ${humanMustLook}; ${listLine}`,
    'not-this-launch': verb === 'kill'
      ? `${session} carries ${CONFLICT_OWN_ID_PHRASE} but is ${CONFLICT_NOT_THIS_LAUNCH_PHRASE}; ${NO_KILL_SENT_PHRASE}; ${humanMustLook}; ${listLine}`
      : `${session} is ${CONFLICT_NOT_THIS_LAUNCH_PHRASE}; nothing was sent; ${humanMustLook}; ${listLine}`,
    'pane-not-found': options.notAdopted === true
      ? `${session} carries ${CONFLICT_OWN_ID_PHRASE}, but ${CONFLICT_PANE_NOT_FOUND_PHRASE}: ${PANE_NOT_ADOPTED_PHRASE}; ${humanMustLook}; ${listLine}`
      : `${session} carries ${CONFLICT_OWN_ID_PHRASE}, but ${CONFLICT_PANE_NOT_FOUND_PHRASE}; ${humanMustLook}; ${listLine}`,
    'conflicting-labels': options.scan === true
      ? `the pre-spawn scan for ${session} found an agent-director label value set at the server, global or global-window scope: ${CONFLICT_CONFLICTING_LABELS_PHRASE}; ${NOTHING_WRITTEN_PHRASE}; ${humanMustLook}; ${listLine}`
      : `more than one session carries this launch's label (${session} among them): ${CONFLICT_CONFLICTING_LABELS_PHRASE}; ${humanMustLook}; ${listLine}`,
    'never-reported-in':
      `the agent in ${session} carries ${CONFLICT_OWN_ID_PHRASE} but ${CONFLICT_NEVER_REPORTED_IN_PHRASE}; ${NO_KILL_SENT_PHRASE}; ${humanMustLook}; ${listLine}`,
    'unrecognised': `${session} could not be matched to the row; ${humanMustLook}; ${listLine}`,
  }
  return phase1OnlyError(ERR_TMUX_SESSION_CONFLICT_NAME, verb, text[conflictCase])
}

/**
 * Build an ErrTmuxNotAvailable (the client's class). With `socketPath`, the
 * description names that socket as not accessible to this user; without it,
 * tmux could not be run.
 */
export function errTmuxNotAvailable(socketPath?: string, verb: string = 'spawn'): ErrTmuxNotAvailable {
  const description = socketPath === undefined
    ? 'tmux binary not available'
    : `tmux socket ${socketPath} is not accessible to this user`
  return new ErrTmuxNotAvailable(verb, 'ErrTmuxNotAvailable', description)
}

/**
 * Build an ErrTmuxNotAvailable (the client's class) whose description carries
 * "not the tmux server the agent was launched on": the server on the row's
 * recorded socket is another one (default verb `resume`; the other
 * single-row verbs that call tmux, such as `read-pane`, also return it;
 * `status` only reads the store and never does).
 */
export function errTmuxNotAvailableDifferentServer(
  socketPath: string = STUB_TMUX_SOCKET_PATH,
  verb: string = 'resume',
): ErrTmuxNotAvailable {
  return new ErrTmuxNotAvailable(
    verb,
    'ErrTmuxNotAvailable',
    `the tmux server on socket ${socketPath} is ${DIFFERENT_TMUX_SERVER_PHRASE}; nothing was done`,
  )
}

/** Build an ErrTmuxCaptureFailed (the client's class; `read-pane`: the tmux session is gone). */
export function errTmuxCaptureFailed(
  sessionName: string = STUB_TMUX_SESSION_NAME,
  verb: string = 'read-pane',
): ErrTmuxCaptureFailed {
  return new ErrTmuxCaptureFailed(
    verb,
    'ErrTmuxCaptureFailed',
    `tmux: capture-pane failed: can't find session: ${sessionName}`,
  )
}

/** Build an ErrSpawnNotPausable (the client's class; `pause` of a row that cannot be paused, e.g. `pending`). */
export function errSpawnNotPausable(verb: string = 'pause'): ErrSpawnNotPausable {
  return new ErrSpawnNotPausable(verb, 'ErrSpawnNotPausable', 'spawn not pausable in its current state')
}

/** Build an ErrSystemInstallDisappeared (the client's class; the binary is gone since construction). */
export function errSystemInstallDisappeared(
  verb: string = 'status',
  binaryPath: string = STUB_RESOLVE_DEFAULT_PATH,
): ErrSystemInstallDisappeared {
  return new ErrSystemInstallDisappeared(verb, binaryPath)
}

/**
 * Build an `ErrUnknownErrorName` the way the client does for an `err_name` it
 * has no class for: `unknownName` is the name and `envelope` is the binary's
 * `{ err_name, err_description }`. The client's own `verb` and
 * `errDescription` stay as it sets them (`''` and its "unknown err_name"
 * text); the binary's description is only in `envelope.err_description`.
 */
export function errUnknownErrorName(
  unknownName: string = 'ErrFromALaterBinary',
  description: string = 'an error this client does not know',
): ErrUnknownErrorName {
  return new ErrUnknownErrorName(unknownName, { err_name: unknownName, err_description: description })
}

/**
 * Build an `ErrSchemaMismatch`, which has no class in any client: an
 * `ErrUnknownErrorName` whose `unknownName` is `ErrSchemaMismatch` and whose
 * envelope carries `description`, by default that the store could not be
 * opened. `ErrSchemaMigrationRequired` and `ErrStoreOpen` are built with
 * `errUnknownErrorName`.
 */
export function errSchemaMismatch(
  description: string = 'the store could not be opened: its schema does not match this binary; nothing was done',
): ErrUnknownErrorName {
  return errUnknownErrorName(ERR_SCHEMA_MISMATCH_NAME, description)
}

/**
 * Build an `ErrInternal`, which has no class in any client: an
 * `ErrUnknownErrorName` whose `unknownName` is `ErrInternal` and whose
 * envelope carries `description`.
 */
export function errInternal(description: string = 'the store could not be read'): ErrUnknownErrorName {
  return errUnknownErrorName('ErrInternal', description)
}

/**
 * One UNAVAILABLE form (b.jg5 SRJ-104): its label, its builder for the verb
 * whose call meets it, and the retry cause kind it arms. A tuple, so a
 * `test.each` over it names its cases by the label.
 */
export type UnavailableForm = readonly [label: string, make: (verb: string) => Error, causeKind: string]

/**
 * Every UNAVAILABLE form, each built by name: `ErrTmuxUnresponsive` and its
 * three variants CSCB tells apart, `ErrCallTimeout`, an unknown error name
 * from a later binary, CSCB's `UnknownError` wrapper, `ErrTmuxKillFailed`
 * (the kill-failure cause; only a kill answers it) and a plain `Error` (not
 * an agent-director error). Pick a file's subset with `unavailableForms`.
 */
export const UNAVAILABLE_FORMS: readonly UnavailableForm[] = [
  ['ErrTmuxUnresponsive', (verb) => errTmuxUnresponsive(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrTmuxUnresponsive, still stopping', (verb) => errTmuxUnresponsiveStillStopping(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrTmuxUnresponsive, still starting', (verb) => errTmuxUnresponsiveStillStarting(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrTmuxUnresponsive, launch timeout', (verb) => errTmuxUnresponsiveLaunchTimeout(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrCallTimeout', (verb) => errCallTimeout(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrUnknownErrorName', () => errUnknownErrorName(), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['a wrapped UnknownError', (verb) => errGeneric(verb, CSCB_UNKNOWN_ERROR_NAME, 'Error: boom'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrTmuxKillFailed', () => errTmuxKillFailed(), UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
  ['a plain Error', () => new Error('boom'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
]

/**
 * The `UNAVAILABLE_FORMS` rows `picks` names, in that order: a label picks its
 * row as is, and a `[label, as]` pair picks it relabelled `as`. Throws for a
 * label the table does not have.
 */
export function unavailableForms(...picks: ReadonlyArray<string | readonly [label: string, as: string]>): UnavailableForm[] {
  return picks.map((pick) => {
    const [label, as] = typeof pick === 'string' ? [pick, pick] : pick
    const form = UNAVAILABLE_FORMS.find(([l]) => l === label)
    if (form === undefined) throw new Error(`unavailableForms: no UNAVAILABLE form labelled ${JSON.stringify(label)}`)
    return [as, form[1], form[2]] as const
  })
}

/**
 * The three recorded-name faults of ADSRD SR-1.4 (an empty name, a control
 * character, a character tmux stores differently).
 */
export type UnusableNameFault = 'empty' | 'control-character' | 'stored-differently'

/** Every `UnusableNameFault`, for `test.each`. */
export const UNUSABLE_NAME_FAULTS: readonly UnusableNameFault[] = ['empty', 'control-character', 'stored-differently']

/**
 * Build the unusable-recorded-name `ErrInternal` (an `ErrUnknownErrorName`
 * whose `unknownName` is `ErrInternal`) for `fault`; each description
 * carries "the recorded tmux session name".
 */
export function errUnusableName(fault: UnusableNameFault = 'empty'): ErrUnknownErrorName {
  const text: Record<UnusableNameFault, string> = {
    'empty': `${UNUSABLE_RECORDED_NAME_PHRASE} is empty`,
    'control-character': `${UNUSABLE_RECORDED_NAME_PHRASE} contains a control character`,
    'stored-differently': `${UNUSABLE_RECORDED_NAME_PHRASE} contains a character tmux stores differently`,
  }
  return errInternal(`${text[fault]}; nothing was done`)
}

/**
 * Build an `ErrConfigMalformed`, which has no class in any client: an
 * `ErrUnknownErrorName` whose `unknownName` is `ErrConfigMalformed` and whose
 * envelope description names a `[tmux]` key, its value and its safe minimum
 * in agent-director's form: `config <path>: refused [tmux] values: [tmux]
 * <key> = <value>, below its safe minimum <minimum> <unit>. A missing key, or
 * 0, gives the default.` The default is `starting_session_seconds` = 30 below
 * its safe minimum 60 s; `unit` is agent-director's symbol, `s` (seconds) or
 * `ms` (milliseconds).
 */
export function errConfigMalformed(
  key: string = 'starting_session_seconds',
  value: string = '30',
  minimum: string = '60',
  unit: string = 's',
): ErrUnknownErrorName {
  return errUnknownErrorName(
    'ErrConfigMalformed',
    `config ${STUB_AD_CONFIG_PATH}: refused [tmux] values: [tmux] ${key} = ${value}, below its safe minimum ${minimum} ${unit}. A missing key, or 0, gives the default.`,
  )
}

// ---------------------------------------------------------------------------
// ListRow + GetResult builders
// ---------------------------------------------------------------------------

/**
 * The persona fields a persona-form row is derived from. A resolved `Persona`
 * (e.g. `makePersonaConfig({}, dir).personas[0]`) satisfies it.
 */
export type CannedRowPersona = Pick<Persona, 'key' | 'working_directory' | 'claude_config_dir'>

/**
 * The fields a spawn of `persona` writes (b.av2 SR-2.2): `cwd` = the working
 * directory, instance ID `cscb_<key>`, tmux session `slack_bot_<key>`, and the
 * labels `service=cscb`, `persona=<key>` and `config_dir=<value>` (no
 * `channel` label). The `config_dir` value comes from the production helper
 * `personaConfigDirLabelValue` (the strict real path, no lexical fallback;
 * bug b.g57) against the caller's `home`, never the OS home. A
 * claude_config_dir that cannot be resolved (a symlink on its path pointing
 * to nothing, a dropped mount) makes that helper throw
 * `ConfigDirUnresolvableError`, so the persona forms of `cannedListRow` and
 * `cannedGetResult` throw it too, even when the overrides replace `labels`:
 * build such a row while the directory resolves, or use the no-persona form.
 * No I/O beyond that helper's realpath; nothing is created or written.
 */
function personaRowDefaults(persona: CannedRowPersona, home: string): {
  cwd: string
  claude_instance_id: string
  tmux_session_name: string
  labels: Record<string, string>
} {
  const configDir = personaConfigDirLabelValue(persona.claude_config_dir, home)
  return {
    cwd: persona.working_directory,
    claude_instance_id: personaInstanceId(persona.key),
    tmux_session_name: personaTmuxSessionName(persona.key),
    labels: { service: 'cscb', persona: persona.key, config_dir: configDir },
  }
}

/**
 * The `cwd` a row built without a persona argument defaults to: the working
 * directory of the default persona fixture (`makePersona()` from
 * `persona-config.ts`, i.e. `<tmpdir>/personas/test_bot/work`). Computed per
 * call because `tmpdir()` follows `TMPDIR`; nothing creates the directory.
 */
export function defaultCannedRowCwd(): string {
  return makePersona().working_directory
}

/**
 * The persona key a row built without a persona argument stands for: its
 * instance ID without the `cscb_` prefix (the ID itself when it lacks it).
 */
function defaultRowPersonaKey(claudeInstanceId: string): string {
  return claudeInstanceId.startsWith(PERSONA_INSTANCE_ID_PREFIX)
    ? claudeInstanceId.slice(PERSONA_INSTANCE_ID_PREFIX.length)
    : claudeInstanceId
}

/**
 * Defaults for a row built without a persona argument (b.av2 SR-13.4): labels
 * exactly `service=cscb` and `persona=<key>` (no `config_dir`, no `channel`),
 * tmux session `slack_bot_<key>`, and `cwd` `defaultCannedRowCwd()`.
 */
function defaultRowFields(claudeInstanceId: string): {
  cwd: string
  tmux_session_name: string
  labels: Record<string, string>
} {
  const key = defaultRowPersonaKey(claudeInstanceId)
  return {
    cwd: defaultCannedRowCwd(),
    tmux_session_name: personaTmuxSessionName(key),
    labels: { service: 'cscb', persona: key },
  }
}

/**
 * Build a canned ListRow with persona defaults. Override fields as needed.
 *
 * Without `persona`, `claude_instance_id` is required and the row stands for
 * the persona whose key is that ID without its `cscb_` prefix: labels exactly
 * `service=cscb` and `persona=<key>`, tmux `slack_bot_<key>`, and `cwd`
 * `defaultCannedRowCwd()` (the default persona fixture's working directory).
 * With `persona` the defaults are what a spawn of that persona writes (see
 * `personaRowDefaults`), `claude_instance_id` defaults to `cscb_<key>`, and
 * `home` (required) is the home directory the `config_dir` label is computed
 * against. Explicit overrides always win, so a negative case can replace
 * `cwd` or `labels` (e.g. drop `persona` or `config_dir`, or carry only an
 * old `channel` label).
 *
 * The Phase 1 fields are overrides too: `launch_started_at` (see
 * `SAMPLE_LAUNCH_STARTS`) and `liveness_note` (`provenanceNote`,
 * `nonLatchingNotes`). Neither is set by default, and either given as
 * `undefined` is left out of the row.
 */
export function cannedListRow(overrides: Partial<Phase1ListRow> & { claude_instance_id: string }): Phase1ListRow
export function cannedListRow(overrides: Partial<Phase1ListRow>, persona: CannedRowPersona, home: string): Phase1ListRow
export function cannedListRow(overrides: Partial<Phase1ListRow>, persona?: CannedRowPersona, home?: string): Phase1ListRow {
  if (persona) {
    if (home === undefined) throw new Error('cannedListRow: the persona form needs a home')
    return omitUndefined({
      parent_id: undefined,
      state: 'waiting',
      relay_mode: 'on',
      started_at: '2026-05-24T12:00:00Z',
      last_seen_at: '2026-05-24T12:00:00Z',
      ended_at: null,
      ...personaRowDefaults(persona, home),
      ...overrides,
    }, PHASE1_ROW_FIELDS)
  }
  return omitUndefined({
    parent_id: undefined,
    state: 'waiting',
    relay_mode: 'on',
    ...defaultRowFields(overrides.claude_instance_id as string),
    started_at: '2026-05-24T12:00:00Z',
    last_seen_at: '2026-05-24T12:00:00Z',
    ended_at: null,
    ...overrides,
  } as Phase1ListRow, PHASE1_ROW_FIELDS)
}

/**
 * Build a canned `PermissionRequestRow` for the plural-projection wire. The
 * default `request_token` is a fresh UUIDv4 (via `crypto.randomUUID()`) so
 * the encoded action_id round-trips through the SR-2.2 anchored regex. CSCB
 * test infrastructure mints opaque tokens; production CSCB code never does.
 */
export function cannedPermissionRequest(
  overrides: Partial<PermissionRequestRow> = {},
): PermissionRequestRow {
  return {
    request_token: crypto.randomUUID(),
    request_id: 1,
    tool_name: 'Bash',
    tool_input: JSON.stringify({ command: 'ls /tmp' }),
    requested_at: '2026-05-24T12:00:00Z',
    ...overrides,
  }
}

/**
 * Overrides accepted by `cannedGetResult` / `cannedGetResultPlural`. The
 * plural `permission_requests` field is not on the published agent-director
 * `GetResult`; the paired AD release replaces the legacy singular field
 * with the plural array, and CSCB consumes the new shape via a structural
 * cast inside the poller.
 */
export type GetResultOverrides =
  & Partial<Phase1GetResult>
  & { claude_instance_id: string }
  & { permission_requests?: PermissionRequestRow[] | null }

/** `GetResultOverrides` for the persona form, where `claude_instance_id` defaults to `cscb_<key>`. */
export type PersonaGetResultOverrides =
  & Partial<Phase1GetResult>
  & { permission_requests?: PermissionRequestRow[] | null }

/**
 * `cannedGetResult` may carry a `permission_requests` field for check_permission
 * rows. Production code (`permission-poller.ts`,
 * `permission-click-handler.ts`) casts `GetResult` to
 * `GetResultWithPermissionRequests` at the use site, so the extra field
 * flows through without polluting the upstream type.
 */
export type CannedGetResult = Phase1GetResult & { permission_requests?: PermissionRequestRow[] | null }

/**
 * Build a canned `GetResult`. Pass `permission_requests` for check_permission
 * rows under the new plural-projection wire. For the negative-test cases
 * (poller skips when the plural field is absent), pass `null` or omit.
 *
 * The `cwd`, tmux name and label defaults match `cannedListRow`. Without
 * `persona`, `claude_instance_id` is required and the row stands for the
 * persona whose key is that ID without its `cscb_` prefix: labels exactly
 * `service=cscb` and `persona=<key>`, tmux `slack_bot_<key>`, `cwd`
 * `defaultCannedRowCwd()`. With `persona` they default to what a spawn of
 * that persona writes: `cwd` = working directory, `cscb_<key>`,
 * `slack_bot_<key>`, and `service=cscb`, `persona=<key>`,
 * `config_dir=<personaConfigDirLabelValue>`; `home` (required) is the home
 * directory the `config_dir` label is computed against. Explicit overrides
 * always win. The stub client's default `get` row uses the no-persona form.
 *
 * The Phase 1 fields `launch_started_at` and `liveness_note` are overrides
 * as on `cannedListRow`: unset by default, and left out when given as
 * `undefined`.
 */
export function cannedGetResult(overrides: GetResultOverrides): CannedGetResult
export function cannedGetResult(
  overrides: PersonaGetResultOverrides,
  persona: CannedRowPersona,
  home: string,
): CannedGetResult
export function cannedGetResult(
  overrides: PersonaGetResultOverrides,
  persona?: CannedRowPersona,
  home?: string,
): CannedGetResult {
  if (persona) {
    if (home === undefined) throw new Error('cannedGetResult: the persona form needs a home')
    return omitUndefined({
      parent_id: '',
      state: 'waiting',
      claude_args: [],
      relay_mode: 'on',
      jsonl_path: '',
      claude_session_id: '',
      started_at: '2026-05-24T12:00:00Z',
      last_seen_at: '2026-05-24T12:00:00Z',
      ended_at: null,
      ...personaRowDefaults(persona, home),
      ...overrides,
    }, PHASE1_ROW_FIELDS)
  }
  return omitUndefined({
    parent_id: '',
    state: 'waiting',
    claude_args: [],
    relay_mode: 'on',
    jsonl_path: '',
    claude_session_id: '',
    ...defaultRowFields((overrides as GetResultOverrides).claude_instance_id),
    started_at: '2026-05-24T12:00:00Z',
    last_seen_at: '2026-05-24T12:00:00Z',
    ended_at: null,
    ...overrides,
  } as CannedGetResult, PHASE1_ROW_FIELDS)
}

/**
 * Build a canned `GetResult` carrying a non-empty `permission_requests`
 * array — the typical positive-test shape for poller / click-handler tests
 * under the new wire. `persona` and `home` pass through to `cannedGetResult`.
 */
export function cannedGetResultPlural(
  overrides: GetResultOverrides & { permission_requests: PermissionRequestRow[] },
): CannedGetResult
export function cannedGetResultPlural(
  overrides: PersonaGetResultOverrides & { permission_requests: PermissionRequestRow[] },
  persona: CannedRowPersona,
  home: string,
): CannedGetResult
export function cannedGetResultPlural(
  overrides: PersonaGetResultOverrides & { permission_requests: PermissionRequestRow[] },
  persona?: CannedRowPersona,
  home?: string,
): CannedGetResult {
  if (!persona) return cannedGetResult(overrides as GetResultOverrides)
  if (home === undefined) throw new Error('cannedGetResultPlural: the persona form needs a home')
  return cannedGetResult(overrides, persona, home)
}

/**
 * Build a canned plural projection with TWO open `permission_requests`
 * rows on the same spawn — the Epic-1 acceptance fixture for
 * "two concurrent prompts on one spawn each get their own Slack message
 * keyed on the composite (claude_instance_id, request_token)".
 *
 * Both rows share `claude_instance_id` and differ on `request_token`,
 * `request_id`, and `tool_name` so the test can identify them.
 */
export function cannedTwoRowPluralProjection(
  claudeInstanceId: string,
  overrides: Omit<GetResultOverrides, 'claude_instance_id' | 'permission_requests'> = {},
): CannedGetResult {
  return cannedGetResult({
    claude_instance_id: claudeInstanceId,
    state: 'check_permission',
    ...overrides,
    permission_requests: [
      cannedPermissionRequest({ request_id: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command: 'ls /tmp' }) }),
      cannedPermissionRequest({ request_id: 2, tool_name: 'Edit', tool_input: JSON.stringify({ file_path: '/etc/hosts' }) }),
    ],
  })
}

/**
 * Build a canned `GetPermissionResult` — the single-row response shape from
 * the paired AD release's `get-permission --request-token <uuid>` verb
 * (SR-7.1). Defaults to the operator-allow shape (`decision='allow'`,
 * `decision_reason=null`); tests override `decision` + `decision_reason` to
 * exercise the four verdict-rendering branches (SR-5.1) plus the unknown-enum
 * fail-closed path (SR-5.2).
 */
export function cannedGetPermissionResponse(
  overrides: Partial<GetPermissionResult> = {},
): GetPermissionResult {
  return {
    request_token: crypto.randomUUID(),
    request_id: 1,
    tool_name: 'Bash',
    tool_input: JSON.stringify({ command: 'ls /tmp' }),
    requested_at: '2026-05-24T12:00:00Z',
    decision: 'allow',
    decision_reason: null,
    decided_at: '2026-05-24T12:00:05Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Stub Client
// ---------------------------------------------------------------------------

/**
 * A canned response for a verb: either a `Result` to resolve with or an
 * `Error` to reject with. Tests pass an array of these to drive sequential
 * call behavior — `spawn` returns the first, then the second, etc.
 */
export type CannedResponse<T> =
  | { kind: 'resolve'; value: T }
  | { kind: 'reject'; error: Error }

export const cannedOk = <T>(value: T): CannedResponse<T> => ({ kind: 'resolve', value })
export const cannedErr = <T>(error: Error): CannedResponse<T> => ({ kind: 'reject', error })

/**
 * Injection points for `makeStubClient`. Each verb has two knobs:
 *
 *   - `<verb>Result` / `<verb>Error`: single canned response, returned for
 *     every call.
 *   - `<verb>Queue`: an array of `CannedResponse<>` — the stub shifts the
 *     next response off the front on each call, so N entries answer the
 *     next N calls in order. While the queue holds an entry it wins; once it
 *     is empty (dry) the verb falls through to `<verb>Error`, then
 *     `<verb>Result`, then the verb's default response.
 *
 * Verbs with a queue: `spawn`, `status`, `get`, `sendKeys`, `readPane`,
 * `kill`, `decide`, `resume`, `findMissing`, `list`, `getPermission`.
 * `statusFn` and `getFn` compute a response per call and take precedence
 * over every other knob of their verb.
 *
 * Plus capture arrays — `<verb>Calls` — for assertion against call shape.
 */
export interface StubClientOptions {
  // Client surface getters added in AD 0.7.0
  binaryPath?: string
  /**
   * The binary version the stub reports (default: `PHASE1_RC_VERSION`, which
   * passes CSCB's Phase 1 floor; b.jg5 SRJ-1303).
   */
  binaryVersion?: string

  // version()
  versionResult?: VersionResult
  versionError?: Error
  versionCalls?: VersionParams[]

  // makeTemplate()
  makeTemplateResult?: MakeTemplateResult
  makeTemplateError?: Error
  makeTemplateCalls?: MakeTemplateParams[]

  // spawn() — a result may carry the Phase 1 `pre_trust` (`cannedSpawnResult`).
  spawnResult?: Phase1SpawnResult
  spawnError?: Error
  spawnQueue?: CannedResponse<Phase1SpawnResult>[]
  spawnCalls?: SpawnParams[]

  // status() — a result may carry the Phase 1 `launch_started_at`
  // (`cannedStatusResult`).
  statusResult?: Phase1StatusResult
  statusError?: Error
  statusQueue?: CannedResponse<Phase1StatusResult>[]
  statusCalls?: StatusParams[]
  /**
   * Dynamic status seam (b.m4r). When supplied, takes precedence over
   * `statusResult`/`statusQueue`/`statusError` and computes the result from the
   * current call params — lets a test model an AD row whose state depends on
   * whether an earlier verb (e.g. the up-front `findMissing` reconcile sweep)
   * has run. Returning an `Error` rejects; returning a `StatusResult` resolves.
   */
  statusFn?: (params: StatusParams) => Phase1StatusResult | Error

  // get() — a row may carry the Phase 1 `launch_started_at` and
  // `liveness_note` (`cannedGetResult`).
  getResult?: Phase1GetResult
  getError?: Error
  getQueue?: CannedResponse<Phase1GetResult>[]
  getCalls?: GetParams[]
  /**
   * Computed `get` row, like `statusFn`: when supplied, takes precedence over
   * `getQueue`/`getError`/`getResult` and computes the row from the current
   * call params. Returning an `Error` rejects; returning a row resolves.
   * The call is still recorded in `getCalls`.
   */
  getFn?: (params: GetParams) => Phase1GetResult | Error

  // sendKeys()
  sendKeysResult?: SendKeysResult
  sendKeysError?: Error
  sendKeysQueue?: CannedResponse<SendKeysResult>[]
  sendKeysCalls?: SendKeysParams[]

  // readPane() — `readPaneResults` is a FIFO sequence of canned panes whose
  // last entry sticks once consumed; `readPaneError` rejects every call and
  // wins over `readPaneResults`.
  readPaneResults?: ReadPaneResult[]
  readPaneError?: Error
  readPaneCalls?: ReadPaneParams[]
  /**
   * Panes or errors in order, one per call (`cannedOk({ pane })` /
   * `cannedErr(err)`). While it holds an entry it wins over `readPaneError`
   * and `readPaneResults`. Once dry, the call falls through to
   * `readPaneError`, then `readPaneResults`, then the empty pane
   * (`{ pane: '' }`); unlike `readPaneResults`, its last entry does not stick.
   */
  readPaneQueue?: CannedResponse<ReadPaneResult>[]

  // kill() — a result may carry the Phase 1 `kill_sent` (`cannedKillResult`).
  // Default: `{}` (no `kill_sent`, as from a binary older than Phase 1).
  killResult?: Phase1KillResult
  killError?: Error
  killQueue?: CannedResponse<Phase1KillResult>[]
  killCalls?: KillParams[]

  // decide()
  decideResult?: DecideResult
  decideError?: Error
  decideQueue?: CannedResponse<DecideResult>[]
  decideCalls?: DecideParams[]

  // resume() — a result may carry the Phase 1 `pre_trust` (`cannedResumeResult`).
  resumeResult?: Phase1ResumeResult
  resumeError?: Error
  resumeQueue?: CannedResponse<Phase1ResumeResult>[]
  resumeCalls?: ResumeParams[]

  // findMissing() — b.4dk: dead-session recovery runs one findMissing before
  // resume so AD transitions the dead live-state row to `missing`. Defaults to
  // the 0.8.0 zero-transition shape.
  findMissingResult?: FindMissingResult
  findMissingError?: Error
  findMissingQueue?: CannedResponse<FindMissingResult>[]
  findMissingCalls?: FindMissingParams[]

  // delete()
  deleteResult?: DeleteResult
  deleteError?: Error
  deleteCalls?: DeleteParams[]

  // list() — rows may carry the Phase 1 fields (`cannedListRow`).
  listResult?: Phase1ListResult
  listError?: Error
  listQueue?: CannedResponse<Phase1ListResult>[]
  listCalls?: ListParams[]

  // pause()
  pauseResult?: PauseResult
  pauseError?: Error
  pauseCalls?: PauseParams[]

  // getPermission() — paired-AD-release verb wrapping `get-permission
  // --request-token <uuid>` (SR-7.1). The published `agent-director` Client
  // doesn't ship this yet, so it lives on the stub via the optional
  // structural-method surface PollerDeps#getClient already exposes.
  getPermissionResult?: GetPermissionResult
  getPermissionError?: Error
  getPermissionQueue?: CannedResponse<GetPermissionResult>[]
  getPermissionCalls?: GetPermissionParams[]

  /**
   * Ordered verb-name log. When supplied, the instrumented verbs — `findMissing`,
   * `status`, and `resume` — push their name before returning, letting a test
   * assert their relative ordering (b.4dk: findMissing must precede resume;
   * b.m4r: the up-front findMissing sweep must precede the first status poll).
   * Other verbs are not instrumented.
   */
  callLog?: string[]
}

/** Structural-typed `Client` stub satisfying every verb CSCB uses. */
export type StubClient = {
  readonly binaryPath: string
  readonly binaryVersion: string
  version(params: VersionParams): Promise<VersionResult>
  makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult>
  spawn(params: SpawnParams): Promise<Phase1SpawnResult>
  status(params: StatusParams): Promise<Phase1StatusResult>
  get(params: GetParams): Promise<Phase1GetResult>
  sendKeys(params: SendKeysParams): Promise<SendKeysResult>
  readPane(params: ReadPaneParams): Promise<ReadPaneResult>
  kill(params: KillParams): Promise<Phase1KillResult>
  decide(params: DecideParams): Promise<DecideResult>
  resume(params: ResumeParams): Promise<Phase1ResumeResult>
  findMissing(params: FindMissingParams): Promise<FindMissingResult>
  delete(params: DeleteParams): Promise<DeleteResult>
  list(params: ListParams): Promise<Phase1ListResult>
  pause(params: PauseParams): Promise<PauseResult>
  /**
   * Paired-AD-release `get-permission` verb (SR-7.1). Optional on the
   * structural type so existing tests that don't configure it still satisfy
   * the `PollerDeps#getClient` shape (where `getPermission` is also optional).
   */
  getPermission(params: GetPermissionParams): Promise<GetPermissionResult>
  close(): void
  [Symbol.dispose](): void
}

/** Resolve the next response: queue first (mutating), then result/error, else throw. */
function nextResponse<T>(
  verb: string,
  queue: CannedResponse<T>[] | undefined,
  result: T | undefined,
  error: Error | undefined,
  defaultValue?: T,
): T {
  if (queue && queue.length > 0) {
    const item = queue.shift()!
    if (item.kind === 'reject') throw item.error
    return item.value
  }
  if (error) throw error
  if (result !== undefined) return result
  if (defaultValue !== undefined) return defaultValue
  throw new Error(`agent-director-stub: '${verb}' called but no canned response configured`)
}

/** Build a stub Client driven by the supplied knobs. */
export function makeStubClient(opts: StubClientOptions = {}): StubClient {
  return {
    get binaryPath(): string {
      return opts.binaryPath ?? '/usr/local/bin/agent-director'
    },
    get binaryVersion(): string {
      return opts.binaryVersion ?? PHASE1_RC_VERSION
    },
    async version(params: VersionParams): Promise<VersionResult> {
      opts.versionCalls?.push(params)
      if (opts.versionError) throw opts.versionError
      return opts.versionResult ?? cannedVersion('v0.4.3')
    },
    async makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult> {
      opts.makeTemplateCalls?.push(params)
      if (opts.makeTemplateError) throw opts.makeTemplateError
      return (
        opts.makeTemplateResult ?? cannedMakeTemplate(`~/.agent-director/templates/${params.name}.toml`)
      )
    },
    async spawn(params: SpawnParams): Promise<Phase1SpawnResult> {
      opts.spawnCalls?.push(params)
      return nextResponse('spawn', opts.spawnQueue, opts.spawnResult, opts.spawnError, {
        claude_instance_id: params.claude_instance_id ?? 'cscb_test',
      })
    },
    async status(params: StatusParams): Promise<Phase1StatusResult> {
      opts.callLog?.push('status')
      opts.statusCalls?.push(params)
      if (opts.statusFn) {
        const r = opts.statusFn(params)
        if (r instanceof Error) throw r
        return r
      }
      return nextResponse('status', opts.statusQueue, opts.statusResult, opts.statusError, { state: 'waiting' })
    },
    async get(params: GetParams): Promise<Phase1GetResult> {
      opts.getCalls?.push(params)
      if (opts.getFn) {
        const r = opts.getFn(params)
        if (r instanceof Error) throw r
        return r
      }
      return nextResponse('get', opts.getQueue, opts.getResult, opts.getError, cannedGetResult({
        claude_instance_id: params.claude_instance_id,
      }))
    },
    async sendKeys(params: SendKeysParams): Promise<SendKeysResult> {
      opts.sendKeysCalls?.push(params)
      return nextResponse('send-keys', opts.sendKeysQueue, opts.sendKeysResult, opts.sendKeysError, {})
    },
    async readPane(params: ReadPaneParams): Promise<ReadPaneResult> {
      opts.readPaneCalls?.push(params)
      const queued = opts.readPaneQueue?.shift()
      if (queued) {
        if (queued.kind === 'reject') throw queued.error
        return queued.value
      }
      if (opts.readPaneError) throw opts.readPaneError
      const seq = opts.readPaneResults
      if (seq && seq.length > 0) {
        // FIFO; the last remaining entry sticks (do not pop the tail).
        return seq.length === 1 ? seq[0] : seq.shift()!
      }
      return { pane: '' }
    },
    async kill(params: KillParams): Promise<Phase1KillResult> {
      opts.killCalls?.push(params)
      return nextResponse('kill', opts.killQueue, opts.killResult, opts.killError, {})
    },
    async decide(params: DecideParams): Promise<DecideResult> {
      opts.decideCalls?.push(params)
      return nextResponse('decide', opts.decideQueue, opts.decideResult, opts.decideError, {})
    },
    async resume(params: ResumeParams): Promise<Phase1ResumeResult> {
      opts.callLog?.push('resume')
      opts.resumeCalls?.push(params)
      return nextResponse('resume', opts.resumeQueue, opts.resumeResult, opts.resumeError, {
        claude_instance_id: params.claude_instance_id,
      })
    },
    async findMissing(params: FindMissingParams): Promise<FindMissingResult> {
      opts.callLog?.push('findMissing')
      opts.findMissingCalls?.push(params)
      return nextResponse(
        'find-missing',
        opts.findMissingQueue,
        opts.findMissingResult,
        opts.findMissingError,
        cannedFindMissing(),
      )
    },
    async delete(params: DeleteParams): Promise<DeleteResult> {
      opts.deleteCalls?.push(params)
      if (opts.deleteError) throw opts.deleteError
      return opts.deleteResult ?? { results: Object.fromEntries(params.claude_instance_id.map((id) => [id, 'ok'])) }
    },
    async list(params: ListParams): Promise<Phase1ListResult> {
      opts.listCalls?.push(params)
      return nextResponse('list', opts.listQueue, opts.listResult, opts.listError, { spawns: [] })
    },
    async pause(params: PauseParams): Promise<PauseResult> {
      opts.pauseCalls?.push(params)
      if (opts.pauseError) throw opts.pauseError
      return opts.pauseResult ?? {}
    },
    async getPermission(params: GetPermissionParams): Promise<GetPermissionResult> {
      opts.getPermissionCalls?.push(params)
      return nextResponse(
        'get-permission',
        opts.getPermissionQueue,
        opts.getPermissionResult,
        opts.getPermissionError,
        cannedGetPermissionResponse({ request_token: params.request_token }),
      )
    },
    close(): void { /* no-op */ },
    [Symbol.dispose](): void { /* no-op */ },
  }
}

// ---------------------------------------------------------------------------
// Held spawns — keep a launch in flight until the test settles it
// ---------------------------------------------------------------------------

/** Handle returned by `holdSpawns`. */
export interface SpawnHold {
  /** Every `spawn` the stub received, held or not, in call order. */
  calls: SpawnParams[]
  /** Instance IDs of the spawns still held open, oldest first. */
  held(): string[]
  /** Resolves once a spawn for `id` has been issued (at once if one already was). */
  entered(id: string): Promise<void>
  /** Resolve the oldest held spawn for `id` with `{ claude_instance_id: id }`. */
  release(id: string): void
  /** Reject the oldest held spawn for `id` with `err`. */
  fail(id: string, err: Error): void
  /** Resolve every held spawn (teardown). */
  releaseAll(): void
}

/**
 * Replace `stub.spawn` so each spawn whose instance ID satisfies `shouldHold`
 * (every spawn by default) stays open until the test releases or fails it;
 * any other spawn goes to the stub's original `spawn`. Lets a test keep one
 * persona's launch in flight while it drives a second call.
 */
export function holdSpawns(stub: StubClient, shouldHold: (id: string) => boolean = () => true): SpawnHold {
  const calls: SpawnParams[] = []
  const held: Array<{ id: string; resolve: (r: SpawnResult) => void; reject: (err: Error) => void }> = []
  const entries = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  const entry = (id: string) => {
    let e = entries.get(id)
    if (!e) {
      let resolve!: () => void
      const promise = new Promise<void>((res) => { resolve = res })
      e = { promise, resolve }
      entries.set(id, e)
    }
    return e
  }
  const take = (id: string) => {
    const i = held.findIndex((h) => h.id === id)
    if (i < 0) throw new Error(`holdSpawns: no held spawn for ${id}`)
    return held.splice(i, 1)[0]!
  }
  const original = stub.spawn.bind(stub)
  stub.spawn = (params: SpawnParams): Promise<SpawnResult> => {
    calls.push(params)
    const id = String(params.claude_instance_id)
    entry(id).resolve()
    if (!shouldHold(id)) return original(params)
    return new Promise<SpawnResult>((resolve, reject) => { held.push({ id, resolve, reject }) })
  }
  return {
    calls,
    held: () => held.map((h) => h.id),
    entered: (id) => entry(id).promise,
    release: (id) => take(id).resolve({ claude_instance_id: id }),
    fail: (id, err) => take(id).reject(err),
    releaseAll: () => {
      for (const h of held.splice(0)) h.resolve({ claude_instance_id: h.id })
    },
  }
}

// ---------------------------------------------------------------------------
// Call log and the stubbed persona launch path
// ---------------------------------------------------------------------------

/** Every per-verb capture list `makeStubClient` fills, all present. */
export type StubCallLog = Required<
  Pick<
    StubClientOptions,
    | 'versionCalls'
    | 'makeTemplateCalls'
    | 'spawnCalls'
    | 'statusCalls'
    | 'getCalls'
    | 'sendKeysCalls'
    | 'readPaneCalls'
    | 'killCalls'
    | 'decideCalls'
    | 'resumeCalls'
    | 'findMissingCalls'
    | 'deleteCalls'
    | 'listCalls'
    | 'pauseCalls'
    | 'getPermissionCalls'
  >
>

/** An empty capture list for every verb; pass it to `makeStubClient`. */
export function makeStubCallLog(): StubCallLog {
  return {
    versionCalls: [], makeTemplateCalls: [], spawnCalls: [], statusCalls: [], getCalls: [], sendKeysCalls: [],
    readPaneCalls: [], killCalls: [], decideCalls: [], resumeCalls: [], findMissingCalls: [], deleteCalls: [],
    listCalls: [], pauseCalls: [], getPermissionCalls: [],
  }
}

/** How many verb calls `log` recorded, over every verb. */
export function stubCallCount(log: StubCallLog): number {
  return Object.values(log).reduce((sum: number, calls: unknown[]) => sum + calls.length, 0)
}

/** The stub client `installStubSpawnPath` installed, and what it recorded. */
export interface StubSpawnPath {
  /** Every call the stub client received, by verb. */
  readonly calls: StubCallLog
  /** The installed client; a test may wrap its verbs (e.g. `spawn`). */
  readonly client: StubClient
  /** How many verb calls were recorded, over every verb. */
  callCount(): number
  /** The instance IDs spawned, in call order. */
  spawnedIds(): string[]
}

/**
 * Route the real persona launch path (`spawnForPersona`) to a fresh stub
 * client with an empty call log: the client is installed as the process's
 * agent-director client, the dialog poll runs at 1 ms with a 200 ms ready
 * bound, tmux reads an empty pane, sends nothing and reports every session
 * alive, and the spawn home is `homeDir` (its `.claude` directory is
 * created). `homeDir` must be under the test's `mkdtempSync` directory.
 * Undo everything with `resetStubSpawnPath` in `afterEach`.
 */
export function installStubSpawnPath(homeDir: string): StubSpawnPath {
  const calls = makeStubCallLog()
  const client = makeStubClient(calls)
  setClientForTests(client as unknown as Parameters<typeof setClientForTests>[0])
  _setDialogPollIntervalMs(1)
  _setDialogReadyTimeoutMs(200)
  _setTmuxCapturePane(async () => '')
  _setTmuxSendEnter(async () => {})
  _setTmuxSessionProber(async () => true)
  mkdirSync(join(homeDir, '.claude'), { recursive: true })
  _setSpawnHomeDir(homeDir)
  return {
    calls,
    client,
    callCount: () => stubCallCount(calls),
    spawnedIds: () => calls.spawnCalls.map((params) => String(params.claude_instance_id)),
  }
}

/** Undo `installStubSpawnPath`, and forget any launch still marked in flight. */
export function resetStubSpawnPath(): void {
  resetClientForTests()
  _resetDialogPollIntervalMs()
  _resetDialogReadyTimeoutMs()
  _resetTmuxDialogHelpers()
  _resetTmuxSessionProber()
  _resetSpawnHomeDir()
  _resetInFlightLaunches()
}

// ---------------------------------------------------------------------------
// Stub Client.create / resolveSystemBinary factories (AD 0.7.0 startup surface)
// ---------------------------------------------------------------------------

/**
 * Options for makeStubCreateClient. Mirrors the existing canned-result /
 * canned-error pattern.
 */
export interface StubCreateClientOptions {
  /** Reject the call with this error. Takes precedence over `client`. */
  error?: Error
  /** Resolve with this pre-built stub Client. If omitted, a default stub is created. */
  client?: StubClient
  /**
   * Capture the options each client is built with, one entry per call, in
   * call order (the error path included), typed as the client's
   * `ClientOptions` so a test reads e.g. `calls[0].callTimeoutMs` (b.jg5
   * SRJ-213); a field the caller did not pass is absent.
   */
  calls?: ClientOptions[]
}

/**
 * Build a stub `Client.create`-shaped factory function. Returns a function
 * of shape `(opts: object) => Promise<StubClient>` that records `opts` in
 * `calls`, then either resolves with the supplied stub or rejects with the
 * supplied error. Drives the startup gate's catch ladder (Task 5 / a9) for
 * the three new typed errors.
 */
export function makeStubCreateClient(opts: StubCreateClientOptions = {}): (clientOpts: object) => Promise<StubClient> {
  return async (clientOpts: object): Promise<StubClient> => {
    opts.calls?.push(clientOpts as ClientOptions)
    if (opts.error) throw opts.error
    return opts.client ?? makeStubClient()
  }
}

/** A stub client whose `close()` only counts its calls, with that count. */
export interface CloseCountingStubClient {
  client: StubClient
  /** How many times `client.close()` has been called. */
  closes(): number
}

/**
 * A stub client (`makeStubClient(opts)`) whose `close()` is replaced by a
 * counter, so a case can check which of two clients was closed and how often.
 */
export function makeCloseCountingStubClient(opts: StubClientOptions = {}): CloseCountingStubClient {
  let count = 0
  const client = makeStubClient(opts)
  client.close = () => { count += 1 }
  return { client, closes: () => count }
}

/**
 * Startup-gate seams for a run that passes every step when nothing is
 * overridden: a default stub client (`makeStubCreateClient()`), the three
 * API-surface probes passing, an ENOENT state.db stat (the same-user check
 * passes silently), UID 1000, a startup-error recorder that swallows, and an
 * `exit` that throws, since a passing run never reaches it. `overrides` wins
 * over every default.
 */
export function makePassingGateDeps(overrides: Partial<StartupGateDeps> = {}): Partial<StartupGateDeps> {
  return {
    createClient: makeStubCreateClient(),
    probeGetPermission: () => true,
    probeErrorCatalog: () => ({ ok: true as const }),
    probeDecideArgv: async () => ({ ok: true as const }),
    statSync: () => {
      const err: NodeJS.ErrnoException = new Error('ENOENT')
      err.code = 'ENOENT'
      throw err
    },
    geteuid: () => 1000,
    recordStartupError: () => { /* swallow */ },
    exit: (_code: number) => { throw new Error('exit should not be reached in non-failing runStartupGate path') },
    ...overrides,
  }
}

/** The binary path a stub `resolveSystemBinary` resolves with by default. */
export const STUB_RESOLVE_DEFAULT_PATH = '/usr/local/bin/agent-director'

/**
 * One answer of a stub `resolveSystemBinary` call:
 *   - `{ version, path? }` resolves with that version, and with `path` or
 *     else the builder's `path` option (default
 *     {@link STUB_RESOLVE_DEFAULT_PATH});
 *   - `{ throws }` rejects with that error;
 *   - `{ never: true }` returns a promise that never settles.
 */
export type StubResolveSystemBinaryOutcome =
  | { version: string; path?: string }
  | { throws: Error }
  | { never: true }

/** Options for makeStubResolveSystemBinary. */
export interface StubResolveSystemBinaryOptions {
  /** Reject every call with this error. Cannot be given with `outcomes`. */
  throws?: Error
  /**
   * Answer the calls in this order, one entry per call; once the list runs
   * out the last entry answers every later call. Must not be empty, and
   * cannot be given with `throws` or `version`.
   */
  outcomes?: readonly StubResolveSystemBinaryOutcome[]
  /**
   * Resolve with this binary path (default: {@link STUB_RESOLVE_DEFAULT_PATH}).
   * With `outcomes`, the path of a `{ version }` entry that names none.
   */
  path?: string
  /** Resolve every call with this binary version (default: `PHASE1_RC_VERSION`). */
  version?: string
  /** Capture each call's opts argument here, a call that never settles included. */
  calls?: Array<object | undefined>
}

/**
 * Build a stub `resolveSystemBinary`-shaped function,
 * `(opts?) => Promise<{ path, version }>`, mirroring the AD library's
 * `resolveSystemBinary()`. With no options every call resolves with
 * `PHASE1_RC_VERSION` (which passes CSCB's Phase 1 floor) at the default
 * path; `throws` rejects every call; `outcomes` answers the calls in order,
 * repeating its last entry. Invalid option combinations throw here, when the
 * stub is built.
 */
export function makeStubResolveSystemBinary(
  opts: StubResolveSystemBinaryOptions = {},
): (resolveOpts?: object) => Promise<{ path: string; version: string }> {
  const { outcomes } = opts
  if (outcomes !== undefined) {
    if (opts.throws !== undefined) {
      throw new Error('makeStubResolveSystemBinary: give `outcomes` or `throws`, not both')
    }
    if (opts.version !== undefined) {
      throw new Error('makeStubResolveSystemBinary: give `outcomes` or `version`, not both; put the version in an outcome')
    }
    if (outcomes.length === 0) {
      throw new Error('makeStubResolveSystemBinary: `outcomes` must hold at least one entry')
    }
  }
  const defaultPath = opts.path ?? STUB_RESOLVE_DEFAULT_PATH
  let callIndex = 0
  return async (resolveOpts?: object): Promise<{ path: string; version: string }> => {
    opts.calls?.push(resolveOpts)
    if (outcomes === undefined) {
      if (opts.throws) throw opts.throws
      return { path: defaultPath, version: opts.version ?? PHASE1_RC_VERSION }
    }
    const outcome = outcomes[Math.min(callIndex, outcomes.length - 1)]!
    callIndex += 1
    if ('never' in outcome) return new Promise<never>(() => {})
    if ('throws' in outcome) throw outcome.throws
    return { path: outcome.path ?? defaultPath, version: outcome.version }
  }
}
