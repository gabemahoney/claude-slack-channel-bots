/**
 * checked-kill.ts — A kill's outcome, its class under b.jg5 SRJ-110, whether
 * the caller's next step may run, one checked kill, and its log rendering
 * (b.jg5 SRJ-110, SRJ-701, SRJ-703).
 *
 * Every kill reports its outcome to its caller, `kill_sent` included (SRJ-701).
 * Only a success lets the caller's next step (a launch, a reuse, a delete)
 * run; `ErrSpawnNotFound` and a GONE answer count as success. Every other
 * outcome keeps the row and follows its class: retry later, latch, or outage.
 * The caller decides that by its own context; this module decides nothing
 * beyond the outcome. One caller rule changes the outcome itself: a caller
 * for which a GONE answer is no success (the CLI's teardown, SRJ-904) passes
 * {@link CheckedKillOptions.goneIsFailure}, and the GONE answer is then the
 * GONE non-success ({@link KillFailureGone}) instead of `session-gone`.
 *
 * The outcome ({@link KillOutcome}):
 *   - a success ({@link KillSuccess}):
 *       `killed`        the kill call resolved; `killSent` is the result's
 *                       `kill_sent` (true or false), or absent from a result
 *                       of a binary older than Phase 1. `kill_sent: false`
 *                       raises nothing by itself (SRJ-703): another row's
 *                       session, another agent-director store's or one with
 *                       no valid label holding the name is GONE for the row;
 *       `row-gone`      the kill answered `ErrSpawnNotFound`: the row is
 *                       already gone;
 *       `session-gone`  the kill answered GONE (`ErrTmuxSendKeys`,
 *                       `ErrTmuxCaptureFailed`): agent-director found the
 *                       tmux session gone. For `kill`, gone is success
 *                       (SRJ-104, SRJ-110); `name` is the GONE name. Not
 *                       given under `goneIsFailure`;
 *       `row-finished`  a `status` read of the row between tries read it
 *                       `ended` or `missing`, or answered `ErrSpawnNotFound`
 *                       (SRJ-110, SRJ-702). No code here makes that read: the
 *                       bounded retry (`src/kill-retry.ts`) gives this form;
 *   - a non-success ({@link KillFailure}, `not-killed`), with the thrown
 *     value kept for the caller's own handling and one SRJ-110 class:
 *     UNAVAILABLE (`ErrTmuxKillFailed`, told apart as `killFailed` with its
 *     description, read raw through `killFailedDescriptionOf`; and every
 *     other UNAVAILABLE value), CONFLICT, UNUSABLE_NAME, CONFIG, ENVIRONMENT
 *     or UNCLASSIFIED; and, only under `goneIsFailure`, GONE (its name
 *     kept as `name`). A value of a class SRJ-110 gives no row (LAUNCH
 *     FAILURE, a STATE name other than `ErrSpawnNotFound`, DIRECTORY) is
 *     UNCLASSIFIED, its classifier class kept as `unlistedClass`, so a caller
 *     inside a launch or recovery attempt reports it as an UNCLASSIFIED
 *     outcome (SRJ-105, SRJ-313): no step follows it. `ErrInvalidFlags` is
 *     one of them (STATE); its caller makes the immediate version re-check
 *     (SRJ-104, SRJ-204), which this module never makes, and records the
 *     re-check's answer kind as `recheck`; a `stop` answer
 *     ({@link killOutcomeStopsServer}) means the server stops, and the caller
 *     does nothing more (SRJ-205).
 * Every class is decided by name through `src/ad-error-class.ts`
 * (`classifyAdError`, `hasAdErrorName`); no `instanceof` decides one.
 *
 * {@link checkedKill} makes exactly one plain `kill` call through the
 * injected call, with `claude_instance_id` alone (CSCB never sets
 * `include_finished`, SRJ-106), and answers the outcome. It never throws and
 * never retries. Every server site calls it with no options: GONE is the
 * `session-gone` success there.
 *
 * {@link describeKillOutcome} renders an outcome for one log line: its form,
 * its class (and the unlisted class it came from), `kill_sent` when present,
 * the re-check's answer when one was made, and any description only through
 * the shared redaction (`renderLogMessageText`, `describeAgentDirectorFailure`).
 * Beside it, the two notices built from a kill's outcome where nothing
 * latches on it (SRJ-1002, SRJ-1003, SRJ-811): {@link teardownKillRefusalNoticeText}
 * for a CONFLICT or an UNUSABLE NAME answer met at a try or at a read
 * between tries, and {@link teardownKillNotSucceededNoticeText} for a
 * non-success after the tries that no other notice records.
 *
 * SRJ-110's sites that take the checked kill (each with the result checked):
 *   - the restart path's kill before a relaunch (`_buildKillSessionAdapter`,
 *     `src/server.ts`, through `killPersonaInstance` in the bounded retry,
 *     `src/kill-retry.ts`);
 *   - the live-row sequence's two kills (`src/live-row-sequence.ts`, bound
 *     by `buildLiveRowSequenceDeps` in `src/session-manager.ts` to
 *     `killPersonaInstance` in the bounded retry); the collision ladder
 *     makes no kill of its own;
 *   - the start sweep's kills (`reconcileOrphans`, `src/session-manager.ts`,
 *     on the sweep's own client, in the bounded retry with the pass budget);
 *   - the persona teardown's kill (`runTeardown`, `src/persona-lifecycle.ts`,
 *     through `killPersonaInstance`).
 *
 * The module holds no state, makes no version re-check (that is the
 * caller's) and loads no server-only module (no notifier, outage state, Slack
 * client, latch, episodes or server module), so the CLI process can use it
 * too.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_GONE_ERR_NAMES,
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  hasAdErrorName,
  killFailedDescriptionOf,
} from './ad-error-class.ts'
import type { Phase1KillResult } from './ad-phase1-types.ts'
import { RECHECK_OUTCOME_STOP, type AdVersionRecheckTriggerAnswer } from './ad-version-gate.ts'
import { ERR_SPAWN_NOT_FOUND_NAME, ERR_TMUX_KILL_FAILED_NAME } from './agent-director-errors.ts'
import { describeLogMessage } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/** Success: the kill call resolved (SRJ-110's three `kill_sent` rows). */
export const KILL_OUTCOME_KILLED = 'killed'
/** Success: the kill answered `ErrSpawnNotFound`; the row is already gone. */
export const KILL_OUTCOME_ROW_GONE = 'row-gone'
/** Success: the kill answered GONE; agent-director found the tmux session gone (SRJ-104, SRJ-110). */
export const KILL_OUTCOME_SESSION_GONE = 'session-gone'
/** Success: a `status` read between tries found the row finished (SRJ-702). */
export const KILL_OUTCOME_ROW_FINISHED = 'row-finished'
/** Non-success: the kill answered an error of one of SRJ-110's non-success classes. */
export const KILL_OUTCOME_NOT_KILLED = 'not-killed'

