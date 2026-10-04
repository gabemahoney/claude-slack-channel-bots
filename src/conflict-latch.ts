/**
 * conflict-latch.ts — The per-persona latch (b.jg5 SRJ-501), its record and
 * the CONFLICT case recognition (b.jg5 SRJ-507).
 *
 * What latches. An `ErrTmuxSessionConflict` from any verb for persona P
 * latches P (SRJ-501); so do a `provenance_conflict` note on P's own row
 * (case "conflicting labels"), an unusable recorded name (SRJ-512) and a
 * `pending` row with no launch start (SRJ-513). While P is latched CSCB's
 * automated paths attempt nothing for it beyond the re-check (SRJ-502). One
 * latch per persona, held in server memory only: a restart drops every latch
 * with the process, and a persona's teardown forgets its latch silently
 * (SRJ-504).
 *
 * What the record holds ({@link ConflictLatchRecord}):
 *   - the quoted session: the first non-empty double-quoted name on one line
 *     (quotes paired left to right) in agent-director's description, or
 *     `slack_bot_<key>` when it gives none (a note latch has no
 *     description), kept bare (no quotes) and redacted;
 *   - the case ({@link LatchCase}): one of SRJ-507's nine CONFLICT cases,
 *     unrecognised text, or one of the two hold cases, "unusable recorded
 *     name" and "launch start not recorded";
 *   - the refused operation ({@link RefusedOperation}): a plain spawn, a
 *     reuse spawn or a `resume`; P's bring-up by the restart path's decision
 *     (a note latch); P's next check or recovery (a pane verb or a kill);
 *     none (the two hold cases);
 *   - the row's state when the latch was set ({@link LatchRowState}): a state
 *     read, no row (`ErrSpawnNotFound`), or unreadable; an unreadable state
 *     counts as live ({@link rowStateCountsAsLive});
 *   - agent-director's description, when there is one, only as the
 *     classifier renders a message (`renderLogMessageText`: redacted, on one
 *     line, capped), never raw.
 *
 * Case recognition (SRJ-507). CSCB tells the CONFLICT cases apart only by
 * agent-director's case words, checked in {@link CONFLICT_CASE_ORDER}, the
 * first match deciding; none gives unrecognised text
 * ({@link recogniseConflictCase}). The words come from
 * `src/ad-description-phrases.ts`; the order lives here. The plain spawn's
 * label wordings ("its label names this instance id", "its label does not
 * name this instance id") are not case phrases. "never reported in" stays a
 * distinct case in the record but is posted and re-checked as unrecognised
 * text ({@link takesUnrecognisedHandling}).
 *
 * The latch ({@link createConflictLatch}): one instance per server, built in
 * `main()`. `set` latches a persona, relatches it with a different case
 * (replacing the record), or, with the same case, keeps it with the record
 * unchanged (SRJ-506), and answers which ({@link ConflictLatchSetOutcome});
 * `setFromConflict` builds the record from a thrown CONFLICT value,
 * `setFromUnusableName` from a thrown UNUSABLE NAME value, and
 * `setLaunchStartNotRecorded` for a `pending` row with no launch start. Every set
 * calls each set observer once with the key, the outcome and the record, so
 * the CONFLICT notice and the holds react to it. `forget(key)` drops one
 * persona's latch silently: no post, no set observer call, no line; its
 * forget observers (`addForgetObserver`: the re-check timer's stop, bound
 * by {@link bindLatchRecheck}) are told the key. The persona
 * teardown calls it (`runTeardown`, `src/persona-lifecycle.ts`) after the
 * launch in flight settled and right before it forgets the persona's notice
 * episodes, which ends the CONFLICT episode with it. There is no forget-all.
 *
 * The unusable recorded name (SRJ-512): {@link isUnusableNameError} tells
 * an UNUSABLE NAME value by the classifier, and {@link unusableNameSetInput}
 * builds its `set` input: the case "unusable recorded name", the refused
 * operation "none", the row state the caller gives, the classification's
 * message as the description and the session quoted in it. Its triggers are
 * in `src/session-manager.ts` (the collision ladder's spawns, the reuse
 * spawn, `resume`, kill and delete, the shared own-row `status` and `get`
 * reads and their step, the shared pane read behind the working-pane read
 * and the prompt rows' pane reads, the reconnect's `send-keys`, the dialog
 * approver's calls and the restart path's kill, `latchOnRestartKillOutcome`)
 * and the liveness, reconnect and restart-kill adapters in `src/server.ts`:
 * the first two apply the session manager's own-row `status` step, the third
 * `latchOnRestartKillOutcome`.
 *
 * The launch start not recorded (SRJ-513): {@link launchStartNotRecordedSetInput}
 * builds its `set` input: the case "launch start not recorded", the refused
 * operation "none", the row state the caller gives (`pending`), the session
 * `slack_bot_<key>` and no description. Its trigger is the row-read rule's
 * launch-start decision (`decideOwnRowRead`, `src/row-read-rules.ts`), acted
 * on by the session manager's shared own-row `get` read and own-row `status`
 * step (so also by the dialog approver's `status` read and the liveness and
 * reconnect adapters in `src/server.ts`), which latch through `set` with
 * this input. The re-check's step-1 read latches through the same shared
 * reads, so through the same input.
 *
 * The notices (SRJ-1004, SRJ-1019, SRJ-1020, SRJ-508, SRJ-1016): {@link conflictNoticeText}
 * builds the CONFLICT notice's body from a CONFLICT latch's record, from the
 * exported fixed lines (`CONFLICT_NOTICE_*`) and the case sentences
 * ({@link CONFLICT_CASE_SENTENCES}); {@link unusableNameNoticeText} builds
 * SRJ-1019's from the persona's key and the record's description, from the
 * exported fixed parts (`UNUSABLE_NAME_NOTICE_*`); and
 * {@link launchStartNotRecordedNoticeText} builds SRJ-1020's from the
 * persona's key, from the exported fixed parts (`LAUNCH_START_NOTICE_*`).
 * One set observer
 * ({@link createConflictNoticeObserver}, bound by {@link bindConflictNotice}
 * in `main()`) dispatches by latch kind: it ends the persona's open episodes
 * of the other latch kinds silently, then begins or keeps its episode of the
 * record's kind in the server's notice episodes (`src/persona-episodes.ts`),
 * the CONFLICT episode with the record's case, and posts that kind's notice
 * there at most once per episode ({@link HOLD_NOTICES} for a hold case): a
 * latch posts once, a relatch with a new case posts once more, and a
 * same-case set posts nothing. The post goes through the episodes' sink, the
 * persona notifier, which adds the persona prefix. A quoted description is
 * redacted and capped as the record holds it, then escaped once for Slack
 * (`escapeSlackControlCharacters`); so is the session name. Log lines stay
 * unescaped.
 *
 * The holds (SRJ-305, SRJ-310, SRJ-313, SRJ-502): a second set observer
 * ({@link createConflictLatchHoldObserver}, bound by
 * {@link bindConflictLatchHolds} in `main()` before the notice) stops the
 * persona's retry timer, ends its `tmux-unresponsive` condition silently,
 * ends its unclassified-error episode, ends its slow-recovery episode
 * with its count (SRJ-610) and ends its stuck-launch episode (SRJ-1016) on
 * every set, through the injected
 * {@link ConflictLatchHolds}. What else a latch holds back is asked of the
 * latch where it happens: the collision ladder (`src/session-manager.ts`,
 * which latches on a CONFLICT or an UNUSABLE NAME at a spawn or resume and
 * launches no latched persona), the restart work, the retry action and the health tick, each
 * through `isLatched`.
 *
 * The recovery notice (SRJ-1005): {@link conflictRecoveryText},
 * {@link holdRecoveryText} and {@link latchRecoveryText} build it for either
 * latch kind ({@link LatchKind}) and one of five reasons
 * ({@link LatchRecoveryReason}); nothing here posts it (see its section).
 *
 * Every latching site latches through `set`, `setFromConflict`,
 * `setFromUnusableName` or `setLaunchStartNotRecorded`. A latch is dropped
 * by the persona's teardown (`forget`, silently) and by the re-check's clear
 * hand-off (below). `setProbeDropped` marks the record's episode as having
 * its "this row's own id" probe dropped (`probeDropped`); a new case's
 * record starts without the mark.
 *
 * The re-check (SRJ-505): {@link LATCH_RECHECK_INTERVAL_MS}, step 1's reading
 * ({@link LatchRecheckReading}), the step, action and call identifiers
 * (`RECHECK_STEP_*`, `RECHECK_ACTION_*`, `RECHECK_CALL_*`), the pure decision
 * ({@link decideLatchRecheck}) and the finished-row retry's launch
 * ({@link decideFinishedRowLaunch}), the verdicts on a `read-pane` answer
 * ({@link decideLatchRecheckProbe}, {@link decideLatchRecheckPendingReadPane}),
 * the clear hand-off's type with its silent form
 * ({@link createSilentLatchRecheckClear}), the per-persona timer
 * ({@link createLatchRecheckController}, bound by {@link bindLatchRecheck})
 * and the round's line ({@link latchRecheckRoundLine}). The round itself,
 * which makes the calls, is the session manager's (`src/session-manager.ts`),
 * built with its production dependencies by `buildLatchRecheck` there. The
 * silent clear forgets the latch and stops the timer, with no recovery post;
 * SRJ-506's clear takes its place through that builder.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] conflict-latch: persona=<key> latched — case=<case> session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> relatched — case=<case> (was <case>) session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> set observer failed: <error>
 *   [slack] conflict-latch: persona=<key> hold failed (<hold>): <error>
 *   [slack] conflict-latch: persona=<key> forget observer failed: <error>
 *   [slack] conflict-latch: persona=<key> re-check timer could not be set: <error> — not armed
 *   [slack] conflict-latch: persona=<key> re-check round failed: <error>
 *   [slack] conflict-latch: re-check of <ref> — case=<case> call=<call> answer=<answer>  (logged by the session manager's round)
 *
 * where `<state>` is {@link describeLatchRowState}'s rendering. A same-case
 * set logs nothing. No line carries a token: the session name and the
 * description are redacted before they are stored.
 *
 * No agent-director call, no persistence and no module-scope state; the
 * only timer is the re-check controller's, on its injected clock, and
 * nothing runs at import or at creation. No label option name is spelled
 * here (b.jg5 SRJ-716).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  classifyAdError,
  conflictDescriptionOf,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
} from './ad-error-class.ts'
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
} from './ad-description-phrases.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
import {
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_CONFLICT,
  PANE_READ_ENVIRONMENT,
  PANE_READ_GONE,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  PANE_READ_UNUSABLE_NAME,
  type PaneReadOutcome,
} from './pane-read.ts'
import {
  describeLogMessage,
  describeThrownValue,
  isSafeIdentifier,
  renderLogMessageText,
} from './persona-connection-errors.ts'
import {
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED,
  PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
  type PersonaEpisodeKind,
  type PersonaEpisodes,
} from './persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName } from './persona-identity.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { escapeSlackControlCharacters } from './slack-text-escape.ts'

// ---------------------------------------------------------------------------
// Cases (b.jg5 SRJ-501, SRJ-507, SRJ-512, SRJ-513)
// ---------------------------------------------------------------------------

/** CONFLICT case "conflicting labels" (also a latch from a `provenance_conflict` note). */
export const LATCH_CASE_CONFLICTING_LABELS = 'conflicting-labels'
/** CONFLICT case "the agent's pane was not found". */
export const LATCH_CASE_PANE_NOT_FOUND = 'pane-not-found'
/** CONFLICT case "not this launch's session". */
export const LATCH_CASE_NOT_THIS_LAUNCH = 'not-this-launch'
/** CONFLICT case "left over from an earlier life" (the pre-spawn scan's and the "duplicate session" leftover alike). */
export const LATCH_CASE_LEFTOVER = 'leftover'
/** CONFLICT case "never reported in": kept in the record, posted and re-checked as unrecognised text. */
export const LATCH_CASE_NEVER_REPORTED_IN = 'never-reported-in'
/** CONFLICT case "this row's own id". */
export const LATCH_CASE_OWN_ID = 'own-id'
/** CONFLICT case "no valid instance id". */
export const LATCH_CASE_NO_VALID_ID = 'no-valid-id'
/** CONFLICT case "a different instance id". */
export const LATCH_CASE_DIFFERENT_ID = 'different-id'
/** CONFLICT case "another agent-director store". */
export const LATCH_CASE_ANOTHER_STORE = 'another-store'
/** A CONFLICT whose description carries none of the case words. */
export const LATCH_CASE_UNRECOGNISED = 'unrecognised'
/**
 * Hold case "unusable recorded name" (SRJ-512): production sets it through
 * `set` with {@link unusableNameSetInput}'s input; `setFromUnusableName` is
 * the same set from a thrown value.
 */
