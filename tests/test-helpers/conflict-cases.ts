/**
 * test-helpers/conflict-cases.ts — The table of CONFLICT latch cases for
 * `test.each` (b.jg5 SRJ-1304; cases per SRJ-501, SRJ-505 and SRJ-507).
 *
 * One row per refusal CSCB can meet: the stub's `errTmuxSessionConflict`
 * description from the verb (and option) that gives it, and what latching a
 * persona on it records. Every entry of the stub's `CONFLICT_CASES` appears
 * in at least one row.
 *
 * Columns filled here (E13, the latch record):
 *   - `name`: a readable row name, built from the operation, the stub's case
 *     identifier and the option set;
 *   - `verb`, `stubCase`, `options`, `sessionName`, and `build`, a thunk that
 *     builds the error through the stub's `errTmuxSessionConflict` with them;
 *   - `latchCase`: the case `src/conflict-latch.ts` recognises (SRJ-507);
 *   - `refusedOperation`: what that verb's refusal refused (SRJ-501): a plain
 *     spawn, a spawn with `--reuse-finished`, a `resume`, or, for a pane verb
 *     or a kill, P's next check or recovery;
 *   - `rowState`: the row state the latch records on that path (SRJ-501): no
 *     row after the pre-spawn scan's refusal, `ended` after a plain spawn's
 *     "duplicate session" answer and on the finished-row path, the state the
 *     path last read for a pane verb or a kill, unreadable where the path
 *     could not read it.
 *
 * Columns filled here (E13 T2, the CONFLICT notice, SRJ-1004):
 *   - `notice`: the {@link ExpectedConflictNotice} for the row's case, quoted
 *     session and description: its `lines` in SRJ-1004's order, its `text`
 *     (the lines joined), and `carries`, the flags for the lines it must
 *     carry: the pointer to "Operator actions", the must-not-be-ended line
 *     (`row` for "a different instance id", `store` for "another
 *     agent-director store", `none` otherwise), the `list` line and the
 *     human-only line.
 *
 * Unrecognised text and "never reported in", which carry no case sentence,
 * are rows of the table (a `resume`'s unrecognised answer and a `kill`'s
 * never-reported-in answer); every `ConflictLatchCase` has at least one row.
 *
 * Other exports (E13 T2):
 *   - {@link expectedConflictNotice}: the expected notice for any case,
 *     session and description (none: no description line), assembled from
 *     the fixed lines and the case sentences `src/conflict-latch.ts` exports
 *     (`CONFLICT_NOTICE_*`, `CONFLICT_CASE_SENTENCES`), with the description
 *     rendered as a record holds it (`renderLogMessageText`) and both it and
 *     the session name escaped once for Slack (`escapeSlackControlCharacters`).
 *     It never calls `conflictNoticeText`, so it is an independent check of it;
 *   - {@link SESSION_ENDING_COMMAND_FORMS} and {@link sessionEndingCommandsIn}:
 *     the session-ending command forms of ADSRD SR-1.4 that SRJ-1001 lists
 *     (`kill` named as a command to run, `pause`, `--include-finished`,
 *     `tmux kill-session`, `tmux kill-server`), as patterns, and the names of
 *     the forms a text matches. None matches agent-director's own "no kill was
 *     sent", "retry kill later" or "never delete this row". E16's, E29's and
 *     E36's text checks reuse them;
 *   - {@link cscbOwnLines}: a notice's lines with agent-director's quoted
 *     description taken out, so a check over CSCB's own words lets the quoted
 *     description through. Two forms: a CONFLICT notice's description line
 *     (SRJ-1004; the line that opens with `CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD`)
 *     is dropped whole; a description quoted inside a sentence (SRJ-1019's
 *     one-line notice) is cut out of its line, its frame and every CSCB word
 *     kept ({@link withoutInlineDescription}). {@link cscbOwnText} joins the
 *     lines back.
 *
 * Unusable-name rows (E16 T1, SRJ-512 and SRJ-1019), {@link UNUSABLE_NAME_CASE_ROWS}:
 * one row per fault in the stub's `UNUSABLE_NAME_FAULTS` for each verb site
 * kind T1 wires ({@link UNUSABLE_NAME_SITES}: `resume`, a plain spawn, the
 * ladder's kill, the ladder's delete, `read-pane`, `status`, `get`). Columns
 * ({@link UnusableNameCaseRow}):
 *   - `name` (`<site>: <fault>`), `site`, `verb` (the agent-director verb
 *     that answers), `fault`, and `build`, a thunk building the stub's
 *     `errUnusableName(fault)`;
 *   - `latchCase` and `refusedOperation`: "unusable recorded name" and
 *     "none" (`LATCH_CASE_UNUSABLE_RECORDED_NAME`, `REFUSED_OPERATION_NONE`);
 *   - `rowState`: the row state the path records. A `status` or a `get`
 *     that itself answers UNUSABLE NAME records unreadable. The others
 *     record the state the path last read: `ended` for `resume` and for the
 *     ladder's kill and delete (the finished-row path, a `resume` answering
 *     `ErrSpawnNotResumable` for the kill), `working` for `read-pane` (the
 *     launch wait's evidence read and `checkWorkingRowPane`). The plain spawn
 *     is the first spawn, which read nothing before it, so its state comes
 *     from the one latch-time `status` read (`latchTimeRead: true`); the row
 *     expects no row, so a case arranges that read to answer
 *     `ErrSpawnNotFound`;
 *   - `latchTimeRead`: true when the recorded state comes from the latch-time
 *     `status` read rather than from a read the path made before the call;
 *   - `description`: the classification's message (`classifyAdError(...)
 *     .message`: redacted, on one line, capped), which the record holds;
 *   - `notice(key)`: the SRJ-1019 notice for persona `key`, built by
 *     `unusableNameNoticeText(key, description)` (its instance id from
 *     `personaInstanceId`); `sessionName(key)`: the session the record holds,
 *     `personaTmuxSessionName(key)` (the stub's descriptions quote none).
 * The approver's and the reconnect's `send-keys` and a reuse spawn get no row
 * here (E17, E19, E22).
 *
 * The tmux-touching verbs (SRJ-502), {@link TMUX_TOUCHING_STUB_VERBS} and
 * {@link tmuxTouchingCallsIn}: `resume`, `spawn` in both forms (plain and
 * `--reuse-finished`, both logged in `spawnCalls`), `read-pane`, `send-keys`,
 * `kill` and `pause`, each with its stub call-log list, and the calls a stub
 * log holds for them ({@link tmuxTouchingCallCounts} takes the log's lengths
 * first, so a case can ask only for the calls made since). A test filters
 * the stub's call log through these and never types the list itself.
 *
 * Per-persona CONFLICT helpers (shared by the recovery-harness cases, so no
 * test file keeps its own copy):
 *   - {@link conflictForPersona}: a plain spawn's CONFLICT for persona `key`,
 *     its session left over from an earlier life ("duplicate session"): the
 *     stub's `errTmuxSessionConflict('spawn', 'duplicate-session-leftover',
 *     personaTmuxSessionName(key))`;
 *   - {@link conflictNoticeForPersona}: the CONFLICT notice that error posts
 *     to persona `key`'s destination, `{ key, text }`, the text
 *     {@link expectedConflictNotice} gives for `LATCH_CASE_LEFTOVER`, the
 *     persona's session name and the error's description.
 *
 * Columns added later: E14 adds the `provenance_conflict` note latch's rows
 * (P's bring-up, no builder call); E16 T2 adds the "launch start not
 * recorded" rows and their SRJ-1020 notice; E30 adds the re-check's action
 * and its still-latched and cleared answers (SRJ-505), with a plain-spawn row
 * per row state step 1 can read, and the unusable-name rows' re-check
 * (`status` only) and `ErrSpawnNotFound` clear columns.
 *
 * There is no "no pane 0.0" row: that case is withdrawn (rev 17; SRJ-507).
 *
 * No case word, notice text or session name is written here: the words reach
 * a row only through the stub, the notice's texts only through
 * `src/conflict-latch.ts`'s exports, and the session name is the stub's
 * `STUB_TMUX_SESSION_NAME` or, for a persona, `personaTmuxSessionName(key)`
 * (its instance id `personaInstanceId(key)`).
 * No Phase-1-only export
 * is named, and no `mock.module()` is used.
 *
 * SPDX-License-Identifier: MIT
 */

