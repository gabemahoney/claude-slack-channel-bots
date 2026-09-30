/**
 * agent-director-errors.ts — The one import surface for the agent-director
 * client's error classes CSCB references.
 *
 * An agent-director error's class (GONE, UNAVAILABLE, CONFLICT, UNUSABLE NAME,
 * CONFIG, ENVIRONMENT, LAUNCH FAILURE, STATE, DIRECTORY, UNCLASSIFIED) is
 * decided by the classifier in `src/ad-error-class.ts` (b.jg5 SRJ-104). No new
 * `instanceof` ladder decides a class; existing sites move to the classifier
 * as later Epics change them. This module re-exports the client's error
 * classes so the classifier, the rest of CSCB and the tests import them from
 * one place, and keeps the subset list in sync with SRD edits. Per SR-0.2 CSCB
 * never parses free-form error message text or exit codes, apart from matching
 * agent-director's fixed description words, which are kept in
 * `src/ad-description-phrases.ts`.
 *
 * Classes of the tmux-side and unknown-name errors (b.jg5 SRJ-103, SRJ-104):
 *   - ErrTmuxSendKeys           GONE
 *   - ErrTmuxCaptureFailed      GONE
 *   - ErrTmuxSessionCreate      LAUNCH FAILURE
 *   - ErrUnknownErrorName       decided by its `unknownName`: `ErrInternal` is
 *                               UNUSABLE NAME when its description carries "the
 *                               recorded tmux session name" and UNCLASSIFIED
 *                               otherwise; `ErrConfigMalformed` is CONFIG;
 *                               `ErrSchemaMismatch`, `ErrSchemaMigrationRequired`
 *                               and `ErrStoreOpen` are UNCLASSIFIED; any other
 *                               name is UNAVAILABLE
 *   - ErrTmuxKillFailed         UNAVAILABLE
 *   - ErrTmuxUnresponsive       UNAVAILABLE
 *   - ErrTmuxSessionConflict    CONFLICT
 *
 * The first four are re-exported below. The last three are recognised by name
 * (SRJ-101 interim rule), not imported, re-exported once the Phase 1 client is
 * adopted (E37): the branch's 0.10.0 client lacks them, and a named import or
 * re-export of a missing export fails every module that loads it. Their names
 * are exported below once, as plain strings. So are the three store-open
 * `unknownName`s (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`,
 * `ErrStoreOpen`), which no client declares as a class.
 *
 * Catalog (SR-0.2):
 *   - ErrBunVersionTooOld       (Client constructor / Bun version gate)
 *   - ErrSystemInstallNotFound  (Client.create / resolveSystemBinary — no `agent-director` on PATH or at ~/.agent-director)
 *   - ErrSystemInstallTooOld    (Client.create / resolveSystemBinary — system binary older than required minimum)
 *   - ErrSystemInstallUnreachable (Client.create / resolveSystemBinary — system binary present but not executable or fails --version)
 *   - ErrSystemInstallDisappeared (any verb / binary gone after valid construction — b.xht)
 *   - ErrTmuxNotAvailable       (spawn / tmux binary not found or not executable)
 *   - ErrTmuxSessionCreate      (spawn / tmux could not create the session)
 *   - ErrTmuxSendKeys           (send-keys / the tmux session is gone)
 *   - ErrTmuxCaptureFailed      (read-pane / the tmux session is gone)
 *   - ErrUnknownErrorName       (any verb / the binary reported an err_name the
 *                               client has no class for)
 *   - ErrCwdNotFound            (spawn / persona working directory does not exist on disk)
 *   - ErrCwdNotADirectory       (spawn / persona working directory exists but is not a directory)
 *   - ErrInstanceIdCollision    (spawn / SR-1.4 idempotency)
 *   - ErrSpawnNotFound          (get / status / decide on missing row)
 *   - ErrSpawnNotInteractive    (send-keys / the row is `ended` or `missing`, or
 *                               `pending` without allow_pending: reconnectMcp's
 *                               dead-session verdict, b.dup)
 *   - ErrSendKeysWhileRelayed   (send-keys / the row sits on a relayed permission
 *                               prompt; UNCLASSIFIED under SRJ-104: CSCB gives it
 *                               no handling)
 *   - ErrNoSessionId            (resume / SR-1.3 fallthrough)
 *   - ErrJsonlMissing           (resume / SR-1.3 fallthrough)
 *   - ErrJsonlNeverWritten      (resume / AD 0.10.0 — session never wrote a transcript, so nothing can be lost)
 *   - ErrSpawnNotResumable      (resume / SR-1.3 collision-recovery)
 *   - ErrAlreadyDecided         (decide / SR-2.2 treated-as-success)
 *   - ErrNoOpenPermissionRequest (decide / poller race)
 *   - ErrRelayModeOff           (spawn / SR-1.2 abort)
 *   - ErrRelayFallenBack       (decide / AD 0.10.0 — the request's relay window
 *                               elapsed, so Claude already fell back to asking at
 *                               the tmux pane; AD refuses to record a verdict that
 *                               nothing would read. The spawn stays alive.)
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
 * inside CSCB and branched on via `instanceof` so SR-0.2 holds for them too):
 *   - ErrSpawnCapReached        (restart backoff / consecutive-failure cap latch)
 *
 * SPDX-License-Identifier: MIT
 */