export const LATCH_CASE_UNUSABLE_RECORDED_NAME = 'unusable-recorded-name'
/**
 * Hold case "launch start not recorded" (SRJ-513): production sets it through
 * `set` with {@link launchStartNotRecordedSetInput}'s input;
 * `setLaunchStartNotRecorded` is the same set.
 */
export const LATCH_CASE_LAUNCH_START_NOT_RECORDED = 'launch-start-not-recorded'

/**
 * The CONFLICT case words in SRJ-507's order: the first whose phrase a
 * description contains decides its case. "no pane 0.0" is withdrawn (HO rev
 * 17), and the plain spawn's label wordings are never case phrases (HO rev
 * 15).
 */
export const CONFLICT_CASE_ORDER = Object.freeze([
  Object.freeze({ latchCase: LATCH_CASE_CONFLICTING_LABELS, phrase: CONFLICT_CONFLICTING_LABELS_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_PANE_NOT_FOUND, phrase: CONFLICT_PANE_NOT_FOUND_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_NOT_THIS_LAUNCH, phrase: CONFLICT_NOT_THIS_LAUNCH_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_LEFTOVER, phrase: CONFLICT_LEFTOVER_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_NEVER_REPORTED_IN, phrase: CONFLICT_NEVER_REPORTED_IN_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_OWN_ID, phrase: CONFLICT_OWN_ID_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_NO_VALID_ID, phrase: CONFLICT_NO_VALID_ID_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_DIFFERENT_ID, phrase: CONFLICT_DIFFERENT_ID_PHRASE }),
  Object.freeze({ latchCase: LATCH_CASE_ANOTHER_STORE, phrase: CONFLICT_ANOTHER_STORE_PHRASE }),
] as const)

/** A CONFLICT case recognised by its words (one entry of {@link CONFLICT_CASE_ORDER}). */
export type RecognisedConflictCase = (typeof CONFLICT_CASE_ORDER)[number]['latchCase']

/** A CONFLICT latch's case: a recognised case or unrecognised text. */
export type ConflictLatchCase = RecognisedConflictCase | typeof LATCH_CASE_UNRECOGNISED

/** The two hold cases: each posts its own notice under its own episode kind ({@link HOLD_NOTICES}). */
export const HOLD_LATCH_CASES = Object.freeze([
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
] as const)

/** A hold case. */
export type HoldLatchCase = (typeof HOLD_LATCH_CASES)[number]

/** Any case a latch records. */
export type LatchCase = ConflictLatchCase | HoldLatchCase

/** Every case a latch records: the nine CONFLICT cases in SRJ-507's order, unrecognised text, then the two hold cases. */
export const LATCH_CASES: readonly LatchCase[] = Object.freeze([
  ...CONFLICT_CASE_ORDER.map((entry) => entry.latchCase),
  LATCH_CASE_UNRECOGNISED,
  ...HOLD_LATCH_CASES,
])

/** True when `latchCase` is one of the two hold cases. */
export function isHoldLatchCase(latchCase: LatchCase): latchCase is HoldLatchCase {
  return (HOLD_LATCH_CASES as readonly LatchCase[]).includes(latchCase)
}

/** The cases posted with the unrecognised-text wording (SRJ-1004) and re-checked as unrecognised text (SRJ-505). */
export const UNRECOGNISED_HANDLING_CASES: ReadonlySet<LatchCase> = new Set<LatchCase>([
  LATCH_CASE_UNRECOGNISED,
  LATCH_CASE_NEVER_REPORTED_IN,
])

/** True for unrecognised text and "never reported in" (SRJ-507): both take the unrecognised-text wording and re-check. */
export function takesUnrecognisedHandling(latchCase: LatchCase): boolean {
  return UNRECOGNISED_HANDLING_CASES.has(latchCase)
}

/**
 * The CONFLICT case of agent-director's `description` (SRJ-507): the first
 * case in {@link CONFLICT_CASE_ORDER} whose phrase it contains, else
 * unrecognised text (also for a value that is not a string). Pure.
 */
export function recogniseConflictCase(description: unknown): ConflictLatchCase {
  if (typeof description !== 'string') return LATCH_CASE_UNRECOGNISED
  return CONFLICT_CASE_ORDER.find((entry) => description.includes(entry.phrase))?.latchCase ?? LATCH_CASE_UNRECOGNISED
}

/** Each double-quoted span, quotes paired left to right. */
const QUOTED_SPAN_RE = /"([^"]*)"/g

/** A line break, by any of the terminators a JavaScript regex knows. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/

/**
 * The latch's quoted session for persona `key` (SRJ-501): the first
 * double-quoted name in `description` that is non-empty and on one line,
 * without its quotes and through `redactSlackLogText`, else the persona's own
 * session name `slack_bot_<key>` (`personaTmuxSessionName`), also when
 * `description` is not a string. Quotes pair in order, so an empty or
 * multi-line span is skipped whole rather than lending its closing quote to
 * the next. Pure.
 */
export function conflictSessionName(description: unknown, key: string): string {
  let quoted: string | undefined
  if (typeof description === 'string') {
    for (const match of description.matchAll(QUOTED_SPAN_RE)) {
      const name = match[1] ?? ''
      if (name !== '' && !LINE_BREAK_RE.test(name)) {
        quoted = name
        break
      }
    }
  }
  return quoted === undefined ? personaTmuxSessionName(key) : redactSlackLogText(quoted)
}

// ---------------------------------------------------------------------------
// Refused operation (b.jg5 SRJ-501)
// ---------------------------------------------------------------------------

/** A plain first spawn was refused. */
export const REFUSED_OPERATION_PLAIN_SPAWN = 'plain-spawn'
/** A spawn with `--reuse-finished` was refused. */
export const REFUSED_OPERATION_REUSE_SPAWN = 'reuse-spawn'
/** A `resume` was refused. */
export const REFUSED_OPERATION_RESUME = 'resume'
/** P's bring-up by the restart path's decision: a latch from a `provenance_conflict` note (E14). */
export const REFUSED_OPERATION_BRING_UP = 'bring-up'
/** P's next check or recovery, decided afresh from its row by the restart path's decision: a pane verb's or a kill's CONFLICT. */
export const REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY = 'next-check-or-recovery'
/** None: the two hold cases, whose re-check reads only `status`. */
export const REFUSED_OPERATION_NONE = 'none'

/** Every refused operation SRJ-501 names. */
export const REFUSED_OPERATIONS = Object.freeze([
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_REUSE_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
] as const)

/** What the latched persona's refusal refused. */
export type RefusedOperation = (typeof REFUSED_OPERATIONS)[number]

// ---------------------------------------------------------------------------
// Recorded row state (b.jg5 SRJ-501, SRJ-505)
// ---------------------------------------------------------------------------

/** The row read in a state. */
export const LATCH_ROW_STATE_KIND_READ = 'read'
/** No row: the read answered `ErrSpawnNotFound`, or the pre-spawn scan wrote none. */
export const LATCH_ROW_STATE_KIND_NO_ROW = 'no-row'
/** The state could not be read. Counts as live. */
export const LATCH_ROW_STATE_KIND_UNREADABLE = 'unreadable'

/** The row's state when the latch was set. */
export type LatchRowState =
  | { readonly kind: typeof LATCH_ROW_STATE_KIND_READ; readonly state: string }
  | { readonly kind: typeof LATCH_ROW_STATE_KIND_NO_ROW }
  | { readonly kind: typeof LATCH_ROW_STATE_KIND_UNREADABLE }

/** No row, as a value. */
export const LATCH_ROW_STATE_NO_ROW: LatchRowState = Object.freeze({ kind: LATCH_ROW_STATE_KIND_NO_ROW })

/** An unreadable state, as a value. */
export const LATCH_ROW_STATE_UNREADABLE: LatchRowState = Object.freeze({ kind: LATCH_ROW_STATE_KIND_UNREADABLE })

/**
 * The recorded state for a row read in `state`. A value that is not a short
 * identifier (`isSafeIdentifier`; every agent-director state is one) is
 * recorded as unreadable, so nothing else is stored or logged.
 */
export function latchRowStateRead(state: unknown): LatchRowState {
  return isSafeIdentifier(state)
    ? Object.freeze({ kind: LATCH_ROW_STATE_KIND_READ, state })
    : LATCH_ROW_STATE_UNREADABLE
}

/**
 * Whether a recorded state counts as live (SRJ-501, SRJ-505): every state the
 * row had reported in by (`waiting`, `working`, `ask_user`,
 * `check_permission`, or any state CSCB does not know) and an unreadable
 * state count; `pending`, `ended`, `missing` and no row do not. A latch whose
 * recorded state counts as live is never cleared by a live reading.
 */
export function rowStateCountsAsLive(rowState: LatchRowState): boolean {
  switch (rowState.kind) {
    case LATCH_ROW_STATE_KIND_UNREADABLE:
      return true
    case LATCH_ROW_STATE_KIND_NO_ROW:
      return false
    case LATCH_ROW_STATE_KIND_READ:
      return rowState.state !== AGENT_DIRECTOR_PENDING_STATE && !AGENT_DIRECTOR_DEAD_STATES.has(rowState.state)
  }
}

/** A recorded state for a log line: the state read, `no-row` or `unreadable`. */
export function describeLatchRowState(rowState: LatchRowState): string {
  return rowState.kind === LATCH_ROW_STATE_KIND_READ ? rowState.state : rowState.kind
}

// ---------------------------------------------------------------------------
// The record and the set outcomes
// ---------------------------------------------------------------------------

/** One persona's latch record (SRJ-501). Frozen. */
export interface ConflictLatchRecord {
  /** The quoted session's name, without quotes and redacted; `slack_bot_<key>` when the description gave none. */
  readonly sessionName: string
  /** The case. */
  readonly latchCase: LatchCase
  /** What was refused. */
  readonly refusedOperation: RefusedOperation
  /** The row's state when the latch was set. */
  readonly rowState: LatchRowState
  /** agent-director's description, redacted, on one line and capped (`renderLogMessageText`); absent when there was none. */
  readonly description?: string
  /**
   * Set (true) once this episode's "this row's own id" probe is dropped
   * (b.jg5 SRJ-505's first table row: the single retry after a cleared probe
   * was refused again with that case), through the latch's
   * `setProbeDropped`; absent otherwise. A same-case set keeps it; a new
   * case begins a new episode and a new record without it.
   */
  readonly probeDropped?: true
}

/** What `set` takes: the record's fields and, when there is one, agent-director's description. */
export interface ConflictLatchSetInput {
  readonly latchCase: LatchCase
  readonly refusedOperation: RefusedOperation
  readonly rowState: LatchRowState
  /** The quoted session's name; `slack_bot_<key>` when absent. Redacted before it is stored. */
  readonly sessionName?: string
  /** agent-director's description; rendered by `renderLogMessageText` before it is stored, and left out when that is empty. */
  readonly description?: string
}

/** The fields `setFromConflict` takes besides the thrown value. */
export interface ConflictLatchConflictFields {
  readonly refusedOperation: RefusedOperation
  readonly rowState: LatchRowState
}

/** A persona that was not latched is now latched. */
export const CONFLICT_LATCH_SET_LATCHED = 'latched'
/** A latched persona was relatched with a different case: the record was replaced (a new episode). */
export const CONFLICT_LATCH_SET_RELATCHED = 'relatched'
/** A latched persona met its own case again: still latched, the record unchanged (SRJ-506). */
export const CONFLICT_LATCH_SET_SAME_CASE = 'same-case'

/** What one set did. */
export type ConflictLatchSetOutcome =
  | typeof CONFLICT_LATCH_SET_LATCHED
  | typeof CONFLICT_LATCH_SET_RELATCHED
  | typeof CONFLICT_LATCH_SET_SAME_CASE

/** What a set observer receives. */
export interface ConflictLatchSetEvent {
  readonly key: string
  readonly outcome: ConflictLatchSetOutcome
  /** The record now held (for a same-case set, the unchanged one). */
  readonly record: ConflictLatchRecord
  /** The record held before the set; absent for a new latch, the same as `record` for a same-case set. */
  readonly previous?: ConflictLatchRecord
}

/** Reacts to a set (the CONFLICT notice, the holds). A throw or rejection is logged and swallowed. */
export type ConflictLatchSetObserver = (event: ConflictLatchSetEvent) => void | Promise<void>

/** Dependencies of {@link createConflictLatch}. */
export interface ConflictLatchDeps {
  /** Receives each `[slack]` line (the server log). A throwing log is swallowed. */
  log: (line: string) => void
}