import { AGENT_DIRECTOR_PENDING_STATE } from '../../src/liveness-reading.ts'
import {
  CONFLICT_CASE_SENTENCES,
  CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_CASE_SENTENCE_LEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL,
  CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_FIRST_LINE_HEAD,
  CONFLICT_NOTICE_FIRST_LINE_TAIL,
  CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  CONFLICT_NOTICE_LINE_SEPARATOR,
  CONFLICT_NOTICE_LIST_LINE_HEAD,
  CONFLICT_NOTICE_LIST_LINE_TAIL,
  CONFLICT_NOTICE_POINTER_LINE,
  LATCH_CASE_ANOTHER_STORE,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_DIFFERENT_ID,
  LATCH_CASE_LEFTOVER,
  LATCH_CASE_NEVER_REPORTED_IN,
  LATCH_CASE_NO_VALID_ID,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_CASE_OWN_ID,
  LATCH_CASE_PANE_NOT_FOUND,
  LATCH_CASE_UNRECOGNISED,
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  UNUSABLE_NAME_NOTICE_DESCRIPTION_END,
  UNUSABLE_NAME_NOTICE_POINTER,
  UNUSABLE_NAME_NOTICE_REASON,
  UNUSABLE_NAME_NOTICE_SEPARATOR,
  latchRowStateRead,
  takesUnrecognisedHandling,
  unusableNameNoticeText,
  type ConflictCaseWithSentence,
  type ConflictLatchCase,
  type LatchRowState,
  type RefusedOperation,
} from '../../src/conflict-latch.ts'
import { classifyAdError } from '../../src/ad-error-class.ts'
import { renderLogMessageText } from '../../src/persona-connection-errors.ts'
import { personaTmuxSessionName } from '../../src/persona-identity.ts'
import { escapeSlackControlCharacters } from '../../src/slack-text-escape.ts'
import {
  STUB_TMUX_SESSION_NAME,
  UNUSABLE_NAME_FAULTS,
  errTmuxSessionConflict,
  errUnusableName,
  type ConflictCase,
  type ConflictOptions,
  type StubCallLog,
  type UnusableNameFault,
} from './agent-director-stub.ts'

