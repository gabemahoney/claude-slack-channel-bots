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
 * the approver's cap shortened and a temp spawn home; the approver reads and
 * types; the prompt-row checks (b.jdc's one-line `read-pane`) only read; both
 * go through the stub client only. A launch
 * through that path returns before its approver's first lap (the approver
 * runs on its own after the launch call, b.jg5 SRJ-401), and
 * `resetStubSpawnPath` leaves no approver running.
 *
 * A recorded `spawn` may be a reuse spawn (b.jg5 SRJ-112, SRJ-708): the
 * stub records its parameters as the client's own `SpawnParams`, reuse flag
 * (`reuse_finished`) included, so a test reads the flag from `spawnCalls`
 * with no cast, and answers it like any spawn, from the same queue and knobs.
 *
 * Per-call answers: `statusFn`, `getFn`, `spawnFn`, `resumeFn`,
 * `findMissingFn`, `readPaneFn`, `sendKeysFn` and `killFn` compute a verb's
 * answer from each call's parameters and win over its queue, error and
 * result; each call is still recorded in the verb's capture list first.
 * Every one but `statusFn` and `getFn` may be async, so a case runs code
 * while a call is in progress, such as moving a fake clock and then
 * rejecting with `errCallTimeout` or `errTmuxUnresponsiveLaunchTimeout`
 * (b.jg5 SRJ-407's launch-call window). Each answers `undefined` to leave a
 * call to the verb's other knobs. The last four let a row's answers follow
 * what CSCB did to it (b.jg5 SRJ-410, SRJ-412): an Enter that clears a
 * startup dialog, a `find-missing` run that judges the row only from G, a
 * `kill` that ends it (`tests/test-helpers/pending-row-model.ts` scripts one
 * persona's row through them).
 *
 * Held calls: `holdSpawns` keeps a stub's `spawn` calls open, and
 * `holdFindMissing` its `find-missing` calls (b.jg5 SRJ-706: a live-row
 * sequence's run held while the start pass, an apply, a stop or a lost
 * message is driven), until the test settles each, oldest first: its handle
 * gives the calls received, the number still held, a promise for a call
 * entered, release with a result (a placement from `cannedFindMissing`),
 * failure with an error, and release of every held call for cleanup.
 *
 * Phase 1 errors and results (b.jg5 SRJ-1303):
 *   - Every error builder uses the client's own class, except:
 *       - `errGeneric`, which builds the base `AgentDirectorError` for any
 *         `errName` (a base error named like a class is not that class:
 *         the classifier answers UNCLASSIFIED for it);
 *       - `errAmbiguousRequest` and `errPermissionRequestNotFound`, which
 *         build the base `AgentDirectorError` with the error's `errName`
 *         although the client exports a class for each, because the code
 *         under test recognises both by `errName`.
 *     The three families for the errors only the Phase 1 client declares
 *     (`errTmuxUnresponsive*`, `errTmuxKillFailed`, `errTmuxSessionConflict`)
 *     build with `new` on `ErrTmuxUnresponsive`, `ErrTmuxKillFailed` and
 *     `ErrTmuxSessionConflict`, the client's own classes as
 *     `src/agent-director-errors.ts` re-exports them. Each value carries its
 *     verb, its name as `errName` and its description.
 *   - `ErrInternal`, `ErrConfigMalformed` and the three store-open names
 *     (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`, `ErrStoreOpen`)
 *     have no class in any client and arrive as `ErrUnknownErrorName`;
 *     `errInternal`, `errUnusableName`, `errConfigMalformed`,
 *     `errSchemaMismatch` and `errUnknownErrorName` build that class the way
 *     the client does, with the name in `unknownName` and the binary's
 *     `{ err_name, err_description }` envelope in `envelope`
 *     (`ErrSchemaMigrationRequired` and `ErrStoreOpen` through
 *     `errUnknownErrorName`).
 *   - A plain spawn's re-lookup after "duplicate session" that could not
 *     answer (HO rev 26; b.jg5 SRJ-111): `errTmuxUnresponsiveNewRowEnded`
 *     (UNAVAILABLE) and `errTmuxNotAvailableNewRowEnded` (ENVIRONMENT), each
 *     carrying "the new row was ended" and the retry with `reuse_finished`
 *     (`NEW_ROW_ENDED_RETRY`), never the launch-timeout words.
 *   - `UNAVAILABLE_FORMS` is the one table of UNAVAILABLE forms (label,
 *     builder by verb, cause kind); `unavailableForms` picks a subset.
 *   - The description words CSCB matches come from
 *     `src/ad-description-phrases.ts`; the Phase 1 result fields
 *     (`kill_sent`, `launch_started_at`, `liveness_note`, `pre_trust`) are
 *     typed by the client's own result types. A binary older than Phase 1
 *     omits `kill_sent` and `pre_trust`, which the client declares required,
 *     so the stub's `kill`, spawn and `resume` answers are typed
 *     `StubKillResult`, `StubSpawnResult` and `StubResumeResult`: the
 *     client's type with that one field optional ({@link MayLackPhase1Fields}).
 *   - Liveness notes (b.jg5 SRJ-114): `provenanceNote` is the only note that
 *     latches; `nonLatchingNotes` is every other note agent-director names,
 *     the list a `test.each` iterates for "no other note latches", typed as
 *     the client's free text; `unknownNote` is a note CSCB does not
 *     know. Tests take note values from here and never type them.
 *   - Launch starts (b.jg5 SRJ-513): the canned row builders
 *     (`cannedStatusResult`, `cannedGetResult`, `cannedListRow`) and the stub
 *     client's default answers give a `pending` row the sample launch start
 *     `SAMPLE_LAUNCH_START_DEFAULT` unless the case gives `launch_started_at`,
 *     since a configured persona's own `pending` row with no launch start
 *     latches the persona. "No launch start" is an explicit request:
 *     `launch_started_at: SAMPLE_LAUNCH_START_NONE` (the key left out) or
 *     `launch_started_at: null`. Rows in any other state carry no launch
 *     start unless given one. Tests take launch starts from the
 *     `SAMPLE_LAUNCH_START*` constants and never type a timestamp.
 *   - Pre-trust (b.jg5 SRJ-413): `cannedSpawnResult` and `cannedResumeResult`
 *     take a `pre_trust`, and `PRE_TRUST_VALUES` lists the three values
 *     (`ok`, `skipped`, `failed`), checked at compile time against every
 *     member of `PreTrust`; a result with no `pre_trust` (from a binary older
 *     than Phase 1) is the builder's value left out. Tests take `pre_trust`
 *     values from the list and never type them.
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
  ErrCwdNotADirectory,
  ErrCwdNotFound,
  ErrInstanceIdCollision,
  ErrInvalidFlags,
  ErrJsonlMissing,
  ErrJsonlNeverWritten,
  ErrNoOpenPermissionRequest,
  ErrNoSessionId,
  ErrPauseTimeout,
  ErrRelayFallenBack,
  ErrRelayModeOff,
  ErrSendKeysWhileRelayed,
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
  FindMissingParams,
  FindMissingResult,
  GetParams,
  GetResult,
  KillParams,
  KillResult,
  ListParams,
  ListResult,
  ListRow,
  MakeTemplateParams,
  MakeTemplateResult,
  PauseParams,
  PauseResult,
  ReadPaneParams,
  ReadPaneResult,
  ResumeParams,
  ResumeResult,
  SendKeysParams,
  SendKeysResult,
  SpawnParams,
  SpawnResult,
  StatusParams,
  StatusResult,
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
  PERSONA_TMUX_SESSION_PREFIX,
  personaInstanceId,
  personaTmuxSessionName,
} from '../../src/persona-identity.ts'
import {
  _resetApproverClock,
  _resetDialogReadyTimeoutMs,
  _resetInFlightLaunches,
  _resetSpawnHomeDir,
  _setDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  personaConfigDirLabelValue,
} from '../../src/session-manager.ts'
import { resetClientForTests, setClientForTests } from '../../src/agent-director-client.ts'
import {
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrTmuxKillFailed,
  ErrTmuxSessionConflict,
  ErrTmuxUnresponsive,
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
  SURVIVOR_CLAUSE_MANY_PHRASE,
  SURVIVOR_CLAUSE_ONE_PHRASE,
  UNUSABLE_RECORDED_NAME_PHRASE,
  survivorPids,
} from '../../src/ad-description-phrases.ts'
import type { LivenessNote, PreTrust } from '../../src/ad-phase1-types.ts'
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
 * A result as agent-director may answer it: the client's own type `T`, with
 * the fields `K` that the client declares required left optional, because a
 * binary older than Phase 1 omits them (b.jg5 SRJ-110: a `kill` result with
 * no `kill_sent`; SRJ-413: a spawn or `resume` result with no `pre_trust`).
 * Every field keeps the client's own type.
 */
export type MayLackPhase1Fields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/** A `kill` answer: the client's `KillResult`, `kill_sent` absent from a binary older than Phase 1. */
export type StubKillResult = MayLackPhase1Fields<KillResult, 'kill_sent'>

/** A spawn answer (plain or reuse): the client's `SpawnResult`, `pre_trust` absent from a binary older than Phase 1. */
export type StubSpawnResult = MayLackPhase1Fields<SpawnResult, 'pre_trust'>

/** A `resume` answer: the client's `ResumeResult`, `pre_trust` absent from a binary older than Phase 1. */
export type StubResumeResult = MayLackPhase1Fields<ResumeResult, 'pre_trust'>

/**
 * Build a canned `kill` result. `killSent` is the Phase 1 `kill_sent` field
 * (whether agent-director sent a kill); omit it for a result from a binary
 * older than Phase 1, which has no such field (the key is then absent).
 */
export function cannedKillResult(killSent?: boolean): StubKillResult {
  return killSent === undefined ? {} : { kill_sent: killSent }
}

/**
 * Sample launch starts (`launch_started_at`, ADSRD SR-22.2: RFC 3339 UTC with
 * millisecond precision, the fraction shown only when it is not zero): one
 * with fractional seconds and one without.
 *
 * The canned row builders (`cannedStatusResult`, `cannedGetResult`,
 * `cannedListRow`) give a `pending` row `SAMPLE_LAUNCH_START_DEFAULT` when the
 * overrides have no `launch_started_at` key, since a configured persona's own
 * `pending` row with no launch start latches the persona (b.jg5 SRJ-513).
 * "No launch start" is an explicit request: pass
 * `launch_started_at: SAMPLE_LAUNCH_START_NONE` (`undefined`: the key is left
 * out of the row) or `launch_started_at: null` (the key shown as `null`). A
 * row in any other state gets no launch start by default, as agent-director
 * shows the field on `pending` rows only; an explicit override still wins in
 * every state.
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

/** The launch start a canned `pending` row shows when the caller gives none. */
export const SAMPLE_LAUNCH_START_DEFAULT = SAMPLE_LAUNCH_STARTS.fractional

/** The row state that carries a launch start: the stub's own spelling of agent-director's `pending`. */
const PENDING_ROW_STATE = 'pending'

/**
 * Give `row` the default launch start when it reads `pending` and `overrides`
 * has no `launch_started_at` key (a key given as `undefined` or `null` is an
 * explicit "no launch start" and is kept).
 */
function withDefaultLaunchStart<T extends { state?: unknown }>(row: T, overrides: object): T {
  if (row.state === PENDING_ROW_STATE && !('launch_started_at' in overrides)) {
    (row as Record<string, unknown>)['launch_started_at'] = SAMPLE_LAUNCH_START_DEFAULT
  }
  return row
}

/**
 * A `liveness_note` as the client types it: free text, since
 * agent-director has notes CSCB does not tell apart.
 */
type ClientLivenessNote = NonNullable<GetResult['liveness_note']>

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
 * `cannedGetResult` and `cannedListRow`. A `pending` result shows
 * `SAMPLE_LAUNCH_START_DEFAULT` unless the overrides give `launch_started_at`;
 * given as `undefined` (`SAMPLE_LAUNCH_START_NONE`) the key is left out, and
 * given as `null` it is shown as `null`.
 */
export function cannedStatusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return omitUndefined(withDefaultLaunchStart({ state: 'waiting', ...overrides }, overrides), ['launch_started_at'])
}

/**
 * Build a canned spawn result (plain or reuse). `preTrust` is the Phase 1
 * `pre_trust` field (`ok`, `skipped`, `failed`); omit it for a result from a
 * binary older than Phase 1 (the key is then absent).
 */
export function cannedSpawnResult(claudeInstanceId: string = 'cscb_test', preTrust?: PreTrust): StubSpawnResult {
  return preTrust === undefined
    ? { claude_instance_id: claudeInstanceId }
    : { claude_instance_id: claudeInstanceId, pre_trust: preTrust }
}

/** Build a canned `resume` result, with `pre_trust` as `cannedSpawnResult` takes it. */
export function cannedResumeResult(claudeInstanceId: string = 'cscb_test', preTrust?: PreTrust): StubResumeResult {
  return preTrust === undefined
    ? { claude_instance_id: claudeInstanceId }
    : { claude_instance_id: claudeInstanceId, pre_trust: preTrust }
}

/**
 * Every `PreTrust` member, each its own key. Typed as a record over
 * `PreTrust`, so a member missing here, or a key that is not a member, fails
 * `bun run typecheck`.
 */
const PRE_TRUST_MEMBERS: { readonly [V in PreTrust]: V } = {
  ok: 'ok',
  skipped: 'skipped',
  failed: 'failed',
}

/**
 * The three `pre_trust` values a Phase 1 spawn or `resume` result carries
 * (b.jg5 SRJ-413), for `test.each` with `cannedSpawnResult` and
 * `cannedResumeResult`; an absent field is their `preTrust` left out. Tests
 * take `pre_trust` values from here and never type them.
 */
export const PRE_TRUST_VALUES: readonly PreTrust[] = Object.freeze(Object.values(PRE_TRUST_MEMBERS))

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

/**
 * Build the client's ErrSendKeysWhileRelayed for `send-keys`: agent-director
 * refuses keystrokes to a row that sits on a relayed permission prompt, and
 * nothing was sent. CSCB gives the name no handling, so it classes
 * UNCLASSIFIED (b.jg5 SRJ-104, SRJ-118).
 */
export function errSendKeysWhileRelayed(): ErrSendKeysWhileRelayed {
  return new ErrSendKeysWhileRelayed(
    'send-keys',
    'ErrSendKeysWhileRelayed',
    'the row sits on a relayed permission prompt; nothing was sent',
  )
}

/** Build an ErrInstanceIdCollision (spawn / SR-1.4 collision path). */
export function errInstanceIdCollision(): ErrInstanceIdCollision {
  return new ErrInstanceIdCollision('spawn', 'ErrInstanceIdCollision', 'claude_instance_id already in use')
}

/**
 * Build agent-director's session-create failure (`ErrTmuxSessionCreate`, the
 * LAUNCH FAILURE class) for a `resume` (the default `verb`) or, with
 * 'spawn', a spawn. CSCB counts it once as a launch failure and never
 * follows it with a kill or a spawn in its place (b.jg5 SRJ-602).
 */
export function errTmuxSessionCreate(verb: string = 'resume'): ErrTmuxSessionCreate {
  return new ErrTmuxSessionCreate(verb, 'ErrTmuxSessionCreate', 'tmux: new-session failed: tmux session already exists')
}

/**
 * Build an ErrTmuxSessionCreate from a reuse spawn (default verb `spawn`) or
 * a `resume` of a row agent-director could not restore: its description ends
 * with HO rev 28's restore sentence "the row could not be restored and stays
 * pending", so the row then reads `pending`. CSCB matches no restore
 * sentence: the retry's read of the row decides (b.jg5 SRJ-112, SRJ-409).
 */
export function errTmuxSessionCreateStaysPending(verb: string = 'spawn'): ErrTmuxSessionCreate {
  return withRestoreSentence(errTmuxSessionCreate(verb), RESTORE_SENTENCE_STAYS_PENDING)
}

/** HO rev 28's restore sentence for a row agent-director could not restore: it stays `pending`. */
export const RESTORE_SENTENCE_STAYS_PENDING = 'the row could not be restored and stays pending'

/**
 * HO rev 28's four restore sentences (ADSRD SR-1.4, SR-8.5): one ends the
 * description of a `resume` or reuse whose launch failed after its move or
 * reset (a launch timeout carries none): the row was restored to its prior
 * state; it changed after the move and was left as it is; it was removed, so
 * nothing was restored; or it could not be restored and stays `pending`.
 * CSCB keys no behaviour on them (b.jg5 SRJ-113), and `src/` holds none, so
 * a case's row stays as the case scripts it (`statusFn`, `getFn`), never
 * derived from the sentence.
 */
export const RESTORE_SENTENCES: readonly string[] = Object.freeze([
  'the row was restored to its prior state',
  'the row changed after the move and was left as it is',
  'the row was removed after the move, so nothing was restored',
  RESTORE_SENTENCE_STAYS_PENDING,
])

/**
 * `err` again, its description ending with `sentence` (one of
 * {@link RESTORE_SENTENCES}): the same class, verb and name, so it
 * classifies as `err` does.
 */
export function withRestoreSentence<E extends AgentDirectorError>(err: E, sentence: string): E {
  const Made = err.constructor as new (verb: string, errName: string, description: string) => E
  const restored = new Made(err.verb, err.errName, `${err.errDescription}; ${sentence}`)
  restored.name = err.name
  return restored
}

/** Build an ErrCwdNotFound (the client's class): the working directory `cwd` does not exist. */
export function errCwdNotFound(verb: string = 'spawn', cwd: string = '/x'): ErrCwdNotFound {
  return new ErrCwdNotFound(verb, 'ErrCwdNotFound', `cwd ${cwd} does not exist`)
}

/** Build an ErrCwdNotADirectory (the client's class): the working directory `cwd` is not a directory. */
export function errCwdNotADirectory(verb: string = 'spawn', cwd: string = '/x'): ErrCwdNotADirectory {
  return new ErrCwdNotADirectory(verb, 'ErrCwdNotADirectory', `cwd ${cwd} is not a directory`)
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
 * canonical `errName`, not the client's `ErrAmbiguousRequest` class;
 * callers match on `errName`.
 */
export function errAmbiguousRequest(): AgentDirectorError {
  return new AgentDirectorError('decide', 'ErrAmbiguousRequest', 'ambiguous request')
}

/**
 * Build the AD `ErrPermissionRequestNotFound` sentinel returned by the
 * paired-release `get-permission` verb when the row has aged out of AD's
 * store. The client exports an `ErrPermissionRequestNotFound` class,
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
 * Build an `ErrTmuxUnresponsive` (the client's class, as
 * `src/agent-director-errors.ts` re-exports it): a tmux call that did not answer
 * (default verb `resume`; `status` only reads the store and never returns
 * it). The default description is a call timeout that did nothing; pass
 * `description` for another. See `errTmuxUnresponsiveLaunchTimeout`,
 * `errTmuxUnresponsiveStillStopping`, `errTmuxUnresponsiveStillStarting`,
 * `errTmuxUnresponsiveAfterDuplicateSession` and
 * `errTmuxUnresponsiveNewRowEnded` for the variants.
 */
export function errTmuxUnresponsive(
  verb: string = 'resume',
  description: string = 'tmux display-message did not answer within 5 s; nothing was done; retry later',
): AgentDirectorError {
  return new ErrTmuxUnresponsive(verb, ERR_TMUX_UNRESPONSIVE_NAME, description)
}

/**
 * Build an `ErrTmuxUnresponsive` (the client's class) met after tmux answered
 * "duplicate session": the session holding the name could not be read, so
 * nothing was started (default verb `resume`).
 */
export function errTmuxUnresponsiveAfterDuplicateSession(verb: string = 'resume'): AgentDirectorError {
  return new ErrTmuxUnresponsive(
    verb,
    ERR_TMUX_UNRESPONSIVE_NAME,
    'tmux new-session answered duplicate session and the session holding the name could not be read; nothing was started',
  )
}

/**
 * Build an `ErrTmuxUnresponsive` (the client's class) that ends a launch call as a launch
 * timeout: its description carries "the session may have been created"
 * (default verb `spawn`; pass `resume` for a resume).
 */
export function errTmuxUnresponsiveLaunchTimeout(
  verb: string = 'spawn',
  instanceId: string = STUB_INSTANCE_ID,
): AgentDirectorError {
  return new ErrTmuxUnresponsive(
    verb,
    ERR_TMUX_UNRESPONSIVE_NAME,
    `${verb} of ${instanceId}: tmux new-session did not answer within 5 s; ${LAUNCH_TIMEOUT_PHRASE} and the row stays pending; do not retry until get shows the row ended or missing`,
  )
}

/**
 * Build an `ErrTmuxUnresponsive` (the client's class) for a row that "appears to still be
 * stopping": it ended less than the stopping window (90 s) ago and its own
 * session still runs. The description names the quoted session name, as
 * agent-director's does (default verb `resume`; reuse and
 * `kill --include-finished` also return it).
 */
export function errTmuxUnresponsiveStillStopping(
  verb: string = 'resume',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): AgentDirectorError {
  return new ErrTmuxUnresponsive(
    verb,
    ERR_TMUX_UNRESPONSIVE_NAME,
    `the agent in tmux session ${JSON.stringify(sessionName)} ${STILL_STOPPING_PHRASE}: its row ended less than the stopping window (90 s) ago; nothing was done; retry later`,
  )
}

/**
 * Build an `ErrTmuxUnresponsive` (the client's class) for a row that "appears to still be
 * starting": its own session is younger than the starting-session bound
 * (300 s). The description names the quoted session name, as
 * agent-director's does (default verb `resume`; reuse also returns it).
 */
export function errTmuxUnresponsiveStillStarting(
  verb: string = 'resume',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): AgentDirectorError {
  return new ErrTmuxUnresponsive(
    verb,
    ERR_TMUX_UNRESPONSIVE_NAME,
    `the agent in tmux session ${JSON.stringify(sessionName)} ${STILL_STARTING_PHRASE}: the session is younger than the starting-session bound (300 s); nothing was done; retry later`,
  )
}

/**
 * The retry a plain spawn's re-lookup error names once it has ended its new
 * row (HO rev 26; b.jg5 SRJ-111): a spawn with `reuse_finished` once the
 * session name is free. agent-director's own words; CSCB keys nothing on
 * them, so `src/` holds none.
 */
export const NEW_ROW_ENDED_RETRY = 'retry with reuse_finished once the session name is free'

/**
 * Build an `ErrTmuxUnresponsive` (the client's class) from a plain spawn whose
 * `tmux new-session` answered "duplicate session" and whose re-lookup of the
 * session holding the name could not answer (HO rev 26; b.jg5 SRJ-111,
 * SRJ-1303): agent-director ended the new row, so the description carries
 * "the new row was ended" and names a retry with `reuse_finished`, and none
 * of the launch-timeout, still-stopping or still-starting words (default verb
 * `spawn`).
 */
export function errTmuxUnresponsiveNewRowEnded(
  verb: string = 'spawn',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): AgentDirectorError {
  return new ErrTmuxUnresponsive(
    verb,
    ERR_TMUX_UNRESPONSIVE_NAME,
    `tmux new-session answered duplicate session for tmux session ${JSON.stringify(sessionName)} and the re-lookup of the session holding the name did not answer within 5 s; ${NEW_ROW_ENDED_PHRASE}; ${NEW_ROW_ENDED_RETRY}`,
  )
}

/**
 * The four `ErrTmuxKillFailed` descriptions, in agent-director 0.11.0-rc.1's
 * wording (`pkg/api/kill_errors.go`):
 *   - `'outlived-exit-wait'`: variant (a), worker only: a kill was sent and
 *     "the agent process (pid N)" was still running after the kill exit wait
 *     of 5 s, N being {@link STUB_WORKER_PID};
 *   - `'pane-process-survived'`: variant (a) with survivors: a kill was sent
 *     and the survivor clause (the form `SURVIVOR_PID_PATTERN` matches),
 *     "another process of a pane of the labelled session (pid S)" for one pid
 *     or "other processes of panes of the labelled session (pids S1, S2)" for
 *     several, was/were still running after the kill exit wait of 5 s; with
 *     the worker-and-survivor option ({@link KillFailedOptions}) the worker's
 *     clause comes first, joined with " and ", and "were still running";
 *   - `'unverifiable-session-present'`: variant (b): a kill was sent, but the
 *     agent process cannot be checked and its labelled session is still
 *     there;
 *   - `'no-session-no-kill'`: variant (c): no session or pane of this launch
 *     was found while its agent process still runs ("(pid N)", N being
 *     {@link STUB_WORKER_PID}), so no kill was sent, and a human can find and
 *     look at the process, with the "Operator actions" pointer.
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
 * The worker's pid that `errTmuxKillFailed`'s `'outlived-exit-wait'` and
 * `'no-session-no-kill'` descriptions name, and `'pane-process-survived'`
 * names with the worker-and-survivor option: one fake pid, above Linux's
 * largest pid (2^22), so it can never be a real process, and distinct from
 * every pid of {@link STUB_SURVIVOR_PIDS}.
 */
export const STUB_WORKER_PID = 4194350

/** Options of `errTmuxKillFailed`. */
export interface KillFailedOptions {
  /**
   * With `'pane-process-survived'` only: name the worker's pid
   * ({@link STUB_WORKER_PID}) beside the survivor clause, as agent-director
   * does when the worker and the survivors both outlived the kill exit wait:
   * "the agent process (pid N) and <survivor clause> were still running".
   */
  readonly workerAlsoRunning?: boolean
}

/**
 * The instance id `errTmuxKillFailed`'s descriptions name for `sessionName`:
 * `cscb_<key>` for a persona's own session `slack_bot_<key>`, otherwise
 * {@link STUB_INSTANCE_ID}.
 */
function killFailedInstanceId(sessionName: string): string {
  return sessionName.startsWith(PERSONA_TMUX_SESSION_PREFIX)
    ? personaInstanceId(sessionName.slice(PERSONA_TMUX_SESSION_PREFIX.length))
    : STUB_INSTANCE_ID
}

/**
 * Build an `ErrTmuxKillFailed` (the client's class, as
 * `src/agent-director-errors.ts` re-exports it; verb `kill`) with one of its four
 * descriptions ({@link KillFailedDescription}), each the full text the client
 * delivers: agent-director's error text, `tmux: agent process still running:
 * instance <id>: ` (the id `cscb_<key>` for a session `slack_bot_<key>`,
 * else {@link STUB_INSTANCE_ID}), then the quoted session name, and ending
 * "retry kill later; never delete this row". Only
 * `'pane-process-survived'` carries the survivor clause, built from
 * `SURVIVOR_CLAUSE_ONE_PHRASE` for one of `pids` and
 * `SURVIVOR_CLAUSE_MANY_PHRASE` for several; the other three ignore `pids`.
 * The builder checks its own text with `survivorPids` and throws when the
 * pids it reads are not exactly `pids` for the survivor description (with or
 * without `workerAlsoRunning`) or not none for the other three. It throws when
 * the survivor description is given no pids, and when `workerAlsoRunning` is
 * given with another description.
 */
export function errTmuxKillFailed(
  sessionName: string = STUB_TMUX_SESSION_NAME,
  description: KillFailedDescription = 'outlived-exit-wait',
  pids: readonly number[] = STUB_SURVIVOR_PIDS,
  options: KillFailedOptions = {},
): AgentDirectorError {
  if (description === 'pane-process-survived' && pids.length === 0) {
    throw new Error("errTmuxKillFailed: 'pane-process-survived' names one or more pids")
  }
  if (options.workerAlsoRunning === true && description !== 'pane-process-survived') {
    throw new Error(`errTmuxKillFailed (${description}): workerAlsoRunning applies to 'pane-process-survived' only`)
  }
  const context = `tmux: agent process still running: instance ${killFailedInstanceId(sessionName)}: tmux session ${JSON.stringify(sessionName)}`
  const sent = "a kill was sent to the agent's pane and to its labelled session"
  const exitWait = 'still running after the kill exit wait of 5 s'
  const tail = `${RETRY_KILL_LATER_PHRASE}; ${NEVER_DELETE_ROW_PHRASE}`
  const worker = `the agent process (pid ${STUB_WORKER_PID})`
  const survivors =
    pids.length === 1
      ? `${SURVIVOR_CLAUSE_ONE_PHRASE} (pid ${pids[0]})`
      : `${SURVIVOR_CLAUSE_MANY_PHRASE} (pids ${pids.join(', ')})`
  const running = options.workerAlsoRunning === true ? `${worker} and ${survivors}` : survivors
  const verb = options.workerAlsoRunning === true || pids.length > 1 ? 'were' : 'was'
  const text: Record<KillFailedDescription, string> = {
    'outlived-exit-wait': `${context}: ${sent}, and ${worker} was ${exitWait}; ${tail}`,
    'pane-process-survived': `${context}: ${sent}, and ${running} ${verb} ${exitWait}; ${tail}`,
    'unverifiable-session-present':
      `${context}: ${sent}, but the agent process cannot be checked and its labelled session is still there; ${tail}`,
    'no-session-no-kill':
      `${context}: no session or pane of this launch was found while its agent process still runs (pid ${STUB_WORKER_PID}), ` +
      `so ${NO_KILL_SENT_PHRASE}; a human can find and look at the process, see "Operator actions" in the agent-director README; ${tail}`,
  }
  const expected = description === 'pane-process-survived' ? [...pids] : []
  if (JSON.stringify(survivorPids(text[description])) !== JSON.stringify(expected)) {
    throw new Error(`errTmuxKillFailed (${description}): the description does not name exactly the pids ${JSON.stringify(expected)}`)
  }
  return new ErrTmuxKillFailed('kill', ERR_TMUX_KILL_FAILED_NAME, text[description])
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
 *   - `plainSpawn`: `different-id` or `another-store` met at "duplicate
 *     session" (by a plain spawn; the reuse and `resume` case rows take it as
 *     their "duplicate session" form);
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
 * Build an `ErrTmuxSessionConflict` (the client's class, as
 * `src/agent-director-errors.ts` re-exports it) for `conflictCase`. Each
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
  return new ErrTmuxSessionConflict(verb, ERR_TMUX_SESSION_CONFLICT_NAME, text[conflictCase])
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

/**
 * Build an ErrTmuxNotAvailable (the client's class) from a plain spawn whose
 * `tmux new-session` answered "duplicate session" and whose re-lookup of the
 * session holding the name could not run tmux (HO rev 26; b.jg5 SRJ-111):
 * agent-director ended the new row, so the description carries "the new row
 * was ended" and names a retry with `reuse_finished` (default verb `spawn`).
 */
export function errTmuxNotAvailableNewRowEnded(
  verb: string = 'spawn',
  sessionName: string = STUB_TMUX_SESSION_NAME,
): ErrTmuxNotAvailable {
  return new ErrTmuxNotAvailable(
    verb,
    'ErrTmuxNotAvailable',
    `tmux new-session answered duplicate session for tmux session ${JSON.stringify(sessionName)} and tmux could not be run for the re-lookup of the session holding the name; ${NEW_ROW_ENDED_PHRASE}; ${NEW_ROW_ENDED_RETRY}`,
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
 * Every UNAVAILABLE form, each built from its class: `ErrTmuxUnresponsive` and its
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
 * `nonLatchingNotes`). A `pending` row shows `SAMPLE_LAUNCH_START_DEFAULT`
 * unless the overrides give `launch_started_at`; no other row has a launch
 * start, and no row has a note, unless given. Either field given as
 * `undefined` (`SAMPLE_LAUNCH_START_NONE` for the launch start) is left out
 * of the row; a `null` launch start is shown as `null`.
 */
export function cannedListRow(overrides: Partial<ListRow> & { claude_instance_id: string }): ListRow
export function cannedListRow(overrides: Partial<ListRow>, persona: CannedRowPersona, home: string): ListRow
export function cannedListRow(overrides: Partial<ListRow>, persona?: CannedRowPersona, home?: string): ListRow {
  if (persona) {
    if (home === undefined) throw new Error('cannedListRow: the persona form needs a home')
    return omitUndefined(withDefaultLaunchStart({
      parent_id: undefined,
      state: 'waiting',
      relay_mode: 'on',
      started_at: '2026-05-24T12:00:00Z',
      last_seen_at: '2026-05-24T12:00:00Z',
      ended_at: null,
      ...personaRowDefaults(persona, home),
      ...overrides,
    }, overrides), PHASE1_ROW_FIELDS)
  }
  return omitUndefined(withDefaultLaunchStart({
    parent_id: undefined,
    state: 'waiting',
    relay_mode: 'on',
    ...defaultRowFields(overrides.claude_instance_id as string),
    started_at: '2026-05-24T12:00:00Z',
    last_seen_at: '2026-05-24T12:00:00Z',
    ended_at: null,
    ...overrides,
  } as ListRow, overrides), PHASE1_ROW_FIELDS)
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
  & Partial<GetResult>
  & { claude_instance_id: string }
  & { permission_requests?: PermissionRequestRow[] | null }

/** `GetResultOverrides` for the persona form, where `claude_instance_id` defaults to `cscb_<key>`. */
export type PersonaGetResultOverrides =
  & Partial<GetResult>
  & { permission_requests?: PermissionRequestRow[] | null }

/**
 * `cannedGetResult` may carry a `permission_requests` field for check_permission
 * rows. Production code (`permission-poller.ts`,
 * `permission-click-handler.ts`) casts `GetResult` to
 * `GetResultWithPermissionRequests` at the use site, so the extra field
 * flows through without polluting the upstream type.
 */
export type CannedGetResult = GetResult & { permission_requests?: PermissionRequestRow[] | null }

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
 * as on `cannedListRow`: a `pending` row shows `SAMPLE_LAUNCH_START_DEFAULT`
 * unless the overrides give `launch_started_at`, nothing else is set by
 * default, and either field given as `undefined` is left out.
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
    return omitUndefined(withDefaultLaunchStart({
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
    }, overrides), PHASE1_ROW_FIELDS)
  }
  return omitUndefined(withDefaultLaunchStart({
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
  } as CannedGetResult, overrides), PHASE1_ROW_FIELDS)
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
 * What a per-call knob that may be async (`spawnFn`, `resumeFn`,
 * `findMissingFn`, `readPaneFn`, `sendKeysFn`, `killFn`) answers, at once or
 * through a promise: a result resolves the call, an `Error` rejects it, and
 * `undefined` leaves the call to the verb's other knobs.
 */
export type StubCallAnswer<T> = T | Error | undefined | Promise<T | Error | undefined>

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
 * Per-call function knobs compute a response per call and take precedence
 * over every other knob of their verb: `statusFn` and `getFn`; `spawnFn`
 * and `resumeFn` for the two launch verbs; `findMissingFn`, `readPaneFn`,
 * `sendKeysFn` and `killFn` (b.jg5 SRJ-410, SRJ-412). All but `statusFn`
 * and `getFn` may be async, so a test can run code while the call is in
 * progress (move a fake clock, then answer or reject it: b.jg5 SRJ-407's
 * launch-call window). Each may answer `undefined` to leave that call to the
 * verb's other knobs, the queue first, as if it were not set.
 *
 * Plus capture arrays — `<verb>Calls` — for assertion against call shape.
 * Every call is recorded there before any knob answers it.
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
  // A recorded call may be a reuse spawn: its parameters carry the client's
  // `reuse_finished` (`SpawnParams`, b.jg5 SRJ-112, SRJ-708), readable
  // with no cast. The stub answers a reuse like any spawn, from the same
  // queue and knobs.
  spawnResult?: StubSpawnResult
  spawnError?: Error
  spawnQueue?: CannedResponse<StubSpawnResult>[]
  spawnCalls?: SpawnParams[]
  /**
   * Per-call `spawn` answer (b.jg5 SRJ-407), like `getFn`: when supplied, it
   * is called with each call's parameters, after the call is recorded in
   * `spawnCalls`, and takes precedence over `spawnQueue`/`spawnError`/
   * `spawnResult`. It may be async and run test code while the call is in
   * progress (for example, advance a fake clock). Returning (or resolving
   * with) an `Error` rejects the call; a result resolves it; `undefined`
   * leaves the call to the other `spawn` knobs, the queue first, as if no
   * `spawnFn` were set. A reuse spawn reaches it too (its parameters carry
   * `reuse_finished`).
   */
  spawnFn?: (params: SpawnParams) => StubCallAnswer<StubSpawnResult>

  // status() — a result may carry the Phase 1 `launch_started_at`
  // (`cannedStatusResult`). Default: `cannedStatusResult()`, a `waiting` row
  // (no launch start, as on every row but a `pending` one).
  statusResult?: StatusResult
  statusError?: Error
  statusQueue?: CannedResponse<StatusResult>[]
  statusCalls?: StatusParams[]
  /**
   * Dynamic status seam (b.m4r). When supplied, takes precedence over
   * `statusResult`/`statusQueue`/`statusError` and computes the result from the
   * current call params — lets a test model an AD row whose state depends on
   * whether an earlier verb (e.g. the up-front `findMissing` reconcile sweep)
   * has run. Returning an `Error` rejects; returning a `StatusResult` resolves;
   * returning `undefined` leaves the call to the other `status` knobs, the
   * queue first, as if no `statusFn` were set (so a knob that answers for
   * one persona's instance can leave every other instance alone). The call
   * is still recorded in `statusCalls` and `callLog`.
   */
  statusFn?: (params: StatusParams) => StatusResult | Error | undefined

  // get() — a row may carry the Phase 1 `launch_started_at` and
  // `liveness_note` (`cannedGetResult`).
  getResult?: GetResult
  getError?: Error
  getQueue?: CannedResponse<GetResult>[]
  getCalls?: GetParams[]
  /**
   * Computed `get` row, like `statusFn`: when supplied, takes precedence over
   * `getQueue`/`getError`/`getResult` and computes the row from the current
   * call params. Returning an `Error` rejects; returning a row resolves;
   * returning `undefined` leaves the call to the other `get` knobs, the
   * queue first, as if no `getFn` were set. The call is still recorded in
   * `getCalls`.
   */
  getFn?: (params: GetParams) => GetResult | Error | undefined

  // sendKeys()
  sendKeysResult?: SendKeysResult
  sendKeysError?: Error
  sendKeysQueue?: CannedResponse<SendKeysResult>[]
  sendKeysCalls?: SendKeysParams[]
  /**
   * Per-call `send-keys` answer (b.jg5 SRJ-410, SRJ-118), as `spawnFn` is for
   * `spawn`: called with each call's parameters after the call is recorded
   * in `sendKeysCalls`, it takes precedence over `sendKeysQueue`/
   * `sendKeysError`/`sendKeysResult`, may be async, rejects with an `Error`
   * (e.g. `errSpawnNotInteractive('send-keys')`), resolves with a result, and
   * leaves the call to the other `send-keys` knobs on `undefined`. Lets an
   * Enter on a dialog pane clear the dialog and move the row to `waiting`.
   */
  sendKeysFn?: (params: SendKeysParams) => StubCallAnswer<SendKeysResult>

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
  /**
   * Per-call `read-pane` answer (b.jg5 SRJ-410, SRJ-117), as `spawnFn` is for
   * `spawn`: called with each call's parameters (`n_lines`, `allow_pending`
   * included) after the call is recorded in `readPaneCalls`, it takes
   * precedence over `readPaneQueue`/`readPaneError`/`readPaneResults`, may
   * be async, rejects with an `Error`, resolves with a pane, and leaves the
   * call to the other `read-pane` knobs on `undefined`.
   */
  readPaneFn?: (params: ReadPaneParams) => StubCallAnswer<ReadPaneResult>

  // kill() — a result may carry the Phase 1 `kill_sent` (`cannedKillResult`).
  // Default: `{}` (no `kill_sent`, as from a binary older than Phase 1).
  killResult?: StubKillResult
  killError?: Error
  killQueue?: CannedResponse<StubKillResult>[]
  killCalls?: KillParams[]
  /**
   * Per-call `kill` answer (b.jg5 SRJ-412, SRJ-702), as `spawnFn` is for
   * `spawn`: called with each call's parameters after the call is recorded
   * in `killCalls`, it takes precedence over `killQueue`/`killError`/
   * `killResult`, may be async, rejects with an `Error` (e.g.
   * `errTmuxKillFailed()`), resolves with a result (`cannedKillResult`), and
   * leaves the call to the other `kill` knobs on `undefined`. Lets a kill's
   * success end the row the case scripts.
   */
  killFn?: (params: KillParams) => StubCallAnswer<StubKillResult>

  // decide()
  decideResult?: DecideResult
  decideError?: Error
  decideQueue?: CannedResponse<DecideResult>[]
  decideCalls?: DecideParams[]

  // resume() — a result may carry the Phase 1 `pre_trust` (`cannedResumeResult`).
  resumeResult?: StubResumeResult
  resumeError?: Error
  resumeQueue?: CannedResponse<StubResumeResult>[]
  resumeCalls?: ResumeParams[]
  /**
   * Per-call `resume` answer (b.jg5 SRJ-407), as `spawnFn` is for `spawn`:
   * called after the call is recorded in `callLog` and `resumeCalls`, it
   * takes precedence over `resumeQueue`/`resumeError`/`resumeResult`, may be
   * async, rejects with an `Error`, resolves with a result, and leaves the
   * call to the other `resume` knobs on `undefined`.
   */
  resumeFn?: (params: ResumeParams) => StubCallAnswer<StubResumeResult>

  // findMissing() — b.4dk: dead-session recovery runs one findMissing before
  // resume so AD transitions the dead live-state row to `missing`. Defaults to
  // the 0.8.0 zero-transition shape.
  findMissingResult?: FindMissingResult
  findMissingError?: Error
  findMissingQueue?: CannedResponse<FindMissingResult>[]
  findMissingCalls?: FindMissingParams[]
  /**
   * Per-call `find-missing` answer (b.jg5 SRJ-410, SRJ-120), as `spawnFn` is
   * for `spawn`: called with each call's parameters after the call is
   * recorded in `callLog` and `findMissingCalls`, it takes precedence over
   * `findMissingQueue`/`findMissingError`/`findMissingResult`, may be async,
   * rejects with an `Error`, resolves with a result (`cannedFindMissing`,
   * e.g. in its placement form), and leaves the call to the other
   * `find-missing` knobs on `undefined`. Lets a run judge a row only from a
   * given clock time (not judged inside G, marked `missing` after). A stub
   * whose `findMissing` `holdFindMissing` replaced never reaches it.
   */
  findMissingFn?: (params: FindMissingParams) => StubCallAnswer<FindMissingResult>

  // delete() — a tripwire: the client has no `delete` (agent-director 0.11.0
  // moved the verb to its operator tool), so no CSCB path may call one; the
  // stub records any call made on it so a case can assert there was none.
  deleteResult?: StubDeleteResult
  deleteError?: Error
  deleteCalls?: StubDeleteParams[]

  // list() — rows may carry the Phase 1 fields (`cannedListRow`).
  listResult?: ListResult
  listError?: Error
  listQueue?: CannedResponse<ListResult>[]
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

/** The parameters the stub's tripwire `delete` records: the instance ids a call named. */
export interface StubDeleteParams {
  claude_instance_id: string[]
}

/** The stub's tripwire `delete` answer: one outcome per instance id. */
export interface StubDeleteResult {
  results: Record<string, string>
}

/** Structural-typed `Client` stub satisfying every verb CSCB uses. */
export type StubClient = {
  readonly binaryPath: string
  readonly binaryVersion: string
  version(params: VersionParams): Promise<VersionResult>
  makeTemplate(params: MakeTemplateParams): Promise<MakeTemplateResult>
  spawn(params: SpawnParams): Promise<StubSpawnResult>
  status(params: StatusParams): Promise<StatusResult>
  get(params: GetParams): Promise<GetResult>
  sendKeys(params: SendKeysParams): Promise<SendKeysResult>
  readPane(params: ReadPaneParams): Promise<ReadPaneResult>
  kill(params: KillParams): Promise<StubKillResult>
  decide(params: DecideParams): Promise<DecideResult>
  resume(params: ResumeParams): Promise<StubResumeResult>
  findMissing(params: FindMissingParams): Promise<FindMissingResult>
  delete(params: StubDeleteParams): Promise<StubDeleteResult>
  list(params: ListParams): Promise<ListResult>
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
    async spawn(params: SpawnParams): Promise<StubSpawnResult> {
      opts.spawnCalls?.push(params)
      if (opts.spawnFn) {
        const r = await opts.spawnFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('spawn', opts.spawnQueue, opts.spawnResult, opts.spawnError, {
        claude_instance_id: params.claude_instance_id ?? 'cscb_test',
      })
    },
    async status(params: StatusParams): Promise<StatusResult> {
      opts.callLog?.push('status')
      opts.statusCalls?.push(params)
      if (opts.statusFn) {
        const r = opts.statusFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('status', opts.statusQueue, opts.statusResult, opts.statusError, cannedStatusResult())
    },
    async get(params: GetParams): Promise<GetResult> {
      opts.getCalls?.push(params)
      if (opts.getFn) {
        const r = opts.getFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('get', opts.getQueue, opts.getResult, opts.getError, cannedGetResult({
        claude_instance_id: params.claude_instance_id,
      }))
    },
    async sendKeys(params: SendKeysParams): Promise<SendKeysResult> {
      opts.sendKeysCalls?.push(params)
      if (opts.sendKeysFn) {
        const r = await opts.sendKeysFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('send-keys', opts.sendKeysQueue, opts.sendKeysResult, opts.sendKeysError, {})
    },
    async readPane(params: ReadPaneParams): Promise<ReadPaneResult> {
      opts.readPaneCalls?.push(params)
      if (opts.readPaneFn) {
        const r = await opts.readPaneFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
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
    async kill(params: KillParams): Promise<StubKillResult> {
      opts.killCalls?.push(params)
      if (opts.killFn) {
        const r = await opts.killFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('kill', opts.killQueue, opts.killResult, opts.killError, {})
    },
    async decide(params: DecideParams): Promise<DecideResult> {
      opts.decideCalls?.push(params)
      return nextResponse('decide', opts.decideQueue, opts.decideResult, opts.decideError, {})
    },
    async resume(params: ResumeParams): Promise<StubResumeResult> {
      opts.callLog?.push('resume')
      opts.resumeCalls?.push(params)
      if (opts.resumeFn) {
        const r = await opts.resumeFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse('resume', opts.resumeQueue, opts.resumeResult, opts.resumeError, {
        claude_instance_id: params.claude_instance_id,
      })
    },
    async findMissing(params: FindMissingParams): Promise<FindMissingResult> {
      opts.callLog?.push('findMissing')
      opts.findMissingCalls?.push(params)
      if (opts.findMissingFn) {
        const r = await opts.findMissingFn(params)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return nextResponse(
        'find-missing',
        opts.findMissingQueue,
        opts.findMissingResult,
        opts.findMissingError,
        cannedFindMissing(),
      )
    },
    async delete(params: StubDeleteParams): Promise<StubDeleteResult> {
      opts.deleteCalls?.push(params)
      if (opts.deleteError) throw opts.deleteError
      return opts.deleteResult ?? { results: Object.fromEntries(params.claude_instance_id.map((id) => [id, 'ok'])) }
    },
    async list(params: ListParams): Promise<ListResult> {
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
  /** Every `spawn` the stub received, held or not, in call order (a reuse spawn's with its `reuse_finished`). */
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

/** Handle returned by `holdFindMissing`. */
export interface FindMissingHold {
  /** Every `find-missing` call the stub received since the hold, in call order. */
  readonly calls: FindMissingParams[]
  /** How many calls are still held open. */
  heldCount(): number
  /** Resolves once `count` calls (1 by default) have been received since the hold (at once if they were). */
  entered(count?: number): Promise<void>
  /** Resolve the oldest held call with `result` (a placement built with `cannedFindMissing`). */
  release(result: FindMissingResult): void
  /** Reject the oldest held call with `err`. */
  fail(err: Error): void
  /** Resolve every held call with the empty result (`cannedFindMissing()`), for cleanup. */
  releaseAll(): void
}

/**
 * Replace `stub.findMissing` so every call stays open until the test
 * releases or fails it, oldest first. Lets a test keep a `find-missing` run
 * (a live-row sequence's, b.jg5 SRJ-706) outstanding while it drives other
 * work, then settle it with a placement. Held calls are recorded in the
 * handle's `calls`, not in the stub's own call log.
 */
export function holdFindMissing(stub: StubClient): FindMissingHold {
  const calls: FindMissingParams[] = []
  const held: Array<{ resolve: (r: FindMissingResult) => void; reject: (err: Error) => void }> = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const take = () => {
    const oldest = held.shift()
    if (oldest === undefined) throw new Error('holdFindMissing: no held find-missing call')
    return oldest
  }
  stub.findMissing = (params: FindMissingParams): Promise<FindMissingResult> => {
    calls.push(params)
    for (const waiter of waiters.filter((w) => w.count <= calls.length)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
    return new Promise<FindMissingResult>((resolve, reject) => { held.push({ resolve, reject }) })
  }
  return {
    calls,
    heldCount: () => held.length,
    entered: (count = 1) =>
      calls.length >= count ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ count, resolve }) }),
    release: (result) => take().resolve(result),
    fail: (err) => take().reject(err),
    releaseAll: () => {
      for (const h of held.splice(0)) h.resolve(cannedFindMissing())
    },
  }
}

/**
 * Replace `stub.spawn` so each spawn whose instance ID satisfies `shouldHold`
 * (every spawn by default) stays open until the test releases or fails it;
 * any other spawn goes to the stub's original `spawn`. Lets a test keep one
 * persona's launch in flight while it drives a second call.
 */
export function holdSpawns(stub: StubClient, shouldHold: (id: string) => boolean = () => true): SpawnHold {
  const calls: SpawnParams[] = []
  const held: Array<{ id: string; resolve: (r: StubSpawnResult) => void; reject: (err: Error) => void }> = []
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
  stub.spawn = (params: SpawnParams): Promise<StubSpawnResult> => {
    calls.push(params)
    const id = String(params.claude_instance_id)
    entry(id).resolve()
    if (!shouldHold(id)) return original(params)
    return new Promise<StubSpawnResult>((resolve, reject) => { held.push({ id, resolve, reject }) })
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
 * agent-director client, and the spawn home is `homeDir` (its `.claude`
 * directory is created). A prompt row (`ask_user`, `check_permission`) the
 * launch meets is read through the stub's `read-pane` (b.jg5 SRJ-607),
 * whose default answer is a pane: no action.
 * `homeDir` must be under the test's `mkdtempSync` directory. Undo
 * everything with `resetStubSpawnPath` in `afterEach`.
 *
 * A launch through this path that returns success starts the persona's
 * startup-dialog approver on its own (b.jg5 SRJ-401): `spawnForPersona`
 * returns before the approver's first lap, which then reads and types
 * through the same client (`status`, `readPane`, `sendKeys`). Its cap is
 * 200 ms (`_setDialogReadyTimeoutMs`, which caps the approver only); its
 * laps are `DIALOG_POLL_INTERVAL_MS` apart, and its sleeps and cap run on
 * the approver's clock (the real one unless the case sets
 * `_setApproverClock`). A case that counts calls after the launch awaits the
 * approver's stop first (`_whenDialogApproverStopped(key)`).
 */
export function installStubSpawnPath(homeDir: string): StubSpawnPath {
  const calls = makeStubCallLog()
  const client = makeStubClient(calls)
  setClientForTests(client as unknown as Parameters<typeof setClientForTests>[0])
  _setDialogReadyTimeoutMs(200)
  mkdirSync(join(homeDir, '.claude'), { recursive: true })
  _setSpawnHomeDir(homeDir)
  return {
    calls,
    client,
    callCount: () => stubCallCount(calls),
    spawnedIds: () => calls.spawnCalls.map((params) => String(params.claude_instance_id)),
  }
}

/**
 * Undo `installStubSpawnPath`: stop and forget every dialog approver and
 * every launch still marked in flight (`_resetInFlightLaunches`, which runs
 * the session manager's approver reset), so no approver is left running;
 * then restore the approver's real clock (a case may have set
 * `_setApproverClock`) and its cap, the client and the spawn home.
 */
export function resetStubSpawnPath(): void {
  _resetInFlightLaunches()
  resetClientForTests()
  _resetDialogReadyTimeoutMs()
  _resetApproverClock()
  _resetSpawnHomeDir()
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
