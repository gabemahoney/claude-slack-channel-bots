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
 * persona's latch silently: no post, no observer call, no line. The persona
 * teardown calls it (`runTeardown`, `src/persona-lifecycle.ts`) after the
 * launch in flight settled and right before it forgets the persona's notice
 * episodes, which ends the CONFLICT episode with it. There is no forget-all.
 *
 * The unusable recorded name (SRJ-512): {@link isUnusableNameError} tells
 * an UNUSABLE NAME value by the classifier, and {@link unusableNameSetInput}
 * builds its `set` input: the case "unusable recorded name", the refused
 * operation "none", the row state the caller gives, the classification's
 * message as the description and the session quoted in it. Its triggers are
 * in `src/session-manager.ts` (the collision ladder's spawns, `resume`, kill
 * and delete, the shared own-row `status` and `get` reads and their step,
 * and the working-pane read) and the liveness and reconnect adapters in
 * `src/server.ts`, which apply the session manager's own-row `status` step.
 * Later sites latch through the same entry: the dialog approver (E17), the
 * reconnect's keystrokes and the prompt rows' pane reads (E19), the restart
 * path's kill (E20), the reuse spawn (E22) and the re-check's relatch (E30).
 *
 * The launch start not recorded (SRJ-513): {@link launchStartNotRecordedSetInput}
 * builds its `set` input: the case "launch start not recorded", the refused
 * operation "none", the row state the caller gives (`pending`), the session
 * `slack_bot_<key>` and no description. Its trigger is the row-read rule's
 * launch-start decision (`decideOwnRowRead`, `src/row-read-rules.ts`), acted
 * on by the session manager's shared own-row `get` read and own-row `status`
 * step (so also by the liveness and reconnect adapters in `src/server.ts`),
 * which latch through `set` with this input. Later sites latch through the
 * same input: the start sweep's `list` (E26), the dialog approver (E17) and
 * the re-check's relatch (E30).
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
 * persona's retry timer, ends its `tmux-unresponsive` condition silently and
 * ends its unclassified-error episode on every set, through the injected
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
 * Where later Epics plug in: the sites E17 to E22, E26 and E29 convert all
 * latch through `set`, `setFromConflict`, `setFromUnusableName` or
 * `setLaunchStartNotRecorded`; E30's re-check and its timer read the record and
 * relatch through `set`, and post the recovery notice when a latch clears;
 * E31's `clear-latch` clears through the clear E30 adds.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] conflict-latch: persona=<key> latched — case=<case> session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> relatched — case=<case> (was <case>) session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> set observer failed: <error>
 *   [slack] conflict-latch: persona=<key> hold failed (<hold>): <error>
 *
 * where `<state>` is {@link describeLatchRowState}'s rendering. A same-case
 * set logs nothing. No line carries a token: the session name and the
 * description are redacted before they are stored.
 *
 * No agent-director call, no timer, no persistence and no module-scope
 * state; nothing runs at import or at creation. No label option name is
 * spelled here (b.jg5 SRJ-716).
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
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
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
/** Hold case "unusable recorded name" (SRJ-512): set by `setFromUnusableName` ({@link unusableNameSetInput}). */
export const LATCH_CASE_UNUSABLE_RECORDED_NAME = 'unusable-recorded-name'
/** Hold case "launch start not recorded" (SRJ-513): set by `setLaunchStartNotRecorded` ({@link launchStartNotRecordedSetInput}). */
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
  /** Drop `key`'s latch silently (its teardown): no post, no observer call, no line. Answers whether it was latched. */
  forget(key: string): boolean
  /** Add a set observer; the returned function removes it. */
  addSetObserver(observer: ConflictLatchSetObserver): () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build one server's latches. Nothing is read, posted or logged at creation. */
export function createConflictLatch(deps: ConflictLatchDeps): ConflictLatch {
  const records = new Map<string, ConflictLatchRecord>()
  const observers = new Set<ConflictLatchSetObserver>()

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

    forget: (key) => records.delete(key),

    addSetObserver(observer) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
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
// Built here, posted elsewhere: E30's re-check and clear post it (every
// reason but "cleared by hand"), and E31's `clear-latch` posts it with
// "cleared by hand"; nothing in this module posts it. Two no-post rules
// before a clear are E30's to enforce: a "not this launch's session" latch
// posts none when its finished-row retry is made or relatches P, only when
// that retry clears it (`LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED`); a
// latch whose refused operation is a spawn posts none when step 1 finds no
// row and the spawn is retried or that retry is refused, only when the retry
// clears it (`LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED`).
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
 * After the episodes' `close` (shutdown) it opens and posts nothing. The
 * clear's end of an episode is E30's, and a teardown's `forget` ends them.
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
 * `tmux-unresponsive` condition and its unclassified-error episodes.
 */
export interface ConflictLatchHolds {
  /** Stop the persona's retry timer with the latch's stop reason, through the controller's `stop` (SRJ-305: "P latches, whatever the case"). */
  stopRetryTimer(key: string): void
  /** End the persona's `tmux-unresponsive` condition silently: no recovery notice (SRJ-310). */
  endTmuxUnresponsive(key: string): void
  /** End the persona's unclassified-error episode with the latch's end reason (SRJ-313). */
  endUnclassifiedError(key: string): void
}

/**
 * The holds' set observer (b.jg5 SRJ-502): on every set, a latch, a relatch
 * and a same-case set alike and whatever the case, it stops the persona's
 * retry timer, then ends its `tmux-unresponsive` condition silently, then
 * ends its unclassified-error episode, in that order. A same-case set runs
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
 * stopped and both episodes are ended before the notice is posted.
 */
export function bindConflictLatchHolds(
  latch: Pick<ConflictLatch, 'addSetObserver'>,
  holds: ConflictLatchHolds,
  log: (line: string) => void,
): () => void {
  return latch.addSetObserver(createConflictLatchHoldObserver(holds, log))
}
