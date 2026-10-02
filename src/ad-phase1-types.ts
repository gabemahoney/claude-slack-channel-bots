/**
 * ad-phase1-types.ts — CSCB-side declarations of the Phase 1 agent-director
 * result and parameter fields the branch's 0.10.0 client does not declare
 * (b.jg5 SRJ-1303).
 *
 * Type-only: this module has no runtime code and imports nothing but the
 * 0.10.0 client's own result and parameter types, as types. None of it is imported from
 * `agent-director`, whose 0.10.0 client lacks these fields. The test stub
 * (`tests/test-helpers/agent-director-stub.ts`) types its canned results with
 * the declarations here; later Epics' readers of these fields (E14, E17, E20,
 * E28) will take them from here too. Once the Phase 1 client is adopted, its
 * own types replace this module (b.jg5 E37).
 *
 * The fields:
 *   - `kill_sent` on a `kill` result: whether agent-director sent a kill.
 *     Absent from a result of a binary older than Phase 1 (b.jg5 SRJ-110).
 *   - `launch_started_at` on `status`, `get` and `list` rows: the launch start,
 *     shown on `pending` rows only, as an RFC 3339 UTC timestamp with
 *     millisecond precision whose fractional seconds are shown only when they
 *     are not zero (ADSRD SR-22.2; b.jg5 SRJ-406).
 *   - `liveness_note` on `get` and `list` rows. The 0.10.0 client already
 *     declares it, as free text (`string | null`), and the rows here keep that
 *     type, since agent-director has notes CSCB does not tell apart. The notes
 *     CSCB tells apart are the `LivenessNote` values.
 *   - `pre_trust` on a spawn (plain or reuse) or `resume` result: `ok`,
 *     `skipped` or `failed`, which CSCB only logs. Absent from a result of a
 *     binary older than Phase 1 (b.jg5 SRJ-413).
 *   - `reuse_finished` on a spawn's parameters: the reuse spawn's flag (b.jg5
 *     SRJ-112, SRJ-708). The 0.10.0 client's parameter type does not declare
 *     it and its flag builder does not emit it, so a spawn made through the
 *     0.10.0 client never carries `--reuse-finished`; the test stub records
 *     the parameters as given; agent-director's own flag for it is
 *     `--reuse-finished`.
 *
 * SPDX-License-Identifier: MIT
 */

import type {
  GetResult,
  KillResult,
  ListResult,
  ListRow,
  ResumeResult,
  SpawnParams,
  SpawnResult,
  StatusResult,
} from 'agent-director'

// ---------------------------------------------------------------------------
// Field values
// ---------------------------------------------------------------------------

/**
 * The liveness notes CSCB tells apart. `provenance_conflict` latches a persona
 * with the case "conflicting labels" (b.jg5 SRJ-507); `tmux_server_changed`,
 * `process_not_seen_session_present` and `tmux_session_name_rewritten` must
 * never latch one.
 */
export type LivenessNote =
  | 'provenance_conflict'
  | 'tmux_server_changed'
  | 'process_not_seen_session_present'
  | 'tmux_session_name_rewritten'

/** A launch's pre-trust outcome, as a spawn or `resume` result reports it (b.jg5 SRJ-413). */
export type PreTrust = 'ok' | 'skipped' | 'failed'

// ---------------------------------------------------------------------------
// Results carrying the Phase 1 fields
// ---------------------------------------------------------------------------

/** A `kill` result. `kill_sent` is absent from a binary older than Phase 1. */
export interface Phase1KillResult extends KillResult {
  kill_sent?: boolean
}

/** A `status` result. `launch_started_at` is present on a `pending` row only. */
export interface Phase1StatusResult extends StatusResult {
  launch_started_at?: string | null
}

/**
 * A `get` result. `launch_started_at` is present on a `pending` row only;
 * `liveness_note` is the 0.10.0 client's own field.
 */
export interface Phase1GetResult extends GetResult {
  launch_started_at?: string | null
}

/**
 * One `list` row. `launch_started_at` is present on a `pending` row only;
 * `liveness_note` is the 0.10.0 client's own field.
 */
export interface Phase1ListRow extends ListRow {
  launch_started_at?: string | null
}

/** A `list` result whose rows carry the Phase 1 fields. */
export interface Phase1ListResult extends ListResult {
  spawns: Phase1ListRow[]
}

/** A spawn result (plain or reuse). `pre_trust` is absent from a binary older than Phase 1. */
export interface Phase1SpawnResult extends SpawnResult {
  pre_trust?: PreTrust
}

/** A `resume` result. `pre_trust` is absent from a binary older than Phase 1. */
export interface Phase1ResumeResult extends ResumeResult {
  pre_trust?: PreTrust
}

// ---------------------------------------------------------------------------
// Parameters carrying the Phase 1 fields
// ---------------------------------------------------------------------------

/**
 * A spawn's parameters with the reuse flag (b.jg5 SRJ-112, SRJ-708).
 * `reuse_finished: true` asks agent-director to spawn the same fixed id over
 * its finished row, resetting that row for a new life and keeping it as an
 * earlier life, instead of answering `ErrInstanceIdCollision`; for an id with
 * no row it is an ordinary fresh spawn. Absent on every plain spawn. The
 * 0.10.0 client neither declares nor emits it.
 */
export interface Phase1SpawnParams extends SpawnParams {
  reuse_finished?: boolean
}
