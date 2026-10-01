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
 * Columns added later: E13's T2 adds the CONFLICT notice `src/conflict-latch.ts`
 * builds for the row (SRJ-1004); E14 adds the `provenance_conflict` note
 * latch's rows (P's bring-up, no builder call); E16 adds the "unusable
 * recorded name" and "launch start not recorded" rows; E30 adds the
 * re-check's action and its still-latched and cleared answers (SRJ-505),
 * with a plain-spawn row per row state step 1 can read.
 *
 * There is no "no pane 0.0" row: that case is withdrawn (rev 17; SRJ-507).
 *
 * No case word, notice text or session name is written here: the words reach
 * a row only through the stub, and the session name is the stub's
 * `STUB_TMUX_SESSION_NAME` (`personaTmuxSessionName`). No Phase-1-only export
 * is named, and no `mock.module()` is used.
 *
 * SPDX-License-Identifier: MIT
 */

import { AGENT_DIRECTOR_PENDING_STATE } from '../../src/liveness-reading.ts'
import {
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
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  latchRowStateRead,
  type ConflictLatchCase,
  type LatchRowState,
  type RefusedOperation,
} from '../../src/conflict-latch.ts'
import {
  STUB_TMUX_SESSION_NAME,
  errTmuxSessionConflict,
  type ConflictCase,
  type ConflictOptions,
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
  return Object.freeze({
    name: `${label}: ${stubCase}${variant.length === 0 ? '' : ` (${variant.join(', ')})`}`,
    verb,
    stubCase,
    options,
    sessionName,
    build: () => errTmuxSessionConflict(verb, stubCase, sessionName, options),
    latchCase,
    refusedOperation,
    rowState,
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