/** One server's latches. */
export interface ConflictLatch {
  /**
   * Latch persona `key`, relatch it with a different case (the record
   * replaced: case, refused operation, recorded state, session and
   * description), or keep it with the record unchanged for the same case.
   * Logs a latched or relatched line, then calls each set observer once.
   */
  set(key: string, input: ConflictLatchSetInput): ConflictLatchSetOutcome
  /**
   * `set` with the record built from a thrown value that classifies as
   * CONFLICT: its description through `conflictDescriptionOf`, its case
   * through `recogniseConflictCase` and its session through
   * `conflictSessionName`. Answers `undefined`, and does nothing, for a value
   * of any other class.
   */
  setFromConflict(key: string, value: unknown, fields: ConflictLatchConflictFields): ConflictLatchSetOutcome | undefined
  /**
   * `set` with the record built from a thrown value that classifies as
   * UNUSABLE NAME ({@link unusableNameSetInput}): the case "unusable recorded
   * name", the refused operation "none", `rowState`, the classification's
   * message as the description and the session quoted in it. Answers
   * `undefined`, and does nothing, for a value of any other class.
   */
  setFromUnusableName(key: string, value: unknown, rowState: LatchRowState): ConflictLatchSetOutcome | undefined
  /**
   * `set` with the record of a `pending` row with no launch start
   * ({@link launchStartNotRecordedSetInput}): the case "launch start not
   * recorded", the refused operation "none", `rowState`, the session
   * `slack_bot_<key>` and no description.
   */
  setLaunchStartNotRecorded(key: string, rowState: LatchRowState): ConflictLatchSetOutcome
  /** Whether `key` is latched. */
  isLatched(key: string): boolean
  /** `key`'s record, or `undefined` when it is not latched. */
  record(key: string): ConflictLatchRecord | undefined
  /**
   * Drop `key`'s latch silently (its teardown, the re-check's silent clear):
   * no post, no set observer call, no line. Each forget observer is then told
   * the key (the re-check timer's stop), when a latch was dropped. Answers
   * whether it was latched.
   */
  forget(key: string): boolean
  /**
   * Mark `key`'s latch episode as having its probe dropped (b.jg5 SRJ-505):
   * the record is replaced by the same record with `probeDropped` set, with
   * no observer call and no line. Answers false, doing nothing, when `key`
   * is not latched. The mark lasts until a set with a new case replaces the
   * record (a new episode) or the latch is forgotten.
   */
  setProbeDropped(key: string): boolean
  /** Add a set observer; the returned function removes it. */
  addSetObserver(observer: ConflictLatchSetObserver): () => void
  /**
   * Add a forget observer, told the key after each `forget` that dropped a
   * latch; it posts nothing (the re-check timer's stop). A throw is logged
   * and swallowed. The returned function removes it.
   */
  addForgetObserver(observer: (key: string) => void): () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build one server's latches. Nothing is read, posted or logged at creation. */
export function createConflictLatch(deps: ConflictLatchDeps): ConflictLatch {
  const records = new Map<string, ConflictLatchRecord>()
  const observers = new Set<ConflictLatchSetObserver>()
  const forgetObservers = new Set<(key: string) => void>()

  function notify(event: ConflictLatchSetEvent): void {
    const failed = (thrown: unknown): void =>
      safeLog(deps.log, `[slack] conflict-latch: persona=${event.key} set observer failed: ${describeThrownValue(thrown)}`)
    for (const observer of [...observers]) {
      try {
        void Promise.resolve(observer(event)).catch(failed)
      } catch (thrown) {
        failed(thrown)
      }
    }
  }

  function set(key: string, input: ConflictLatchSetInput): ConflictLatchSetOutcome {
    const previous = records.get(key)
    if (previous !== undefined && previous.latchCase === input.latchCase) {
      notify({ key, outcome: CONFLICT_LATCH_SET_SAME_CASE, record: previous, previous })
      return CONFLICT_LATCH_SET_SAME_CASE
    }
    const record = buildRecord(key, input)
    records.set(key, record)
    if (previous === undefined) {
      safeLog(deps.log, `[slack] conflict-latch: persona=${key} latched — ${describeRecord(record)}`)
      notify({ key, outcome: CONFLICT_LATCH_SET_LATCHED, record })
      return CONFLICT_LATCH_SET_LATCHED
    }
    safeLog(
      deps.log,
      `[slack] conflict-latch: persona=${key} relatched — ${describeRecord(record, previous.latchCase)}`,
    )
    notify({ key, outcome: CONFLICT_LATCH_SET_RELATCHED, record, previous })
    return CONFLICT_LATCH_SET_RELATCHED
  }

  return {
    set,

    setFromConflict(key, value, fields) {
      if (classifyAdError(value).errorClass !== AD_ERROR_CLASS_CONFLICT) return undefined
      const description = conflictDescriptionOf(value)
      return set(key, {
        latchCase: recogniseConflictCase(description),
        refusedOperation: fields.refusedOperation,
        rowState: fields.rowState,
        sessionName: conflictSessionName(description, key),
        ...(description === undefined ? {} : { description }),
      })
    },

    setFromUnusableName(key, value, rowState) {
      const input = unusableNameSetInput(key, value, rowState)
      return input === undefined ? undefined : set(key, input)
    },

    setLaunchStartNotRecorded: (key, rowState) => set(key, launchStartNotRecordedSetInput(key, rowState)),

    isLatched: (key) => records.has(key),

    record: (key) => records.get(key),

    forget(key) {
      if (!records.delete(key)) return false
      for (const observer of [...forgetObservers]) {
        try {
          observer(key)
        } catch (thrown) {
          safeLog(deps.log, `[slack] conflict-latch: persona=${key} forget observer failed: ${describeThrownValue(thrown)}`)
        }
      }
      return true
    },

    setProbeDropped(key) {
      const record = records.get(key)
      if (record === undefined) return false
      if (record.probeDropped !== true) records.set(key, Object.freeze({ ...record, probeDropped: true as const }))
      return true
    },

    addSetObserver(observer) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },

    addForgetObserver(observer) {
      forgetObservers.add(observer)
      return () => {
        forgetObservers.delete(observer)
      }
    },
  }
}

/**
 * The frozen record for `input`: the session name and the description
 * rendered by `renderLogMessageText` (redacted, on one line, capped), the
 * session `slack_bot_<key>` when that is empty, and the row state as one of
 * this module's frozen values ({@link normaliseRowState}).
 */
function buildRecord(key: string, input: ConflictLatchSetInput): ConflictLatchRecord {
  const sessionName = renderLogMessageText(input.sessionName)
  const description = renderLogMessageText(input.description)
  return Object.freeze({
    sessionName: sessionName === '' ? personaTmuxSessionName(key) : sessionName,
    latchCase: input.latchCase,
    refusedOperation: input.refusedOperation,
    rowState: normaliseRowState(input.rowState),
    ...(description === '' ? {} : { description }),
  })
}

/**
 * A caller's row state as a frozen value: a read state through
 * `latchRowStateRead` (an unsafe state becomes unreadable), no row as
 * `LATCH_ROW_STATE_NO_ROW`, anything else as `LATCH_ROW_STATE_UNREADABLE`.
 */
function normaliseRowState(rowState: LatchRowState): LatchRowState {
  if (rowState.kind === LATCH_ROW_STATE_KIND_READ) return latchRowStateRead(rowState.state)
  return rowState.kind === LATCH_ROW_STATE_KIND_NO_ROW ? LATCH_ROW_STATE_NO_ROW : LATCH_ROW_STATE_UNREADABLE
}

/** `case=<case>[ (was <case>)] session="<name>" refused=<operation> state=<state>[ message="<description>"]`. */
function describeRecord(record: ConflictLatchRecord, previousCase?: LatchCase): string {
  const was = previousCase === undefined ? '' : ` (was ${previousCase})`
  const message = describeLogMessage(record.description)
  return (
    `case=${record.latchCase}${was} session=${JSON.stringify(record.sessionName)} ` +
    `refused=${record.refusedOperation} state=${describeLatchRowState(record.rowState)}` +
    (message === '' ? '' : ` ${message}`)
  )
}

/** Hand `line` to `log`; a throwing log is swallowed, so no set throws because of it. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what the latch does */
  }
}

// ---------------------------------------------------------------------------
// The unusable recorded name (b.jg5 SRJ-512)
// ---------------------------------------------------------------------------

/**
 * True when `value` classifies as UNUSABLE NAME (b.jg5 SRJ-104: an
 * `ErrInternal` whose description carries "the recorded tmux session name"),
 * decided by the classifier (`classifyAdError`, by name). For a site that
 * must branch before it knows the row state to record. Every other
 * `ErrInternal` is UNCLASSIFIED and answers false (SRJ-313). Pure; never
 * throws.
 */
export function isUnusableNameError(value: unknown): boolean {
  return classifyAdError(value).errorClass === AD_ERROR_CLASS_UNUSABLE_NAME
}

/**
 * What `set` takes for persona `key` meeting the thrown `value` (b.jg5
 * SRJ-501, SRJ-512), when `value` classifies as UNUSABLE NAME: the case
 * "unusable recorded name", the refused operation "none" (its re-check reads
 * only `status`), `rowState`, the classification's message as the
 * description (already redacted, on one line and capped by the classifier)
 * and the session quoted in that message (`conflictSessionName`, else
 * `slack_bot_<key>`). `undefined` for a value of any other class, which
 * latches nothing. The latch's `setFromUnusableName` sets it; a holder of
 * only `set` (the session manager) passes it to `set`. Pure; never throws.
 */
export function unusableNameSetInput(
  key: string,
  value: unknown,
  rowState: LatchRowState,
): ConflictLatchSetInput | undefined {
  const classification = classifyAdError(value)
  if (classification.errorClass !== AD_ERROR_CLASS_UNUSABLE_NAME) return undefined
  const description = classification.message
  return {
    latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState,
    sessionName: conflictSessionName(description, key),
    ...(description === undefined ? {} : { description }),
  }
}

// ---------------------------------------------------------------------------
// A `pending` row with no launch start (b.jg5 SRJ-513)
// ---------------------------------------------------------------------------

/**
 * What `set` takes for persona `key` whose own row reads `pending` with no
 * launch start (b.jg5 SRJ-501, SRJ-513): the case "launch start not
 * recorded", the refused operation "none" (its re-check reads only
 * `status`), `rowState` (the state the read gave, `pending`), the session
 * `slack_bot_<key>` and no description, since a row read carries none. The
 * latch's `setLaunchStartNotRecorded` sets it; a holder of only `set` (the
 * session manager) passes it to `set`. Pure; never throws.
 */
export function launchStartNotRecordedSetInput(key: string, rowState: LatchRowState): ConflictLatchSetInput {
  return {
    latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState,
    sessionName: personaTmuxSessionName(key),
  }
}

// ---------------------------------------------------------------------------
// The CONFLICT notice (b.jg5 SRJ-1004)
// ---------------------------------------------------------------------------

/** The first line up to `<session>`. */
export const CONFLICT_NOTICE_FIRST_LINE_HEAD =
  ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session "

/** Between `<session>` and the case sentence, for a recognised case. */
export const CONFLICT_NOTICE_CASE_SENTENCE_LEAD = ': '

/** The first line after `<session>` (or after the case sentence). */
export const CONFLICT_NOTICE_FIRST_LINE_TAIL =
  '. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost.'

/** The description line up to agent-director's description. */
export const CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD = 'agent-director said: "'

/** The description line after agent-director's description. */
export const CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL = '"'

/** The pointer line: every case but "a different instance id", "another agent-director store" included. */
export const CONFLICT_NOTICE_POINTER_LINE =
  'What to do: a human follows the "Operator actions" section of agent-director\'s README for this session.'

/** "a different instance id": in place of the pointer line. */
export const CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE =
  'This session belongs to another agent-director row and must not be ended.'

/** "another agent-director store": before the pointer line (HO rev 15). */
export const CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE =
  'This session belongs to another agent-director store and must not be ended.'

/** The list line up to `<name>`. */
export const CONFLICT_NOTICE_LIST_LINE_HEAD =
  'To see which agent-director rows record the session name, run `agent-director list --tmux-session-name '

/** The list line after `<name>`. */
export const CONFLICT_NOTICE_LIST_LINE_TAIL =
  '` on the command line (over MCP, list ignores that filter).'

/** The human-only line (SRJ-1001). */
export const CONFLICT_NOTICE_HUMAN_ONLY_LINE =
  'This is for a human only: no bot, including any persona that sees this post, may act on it.'

/** What separates the notice's lines. */
export const CONFLICT_NOTICE_LINE_SEPARATOR = '\n'

/** A recognised case that has a case sentence: every one but "never reported in", which takes the unrecognised-text wording (SRJ-507). */
export type ConflictCaseWithSentence = Exclude<RecognisedConflictCase, typeof LATCH_CASE_NEVER_REPORTED_IN>

