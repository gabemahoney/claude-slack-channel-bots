/**
 * row-read-rules.ts — The pure decisions over one read of a persona's own
 * agent-director row (b.jg5 SRJ-114, SRJ-115, SRJ-116, SRJ-513, SRJ-807).
 *
 * The rule has two latch decisions, asked of every read the server makes at
 * SRJ-114's and SRJ-115's sites of a configured persona's own row (the row
 * `cscb_<key>` of a persona in the applied configuration). A row that is not
 * a configured persona's own (another caller's id, a pre-persona id, or the
 * `cscb_<key>` row of a key outside the applied configuration) gets neither
 * (C14, C24; SRJ-408).
 *
 *   1. "launch start not recorded" (SRJ-513): the row reads `pending` with
 *      no launch start (`isPendingWithNoLaunchStart`, `src/pending-row.ts`:
 *      absent, `null` or unparseable). It latches persona P with that case,
 *      the refused operation "none" and the recorded state `pending`,
 *      whether or not the row is P's current life (a retired key's old life,
 *      whatever its retired mark, and a `cwd` or `config_dir` mismatch
 *      included), and whether or not it carries a note: a row that also
 *      carries `provenance_conflict` answers this decision only.
 *   2. "conflicting labels" (SRJ-114): the row's `liveness_note` reads
 *      exactly `provenance_conflict` ({@link LATCHING_LIVENESS_NOTE}). It
 *      latches P with that case and the refused operation "P's bring-up by
 *      the restart path's decision", recording the row's state as that read
 *      gave it (b.jg5 SRJ-501). No other note latches (`tmux_server_changed`,
 *      `process_not_seen_*`, `probe_eacces`, `tmux_session_name_*`, and any
 *      note CSCB does not know). Matching is exact equality with the
 *      constant: no prefix, substring or case-folded match.
 *
 * Beside them, one entry-clear decision (SRJ-807): the own row `cscb_<key>`
 * of a key the caller says is recorded as retired with its "new life has
 * begun" mark set, read in a live state other than `pending`
 * ({@link RETIRED_ENTRY_CLEARING_STATES}: `waiting`, `working`, `ask_user`,
 * `check_permission`), clears the key's entry from the retired-key record
 * (`src/retired-keys.ts`). It applies to any key's own row, configured or
 * not, and it is independent of the latch decisions: a live row carrying
 * the latching note with the mark set answers both the latch and the clear.
 * It never answers on `pending` (with or without a launch start), `ended`,
 * `missing` or a state CSCB does not know, on a key with no mark or not
 * recorded, or on another key's row.
 *
 * {@link decideOwnRowRead} answers these decisions for one read; it latches
 * and clears nothing itself. It takes a `get` row, a `list` row or a `status`
 * result ({@link RowReadRow}); a `status` result is P's own row by the
 * address the read used, so its caller gives it the id `cscb_<key>`. The
 * session manager's shared own-row read (`readPersonaOwnRow`,
 * `src/session-manager.ts`) makes the `get`, asks this module on every row it
 * reads, latches through the server's latch on a latch decision and clears
 * through the server's retired-key store on a clear decision; its sites are
 * the collision `get` of `runPersonaLadder`, `diagnoseJsonlMissing`,
 * `readPersonaTranscript`, the `get` after `unverified_ids` and every other
 * own-row `get` the session manager makes. The session manager's own-row
 * `status` step (`applyOwnRowStatusStep`) asks it of every `status` result,
 * whoever made the call (the shared own-row `status` read, and the liveness
 * and reconnect adapters in `src/server.ts`, so the health tick, the restart
 * path, the re-probe and the lost-message read too), and acts on both kinds
 * of decision the same way. The persona teardown kill's `status` read
 * between its tries (`readTeardownKillRow`) asks only the entry clear
 * ({@link decideRetiredEntryClear}) and acts on it, latching nothing
 * (SRJ-715, SRJ-115). None of the decisions applies at the permission
 * poller's `list` and `get` or at the JSONL persistence safeguard's `get`,
 * which are not SRJ-114's sites (b.jg5 SRJ-122).
 *
 * A `list` row (the start sweep's, SRJ-116) has the same shape
 * ({@link RowReadRow}), so the decisions, the clear included, answer for a
 * listed own row as for a `get` row. The CLI precheck (SRJ-901) latches
 * nothing and never acts on a clear decision: the CLI installs no store and
 * never writes the retired-key record (SRJ-801).
 *
 * Pure: no module-scope state, no timer, no agent-director call, no log line,
 * nothing run at import. No label option name is spelled here (b.jg5
 * SRJ-716), and nothing names an export only the Phase 1 client has.
 *
 * SPDX-License-Identifier: MIT
 */