/** One refusal and what latching a persona on it records. */
export interface ConflictCaseRow {
  /** Readable row name for `test.each`. */
  readonly name: string
  /** The verb the stub's error carries. */
  readonly verb: string
  /** The stub's case identifier. */
  readonly stubCase: ConflictCase
  /** The stub's variant options, when the row needs one. */
  readonly options: ConflictOptions
  /** The session the description quotes (and the latch records). */
  readonly sessionName: string
  /** Builds the error through `errTmuxSessionConflict`. */
  readonly build: () => ReturnType<typeof errTmuxSessionConflict>
  /** The case `recogniseConflictCase` gives the description. */
  readonly latchCase: ConflictLatchCase
  /** The refused operation the latch records for this verb. */
  readonly refusedOperation: RefusedOperation
  /** The row state the latch records on this path. */
  readonly rowState: LatchRowState
  /** The CONFLICT notice for the row's case, quoted session and description (SRJ-1004). */
  readonly notice: ExpectedConflictNotice
}

// ---------------------------------------------------------------------------
// The expected CONFLICT notice (b.jg5 SRJ-1004)
// ---------------------------------------------------------------------------

/** Which must-not-be-ended line a notice carries: another row's, another store's, or none. */
export type MustNotEndLine = 'row' | 'store' | 'none'

/** The lines a CONFLICT notice must carry besides its first line and its description line. */
export interface ConflictNoticeCarries {
  /** The pointer to agent-director's README "Operator actions": every case but "a different instance id". */
  readonly pointer: boolean
  /** "a different instance id": `row`, in place of the pointer; "another agent-director store": `store`, before the pointer. */
  readonly mustNotEnd: MustNotEndLine
  /** The `list` line: every case. */
  readonly list: boolean
  /** The human-only line: every case. */
  readonly humanOnly: boolean
}

/** One expected CONFLICT notice body (the persona notifier adds the prefix). */
export interface ExpectedConflictNotice {
  /** Its lines, in SRJ-1004's order. */
  readonly lines: readonly string[]
  /** The lines joined by `CONFLICT_NOTICE_LINE_SEPARATOR`. */
  readonly text: string
  /** The flags for the lines it must carry. */
  readonly carries: ConflictNoticeCarries
  /** The case sentence in its first line; `undefined` for unrecognised text and "never reported in". */
  readonly caseSentence: string | undefined
  /** Its description line; `undefined` when there is no description. */
  readonly descriptionLine: string | undefined
}