/** What a `status` read between tries found, when it ended the tries as a success. */
export const KILL_ROW_FINISHED_ENDED = 'ended'
/** The row read `missing`. */
export const KILL_ROW_FINISHED_MISSING = 'missing'
/** The read answered `ErrSpawnNotFound`. */
export const KILL_ROW_FINISHED_NO_ROW = 'no-row'
/**
 * An old-life wait's kill only (SRJ-702, SRJ-811; option A): the hold the
 * kill serves ended while its tries ran, because another call read the old
 * row finished; the tries end as a success, as a finished read does.
 */
export const KILL_ROW_FINISHED_HOLD_ENDED = 'hold-ended'

/** What ended the tries as a success: a `status` read between tries, or an old-life wait's hold's end. */
export type KillRowFinishedRead =
  | typeof KILL_ROW_FINISHED_ENDED
  | typeof KILL_ROW_FINISHED_MISSING
  | typeof KILL_ROW_FINISHED_NO_ROW
  | typeof KILL_ROW_FINISHED_HOLD_ENDED

/** A success with a kill result. `killSent` is absent from a binary older than Phase 1. */
export interface KillKilled {
  readonly kind: typeof KILL_OUTCOME_KILLED
  readonly killSent?: boolean
}

/** A success because the kill answered `ErrSpawnNotFound`. */
export interface KillRowGone {
  readonly kind: typeof KILL_OUTCOME_ROW_GONE
}

/**
 * A success because the kill answered GONE (`ErrTmuxSendKeys`,
 * `ErrTmuxCaptureFailed`): for `kill`, gone is success (SRJ-104, SRJ-110).
 * `name` is the GONE name, absent when it cannot be read.
 */
export interface KillSessionGone {
  readonly kind: typeof KILL_OUTCOME_SESSION_GONE
  readonly name?: string
}