import type { LivenessNote, Phase1StatusResult } from './ad-phase1-types.ts'
import {
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NONE,
  latchRowStateRead,
  type LatchCase,
  type LatchRowState,
  type RefusedOperation,
} from './conflict-latch.ts'
import { AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
import { isPendingWithNoLaunchStart } from './pending-row.ts'
import { personaInstanceId } from './persona-identity.ts'

/**
 * The one liveness note that latches a persona (b.jg5 SRJ-114, SRJ-501):
 * two sessions carry the launch's label, or a label value is set at the
 * server, global or global-window scope.
 */
export const LATCHING_LIVENESS_NOTE = 'provenance_conflict' as const satisfies LivenessNote

/** A row state as the client types it. */
export type RowReadState = Phase1StatusResult['state']

/**
 * The row states that clear a retired key's entry when its mark is set
 * (b.jg5 SRJ-807): the live states other than `pending`
 * (`AGENT_DIRECTOR_LIVE_STATES` less `AGENT_DIRECTOR_PENDING_STATE`), that is
 * `waiting`, `working`, `ask_user` and `check_permission`.
 */
export const RETIRED_ENTRY_CLEARING_STATES: ReadonlySet<RowReadState> = new Set<RowReadState>(
  [...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE),
)

/**
 * What the decision reads of a row: the fields a `get` result, a `list` row
 * and a `status` result (given P's own id by its caller) carry.
 * `liveness_note` is the 0.10.0 client's free text, absent from a `status`
 * result; `launch_started_at` is the raw launch start, shown on `pending`
 * rows only (`src/ad-phase1-types.ts`).
 */
export interface RowReadRow {
  readonly claude_instance_id: string
  readonly state: string
  readonly liveness_note?: string | null
  readonly launch_started_at?: string | null
}

/** One read of persona `key`'s own row. */
export interface OwnRowReadInput {
  /** The persona key the read addressed (its own row is `cscb_<key>`). */
  readonly key: string
  /** The row as the client returned it. */
  readonly row: RowReadRow
  /** Whether `key` is a persona of the applied configuration now. */
  readonly configured: boolean
  /**
   * Whether `key` is recorded as retired with its "new life has begun" mark
   * set (b.jg5 SRJ-806, SRJ-807), as the caller's retired-key store answers.
   * Absent counts as false: no clear decision.
   */
  readonly retiredMarked?: boolean
}

/** A decision to latch the persona: the latch record's case, refused operation and row state (b.jg5 SRJ-501). */
export interface RowReadLatchDecision {
  readonly latchCase: LatchCase
  readonly refusedOperation: RefusedOperation
  readonly rowState: LatchRowState
}

/**
 * A decision to clear the read key's entry from the retired-key record
 * (b.jg5 SRJ-807), with the live state the read gave.
 */
export interface RowReadClearDecision {
  readonly stateRead: RowReadState
}

/**
 * What one read decides. Every field is optional: an empty decision
 * ({@link ROW_READ_NO_DECISION}) changes nothing. `latch` and
 * `clearRetiredEntry` are independent: one read may answer both.
 */
export interface RowReadDecision {
  /** Set when the read latches the persona. */
  readonly latch?: RowReadLatchDecision
  /** Set when the read clears the key's retired-key entry (b.jg5 SRJ-807). */
  readonly clearRetiredEntry?: RowReadClearDecision
}

/** The decision that changes nothing. */
export const ROW_READ_NO_DECISION: RowReadDecision = Object.freeze({})

/**
 * The launch-start decision (b.jg5 SRJ-513): latch with the case "launch
 * start not recorded", the refused operation "none" and the recorded state
 * `pending`.
 */
export const ROW_READ_LAUNCH_START_NOT_RECORDED: RowReadDecision = Object.freeze({
  latch: Object.freeze({
    latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState: latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
  }),
})

/** True when `note` is exactly {@link LATCHING_LIVENESS_NOTE}. Pure. */
export function isLatchingLivenessNote(note: unknown): boolean {
  return note === LATCHING_LIVENESS_NOTE
}

/** True when `row` is persona `key`'s own row: its id is exactly `cscb_<key>`. Pure. */
export function isPersonaOwnRow(row: Pick<RowReadRow, 'claude_instance_id'>, key: string): boolean {
  return row.claude_instance_id === personaInstanceId(key)
}

/**
 * The entry-clear decision over one read of key `key`'s row (b.jg5 SRJ-807):
 * set when the row is `key`'s own, it reads one of
 * {@link RETIRED_ENTRY_CLEARING_STATES}, and `retiredMarked` is exactly true;
 * undefined otherwise. Whether `key` is configured plays no part. Pure.
 */
export function decideRetiredEntryClear(input: OwnRowReadInput): RowReadClearDecision | undefined {
  const { key, row, retiredMarked } = input
  if (retiredMarked !== true || !isPersonaOwnRow(row, key)) return undefined
  if (!RETIRED_ENTRY_CLEARING_STATES.has(row.state)) return undefined
  return Object.freeze({ stateRead: row.state })
}

/** The latch decision over one read of persona `key`'s row, or undefined (`decideOwnRowRead`'s steps 1 and 2). Pure. */
function decideOwnRowLatch(input: OwnRowReadInput): RowReadLatchDecision | undefined {
  const { key, row, configured } = input
  if (!configured || !isPersonaOwnRow(row, key)) return undefined
  if (isPendingWithNoLaunchStart(row)) return ROW_READ_LAUNCH_START_NOT_RECORDED.latch
  if (!isLatchingLivenessNote(row.liveness_note)) return undefined
  return Object.freeze({
    latchCase: LATCH_CASE_CONFLICTING_LABELS,
    refusedOperation: REFUSED_OPERATION_BRING_UP,
    rowState: latchRowStateRead(row.state),
  })
}

/**
 * The rule's decisions over one read of key `key`'s row;
 * {@link ROW_READ_NO_DECISION} when none holds.
 *
 * The latch, when `key` is configured and the row is its own; in order, the
 * first that holds deciding:
 *
 *   1. the row reads `pending` with no launch start
 *      (`isPendingWithNoLaunchStart`): {@link ROW_READ_LAUNCH_START_NOT_RECORDED}
 *      (b.jg5 SRJ-513), also for a row that carries the latching note and
 *      whatever the key's retired mark;
 *   2. the row carries exactly the latching note: a latch decision with the
 *      case "conflicting labels", the refused operation "P's bring-up" and
 *      the row's state as read (`latchRowStateRead`; a `waiting` row's state
 *      is a live state) (b.jg5 SRJ-114).
 *
 * The entry clear, independently of the latch and of whether `key` is
 * configured ({@link decideRetiredEntryClear}, b.jg5 SRJ-807): the row is
 * `key`'s own, reads a live state other than `pending`, and the key is
 * recorded with its mark set. A read with no clear answers the latch
 * decision alone: {@link ROW_READ_NO_DECISION} with no latch,
 * {@link ROW_READ_LAUNCH_START_NOT_RECORDED} for step 1 (which never comes
 * with a clear), and a frozen `{ latch }` for step 2.
 *
 * Pure; never throws.
 */
export function decideOwnRowRead(input: OwnRowReadInput): RowReadDecision {
  const latch = decideOwnRowLatch(input)
  const clearRetiredEntry = decideRetiredEntryClear(input)
  if (clearRetiredEntry === undefined) {
    if (latch === undefined) return ROW_READ_NO_DECISION
    return latch === ROW_READ_LAUNCH_START_NOT_RECORDED.latch ? ROW_READ_LAUNCH_START_NOT_RECORDED : Object.freeze({ latch })
  }
  return latch === undefined ? Object.freeze({ clearRetiredEntry }) : Object.freeze({ latch, clearRetiredEntry })
}