/**
 * SRJ-1004's case sentence for each recognised case. Unrecognised text and
 * "never reported in" have none ({@link conflictCaseSentence}). Both
 * leftover descriptions, the pre-spawn scan's and the "duplicate session"
 * one, are the one case {@link LATCH_CASE_LEFTOVER}, so both get its sentence.
 */
export const CONFLICT_CASE_SENTENCES: Readonly<Record<ConflictCaseWithSentence, string>> = Object.freeze({
  [LATCH_CASE_OWN_ID]:
    "this persona's own session still runs on its finished agent-director row past agent-director's stopping window and starting-session bound, or its worker process still runs after that session has gone; the worker may be hung or running on a row wrongly marked finished, and the conversation stays resumable",
  [LATCH_CASE_LEFTOVER]:
    "a session left over from an earlier launch of this persona holds the name or, renamed, still carries this persona's agent-director label, and ending it is a human's decision",
  [LATCH_CASE_NOT_THIS_LAUNCH]:
    "a session left over from an earlier launch of this persona is there; CSCB will not act on it, and ending it is a human's decision",
  [LATCH_CASE_NO_VALID_ID]: 'a session with no valid agent-director label holds the name; CSCB never touches it',
  [LATCH_CASE_DIFFERENT_ID]: "another agent-director row's session holds the name; CSCB never touches it",
  [LATCH_CASE_PANE_NOT_FOUND]:
    "the worker's recorded pane is not there (it is gone, it was respawned with another program, or it could not be adopted), or the one session left over from an earlier launch of this persona has no pane agent-director can find, and a human should look",
  [LATCH_CASE_CONFLICTING_LABELS]:
    'two sessions carry this launch\'s agent-director label, or an agent-director label value is set at the server, global or global-window scope; nothing automatic is safe, and a human must look',
  [LATCH_CASE_ANOTHER_STORE]:
    'a worker of another agent-director store sharing this tmux server holds the name; CSCB never touches it',
})

/** The case sentence for `latchCase`, or `undefined` for unrecognised text and "never reported in" (and for a hold case). Pure. */
export function conflictCaseSentence(latchCase: LatchCase): string | undefined {
  return Object.hasOwn(CONFLICT_CASE_SENTENCES, latchCase)
    ? CONFLICT_CASE_SENTENCES[latchCase as ConflictCaseWithSentence]
    : undefined
}

/** What the CONFLICT notice is built from: a CONFLICT latch's record. */
export interface ConflictNoticeSource {
  /** The quoted session's name, without quotes (the record's, already redacted). */
  readonly sessionName: string
  /** A CONFLICT case or unrecognised text; never a hold case. */
  readonly latchCase: ConflictLatchCase
  /** agent-director's description as the record holds it; absent, the description line is left out. */
  readonly description?: string
}

/**
 * `<session>` in a Slack text: the session's name, rendered as the record
 * stores it (`renderLogMessageText`: redacted, on one line, capped; a no-op
 * on a record's name), escaped for Slack, between double quotes.
 */
function slackQuotedSession(sessionName: string): string {
  return `"${slackName(sessionName)}"`
}

/** `<name>`: the session's name without quotes, rendered as {@link slackQuotedSession} renders it. */
function slackName(sessionName: string): string {
  return escapeSlackControlCharacters(renderLogMessageText(sessionName))
}

/**
 * The CONFLICT notice's body for a CONFLICT latch's record (b.jg5 SRJ-1004);
 * the persona notifier adds the persona prefix. Its lines, joined by
 * {@link CONFLICT_NOTICE_LINE_SEPARATOR}:
 *
 *   1. the first line, with the case sentence for a recognised case and
 *      none for unrecognised text or "never reported in";
 *   2. `agent-director said: "<description>"`, the description redacted and
 *      capped (`renderLogMessageText`, the record's form, so a no-op on a
 *      record's description) and then escaped once for Slack
 *      (`escapeSlackControlCharacters`); left out when there is none (the
 *      `provenance_conflict` note latch's form, SRJ-1004 hatch A2);
 *   3. the pointer line, or for "a different instance id" its
 *      must-not-be-ended line in place of it, or for "another agent-director
 *      store" its must-not-be-ended line and then the pointer line;
 *   4. the list line, naming the session without its quotes;
 *   5. the human-only line.
 *
 * The session name is text CSCB did not write, so it is escaped for Slack
 * too, in the first line and the list line. No line of CSCB's own names a
 * session-ending command, a label option or anything SRJ-1001 forbids. Pure.
 */
export function conflictNoticeText(source: ConflictNoticeSource): string {
  const session = slackQuotedSession(source.sessionName)
  const sentence = conflictCaseSentence(source.latchCase)
  const lines = [
    CONFLICT_NOTICE_FIRST_LINE_HEAD +
      session +
      (sentence === undefined ? '' : CONFLICT_NOTICE_CASE_SENTENCE_LEAD + sentence) +
      CONFLICT_NOTICE_FIRST_LINE_TAIL,
  ]
  const description = renderLogMessageText(source.description)
  if (description !== '') {
    lines.push(
      CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD +
        escapeSlackControlCharacters(description) +
        CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL,
    )
  }
  if (source.latchCase === LATCH_CASE_DIFFERENT_ID) {
    lines.push(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE)
  } else {
    if (source.latchCase === LATCH_CASE_ANOTHER_STORE) lines.push(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE)
    lines.push(CONFLICT_NOTICE_POINTER_LINE)
  }
  lines.push(CONFLICT_NOTICE_LIST_LINE_HEAD + slackName(source.sessionName) + CONFLICT_NOTICE_LIST_LINE_TAIL)
  lines.push(CONFLICT_NOTICE_HUMAN_ONLY_LINE)
  return lines.join(CONFLICT_NOTICE_LINE_SEPARATOR)
}

// ---------------------------------------------------------------------------
// The unusable-recorded-name notice (b.jg5 SRJ-1019)
// ---------------------------------------------------------------------------

/** The notice up to `<instance id>`. */
export const UNUSABLE_NAME_NOTICE_HEAD =
  ":no_entry: *Held: unusable tmux session name* — agent-director will not act on this persona's row "

/** Between `<instance id>` and the quoted description. */
export const UNUSABLE_NAME_NOTICE_REASON =
  ', because its recorded tmux session name cannot be used. '

/** After the quoted description (whose closing quote is `CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL`). */
export const UNUSABLE_NAME_NOTICE_DESCRIPTION_END = '.'

/** The pointer sentence: to the "Operator actions" section, for this row. */
export const UNUSABLE_NAME_NOTICE_POINTER =
  'What to do: a human follows the "Operator actions" section of agent-director\'s README for this row.'

/** What CSCB does meanwhile. */
export const UNUSABLE_NAME_NOTICE_HOLD =
  'CSCB takes no action for this persona until the row is removed, and messages sent to it meanwhile are lost.'

/** What separates the notice's sentences: it is one line. */
export const UNUSABLE_NAME_NOTICE_SEPARATOR = ' '

/**
 * The unusable-recorded-name notice's body for persona `key` (b.jg5
 * SRJ-1019); the persona notifier adds the persona prefix. One line:
 * {@link UNUSABLE_NAME_NOTICE_HEAD}, the instance id `cscb_<key>`,
 * {@link UNUSABLE_NAME_NOTICE_REASON}, `agent-director said: "<description>".`
 * (the latch record's description, rendered by `renderLogMessageText`, a
 * no-op on a record's, then escaped once for Slack), the pointer, the hold
 * sentence and the human-only sentence (`CONFLICT_NOTICE_HUMAN_ONLY_LINE`),
 * joined by single spaces. Names no command. Pure.
 */
export function unusableNameNoticeText(key: string, description: string | undefined): string {
  return [
    UNUSABLE_NAME_NOTICE_HEAD +
      personaInstanceId(key) +
      UNUSABLE_NAME_NOTICE_REASON +
      CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD +
      escapeSlackControlCharacters(renderLogMessageText(description)) +
      CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL +
      UNUSABLE_NAME_NOTICE_DESCRIPTION_END,
    UNUSABLE_NAME_NOTICE_POINTER,
    UNUSABLE_NAME_NOTICE_HOLD,
    CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  ].join(UNUSABLE_NAME_NOTICE_SEPARATOR)
}

// ---------------------------------------------------------------------------
// The launch-start-not-recorded notice (b.jg5 SRJ-1020)
// ---------------------------------------------------------------------------

/** The notice up to `<session>`. */
export const LAUNCH_START_NOTICE_HEAD =
  ":no_entry: *Held: launch start not recorded* — this persona's agent-director row reads pending but records no launch start, so it was written by an agent-director process older than the install, and agent-director will not act on its session "

/** After `<session>`. */
export const LAUNCH_START_NOTICE_SESSION_END = '.'

/** The pointer sentence: to the "Operator actions" section. */
export const LAUNCH_START_NOTICE_POINTER =
  'A human should look: follow the "Operator actions" section of agent-director\'s README.'

/** What CSCB does meanwhile. */
export const LAUNCH_START_NOTICE_HOLD =
  'CSCB takes no action for this persona until the row reads ended or missing, or is removed, and messages sent to it meanwhile are lost.'

/** What separates the notice's sentences: it is one line. */
export const LAUNCH_START_NOTICE_SEPARATOR = ' '

/**
 * The launch-start-not-recorded notice's body for persona `key` (b.jg5
 * SRJ-1020); the persona notifier adds the persona prefix. One line:
 * {@link LAUNCH_START_NOTICE_HEAD}, the persona's session `"slack_bot_<key>"`
 * (the session such a latch records, rendered as the CONFLICT notice renders
 * a record's quoted session: redacted, escaped for Slack, between double
 * quotes), {@link LAUNCH_START_NOTICE_SESSION_END}, the pointer, the hold
 * sentence and the human-only sentence (`CONFLICT_NOTICE_HUMAN_ONLY_LINE`),
 * joined by single spaces. Names no command. Pure.
 */
export function launchStartNotRecordedNoticeText(key: string): string {
  return [
    LAUNCH_START_NOTICE_HEAD + slackQuotedSession(personaTmuxSessionName(key)) + LAUNCH_START_NOTICE_SESSION_END,
    LAUNCH_START_NOTICE_POINTER,
    LAUNCH_START_NOTICE_HOLD,
    CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  ].join(LAUNCH_START_NOTICE_SEPARATOR)
}

// ---------------------------------------------------------------------------
// The recovery notice (b.jg5 SRJ-1005)
//
// Built here; nothing in this module posts it. The re-check's clear
// hand-off is where a re-check's clear is handed (every reason but "cleared
// by hand"; the silent clear posts nothing yet), and a `clear-latch` posts
// it with "cleared by hand". The re-check posts nothing before a clear: a
// "not this launch's session" latch posts none when its finished-row retry
// is made or relatches P, only when that retry clears it
// (`LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED`); a latch whose refused
// operation is a spawn posts none when step 1 finds no row and the spawn is
// retried or that retry is refused, only when the retry clears it
// (`LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED`).
// ---------------------------------------------------------------------------

/** A CONFLICT latch: a CONFLICT case or unrecognised text ("Conflict cleared"). */
export const LATCH_KIND_CONFLICT = 'conflict'
/** A hold latch: "unusable recorded name" or "launch start not recorded" ("Hold cleared"). */
export const LATCH_KIND_HOLD = 'hold'

/** Which recovery heading a latch takes. */
export type LatchKind = typeof LATCH_KIND_CONFLICT | typeof LATCH_KIND_HOLD

/** The latch kind of `latchCase`. Pure. */
export function latchKindOf(latchCase: LatchCase): LatchKind {
  return isHoldLatchCase(latchCase) ? LATCH_KIND_HOLD : LATCH_KIND_CONFLICT
}

/** Reason `its agent-director row reads <state>`. */
export const LATCH_RECOVERY_REASON_KIND_ROW_READS = 'row-reads'
/** Reason `its agent-director row is gone`. */
export const LATCH_RECOVERY_REASON_KIND_ROW_GONE = 'row-gone'
/** Reason `a retry of the refused operation was not refused`. */
export const LATCH_RECOVERY_REASON_KIND_RETRY_NOT_REFUSED = 'retry-not-refused'
/** Reason `its row finished and a relaunch was not refused`. */
export const LATCH_RECOVERY_REASON_KIND_RELAUNCH_NOT_REFUSED = 'relaunch-not-refused'
/** Reason `cleared by hand` (E31's `clear-latch`). */
export const LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND = 'cleared-by-hand'