/** A success because a `status` read between tries found the row finished, or an old-life wait's hold ended. */
export interface KillRowFinished {
  readonly kind: typeof KILL_OUTCOME_ROW_FINISHED
  readonly read: KillRowFinishedRead
}

/** Every success form: the caller's next step may run. */
export type KillSuccess = KillKilled | KillRowGone | KillSessionGone | KillRowFinished

/** SRJ-110's non-success classes. */
export const KILL_FAILURE_CLASSES = [
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNCLASSIFIED,
] as const

/** One of SRJ-110's non-success classes. */
export type KillFailureClass = (typeof KILL_FAILURE_CLASSES)[number]

/** An UNAVAILABLE non-success. */
export interface KillFailureUnavailable {
  readonly kind: typeof KILL_OUTCOME_NOT_KILLED
  readonly errorClass: typeof AD_ERROR_CLASS_UNAVAILABLE
  /** The thrown value, for the caller's own handling. Never logged raw. */
  readonly error: unknown
  /** True for `ErrTmuxKillFailed` (by name), false for any other UNAVAILABLE value. */
  readonly killFailed: boolean
  /**
   * `ErrTmuxKillFailed` only: agent-director's description, raw
   * (`killFailedDescriptionOf`), when it is a string. Redacted before any
   * log line, record or notice.
   */
  readonly killFailedDescription?: string
}

/**
 * The classifier classes SRJ-110 has no row for at a kill: LAUNCH FAILURE, a
 * STATE name other than `ErrSpawnNotFound` (`ErrInvalidFlags` included) and
 * DIRECTORY. A kill outcome of one of them is UNCLASSIFIED.
 */
export const KILL_UNLISTED_CLASSES = [
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_DIRECTORY,
] as const

/** One class SRJ-110 has no row for at a kill. */
export type KillUnlistedClass = (typeof KILL_UNLISTED_CLASSES)[number]

/** The immediate version re-check's answer kind (SRJ-204). */
export type KillRecheckKind = AdVersionRecheckTriggerAnswer['kind']

/** A non-success of any other class. */
export interface KillFailureOther {
  readonly kind: typeof KILL_OUTCOME_NOT_KILLED
  readonly errorClass: Exclude<KillFailureClass, typeof AD_ERROR_CLASS_UNAVAILABLE>
  /** The thrown value, for the caller's own handling. Never logged raw. */
  readonly error: unknown
  /**
   * UNCLASSIFIED only: the classifier's class when SRJ-110 has no row for it
   * (`KILL_UNLISTED_CLASSES`); absent for a value the classifier itself
   * answers UNCLASSIFIED. Inside a launch or recovery attempt the caller
   * reports such an outcome as UNCLASSIFIED (SRJ-105, SRJ-313).
   */
  readonly unlistedClass?: KillUnlistedClass
  /**
   * `ErrInvalidFlags` only: the answer kind of the immediate version
   * re-check its caller made (SRJ-104, SRJ-204).
   * `stop` means the server stops and the caller does nothing more (SRJ-205).
   * Never set by {@link checkedKill} or {@link killOutcomeOf}.
   */
  readonly recheck?: KillRecheckKind
}

/**
 * A non-success because the kill answered GONE (`ErrTmuxSendKeys`,
 * `ErrTmuxCaptureFailed`) for a caller that counts GONE as no success
 * ({@link CheckedKillOptions.goneIsFailure}; the CLI's teardown, SRJ-904).
 * Only that option gives it; a server site never sees one. `name` is the GONE
 * name, absent when it cannot be read. It is not UNAVAILABLE, so the bounded
 * retry never tries it again (SRJ-702).
 */
export interface KillFailureGone {
  readonly kind: typeof KILL_OUTCOME_NOT_KILLED
  readonly errorClass: typeof AD_ERROR_CLASS_GONE
  /** The thrown value, for the caller's own handling. Never logged raw. */
  readonly error: unknown
  readonly name?: string
}

/** Every non-success: no launch, reuse or delete may follow. */
export type KillFailure = KillFailureUnavailable | KillFailureOther

/** A kill's outcome (SRJ-110, SRJ-701). */
export type KillOutcome = KillSuccess | KillFailure

/** Every non-success form, the GONE non-success of {@link CheckedKillOptions.goneIsFailure} included. */
export type AnyKillFailure = KillFailure | KillFailureGone

