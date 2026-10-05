/**
 * test-helpers/pending-row-model.ts — one persona's scripted agent-director
 * row over the stub's per-call knobs and a fake clock, for the pending-row
 * rule's cases (b.jg5 SRJ-410, SRJ-412; AC 30, AC 32, AC 33, AC 84).
 *
 * What it models
 * --------------
 * One row, the persona's own (`cscb_<key>`): its state, its raw launch start
 * (`launch_started_at`, either form: with or without fractional seconds, or
 * none), its session id (`claude_session_id`), its `started_at`, its `cwd`
 * and labels (the persona's own by default, through the stub's persona-form
 * `cannedGetResult`), and the pane its session shows. It is installed on a
 * stub through the per-call knobs (`statusFn`, `getFn`, `readPaneFn`,
 * `sendKeysFn`, `findMissingFn`, `killFn`, `spawnFn`, `resumeFn`), so each
 * answer follows what was done to the row:
 *
 *   - `status` and `get` read the row (`cannedStatusResult`,
 *     `cannedGetResult`; with no row, `errSpawnNotFound()`). Only a `pending`
 *     row shows its launch start. Scripted answers (`status`, `get`;
 *     `scriptStatus`, `scriptGet`) answer first, in order: an error is a
 *     failed read. `pendingRowOfRecheckReading(reading)` gives the state and
 *     note a latch re-check's step-1 reading reads (E30).
 *   - `read-pane` answers the pane: a known startup dialog
 *     (`PENDING_ROW_DIALOG_TRUST`, `PENDING_ROW_DIALOG_DEV_CHANNELS`, each
 *     built around the approver's needle, `TRUST_DIALOG_NEEDLE` or
 *     `DEV_CHANNELS_DIALOG_NEEDLE`), a prompt the approver does not know
 *     (`PENDING_ROW_DIALOG_UNRECOGNISED`) or no dialog
 *     (`PENDING_ROW_DIALOG_NONE`, the stub's empty pane); scripted errors
 *     (`readPane`, `scriptReadPane`) answer first, in order.
 *   - `send-keys` answers its scripted outcomes (`sendKeys`) in order; once
 *     they run out, a `send-keys` on a pane showing a known dialog clears it
 *     and moves a `pending` row to `waiting` (an unrecognised prompt stays);
 *     on a finished row it answers `errSpawnNotInteractive('send-keys')`.
 *   - `find-missing` follows the judgment (`judgment`): not judged, in
 *     `unverified_ids`, marked `missing` from a clock time (for example G or
 *     B past the row's launch start, read through the accessors at each
 *     call), or a failure. Only a `pending` row is judged; a row marked
 *     `missing` reads `missing` from then on. The row is merged into what
 *     an earlier `findMissingFn` answered.
 *   - `kill` answers its scripted outcomes (`kill`: `cannedKillResult(...)`
 *     or an error builder's value) in order, then `cannedKillResult(true)`;
 *     a success, `kill_sent` true or false, ends the row (`ended`).
 *   - `spawn` (plain or reuse) and `resume` answer their scripted outcomes
 *     in order: each form's own queue first (`plainSpawns`, `reuseSpawns`
 *     for a `spawn` with `reuse_finished: true`, `resumes`) while it holds
 *     an entry, then the queue all forms share (`launches`). An error leaves
 *     the row as it is; a refusal (`PendingRowRefusal`, E30) also leaves the
 *     row as agent-director does: no row after the pre-spawn scan's refusal
 *     (`scanRefusal`), `ended` after "duplicate session"
 *     (`duplicateSessionRefusal`), and for a failed `resume` or reuse (HO
 *     rev 28) the row restored, changed, removed or left `pending`, its
 *     error ending with the matching restore sentence (`restoreRefusal`,
 *     through the stub's `withRestoreSentence` and `RESTORE_SENTENCES`;
 *     `staysPendingLaunchFailure`, the stub's
 *     `errTmuxSessionCreateStaysPending`); a row left `pending` takes the
 *     clock's now as its launch start. A success (`undefined`, and every
 *     call once the queues run out) starts a new launch: state `pending`,
 *     launch start the clock's now (`launchStartText`), the pane
 *     `dialogOnLaunch`, no note, answered with `cannedSpawnResult` or
 *     `cannedResumeResult`.
 *   - The `provenance_conflict` note (E30; b.jg5 SRJ-114): `note` puts it on
 *     the row, shown on `get` only (the stub's `provenanceNote`); a
 *     `find-missing` run removes nothing, the note or the whole row as
 *     `findMissingRemoves` says (`PENDING_ROW_FIND_MISSING_REMOVES_*`, or a
 *     function of the clock and the launch start), whatever the row's state,
 *     before it judges a `pending` row.
 *   - Changes at a clock time (E30; `rowChanges`, `scriptRowChange(at,
 *     change)`): the row's state (no row included), its note, its launch
 *     start, applied in time order before the first call, or read of the
 *     handle, at or after `at` (a live row read `missing`, a `pending` row
 *     whose dialog a human answered read `waiting`, a removed row, a removed
 *     note), so a case drives one row across many latch re-checks.
 *
 * Calls for any other instance go to the knob scripted before the model was
 * installed, then to the verb's other knobs (`statusFn` and `getFn` answer
 * `undefined` for them). Every call the model answers is recorded, read-only,
 * in `calls` (`{ verb, at, state, params }`: the verb, the clock time, the
 * row's state when it came and a copy of the call's parameters, `n_lines`,
 * `allow_pending` and `reuse_finished` among them), and `callTimes(verb)`
 * reads one verb's times, for cadence assertions (AC 33).
 *
 * What it does not model: other rows (only one persona's), `list`,
 * `decide`, `pause` and `delete`, permission prompts, a liveness note other
 * than `provenance_conflict`, the pre-spawn scan on its own (a case scripts
 * its refusal), agent-director's own grace or bound (the judgment is the
 * case's script), a launch call that takes time (`scriptTimedLaunch` in
 * `recovery-harness.ts` does), or what the pane shows once the session runs.
 * A model replaced by a later knob (`h.script({ statusFn })`,
 * `holdFindMissing`) no longer answers that verb.
 *
 * API
 * ---
 * `makePendingRowModel(host, key, options?)` installs the model for persona
 * `key` of `host` (a `RecoveryHarness` fits `PendingRowModelHost` as it is)
 * and answers the handle. For example, a row held at the trust dialog, not
 * judged until G past its launch start, then marked `missing`:
 *
 *   const row = makePendingRowModel(h, key, { dialog: PENDING_ROW_DIALOG_TRUST, judgment: judgeMissingFromG() })
 *   ...
 *   row.callTimes('find-missing') // each run's clock time
 *
 * A latched persona's row across re-checks (E30), each in a few lines:
 *
 *   // a leftover refuses two relaunches, then is gone
 *   makePendingRowModel(h, key, { state: LIVENESS_DEAD_ROW_MISSING, resumes: [refused, refused] })
 *   // a scan refusal with no row, then the spawn succeeds
 *   makePendingRowModel(h, key, { state: PENDING_ROW_MODEL_NO_ROW, plainSpawns: [scanRefusal(scanRow.build())] })
 *   // a refused resume whose row stays pending, then reads ended
 *   const row = makePendingRowModel(h, key, { state: LIVENESS_DEAD_ROW_ENDED, resumes: [restoreRefusal(err, PENDING_ROW_RESTORE_STAYS_PENDING)] })
 *   row.scriptRowChange(at, { state: LIVENESS_DEAD_ROW_ENDED })
 *
 * Every default answer is built by the stub's builders; launch starts are
 * the stub's `SAMPLE_LAUNCH_START*` values or rendered from a clock time
 * by `launchStartText`.
 *
 * Isolation: no top-level `mock.module()`, no real clock (the host's clock
 * only), no module state; every model's state lives in its handle.
 *
 * SPDX-License-Identifier: MIT
 */