/** Why a latch cleared: one of SRJ-1005's five reasons, the state-bearing one with its state. */
export type LatchRecoveryReason =
  | { readonly kind: typeof LATCH_RECOVERY_REASON_KIND_ROW_READS; readonly state: string }
  | { readonly kind: typeof LATCH_RECOVERY_REASON_KIND_ROW_GONE }
  | { readonly kind: typeof LATCH_RECOVERY_REASON_KIND_RETRY_NOT_REFUSED }
  | { readonly kind: typeof LATCH_RECOVERY_REASON_KIND_RELAUNCH_NOT_REFUSED }
  | { readonly kind: typeof LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND }

/** `its agent-director row reads <state>`, as a value. */
export function latchRecoveryReasonRowReads(state: string): LatchRecoveryReason {
  return Object.freeze({ kind: LATCH_RECOVERY_REASON_KIND_ROW_READS, state })
}
/** `its agent-director row is gone`, as a value. */
export const LATCH_RECOVERY_REASON_ROW_GONE: LatchRecoveryReason = Object.freeze({ kind: LATCH_RECOVERY_REASON_KIND_ROW_GONE })
/** `a retry of the refused operation was not refused`, as a value. */
export const LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED: LatchRecoveryReason = Object.freeze({
  kind: LATCH_RECOVERY_REASON_KIND_RETRY_NOT_REFUSED,
})
/** `its row finished and a relaunch was not refused`, as a value. */
export const LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED: LatchRecoveryReason = Object.freeze({
  kind: LATCH_RECOVERY_REASON_KIND_RELAUNCH_NOT_REFUSED,
})
/** `cleared by hand`, as a value. */
export const LATCH_RECOVERY_REASON_CLEARED_BY_HAND: LatchRecoveryReason = Object.freeze({
  kind: LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND,
})

/** The state-bearing reason's text up to `<state>`. */
export const LATCH_RECOVERY_REASON_ROW_READS_HEAD = 'its agent-director row reads '

/** The fixed text of each reason without a state. */
export const LATCH_RECOVERY_REASON_TEXTS: Readonly<
  Record<Exclude<LatchRecoveryReason['kind'], typeof LATCH_RECOVERY_REASON_KIND_ROW_READS>, string>
> = Object.freeze({
  [LATCH_RECOVERY_REASON_KIND_ROW_GONE]: 'its agent-director row is gone',
  [LATCH_RECOVERY_REASON_KIND_RETRY_NOT_REFUSED]: 'a retry of the refused operation was not refused',
  [LATCH_RECOVERY_REASON_KIND_RELAUNCH_NOT_REFUSED]: 'its row finished and a relaunch was not refused',
  [LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND]: 'cleared by hand',
})

/**
 * `<reason>` for a Slack text. The state is agent-director's text, so it is
 * rendered as a quoted description is (redacted, on one line, capped) and
 * escaped for Slack; a state agent-director reports (`ended`, `missing`, …)
 * is unchanged by both. Pure.
 */
export function latchRecoveryReasonText(reason: LatchRecoveryReason): string {
  return reason.kind === LATCH_RECOVERY_REASON_KIND_ROW_READS
    ? LATCH_RECOVERY_REASON_ROW_READS_HEAD + escapeSlackControlCharacters(renderLogMessageText(reason.state))
    : LATCH_RECOVERY_REASON_TEXTS[reason.kind]
}

/** The CONFLICT recovery notice up to `<session>`. */
export const CONFLICT_RECOVERY_HEAD = ":white_check_mark: *Conflict cleared* — the hold on this persona's tmux session "
/** The CONFLICT recovery notice between `<session>` and `<reason>`. */
export const CONFLICT_RECOVERY_REASON_LEAD = ' is cleared ('
/** The hold recovery notice up to `<reason>`. */
export const HOLD_RECOVERY_HEAD =
  ":white_check_mark: *Hold cleared* — the hold on this persona's agent-director row is cleared ("
/** Both recovery notices after `<reason>`. */
export const LATCH_RECOVERY_TAIL = '). CSCB is recovering this persona again.'

/**
 * The recovery notice's body for a CONFLICT latch on the quoted session
 * `sessionName` (the record's, without quotes) cleared for `reason`
 * (b.jg5 SRJ-1005); the persona notifier adds the persona prefix. Pure.
 */
export function conflictRecoveryText(sessionName: string, reason: LatchRecoveryReason): string {
  return (
    CONFLICT_RECOVERY_HEAD +
    slackQuotedSession(sessionName) +
    CONFLICT_RECOVERY_REASON_LEAD +
    latchRecoveryReasonText(reason) +
    LATCH_RECOVERY_TAIL
  )
}

/** The recovery notice's body for an "unusable recorded name" or "launch start not recorded" latch cleared for `reason` (b.jg5 SRJ-1005). Pure. */
export function holdRecoveryText(reason: LatchRecoveryReason): string {
  return HOLD_RECOVERY_HEAD + latchRecoveryReasonText(reason) + LATCH_RECOVERY_TAIL
}

/**
 * The recovery notice's body for a latch of `kind` cleared for `reason`:
 * {@link conflictRecoveryText} on `sessionName` for a CONFLICT latch,
 * {@link holdRecoveryText} for a hold (which names no session). Pure.
 */
export function latchRecoveryText(kind: LatchKind, reason: LatchRecoveryReason, sessionName: string): string {
  return kind === LATCH_KIND_HOLD ? holdRecoveryText(reason) : conflictRecoveryText(sessionName, reason)
}

// ---------------------------------------------------------------------------
// The latch notices' episodes (b.jg5 SRJ-508, SRJ-1016)
// ---------------------------------------------------------------------------

/**
 * What the notice reaction uses of the server's notice episodes: `begin` and
 * `post`, and `end` for the silent cross-kind end.
 */
export type ConflictNoticeEpisodes = Pick<PersonaEpisodes, 'begin' | 'post' | 'end'>

/** One hold case's notice: its episode kind and its text builder. */
export interface HoldNotice {
  readonly episodeKind: PersonaEpisodeKind
  /** The notice's body for persona `key`'s latch record; the persona notifier adds the prefix. Pure. */
  readonly text: (key: string, record: ConflictLatchRecord) => string
}

/**
 * Each hold case's notice (b.jg5 SRJ-508, SRJ-1016): its own episode kind
 * and its text. "unusable recorded name" posts SRJ-1019
 * ({@link unusableNameNoticeText}); "launch start not recorded" posts
 * SRJ-1020 ({@link launchStartNotRecordedNoticeText}).
 */
export const HOLD_NOTICES: Readonly<Record<HoldLatchCase, HoldNotice>> = Object.freeze({
  [LATCH_CASE_UNUSABLE_RECORDED_NAME]: Object.freeze({
    episodeKind: PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
    text: (key: string, record: ConflictLatchRecord) => unusableNameNoticeText(key, record.description),
  }),
  [LATCH_CASE_LAUNCH_START_NOT_RECORDED]: Object.freeze({
    episodeKind: PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED,
    text: (key: string) => launchStartNotRecordedNoticeText(key),
  }),
})

/**
 * The notice episode kind of each latch kind, one per kind: CONFLICT (every
 * CONFLICT case and unrecognised text), then each hold case's.
 */
export const LATCH_NOTICE_EPISODE_KINDS: readonly PersonaEpisodeKind[] = Object.freeze([
  PERSONA_EPISODE_KIND_CONFLICT,
  ...HOLD_LATCH_CASES.map((latchCase) => HOLD_NOTICES[latchCase].episodeKind),
])

/** The notice episode kind of `latchCase`: its hold notice's, else CONFLICT's. Pure. */
export function latchNoticeEpisodeKindOf(latchCase: LatchCase): PersonaEpisodeKind {
  return isHoldLatchCase(latchCase) ? HOLD_NOTICES[latchCase].episodeKind : PERSONA_EPISODE_KIND_CONFLICT
}

/**
 * The latch notices' set observer over `episodes` (b.jg5 SRJ-508,
 * SRJ-1016), dispatching by the record's latch kind:
 *
 *   - a latch (`latched`) or a relatch with a new case (`relatched`) first
 *     ends P's open episodes of the other latch kinds silently (`end`: no
 *     recovery post), so a later relatch back to one of them posts once more
 *     (SRJ-512, SRJ-513); then
 *       - for a CONFLICT case or unrecognised text, it begins P's CONFLICT
 *         episode with the record's case, or keeps the open one when its
 *         case is the same, and posts {@link conflictNoticeText} in it at
 *         most once: a new case's episode is new, so it posts once more;
 *       - for a hold case, it begins (or keeps) P's episode of that case's
 *         kind ({@link HOLD_NOTICES}) and posts that case's text in it at
 *         most once (SRJ-1019 or SRJ-1020). SRJ-1004 is never posted for a
 *         hold case;
 *   - a same-case set (`same-case`) keeps the episode and posts nothing.
 *
 * Every post goes through the episodes' sink (the persona notifier), never
 * straight to Slack, and reads no other notice's latch, b.f2b's
 * `unproven-idle` and `blocked-on-prompt` included, so none holds it back.
 * After the episodes' `close` (shutdown) it opens and posts nothing. A
 * teardown's `forget` ends them; the re-check's silent clear ends none.
 */
export function createConflictNoticeObserver(episodes: ConflictNoticeEpisodes): ConflictLatchSetObserver {
  return ({ key, outcome, record }) => {
    if (outcome === CONFLICT_LATCH_SET_SAME_CASE) return
    const latchCase = record.latchCase
    const kind = latchNoticeEpisodeKindOf(latchCase)
    for (const other of LATCH_NOTICE_EPISODE_KINDS) {
      if (other !== kind) episodes.end(key, other)
    }
    if (episodes.begin(key, kind, latchCase) === 'closed') return
    if (isHoldLatchCase(latchCase)) {
      episodes.post(key, kind, HOLD_NOTICES[latchCase].text(key, record))
      return
    }
    episodes.post(key, kind, conflictNoticeText({ sessionName: record.sessionName, latchCase, description: record.description }))
  }
}

/**
 * Bind the latch notices to `latch`: adds {@link createConflictNoticeObserver}
 * over `episodes` as a set observer. Answers the observer's removal. `main()`
 * binds the server's one latch to its one set of notice episodes.
 */
export function bindConflictNotice(latch: Pick<ConflictLatch, 'addSetObserver'>, episodes: ConflictNoticeEpisodes): () => void {
  return latch.addSetObserver(createConflictNoticeObserver(episodes))
}

// ---------------------------------------------------------------------------
// The holds (b.jg5 SRJ-305, SRJ-310, SRJ-313, SRJ-502)
// ---------------------------------------------------------------------------

/**
 * What a latch holds back at once for the persona, each given its key.
 * `main()` binds them to the server's retry controller, its
 * `tmux-unresponsive` condition, its unclassified-error episodes, its
 * slow-recovery tracker and its notice episodes' stuck-launch kind.
 */
export interface ConflictLatchHolds {
  /** Stop the persona's retry timer with the latch's stop reason, through the controller's `stop` (SRJ-305: "P latches, whatever the case"). */
  stopRetryTimer(key: string): void
  /** End the persona's `tmux-unresponsive` condition silently: no recovery notice (SRJ-310). */
  endTmuxUnresponsive(key: string): void
  /** End the persona's unclassified-error episode with the latch's end reason (SRJ-313). */
  endUnclassifiedError(key: string): void
  /**
   * Reset the persona's slow-recovery count and end its slow-recovery
   * episode silently (SRJ-610, SRJ-1016; `main()` binds the tracker's
   * `endForLatch`). Absent: no slow-recovery state is kept for the latch to
   * end.
   */
  endSlowRecovery?(key: string): void
  /**
   * End the persona's stuck-launch episode silently (SRJ-1016; `main()`
   * binds `endStuckLaunchEpisodeForLatch`, `src/pending-row.ts`, over its
   * notice episodes). Absent: no stuck-launch episode is kept for the latch
   * to end.
   */
  endStuckLaunch?(key: string): void
}

/**
 * The holds' set observer (b.jg5 SRJ-502): on every set, a latch, a relatch
 * and a same-case set alike and whatever the case, it stops the persona's
 * retry timer, then ends its `tmux-unresponsive` condition silently, then
 * ends its unclassified-error episode, then resets its slow-recovery count
 * and ends that episode silently (SRJ-610, SRJ-1016), then ends its
 * stuck-launch episode silently (SRJ-1016), in that order. A same-case set runs
 * them too: a refusal met while P was already latched (the latch-time
 * `status` read's error included) may have armed the timer again. Each hold
 * is isolated: one that throws is logged to `log` and the next still runs.
 * Bound before the latch's notice ({@link bindConflictLatchHolds}), so every
 * hold is done by the time the notice is posted.
 */