/**
 * Every outcome form, the GONE non-success of
 * {@link CheckedKillOptions.goneIsFailure} included. A call with no options
 * answers a {@link KillOutcome}, so a server site's type never holds the
 * GONE non-success.
 */
export type AnyKillOutcome = KillOutcome | KillFailureGone

/** How a kill settled: its result, or what it threw. */
export type KillSettled = { readonly result: unknown } | { readonly thrown: unknown }

/** A caller's rule for what a kill's answer means. Absent, or every field absent: SRJ-110's server rules. */
export interface CheckedKillOptions {
  /**
   * True: a GONE answer is the GONE non-success ({@link KillFailureGone}),
   * not the `session-gone` success, so it lets no next step run and the
   * bounded retry ends at once on it (only UNAVAILABLE is tried again). For a
   * caller where only SRJ-110's success forms count, the CLI's teardown
   * (SRJ-904). Absent or false: `session-gone`.
   */
  readonly goneIsFailure?: boolean
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const FAILURE_CLASSES: ReadonlySet<string> = new Set<string>(KILL_FAILURE_CLASSES)

const UNLISTED_CLASSES: ReadonlySet<string> = new Set<string>(KILL_UNLISTED_CLASSES)

/**
 * The outcome of a kill that settled as `settled` (SRJ-110). A result is a
 * success with its `kill_sent` kept as given (absent when the result has no
 * boolean `kill_sent`). A thrown `ErrSpawnNotFound` (by name) is the
 * `row-gone` success, and a thrown GONE value the `session-gone` success
 * (SRJ-104: for `kill`, gone is success), or the GONE non-success under
 * `options.goneIsFailure`; any other thrown value is a
 * non-success of the class `classifyAdError` answers by name, a class SRJ-110
 * has no row for counting as UNCLASSIFIED with that class kept as
 * `unlistedClass`. Pure; never throws.
 */
export function killOutcomeOf(settled: KillSettled): KillOutcome
export function killOutcomeOf(settled: KillSettled, options: CheckedKillOptions): AnyKillOutcome
export function killOutcomeOf(settled: KillSettled, options?: CheckedKillOptions): AnyKillOutcome {
  try {
    if ('result' in settled) return killedOutcome(settled.result)
    return thrownOutcome(settled.thrown, options?.goneIsFailure === true)
  } catch {
    return { kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error: undefined }
  }
}

/** The success for a settled kill result. */
function killedOutcome(result: unknown): KillKilled {
  const killSent = readKillSent(result)
  return killSent === undefined ? { kind: KILL_OUTCOME_KILLED } : { kind: KILL_OUTCOME_KILLED, killSent }
}

/** A result's `kill_sent` when it is a boolean; `undefined` otherwise or when the read throws. */
function readKillSent(result: unknown): boolean | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  try {
    const killSent = (result as Phase1KillResult).kill_sent
    return typeof killSent === 'boolean' ? killSent : undefined
  } catch {
    return undefined
  }
}

/** The outcome for a value a kill threw; a GONE value is a non-success when `goneIsFailure`. */
function thrownOutcome(error: unknown, goneIsFailure: boolean): AnyKillOutcome {
  if (hasAdErrorName(error, ERR_SPAWN_NOT_FOUND_NAME)) return { kind: KILL_OUTCOME_ROW_GONE }
  const { errorClass } = classifyAdError(error)
  if (errorClass === AD_ERROR_CLASS_GONE) {
    const name = AD_GONE_ERR_NAMES.find((goneName) => hasAdErrorName(error, goneName))
    const named = name === undefined ? {} : { name }
    return goneIsFailure
      ? { kind: KILL_OUTCOME_NOT_KILLED, errorClass, error, ...named }
      : { kind: KILL_OUTCOME_SESSION_GONE, ...named }
  }
  if (errorClass === AD_ERROR_CLASS_UNAVAILABLE) {
    const killFailedDescription = killFailedDescriptionOf(error)
    const killFailed = killFailedDescription !== undefined || hasAdErrorName(error, ERR_TMUX_KILL_FAILED_NAME)
    return {
      kind: KILL_OUTCOME_NOT_KILLED,
      errorClass,
      error,
      killFailed,
      ...(killFailedDescription !== undefined ? { killFailedDescription } : {}),
    }
  }
  if (FAILURE_CLASSES.has(errorClass)) {
    return { kind: KILL_OUTCOME_NOT_KILLED, errorClass: errorClass as KillFailureOther['errorClass'], error }
  }
  return UNLISTED_CLASSES.has(errorClass)
    ? { kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error, unlistedClass: errorClass as KillUnlistedClass }
    : { kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const SUCCESS_KINDS: ReadonlySet<unknown> = new Set<unknown>([
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_OUTCOME_ROW_FINISHED,
])

/** `value.kind`, or `undefined` when `value` is not an object or the read throws. */
function kindOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    return (value as { kind?: unknown }).kind
  } catch {
    return undefined
  }
}

