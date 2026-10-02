/**
 * kill-retry.ts — The bounded retry of a live row's kill (b.jg5 SRJ-702,
 * SRJ-110): up to 3 tries 2 s apart on UNAVAILABLE, one `status` read of the
 * row before each further try, a caller's keep-going check, the start
 * sweep's pass budget, the survivor tracking with the decision of which
 * kill-failure alert the tries call for, and one log line per try and per
 * read.
 *
 * {@link runKillRetry} makes one try with the caller's single-try kill (the
 * checked kill, `src/checked-kill.ts`, or a caller's binding of it), and:
 *   - only an UNAVAILABLE outcome (`ErrTmuxKillFailed`, `ErrTmuxUnresponsive`,
 *     `ErrCallTimeout`, an `ErrUnknownErrorName` of that class or a wrapped
 *     unknown error) of a row the path last read live is tried again; every
 *     other outcome stands at once: a success, CONFLICT (never retried as a
 *     kill), UNUSABLE NAME, CONFIG, ENVIRONMENT (`ErrTmuxNotAvailable`, as
 *     when the tmux server is exiting after a kill ended its last session)
 *     and UNCLASSIFIED. A seed that is not live (the row read finished, or no
 *     row) makes one try: on a finished row `kill` is a no-op success that
 *     proves nothing;
 *   - before each further try, after the 2 s wait, exactly one `status` read
 *     of the row through the caller's read: `ended`, `missing` or
 *     `ErrSpawnNotFound` ends the tries as the `row-finished` success with no
 *     further kill; a read that latched the persona ends them with no further
 *     kill, the last try's outcome standing; a CONFIG answer ends them, the
 *     last try's outcome standing, only when the last state read (the seed,
 *     then each read) is `pending`, and lets the try go ahead otherwise; any
 *     other failed read lets the try go ahead; a live state read becomes the
 *     last state read. The read's own side effects (outage flags, the
 *     `ad-config-malformed` raise, the latch) are the read function's;
 *   - the keep-going check, asked after the wait and again after the read, ends
 *     the tries with no further kill when it answers false (or throws), the
 *     last try's outcome standing; the result says so (`stopped`), so a
 *     caller can answer `latched`;
 *   - a pass budget (the start sweep's, AC 56): once one kill with it has used
 *     all its tries with an UNAVAILABLE outcome standing, every later kill
 *     with it makes one try. A kill that ends in a success, in another class,
 *     or by a read or a stop does not spend it.
 *
 * Survivor tracking (SRJ-702, SRJ-110, SRJ-1007): a try's `ErrTmuxKillFailed`
 * whose description names a surviving pid (`survivorPids` from
 * `src/ad-description-phrases.ts`, the one module that holds the form) is
 * kept as the latest survivor-naming description. A retried `kill` re-checks
 * only the worker's process, so that survivor is checked by no later call.
 * The result carries the alert decision ({@link KillRetryAlert}):
 *   - `survivor`, quoting the latest survivor-naming description, on any
 *     success end after a survivor-naming failure (a read of `ended`,
 *     `missing` or `ErrSpawnNotFound`; a later try's success, whatever its
 *     `kill_sent`; a later try's `ErrSpawnNotFound` or GONE);
 *   - `ordinary` on a failure end whose last outcome is `ErrTmuxKillFailed`,
 *     quoting its description, and on any failure end after a
 *     survivor-naming failure (a stop by a read or by the keep-going check
 *     included), quoting the latest survivor-naming description, and both
 *     when the last outcome is an `ErrTmuxKillFailed` naming no survivor;
 *   - `none` otherwise.
 * The decision is made by class only; the caller does the last outcome's own
 * handling (latch, outage, retry timer) and raises the alert.
 *
 * Every timer runs on an injected wait: a clock with `setTimeout` (the shape
 * `createFakeClock` satisfies) or a sleep function. Every wait is awaited, so
 * no timer is left pending once the entry settles. The module holds no state
 * and loads no server-only module (no notifier, outage state, Slack client,
 * latch, episodes or server module), so the CLI process can use it too.
 *
 * Log lines (SRJ-1014), through the caller's sink with its prefix: one per
 * try ({@link killRetryTryLine}: instance id, try number, the outcome through
 * `describeKillOutcome`, `kill_sent` and the redacted description included),
 * one per read ({@link killRetryReadLine}: the state, or the class and the
 * redacted failure), one per stop ({@link killRetryStopLine}), and one end
 * line ({@link killRetryEndLine}) when more than one call was made or an
 * alert is called for. No raw description and no token is logged.
 *
 * SPDX-License-Identifier: MIT
 */

