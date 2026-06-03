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
 * SPDX-License-Identifier: MIT
 */

export {
  AgentDirectorError,
  ErrClientClosed,
  ErrBunVersionTooOld,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
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
