/**
 * agent-director-errors.ts — The one import surface for the agent-director
 * client's error classes CSCB references.
 *
 * An agent-director error's class (GONE, UNAVAILABLE, CONFLICT, UNUSABLE NAME,
 * CONFIG, ENVIRONMENT, LAUNCH FAILURE, STATE, DIRECTORY, UNCLASSIFIED) is
 * decided by the classifier in `src/ad-error-class.ts` (b.jg5 SRJ-104), which
 * recognises every error the client declares as a class by `instanceof` that
 * class. No `instanceof` ladder outside the classifier decides a class. This
 * module exports the client's error classes so the classifier, the rest of
 * CSCB and the tests import them from one place, and keeps the subset list in
 * sync with SRD edits. Per SR-0.2 CSCB never parses free-form error message
 * text or exit codes, apart from matching agent-director's fixed description
 * words, which are kept in `src/ad-description-phrases.ts`.
 *
 * The seven classes of the tmux-side and unknown-name errors (b.jg5 SRJ-103,
 * SRJ-104), each a named re-export of the client's own class:
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
 * Every class the client declares is decided by `instanceof` that class,
 * through the classifier; apart from the sanctioned by-name checks
 * (`SANCTIONED_BY_NAME` in `tests/fmk-source-audit.test.ts`), no code decides
 * a client class by its name. The names of the
 * last three are also exported below as plain strings, for the startup gate's
 * dist-text check (`REQUIRED_ERR_NAMES`, `src/agent-director-startup.ts`,
 * b.jg5 SRJ-102) and for log labels only. So are the three store-open
 * `unknownName`s (`ErrSchemaMismatch`, `ErrSchemaMigrationRequired`,
 * `ErrStoreOpen`) and `ErrInternal`, which no client declares as a class and
 * the classifier matches by `unknownName`.
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
 *   - ErrTmuxKillFailed         (kill / the agent process, or another process of
 *                               the session's panes, outlived the kill)
 *   - ErrTmuxUnresponsive       (any tmux-touching verb / tmux did not answer
 *                               usably)
 *   - ErrTmuxSessionConflict    (spawn / resume / kill / the session found is not
 *                               this launch's, or tmux holds conflicting labels)
 *   - ErrUnknownErrorName       (any verb / the binary reported an err_name the
 *                               client has no class for)
 *   - ErrCwdNotFound            (spawn / persona working directory does not exist on disk)
 *   - ErrCwdNotADirectory       (spawn / persona working directory exists but is not a directory)
 *   - ErrInstanceIdCollision    (spawn / SR-1.4 idempotency)
 *   - ErrSpawnNotFound          (get / status / decide on missing row)
 *   - ErrSpawnNotInteractive    (send-keys / the row is `ended` or `missing`, or
 *                               `pending` whose session may be another launch's
 *                               or with no launch start: the reconnect's
 *                               `dead-session` (`row-not-interactive`, b.dup),
 *                               a route into the restart path's decision only;
 *                               it does not prove the worker gone, b.jg5 SRJ-609)
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
 *   - ErrSpawnNotPausable       (pause / the row's state does not allow a pause)
 *   - ErrInvalidFlags           (any verb / flags this binary does not accept)
 *
 * ErrPauseTimeout (pause / the row did not end within the host's
 * `[pause] timeout_seconds`) is not re-exported: the CLI teardown's pause
 * (`teardownPersona`, `src/cli.ts`, through `src/cli-teardown.ts`) meets it and escalates to the
 * kill (b.jg5 SRJ-119, SRJ-903) on the classifier's answer, UNCLASSIFIED, as
 * for every other agent-director error SRJ-104 gives no handling.
 *
 * CSCB-synthetic subclasses (NOT emitted by the agent-director library — minted
 * inside CSCB and recognised by their class, like agent-director's own
 * errors, so SR-0.2 holds for them too):
 *   - ErrSpawnCapReached        (restart backoff / consecutive-failure cap latch)
 *
 * SPDX-License-Identifier: MIT
 */

import { AgentDirectorError } from 'agent-director'

/**
 * `errName` of CSCB's own `ErrSpawnCapReached`. The spawn-failure notice's
 * remediation line tells it apart by its class (`ErrSpawnCapReached`, below;
 * SR-0.2 — no message matching).
 */
export const ERR_SPAWN_CAP_REACHED_NAME = 'SpawnCapReached'

/**
 * CSCB-synthetic error — never emitted by the agent-director library. Minted by
 * the restart backoff cap path (`notifyRestartCapReached` in session-manager.ts,
 * called from restart.ts `onCapReached`) when a persona hits the consecutive
 * session-launch failure cap and automatic restarts are suspended. Its
 * `errName` is `ERR_SPAWN_CAP_REACHED_NAME`.
 */
export class ErrSpawnCapReached extends AgentDirectorError {
  constructor(description: string) {
    super('spawn', ERR_SPAWN_CAP_REACHED_NAME, description)
  }
}

/**
 * Names of the three errors only the Phase 1 client declares (b.jg5 SRJ-102,
 * SRJ-103), as plain strings. They serve the startup gate's dist-text check
 * (`REQUIRED_ERR_NAMES`, `src/agent-director-startup.ts`) and log labels
 * only; no code decides an error by them. The errors themselves are
 * recognised by class: the re-exported `ErrTmuxKillFailed`,
 * `ErrTmuxUnresponsive` and `ErrTmuxSessionConflict` below.
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
 * `unknownName` of agent-director's internal error (b.jg5 SRJ-104). No client
 * declares a class of this name, so every client delivers it as
 * `ErrUnknownErrorName`; the classifier answers UNUSABLE NAME when its
 * description carries the unusable-name phrase and UNCLASSIFIED, reporting
 * this name, otherwise. A site that must tell "another `ErrInternal`" apart
 * from other UNCLASSIFIED answers, such as the CLI teardown's pause (SRJ-903),
 * compares the classification's reported name with this constant.
 */
export const ERR_INTERNAL_NAME = 'ErrInternal'

/**
 * `errName` of the error agent-director answers when no row has the instance
 * id (`get`, `status`, `decide` and the other single-row verbs). Every client
 * declares its class (`ErrSpawnNotFound`), by which every site recognises it;
 * the name is kept here for log labels.
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
  ErrTmuxKillFailed,
  ErrTmuxUnresponsive,
  ErrTmuxSessionConflict,
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
  ErrSpawnNotPausable,
  ErrInvalidFlags,
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
