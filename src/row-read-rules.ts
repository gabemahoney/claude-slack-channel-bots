/**
 * row-read-rules.ts — The pure decisions over one read of a persona's own
 * agent-director row (b.jg5 SRJ-114, SRJ-115, SRJ-513).
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
 *      whether or not the row is P's current life (a `cwd` or `config_dir`
 *      mismatch included), and whether or not it carries a note: a row that
 *      also carries `provenance_conflict` answers this decision only.
 *   2. "conflicting labels" (SRJ-114): the row's `liveness_note` reads
 *      exactly `provenance_conflict` ({@link LATCHING_LIVENESS_NOTE}). It
 *      latches P with that case and the refused operation "P's bring-up by
 *      the restart path's decision", recording the row's state as that read
 *      gave it (b.jg5 SRJ-501). No other note latches (`tmux_server_changed`,
 *      `process_not_seen_*`, `probe_eacces`, `tmux_session_name_*`, and any
 *      note CSCB does not know). Matching is exact equality with the
 *      constant: no prefix, substring or case-folded match.
 *
 * {@link decideOwnRowRead} answers that decision for one read; it latches
 * nothing itself. It takes a `get` row, a `list` row or a `status` result
 * ({@link RowReadRow}); a `status` result is P's own row by the address the
 * read used, so its caller gives it the id `cscb_<key>`. The session
 * manager's shared own-row read (`readPersonaOwnRow`, `src/session-manager.ts`)
 * makes the `get`, asks this module on every row it reads, and latches
 * through the server's latch on a latch decision; its sites are the
 * collision `get` of `runPersonaLadder`, `diagnoseJsonlMissing`,
 * `readPersonaTranscript` and the `get` after `unverified_ids`. The
 * session manager's own-row `status` step (`applyOwnRowStatusStep`) asks it
 * of every `status` result, whoever made the call (the shared own-row
 * `status` read, and the liveness and reconnect adapters in `src/server.ts`).
 * Neither decision applies at the permission poller's `list` and `get` or
 * at the JSONL persistence safeguard's `get`, which are not SRJ-114's sites
 * (b.jg5 SRJ-122).
 *
 * Where later work plugs in: the decision's result ({@link RowReadDecision})
 * carries an optional latch, so an entry-clear decision (a retired key's
 * row, SRJ-807) adds a field beside it with no change to the sites that read
 * through the shared reads; the start sweep's `list` rows (SRJ-116, E26) are
 * rows of the same shape ({@link RowReadRow}); and the CLI precheck (SRJ-901)
 * may read a row with this decision and latch nothing.
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
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NONE,
  latchRowStateRead,
  type LatchCase,
  type LatchRowState,
  type RefusedOperation,
} from './conflict-latch.ts'
import { AGENT_DIRECTOR_PENDING_STATE } from './liveness-reading.ts'
import { isPendingWithNoLaunchStart } from './pending-row.ts'
import { personaInstanceId } from './persona-identity.ts'

/**
 * The one liveness note that latches a persona (b.jg5 SRJ-114, SRJ-501):
 * two sessions carry the launch's label, or a label value is set at the
 * server, global or global-window scope.
 */
export const LATCHING_LIVENESS_NOTE = 'provenance_conflict' as const satisfies LivenessNote

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
 * The rule's decision over one read of persona `key`'s row, when `key` is
 * configured and the row is its own; {@link ROW_READ_NO_DECISION} for every
 * other read. In order, the first that holds deciding:
 *
 *   1. the row reads `pending` with no launch start
 *      (`isPendingWithNoLaunchStart`): {@link ROW_READ_LAUNCH_START_NOT_RECORDED}
 *      (b.jg5 SRJ-513), also for a row that carries the latching note;
 *   2. the row carries exactly the latching note: a latch decision with the
 *      case "conflicting labels", the refused operation "P's bring-up" and
 *      the row's state as read (`latchRowStateRead`; a `waiting` row's state
 *      is a live state) (b.jg5 SRJ-114).
 *
 * Pure; never throws.
 */
export function decideOwnRowRead(input: OwnRowReadInput): RowReadDecision {
  const { key, row, configured } = input
  if (!configured || !isPersonaOwnRow(row, key)) return ROW_READ_NO_DECISION
  if (isPendingWithNoLaunchStart(row)) return ROW_READ_LAUNCH_START_NOT_RECORDED
  if (!isLatchingLivenessNote(row.liveness_note)) return ROW_READ_NO_DECISION
  return Object.freeze({
    latch: Object.freeze({
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: latchRowStateRead(row.state),
    }),
  })
}