export function createConflictLatchHoldObserver(
  holds: ConflictLatchHolds,
  log: (line: string) => void,
): ConflictLatchSetObserver {
  const steps: ReadonlyArray<readonly [string, (key: string) => void]> = [
    ['retry timer stop', (key) => holds.stopRetryTimer(key)],
    ['tmux-unresponsive end', (key) => holds.endTmuxUnresponsive(key)],
    ['unclassified-error end', (key) => holds.endUnclassifiedError(key)],
    ['slow-recovery end', (key) => holds.endSlowRecovery?.(key)],
    ['stuck-launch end', (key) => holds.endStuckLaunch?.(key)],
  ]
  return ({ key }) => {
    for (const [name, step] of steps) {
      try {
        step(key)
      } catch (thrown) {
        safeLog(log, `[slack] conflict-latch: persona=${key} hold failed (${name}): ${describeThrownValue(thrown)}`)
      }
    }
  }
}

/**
 * Bind the holds to `latch` as a set observer
 * ({@link createConflictLatchHoldObserver}). Answers the observer's removal.
 * Observers run in the order they were added, so `main()` binds the holds
 * before the latch's notice ({@link bindConflictNotice}): the timer is
 * stopped and the episodes are ended before the notice is posted.
 */
export function bindConflictLatchHolds(
  latch: Pick<ConflictLatch, 'addSetObserver'>,
  holds: ConflictLatchHolds,
  log: (line: string) => void,
): () => void {
  return latch.addSetObserver(createConflictLatchHoldObserver(holds, log))
}

// ---------------------------------------------------------------------------
// The re-check (b.jg5 SRJ-505): its interval, step 1's reading, the decision
// ---------------------------------------------------------------------------

/**
 * The re-check's interval (b.jg5 SRJ-505): at most one re-check per latched
 * persona per 120 s, on its own timer, whatever `health_check_interval` is
 * (0 included). The first comes one interval after the persona latches,
 * each next one interval after the previous one has settled.
 */
export const LATCH_RECHECK_INTERVAL_MS = 120_000

/** Step 1 read the row in a state (with `get`, whether the `provenance_conflict` note is on it). */
export const RECHECK_READING_STATE = 'state'
/** Step 1's read answered `ErrSpawnNotFound`: no row. */
export const RECHECK_READING_NO_ROW = 'no-row'
/** Step 1's read failed: no information. */
export const RECHECK_READING_FAILED = 'failed'

/**
 * What step 1's read of the row gave (b.jg5 SRJ-505): a state, with
 * `notePresent` true when its `get` showed the latching `provenance_conflict`
 * note (a "conflicting labels" latch's read; a `status` shows no note); no
 * row; or a failed read.
 */
export type LatchRecheckReading =
  | { readonly kind: typeof RECHECK_READING_STATE; readonly state: string; readonly notePresent?: boolean }
  | { readonly kind: typeof RECHECK_READING_NO_ROW }
  | { readonly kind: typeof RECHECK_READING_FAILED }

/** No row, as a reading. */
export const RECHECK_READING_NO_ROW_VALUE: LatchRecheckReading = Object.freeze({ kind: RECHECK_READING_NO_ROW })
/** A failed read, as a reading. */
export const RECHECK_READING_FAILED_VALUE: LatchRecheckReading = Object.freeze({ kind: RECHECK_READING_FAILED })

/** Step 1: the row has reported in since the latch was set, so the latch clears. */
export const RECHECK_STEP_CLEAR_REPORTED_IN = 'clear-reported-in'
/** Step 1: `ErrSpawnNotFound` clears the latch (the row is gone). */
export const RECHECK_STEP_CLEAR_GONE = 'clear-gone'
/** Step 1: no row, for a latch whose refused operation is a spawn: that spawn is retried, P still latched. */
export const RECHECK_STEP_SPAWN_RETRY = 'spawn-retry'
/** Step 1: no row, for "not this launch's session": the finished-row retry, P still latched. */
export const RECHECK_STEP_FINISHED_ROW_RETRY = 'finished-row-retry'
/** Step 1 decided nothing: step 2's table decides. */
export const RECHECK_STEP_TABLE = 'step-2'
/** Step 1's read failed: no information; the round ends with no other call. */
export const RECHECK_STEP_NO_INFORMATION = 'no-information'

/** One of step 1's outcomes. */
export type LatchRecheckStep =
  | typeof RECHECK_STEP_CLEAR_REPORTED_IN
  | typeof RECHECK_STEP_CLEAR_GONE
  | typeof RECHECK_STEP_SPAWN_RETRY
  | typeof RECHECK_STEP_FINISHED_ROW_RETRY
  | typeof RECHECK_STEP_TABLE
  | typeof RECHECK_STEP_NO_INFORMATION

/** Table action: `status` only (the read is the whole re-check). */
export const RECHECK_ACTION_STATUS_ONLY = 'status-only'
/** Table action: the one-line `read-pane` probe. */
export const RECHECK_ACTION_PROBE = 'probe'
/** Table action: the latched operation retried at the cadence. */
export const RECHECK_ACTION_RETRY = 'retry'
/** Table action: a plain spawn's retry, keyed on the row step 1 read. */
export const RECHECK_ACTION_PLAIN_SPAWN_RETRY = 'plain-spawn-retry'
/** Table action: "conflicting labels" by the row's state. */
export const RECHECK_ACTION_CONFLICTING_LABELS = 'conflicting-labels'
/** Table action: the restart path's decision (a bring-up latch's latched operation). */
export const RECHECK_ACTION_RESTART_DECISION = 'restart-decision'
/** Table action: none. */
export const RECHECK_ACTION_NONE = 'none'

/** One of the table's actions. */
export type LatchRecheckAction =
  | typeof RECHECK_ACTION_STATUS_ONLY
  | typeof RECHECK_ACTION_PROBE
  | typeof RECHECK_ACTION_RETRY
  | typeof RECHECK_ACTION_PLAIN_SPAWN_RETRY
  | typeof RECHECK_ACTION_CONFLICTING_LABELS
  | typeof RECHECK_ACTION_RESTART_DECISION
  | typeof RECHECK_ACTION_NONE

/** The call: none. */
export const RECHECK_CALL_NONE = 'none'
/** The call: one `read-pane` with `n_lines` 1 (the probe). */
export const RECHECK_CALL_PROBE = 'read-pane'
/** The call: the lap's `read-pane` with `n_lines` 1 and `allow_pending`, typing nothing ("conflicting labels" on a `pending` row). */
export const RECHECK_CALL_PENDING_READ_PANE = 'read-pane-pending'
/** The call: a plain spawn. */
export const RECHECK_CALL_PLAIN_SPAWN = 'plain-spawn'
/** The call: a spawn with `reuse_finished` (an ordinary fresh spawn when no row exists). */
export const RECHECK_CALL_REUSE_SPAWN = 'reuse-spawn'
/** The call: a `resume`. */
export const RECHECK_CALL_RESUME = 'resume'
/** The call: one run of the restart path's decision. */
export const RECHECK_CALL_RESTART_DECISION = 'restart-decision'
/** The call: the finished-row retry: one `get`, then the launch it decides (`decideFinishedRowLaunch`). */
export const RECHECK_CALL_FINISHED_ROW = 'finished-row-retry'

/** The one call a re-check makes after step 1's read, or none. */
export type LatchRecheckCall =
  | typeof RECHECK_CALL_NONE
  | typeof RECHECK_CALL_PROBE
  | typeof RECHECK_CALL_PENDING_READ_PANE
  | typeof RECHECK_CALL_PLAIN_SPAWN
  | typeof RECHECK_CALL_REUSE_SPAWN
  | typeof RECHECK_CALL_RESUME
  | typeof RECHECK_CALL_RESTART_DECISION
  | typeof RECHECK_CALL_FINISHED_ROW

/** What the decision is given. */
export interface LatchRecheckDecisionInput {
  /** The latch record now held: its case, refused operation, recorded state and probe-dropped mark. */
  readonly record: Pick<ConflictLatchRecord, 'latchCase' | 'refusedOperation' | 'rowState' | 'probeDropped'>
  /** What step 1's read gave. */
  readonly reading: LatchRecheckReading
  /**
   * Whether the persona's key is recorded in `retired-keys.json` now (the
   * caller reads `retiredKeyReadingOf`). While it is, a retry that would be a
   * `resume` or a plain spawn is the reuse (b.jg5 SRJ-805).
   */
  readonly retiredKeyRecorded: boolean
}

/** What one re-check does after step 1's read. */
export interface LatchRecheckDecision {
  readonly step: LatchRecheckStep
  readonly action: LatchRecheckAction
  readonly call: LatchRecheckCall
  /**
   * Present when step 1's reading clears the latch (gone, reported in, or a
   * "launch start not recorded" row read `ended` or `missing`): the
   * recovery notice's reason (SRJ-1005).
   */
  readonly clear?: { readonly reason: LatchRecoveryReason }
  /** True for a latch whose refused operation and case match no table row: step 1 only, with one line naming the pair. */
  readonly unmatched?: true
}

/** The states a row has reported in by (SRJ-505 step 1's second bullet): the live states other than `pending`. */
const REPORTED_IN_STATES: ReadonlySet<string> = new Set(
  [...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE),
)

/** The cases of the table's no-probe row for a `resume`, a reuse or a bring-up (HO rev 15). */
const NO_PROBE_RETRY_CASES: ReadonlySet<LatchCase> = new Set<LatchCase>([
  LATCH_CASE_NO_VALID_ID,
  LATCH_CASE_DIFFERENT_ID,
  LATCH_CASE_ANOTHER_STORE,
  LATCH_CASE_LEFTOVER,
])

/** A decision with no call. */
function decided(step: LatchRecheckStep, action: LatchRecheckAction, call: LatchRecheckCall = RECHECK_CALL_NONE): LatchRecheckDecision {
  return Object.freeze({ step, action, call })
}

/** `call` as made for a key recorded in `retired-keys.json`: a `resume` or a plain spawn is the reuse (b.jg5 SRJ-805). */
function retiredAware(call: LatchRecheckCall, retiredKeyRecorded: boolean): LatchRecheckCall {
  return retiredKeyRecorded && (call === RECHECK_CALL_RESUME || call === RECHECK_CALL_PLAIN_SPAWN) ? RECHECK_CALL_REUSE_SPAWN : call
}

/**
 * The re-check's decision for one latched persona (b.jg5 SRJ-505), from its
 * latch record, step 1's reading and whether its key is retired. Pure; makes
 * no call.
 *
 * Step 1:
 *   - a failed read gives no information: no call;
 *   - no row (`ErrSpawnNotFound`): for "not this launch's session" the
 *     finished-row retry; for a latch whose refused operation is a spawn,
 *     plain or reuse, that spawn retried, whatever the case, with no probe
 *     (HO rev 15); otherwise the latch clears ("its agent-director row is
 *     gone"), a `resume` latch included (HO rev 28);
 *   - a row reading `waiting`, `working`, `ask_user` or `check_permission`
 *     clears the latch only when the recorded state did not count as live
 *     (`rowStateCountsAsLive`: it read `pending`, `ended`, `missing` or no
 *     row), never for "not this launch's session", and never while the
 *     `provenance_conflict` note is on a "conflicting labels" latch's row.
 *
 * Step 2, the first table row that matches:
 *   1. a `resume` or reuse on "this row's own id" whose probe was dropped:
 *      the latched operation retried;
 *   2. a `resume` or reuse on "this row's own id": the one-line probe;
 *   3. any operation on "the agent's pane was not found": the probe;
 *   4. a `resume`, a reuse or a bring-up on "no valid instance id", "a
 *      different instance id", "another agent-director store" or "left over
 *      from an earlier life": the latched operation retried (a bring-up's is
 *      the restart path's decision);
 *   5. a plain spawn, whatever the case: on a row read `ended` or `missing`
 *      a spawn with `reuse_finished`, never a plain spawn; on any live state,
 *      `pending` included, no retry;
 *   6. "not this launch's session", whatever the verb: `status` only; a row
 *      read `ended` or `missing` leads to the finished-row retry; the refused
 *      call is never retried;
 *   7. "conflicting labels": with the note on the row, nothing; on a
 *      `pending` row the lap's one-line `read-pane`, typing nothing; on
 *      another live row one run of the restart path's decision; on a row
 *      read `ended` or `missing` the latched `resume` or reuse, or for any
 *      other refused operation the restart path's decision;
 *   8. "unusable recorded name": `status` only;
 *   9. "launch start not recorded": `status` only; a row read `ended` or
 *      `missing` clears it;
 *   10. unrecognised text and "never reported in": none;
 *   any other pair: none, marked `unmatched`.
 * HO rev 28: in rows 1 to 4 a latched `resume` or reuse is probed or retried
 * only when step 1 read the row `ended` or `missing`; any other reading,
 * `pending` included, decides no call (and no post). That gate is its own
 * test, never `rowStateCountsAsLive`. A retry of a retired key's `resume` or
 * plain spawn is the reuse (`retiredKeyRecorded`).
 */
