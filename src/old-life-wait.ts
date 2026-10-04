/**
 * old-life-wait.ts — How an old-life wait's round ends (b.jg5 SRJ-811,
 * SRJ-812, SRJ-702, SRJ-704, SRJ-717, SRJ-1002, SRJ-1013).
 *
 * An old-life wait runs the live-row sequence's kill and `find-missing` steps
 * (SRJ-705 steps 1 to 5) on an old row's instance id, with no launch, in the
 * background (the no-launch form of `src/live-row-sequence.ts`, started by
 * the session manager's `ensureOldLifeWait`). This module decides, from how
 * one round ended and what its calls met, what follows it
 * ({@link decideOldLifeWaitEnd}), and renders its lines; the session
 * manager's end handler applies the decision.
 *
 * The rounds' results by class (SRJ-811; the calling agent's rulings):
 *   - the row finished (step 6 of the no-launch form): nothing more; the read
 *     that found it finished ended the hold (SRJ-809);
 *   - the hold ended while the round ran, its kill's tries included (between
 *     tries, or during a try whose UNAVAILABLE outcome would stand, the last
 *     included): a success, as a finished read is; no mark, nothing armed;
 *     decided before every case below, so it also wins over a stop in the
 *     same window (SRJ-702; option A). A survivor named by those tries has
 *     raised the survivor version already, through the round's alert sink;
 *   - stopped by a shutdown or by the teardown of the last persona waiting
 *     on the hold: nothing more here (a kill those stopped wrote its one line
 *     and the old key's `persona-kill-failed` entry, with no alert text,
 *     through the round's alert sink); no mark, nothing armed, no notice;
 *   - stopped because a configured persona's own row is latched (a read of
 *     it latched the persona, or the persona was latched already; SRJ-114,
 *     SRJ-513, SRJ-502): the hold goes on, the waiting personas that are not
 *     latched are armed as below (the session manager's arm never arms a
 *     latched persona: SRJ-305, SRJ-301), and the hold is marked
 *     kill-failed when the round's kill decided the ordinary alert and no
 *     stop ended its tries (a read-latch end is a failure end, its alert
 *     standing; SRJ-812);
 *   - every other end keeps the hold and arms each waiting persona's retry
 *     timer with {@link OLD_LIFE_WAIT_ARM_CAUSE}, uncounted: an UNAVAILABLE,
 *     ENVIRONMENT, CONFIG or UNCLASSIFIED answer (the outages were raised for
 *     the waiting personas at the call), a kill failure, a CONFLICT or an
 *     unusable recorded name, a run that did not judge a `pending` old row
 *     (SRJ-717: no alert, no mark), or the row still live after runs that
 *     judged it (SRJ-705 step 5). The hold is marked kill-failed (SRJ-812)
 *     when the round's kill decided the ordinary kill-failure alert and no
 *     stop ended its tries, or at step 5's alert; a survivor version never
 *     marks it.
 * Each CONFLICT and unusable recorded name a round met (at a kill try, a
 * `status` read between tries, a `get` or a run) is one log line and one
 * `persona-teardown-notice` entry worded "during the wait", latching no one
 * (SRJ-1002, SRJ-1013). A round's first UNCLASSIFIED answer is reported to
 * the old row's unclassified-error episode (SRJ-313), keyed by the held
 * instance id, whose one alert per episode takes the log-only route once the
 * answers have lasted longer than the alert threshold; it is reported only
 * after a round that keeps the hold, and the hold's end ends the episode.
 * Nothing is written or reported for a round a shutdown or a teardown
 * stopped, whose answers are dropped (SRJ-706). A `kill_sent: false`
 * success, and a CONFLICT, never end the hold (SRJ-809).
 *
 * Pure module: no module-scope state, no environment or file access, no
 * server-only import, and nothing runs at import. Errors are classified by
 * name through `src/ad-error-class.ts`; agent-director text reaches a line
 * only through the shared redaction.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  describeAgentDirectorFailure,
} from './ad-error-class.ts'
import { KILL_REFUSAL_AT_KILL, KILL_REFUSAL_AT_READ, teardownKillRefusalNoticeText } from './checked-kill.ts'
import {
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_END_HOLD_ENDED,
  KILL_RETRY_END_STOPPED,
  killRetryStopped,
  type KillRetryResult,
} from './kill-retry.ts'
import {
  LIVE_ROW_OUTCOME_ABORTED,
  LIVE_ROW_OUTCOME_CONFIG_MALFORMED,
  LIVE_ROW_OUTCOME_ESCALATED,
  LIVE_ROW_OUTCOME_NO_JUDGED_RUN,
  LIVE_ROW_OUTCOME_NOT_JUDGED,
  LIVE_ROW_OUTCOME_READ_REFUSED,
  LIVE_ROW_OUTCOME_ROW_FINISHED,
  LIVE_ROW_OUTCOME_RUN_REFUSED,
  LIVE_ROW_OUTCOME_STOPPED,
  LIVE_ROW_STOP_HOLD_ENDED,
  LIVE_ROW_STOP_LATCHED,
  type LiveRowSequenceOutcome,
} from './live-row-sequence.ts'
import { renderLogMessageText } from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The wait's site name: its log lines' head and its agent-director calls' log prefix. */
export const OLD_LIFE_WAIT_SITE = 'old-life-wait'