import { survivorPids } from './ad-description-phrases.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_UNAVAILABLE,
  classifyAdError,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  hasAdErrorName,
} from './ad-error-class.ts'
import { ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'
import {
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_ROW_FINISHED_ENDED,
  KILL_ROW_FINISHED_MISSING,
  KILL_ROW_FINISHED_NO_ROW,
  describeKillOutcome,
  killLetsNextStepRun,
  killOutcomeOf,
  type KillOutcome,
  type KillRowFinishedRead,
} from './checked-kill.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
import { isSafeIdentifier, renderLogMessageText } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tries of a live row's kill on UNAVAILABLE before its outcome stands (SRJ-702). */
export const KILL_RETRY_TRIES = 3

/** The wait between two tries, in ms (SRJ-702). */
export const KILL_RETRY_SPACING_MS = 2_000

// ---------------------------------------------------------------------------
// The wait
// ---------------------------------------------------------------------------

/** A clock whose `setTimeout` runs the wait between tries (`createFakeClock` satisfies it). */
export interface KillRetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown
}

/** A sleep function: resolves once `ms` has passed. */
export type KillRetrySleep = (ms: number) => Promise<void>

/** The injected wait between tries: a clock or a sleep function. */
export type KillRetryWait = KillRetryClock | KillRetrySleep

/** The real clock, the production wait. */
export const KILL_RETRY_SYSTEM_CLOCK: KillRetryClock = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
})

/** Wait `ms` on `wait`. Rejects only when a sleep function rejects or a clock throws. */
function waitOn(wait: KillRetryWait, ms: number): Promise<void> {
  if (typeof wait === 'function') return wait(ms)
  return new Promise<void>((resolve) => {
    wait.setTimeout(resolve, ms)
  })
}

// ---------------------------------------------------------------------------
// The seed: the row state the path last read
// ---------------------------------------------------------------------------

/** The path read the row in `state`. */
const KILL_RETRY_SEED_STATE = 'state'
/** The row is known live, but the path did not read its state (agent-director called it live). */
const KILL_RETRY_SEED_LIVE = 'live'
/** The path did not read the row live: it read it finished, read no row, or did not read it. */
const KILL_RETRY_SEED_NOT_LIVE = 'not-live'

/** The row state the kill's path last read before the kill (SRJ-702). */
export type KillRetrySeed =
  | { readonly kind: typeof KILL_RETRY_SEED_STATE; readonly state: string }
  | { readonly kind: typeof KILL_RETRY_SEED_LIVE }
  | { readonly kind: typeof KILL_RETRY_SEED_NOT_LIVE }

/** A known-live seed with no state read, as a value. */
export const KILL_RETRY_SEED_LIVE_UNREAD: KillRetrySeed = Object.freeze({ kind: KILL_RETRY_SEED_LIVE })

/** A seed that is not live, as a value: the kill makes one try. */
export const KILL_RETRY_SEED_NOT_LIVE_VALUE: KillRetrySeed = Object.freeze({ kind: KILL_RETRY_SEED_NOT_LIVE })

/** The seed for a row the path read in `state`. */
export function killRetrySeedOfState(state: string): KillRetrySeed {
  return Object.freeze({ kind: KILL_RETRY_SEED_STATE, state })
}

/**
 * True when `seed` is a row last read live: a known-live seed, or a state
 * read that is not finished (`ended`, `missing`); `pending` and any state
 * CSCB does not know count as live.
 */
export function killRetrySeedIsLive(seed: KillRetrySeed): boolean {
  if (seed.kind === KILL_RETRY_SEED_LIVE) return true
  if (seed.kind !== KILL_RETRY_SEED_STATE) return false
  return !AGENT_DIRECTOR_DEAD_STATES.has(seed.state)
}

/** True when `seed` is a row last read `pending`. */
function seedIsPending(seed: KillRetrySeed): boolean {
  return seed.kind === KILL_RETRY_SEED_STATE && seed.state === AGENT_DIRECTOR_PENDING_STATE
}