/** What an expected notice is built from: a CONFLICT latch's case, its quoted session (as the record holds it) and its description, if any. */
export interface ExpectedConflictNoticeSource {
  readonly latchCase: ConflictLatchCase
  readonly sessionName: string
  readonly description?: string
}

/** The flags SRJ-1004 sets for a case. */
function carriesFor(latchCase: ConflictLatchCase): ConflictNoticeCarries {
  const mustNotEnd: MustNotEndLine =
    latchCase === LATCH_CASE_DIFFERENT_ID ? 'row' : latchCase === LATCH_CASE_ANOTHER_STORE ? 'store' : 'none'
  return Object.freeze({ pointer: latchCase !== LATCH_CASE_DIFFERENT_ID, mustNotEnd, list: true, humanOnly: true })
}

/**
 * The CONFLICT notice SRJ-1004 gives for `source`, assembled line by line
 * from `src/conflict-latch.ts`'s exported fixed lines and case sentences:
 * the first line (`"<session>"`, with the case sentence unless the case takes
 * the unrecognised-text wording), the description line (left out when the
 * rendered description is empty), the must-not-be-ended line and the pointer
 * as `carries` says, the `list` line (`<name>` without quotes) and the
 * human-only line. The session name and the rendered description are escaped
 * once for Slack.
 */
export function expectedConflictNotice(source: ExpectedConflictNoticeSource): ExpectedConflictNotice {
  const name = escapeSlackControlCharacters(source.sessionName)
  const caseSentence = takesUnrecognisedHandling(source.latchCase)
    ? undefined
    : CONFLICT_CASE_SENTENCES[source.latchCase as ConflictCaseWithSentence]
  const rendered = renderLogMessageText(source.description)
  const descriptionLine =
    rendered === ''
      ? undefined
      : CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + escapeSlackControlCharacters(rendered) + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL
  const carries = carriesFor(source.latchCase)
  const lines = [
    CONFLICT_NOTICE_FIRST_LINE_HEAD +
      `"${name}"` +
      (caseSentence === undefined ? '' : CONFLICT_NOTICE_CASE_SENTENCE_LEAD + caseSentence) +
      CONFLICT_NOTICE_FIRST_LINE_TAIL,
    ...(descriptionLine === undefined ? [] : [descriptionLine]),
    ...(carries.mustNotEnd === 'row' ? [CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE] : []),
    ...(carries.mustNotEnd === 'store' ? [CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE] : []),
    ...(carries.pointer ? [CONFLICT_NOTICE_POINTER_LINE] : []),
    CONFLICT_NOTICE_LIST_LINE_HEAD + name + CONFLICT_NOTICE_LIST_LINE_TAIL,
    CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  ]
  return Object.freeze({
    lines: Object.freeze(lines),
    text: lines.join(CONFLICT_NOTICE_LINE_SEPARATOR),
    carries,
    caseSentence,
    descriptionLine,
  })
}

/**
 * Where SRJ-1019's notice opens its quoted description, inside its first
 * sentence: the reason, then `agent-director said: "`.
 */
const INLINE_DESCRIPTION_OPEN = UNUSABLE_NAME_NOTICE_REASON + CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD

/**
 * Where SRJ-1019's notice closes its quoted description: the closing quote,
 * the sentence's end, the separator and the pointer sentence.
 */
const INLINE_DESCRIPTION_CLOSE =
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL +
  UNUSABLE_NAME_NOTICE_DESCRIPTION_END +
  UNUSABLE_NAME_NOTICE_SEPARATOR +
  UNUSABLE_NAME_NOTICE_POINTER

/**
 * `line` with a description quoted inside a sentence cut out (SRJ-1019's
 * form): everything between the first {@link INLINE_DESCRIPTION_OPEN} and
 * the last {@link INLINE_DESCRIPTION_CLOSE} after it is removed, the frame
 * itself and every other word kept. A line without that frame is returned
 * as it is.
 */