import { AgentDirectorError } from 'agent-director'

/**
 * CSCB-synthetic error — never emitted by the agent-director library. Minted by
 * the restart backoff cap path (`notifyRestartCapReached` in session-manager.ts,
 * called from restart.ts `onCapReached`) when a persona hits the consecutive
 * session-launch failure cap and automatic restarts are suspended.
 * Branched on via `instanceof` in remediationHint (SR-0.2 — no string matching).
 */
export class ErrSpawnCapReached extends AgentDirectorError {
  constructor(description: string) {
    super('spawn', 'SpawnCapReached', description)
  }
}

/**
 * Names of the three errors only the Phase 1 client declares (b.jg5 SRJ-101
 * interim rule, SRJ-103). They are plain strings: code recognises these errors
 * by their name and never imports the classes, which the branch's 0.10.0
 * client lacks. The startup catalogue check, the stub's by-name builders and
 * the classifier take the names from here. Re-exported as classes once the
 * Phase 1 client is adopted (E37).
 */
export const ERR_TMUX_KILL_FAILED_NAME = 'ErrTmuxKillFailed'
export const ERR_TMUX_UNRESPONSIVE_NAME = 'ErrTmuxUnresponsive'
export const ERR_TMUX_SESSION_CONFLICT_NAME = 'ErrTmuxSessionConflict'

/** The three Phase-1-only error names, in one list. */
export const PHASE1_ONLY_ERR_NAMES = [
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
] as const

/** One of the three Phase-1-only error names. */
export type Phase1OnlyErrName = (typeof PHASE1_ONLY_ERR_NAMES)[number]

/**
 * `unknownName`s of the three errors agent-director's CLI answers when it
 * cannot open its store (b.jg5 SRJ-104, A-32, Q-15): a schema the binary does
 * not match or a missing or malformed store id (`ErrSchemaMismatch`), a store
 * that still needs the install script's migration
 * (`ErrSchemaMigrationRequired`), and a store it cannot open at all
 * (`ErrStoreOpen`). They are outside agent-director's error catalogue, so
 * every client, the Phase 1 client included, delivers them as
 * `ErrUnknownErrorName`; the classifier recognises them by that name and
 * answers UNCLASSIFIED. No client declares a class of these names, so they are
 * not in `PHASE1_ONLY_ERR_NAMES`, whose names the startup gate requires as
 * classes in the client.
 */
export const ERR_SCHEMA_MISMATCH_NAME = 'ErrSchemaMismatch'
export const ERR_SCHEMA_MIGRATION_REQUIRED_NAME = 'ErrSchemaMigrationRequired'
export const ERR_STORE_OPEN_NAME = 'ErrStoreOpen'

/**
 * `errName` of the error agent-director answers when no row has the instance
 * id (`get`, `status`, `decide` and the other single-row verbs). Every client
 * declares its class; the name is kept here for the sites that tell one
 * agent-director error from another by name (`hasAdErrorName` in
 * `src/ad-error-class.ts`).
 */
export const ERR_SPAWN_NOT_FOUND_NAME = 'ErrSpawnNotFound'

/** The three store-open error names, in one list. */
export const STORE_OPEN_ERR_NAMES = [
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_SCHEMA_MIGRATION_REQUIRED_NAME,
  ERR_STORE_OPEN_NAME,
] as const

export {
  AgentDirectorError,
  ErrClientClosed,
  ErrBunVersionTooOld,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
  ErrSystemInstallDisappeared,
  ErrTmuxNotAvailable,
  ErrTmuxSessionCreate,
  ErrTmuxSendKeys,
  ErrTmuxCaptureFailed,
  ErrUnknownErrorName,
  ErrCwdNotFound,
  ErrCwdNotADirectory,
  ErrCallTimeout,
  ErrInstanceIdCollision,
  ErrSpawnNotFound,
  ErrSpawnNotInteractive,
  ErrSendKeysWhileRelayed,
  ErrNoSessionId,
  ErrJsonlMissing,
  ErrJsonlNeverWritten,
  ErrSpawnNotResumable,
  ErrAlreadyDecided,
  ErrNoOpenPermissionRequest,
  ErrRelayModeOff,
  ErrRelayFallenBack,
  ErrRelayModeInvalid,
  ErrTemplateMalformed,
  ErrTemplateExists,
  ErrTemplateNotFound,
  ErrTemplateNameUnsafe,
} from 'agent-director'