// ---------------------------------------------------------------------------
// The read between tries
// ---------------------------------------------------------------------------

/** The read gave the row's state. */
export const KILL_RETRY_READ_STATE = 'state'
/** The read found no row (`ErrSpawnNotFound`). */
export const KILL_RETRY_READ_NO_ROW = 'no-row'
/** The read latched the persona (an UNUSABLE NAME answer, or its own row read `pending` with no launch start). */
export const KILL_RETRY_READ_LATCHED = 'latched'
/** The read failed with `error` and latched nothing. */
export const KILL_RETRY_READ_FAILED = 'failed'

/** What one `status` read of the row between tries answered, as the caller's read reports it. */
export type KillRetryRead =
  | { readonly kind: typeof KILL_RETRY_READ_STATE; readonly state: string }
  | { readonly kind: typeof KILL_RETRY_READ_NO_ROW }
  | { readonly kind: typeof KILL_RETRY_READ_LATCHED }
  | { readonly kind: typeof KILL_RETRY_READ_FAILED; readonly error: unknown }

// ---------------------------------------------------------------------------
// The pass budget (AC 56)
// ---------------------------------------------------------------------------

/**
 * The start sweep's pass budget: one per pass. Once a kill with it has used
 * all its tries with an UNAVAILABLE outcome standing, it is spent, and every
 * later kill with it makes one try.
 */
export interface KillRetryPassBudget {
  /** True once a kill with this budget used all its tries on UNAVAILABLE. */
  isSpent(): boolean
  /** Spend the budget. */
  spend(): void
}