import type {
  FindMissingParams,
  FindMissingResult,
  KillParams,
  ReadPaneParams,
  ReadPaneResult,
  ResumeParams,
  SendKeysParams,
  SendKeysResult,
  StatusParams,
} from 'agent-director'

import type { GetResult, SpawnParams, StatusResult } from 'agent-director'
import type { StubKillResult, StubResumeResult, StubSpawnResult } from './agent-director-stub.ts'
import { adGraceMsInEffect } from '../../src/ad-settings.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING } from '../../src/liveness-reading.ts'
import { RECHECK_READING_NO_ROW, RECHECK_READING_STATE, type LatchRecheckReading } from '../../src/conflict-latch.ts'
import { parseLaunchStart } from '../../src/pending-row.ts'
import { personaInstanceId } from '../../src/persona-identity.ts'
import { DEV_CHANNELS_DIALOG_NEEDLE, TRUST_DIALOG_NEEDLE } from '../../src/session-manager.ts'
import {
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedResumeResult,
  cannedSpawnResult,
  cannedStatusResult,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errTmuxSessionCreateStaysPending,
  provenanceNote,
  RESTORE_SENTENCE_STAYS_PENDING,
  RESTORE_SENTENCES,
  SAMPLE_LAUNCH_START_DEFAULT,
  withRestoreSentence,
  type CannedGetResult,
  type CannedRowPersona,
  type FindMissingRowPlacement,
  type PersonaGetResultOverrides,
  type StubCallAnswer,
  type StubClientOptions,
} from './agent-director-stub.ts'

// ---------------------------------------------------------------------------
// The host, the pane and the launch start
// ---------------------------------------------------------------------------

/** The stub knobs the model installs. */
export type PendingRowModelKnobs = Pick<
  StubClientOptions,
  'statusFn' | 'getFn' | 'readPaneFn' | 'sendKeysFn' | 'findMissingFn' | 'killFn' | 'spawnFn' | 'resumeFn'
>

/**
 * Where the model is installed: a clock, the configured personas and the
 * HOME their `config_dir` label is computed against, the stub's knob object
 * (read for the knobs scripted before) and its script entry (which sets
 * knobs the stub reads at each call). A `RecoveryHarness` fits as it is; a
 * bare stub fits as `{ clock, home, config: { personas }, stub: { calls:
 * opts }, script: (knobs) => Object.assign(opts, knobs) }`.
 */
export interface PendingRowModelHost {
  readonly clock: { now(): number }
  readonly home: string
  readonly config: { readonly personas: readonly CannedRowPersona[] }
  readonly stub: { readonly calls: object }
  script(knobs: PendingRowModelKnobs): void
}

