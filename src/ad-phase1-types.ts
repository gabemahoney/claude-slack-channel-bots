/**
 * ad-phase1-types.ts — CSCB-side declarations of the Phase 1 agent-director
 * result and parameter fields, for a client that does not declare them
 * (b.jg5 SRJ-1303).
 *
 * Type-only: this module has no runtime code and imports nothing but the
 * installed client's own result and parameter types, as types. Each type
 * here is the client's own type plus CSCB's declaration of every Phase 1
 * field that type lacks ({@link WithFieldsTheClientLacks}): where the
 * installed client declares a field, its own declaration is the one in
 * force and CSCB's is dropped, so the module compiles against the 0.10.0
 * client, which lacks these fields, and against the Phase 1 client, which
 * declares them (some of them required), with no field redeclared over the
 * client's own. The test stub (`tests/test-helpers/agent-director-stub.ts`)
 * types its canned results with these types, and so do the readers of these
 * fields. Once the package pins the Phase 1 client, its own types replace
 * this module's declarations (b.jg5 SRJ-101).
 *
 * The fields:
 *   - `kill_sent` on a `kill` result: whether agent-director sent a kill.
 *     Absent from a result of a binary older than Phase 1 (b.jg5 SRJ-110);
 *     the Phase 1 client declares it required.
 *   - `launch_started_at` on `status`, `get` and `list` rows: the launch start,
 *     shown on `pending` rows only, as an RFC 3339 UTC timestamp with
 *     millisecond precision whose fractional seconds are shown only when they
 *     are not zero (ADSRD SR-22.2; b.jg5 SRJ-406).
 *   - `liveness_note` on `get` and `list` rows. Every client declares it, as
 *     free text (`string | null`), and the rows here keep that type, since
 *     agent-director has notes CSCB does not tell apart. The notes CSCB tells
 *     apart are the `LivenessNote` values.
 *   - `pre_trust` on a spawn (plain or reuse) or `resume` result: `ok`,
 *     `skipped` or `failed`, which CSCB only logs. Absent from a result of a
 *     binary older than Phase 1 (b.jg5 SRJ-413); the Phase 1 client declares
 *     it required.
 *   - `reuse_finished` on a spawn's parameters: the reuse spawn's flag (b.jg5
 *     SRJ-112, SRJ-708), agent-director's `--reuse-finished`. The Phase 1
 *     client declares it on its own `SpawnParams` and emits `--reuse-finished`
 *     for `reuse_finished: true` (its spawn flag builder,
 *     `pkg/ts-bun-client/src/internal/argv.ts` at agent-director commit
 *     `d787cb4`, as packed in the release candidate's client); the
 *     0.10.0 client neither declares nor emits it, so a spawn made through
 *     that client never carries the flag. The test stub records the
 *     parameters as given.
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

/**
 * The client's own type `ClientType` plus every field of `Phase1Fields` that
 * `ClientType` does not declare. A field the installed client declares keeps
 * the client's own declaration (required or optional, with its own type);
 * CSCB's declaration of it is dropped. So no field is redeclared over the
 * client's, whichever client is installed.
 */
export type WithFieldsTheClientLacks<ClientType, Phase1Fields> = ClientType & Omit<Phase1Fields, keyof ClientType>

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

/**
 * A `kill` result. `kill_sent` is absent from a binary older than Phase 1
 * (CSCB's optional declaration, where the client lacks the field).
 */
export type Phase1KillResult = WithFieldsTheClientLacks<KillResult, { kill_sent?: boolean }>

/** A `status` result. `launch_started_at` is present on a `pending` row only. */
export type Phase1StatusResult = WithFieldsTheClientLacks<StatusResult, { launch_started_at?: string | null }>

/**
 * A `get` result. `launch_started_at` is present on a `pending` row only;
 * `liveness_note` is the client's own field.
 */
export type Phase1GetResult = WithFieldsTheClientLacks<GetResult, { launch_started_at?: string | null }>

/**
 * One `list` row. `launch_started_at` is present on a `pending` row only;
 * `liveness_note` is the client's own field.
 */
export type Phase1ListRow = WithFieldsTheClientLacks<ListRow, { launch_started_at?: string | null }>

/** A `list` result whose rows carry the Phase 1 fields. */
export interface Phase1ListResult extends ListResult {
  spawns: Phase1ListRow[]
}

/**
 * A spawn result (plain or reuse). `pre_trust` is absent from a binary older
 * than Phase 1 (CSCB's optional declaration, where the client lacks the field).
 */
export type Phase1SpawnResult = WithFieldsTheClientLacks<SpawnResult, { pre_trust?: PreTrust }>

/**
 * A `resume` result. `pre_trust` is absent from a binary older than Phase 1
 * (CSCB's optional declaration, where the client lacks the field).
 */
export type Phase1ResumeResult = WithFieldsTheClientLacks<ResumeResult, { pre_trust?: PreTrust }>

// ---------------------------------------------------------------------------
// Parameters carrying the Phase 1 fields
// ---------------------------------------------------------------------------

/**
 * A spawn's parameters with the reuse flag (b.jg5 SRJ-112, SRJ-708).
 * `reuse_finished: true` asks agent-director to spawn the same fixed id over
 * its finished row, resetting that row for a new life and keeping it as an
 * earlier life, instead of answering `ErrInstanceIdCollision`; for an id with
 * no row it is an ordinary fresh spawn. Absent on every plain spawn. The
 * field is the client's own `SpawnParams.reuse_finished` where the client
 * declares it (the Phase 1 client, which emits `--reuse-finished` for it),
 * else CSCB's declaration (the 0.10.0 client, which neither declares nor
 * emits it).
 */
export type Phase1SpawnParams = WithFieldsTheClientLacks<SpawnParams, { reuse_finished?: boolean }>