export function withoutInlineDescription(line: string): string {
  const open = line.indexOf(INLINE_DESCRIPTION_OPEN)
  if (open === -1) return line
  const start = open + INLINE_DESCRIPTION_OPEN.length
  const close = line.lastIndexOf(INLINE_DESCRIPTION_CLOSE)
  if (close < start) return line
  return line.slice(0, start) + line.slice(close)
}

/**
 * CSCB's own lines of a notice: its lines without agent-director's quoted
 * description. A CONFLICT notice's description line (the one that opens with
 * `CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD`) is dropped; a description quoted
 * inside a sentence (SRJ-1019) is cut out of its line
 * ({@link withoutInlineDescription}).
 */
export function cscbOwnLines(notice: string): string[] {
  return notice
    .split(CONFLICT_NOTICE_LINE_SEPARATOR)
    .filter((line) => !line.startsWith(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD))
    .map(withoutInlineDescription)
}

/** {@link cscbOwnLines} joined back by `CONFLICT_NOTICE_LINE_SEPARATOR`: CSCB's own text of a notice. */
export function cscbOwnText(notice: string): string {
  return cscbOwnLines(notice).join(CONFLICT_NOTICE_LINE_SEPARATOR)
}

// ---------------------------------------------------------------------------
// Per-persona CONFLICT error and notice
// ---------------------------------------------------------------------------

/** A plain spawn's CONFLICT for persona `key`: its session left over from an earlier life ("duplicate session"). */
export function conflictForPersona(key: string): ReturnType<typeof errTmuxSessionConflict> {
  return errTmuxSessionConflict(SPAWN_VERB, 'duplicate-session-leftover', personaTmuxSessionName(key))
}

/** The CONFLICT notice `err` (a {@link conflictForPersona} error) posts to persona `key`'s destination. */
export function conflictNoticeForPersona(key: string, err: ReturnType<typeof conflictForPersona>): { key: string; text: string } {
  const notice = expectedConflictNotice({ latchCase: LATCH_CASE_LEFTOVER, sessionName: personaTmuxSessionName(key), description: err.errDescription })
  return { key, text: notice.text }
}

// ---------------------------------------------------------------------------
// Session-ending command forms (ADSRD SR-1.4; b.jg5 SRJ-1001)
// ---------------------------------------------------------------------------

/** One session-ending command form: what it names and the pattern that finds it. */
export interface SessionEndingCommandForm {
  readonly name: string
  /** Not global, so it keeps no `lastIndex` between tests. */
  readonly pattern: RegExp
}

/** Imperative verbs that put a command to run after them. */
const RUN_VERBS = String.raw`(?:run|use|type|execute|issue|invoke)`

/** `verb` named as a command: `agent-director <verb>`, a code span opening with it, `<verb>` with an option or a pid, or a run verb before it. */
function commandFormOf(verb: string): RegExp {
  return new RegExp(
    String.raw`\bagent-director\s+${verb}\b|\x60\s*${verb}\b|\b${verb}\s+(?:-|\d)|\b${RUN_VERBS}\s+(?:the\s+|a\s+)?\x60?\s*${verb}\b`,
    'i',
  )
}

/**
 * The commands that end a session as ADSRD SR-1.4 defines one, as SRJ-1001
 * lists them for the CONFLICT, unusable-name, launch-start and stuck-launch
 * posts: `kill` named as a command to run (so agent-director's "no kill was
 * sent" and "retry kill later" are no hit), `pause` in any form,
 * `--include-finished` (with or without its dashes), `tmux kill-session` and
 * `tmux kill-server`.
 */
export const SESSION_ENDING_COMMAND_FORMS: readonly SessionEndingCommandForm[] = Object.freeze([
  Object.freeze({ name: 'kill as a command', pattern: commandFormOf('kill') }),
  Object.freeze({ name: 'pause', pattern: /\bpause\b/i }),
  Object.freeze({ name: '--include-finished', pattern: /include-finished/i }),
  Object.freeze({ name: 'tmux kill-session', pattern: /\bkill-session\b/i }),
  Object.freeze({ name: 'tmux kill-server', pattern: /\bkill-server\b/i }),
])

/** The names of the session-ending command forms `text` matches, in table order; empty when none does. */
export function sessionEndingCommandsIn(text: string): string[] {
  return SESSION_ENDING_COMMAND_FORMS.filter((form) => form.pattern.test(text)).map((form) => form.name)
}

