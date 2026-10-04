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
 * The first four are named re-exports of the client's classes. The last three
 * are the installed client's own classes wherever the client declares them:
 * {@link resolvePhase1ErrorClasses} reads them once, at module load, through a
 * namespace import of `agent-director` and a typed optional cast, and each
 * binding below is the client's class when the client declares it, else a
 * CSCB stand-in subclass of the client's `AgentDirectorError` with the same
 * `name`. {@link PHASE1_ERROR_CLASSES_FROM_CLIENT} is true only when all three
 * came from the client. The stand-ins are reachable only on a client the
 * startup gate refuses (`ad-shim-catalog-incomplete`: `REQUIRED_ERR_NAMES`,
 * `src/agent-director-startup.ts`, b.jg5 SRJ-102), so production code never
 * meets one.
 *
 * The narrowed interim rule (b.jg5 SRJ-101), until the package pins the
 * Phase 1 client: no file in `src/` or `tests/` names
 * `ErrTmuxKillFailed`, `ErrTmuxUnresponsive` or `ErrTmuxSessionConflict` in a
 * named import, a re-export or a destructuring of `agent-director`, and this
 * module is the one place they are read from the client; every other file
 * imports the bindings from here. Their names are also exported below as plain
 * strings, for the startup gate's dist-text check and for log labels only. So
 * are the three store-open `unknownName`s (`ErrSchemaMismatch`,
 * `ErrSchemaMigrationRequired`, `ErrStoreOpen`) and `ErrInternal`, which no
 * client declares as a class and the classifier matches by `unknownName`.
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

import * as agentDirectorClient from 'agent-director'
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
 * (`REQUIRED_ERR_NAMES`, `src/agent-director-startup.ts`), the stand-ins'
 * `name` and log labels only; no code decides an error by them. The errors
 * themselves are recognised by class: the bindings {@link ErrTmuxKillFailed},
 * {@link ErrTmuxUnresponsive} and {@link ErrTmuxSessionConflict} below.
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
 * A constructor of an agent-director error class built, like the client's
 * catalogue classes, from (verb, errName, description).
 */
export type AdErrorClassConstructor = new (verb: string, errName: string, errDescription: string) => AgentDirectorError

/**
 * What {@link resolvePhase1ErrorClasses} reads: a namespace-like object (the
 * `agent-director` module namespace, or a test's fake) that may or may not
 * declare the three Phase-1-only classes. Every field is optional and
 * `unknown`, so the read typechecks against a client that lacks them.
 */
export interface Phase1ErrorNamespace {
  readonly ErrTmuxKillFailed?: unknown
  readonly ErrTmuxUnresponsive?: unknown
  readonly ErrTmuxSessionConflict?: unknown
}

/** What {@link resolvePhase1ErrorClasses} answers: one class per Phase-1-only name, and where they came from. */
export interface Phase1ErrorClasses {
  readonly ErrTmuxKillFailed: AdErrorClassConstructor
  readonly ErrTmuxUnresponsive: AdErrorClassConstructor
  readonly ErrTmuxSessionConflict: AdErrorClassConstructor
  /** True only when all three are the namespace's own classes (no stand-in). */
  readonly fromClient: boolean
}

/**
 * A CSCB stand-in for a Phase-1-only class the installed client does not
 * declare: a subclass of the client's `AgentDirectorError` whose class name
 * and instances' `name` are `name`, built from (verb, errName, description)
 * as the client's classes are. Reachable only on a client the startup gate
 * refuses (`ad-shim-catalog-incomplete`, b.jg5 SRJ-102).
 */
function phase1StandIn(name: Phase1OnlyErrName): AdErrorClassConstructor {
  const StandIn = class extends AgentDirectorError {
    constructor(verb: string, errName: string, errDescription: string) {
      super(verb, errName, errDescription)
      this.name = name
    }
  }
  Object.defineProperty(StandIn, 'name', { value: name })
  return StandIn
}

/** One stand-in per Phase-1-only name, made once so every fallback answer shares it. */
const PHASE1_STAND_INS: Readonly<Record<Phase1OnlyErrName, AdErrorClassConstructor>> = {
  [ERR_TMUX_KILL_FAILED_NAME]: phase1StandIn(ERR_TMUX_KILL_FAILED_NAME),
  [ERR_TMUX_UNRESPONSIVE_NAME]: phase1StandIn(ERR_TMUX_UNRESPONSIVE_NAME),
  [ERR_TMUX_SESSION_CONFLICT_NAME]: phase1StandIn(ERR_TMUX_SESSION_CONFLICT_NAME),
}

/** True when `value` is a subclass of the client's `AgentDirectorError`. Never throws. */
function isAgentDirectorErrorClass(value: unknown): value is AdErrorClassConstructor {
  try {
    return typeof value === 'function' && value.prototype instanceof AgentDirectorError
  } catch {
    return false
  }
}

