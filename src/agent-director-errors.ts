/**
 * agent-director-errors.ts — Re-export of typed Err* subclasses CSCB references.
 *
 * Per SR-0.2 the integration must not parse error strings or exit codes; every
 * call site branches on `instanceof` against the typed classes below. This
 * module gives the rest of CSCB a single import surface and a single place to
 * keep the subset list in sync with SRD edits.
 *
 * Catalog (SR-0.2):
 *   - ErrBunVersionTooOld       (Client constructor / Bun version gate)
 *   - ErrSystemInstallNotFound  (Client.create / resolveSystemBinary — no `agent-director` on PATH or at ~/.agent-director)
 *   - ErrSystemInstallTooOld    (Client.create / resolveSystemBinary — system binary older than required minimum)
 *   - ErrSystemInstallUnreachable (Client.create / resolveSystemBinary — system binary present but not executable or fails --version)
 *   - ErrSystemInstallDisappeared (any verb / binary gone after valid construction — b.xht)
 *   - ErrTmuxNotAvailable       (spawn / tmux binary not found or not executable)
 *   - ErrCwdNotFound            (spawn / route cwd does not exist on disk)
 *   - ErrCwdNotADirectory       (spawn / route cwd path exists but is not a directory)
 *   - ErrInstanceIdCollision    (spawn / SR-1.4 idempotency)
 *   - ErrSpawnNotFound          (get / status / decide on missing row)
 *   - ErrNoSessionId            (resume / SR-1.3 fallthrough)
 *   - ErrJsonlMissing           (resume / SR-1.3 fallthrough)
 *   - ErrSpawnNotResumable      (resume / SR-1.3 collision-recovery)
 *   - ErrAlreadyDecided         (decide / SR-2.2 treated-as-success)
 *   - ErrNoOpenPermissionRequest (decide / poller race)
 *   - ErrRelayModeOff           (spawn / SR-1.2 abort)
 *   - ErrRelayModeInvalid       (spawn / SR-1.2 abort)
 *   - ErrTemplateMalformed      (makeTemplate / SR-3.2 fatal)
 *   - ErrTemplateExists         (makeTemplate; only relevant pre-overwrite)
 *   - ErrTemplateNotFound       (defensive — not raised by makeTemplate)
 *   - ErrTemplateNameUnsafe     (makeTemplate / SR-3.2 fatal)
 *   - ErrClientClosed           (post-close verb call; TS-only)
 *   - ErrCallTimeout            (any verb / per-call timeout exceeded)
 *
 * ErrPauseTimeout is intentionally omitted (SR-0.2): SR-11 Event 12 owns its
 * own pause timeout via CSCB-side polling and never relies on the library's
 * pause budget, so the class never reaches a CSCB handler.
 *
 * CSCB-synthetic subclasses (NOT emitted by the agent-director library — minted
 * inside CSCB and dispatched through the same instanceof-branching convention so
 * SR-0.2 holds for them too):
 *   - ErrSpawnCapReached        (restart backoff / consecutive-failure cap latch)
 *
 * SPDX-License-Identifier: MIT
 */

import { AgentDirectorError } from 'agent-director'

/**
 * CSCB-synthetic error — never emitted by the agent-director library. Minted by
 * the restart backoff cap path (server.ts onCapReached) when a channel hits the
 * consecutive session-launch failure cap and automatic restarts are suspended.
 * Branched on via `instanceof` in remediationHint (SR-0.2 — no string matching).
 */
export class ErrSpawnCapReached extends AgentDirectorError {
  constructor(description: string) {
    super('spawn', 'SpawnCapReached', description)
  }
}

export {
  AgentDirectorError,
  ErrClientClosed,
  ErrBunVersionTooOld,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
  ErrCallTimeout,
  ErrInstanceIdCollision,
  ErrSpawnNotFound,
  ErrNoSessionId,
  ErrJsonlMissing,
  ErrSpawnNotResumable,
  ErrAlreadyDecided,
  ErrNoOpenPermissionRequest,
  ErrRelayModeOff,
  ErrRelayModeInvalid,
  ErrTemplateMalformed,
  ErrTemplateExists,
  ErrTemplateNotFound,
  ErrTemplateNameUnsafe,
} from 'agent-director'