/** The head of every line the wait's end handler logs. */
export const OLD_LIFE_WAIT_LOG_PREFIX = `[slack] ${OLD_LIFE_WAIT_SITE}:`

/** The context an UNUSABLE NAME answer to a wait's `get` of a configured persona's own row is routed in (SRJ-1002). */
export const OLD_LIFE_WAIT_ROUTED_CONTEXT = 'the old-life wait'

/**
 * The retry cause each waiting persona's timer is armed with after a round
 * that keeps the hold, and a persona refused because a wait runs on its own
 * row (SRJ-811, SRJ-301). The same string as the retry controller's label
 * (`UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD`, `src/unavailable-retry.ts`, not
 * imported here: that module loads server modules). Never counted.
 */
export const OLD_LIFE_WAIT_ARM_CAUSE = 'held-for-old-life'

/**
 * The seed a wait's request carries when no state of the old row has been
 * read: the row is live, its state unread (its kill gets the bounded retry's
 * tries, `KILL_RETRY_SEED_LIVE_UNREAD`).
 */
export const OLD_LIFE_WAIT_SEED_LIVE_UNREAD = 'live-unread'

// ---------------------------------------------------------------------------
// What a round met
// ---------------------------------------------------------------------------

/** A CONFLICT or an UNUSABLE NAME answer met at a kill try. */
export const OLD_LIFE_WAIT_AT_KILL = KILL_REFUSAL_AT_KILL
/** Met at a `status` read between a kill's tries. */
export const OLD_LIFE_WAIT_AT_STATUS_READ = KILL_REFUSAL_AT_READ
/** Met at a `get` of the old row. */
export const OLD_LIFE_WAIT_AT_GET = 'get'
/** Met at a bypassing `find-missing` run. */
export const OLD_LIFE_WAIT_AT_FIND_MISSING = 'find-missing'

/** Where a refusal was met. */
export type OldLifeWaitRefusalAt =
  | typeof OLD_LIFE_WAIT_AT_KILL
  | typeof OLD_LIFE_WAIT_AT_STATUS_READ
  | typeof OLD_LIFE_WAIT_AT_GET
  | typeof OLD_LIFE_WAIT_AT_FIND_MISSING

/** One CONFLICT or UNUSABLE NAME answer a round met: where, its class (by the classifier) and the thrown value, raw. Latches no one. */
export interface OldLifeWaitRefusal {
  readonly at: OldLifeWaitRefusalAt
  readonly errorClass: typeof AD_ERROR_CLASS_CONFLICT | typeof AD_ERROR_CLASS_UNUSABLE_NAME
  readonly error: unknown
}

