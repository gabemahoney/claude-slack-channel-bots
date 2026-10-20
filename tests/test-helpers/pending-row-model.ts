/** AD row and find-missing outcomes for pending launch recovery tests.
 * Read-pane exposes only an opaque outcome; keys never synthesize an AD state transition. */
import { cannedReadPaneResult } from './ad-results.ts'


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
   * The row's `session_id`; the stub's default when unset, which is
   * `''`: the default row has no session id (a finished-row case with one
   * sets it here, or through `row`).
   */
  readonly sessionId?: string
  /** The row's `started_at`; the stub's default when unset. */
  readonly startedAt?: string
  /** Further `get` row overrides (a `cwd` or `labels` that do not match the persona). */
  readonly row?: PersonaGetResultOverrides
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
  /** The row as `status` and `get` answer it now; each throws when there is no row. */
  statusRow(): StatusResult
  getRow(): CannedGetResult
  /** Whether the row carries the `provenance_conflict` note now. */
  note(): boolean
  /** Change the row: its state, its raw launch start, its pane, its judgment, its note, what a `find-missing` run removes. */
  setState(state: PendingRowModelState): void
  setLaunchStartedAt(raw: string | null | undefined): void
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

  let state: PendingRowModelState = options.state ?? AGENT_DIRECTOR_PENDING_STATE
  let launchStartedAt: string | null | undefined = 'launchStartedAt' in options ? options.launchStartedAt : SAMPLE_LAUNCH_START_DEFAULT
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
      ...(options.sessionId === undefined ? {} : { session_id: options.sessionId }),
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

  const ownId = (params: { instance_id?: unknown }): boolean => params.instance_id === id

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
      return cannedReadPaneResult('arbitrary terminal contents')
    },
    sendKeysFn: (params: SendKeysParams): StubCallAnswer<SendKeysResult> => {
      if (!ownId(params)) return earlier.sendKeysFn?.(params)
      applyDueChanges()
      record('send-keys', params)
      const scripted = sendKeysAnswers.shift()
      if (scripted !== undefined) return scripted
      if (state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      if (isFinished(state)) return errSpawnNotInteractive('send-keys')
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