/** A fresh pass budget, not spent. */
export function createKillRetryPassBudget(): KillRetryPassBudget {
  let spent = false
  return {
    isSpent: () => spent,
    spend: () => {
      spent = true
    },
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** The last try's outcome stands: a success, a class not tried again, or a row not last read live. */
export const KILL_RETRY_END_SETTLED = 'settled'
/** Every try was used and the last one's UNAVAILABLE outcome stands. */
export const KILL_RETRY_END_EXHAUSTED = 'exhausted'
/** The pass budget was spent: one try, and its UNAVAILABLE outcome stands. */
export const KILL_RETRY_END_BUDGET_SPENT = 'budget-spent'
/** A read found the row finished (`ended`, `missing`, `ErrSpawnNotFound`): the `row-finished` success. */
export const KILL_RETRY_END_ROW_FINISHED = 'row-finished'
/** A read answered CONFIG with the row last read `pending`: the last try's outcome stands. */
export const KILL_RETRY_END_READ_CONFIG = 'read-config'
/** A read latched the persona: the last try's outcome stands. */
export const KILL_RETRY_END_READ_LATCHED = 'read-latched'
/** The keep-going check answered false (or the wait failed): the last try's outcome stands. */
export const KILL_RETRY_END_STOPPED = 'stopped'

/** How the tries ended. */
export type KillRetryEnd =
  | typeof KILL_RETRY_END_SETTLED
  | typeof KILL_RETRY_END_EXHAUSTED
  | typeof KILL_RETRY_END_BUDGET_SPENT
  | typeof KILL_RETRY_END_ROW_FINISHED
  | typeof KILL_RETRY_END_READ_CONFIG
  | typeof KILL_RETRY_END_READ_LATCHED
  | typeof KILL_RETRY_END_STOPPED

/** No kill-failure alert. */
export const KILL_RETRY_ALERT_NONE = 'none'
/** The kill-failure alert's survivor version (SRJ-1007). */
export const KILL_RETRY_ALERT_SURVIVOR = 'survivor'
/** The kill-failure alert's ordinary version (SRJ-1007). */
export const KILL_RETRY_ALERT_ORDINARY = 'ordinary'

/**
 * Which kill-failure alert the tries call for, with the descriptions it
 * quotes (SRJ-702, SRJ-1007). Every description is agent-director's, raw:
 * redact it before any log line, record or notice.
 */
export type KillRetryAlert =
  | { readonly kind: typeof KILL_RETRY_ALERT_NONE }
  /** A success end after a survivor-naming failure: quote the latest survivor-naming description. */
  | { readonly kind: typeof KILL_RETRY_ALERT_SURVIVOR; readonly survivorDescription: string }
  | {
      readonly kind: typeof KILL_RETRY_ALERT_ORDINARY
      /** The standing outcome's `ErrTmuxKillFailed` description, when the last outcome is one and its description is a string. */
      readonly lastKillFailedDescription?: string
      /**
       * The latest survivor-naming description of an earlier try, when one
       * came and the last outcome is not itself a survivor-naming
       * `ErrTmuxKillFailed`. With `lastKillFailedDescription` too, both are
       * quoted (SRJ-1007's "and, earlier in these tries" form).
       */
      readonly earlierSurvivorDescription?: string
    }

/** What the bounded retry answers. */
export interface KillRetryResult {
  /** The outcome that stands: the last try's, or the `row-finished` success a read gave. */
  readonly outcome: KillOutcome
  /** How the tries ended. */
  readonly end: KillRetryEnd
  /** Kills made. */
  readonly tries: number
  /** `status` reads made between tries. */
  readonly reads: number
  /** Which kill-failure alert the tries call for; the caller raises it. */
  readonly alert: KillRetryAlert
}

/**
 * True when the tries were ended by a read that latched the persona or by
 * the keep-going check: the caller makes no further call for the persona,
 * reports nothing more for the kill, and answers `latched` when the persona
 * is latched.
 */
export function killRetryStopped(result: KillRetryResult): boolean {
  return result.end === KILL_RETRY_END_READ_LATCHED || result.end === KILL_RETRY_END_STOPPED
}

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

/** What {@link runKillRetry} is given. */
export interface KillRetryOptions {
  /** The row's instance id, for the log lines. */
  readonly instanceId: string
  /** One try: the checked kill or a caller's binding of it. Should never throw; a throw is taken as its outcome. */
  readonly kill: () => Promise<KillOutcome>
  /** One `status` read of the row; its side effects are its own. A throw is a failed read. */
  readonly read: () => Promise<KillRetryRead>
  /** The wait between tries. */
  readonly wait: KillRetryWait
  /** The row state the path last read before the kill. */
  readonly lastRead: KillRetrySeed
  /** Asked after each wait and again after each read; false (or a throw) ends the tries with no further kill. Absent: always true. */
  readonly keepGoing?: () => boolean
  /** The start sweep's pass budget. Absent: every live row's kill gets its tries. */
  readonly budget?: KillRetryPassBudget
  /** Where each line goes. A throw is ignored. */
  readonly log: (line: string) => void
  /** Each line's head, e.g. `[slack] reconcileOrphans`. */
  readonly logPrefix: string
}

/** What the tries have seen of `ErrTmuxKillFailed` descriptions. */
interface SurvivorTrack {
  /** The latest survivor-naming `ErrTmuxKillFailed` description. */
  latestSurvivor?: string
}

/**
 * The bounded retry of a kill (SRJ-702). Never throws or rejects, and leaves
 * no timer pending once it settles.
 */
export async function runKillRetry(options: KillRetryOptions): Promise<KillRetryResult> {
  const live = killRetrySeedIsLive(options.lastRead)
  const budgetSpent = live && budgetIsSpent(options.budget)
  const maxTries = live && !budgetSpent ? KILL_RETRY_TRIES : 1
  const track: SurvivorTrack = {}
  let lastRead = options.lastRead
  let tries = 0
  let reads = 0
  const finish = (outcome: KillOutcome, end: KillRetryEnd): KillRetryResult => {
    const result: KillRetryResult = { outcome, end, tries, reads, alert: alertDecision(outcome, track) }
    if (tries + reads > 1 || result.alert.kind !== KILL_RETRY_ALERT_NONE) {
      emit(options, killRetryEndLine(options.logPrefix, options.instanceId, result))
    }
    return result
  }
  for (;;) {
    tries++
    const outcome = await tryOnce(options.kill)
    noteTry(track, outcome)
    const next = afterTry(outcome, tries, maxTries, live, budgetSpent)
    emit(options, killRetryTryLine(options.logPrefix, options.instanceId, tries, maxTries, outcome, next))
    if (next !== KILL_RETRY_NEXT_AGAIN) {
      if (next === KILL_RETRY_NEXT_EXHAUSTED && maxTries === KILL_RETRY_TRIES) options.budget?.spend()
      return finish(outcome, endOfTryNext(next))
    }
    try {
      await waitOn(options.wait, KILL_RETRY_SPACING_MS)
    } catch {
      emit(options, killRetryStopLine(options.logPrefix, options.instanceId, tries + 1, 'the wait between tries failed'))
      return finish(outcome, KILL_RETRY_END_STOPPED)
    }
    if (!keepGoing(options)) {
      emit(options, killRetryStopLine(options.logPrefix, options.instanceId, tries + 1, "the caller's keep-going check answered false"))
      return finish(outcome, KILL_RETRY_END_STOPPED)
    }
    reads++
    const read = await readOnce(options.read)
    const verdict = judgeRead(read, lastRead)
    emit(options, killRetryReadLine(options.logPrefix, options.instanceId, tries + 1, read, verdict.kind, lastRead))
    if (verdict.kind === KILL_RETRY_VERDICT_FINISHED) {
      return finish({ kind: KILL_OUTCOME_ROW_FINISHED, read: verdict.read }, KILL_RETRY_END_ROW_FINISHED)
    }
    if (verdict.kind === KILL_RETRY_VERDICT_LATCHED) return finish(outcome, KILL_RETRY_END_READ_LATCHED)
    if (verdict.kind === KILL_RETRY_VERDICT_CONFIG_STOP) return finish(outcome, KILL_RETRY_END_READ_CONFIG)
    if (verdict.lastRead !== undefined) lastRead = verdict.lastRead
    if (!keepGoing(options)) {
      emit(options, killRetryStopLine(options.logPrefix, options.instanceId, tries + 1, "the caller's keep-going check answered false"))
      return finish(outcome, KILL_RETRY_END_STOPPED)
    }
  }
}

/** The budget's answer, a throw counting as not spent. */
function budgetIsSpent(budget: KillRetryPassBudget | undefined): boolean {
  if (budget === undefined) return false
  try {
    return budget.isSpent() === true
  } catch {
    return false
  }
}

/** One try; a throw is taken as its outcome. */
async function tryOnce(kill: () => Promise<KillOutcome>): Promise<KillOutcome> {
  try {
    return await kill()
  } catch (thrown) {
    return killOutcomeOf({ thrown })
  }
}

/** One read; a throw is a failed read. */
async function readOnce(read: () => Promise<KillRetryRead>): Promise<KillRetryRead> {
  try {
    return await read()
  } catch (error) {
    return { kind: KILL_RETRY_READ_FAILED, error }
  }
}

/** The keep-going check; absent is true, a throw is false. */
function keepGoing(options: KillRetryOptions): boolean {
  if (options.keepGoing === undefined) return true
  try {
    return options.keepGoing() === true
  } catch {
    return false
  }
}

/** Hand `line` to the sink, ignoring a throw. */
function emit(options: KillRetryOptions, line: string): void {
  try {
    options.log(line)
  } catch {
    /* a failing sink changes nothing about the tries */
  }
}

// ---------------------------------------------------------------------------
// After a try
// ---------------------------------------------------------------------------

/** Another try follows, after the wait and a read. */
export const KILL_RETRY_NEXT_AGAIN = 'again'
/** The outcome stands: a success. */
export const KILL_RETRY_NEXT_SUCCESS = 'success'
/** The outcome stands: a class that is never tried again. */
export const KILL_RETRY_NEXT_NOT_RETRIED = 'not-retried'
/** The outcome stands: the row was not last read live, so one try. */
export const KILL_RETRY_NEXT_NOT_LIVE = 'not-live'
/** The outcome stands: every try was used. */
export const KILL_RETRY_NEXT_EXHAUSTED = 'exhausted'
/** The outcome stands: the pass budget was spent, so one try. */
export const KILL_RETRY_NEXT_BUDGET_SPENT = 'budget-spent'

/** What follows a try. */
export type KillRetryTryNext =
  | typeof KILL_RETRY_NEXT_AGAIN
  | typeof KILL_RETRY_NEXT_SUCCESS
  | typeof KILL_RETRY_NEXT_NOT_RETRIED
  | typeof KILL_RETRY_NEXT_NOT_LIVE
  | typeof KILL_RETRY_NEXT_EXHAUSTED
  | typeof KILL_RETRY_NEXT_BUDGET_SPENT

/** What follows try number `tries` of at most `maxTries`. */
function afterTry(outcome: KillOutcome, tries: number, maxTries: number, live: boolean, budgetSpent: boolean): KillRetryTryNext {
  if (killLetsNextStepRun(outcome)) return KILL_RETRY_NEXT_SUCCESS
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass !== AD_ERROR_CLASS_UNAVAILABLE) return KILL_RETRY_NEXT_NOT_RETRIED
  if (!live) return KILL_RETRY_NEXT_NOT_LIVE
  if (budgetSpent) return KILL_RETRY_NEXT_BUDGET_SPENT
  return tries >= maxTries ? KILL_RETRY_NEXT_EXHAUSTED : KILL_RETRY_NEXT_AGAIN
}

/** The end for a try's standing outcome. */
function endOfTryNext(next: KillRetryTryNext): KillRetryEnd {
  if (next === KILL_RETRY_NEXT_EXHAUSTED) return KILL_RETRY_END_EXHAUSTED
  if (next === KILL_RETRY_NEXT_BUDGET_SPENT) return KILL_RETRY_END_BUDGET_SPENT
  return KILL_RETRY_END_SETTLED
}

// ---------------------------------------------------------------------------
// Judging a read
// ---------------------------------------------------------------------------

/** The read found the row finished: the tries end as a success. */
const KILL_RETRY_VERDICT_FINISHED = 'finished'
/** The read latched the persona: the tries end. */
const KILL_RETRY_VERDICT_LATCHED = 'latched'
/** A CONFIG answer on a row last read `pending`: the tries end. */
const KILL_RETRY_VERDICT_CONFIG_STOP = 'config-stop'
/** The try goes ahead. */
const KILL_RETRY_VERDICT_GO = 'go'

/** What a read decides. */
type KillRetryReadVerdict =
  | typeof KILL_RETRY_VERDICT_FINISHED
  | typeof KILL_RETRY_VERDICT_LATCHED
  | typeof KILL_RETRY_VERDICT_CONFIG_STOP
  | typeof KILL_RETRY_VERDICT_GO

type JudgedRead =
  | { readonly kind: typeof KILL_RETRY_VERDICT_FINISHED; readonly read: KillRowFinishedRead }
  | { readonly kind: typeof KILL_RETRY_VERDICT_LATCHED }
  | { readonly kind: typeof KILL_RETRY_VERDICT_CONFIG_STOP }
  | { readonly kind: typeof KILL_RETRY_VERDICT_GO; readonly lastRead?: KillRetrySeed }

/** What `read` decides, given the last state read. */
function judgeRead(read: KillRetryRead, lastRead: KillRetrySeed): JudgedRead {
  switch (read.kind) {
    case KILL_RETRY_READ_STATE:
      if (read.state === KILL_ROW_FINISHED_ENDED) return { kind: KILL_RETRY_VERDICT_FINISHED, read: KILL_ROW_FINISHED_ENDED }
      if (read.state === KILL_ROW_FINISHED_MISSING) return { kind: KILL_RETRY_VERDICT_FINISHED, read: KILL_ROW_FINISHED_MISSING }
      return { kind: KILL_RETRY_VERDICT_GO, lastRead: killRetrySeedOfState(read.state) }
    case KILL_RETRY_READ_NO_ROW:
      return { kind: KILL_RETRY_VERDICT_FINISHED, read: KILL_ROW_FINISHED_NO_ROW }
    case KILL_RETRY_READ_LATCHED:
      return { kind: KILL_RETRY_VERDICT_LATCHED }
    default:
      break
  }
  const error = read.kind === KILL_RETRY_READ_FAILED ? read.error : undefined
  if (hasAdErrorName(error, ERR_SPAWN_NOT_FOUND_NAME)) return { kind: KILL_RETRY_VERDICT_FINISHED, read: KILL_ROW_FINISHED_NO_ROW }
  if (classOf(error) === AD_ERROR_CLASS_CONFIG && seedIsPending(lastRead)) return { kind: KILL_RETRY_VERDICT_CONFIG_STOP }
  return { kind: KILL_RETRY_VERDICT_GO }
}

/** `error`'s class by name, through `src/ad-error-class.ts`. */
function classOf(error: unknown): string {
  try {
    return classifyAdError(error).errorClass
  } catch {
    return AD_ERROR_CLASS_UNAVAILABLE
  }
}

// ---------------------------------------------------------------------------
// Survivor tracking and the alert decision
// ---------------------------------------------------------------------------

/** `outcome`'s `ErrTmuxKillFailed` description, when it is one and the description is a string. */
function killFailedDescriptionOfOutcome(outcome: KillOutcome): string | undefined {
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass !== AD_ERROR_CLASS_UNAVAILABLE) return undefined
  if (!outcome.killFailed) return undefined
  return typeof outcome.killFailedDescription === 'string' ? outcome.killFailedDescription : undefined
}

