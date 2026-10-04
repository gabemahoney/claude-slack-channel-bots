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
 *     row shows its launch start.
 *   - `read-pane` answers the pane: a known startup dialog
 *     (`PENDING_ROW_DIALOG_TRUST`, `PENDING_ROW_DIALOG_DEV_CHANNELS`, each
 *     built around the approver's needle, `TRUST_DIALOG_NEEDLE` or
 *     `DEV_CHANNELS_DIALOG_NEEDLE`), a prompt the approver does not know
 *     (`PENDING_ROW_DIALOG_UNRECOGNISED`) or no dialog
 *     (`PENDING_ROW_DIALOG_NONE`, the stub's empty pane); scripted errors
 *     (`readPane`) answer first, in order.
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
 *     (`launches`) in order: an error leaves the row as it is; a success
 *     (`undefined`, and every call once they run out) starts a new launch:
 *     state `pending`, launch start the clock's now (`launchStartText`), the
 *     pane `dialogOnLaunch`, answered with `cannedSpawnResult` or
 *     `cannedResumeResult`.
 *
 * Calls for any other instance go to the knob scripted before the model was
 * installed, then to the verb's other knobs (`statusFn` and `getFn` answer
 * `undefined` for them). Every call the model answers is recorded, read-only,
 * in `calls` (`{ verb, at, state }`: the verb, the clock time, the row's
 * state when it came), and `callTimes(verb)` reads one verb's times, for
 * cadence assertions (AC 33).
 *
 * What it does not model: other rows (only one persona's), `list`,
 * `decide`, `pause` and `delete`, permission prompts, the liveness notes,
 * the pre-spawn scan, agent-director's own grace or bound (the judgment is
 * the case's script), a launch call that takes time (`scriptTimedLaunch` in
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

import type { Phase1GetResult, Phase1KillResult, Phase1ResumeResult, Phase1SpawnParams, Phase1SpawnResult, Phase1StatusResult } from '../../src/ad-phase1-types.ts'
import { adGraceMsInEffect } from '../../src/ad-settings.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING } from '../../src/liveness-reading.ts'
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
  SAMPLE_LAUNCH_START_DEFAULT,
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

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** A verb the model answers, by agent-director's spelling. */
export type PendingRowModelVerb = 'status' | 'get' | 'read-pane' | 'send-keys' | 'find-missing' | 'kill' | 'spawn' | 'resume'

/** One call the model answered: the verb, the clock time it came at and the row's state then. */
export interface PendingRowModelCall {
  readonly verb: PendingRowModelVerb
  readonly at: number
  readonly state: PendingRowModelState
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
  /** The row's `claude_session_id`; the stub's default when unset. */
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
  /** The first `send-keys` answers, in order: an error rejects the call (nothing typed), `undefined` is the model's own answer. */
  readonly sendKeys?: ReadonlyArray<Error | undefined>
  /** The first `kill` answers, in order (`cannedKillResult(...)`, or an error builder's value); `cannedKillResult(true)` after. */
  readonly kill?: ReadonlyArray<Phase1KillResult | Error>
  /** The first `spawn` and `resume` answers, in order: an error rejects the call, `undefined` starts a new launch. */
  readonly launches?: ReadonlyArray<Error | undefined>
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
  statusRow(): Phase1StatusResult
  getRow(): CannedGetResult
  /** Change the row: its state, its raw launch start, its pane, its judgment. */
  setState(state: PendingRowModelState): void
  setLaunchStartedAt(raw: string | null | undefined): void
  setDialog(dialog: PendingRowDialog): void
  setJudgment(judgment: PendingRowJudgment): void
  /** Queue more answers after those still queued (see the options `sendKeys`, `kill` and `launches`). */
  scriptSendKeys(...answers: Array<Error | undefined>): void
  scriptKill(...answers: Array<Phase1KillResult | Error>): void
  scriptLaunches(...answers: Array<Error | undefined>): void
  /** Every call the model answered, in order (read-only). */
  readonly calls: readonly PendingRowModelCall[]
  /** The clock times of one verb's calls, in order. */
  callTimes(verb: PendingRowModelVerb): number[]
}

/** True for a row that is finished (`ended`, `missing`) or gone. */
function isFinished(state: PendingRowModelState): boolean {
  return state === PENDING_ROW_MODEL_NO_ROW || AGENT_DIRECTOR_DEAD_STATES.has(state)
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
  const readPaneAnswers = [...(options.readPane ?? [])]
  const sendKeysAnswers = [...(options.sendKeys ?? [])]
  const killAnswers = [...(options.kill ?? [])]
  const launchAnswers = [...(options.launches ?? [])]
  const calls: PendingRowModelCall[] = []

  const record = (verb: PendingRowModelVerb): void => {
    calls.push({ verb, at: host.clock.now(), state })
  }
  const isPending = (): boolean => state === AGENT_DIRECTOR_PENDING_STATE
  const launchStartMs = (): number | undefined => parseLaunchStart(launchStartedAt)

  const statusRow = (): Phase1StatusResult => {
    if (state === PENDING_ROW_MODEL_NO_ROW) throw new Error(`makePendingRowModel: persona ${key} has no row`)
    return isPending() ? cannedStatusResult({ state, launch_started_at: launchStartedAt }) : cannedStatusResult({ state })
  }
  const getRow = (): CannedGetResult => {
    if (state === PENDING_ROW_MODEL_NO_ROW) throw new Error(`makePendingRowModel: persona ${key} has no row`)
    const overrides: PersonaGetResultOverrides = {
      ...(options.sessionId === undefined ? {} : { claude_session_id: options.sessionId }),
      ...(options.startedAt === undefined ? {} : { started_at: options.startedAt }),
      ...options.row,
      state,
      ...(isPending() ? { launch_started_at: launchStartedAt } : { launch_started_at: undefined }),
    }
    return cannedGetResult(overrides, persona, host.home)
  }

  /** A new launch of the row at the clock's now: `pending`, its launch start now, the launch's pane. */
  const startLaunch = (): void => {
    state = AGENT_DIRECTOR_PENDING_STATE
    launchStartedAt = launchStartText(host.clock.now())
    dialog = dialogOnLaunch
  }
  /** A launch call's answer: the next scripted error, or a new launch answered by `succeed`. */
  const launch = <T>(verb: PendingRowModelVerb, succeed: () => T): T | Error => {
    record(verb)
    const scripted = launchAnswers.shift()
    if (scripted !== undefined) return scripted
    startLaunch()
    return succeed()
  }

  const ownId = (params: { claude_instance_id?: unknown }): boolean => params.claude_instance_id === id

  const knobs: PendingRowModelKnobs = {
    statusFn: (params: StatusParams): Phase1StatusResult | Error | undefined => {
      if (!ownId(params)) return earlier.statusFn?.(params)
      record('status')
      return state === PENDING_ROW_MODEL_NO_ROW ? errSpawnNotFound() : statusRow()
    },
    getFn: (params): Phase1GetResult | Error | undefined => {
      if (!ownId(params)) return earlier.getFn?.(params)
      record('get')
      return state === PENDING_ROW_MODEL_NO_ROW ? errSpawnNotFound() : getRow()
    },
    readPaneFn: (params: ReadPaneParams): StubCallAnswer<ReadPaneResult> => {
      if (!ownId(params)) return earlier.readPaneFn?.(params)
      record('read-pane')
      const scripted = readPaneAnswers.shift()
      if (scripted !== undefined) return scripted
      if (state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      return { pane: pendingRowDialogPane(dialog) }
    },
    sendKeysFn: (params: SendKeysParams): StubCallAnswer<SendKeysResult> => {
      if (!ownId(params)) return earlier.sendKeysFn?.(params)
      record('send-keys')
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
      record('find-missing')
      const earlierAnswer = await earlier.findMissingFn?.(params)
      if (earlierAnswer instanceof Error) return earlierAnswer
      const placement: FindMissingRowPlacement | Error = isPending() ? judgment({ nowMs: host.clock.now(), launchStartMs: launchStartMs() }) : 'neither'
      if (placement instanceof Error) return placement
      if (placement === 'ids') state = LIVENESS_DEAD_ROW_MISSING
      const own = cannedFindMissing({ rows: { [id]: placement } })
      if (earlierAnswer === undefined) return own
      const ids = [...new Set([...earlierAnswer.ids, ...own.ids])].sort()
      const unverifiedIds = [...new Set([...(earlierAnswer.unverified_ids ?? []), ...own.unverified_ids])].sort()
      return { ...earlierAnswer, count: ids.length, ids, unverified: unverifiedIds.length, unverified_ids: unverifiedIds }
    },
    killFn: (params: KillParams): StubCallAnswer<Phase1KillResult> => {
      if (!ownId(params)) return earlier.killFn?.(params)
      record('kill')
      const scripted = killAnswers.shift()
      if (scripted instanceof Error) return scripted
      if (scripted === undefined && state === PENDING_ROW_MODEL_NO_ROW) return errSpawnNotFound()
      if (state !== PENDING_ROW_MODEL_NO_ROW) state = LIVENESS_DEAD_ROW_ENDED
      return scripted ?? cannedKillResult(true)
    },
    spawnFn: (params: Phase1SpawnParams): StubCallAnswer<Phase1SpawnResult> => {
      if (!ownId(params)) return earlier.spawnFn?.(params)
      return launch('spawn', () => cannedSpawnResult(id))
    },
    resumeFn: (params: ResumeParams): StubCallAnswer<Phase1ResumeResult> => {
      if (!ownId(params)) return earlier.resumeFn?.(params)
      return launch('resume', () => cannedResumeResult(id))
    },
  }
  host.script(knobs)

  return {
    key,
    instanceId: id,
    state: () => state,
    launchStartedAt: () => launchStartedAt,
    launchStartMs,
    dialog: () => dialog,
    statusRow,
    getRow,
    setState(next) {
      state = next
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
    scriptSendKeys: (...answers) => {
      sendKeysAnswers.push(...answers)
    },
    scriptKill: (...answers) => {
      killAnswers.push(...answers)
    },
    scriptLaunches: (...answers) => {
      launchAnswers.push(...answers)
    },
    calls,
    callTimes: (verb) => calls.filter((call) => call.verb === verb).map((call) => call.at),
  }
}
