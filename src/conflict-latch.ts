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
 * `setFromConflict` builds the record from a thrown CONFLICT value. Every set
 * calls each set observer once with the key, the outcome and the record, so
 * the CONFLICT notice and the holds react without this module importing
 * them. `forget(key)` drops one persona's latch silently: no post, no
 * observer call, no line. There is no forget-all.
 *
 * Where later Epics plug in: E14's `provenance_conflict` note latch, E16's
 * two hold latches and their triggers, and the sites E17 to E22 and E29
 * convert all latch through `set` or `setFromConflict`; T2's notice and
 * E16's hold notices are set observers; E30's re-check and its timer read the
 * record and relatch through `set`; E31's `clear-latch` clears through the
 * clear E30 adds.
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] conflict-latch: persona=<key> latched — case=<case> session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> relatched — case=<case> (was <case>) session="<name>" refused=<operation> state=<state>[ message="<description>"]
 *   [slack] conflict-latch: persona=<key> set observer failed: <error>
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

import { classifyAdError, conflictDescriptionOf, AD_ERROR_CLASS_CONFLICT } from './ad-error-class.ts'
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
import { personaTmuxSessionName } from './persona-identity.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

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
/** Hold case "unusable recorded name" (SRJ-512): no trigger here (E16). */
export const LATCH_CASE_UNUSABLE_RECORDED_NAME = 'unusable-recorded-name'
/** Hold case "launch start not recorded" (SRJ-513): no trigger here (E16). */
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

/** The two hold cases, declared here; E16 builds their triggers, notices and episodes. */
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