/** True when `outcome` is an `ErrTmuxKillFailed`. */
function isKillFailed(outcome: KillOutcome): boolean {
  return outcome.kind === KILL_OUTCOME_NOT_KILLED && outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE && outcome.killFailed
}

/** True when `description` names a surviving pid (`survivorPids`, the one detector). */
function namesSurvivor(description: string | undefined): description is string {
  if (description === undefined) return false
  try {
    return survivorPids(description).length > 0
  } catch {
    return false
  }
}

/** Keep a try's survivor-naming description. */
function noteTry(track: SurvivorTrack, outcome: KillOutcome): void {
  const description = killFailedDescriptionOfOutcome(outcome)
  if (namesSurvivor(description)) track.latestSurvivor = description
}

/** The alert decision for the outcome that stands (SRJ-702, SRJ-704, SRJ-1007). */
function alertDecision(outcome: KillOutcome, track: SurvivorTrack): KillRetryAlert {
  const survivor = track.latestSurvivor
  if (killLetsNextStepRun(outcome)) {
    return survivor === undefined
      ? { kind: KILL_RETRY_ALERT_NONE }
      : { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: survivor }
  }
  if (isKillFailed(outcome)) {
    const last = killFailedDescriptionOfOutcome(outcome)
    const earlier = namesSurvivor(last) ? undefined : survivor
    return {
      kind: KILL_RETRY_ALERT_ORDINARY,
      ...(last !== undefined ? { lastKillFailedDescription: last } : {}),
      ...(earlier !== undefined ? { earlierSurvivorDescription: earlier } : {}),
    }
  }
  return survivor === undefined
    ? { kind: KILL_RETRY_ALERT_NONE }
    : { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: survivor }
}

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