export function decideLatchRecheck(input: LatchRecheckDecisionInput): LatchRecheckDecision {
  const { record, reading, retiredKeyRecorded } = input
  const { latchCase, refusedOperation } = record
  if (reading.kind === RECHECK_READING_FAILED) return decided(RECHECK_STEP_NO_INFORMATION, RECHECK_ACTION_NONE)
  if (reading.kind === RECHECK_READING_NO_ROW) {
    if (latchCase === LATCH_CASE_NOT_THIS_LAUNCH) {
      return decided(RECHECK_STEP_FINISHED_ROW_RETRY, RECHECK_ACTION_STATUS_ONLY, RECHECK_CALL_FINISHED_ROW)
    }
    if (refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN) {
      return decided(RECHECK_STEP_SPAWN_RETRY, RECHECK_ACTION_PLAIN_SPAWN_RETRY, retiredAware(RECHECK_CALL_PLAIN_SPAWN, retiredKeyRecorded))
    }
    if (refusedOperation === REFUSED_OPERATION_REUSE_SPAWN) {
      return decided(RECHECK_STEP_SPAWN_RETRY, RECHECK_ACTION_RETRY, RECHECK_CALL_REUSE_SPAWN)
    }
    return Object.freeze({
      step: RECHECK_STEP_CLEAR_GONE,
      action: RECHECK_ACTION_NONE,
      call: RECHECK_CALL_NONE,
      clear: Object.freeze({ reason: LATCH_RECOVERY_REASON_ROW_GONE }),
    })
  }
  const { state } = reading
  const noted = latchCase === LATCH_CASE_CONFLICTING_LABELS && reading.notePresent === true
  if (
    REPORTED_IN_STATES.has(state) &&
    latchCase !== LATCH_CASE_NOT_THIS_LAUNCH &&
    !rowStateCountsAsLive(record.rowState) &&
    !noted
  ) {
    return Object.freeze({
      step: RECHECK_STEP_CLEAR_REPORTED_IN,
      action: RECHECK_ACTION_NONE,
      call: RECHECK_CALL_NONE,
      clear: Object.freeze({ reason: latchRecoveryReasonRowReads(state) }),
    })
  }
  return tableDecision(record, state, noted, retiredKeyRecorded)
}

/** Step 2: the first table row matching `record`, for a row step 1 read in `state`. */
function tableDecision(
  record: LatchRecheckDecisionInput['record'],
  state: string,
  noted: boolean,
  retiredKeyRecorded: boolean,
): LatchRecheckDecision {
  const { latchCase, refusedOperation } = record
  const finished = AGENT_DIRECTOR_DEAD_STATES.has(state)
  const launchOp = refusedOperation === REFUSED_OPERATION_RESUME || refusedOperation === REFUSED_OPERATION_REUSE_SPAWN
  const latchedLaunch = retiredAware(
    refusedOperation === REFUSED_OPERATION_RESUME ? RECHECK_CALL_RESUME : RECHECK_CALL_REUSE_SPAWN,
    retiredKeyRecorded,
  )
  // HO rev 28: a latched `resume` or reuse is probed or retried only on a finished row.
  const gated = (call: LatchRecheckCall): LatchRecheckCall => (launchOp && !finished ? RECHECK_CALL_NONE : call)
  const table = (action: LatchRecheckAction, call: LatchRecheckCall = RECHECK_CALL_NONE): LatchRecheckDecision =>
    decided(RECHECK_STEP_TABLE, action, call)

  if (launchOp && latchCase === LATCH_CASE_OWN_ID) {
    return record.probeDropped === true
      ? table(RECHECK_ACTION_RETRY, gated(latchedLaunch))
      : table(RECHECK_ACTION_PROBE, gated(RECHECK_CALL_PROBE))
  }
  if (latchCase === LATCH_CASE_PANE_NOT_FOUND) return table(RECHECK_ACTION_PROBE, gated(RECHECK_CALL_PROBE))
  if (NO_PROBE_RETRY_CASES.has(latchCase)) {
    if (launchOp) return table(RECHECK_ACTION_RETRY, gated(latchedLaunch))
    if (refusedOperation === REFUSED_OPERATION_BRING_UP) return table(RECHECK_ACTION_RESTART_DECISION, RECHECK_CALL_RESTART_DECISION)
  }
  if (refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN) {
    return table(RECHECK_ACTION_PLAIN_SPAWN_RETRY, finished ? RECHECK_CALL_REUSE_SPAWN : RECHECK_CALL_NONE)
  }
  if (latchCase === LATCH_CASE_NOT_THIS_LAUNCH) {
    return finished
      ? decided(RECHECK_STEP_FINISHED_ROW_RETRY, RECHECK_ACTION_STATUS_ONLY, RECHECK_CALL_FINISHED_ROW)
      : table(RECHECK_ACTION_STATUS_ONLY)
  }
  if (latchCase === LATCH_CASE_CONFLICTING_LABELS) {
    if (noted) return table(RECHECK_ACTION_CONFLICTING_LABELS)
    if (state === AGENT_DIRECTOR_PENDING_STATE) return table(RECHECK_ACTION_CONFLICTING_LABELS, RECHECK_CALL_PENDING_READ_PANE)
    if (!finished) return table(RECHECK_ACTION_CONFLICTING_LABELS, RECHECK_CALL_RESTART_DECISION)
    return table(RECHECK_ACTION_CONFLICTING_LABELS, launchOp ? latchedLaunch : RECHECK_CALL_RESTART_DECISION)
  }
  if (latchCase === LATCH_CASE_UNUSABLE_RECORDED_NAME) return table(RECHECK_ACTION_STATUS_ONLY)
  if (latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED) {
    if (!finished) return table(RECHECK_ACTION_STATUS_ONLY)
    return Object.freeze({
      step: RECHECK_STEP_TABLE,
      action: RECHECK_ACTION_STATUS_ONLY,
      call: RECHECK_CALL_NONE,
      clear: Object.freeze({ reason: latchRecoveryReasonRowReads(state) }),
    })
  }
  if (takesUnrecognisedHandling(latchCase)) return table(RECHECK_ACTION_NONE)
  return Object.freeze({ step: RECHECK_STEP_TABLE, action: RECHECK_ACTION_NONE, call: RECHECK_CALL_NONE, unmatched: true as const })
}

/**
 * The launch of a "not this launch's session" latch's finished-row retry
 * (b.jg5 SRJ-505; hatch A3), from the one `get` it makes (`reading`) and
 * whether that row has a session id: a row read `ended` or `missing` with a
 * session id gets a `resume`, one with none a reuse spawn; no row left gets
 * the plain first spawn; a row read live, `pending` included, gets no
 * launch (HO rev 28), and so does a failed read (no information). Never a
 * kill and never a plain spawn over a row. A key recorded in
 * `retired-keys.json` gets the reuse in place of a `resume` or a plain spawn
 * (b.jg5 SRJ-805). Pure.
 */
export function decideFinishedRowLaunch(
  reading: LatchRecheckReading,
  hasSessionId: boolean,
  retiredKeyRecorded: boolean,
): LatchRecheckCall {
  switch (reading.kind) {
    case RECHECK_READING_FAILED:
      return RECHECK_CALL_NONE
    case RECHECK_READING_NO_ROW:
      return retiredAware(RECHECK_CALL_PLAIN_SPAWN, retiredKeyRecorded)
    case RECHECK_READING_STATE:
      if (!AGENT_DIRECTOR_DEAD_STATES.has(reading.state)) return RECHECK_CALL_NONE
      return retiredAware(hasSessionId ? RECHECK_CALL_RESUME : RECHECK_CALL_REUSE_SPAWN, retiredKeyRecorded)
  }
}

// ---------------------------------------------------------------------------
// The re-check's verdict on a `read-pane` answer (b.jg5 SRJ-505, SRJ-117)
// ---------------------------------------------------------------------------

/** The answer keeps the persona latched with its case (no post, record unchanged). */
export const RECHECK_VERDICT_STILL_LATCHED = 'still-latched'
/** The answer finds the condition cleared. */
export const RECHECK_VERDICT_CLEARED = 'cleared'
/** The answer gives no information: still latched, no condition, no outage, no post. */
export const RECHECK_VERDICT_NO_INFORMATION = 'no-information'
/** CONFIG: still latched; the `ad-config-malformed` outage is raised (by the wrapper). */
export const RECHECK_VERDICT_CONFIG = 'config'
/** UNUSABLE NAME: the persona relatches with "unusable recorded name". */
export const RECHECK_VERDICT_UNUSABLE_NAME = 'unusable-name'
/** A CONFLICT with another case, at a retry: the persona relatches with it. */
export const RECHECK_VERDICT_RELATCH = 'relatch'
/** Any probe answer the table does not name as cleared: still latched, with no set and no post. */
export const RECHECK_VERDICT_KEPT = 'kept'

/** What a re-check makes of one `read-pane` answer. */
export type LatchRecheckVerdict =
  | typeof RECHECK_VERDICT_STILL_LATCHED
  | typeof RECHECK_VERDICT_CLEARED
  | typeof RECHECK_VERDICT_NO_INFORMATION
  | typeof RECHECK_VERDICT_CONFIG
  | typeof RECHECK_VERDICT_UNUSABLE_NAME
  | typeof RECHECK_VERDICT_RELATCH
  | typeof RECHECK_VERDICT_KEPT

/**
 * One `read-pane` answer as the verdicts read it: the pure mapper's outcome
 * kind (`PANE_READ_*`, `src/pane-read.ts`; `PANE_READ_PANE` for a pane) and,
 * for a CONFLICT, the case its description gives (`recogniseConflictCase`).
 */
export interface LatchRecheckPaneAnswer {
  readonly kind: PaneReadOutcome['kind']
  readonly conflictCase?: ConflictLatchCase
}

/** The verdict shared by both `read-pane`s for the answers that give no information, CONFIG and UNUSABLE NAME; undefined for the rest. */
function commonPaneVerdict(answer: LatchRecheckPaneAnswer): LatchRecheckVerdict | undefined {
  switch (answer.kind) {
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_ENVIRONMENT:
    case PANE_READ_UNCLASSIFIED:
    // b.jg5 SRJ-117: `ErrSpawnNotFound` from `read-pane`: the next re-check's read decides.
    case PANE_READ_ABSENT:
      return RECHECK_VERDICT_NO_INFORMATION
    case PANE_READ_CONFIG:
      return RECHECK_VERDICT_CONFIG
    case PANE_READ_UNUSABLE_NAME:
      return RECHECK_VERDICT_UNUSABLE_NAME
    default:
      return undefined
  }
}

/**
 * The probe's verdict (b.jg5 SRJ-505, SRJ-117's "Latch re-check probe" row)
 * for a latch of `latchCase` on one one-line `read-pane` answer: a pane
 * keeps "this row's own id" latched and clears "the agent's pane was not
 * found"; GONE clears both; a CONFLICT with the latch's own case keeps it
 * latched; UNAVAILABLE, ENVIRONMENT, UNCLASSIFIED and an absent row give no
 * information; CONFIG keeps it (`config`); UNUSABLE NAME relatches
 * (`unusable-name`); any other answer, a CONFLICT with another case
 * included, keeps the latch as it is, with no relatch and no post (`kept`).
 * Pure.
 */
export function decideLatchRecheckProbe(latchCase: LatchCase, answer: LatchRecheckPaneAnswer): LatchRecheckVerdict {
  const probed = latchCase === LATCH_CASE_OWN_ID || latchCase === LATCH_CASE_PANE_NOT_FOUND
  switch (answer.kind) {
    case PANE_READ_PANE:
      if (latchCase === LATCH_CASE_OWN_ID) return RECHECK_VERDICT_STILL_LATCHED
      return latchCase === LATCH_CASE_PANE_NOT_FOUND ? RECHECK_VERDICT_CLEARED : RECHECK_VERDICT_KEPT
    case PANE_READ_GONE:
      return probed ? RECHECK_VERDICT_CLEARED : RECHECK_VERDICT_KEPT
    case PANE_READ_CONFLICT:
      return answer.conflictCase === latchCase ? RECHECK_VERDICT_STILL_LATCHED : RECHECK_VERDICT_KEPT
    default:
      return commonPaneVerdict(answer) ?? RECHECK_VERDICT_KEPT
  }
}

/**
 * The verdict on a "conflicting labels" latch's `read-pane` of a `pending`
 * row (b.jg5 SRJ-505, SRJ-117), which is that latch's retry, not a probe:
 * a pane or GONE clears it as a retry's answer (SRJ-506); a CONFLICT with
 * the latch's own case keeps it (no post), and one with another case
 * relatches (`relatch`); UNAVAILABLE, ENVIRONMENT, UNCLASSIFIED and an
 * absent row give no information; CONFIG keeps it; UNUSABLE NAME relatches.
 * Pure.
 */