/** The verb of a spawn, plain or with `--reuse-finished`. */
const SPAWN_VERB = 'spawn'

const ENDED = latchRowStateRead('ended')
const PENDING = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
const WAITING = latchRowStateRead('waiting')
const WORKING = latchRowStateRead('working')
const ASK_USER = latchRowStateRead('ask_user')
const CHECK_PERMISSION = latchRowStateRead('check_permission')

/** The readable label of each refused operation a row uses, for row names. */
const OPERATION_LABEL: Readonly<Partial<Record<RefusedOperation, string>>> = {
  [REFUSED_OPERATION_PLAIN_SPAWN]: 'plain spawn',
  [REFUSED_OPERATION_REUSE_SPAWN]: 'reuse spawn',
  [REFUSED_OPERATION_RESUME]: 'resume',
}

function row(
  refusedOperation: RefusedOperation,
  verb: string,
  stubCase: ConflictCase,
  latchCase: ConflictLatchCase,
  rowState: LatchRowState,
  options: ConflictOptions = {},
): ConflictCaseRow {
  const variant = Object.keys(options).filter((key) => options[key as keyof ConflictOptions] === true)
  const label = OPERATION_LABEL[refusedOperation] ?? verb
  const sessionName = STUB_TMUX_SESSION_NAME
  const build = () => errTmuxSessionConflict(verb, stubCase, sessionName, options)
  return Object.freeze({
    name: `${label}: ${stubCase}${variant.length === 0 ? '' : ` (${variant.join(', ')})`}`,
    verb,
    stubCase,
    options,
    sessionName,
    build,
    latchCase,
    refusedOperation,
    rowState,
    notice: expectedConflictNotice({ latchCase, sessionName, description: build().errDescription }),
  })
}

const plainSpawn = (c: ConflictCase, l: ConflictLatchCase, s: LatchRowState, o?: ConflictOptions): ConflictCaseRow =>
  row(REFUSED_OPERATION_PLAIN_SPAWN, SPAWN_VERB, c, l, s, o)
const reuseSpawn = (c: ConflictCase, l: ConflictLatchCase, s: LatchRowState): ConflictCaseRow =>
  row(REFUSED_OPERATION_REUSE_SPAWN, SPAWN_VERB, c, l, s)
const resume = (c: ConflictCase, l: ConflictLatchCase, s: LatchRowState): ConflictCaseRow =>
  row(REFUSED_OPERATION_RESUME, 'resume', c, l, s)
const paneOrKill = (
  verb: string,
  c: ConflictCase,
  l: ConflictLatchCase,
  s: LatchRowState,
  o?: ConflictOptions,
): ConflictCaseRow => row(REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, verb, c, l, s, o)

