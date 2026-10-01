/**
 * row-read-rules.ts — The pure decisions over one read of a persona's own
 * agent-director row (b.jg5 SRJ-114).
 *
 * SRJ-114's rule. On every read the server makes at SRJ-114's sites, a
 * configured persona's own row (the row `cscb_<key>` of a persona in the
 * applied configuration) whose `liveness_note` reads exactly
 * `provenance_conflict` ({@link LATCHING_LIVENESS_NOTE}) latches persona P
 * with the case "conflicting labels" and the refused operation "P's bring-up
 * by the restart path's decision", recording the row's state as that read
 * gave it (b.jg5 SRJ-501). No other note latches (`tmux_server_changed`,
 * `process_not_seen_*`, `probe_eacces`, `tmux_session_name_*`, and any note
 * CSCB does not know), and a note on a row that is not a configured persona's
 * own (another caller's id, or the `cscb_<key>` row of a key outside the
 * applied configuration) is ignored (C14, C24). Matching is exact equality
 * with the constant: no prefix, substring or case-folded match.
 *
 * {@link decideOwnRowRead} answers that decision for one row read; it latches
 * nothing itself. The session manager's shared own-row read
 * (`readPersonaOwnRow`, `src/session-manager.ts`) makes the `get`, asks this
 * module, and latches through the server's latch on a latch decision. Its
 * sites today are the collision `get` of `runPersonaLadder`,
 * `diagnoseJsonlMissing` and `readPersonaTranscript`. The permission poller's
 * `get` and the JSONL persistence safeguard's `get` are not SRJ-114's sites
 * and apply no rule of this module (b.jg5 SRJ-122).
 *
 * Where later work plugs in: the decision's result ({@link RowReadDecision})
 * carries an optional latch, so a second latch decision (a `pending` row with
 * no launch start, SRJ-513) answers through the same field with its own case,
 * and an entry-clear decision (a retired key's row, SRJ-807) adds a field
 * beside it, with no change to the sites that read through
 * `readPersonaOwnRow`, which asks this decision on every row it reads, with
 * or without a note; the start sweep's `list` rows
 * (SRJ-116) are rows of the same shape ({@link RowReadRow}); and the CLI
 * precheck (SRJ-901) may read a row with this decision and latch nothing.
 *
 * Pure: no module-scope state, no timer, no agent-director call, no log line,
 * nothing run at import. No label option name is spelled here (b.jg5
 * SRJ-716), and nothing names an export only the Phase 1 client has.
 *
 * SPDX-License-Identifier: MIT
 */

import type { LivenessNote } from './ad-phase1-types.ts'
import {
  LATCH_CASE_CONFLICTING_LABELS,
  REFUSED_OPERATION_BRING_UP,
  latchRowStateRead,
  type LatchCase,
  type LatchRowState,
  type RefusedOperation,
} from './conflict-latch.ts'
import { personaInstanceId } from './persona-identity.ts'

/**
 * The one liveness note that latches a persona (b.jg5 SRJ-114, SRJ-501):
 * two sessions carry the launch's label, or a label value is set at the
 * server, global or global-window scope.
 */
export const LATCHING_LIVENESS_NOTE = 'provenance_conflict' as const satisfies LivenessNote

/**
 * What the decision reads of a row: the fields a `get` result and a `list`
 * row both carry. `liveness_note` is the 0.10.0 client's free text.
 */
export interface RowReadRow {
  readonly claude_instance_id: string
  readonly state: string
  readonly liveness_note?: string | null
}

/** One read of persona `key`'s own row. */
export interface OwnRowReadInput {
  /** The persona key the read addressed (its own row is `cscb_<key>`). */
  readonly key: string
  /** The row as the client returned it. */
  readonly row: RowReadRow
  /** Whether `key` is a persona of the applied configuration now. */
  readonly configured: boolean
}

/** A decision to latch the persona: the latch record's case, refused operation and row state (b.jg5 SRJ-501). */
export interface RowReadLatchDecision {
  readonly latchCase: LatchCase
  readonly refusedOperation: RefusedOperation
  readonly rowState: LatchRowState
}

/**
 * What one read decides. Every field is optional: an empty decision
 * ({@link ROW_READ_NO_DECISION}) changes nothing.
 */
export interface RowReadDecision {
  /** Set when the read latches the persona. */
  readonly latch?: RowReadLatchDecision
}

/** The decision that changes nothing. */
export const ROW_READ_NO_DECISION: RowReadDecision = Object.freeze({})

/** True when `note` is exactly {@link LATCHING_LIVENESS_NOTE}. Pure. */
export function isLatchingLivenessNote(note: unknown): boolean {
  return note === LATCHING_LIVENESS_NOTE
}

/** True when `row` is persona `key`'s own row: its id is exactly `cscb_<key>`. Pure. */
export function isPersonaOwnRow(row: Pick<RowReadRow, 'claude_instance_id'>, key: string): boolean {
  return row.claude_instance_id === personaInstanceId(key)
}

/**
 * SRJ-114's decision over one read of persona `key`'s row: a latch decision
 * with the case "conflicting labels", the refused operation "P's bring-up"
 * and the row's state as read (`latchRowStateRead`; a `waiting` row's state
 * is a live state), when `key` is configured, the row is its own and the row
 * carries exactly the latching note; {@link ROW_READ_NO_DECISION} for every
 * other read. Pure; never throws.
 */
export function decideOwnRowRead(input: OwnRowReadInput): RowReadDecision {
  const { key, row, configured } = input
  if (!configured || !isPersonaOwnRow(row, key) || !isLatchingLivenessNote(row.liveness_note)) {
    return ROW_READ_NO_DECISION
  }
  return Object.freeze({
    latch: Object.freeze({
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: latchRowStateRead(row.state),
    }),
  })
}