/** The pane shows no dialog: the stub's own empty pane. */
export const PENDING_ROW_DIALOG_NONE = 'none'
/** The pane shows the folder-trust dialog (the approver's `TRUST_DIALOG_NEEDLE`). */
export const PENDING_ROW_DIALOG_TRUST = 'trust'
/** The pane shows the dev-channels dialog (the approver's `DEV_CHANNELS_DIALOG_NEEDLE`). */
export const PENDING_ROW_DIALOG_DEV_CHANNELS = 'dev-channels'
/** The pane shows a prompt with none of the approver's needles: Enter never clears it here. */
export const PENDING_ROW_DIALOG_UNRECOGNISED = 'unrecognised'

/** What the row's pane shows. */
export type PendingRowDialog =
  | typeof PENDING_ROW_DIALOG_NONE
  | typeof PENDING_ROW_DIALOG_TRUST
  | typeof PENDING_ROW_DIALOG_DEV_CHANNELS
  | typeof PENDING_ROW_DIALOG_UNRECOGNISED

/** The pane each dialog shows: the known ones carry the approver's needle, the unrecognised one none. */
const DIALOG_PANES: Readonly<Record<PendingRowDialog, string>> = Object.freeze({
  [PENDING_ROW_DIALOG_NONE]: '',
  [PENDING_ROW_DIALOG_TRUST]: `Do you trust the files in this folder?\n\n> 1. ${TRUST_DIALOG_NEEDLE}\n  2. No, exit\n`,
  [PENDING_ROW_DIALOG_DEV_CHANNELS]: `Loading development channels\n\n> 1. ${DEV_CHANNELS_DIALOG_NEEDLE}\n  2. Exit\n`,
  [PENDING_ROW_DIALOG_UNRECOGNISED]: 'Choose an option to continue\n\n> 1. Continue later\n  2. Exit\n',
})

/** The pane text `dialog` shows, as the model's `read-pane` answers it. */
export function pendingRowDialogPane(dialog: PendingRowDialog): string {
  return DIALOG_PANES[dialog]
}

/** Whether `dialog` is one the approver (and the lap) recognises, so an Enter clears it here. */
function isKnownDialog(dialog: PendingRowDialog): boolean {
  return dialog === PENDING_ROW_DIALOG_TRUST || dialog === PENDING_ROW_DIALOG_DEV_CHANNELS
}

/**
 * The launch start agent-director shows for the instant `ms` (ADSRD SR-22.2:
 * RFC 3339 UTC, the milliseconds shown only when they are not zero): a whole
 * second gives the form without fractional seconds, any other instant the
 * fractional form.
 */
export function launchStartText(ms: number): string {
  const iso = new Date(ms).toISOString()
  return ms % 1000 === 0 ? iso.replace(/\.000Z$/, 'Z') : iso
}

/** The model's own spelling of "the row is gone": `status` and `get` answer `errSpawnNotFound()`. */
export const PENDING_ROW_MODEL_NO_ROW = 'no-row'

/** The row's state: a state agent-director names, or no row. */
export type PendingRowModelState = string | typeof PENDING_ROW_MODEL_NO_ROW

// ---------------------------------------------------------------------------
// The judgment of a find-missing run
// ---------------------------------------------------------------------------

/** What a judgment is given at each `find-missing` call on a `pending` row. */
export interface PendingRowJudgmentInput {
  /** The clock's now. */
  readonly nowMs: number
  /** The row's launch start, parsed (`parseLaunchStart`); undefined when it has none. */
  readonly launchStartMs: number | undefined
}

/**
 * How a `find-missing` run judges the `pending` row: where it places it
 * (`'ids'`: marked `missing`; `'unverified_ids'`; `'neither'`: not judged),
 * or an error the whole call rejects with.
 */
export type PendingRowJudgment = (input: PendingRowJudgmentInput) => FindMissingRowPlacement | Error

/** Never judged: every run leaves the row in neither list. */
export const judgeNotJudged: PendingRowJudgment = () => 'neither'

/** Judged but unverified: every run places the row in `unverified_ids`, leaving it `pending`. */
export const judgeUnverified: PendingRowJudgment = () => 'unverified_ids'

/**
 * Not judged before `atMs`, marked `missing` at or after it. `atMs` is a
 * clock time, or a function of the input read at each call (it may answer
 * undefined: never).
 */
export function judgeMissingFrom(atMs: number | ((input: PendingRowJudgmentInput) => number | undefined)): PendingRowJudgment {
  return (input) => {
    const at = typeof atMs === 'number' ? atMs : atMs(input)
    return at !== undefined && input.nowMs >= at ? 'ids' : 'neither'
  }
}

/** Not judged until G (`adGraceMsInEffect`, read at each call) past the row's launch start, then marked `missing`; a row with no launch start never. */
export function judgeMissingFromG(): PendingRowJudgment {
  return judgeMissingFrom(({ launchStartMs }) => (launchStartMs === undefined ? undefined : launchStartMs + adGraceMsInEffect()))
}

/** A `find-missing` run removes nothing of the row (the default). */
export const PENDING_ROW_FIND_MISSING_REMOVES_NOTHING = 'nothing'
/** A `find-missing` run removes the row's `provenance_conflict` note (b.jg5 SRJ-120: a stale note cleared). */
export const PENDING_ROW_FIND_MISSING_REMOVES_NOTE = 'note'
/** A `find-missing` run removes the row: `status` and `get` answer `errSpawnNotFound()` from then on. */
export const PENDING_ROW_FIND_MISSING_REMOVES_ROW = 'row'

/** What a `find-missing` run removes of the row, whatever its state. */
export type PendingRowFindMissingRemoval =
  | typeof PENDING_ROW_FIND_MISSING_REMOVES_NOTHING
  | typeof PENDING_ROW_FIND_MISSING_REMOVES_NOTE
  | typeof PENDING_ROW_FIND_MISSING_REMOVES_ROW

