/**
 * ad-phase1-types.ts — The value types CSCB tells apart in two Phase 1
 * agent-director result fields (b.jg5 SRJ-114, SRJ-413).
 *
 * Type-only: this module has no runtime code and imports nothing but the
 * client's own result type, as a type. Every Phase 1 result and parameter
 * field (`kill_sent`, `launch_started_at`, `liveness_note`, `pre_trust`,
 * `reuse_finished`) is the client's own declaration, read through the
 * client's types (`KillResult`, `StatusResult`, `GetResult`, `ListRow`,
 * `SpawnResult`, `ResumeResult`, `SpawnParams`); this module declares no
 * field. `SpawnParams.reuse_finished` is the reuse spawn's flag (b.jg5
 * SRJ-112, SRJ-708), which the 0.11.0 client emits as `--reuse-finished` for
 * `reuse_finished: true` (its spawn flag builder,
 * `pkg/ts-bun-client/src/internal/argv.ts` at agent-director tag `v0.11.0`,
 * as read from its packed client).
 *
 * SPDX-License-Identifier: MIT
 */

import type { SpawnResult } from 'agent-director'

/**
 * The liveness notes CSCB tells apart. `provenance_conflict` latches a persona
 * with the case "conflicting labels" (b.jg5 SRJ-507); `tmux_server_changed`,
 * `process_not_seen_session_present` and `tmux_session_name_rewritten` must
 * never latch one. The client types `liveness_note` as free text
 * (`string | null`), since agent-director has notes CSCB does not tell apart.
 */
export type LivenessNote =
  | 'provenance_conflict'
  | 'tmux_server_changed'
  | 'process_not_seen_session_present'
  | 'tmux_session_name_rewritten'

/**
 * A launch's pre-trust outcome (`ok`, `skipped` or `failed`), as a spawn
 * (plain or reuse) or `resume` result reports it (b.jg5 SRJ-413): the
 * client's own `pre_trust` type.
 */
export type PreTrust = SpawnResult['pre_trust']