/** What one round's calls met, kept by the session manager's wait dependencies. */
export interface OldLifeWaitAnswers {
  /** Every CONFLICT and UNUSABLE NAME answer met, in order. */
  readonly refusals: readonly OldLifeWaitRefusal[]
  /** The first UNCLASSIFIED answer met, raw; absent when none was. */
  readonly unclassified?: unknown
  /** The round's last kill's bounded retry result; absent when it made no kill. */
  readonly lastKill?: KillRetryResult
  /**
   * The class (by name, through `src/ad-error-class.ts`) of the last answer
   * that failed a `get` or a `find-missing` run of the round; absent when
   * none failed. Names the class in the end line of a round a failed `get`
   * or run ended (an ENVIRONMENT `get` included).
   */
  readonly failedCallClass?: string
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** The no-launch form reached step 6: the row is finished. */
export const OLD_LIFE_WAIT_END_ROW_FINISHED = 'row-finished'
/** The hold ended while the round ran (its kill's tries included): a success. */
export const OLD_LIFE_WAIT_END_HOLD_ENDED = 'hold-ended'
/** A shutdown, or the last waiter's teardown, stopped the round. */
export const OLD_LIFE_WAIT_END_STOPPED = 'stopped'
/** A configured persona's own row is latched: a read of it latched the persona, or the persona was latched already. */
export const OLD_LIFE_WAIT_END_LATCHED = 'latched'
/** The round's kill decided the ordinary kill-failure alert. */
export const OLD_LIFE_WAIT_END_KILL_FAILED = 'kill-failed'
/** Step 5: the old row stayed live after runs that judged it; the ordinary alert, with no description. */
export const OLD_LIFE_WAIT_END_ESCALATED = 'escalated'
/** The kill met a CONFLICT or an unusable recorded name. */
export const OLD_LIFE_WAIT_END_REFUSED = 'refused'
/** A run did not judge the `pending` old row, or no run judged it (SRJ-717). */
export const OLD_LIFE_WAIT_END_NOT_JUDGED = 'not-judged'
/** An UNAVAILABLE answer (a kill's that stands, other than one that decided the alert). */
export const OLD_LIFE_WAIT_END_UNAVAILABLE = 'unavailable'
/** An ENVIRONMENT answer. */
export const OLD_LIFE_WAIT_END_ENVIRONMENT = 'environment'
/** A CONFIG answer, or no kill of a row last read `pending` while `ad-config-malformed` is raised. */
export const OLD_LIFE_WAIT_END_CONFIG = 'config'
/** An UNCLASSIFIED answer. */
export const OLD_LIFE_WAIT_END_UNCLASSIFIED = 'unclassified'
/** A `get` or a run failed with an answer of no class above. */
export const OLD_LIFE_WAIT_END_CALL_FAILED = 'call-failed'
/** A dependency failed. */
export const OLD_LIFE_WAIT_END_INTERNAL_ERROR = 'internal-error'

/** How a round ended, for its end line. */
export type OldLifeWaitEndKind =
  | typeof OLD_LIFE_WAIT_END_ROW_FINISHED
  | typeof OLD_LIFE_WAIT_END_HOLD_ENDED
  | typeof OLD_LIFE_WAIT_END_STOPPED
  | typeof OLD_LIFE_WAIT_END_LATCHED
  | typeof OLD_LIFE_WAIT_END_KILL_FAILED
  | typeof OLD_LIFE_WAIT_END_ESCALATED
  | typeof OLD_LIFE_WAIT_END_REFUSED
  | typeof OLD_LIFE_WAIT_END_NOT_JUDGED
  | typeof OLD_LIFE_WAIT_END_UNAVAILABLE
  | typeof OLD_LIFE_WAIT_END_ENVIRONMENT
  | typeof OLD_LIFE_WAIT_END_CONFIG
  | typeof OLD_LIFE_WAIT_END_UNCLASSIFIED
  | typeof OLD_LIFE_WAIT_END_CALL_FAILED
  | typeof OLD_LIFE_WAIT_END_INTERNAL_ERROR

/** What the decision is given. */
export interface OldLifeWaitEndInput {
  /** How the round's no-launch sequence ended. */
  readonly outcome: LiveRowSequenceOutcome
  /** What its calls met. */
  readonly answers: OldLifeWaitAnswers
  /** True when the hold no longer exists once the round has settled. */
  readonly holdEnded: boolean
}

/** What follows a round. */
export interface OldLifeWaitEndDecision {
  readonly kind: OldLifeWaitEndKind
  /** The hold goes on (no end of the round ended it). */
  readonly holdGoesOn: boolean
  /** Mark the hold kill-failed (SRJ-812). */
  readonly markKillFailed: boolean
  /** Arm each waiting persona's retry timer with `OLD_LIFE_WAIT_ARM_CAUSE`, uncounted. */
  readonly armWaiting: boolean
  /** The CONFLICT and UNUSABLE NAME answers to write, each one line and one `persona-teardown-notice` entry. */
  readonly notices: readonly OldLifeWaitRefusal[]
  /**
   * Report the round's first UNCLASSIFIED answer to the old row's
   * unclassified-error episode (SRJ-313; keyed by the instance id, its alert
   * on the log-only route). Only for a round after which the hold goes on.
   */
  readonly reportUnclassified: boolean
}

/**
 * What follows one old-life wait round (see the module comment), first match
 * wins: the hold's end while the round's kill ran, the row finished, the
 * hold gone by the round's end, a latch, a stop by a shutdown or a teardown;
 * otherwise (a latch included) the hold goes on and the waiting personas are
 * armed, with the mark for a kill that decided the ordinary alert or step
 * 5's alert. Pure; never throws.
 */
export function decideOldLifeWaitEnd(input: OldLifeWaitEndInput): OldLifeWaitEndDecision {
  const { outcome, answers } = input
  const lastKill = answers.lastKill
  const notices = answers.refusals
  const reportUnclassified = answers.unclassified !== undefined
  // A round after which the hold is over reports nothing to the episode: the
  // hold's end ended it (SRJ-313, SRJ-811).
  const ends = (kind: OldLifeWaitEndKind, withNotices: boolean): OldLifeWaitEndDecision => ({
    kind,
    holdGoesOn: false,
    markKillFailed: false,
    armWaiting: false,
    notices: withNotices ? notices : [],
    reportUnclassified: false,
  })
  // SRJ-702, SRJ-811 (option A): the hold's end while the kill ran is a
  // success, and wins over a stop that lands in the same window.
  if (lastKill?.end === KILL_RETRY_END_HOLD_ENDED) return ends(OLD_LIFE_WAIT_END_HOLD_ENDED, true)
  if (outcome.kind === LIVE_ROW_OUTCOME_STOPPED && outcome.reason === LIVE_ROW_STOP_HOLD_ENDED) {
    return ends(OLD_LIFE_WAIT_END_HOLD_ENDED, true)
  }
  if (outcome.kind === LIVE_ROW_OUTCOME_ROW_FINISHED) return ends(OLD_LIFE_WAIT_END_ROW_FINISHED, true)
  if (input.holdEnded) return ends(OLD_LIFE_WAIT_END_HOLD_ENDED, true)
  const kept = (kind: OldLifeWaitEndKind, markKillFailed = false): OldLifeWaitEndDecision => ({
    kind,
    holdGoesOn: true,
    markKillFailed,
    armWaiting: true,
    notices,
    reportUnclassified,
  })
  if (outcome.kind === LIVE_ROW_OUTCOME_STOPPED) {
    if (outcome.reason === LIVE_ROW_STOP_LATCHED) {
      // SRJ-114, SRJ-513, SRJ-502: a configured persona's own row is latched.
      // The hold goes on and the waiting personas are armed, as after every
      // end that keeps the hold other than a stop; the session manager's arm
      // skips a latched persona (SRJ-305, SRJ-301). A read-latch end of the
      // kill's tries is a failure end whose ordinary alert stands, so it
      // marks the hold (SRJ-812); only tries a stop ended do not.
      const marks = lastKill !== undefined && lastKill.alert.kind === KILL_RETRY_ALERT_ORDINARY && lastKill.end !== KILL_RETRY_END_STOPPED
      return kept(OLD_LIFE_WAIT_END_LATCHED, marks)
    }
    // SRJ-702, SRJ-706: a shutdown or teardown stop drops what came after it.
    return ends(OLD_LIFE_WAIT_END_STOPPED, false)
  }
  switch (outcome.kind) {
    case LIVE_ROW_OUTCOME_ESCALATED:
      return kept(OLD_LIFE_WAIT_END_ESCALATED, true)
    case LIVE_ROW_OUTCOME_ABORTED: {
      // SRJ-812: only a kill whose tries decided the ordinary alert, with no stop, marks the hold.
      if (lastKill !== undefined && lastKill.alert.kind === KILL_RETRY_ALERT_ORDINARY && !killRetryStopped(lastKill)) {
        return kept(OLD_LIFE_WAIT_END_KILL_FAILED, true)
      }
      return kept(endKindOfClass(outcome.errorClass))
    }
    case LIVE_ROW_OUTCOME_NOT_JUDGED:
    case LIVE_ROW_OUTCOME_NO_JUDGED_RUN:
      return kept(OLD_LIFE_WAIT_END_NOT_JUDGED)
    case LIVE_ROW_OUTCOME_CONFIG_MALFORMED:
      return kept(OLD_LIFE_WAIT_END_CONFIG)
    case LIVE_ROW_OUTCOME_READ_REFUSED:
    case LIVE_ROW_OUTCOME_RUN_REFUSED:
      return kept(notices.length > 0 ? OLD_LIFE_WAIT_END_REFUSED : endKindOfFailedCall(answers.failedCallClass))
    default:
      // A dependency's failure, or an end the no-launch form never reaches.
      return kept(OLD_LIFE_WAIT_END_INTERNAL_ERROR)
  }
}

/**
 * The end kind of a round a failed `get` or run ended, by the failing
 * answer's class: UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED by name,
 * as an abort's is; any other class, or none recorded, a failed call.
 */
function endKindOfFailedCall(errorClass: string | undefined): OldLifeWaitEndKind {
  switch (errorClass) {
    case AD_ERROR_CLASS_UNAVAILABLE:
    case AD_ERROR_CLASS_ENVIRONMENT:
    case AD_ERROR_CLASS_CONFIG:
    case AD_ERROR_CLASS_UNCLASSIFIED:
      return endKindOfClass(errorClass)
    default:
      return OLD_LIFE_WAIT_END_CALL_FAILED
  }
}

/** The end kind of an abort by `errorClass`. */
function endKindOfClass(errorClass: string): OldLifeWaitEndKind {
  switch (errorClass) {
    case AD_ERROR_CLASS_CONFLICT:
    case AD_ERROR_CLASS_UNUSABLE_NAME:
      return OLD_LIFE_WAIT_END_REFUSED
    case AD_ERROR_CLASS_UNAVAILABLE:
      return OLD_LIFE_WAIT_END_UNAVAILABLE
    case AD_ERROR_CLASS_ENVIRONMENT:
      return OLD_LIFE_WAIT_END_ENVIRONMENT
    case AD_ERROR_CLASS_CONFIG:
      return OLD_LIFE_WAIT_END_CONFIG
    case AD_ERROR_CLASS_UNCLASSIFIED:
      return OLD_LIFE_WAIT_END_UNCLASSIFIED
    default:
      return OLD_LIFE_WAIT_END_INTERNAL_ERROR
  }
}

// ---------------------------------------------------------------------------
// Texts and lines
// ---------------------------------------------------------------------------

/** An instance id or key for a line: redacted, one line, capped. */
function render(text: unknown): string {
  const rendered = renderLogMessageText(text)
  return rendered === '' ? 'unknown' : rendered
}

/**
 * The reference an old-life wait's entries and lines name (SRJ-1007): the
 * old key, as `persona=<key>`, when the old row is its `cscb_<key>`;
 * otherwise the instance id standing in for it, as `instanceId=<id>`. Pure.
 */
export function oldLifeWaitRef(instanceId: string, oldKey: string): string {
  return oldKey === instanceId ? `instanceId=${render(instanceId)}` : `persona=${render(oldKey)}`
}

/**
 * The text of a CONFLICT or UNUSABLE NAME answer met in an old-life wait
 * (SRJ-1002, SRJ-1003, SRJ-811), its `persona-teardown-notice` entry's
 * notice: at a kill try or a `status` read between tries, the kill outcome's
 * one-line rendering (`teardownKillRefusalNoticeText`, the builder the
 * persona teardown's entry uses); at a `get` or a run, the call, the
 * instance id, the class and the redacted answer. Nothing latched on it, so
 * it carries no hold sentence. Never throws.
 *
 *   agent-director kill of <id> refused at a try: <describeKillOutcome>
 *   agent-director kill of <id> refused at a status read between its tries: <describeKillOutcome>
 *   agent-director <get|find-missing> for <id> refused: class=<class> <name> message="…"
 */
export function oldLifeWaitRefusalNoticeText(instanceId: string, refusal: OldLifeWaitRefusal): string {
  if (refusal.at === OLD_LIFE_WAIT_AT_KILL || refusal.at === OLD_LIFE_WAIT_AT_STATUS_READ) {
    return teardownKillRefusalNoticeText(render(instanceId), { at: refusal.at, errorClass: refusal.errorClass, error: refusal.error })
  }
  return `agent-director ${refusal.at} for ${render(instanceId)} refused: class=${refusal.errorClass} ${describeAgentDirectorFailure(refusal.error)}`
}

/** What a round's end line names: what ended it. */
function describeEnd(kind: OldLifeWaitEndKind): string {
  switch (kind) {
    case OLD_LIFE_WAIT_END_ROW_FINISHED:
      return 'the old row is finished'
    case OLD_LIFE_WAIT_END_HOLD_ENDED:
      return 'its hold ended while it ran (a success, as a finished read is)'
    case OLD_LIFE_WAIT_END_STOPPED:
      return 'stopped (a shutdown, or the teardown of the last persona waiting on its hold)'
    case OLD_LIFE_WAIT_END_LATCHED:
      return "the row's own persona is latched (a read of the row latched it, or it was latched already)"
    case OLD_LIFE_WAIT_END_KILL_FAILED:
      return 'the old key\'s kill failed (the ordinary kill-failure alert)'
    case OLD_LIFE_WAIT_END_ESCALATED:
      return 'the old row stayed live after runs that judged it (the ordinary kill-failure alert)'
    case OLD_LIFE_WAIT_END_REFUSED:
      return 'a CONFLICT or an unusable recorded name was met; nothing latches'
    case OLD_LIFE_WAIT_END_NOT_JUDGED:
      return 'a run did not judge the pending old row; no alert'
    case OLD_LIFE_WAIT_END_UNAVAILABLE:
      return 'an UNAVAILABLE answer'
    case OLD_LIFE_WAIT_END_ENVIRONMENT:
      return 'an ENVIRONMENT answer (tmux-unavailable is raised for the waiting personas)'
    case OLD_LIFE_WAIT_END_CONFIG:
      return 'a CONFIG answer, or no kill of a row last read pending while agent-director refuses its config file'
    case OLD_LIFE_WAIT_END_UNCLASSIFIED:
      return 'an UNCLASSIFIED answer'
    case OLD_LIFE_WAIT_END_CALL_FAILED:
      return 'a get or a run failed'
    case OLD_LIFE_WAIT_END_INTERNAL_ERROR:
      return 'a dependency failed'
  }
}

/** What a round's end line is built from. */
export interface OldLifeWaitEndLineInput {
  readonly instanceId: string
  readonly oldKey: string
  readonly decision: OldLifeWaitEndDecision
  /** The waiting personas' keys whose timers were armed, in order. */
  readonly armed: readonly string[]
}

/**
 * One round's end line (SRJ-811, SRJ-1014):
 *
 *   [slack] old-life-wait: <ref> (instanceId=<id>): ended — <what ended it>; <the hold goes on|the hold is over|nothing more>[; the hold is marked kill-failed]; waiting personas armed (held-for-old-life): <keys|none> (b.jg5 SRJ-811)
 *
 * Pure.
 */
export function oldLifeWaitEndLine(input: OldLifeWaitEndLineInput): string {
  const { decision } = input
  const hold = decision.holdGoesOn
    ? 'the hold goes on'
    : decision.kind === OLD_LIFE_WAIT_END_STOPPED
      ? 'nothing more'
      : 'the hold is over'
  const mark = decision.markKillFailed ? '; the hold is marked kill-failed' : ''
  const armed = input.armed.length === 0 ? 'none' : input.armed.map(render).join(', ')
  return (
    `${OLD_LIFE_WAIT_LOG_PREFIX} ${oldLifeWaitRef(input.instanceId, input.oldKey)} (instanceId=${render(input.instanceId)}): ` +
    `ended — ${describeEnd(decision.kind)}; ${hold}${mark}; waiting personas armed (${OLD_LIFE_WAIT_ARM_CAUSE}): ${armed} (b.jg5 SRJ-811)`
  )
}