/** What a `find-missing` run removes: one removal for every run, or one decided at each run from the clock and the launch start. */
export type PendingRowFindMissingRemoves = PendingRowFindMissingRemoval | ((input: PendingRowJudgmentInput) => PendingRowFindMissingRemoval)

// ---------------------------------------------------------------------------
// A launch's scripted answers and what a refusal leaves of the row
// ---------------------------------------------------------------------------

/** A refusal's row after: the row as it was before the call (agent-director restored it, or wrote nothing). */
export const PENDING_ROW_MODEL_ROW_RESTORED = 'restored'

/**
 * A launch refused, and the row agent-director leaves after it: a state, no
 * row (`PENDING_ROW_MODEL_NO_ROW`), or the row as it was before the call
 * (`PENDING_ROW_MODEL_ROW_RESTORED`). A row left `pending` takes a launch
 * start at the clock's now (the failed launch's own).
 */
export interface PendingRowRefusal {
  readonly error: Error
  readonly rowAfter: PendingRowModelState | typeof PENDING_ROW_MODEL_ROW_RESTORED
}

/**
 * One scripted answer to a `spawn` (plain or reuse) or a `resume`: an error
 * the call rejects with, leaving the row as it is; a {@link PendingRowRefusal},
 * which also leaves the row as it says; or `undefined`, a success (a new
 * launch).
 */
export type PendingRowLaunchAnswer = Error | PendingRowRefusal | undefined

/**
 * A plain spawn refused by the pre-spawn scan (HO rev 15; b.jg5 SRJ-713):
 * nothing was written and no row created, so no row after it.
 */
export function scanRefusal(error: Error): PendingRowRefusal {
  return Object.freeze({ error, rowAfter: PENDING_ROW_MODEL_NO_ROW })
}

/** A plain spawn refused after "duplicate session" (b.jg5 SRJ-111, SRJ-713): agent-director ended the new row. */
export function duplicateSessionRefusal(error: Error): PendingRowRefusal {
  return Object.freeze({ error, rowAfter: LIVENESS_DEAD_ROW_ENDED })
}

/** HO rev 28's restore of a failed `resume` or reuse: restored to its prior state. */
export const PENDING_ROW_RESTORE_RESTORED = 'restored'
/** HO rev 28's restore: the row changed after the move and was left as it is. */
export const PENDING_ROW_RESTORE_CHANGED = 'changed'
/** HO rev 28's restore: the row was removed, so nothing was restored. */
export const PENDING_ROW_RESTORE_REMOVED = 'removed'
/** HO rev 28's restore: the row could not be restored and stays `pending`. */
export const PENDING_ROW_RESTORE_STAYS_PENDING = 'stays-pending'

/** One of HO rev 28's four restore outcomes of a failed `resume` or reuse. */
export type PendingRowRestore =
  | typeof PENDING_ROW_RESTORE_RESTORED
  | typeof PENDING_ROW_RESTORE_CHANGED
  | typeof PENDING_ROW_RESTORE_REMOVED
  | typeof PENDING_ROW_RESTORE_STAYS_PENDING

/** Every restore outcome, in the order of the stub's `RESTORE_SENTENCES`. */
export const PENDING_ROW_RESTORES: readonly PendingRowRestore[] = Object.freeze([
  PENDING_ROW_RESTORE_RESTORED,
  PENDING_ROW_RESTORE_CHANGED,
  PENDING_ROW_RESTORE_REMOVED,
  PENDING_ROW_RESTORE_STAYS_PENDING,
] as const)

/**
 * The restore sentence each outcome's description ends with: the stub's
 * `RESTORE_SENTENCES`, in their documented order. Checked here, when a case
 * builds a restore refusal, so a stub whose sentences moved fails only the
 * cases that use them.
 */
function restoreSentenceOf(restore: PendingRowRestore): string {
  if (RESTORE_SENTENCES.length !== PENDING_ROW_RESTORES.length || RESTORE_SENTENCES[3] !== RESTORE_SENTENCE_STAYS_PENDING) {
    throw new Error('pending-row-model: the stub\'s RESTORE_SENTENCES no longer hold the four restore outcomes in their documented order')
  }
  return RESTORE_SENTENCES[PENDING_ROW_RESTORES.indexOf(restore)]!
}

/**
 * A failed `resume` or reuse whose row agent-director's restore left as
 * `restore` says (HO rev 28), `error` given the matching restore sentence
 * (the stub's `withRestoreSentence`): restored (the row as it was before the
 * call), changed (to `changedTo`, required), removed (no row), or still
 * `pending`. CSCB keys nothing on the sentence: the row the case reads is
 * the model's.
 */
export function restoreRefusal(error: Parameters<typeof withRestoreSentence>[0], restore: PendingRowRestore, changedTo?: string): PendingRowRefusal {
  if (restore === PENDING_ROW_RESTORE_CHANGED && changedTo === undefined) {
    throw new Error('pending-row-model: a changed restore needs the state the row changed to')
  }
  const rowAfter: PendingRowRefusal['rowAfter'] =
    restore === PENDING_ROW_RESTORE_RESTORED
      ? PENDING_ROW_MODEL_ROW_RESTORED
      : restore === PENDING_ROW_RESTORE_REMOVED
        ? PENDING_ROW_MODEL_NO_ROW
        : restore === PENDING_ROW_RESTORE_STAYS_PENDING
          ? AGENT_DIRECTOR_PENDING_STATE
          : changedTo!
  return Object.freeze({ error: withRestoreSentence(error, restoreSentenceOf(restore)), rowAfter })
}