/** An instance id for a line: redacted, on one line, capped. */
function renderId(instanceId: unknown): string {
  const rendered = renderLogMessageText(instanceId)
  return rendered === '' ? 'unknown' : rendered
}

/** A state for a line, only when it is a short identifier. */
function renderState(state: unknown): string {
  return isSafeIdentifier(state) ? state : 'unknown'
}

/** What follows a try, in words. */
function tryNextText(next: KillRetryTryNext): string {
  switch (next) {
    case KILL_RETRY_NEXT_AGAIN:
      return `trying again in ${KILL_RETRY_SPACING_MS / 1000} s, after a status read of the row`
    case KILL_RETRY_NEXT_SUCCESS:
      return 'the tries end in this success'
    case KILL_RETRY_NEXT_NOT_RETRIED:
      return 'not tried again (only UNAVAILABLE is); this outcome stands'
    case KILL_RETRY_NEXT_NOT_LIVE:
      return 'the row was not last read live, so it gets one try; this outcome stands'
    case KILL_RETRY_NEXT_EXHAUSTED:
      return 'no tries left; this outcome stands'
    case KILL_RETRY_NEXT_BUDGET_SPENT:
      return "this start pass's retries are spent (one row already used its tries on UNAVAILABLE), so it gets one try; this outcome stands"
  }
}