export function decideLatchRecheckPendingReadPane(latchCase: LatchCase, answer: LatchRecheckPaneAnswer): LatchRecheckVerdict {
  switch (answer.kind) {
    case PANE_READ_PANE:
    case PANE_READ_GONE:
      return RECHECK_VERDICT_CLEARED
    case PANE_READ_CONFLICT:
      return answer.conflictCase === latchCase ? RECHECK_VERDICT_STILL_LATCHED : RECHECK_VERDICT_RELATCH
    default:
      return commonPaneVerdict(answer) ?? RECHECK_VERDICT_NO_INFORMATION
  }
}

// ---------------------------------------------------------------------------
// The re-check's clear hand-off (b.jg5 SRJ-505, SRJ-506)
// ---------------------------------------------------------------------------

/** Cleared by step 1's read: the row is gone, or it reported in. */
export const RECHECK_CLEARED_BY_STEP_1 = 'step-1'
/** Cleared by a "launch start not recorded" latch's row read `ended` or `missing` (its clear is followed by one bring-up retry, SRJ-506). */
export const RECHECK_CLEARED_BY_LAUNCH_START_FINISHED = 'launch-start-finished'
/** Cleared by a retry at the cadence (or step 1's spawn retry) that was not refused. */
export const RECHECK_CLEARED_BY_RETRY = 'retry'
/** Cleared by a "not this launch's session" latch's finished-row retry that was not refused. */
export const RECHECK_CLEARED_BY_FINISHED_ROW_RETRY = 'finished-row-retry'
/** Cleared by a "conflicting labels" latch's `read-pane` of a `pending` row (a pane or GONE). */
export const RECHECK_CLEARED_BY_PENDING_READ_PANE = 'pending-read-pane'
/** Cleared by a run of the restart path's decision that completed with no refusal. */
export const RECHECK_CLEARED_BY_RESTART_DECISION = 'restart-decision'
/** A probe that found the condition cleared: the latch is not cleared by it (SRJ-506's `find-missing` and single retry follow). */
export const RECHECK_CLEARED_BY_PROBE = 'probe'

/** What cleared, or (for a probe) found the condition cleared. */
export type LatchRecheckClearedBy =
  | typeof RECHECK_CLEARED_BY_STEP_1
  | typeof RECHECK_CLEARED_BY_LAUNCH_START_FINISHED
  | typeof RECHECK_CLEARED_BY_RETRY
  | typeof RECHECK_CLEARED_BY_FINISHED_ROW_RETRY
  | typeof RECHECK_CLEARED_BY_PENDING_READ_PANE
  | typeof RECHECK_CLEARED_BY_RESTART_DECISION
  | typeof RECHECK_CLEARED_BY_PROBE

/**
 * What the re-check hands off for persona P: a cleared outcome, or a probe
 * that found the condition cleared. `record` is P's latch record when the
 * round decided (the probe's or retry's latched operation). `reason` is
 * SRJ-1005's for the recovery notice (a probe has none: its single retry's
 * answer gives it). `by` says what cleared: step 1, a "launch start not
 * recorded" row read finished and a "conflicting labels" latch's `pending`
 * `read-pane` launched nothing, so the bring-up the latch held back is still
 * owed; a retry, a finished-row retry and a run of the restart path's
 * decision keep their own outcome (SRJ-506).
 */
export type LatchRecheckCleared =
  | {
      readonly by: Exclude<LatchRecheckClearedBy, typeof RECHECK_CLEARED_BY_PROBE>
      readonly record: ConflictLatchRecord
      readonly reason: LatchRecoveryReason
    }
  | { readonly by: typeof RECHECK_CLEARED_BY_PROBE; readonly record: ConflictLatchRecord }

/**
 * The one clear hand-off (b.jg5 SRJ-505, SRJ-506): called synchronously, once
 * per cleared outcome, before any step of the clearing path that stops for a
 * latched persona (the dialog approver, a live-row sequence) and before a
 * definite failure's class handling. Must not throw (a throw is logged and
 * swallowed by the caller). Anything asynchronous it starts must not await
 * the persona's lifecycle serializer from inside the round (the round holds
 * that turn).
 */
export type LatchRecheckClearHandOff = (key: string, cleared: LatchRecheckCleared) => void

/** What the silent clear needs: the latch's silent forget and the re-check timer's stop. */
export interface SilentLatchRecheckClearDeps {
  readonly latch: Pick<ConflictLatch, 'forget'>
  /** Stop persona `key`'s re-check timer (`LatchRecheckController.stop`). */
  readonly stopTimer: (key: string) => void
}

/**
 * The silent clear hand-off: for a cleared outcome, the latch's silent
 * forget (no post, no observer call, no line) and the persona's re-check
 * timer stop; for a probe that found the condition cleared, nothing (the
 * persona stays latched; the round's line names it). No recovery post, no
 * episode end and no bring-up: SRJ-506's clear replaces this hand-off
 * whole, through the re-check's dependency builder. Never throws.
 */
export function createSilentLatchRecheckClear(deps: SilentLatchRecheckClearDeps): LatchRecheckClearHandOff {
  return (key, cleared) => {
    if (cleared.by === RECHECK_CLEARED_BY_PROBE) return
    try {
      deps.latch.forget(key)
    } finally {
      deps.stopTimer(key)
    }
  }
}

// ---------------------------------------------------------------------------
// The re-check timer (b.jg5 SRJ-505)
// ---------------------------------------------------------------------------

/** The timers the re-check controller uses (the system clock in production, a fake clock in tests). */
export interface LatchRecheckClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** Dependencies of {@link createLatchRecheckController}. */
export interface LatchRecheckControllerDeps {
  readonly clock: LatchRecheckClock
  /** The latch's own query. A throw counts as latched. */
  readonly isLatched: (key: string) => boolean
  /** Submit one operation for `key` through the persona lifecycle serializer (`PersonaSerializer.run`). */
  readonly serialize: <T>(key: string, operation: () => T | Promise<T>) => Promise<T>
  /** One re-check round for `key`, run inside its serializer turn. A rejection is logged. */
  readonly round: (key: string) => Promise<void>
  /** Receives the controller's own lines (a failed round, a failed clock). A throwing log is swallowed. */
  readonly log: (line: string) => void
  /** The interval; `LATCH_RECHECK_INTERVAL_MS` when absent. */
  readonly intervalMs?: number
}

/** One server's re-check timers, one per latched persona. */
export interface LatchRecheckController {
  /** The latch's set observer: a persona that goes from unlatched to latched gets its timer; a relatch or a same-case set changes nothing. */
  readonly observer: ConflictLatchSetObserver
  /** Arm `key`'s timer, its first round one interval from now. Answers false, doing nothing, when it is armed already or after `stopAll`. */
  arm(key: string): boolean
  /** Stop `key`'s timer (a clear, a teardown's forget). A round in progress finishes and schedules nothing. Answers whether one was armed; a stop of no timer is a no-op. */
  stop(key: string): boolean
  /** Stop every timer and arm none again (shutdown). */
  stopAll(): void
  /** Whether `key` has a timer (waiting or running its round). */
  isArmed(key: string): boolean
  /** The keys with a timer. */
  armedKeys(): string[]
  /** Resolves once `key`'s round in progress, if any, has settled (with its next arm); at once when none runs. Never rejects. */
  whenRoundSettled(key: string): Promise<void>
}

/** One persona's timer: its pending handle and its round in progress. */
interface LatchRecheckEntry {
  handle: unknown
  settled: Promise<void> | undefined
}

/**
 * Build one server's re-check timers (b.jg5 SRJ-505) over an injected clock,
 * the latch's query, the persona serializer and the round; it imports
 * nothing from the session manager. A persona's timer is armed when it goes
 * from unlatched to latched (its `observer`, bound after the holds and the
 * notice, `bindLatchRecheck`); its first round is due one interval after the
 * latch, whatever `health_check_interval` is. Each fire submits one round
 * through the serializer (never awaited inside a turn the persona holds) and
 * the next is due one interval after that round settles, so rounds never
 * overlap; a fire, and a round when its turn comes, do nothing when the
 * persona is no longer latched, its timer was stopped, or `stopAll` ran. A
 * relatch neither restarts the timer nor adds one. Stops: `stop` (the clear
 * hand-off; a teardown's forget, bound beside it), and `stopAll` at
 * shutdown. No line for an arm or a stop; nothing runs at creation.
 */
export function createLatchRecheckController(deps: LatchRecheckControllerDeps): LatchRecheckController {
  const entries = new Map<string, LatchRecheckEntry>()
  const intervalMs = deps.intervalMs ?? LATCH_RECHECK_INTERVAL_MS
  let closed = false

  function latched(key: string): boolean {
    try {
      return deps.isLatched(key) === true
    } catch {
      return true
    }
  }

  function schedule(key: string, entry: LatchRecheckEntry): void {
    try {
      entry.handle = deps.clock.setTimeout(() => fire(key, entry), intervalMs)
    } catch (thrown) {
      if (entries.get(key) === entry) entries.delete(key)
      safeLog(deps.log, `[slack] conflict-latch: persona=${key} re-check timer could not be set: ${describeThrownValue(thrown)} — not armed`)
    }
  }

  function goes(key: string, entry: LatchRecheckEntry): boolean {
    return !closed && entries.get(key) === entry && latched(key)
  }

  function fire(key: string, entry: LatchRecheckEntry): void {
    entry.handle = undefined
    if (entries.get(key) !== entry) return
    if (!goes(key, entry)) {
      entries.delete(key)
      return
    }
    const round = deps.serialize(key, async () => {
      if (goes(key, entry)) await deps.round(key)
    })
    entry.settled = round
      .catch((thrown: unknown) => {
        safeLog(deps.log, `[slack] conflict-latch: persona=${key} re-check round failed: ${describeThrownValue(thrown)}`)
      })
      .then(() => {
        entry.settled = undefined
        if (entries.get(key) !== entry) return
        if (!goes(key, entry)) {
          entries.delete(key)
          return
        }
        schedule(key, entry)
      })
  }

  function arm(key: string): boolean {
    if (closed || entries.has(key)) return false
    const entry: LatchRecheckEntry = { handle: undefined, settled: undefined }
    entries.set(key, entry)
    schedule(key, entry)
    return entries.get(key) === entry
  }

  function stop(key: string): boolean {
    const entry = entries.get(key)
    if (entry === undefined) return false
    entries.delete(key)
    if (entry.handle !== undefined) {
      try {
        deps.clock.clearTimeout(entry.handle)
      } catch {
        /* a timer that fires anyway finds its entry gone and does nothing */
      }
      entry.handle = undefined
    }
    return true
  }

  return {
    observer: ({ key, outcome }) => {
      if (outcome === CONFLICT_LATCH_SET_LATCHED) arm(key)
    },
    arm,
    stop,
    stopAll() {
      closed = true
      for (const key of [...entries.keys()]) stop(key)
    },
    isArmed: (key) => entries.has(key),
    armedKeys: () => [...entries.keys()],
    async whenRoundSettled(key) {
      await entries.get(key)?.settled
    },
  }
}

/**
 * Bind the re-check timers to `latch`: the controller's set observer (a new
 * latch arms its timer) and a forget observer that stops the persona's timer
 * at every forget of its latch (its teardown's, through `main()`'s
 * `forgetConflictLatch` binding; the silent clear's). Answers the removal of
 * both. `main()` binds it after the holds and the notice, so a set runs the
 * read, the set, the holds, the notice, then the timer's arm.
 */
export function bindLatchRecheck(
  latch: Pick<ConflictLatch, 'addSetObserver' | 'addForgetObserver'>,
  controller: Pick<LatchRecheckController, 'observer' | 'stop'>,
): () => void {
  const removeSet = latch.addSetObserver(controller.observer)
  const removeForget = latch.addForgetObserver((key) => {
    controller.stop(key)
  })
  return () => {
    removeSet()
    removeForget()
  }
}

/**
 * The re-check round's one line (b.jg5 SRJ-505, SRJ-1014): the persona
 * reference, the latch's case, the call made (`none` when it made none
 * after its read) and the answer's class, each a CSCB-written label:
 *
 *   [slack] conflict-latch: re-check of <ref> — case=<case> call=<call> answer=<answer>
 *
 * Carries no agent-director description. Pure.
 */
export function latchRecheckRoundLine(ref: string, latchCase: LatchCase, call: string, answer: string): string {
  return `[slack] conflict-latch: re-check of ${ref} — case=${latchCase} call=${call} answer=${answer}`
}