/**
 * A `resume` or reuse whose launch failed (`ErrTmuxSessionCreate`, a definite
 * failure) and whose row could not be restored and stays `pending`: the
 * stub's `errTmuxSessionCreateStaysPending(verb)`.
 */
export function staysPendingLaunchFailure(verb: string = 'spawn'): PendingRowRefusal {
  return Object.freeze({ error: errTmuxSessionCreateStaysPending(verb), rowAfter: AGENT_DIRECTOR_PENDING_STATE })
}

/**
 * The row a latch re-check's step-1 reading reads (E30; b.jg5 SRJ-505), as
 * the model holds it: its state (`PENDING_ROW_MODEL_NO_ROW` for no row) and
 * whether the note is on it. Undefined for a failed read, which a case
 * scripts as a `status` or `get` error instead (`scriptStatus`,
 * `scriptGet`). For a conflict-cases entry's `reading`.
 */
export function pendingRowOfRecheckReading(reading: LatchRecheckReading): { readonly state: PendingRowModelState; readonly note: boolean } | undefined {
  if (reading.kind === RECHECK_READING_NO_ROW) return { state: PENDING_ROW_MODEL_NO_ROW, note: false }
  if (reading.kind === RECHECK_READING_STATE) return { state: reading.state, note: reading.notePresent === true }
  return undefined
}

/**
 * A change of the row at a clock time (`at`, ms): its state (no row
 * included), its note, its raw launch start, each left as it is when not
 * given. Applied before the first call (or read of the handle) at or after
 * `at`.
 */