/**
 * One try's line (SRJ-1014):
 *   `<prefix>: kill try <n> of <max> for <id>: <describeKillOutcome>[ (names a surviving pid)] — <what follows>`
 * The outcome carries `kill_sent` and the description, redacted. Never throws.
 */
export function killRetryTryLine(
  prefix: string,
  instanceId: string,
  tryNumber: number,
  maxTries: number,
  outcome: KillOutcome,
  next: KillRetryTryNext,
): string {
  const survivor = namesSurvivor(killFailedDescriptionOfOutcome(outcome)) ? ' (names a surviving pid)' : ''
  return `${prefix}: kill try ${tryNumber} of ${maxTries} for ${renderId(instanceId)}: ${describeKillOutcome(outcome)}${survivor} — ${tryNextText(next)} (b.jg5 SRJ-702)`
}

/** A read's answer, for its line: the state, or the class and the redacted failure. */
function describeRead(read: KillRetryRead): string {
  switch (read.kind) {
    case KILL_RETRY_READ_STATE:
      return `state=${renderState(read.state)}`
    case KILL_RETRY_READ_NO_ROW:
      return 'no row (ErrSpawnNotFound)'
    case KILL_RETRY_READ_LATCHED:
      return 'the read latched the persona'
    case KILL_RETRY_READ_FAILED:
      return `failed: ${describeReadFailure(read.error)}`
  }
}