/** Every CONFLICT latch row, for `test.each`. */
export const CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze([
  // A plain spawn: the pre-spawn scan's refusals (nothing written, no row).
  plainSpawn('scan-leftover', LATCH_CASE_LEFTOVER, LATCH_ROW_STATE_NO_ROW),
  plainSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, LATCH_ROW_STATE_NO_ROW, { scan: true }),
  // A plain spawn's "duplicate session" answers (the new row was ended).
  plainSpawn('duplicate-session-leftover', LATCH_CASE_LEFTOVER, ENDED),
  plainSpawn('no-valid-id', LATCH_CASE_NO_VALID_ID, ENDED),
  plainSpawn('different-id', LATCH_CASE_DIFFERENT_ID, ENDED, { plainSpawn: true }),
  plainSpawn('another-store', LATCH_CASE_ANOTHER_STORE, ENDED, { plainSpawn: true }),
  plainSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, ENDED),
  // A spawn with `--reuse-finished` of a finished row, and of an id with no
  // row (an ordinary fresh spawn, which the pre-spawn scan refuses).
  reuseSpawn('no-valid-id', LATCH_CASE_NO_VALID_ID, ENDED),
  reuseSpawn('different-id', LATCH_CASE_DIFFERENT_ID, ENDED),
  reuseSpawn('another-store', LATCH_CASE_ANOTHER_STORE, ENDED),
  reuseSpawn('own-id', LATCH_CASE_OWN_ID, ENDED),
  reuseSpawn('leftover', LATCH_CASE_LEFTOVER, ENDED),
  reuseSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, ENDED),
  reuseSpawn('scan-leftover', LATCH_CASE_LEFTOVER, LATCH_ROW_STATE_NO_ROW),
  // A `resume` on the finished-row path; unrecognised text where the path
  // could not read the row's state.
  resume('no-valid-id', LATCH_CASE_NO_VALID_ID, ENDED),
  resume('different-id', LATCH_CASE_DIFFERENT_ID, ENDED),
  resume('another-store', LATCH_CASE_ANOTHER_STORE, ENDED),
  resume('own-id', LATCH_CASE_OWN_ID, ENDED),
  resume('leftover', LATCH_CASE_LEFTOVER, ENDED),
  resume('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, ENDED),
  resume('unrecognised', LATCH_CASE_UNRECOGNISED, LATCH_ROW_STATE_UNREADABLE),
  // Pane verbs and kills: P's next check or recovery, the state last read.
  paneOrKill('kill', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, WAITING),
  paneOrKill('send-keys', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, WORKING),
  paneOrKill('pause', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, CHECK_PERMISSION),
  paneOrKill('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, WAITING),
  paneOrKill('send-keys', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, ASK_USER),
  paneOrKill('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, PENDING, { notAdopted: true }),
  paneOrKill('read-pane', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, PENDING),
  paneOrKill('kill', 'never-reported-in', LATCH_CASE_NEVER_REPORTED_IN, PENDING),
  paneOrKill('kill', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, WORKING),
])

// ---------------------------------------------------------------------------
// The unusable recorded name (b.jg5 SRJ-512, SRJ-1019)
// ---------------------------------------------------------------------------

/** A verb site kind E16 T1 wires for an UNUSABLE NAME answer. */
export type UnusableNameSite =
  | 'resume'
  | 'plain spawn'
  | 'ladder kill'
  | 'ladder delete'
  | 'read-pane'
  | 'status'
  | 'get'

/** The agent-director verb each site kind calls. */
const UNUSABLE_NAME_SITE_VERB: Readonly<Record<UnusableNameSite, string>> = Object.freeze({
  'resume': 'resume',
  'plain spawn': SPAWN_VERB,
  'ladder kill': 'kill',
  'ladder delete': 'delete',
  'read-pane': 'read-pane',
  'status': 'status',
  'get': 'get',
})

/** Every site kind of {@link UnusableNameSite}, in row order. */
export const UNUSABLE_NAME_SITES: readonly UnusableNameSite[] = Object.freeze(
  Object.keys(UNUSABLE_NAME_SITE_VERB) as UnusableNameSite[],
)

/** One UNUSABLE NAME answer at one site kind and what latching a persona on it records and posts. */
export interface UnusableNameCaseRow {
  /** Readable row name for `test.each`: `<site>: <fault>`. */
  readonly name: string
  /** The verb site kind that meets the answer. */
  readonly site: UnusableNameSite
  /** The agent-director verb that answers. */
  readonly verb: string
  /** The stub's recorded-name fault. */
  readonly fault: UnusableNameFault
  /** Builds the error through the stub's `errUnusableName(fault)`. */
  readonly build: () => ReturnType<typeof errUnusableName>
  /** "unusable recorded name". */
  readonly latchCase: typeof LATCH_CASE_UNUSABLE_RECORDED_NAME
  /** "none": the re-check reads only `status`. */
  readonly refusedOperation: typeof REFUSED_OPERATION_NONE
  /** The row state the latch records on this path. */
  readonly rowState: LatchRowState
  /** True when `rowState` comes from the one latch-time `status` read (the path read nothing before its call). */
  readonly latchTimeRead: boolean
  /** The classification's message (redacted, one line, capped): the record's description. */
  readonly description: string
  /** The session the record holds for persona `key`. */
  readonly sessionName: (key: string) => string
  /** The SRJ-1019 notice body for persona `key` (the persona notifier adds the prefix). */
  readonly notice: (key: string) => string
}

/** The state each non-read site kind's path last read before its call (see the header). */
const UNUSABLE_NAME_LAST_READ: Readonly<Record<UnusableNameSite, LatchRowState>> = Object.freeze({
  'resume': ENDED,
  'plain spawn': LATCH_ROW_STATE_NO_ROW,
  'ladder kill': ENDED,
  'ladder delete': ENDED,
  'read-pane': WORKING,
  'status': LATCH_ROW_STATE_UNREADABLE,
  'get': LATCH_ROW_STATE_UNREADABLE,
})

function unusableNameRow(site: UnusableNameSite, fault: UnusableNameFault): UnusableNameCaseRow {
  const build = () => errUnusableName(fault)
  const message = classifyAdError(build()).message
  if (message === undefined) throw new Error(`conflict-cases: errUnusableName('${fault}') has no classification message`)
  return Object.freeze({
    name: `${site}: ${fault}`,
    site,
    verb: UNUSABLE_NAME_SITE_VERB[site],
    fault,
    build,
    latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState: UNUSABLE_NAME_LAST_READ[site],
    latchTimeRead: site === 'plain spawn',
    description: message,
    sessionName: (key: string) => personaTmuxSessionName(key),
    notice: (key: string) => unusableNameNoticeText(key, message),
  })
}

/** Every UNUSABLE NAME row: each fault of `UNUSABLE_NAME_FAULTS` at each site kind, for `test.each`. */
export const UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_SITES.flatMap((site) => UNUSABLE_NAME_FAULTS.map((fault) => unusableNameRow(site, fault))),
)