export interface PendingRowChange {
  readonly at: number
  readonly state?: PendingRowModelState
  readonly note?: boolean
  readonly launchStartedAt?: string | null | undefined
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** A verb the model answers, by agent-director's spelling. */
export type PendingRowModelVerb = 'status' | 'get' | 'read-pane' | 'send-keys' | 'find-missing' | 'kill' | 'spawn' | 'resume'

/**
 * One call the model answered: the verb, the clock time it came at, the
 * row's state then and the call's parameters as given (a copy:
 * `n_lines`, `allow_pending`, `reuse_finished` and the rest).
 */
export interface PendingRowModelCall {
  readonly verb: PendingRowModelVerb
  readonly at: number
  readonly state: PendingRowModelState
  readonly params: Readonly<Record<string, unknown>>
}

/** Options of `makePendingRowModel`; every one is optional. */
export interface PendingRowModelOptions {
  /** The row's state at first: `pending` when unset; `PENDING_ROW_MODEL_NO_ROW` for no row. */
  readonly state?: PendingRowModelState
  /**
   * The row's raw launch start: `SAMPLE_LAUNCH_START_DEFAULT` when the key is
   * absent; given as `undefined` (`SAMPLE_LAUNCH_START_NONE`: left out of the
   * row) or `null` (shown as `null`), the row has none.
   */
  readonly launchStartedAt?: string | null | undefined
  /**
   * The row's `claude_session_id`; the stub's default when unset, which is
   * `''`: the default row has no session id (a finished-row case with one
   * sets it here, or through `row`).
   */
  readonly sessionId?: string
  /** The row's `started_at`; the stub's default when unset. */
  readonly startedAt?: string
  /** Further `get` row overrides (a `cwd` or `labels` that do not match the persona). */
  readonly row?: PersonaGetResultOverrides
  /** What the pane shows at first: `PENDING_ROW_DIALOG_NONE` when unset. */
  readonly dialog?: PendingRowDialog
  /** What the pane shows after a new launch (`spawn`, `resume`): `dialog` when unset. */
  readonly dialogOnLaunch?: PendingRowDialog
  /** How a `find-missing` run judges the `pending` row: `judgeNotJudged` when unset. */
  readonly judgment?: PendingRowJudgment
  /** The first `read-pane` answers, in order: an error rejects the call, `undefined` answers the pane. */
  readonly readPane?: ReadonlyArray<Error | undefined>
  /** The first `status` answers, in order: an error rejects the call (a failed read), `undefined` answers the row. */
  readonly status?: ReadonlyArray<Error | undefined>
  /** The first `get` answers, in order: an error rejects the call (a failed read), `undefined` answers the row. */
  readonly get?: ReadonlyArray<Error | undefined>
  /** The first `send-keys` answers, in order: an error rejects the call (nothing typed), `undefined` is the model's own answer. */
  readonly sendKeys?: ReadonlyArray<Error | undefined>
  /** The first `kill` answers, in order (`cannedKillResult(...)`, or an error builder's value); `cannedKillResult(true)` after. */
  readonly kill?: ReadonlyArray<StubKillResult | Error>
  /**
   * The first `spawn` and `resume` answers, one queue shared by every form,
   * in order: an error rejects the call, a refusal also leaves the row as it
   * says, `undefined` starts a new launch. A form's own queue below answers
   * first while it holds an entry.
   */
  readonly launches?: ReadonlyArray<PendingRowLaunchAnswer>
  /** The first plain `spawn` answers (no `reuse_finished`), before the shared queue. */
  readonly plainSpawns?: ReadonlyArray<PendingRowLaunchAnswer>
  /** The first reuse `spawn` answers (`reuse_finished: true`), before the shared queue. */
  readonly reuseSpawns?: ReadonlyArray<PendingRowLaunchAnswer>
  /** The first `resume` answers, before the shared queue. */
  readonly resumes?: ReadonlyArray<PendingRowLaunchAnswer>
  /** Whether the row carries the `provenance_conflict` note at first (shown on `get` only); false when unset. */
  readonly note?: boolean
  /** What each `find-missing` run removes of the row, whatever its state: `PENDING_ROW_FIND_MISSING_REMOVES_NOTHING` when unset. */
  readonly findMissingRemoves?: PendingRowFindMissingRemoves
  /** Changes of the row at clock times ({@link PendingRowChange}), applied in time order. */
  readonly rowChanges?: ReadonlyArray<PendingRowChange>
}

/** The handle `makePendingRowModel` answers. */
export interface PendingRowModel {
  /** The persona key and its instance id. */
  readonly key: string
  readonly instanceId: string
  /** The row's state now (`PENDING_ROW_MODEL_NO_ROW` for none). */
  state(): PendingRowModelState
  /** The row's raw launch start now. */
  launchStartedAt(): string | null | undefined
  /** The row's launch start now, parsed (`parseLaunchStart`); undefined when it has none. */
  launchStartMs(): number | undefined
  /** What the pane shows now. */
  dialog(): PendingRowDialog
  /** The row as `status` and `get` answer it now; each throws when there is no row. */
  statusRow(): StatusResult
  getRow(): CannedGetResult
  /** Whether the row carries the `provenance_conflict` note now. */
  note(): boolean
  /** Change the row: its state, its raw launch start, its pane, its judgment, its note, what a `find-missing` run removes. */
  setState(state: PendingRowModelState): void
  setLaunchStartedAt(raw: string | null | undefined): void
  setDialog(dialog: PendingRowDialog): void
  setJudgment(judgment: PendingRowJudgment): void
  setNote(note: boolean): void
  setFindMissingRemoves(removes: PendingRowFindMissingRemoves): void
  /** Queue more answers after those still queued (see the options `status`, `get`, `readPane`, `sendKeys`, `kill`, `launches`, `plainSpawns`, `reuseSpawns` and `resumes`). */
  scriptStatus(...answers: Array<Error | undefined>): void
  scriptGet(...answers: Array<Error | undefined>): void
  scriptReadPane(...answers: Array<Error | undefined>): void
  scriptSendKeys(...answers: Array<Error | undefined>): void
  scriptKill(...answers: Array<StubKillResult | Error>): void
  scriptLaunches(...answers: PendingRowLaunchAnswer[]): void
  scriptPlainSpawns(...answers: PendingRowLaunchAnswer[]): void
  scriptReuseSpawns(...answers: PendingRowLaunchAnswer[]): void
  scriptResumes(...answers: PendingRowLaunchAnswer[]): void
  /** Change the row at clock time `at` (see the option `rowChanges`). */
  scriptRowChange(at: number, change: Omit<PendingRowChange, 'at'>): void
  /** Every call the model answered, in order (read-only). */
  readonly calls: readonly PendingRowModelCall[]
  /** The clock times of one verb's calls, in order. */
  callTimes(verb: PendingRowModelVerb): number[]
}

/** True for a row that is finished (`ended`, `missing`) or gone. */
function isFinished(state: PendingRowModelState): boolean {
  return state === PENDING_ROW_MODEL_NO_ROW || AGENT_DIRECTOR_DEAD_STATES.has(state)
}

/** A launch's form, each with its own scripted queue: a plain spawn, a reuse spawn, a `resume`. */
type LaunchForm = 'plain' | 'reuse' | 'resume'

/** Whether a `spawn` call is a reuse (`reuse_finished: true`). */
function isReuseSpawn(params: SpawnParams): boolean {
  return params.reuse_finished === true
}

/**
 * Install one persona's scripted row on `host`'s stub, for persona `key`
 * (one of `host.config.personas`); see the module comment.
 */
export function makePendingRowModel(host: PendingRowModelHost, key: string, options: PendingRowModelOptions = {}): PendingRowModel {
  const persona = host.config.personas.find((p) => p.key === key)
  if (persona === undefined) throw new Error(`makePendingRowModel: no configured persona ${JSON.stringify(key)}`)
  const id = personaInstanceId(key)
  const before = host.stub.calls as StubClientOptions
  const earlier: PendingRowModelKnobs = {
    statusFn: before.statusFn,
    getFn: before.getFn,
    readPaneFn: before.readPaneFn,
    sendKeysFn: before.sendKeysFn,
    findMissingFn: before.findMissingFn,
    killFn: before.killFn,
    spawnFn: before.spawnFn,
    resumeFn: before.resumeFn,
  }
  const waitingState = cannedStatusResult().state

  let state: PendingRowModelState = options.state ?? AGENT_DIRECTOR_PENDING_STATE
  let launchStartedAt: string | null | undefined = 'launchStartedAt' in options ? options.launchStartedAt : SAMPLE_LAUNCH_START_DEFAULT
  let dialog: PendingRowDialog = options.dialog ?? PENDING_ROW_DIALOG_NONE
  const dialogOnLaunch: PendingRowDialog = options.dialogOnLaunch ?? dialog
  let judgment: PendingRowJudgment = options.judgment ?? judgeNotJudged
  let note = options.note === true
  let findMissingRemoves: PendingRowFindMissingRemoves = options.findMissingRemoves ?? PENDING_ROW_FIND_MISSING_REMOVES_NOTHING
  const readPaneAnswers = [...(options.readPane ?? [])]
  const statusAnswers = [...(options.status ?? [])]
  const getAnswers = [...(options.get ?? [])]
  const sendKeysAnswers = [...(options.sendKeys ?? [])]
  const killAnswers = [...(options.kill ?? [])]
  const launchAnswers: PendingRowLaunchAnswer[] = [...(options.launches ?? [])]
  const formAnswers: Record<LaunchForm, PendingRowLaunchAnswer[]> = {
    plain: [...(options.plainSpawns ?? [])],
    reuse: [...(options.reuseSpawns ?? [])],
    resume: [...(options.resumes ?? [])],
  }
  // Pending row changes, kept in time order (a later one at the same time after an earlier one).
  const rowChanges: PendingRowChange[] = []
  const addRowChange = (change: PendingRowChange): void => {
    const at = rowChanges.findIndex((pending) => pending.at > change.at)
    rowChanges.splice(at === -1 ? rowChanges.length : at, 0, Object.freeze({ ...change }))
  }
  for (const change of options.rowChanges ?? []) addRowChange(change)
  const calls: PendingRowModelCall[] = []

  /** Apply every row change due at the clock's now, in time order. */
  const applyDueChanges = (): void => {
    while (rowChanges.length > 0 && rowChanges[0]!.at <= host.clock.now()) {
      const change = rowChanges.shift()!
      if (change.state !== undefined) state = change.state
      if (change.note !== undefined) note = change.note
      if ('launchStartedAt' in change) launchStartedAt = change.launchStartedAt
      if (state === PENDING_ROW_MODEL_NO_ROW) note = false
    }
  }

  const record = (verb: PendingRowModelVerb, params: object): void => {
    calls.push({ verb, at: host.clock.now(), state, params: Object.freeze({ ...(params as Record<string, unknown>) }) })
  }
  const isPending = (): boolean => state === AGENT_DIRECTOR_PENDING_STATE
  const launchStartMs = (): number | undefined => parseLaunchStart(launchStartedAt)

  const statusRow = (): StatusResult => {
    applyDueChanges()
    if (state === PENDING_ROW_MODEL_NO_ROW) throw new Error(`makePendingRowModel: persona ${key} has no row`)
    return isPending() ? cannedStatusResult({ state, launch_started_at: launchStartedAt }) : cannedStatusResult({ state })
  }
  const getRow = (): CannedGetResult => {
    applyDueChanges()
    if (state === PENDING_ROW_MODEL_NO_ROW) throw new Error(`makePendingRowModel: persona ${key} has no row`)
    const overrides: PersonaGetResultOverrides = {
      ...(options.sessionId === undefined ? {} : { claude_session_id: options.sessionId }),
      ...(options.startedAt === undefined ? {} : { started_at: options.startedAt }),
      ...options.row,
      state,
      ...(isPending() ? { launch_started_at: launchStartedAt } : { launch_started_at: undefined }),
      ...(note ? { liveness_note: provenanceNote } : {}),
    }
    return cannedGetResult(overrides, persona, host.home)
  }

  /** A new launch of the row at the clock's now: `pending`, its launch start now, the launch's pane, no note. */
  const startLaunch = (): void => {
    state = AGENT_DIRECTOR_PENDING_STATE
    launchStartedAt = launchStartText(host.clock.now())
    dialog = dialogOnLaunch
    note = false
  }
  /** The row a refusal leaves (`PendingRowRefusal.rowAfter`); a row left `pending` takes the failed launch's own launch start. */
  const leaveRow = (rowAfter: PendingRowRefusal['rowAfter']): void => {
    if (rowAfter === PENDING_ROW_MODEL_ROW_RESTORED) return
    state = rowAfter
    if (state === PENDING_ROW_MODEL_NO_ROW) note = false
    if (isPending()) launchStartedAt = launchStartText(host.clock.now())
  }
  /**
   * A launch call's answer: the next scripted one (its form's queue first,
   * then the shared queue), or a new launch answered by `succeed`.
   */
  const launch = <T>(verb: PendingRowModelVerb, form: LaunchForm, params: object, succeed: () => T): T | Error => {
    record(verb, params)
    const queue = formAnswers[form]
    const scripted = queue.length > 0 ? queue.shift() : launchAnswers.shift()
    if (scripted === undefined) {
      startLaunch()
      return succeed()
    }
    if (scripted instanceof Error) return scripted
    leaveRow(scripted.rowAfter)
    return scripted.error
  }

  const ownId = (params: { claude_instance_id?: unknown }): boolean => params.claude_instance_id === id

  const knobs: PendingRowModelKnobs = {
    statusFn: (params: StatusParams): StatusResult | Error | undefined => {
      if (!ownId(params)) return earlier.statusFn?.(params)
      applyDueChanges()
      record('status', params)
      const scripted = statusAnswers.shift()
      if (scripted !== undefined) return scripted
      return state === PENDING_ROW_MODEL_NO_ROW ? errSpawnNotFound() : statusRow()
    },
    getFn: (params): GetResult | Error | undefined => {
      if (!ownId(params)) return earlier.getFn?.(params)
      applyDueChanges()
      record('get', params)
      const scripted = getAnswers.shift()
      if (scripted !== undefined) return scripted
      return state === PENDING_ROW_MODEL_NO_ROW ? errSpawnNotFound() : getRow()
    },
    readPaneFn: (params: ReadPaneParams): StubCallAnswer<ReadPaneResult> => {
      if (!ownId(params)) return earlier.readPaneFn?.(params)
      applyDueChanges()
      record('read-pane', params)
      const scripted = readPaneAnswers.shift()
      if (scripted !== undefined) return scripted
      if (state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      return { pane: pendingRowDialogPane(dialog) }
    },
    sendKeysFn: (params: SendKeysParams): StubCallAnswer<SendKeysResult> => {
      if (!ownId(params)) return earlier.sendKeysFn?.(params)
      applyDueChanges()
      record('send-keys', params)
      const scripted = sendKeysAnswers.shift()
      if (scripted !== undefined) return scripted
      if (state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      if (isFinished(state)) return errSpawnNotInteractive('send-keys')
      if (isKnownDialog(dialog)) {
        dialog = PENDING_ROW_DIALOG_NONE
        if (isPending()) state = waitingState
      }
      return {}
    },
    findMissingFn: async (params: FindMissingParams): Promise<FindMissingResult | Error | undefined> => {
      applyDueChanges()
      record('find-missing', params)
      const earlierAnswer = await earlier.findMissingFn?.(params)
      if (earlierAnswer instanceof Error) return earlierAnswer
      const input = (): PendingRowJudgmentInput => ({ nowMs: host.clock.now(), launchStartMs: launchStartMs() })
      const removal = typeof findMissingRemoves === 'function' ? findMissingRemoves(input()) : findMissingRemoves
      if (removal === PENDING_ROW_FIND_MISSING_REMOVES_NOTE) note = false
      if (removal === PENDING_ROW_FIND_MISSING_REMOVES_ROW) {
        state = PENDING_ROW_MODEL_NO_ROW
        note = false
      }
      const placement: FindMissingRowPlacement | Error = isPending() ? judgment(input()) : 'neither'
      if (placement instanceof Error) return placement
      if (placement === 'ids') state = LIVENESS_DEAD_ROW_MISSING
      const own = cannedFindMissing({ rows: { [id]: placement } })
      if (earlierAnswer === undefined) return own
      const ids = [...new Set([...earlierAnswer.ids, ...own.ids])].sort()
      const unverifiedIds = [...new Set([...(earlierAnswer.unverified_ids ?? []), ...own.unverified_ids])].sort()
      return { ...earlierAnswer, count: ids.length, ids, unverified: unverifiedIds.length, unverified_ids: unverifiedIds }
    },
    killFn: (params: KillParams): StubCallAnswer<StubKillResult> => {
      if (!ownId(params)) return earlier.killFn?.(params)
      applyDueChanges()
      record('kill', params)
      const scripted = killAnswers.shift()
      if (scripted instanceof Error) return scripted
      if (scripted === undefined && state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      if (state !== PENDING_ROW_MODEL_NO_ROW) state = LIVENESS_DEAD_ROW_ENDED
      return scripted ?? cannedKillResult(true)
    },
    spawnFn: (params: SpawnParams): StubCallAnswer<StubSpawnResult> => {
      if (!ownId(params)) return earlier.spawnFn?.(params)
      applyDueChanges()
      return launch('spawn', isReuseSpawn(params) ? 'reuse' : 'plain', params, () => cannedSpawnResult(id))
    },
    resumeFn: (params: ResumeParams): StubCallAnswer<StubResumeResult> => {
      if (!ownId(params)) return earlier.resumeFn?.(params)
      applyDueChanges()
      return launch('resume', 'resume', params, () => cannedResumeResult(id))
    },
  }
  host.script(knobs)

  return {
    key,
    instanceId: id,
    state: () => {
      applyDueChanges()
      return state
    },
    launchStartedAt: () => {
      applyDueChanges()
      return launchStartedAt
    },
    launchStartMs: () => {
      applyDueChanges()
      return launchStartMs()
    },
    dialog: () => dialog,
    note: () => {
      applyDueChanges()
      return note
    },
    statusRow,
    getRow,
    setState(next) {
      state = next
      if (state === PENDING_ROW_MODEL_NO_ROW) note = false
    },
    setLaunchStartedAt(raw) {
      launchStartedAt = raw
    },
    setDialog(next) {
      dialog = next
    },
    setJudgment(next) {
      judgment = next
    },
    setNote(next) {
      note = next
    },
    setFindMissingRemoves(next) {
      findMissingRemoves = next
    },
    scriptStatus: (...answers) => {
      statusAnswers.push(...answers)
    },
    scriptGet: (...answers) => {
      getAnswers.push(...answers)
    },
    scriptReadPane: (...answers) => {
      readPaneAnswers.push(...answers)
    },
    scriptSendKeys: (...answers) => {
      sendKeysAnswers.push(...answers)
    },
    scriptKill: (...answers) => {
      killAnswers.push(...answers)
    },
    scriptLaunches: (...answers) => {
      launchAnswers.push(...answers)
    },
    scriptPlainSpawns: (...answers) => {
      formAnswers.plain.push(...answers)
    },
    scriptReuseSpawns: (...answers) => {
      formAnswers.reuse.push(...answers)
    },
    scriptResumes: (...answers) => {
      formAnswers.resume.push(...answers)
    },
    scriptRowChange(at, change) {
      addRowChange({ ...change, at })
    },
    calls,
    callTimes: (verb) => calls.filter((call) => call.verb === verb).map((call) => call.at),
  }
}