/** A failed read's class and redacted failure. */
function describeReadFailure(error: unknown): string {
  if (hasAdErrorName(error, ERR_SPAWN_NOT_FOUND_NAME)) return 'no row (ErrSpawnNotFound)'
  try {
    const classification = classifyAdError(error)
    if (classification.reportedName !== undefined || classification.message !== undefined) {
      return describeAdErrorClassification(classification)
    }
    return `class=${classification.errorClass} ${describeAgentDirectorFailure(error)}`
  } catch {
    return 'class=unknown'
  }
}

/** The state last read, for a line. */
function describeSeed(seed: KillRetrySeed): string {
  if (seed.kind === KILL_RETRY_SEED_STATE) return renderState(seed.state)
  return seed.kind === KILL_RETRY_SEED_LIVE ? 'live (state not read)' : 'not live'
}

/** What a read decides, in words. */
function readVerdictText(verdict: KillRetryReadVerdict, read: KillRetryRead, lastRead: KillRetrySeed): string {
  switch (verdict) {
    case KILL_RETRY_VERDICT_FINISHED:
      return 'the row is finished: the tries end as a success with no further kill'
    case KILL_RETRY_VERDICT_LATCHED:
      return "no further kill (no call is made for a latched persona); the last try's outcome stands"
    case KILL_RETRY_VERDICT_CONFIG_STOP:
      return "the row was last read pending: no further kill while agent-director's config is unreadable; the last try's outcome stands"
    case KILL_RETRY_VERDICT_GO:
      if (read.kind === KILL_RETRY_READ_FAILED && classOf(read.error) === AD_ERROR_CLASS_CONFIG) {
        return `the row was last read ${describeSeed(lastRead)}: the try goes ahead`
      }
      return 'the try goes ahead'
  }
}

/**
 * One read's line (SRJ-1014):
 *   `<prefix>: status read before kill try <n> for <id>: <state, or the class and the redacted failure> — <what it decides>`
 * `lastRead` is the state last read before this read. Never throws.
 */
function killRetryReadLine(
  prefix: string,
  instanceId: string,
  nextTry: number,
  read: KillRetryRead,
  verdict: KillRetryReadVerdict,
  lastRead: KillRetrySeed,
): string {
  return `${prefix}: status read before kill try ${nextTry} for ${renderId(instanceId)}: ${describeRead(read)} — ${readVerdictText(verdict, read, lastRead)} (b.jg5 SRJ-702)`
}

/**
 * The line when the tries stop before try `nextTry`:
 *   `<prefix>: kill tries for <id> stop before try <n>: <why> — no further kill; the last try's outcome stands`
 */
function killRetryStopLine(prefix: string, instanceId: string, nextTry: number, why: string): string {
  return `${prefix}: kill tries for ${renderId(instanceId)} stop before try ${nextTry}: ${why} — no further kill; the last try's outcome stands (b.jg5 SRJ-702)`
}

/**
 * The end line, written when more than one call was made or an alert is
 * called for:
 *   `<prefix>: kill tries for <id> ended (<end>) after <n> kill(s) and <m> read(s): <describeKillOutcome> — alert=<none|survivor|ordinary>`
 */
export function killRetryEndLine(prefix: string, instanceId: string, result: KillRetryResult): string {
  return `${prefix}: kill tries for ${renderId(instanceId)} ended (${result.end}) after ${result.tries} kill(s) and ${result.reads} read(s): ${describeKillOutcome(result.outcome)} — alert=${result.alert.kind} (b.jg5 SRJ-702)`
}