/**
 * True only for a success form (`killed`, any `kill_sent`; `row-gone`;
 * `session-gone`; `row-finished`): the caller's next step may run (SRJ-701). False for every
 * non-success and for any value that is not a kill outcome, so an answer
 * that is not an outcome never lets a launch, reuse or delete follow. Never
 * throws.
 */
export function killLetsNextStepRun(outcome: unknown): outcome is KillSuccess {
  return SUCCESS_KINDS.has(kindOf(outcome))
}

/** True when `value` is a kill outcome of any form. Never throws. */
export function isKillOutcome(value: unknown): value is KillOutcome {
  const kind = kindOf(value)
  return SUCCESS_KINDS.has(kind) || kind === KILL_OUTCOME_NOT_KILLED
}

/**
 * True when `value` is a non-success whose immediate version re-check, after
 * an `ErrInvalidFlags`, decided that the server stops (`recheck` is `stop`,
 * SRJ-204, SRJ-205): the caller does nothing more. False for every other
 * value. Never throws.
 */
export function killOutcomeStopsServer(value: unknown): boolean {
  if (kindOf(value) !== KILL_OUTCOME_NOT_KILLED) return false
  try {
    return (value as { recheck?: unknown }).recheck === RECHECK_OUTCOME_STOP
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// One checked kill
// ---------------------------------------------------------------------------

/** A kill call's parameters: the instance id alone, so the kill is plain (no `include_finished`, SRJ-106). */
export interface PlainKillParams {
  readonly claude_instance_id: string
}

/** An injected kill call: one agent-director `kill` with `params`. */
export type KillCall = (params: PlainKillParams) => Promise<unknown>

/**
 * One checked kill of `instanceId` (SRJ-110, SRJ-701): exactly one call of
 * `kill` with `{ claude_instance_id: instanceId }` and nothing else, and its
 * outcome (`killOutcomeOf`, under `options`). A call that throws,
 * synchronously or by rejecting, gives the outcome of what it threw. Never
 * throws or rejects, and never retries.
 */
export function checkedKill(instanceId: string, kill: KillCall): Promise<KillOutcome>
export function checkedKill(instanceId: string, kill: KillCall, options: CheckedKillOptions): Promise<AnyKillOutcome>
export async function checkedKill(instanceId: string, kill: KillCall, options?: CheckedKillOptions): Promise<AnyKillOutcome> {
  let result: unknown
  try {
    result = await kill({ claude_instance_id: instanceId })
  } catch (thrown) {
    return killOutcomeOf({ thrown }, options ?? {})
  }
  return killOutcomeOf({ result }, options ?? {})
}

// ---------------------------------------------------------------------------
// Log rendering
// ---------------------------------------------------------------------------

/**
 * One line's rendering of a kill outcome (b.jg5 SRJ-701, SRJ-1014):
 *   `outcome=killed kill_sent=true` (or `kill_sent=false`, or
 *   `kill_sent=absent` for a result with no `kill_sent`);
 *   `outcome=row-gone (ErrSpawnNotFound)`;
 *   `outcome=session-gone (<GONE name>)`, or `outcome=session-gone` when
 *   the name cannot be read;
 *   `outcome=row-finished read=<ended|missing|no-row|hold-ended>`;
 *   `outcome=not-killed class=<class> <name> message="…"`, the name and
 *   message by `describeAgentDirectorFailure` (the GONE non-success
 *   included: `outcome=not-killed class=GONE ErrTmuxSendKeys message="…"`);
 *   for a class SRJ-110 has no
 *   row for, `outcome=not-killed class=UNCLASSIFIED from=<class> <name>
 *   message="…"`, followed by ` recheck=<kind>` when an immediate version
 *   re-check was made after an `ErrInvalidFlags`; for a value whose
 *   classification carries a reported name or message (UNUSABLE NAME,
 *   CONFIG, UNCLASSIFIED), `outcome=not-killed class=<class> name=<name>
 *   message="…"` from the classification's own fields
 *   (`describeAdErrorClassification`); for `ErrTmuxKillFailed`,
 *   `outcome=not-killed class=UNAVAILABLE ErrTmuxKillFailed message="…"`
 *   with its description.
 * Every description goes through the shared redaction, on one line and
 * capped (`renderLogMessageText`); a name appears only when it is a safe
 * identifier; no raw thrown value is rendered. Never throws.
 */
export function describeKillOutcome(outcome: AnyKillOutcome): string {
  try {
    switch (outcome.kind) {
      case KILL_OUTCOME_KILLED:
        return `outcome=${KILL_OUTCOME_KILLED} kill_sent=${outcome.killSent === undefined ? 'absent' : String(outcome.killSent)}`
      case KILL_OUTCOME_ROW_GONE:
        return `outcome=${KILL_OUTCOME_ROW_GONE} (ErrSpawnNotFound)`
      case KILL_OUTCOME_SESSION_GONE:
        return renderSessionGone(outcome.name)
      case KILL_OUTCOME_ROW_FINISHED:
        return `outcome=${KILL_OUTCOME_ROW_FINISHED} read=${renderFinishedRead(outcome.read)}`
      case KILL_OUTCOME_NOT_KILLED:
        return `outcome=${KILL_OUTCOME_NOT_KILLED} ${describeFailure(outcome)}`
    }
  } catch {
    /* fall through to the fixed text */
  }
  return 'outcome=unknown'
}

// ---------------------------------------------------------------------------
// Notices built from a kill's outcome (SRJ-1002, SRJ-1003, SRJ-110, SRJ-811)
// ---------------------------------------------------------------------------

/** A CONFLICT or an UNUSABLE NAME answer a kill met at one of its tries. */
export const KILL_REFUSAL_AT_KILL = 'kill'
/** A CONFLICT or an UNUSABLE NAME answer a kill met at a `status` read between its tries. */
export const KILL_REFUSAL_AT_READ = 'status read'

/**
 * One CONFLICT or UNUSABLE NAME answer a kill met where nothing latches on
 * it (a persona teardown's kill, an old-life wait's kill; SRJ-1002): where,
 * its class (by name) and the thrown value, raw. Never logged raw.
 */
export interface KillRefusal {
  readonly at: typeof KILL_REFUSAL_AT_KILL | typeof KILL_REFUSAL_AT_READ
  readonly errorClass: typeof AD_ERROR_CLASS_CONFLICT | typeof AD_ERROR_CLASS_UNUSABLE_NAME
  readonly error: unknown
}

/**
 * The notice for a CONFLICT or an UNUSABLE NAME answer a kill met where
 * nothing latches on it, at one of its tries or at a `status` read between
 * them (SRJ-1003, SRJ-1002): the kill outcome's one-line rendering
 * ({@link describeKillOutcome}: its class and agent-director's redacted
 * description) with the instance id and where it was met. Nothing latched
 * on it, so it carries no hold sentence and is never the CONFLICT notice's
 * or the unusable-name notice's text. The one builder of that notice: a
 * persona teardown's window writes it inside its entry form
 * (`personaTeardownNoticeEntryText`, `src/persona-notifier.ts`), and an
 * old-life wait's entry can use it with no server-only module (SRJ-811).
 * Unescaped. Never throws.
 *
 *   agent-director kill of <id> refused at a try: <describeKillOutcome>
 *   agent-director kill of <id> refused at a status read between its tries: <describeKillOutcome>
 */
export function teardownKillRefusalNoticeText(instanceId: string, refusal: Pick<KillRefusal, 'at' | 'errorClass' | 'error'>): string {
  const where = refusal.at === KILL_REFUSAL_AT_READ ? 'at a status read between its tries' : 'at a try'
  const outcome = describeKillOutcome({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: refusal.errorClass, error: refusal.error })
  return `agent-director kill of ${instanceId} refused ${where}: ${outcome}`
}

/**
 * The notice for a kill whose outcome, after its tries, is a non-success
 * that no other notice records (SRJ-110: "keeps the row and is recorded";
 * SRJ-1003): no kill-failure alert was raised for it, it is no CONFLICT or
 * UNUSABLE NAME answer (whose notice is
 * {@link teardownKillRefusalNoticeText}'s), and no outage onset was written
 * for it (an ENVIRONMENT or CONFIG answer for a persona no longer in the
 * applied configuration, which raises no outage; an UNAVAILABLE value other
 * than `ErrTmuxKillFailed`; an UNCLASSIFIED value). The outcome's one-line
 * rendering ({@link describeKillOutcome}) with the instance id and the
 * number of kills made. Nothing latches and nothing is armed on it.
 * Unescaped. Never throws.
 *
 *   agent-director kill of <id> did not succeed after <n> kill(s); the row is kept: <describeKillOutcome>
 */
export function teardownKillNotSucceededNoticeText(instanceId: string, outcome: KillFailure, tries: number): string {
  const kills = Number.isSafeInteger(tries) && tries >= 0 ? `${tries} kill(s)` : 'its tries'
  return `agent-director kill of ${instanceId} did not succeed after ${kills}; the row is kept: ${describeKillOutcome(outcome)}`
}

/** The `session-gone` rendering, naming the GONE name only when it is one of the two. */
function renderSessionGone(name: unknown): string {
  return (AD_GONE_ERR_NAMES as readonly unknown[]).includes(name)
    ? `outcome=${KILL_OUTCOME_SESSION_GONE} (${String(name)})`
    : `outcome=${KILL_OUTCOME_SESSION_GONE}`
}

/** A finished read's label, only when it is one of the four. */
function renderFinishedRead(read: unknown): string {
  return read === KILL_ROW_FINISHED_ENDED ||
    read === KILL_ROW_FINISHED_MISSING ||
    read === KILL_ROW_FINISHED_NO_ROW ||
    read === KILL_ROW_FINISHED_HOLD_ENDED
    ? read
    : 'unknown'
}

/** A failure class's label, only when it is one of SRJ-110's. */
function renderFailureClass(errorClass: unknown): string {
  return typeof errorClass === 'string' && FAILURE_CLASSES.has(errorClass) ? errorClass : 'unknown'
}

/**
 * A non-success's class, name and redacted message: the kill-failure
 * description for `ErrTmuxKillFailed`; the classification's reported name
 * and rendered message (agent-director's own description, for an
 * `ErrUnknownErrorName`) when it carries either; else the redacting
 * describer's name and message.
 */
function describeFailure(outcome: AnyKillFailure): string {
  if (outcome.errorClass === AD_ERROR_CLASS_GONE) return `class=${AD_ERROR_CLASS_GONE} ${describeAgentDirectorFailure(outcome.error)}`
  const label = `class=${renderFailureClass(outcome.errorClass)}`
  if (outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE) {
    if (outcome.killFailed) {
      const message = describeLogMessage(outcome.killFailedDescription)
      return message === '' ? `${label} ${ERR_TMUX_KILL_FAILED_NAME}` : `${label} ${ERR_TMUX_KILL_FAILED_NAME} ${message}`
    }
    return `${label} ${describeAgentDirectorFailure(outcome.error)}`
  }
  if (outcome.unlistedClass !== undefined) {
    const from = renderUnlistedClass(outcome.unlistedClass)
    return `${label} from=${from} ${describeAgentDirectorFailure(outcome.error)}${renderRecheck(outcome.recheck)}`
  }
  const classification = classifyAdError(outcome.error)
  if (classification.reportedName !== undefined || classification.message !== undefined) {
    return describeAdErrorClassification({ ...classification, errorClass: renderedClassOf(outcome.errorClass) })
  }
  return `${label} ${describeAgentDirectorFailure(outcome.error)}`
}

/** An unlisted class's label, only when it is one of `KILL_UNLISTED_CLASSES`. */
function renderUnlistedClass(unlistedClass: unknown): string {
  return typeof unlistedClass === 'string' && UNLISTED_CLASSES.has(unlistedClass) ? unlistedClass : 'unknown'
}

/** ` recheck=<kind>` when a re-check answer kind that is a safe label was recorded, else empty. */
function renderRecheck(recheck: unknown): string {
  return typeof recheck === 'string' && /^[a-z-]{1,32}$/.test(recheck) ? ` recheck=${recheck}` : ''
}

/** The outcome's class when it is one of SRJ-110's, else UNCLASSIFIED (for the classification renderer). */
function renderedClassOf(errorClass: unknown): KillFailureClass {
  return typeof errorClass === 'string' && FAILURE_CLASSES.has(errorClass)
    ? (errorClass as KillFailureClass)
    : AD_ERROR_CLASS_UNCLASSIFIED
}