// ---------------------------------------------------------------------------
// The tmux-touching verbs (HO C24; ADSRD SR-1.4; b.jg5 SRJ-502)
// ---------------------------------------------------------------------------

/** One tmux-touching verb and the stub call-log list that records its calls. */
export interface TmuxTouchingStubVerb {
  readonly verb: string
  readonly log: keyof StubCallLog
}

/**
 * The agent-director verbs that touch tmux, with the stub's call-log list of
 * each: `resume`, `spawn` in both forms (plain and `--reuse-finished`, both
 * in `spawnCalls`), `read-pane`, `send-keys`, `kill` and `pause`. HO C24
 * says no tmux-touching call is made for an unusable recorded name, and
 * ADSRD SR-1.4 is where agent-director names these verbs as the ones that
 * reach tmux; a `kill` counts here whatever row it was declared for, so a
 * test's "no tmux-touching call" check is never weaker than SRJ-502's.
 */
export const TMUX_TOUCHING_STUB_VERBS: readonly TmuxTouchingStubVerb[] = Object.freeze([
  Object.freeze({ verb: 'resume', log: 'resumeCalls' }),
  Object.freeze({ verb: SPAWN_VERB, log: 'spawnCalls' }),
  Object.freeze({ verb: 'read-pane', log: 'readPaneCalls' }),
  Object.freeze({ verb: 'send-keys', log: 'sendKeysCalls' }),
  Object.freeze({ verb: 'kill', log: 'killCalls' }),
  Object.freeze({ verb: 'pause', log: 'pauseCalls' }),
] as const)

/** One tmux-touching call a stub log recorded: its verb and the params it was given. */
export interface TmuxTouchingCall {
  readonly verb: string
  readonly params: unknown
}

/**
 * The tmux-touching calls `log` recorded, verb by verb in
 * {@link TMUX_TOUCHING_STUB_VERBS}' order (each verb's calls in call order);
 * empty when there is none. Pass `from`, the log's lengths taken earlier with
 * {@link tmuxTouchingCallCounts}, to get only the calls made since.
 */
export function tmuxTouchingCallsIn(
  log: StubCallLog,
  from?: Readonly<Partial<Record<keyof StubCallLog, number>>>,
): TmuxTouchingCall[] {
  return TMUX_TOUCHING_STUB_VERBS.flatMap(({ verb, log: list }) =>
    (log[list] as readonly unknown[]).slice(from?.[list] ?? 0).map((params) => ({ verb, params })),
  )
}

/** How many calls each tmux-touching verb's list in `log` holds now, for {@link tmuxTouchingCallsIn}'s `from`. */
export function tmuxTouchingCallCounts(log: StubCallLog): Partial<Record<keyof StubCallLog, number>> {
  return Object.fromEntries(
    TMUX_TOUCHING_STUB_VERBS.map(({ log: list }) => [list, (log[list] as readonly unknown[]).length]),
  )
}