/**
 * The three Phase-1-only classes, chosen per name from `namespace` (b.jg5
 * SRJ-101, SRJ-103): the namespace's own class when it declares one (a
 * subclass of the client's `AgentDirectorError`), else the CSCB
 * stand-in for that name. `fromClient` is true only when all three came from
 * the namespace. Pure apart from reading the three fields; never throws (a
 * throwing read counts as an absent class).
 */
export function resolvePhase1ErrorClasses(namespace: Phase1ErrorNamespace): Phase1ErrorClasses {
  const pick = (name: Phase1OnlyErrName): { readonly cls: AdErrorClassConstructor; readonly own: boolean } => {
    let declared: unknown
    try {
      declared = namespace[name]
    } catch {
      declared = undefined
    }
    return isAgentDirectorErrorClass(declared) ? { cls: declared, own: true } : { cls: PHASE1_STAND_INS[name], own: false }
  }
  const killFailed = pick(ERR_TMUX_KILL_FAILED_NAME)
  const unresponsive = pick(ERR_TMUX_UNRESPONSIVE_NAME)
  const sessionConflict = pick(ERR_TMUX_SESSION_CONFLICT_NAME)
  return {
    ErrTmuxKillFailed: killFailed.cls,
    ErrTmuxUnresponsive: unresponsive.cls,
    ErrTmuxSessionConflict: sessionConflict.cls,
    fromClient: killFailed.own && unresponsive.own && sessionConflict.own,
  }
}

/** The installed client's answer, read once at module load through the namespace and a typed optional cast. */
const INSTALLED_PHASE1_ERROR_CLASSES = resolvePhase1ErrorClasses(agentDirectorClient as unknown as Phase1ErrorNamespace)

/** `ErrTmuxKillFailed` (UNAVAILABLE): the installed client's class, or its stand-in on a client the startup gate refuses. */
export const ErrTmuxKillFailed: AdErrorClassConstructor = INSTALLED_PHASE1_ERROR_CLASSES.ErrTmuxKillFailed

/** `ErrTmuxUnresponsive` (UNAVAILABLE): the installed client's class, or its stand-in on a client the startup gate refuses. */
export const ErrTmuxUnresponsive: AdErrorClassConstructor = INSTALLED_PHASE1_ERROR_CLASSES.ErrTmuxUnresponsive

/** `ErrTmuxSessionConflict` (CONFLICT): the installed client's class, or its stand-in on a client the startup gate refuses. */
export const ErrTmuxSessionConflict: AdErrorClassConstructor = INSTALLED_PHASE1_ERROR_CLASSES.ErrTmuxSessionConflict

/**
 * True only when the installed client declares all three Phase-1-only
 * classes, so {@link ErrTmuxKillFailed}, {@link ErrTmuxUnresponsive} and
 * {@link ErrTmuxSessionConflict} are its own classes and no stand-in is in use.
 */
export const PHASE1_ERROR_CLASSES_FROM_CLIENT: boolean = INSTALLED_PHASE1_ERROR_CLASSES.fromClient

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

/**
 * `errName` of the error agent-director answers when a row is not interactive
 * for the verb: a `send-keys` that reaches no session carrying this launch's
 * label, or a `pending` row with no launch start (C5, C21). Every client
 * declares its class (`ErrSpawnNotInteractive`), by which every site, the
 * dialog approver included (b.jg5 SRJ-118, SRJ-404), recognises it; the name
 * is kept here for log labels.
 */
export const ERR_SPAWN_NOT_INTERACTIVE_NAME = 'ErrSpawnNotInteractive'

/**
 * `errName` of the error the client raises when its agent-director binary is
 * gone after the client was built (any verb; b.xht). Every client declares
 * its class (`ErrSystemInstallDisappeared`), by which every site, the
 * liveness adapter included (where it reads dead, b.jg5 SRJ-314), recognises
 * it; the name is kept here for log labels.
 */
export const ERR_SYSTEM_INSTALL_DISAPPEARED_NAME = 'ErrSystemInstallDisappeared'

/**
 * `errName`s of `resume`'s answers that the live-row sequence's final
 * launch tells apart (b.jg5 SRJ-705, SRJ-710): the three no-transcript
 * answers, which go on to the reuse spawn, and `ErrSpawnNotResumable`. Every
 * client declares their classes, by which the sites recognise them; the
 * names are kept here for log labels.
 */
export const ERR_NO_SESSION_ID_NAME = 'ErrNoSessionId'
export const ERR_JSONL_MISSING_NAME = 'ErrJsonlMissing'
export const ERR_JSONL_NEVER_WRITTEN_NAME = 'ErrJsonlNeverWritten'
export const ERR_SPAWN_NOT_RESUMABLE_NAME = 'ErrSpawnNotResumable'

/**
 * `errName` of the error agent-director answers when a spawn names an id
 * whose row is live (a plain spawn's or a reuse spawn's collision, b.jg5
 * SRJ-111, SRJ-112). Every client declares its class
 * (`ErrInstanceIdCollision`), by which the launch sites recognise it; the
 * name is kept here for log labels.
 */
export const ERR_INSTANCE_ID_COLLISION_NAME = 'ErrInstanceIdCollision'

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
