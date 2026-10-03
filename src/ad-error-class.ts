/**
 * ad-error-class.ts — The one classifier of agent-director errors (b.jg5
 * SRJ-104), and the `ErrInvalidFlags` step beside it.
 *
 * {@link classifyAdError} maps any value thrown by an agent-director call to
 * exactly one class:
 *
 *   GONE            ErrTmuxSendKeys, ErrTmuxCaptureFailed
 *   UNAVAILABLE     ErrTmuxUnresponsive, ErrTmuxKillFailed, ErrCallTimeout;
 *                   an ErrUnknownErrorName whose `unknownName` is none of
 *                   ErrInternal, ErrConfigMalformed, ErrSchemaMismatch,
 *                   ErrSchemaMigrationRequired and ErrStoreOpen (a Phase 1
 *                   name included); an AgentDirectorError whose `errName` is
 *                   UnknownError (CSCB's own wrapper); any value that is not
 *                   an AgentDirectorError
 *   CONFLICT        ErrTmuxSessionConflict
 *   UNUSABLE_NAME   an ErrInternal whose description carries "the recorded
 *                   tmux session name" (`UNUSABLE_RECORDED_NAME_PHRASE`)
 *   CONFIG          ErrConfigMalformed
 *   ENVIRONMENT     ErrTmuxNotAvailable
 *   LAUNCH_FAILURE  ErrTmuxSessionCreate
 *   STATE           ErrSpawnNotFound, ErrInstanceIdCollision,
 *                   ErrSpawnNotResumable, ErrSpawnNotInteractive,
 *                   ErrSpawnNotPausable, ErrNoSessionId, ErrJsonlMissing,
 *                   ErrJsonlNeverWritten, ErrInvalidFlags (its meaning is set
 *                   per call site)
 *   DIRECTORY       ErrCwdNotFound, ErrCwdNotADirectory
 *   UNCLASSIFIED    every other ErrInternal; ErrSchemaMismatch,
 *                   ErrSchemaMigrationRequired and ErrStoreOpen (a store
 *                   agent-director cannot open, A-32);
 *                   ErrSystemInstallDisappeared and every other
 *                   agent-director error name
 *
 * Recognition is by name (b.jg5 SRJ-101 interim rule): the value's `errName`,
 * and for an `ErrUnknownErrorName` its `unknownName` and the envelope's
 * `err_description`; never the value's `name`. The three Phase-1-only names,
 * the three store-open names and `ErrInternal` come from
 * `src/agent-director-errors.ts` as strings, and nothing here imports the
 * Phase-1-only classes, which the
 * branch's 0.10.0 client lacks. Only the base `AgentDirectorError` is tested
 * by class. `ErrInternal`, `ErrConfigMalformed` and the three store-open names
 * arrive as `ErrUnknownErrorName`, matched exactly (a differently cased name
 * is any other name); a value whose own `errName` is one of them is
 * classified the same way, its description taken from `errDescription`
 * (Assumption A-13).
 *
 * An UNCLASSIFIED, UNUSABLE_NAME or CONFIG classification carries the
 * reported name (`unknownName` for an `ErrUnknownErrorName`, else `errName`)
 * only when `isSafeIdentifier` accepts it, and the message (the envelope's
 * `err_description` for an `ErrUnknownErrorName`, else `errDescription`)
 * rendered by `renderLogMessageText`: through `redactSlackLogText`, on one
 * line, capped at `MAX_LOGGED_MESSAGE_LENGTH`. An unsafe name is absent,
 * never reported raw; no placeholder stands in for it.
 * {@link describeAdErrorClassification} renders a classification for a log
 * line from those fields only.
 *
 * {@link conflictDescriptionOf} answers the description of a value that
 * classifies as CONFLICT (its `errDescription`, read by name), and nothing
 * for any other value; the conflict latch (`src/conflict-latch.ts`; b.jg5
 * SRJ-501, SRJ-507) reads its quoted session and its case from it. A CONFLICT
 * classification itself carries no description, so
 * `describeAdErrorClassification` never logs the raw text. Never throws.
 *
 * {@link killFailedDescriptionOf} answers the description of a value that is
 * an `ErrTmuxKillFailed` by name (its own `errName`, or an
 * `ErrUnknownErrorName` carrying that name, with the envelope's
 * description), and nothing for any other value; the kill outcome
 * (`src/checked-kill.ts`; b.jg5 SRJ-110, SRJ-702) carries it raw, and every
 * log line renders it redacted. An UNAVAILABLE classification carries no
 * description either. Never throws.
 *
 * The classifier is pure: no I/O, clock, module state or agent-director call,
 * and it never throws (a throwing property read counts as an absent field).
 *
 * {@link hasAdErrorName} answers whether a value is an agent-director error of
 * one given `errName`, for a site that must tell one name from another (a
 * STATE name's meaning is set per site); {@link isInvalidFlagsError} is its
 * use for `ErrInvalidFlags`. Never throws.
 *
 * {@link isDifferentTmuxServerError} answers whether a value is the
 * re-bound-socket form of ENVIRONMENT (b.jg5 SRJ-1021): ENVIRONMENT by the
 * classifier, its description carrying `DIFFERENT_TMUX_SERVER_PHRASE`
 * (`src/ad-description-phrases.ts`). Never throws.
 *
 * {@link isLaunchTimeoutError} answers whether a value ends a declared launch
 * call as a launch timeout (b.jg5 SRJ-407): `ErrCallTimeout`, or an
 * `ErrTmuxUnresponsive` whose description carries `LAUNCH_TIMEOUT_PHRASE`;
 * {@link launchTimeoutFormOf} names the form. Both forms keep their
 * UNAVAILABLE class. Never throws.
 *
 * {@link classifyWithInvalidFlagsRecheck} is the step for a site that gives
 * `ErrInvalidFlags` no meaning (b.jg5 SRJ-104: any site but a plain or reuse
 * spawn): an `ErrInvalidFlags` gets exactly one immediate version re-check
 * through `triggerAdVersionRecheck` (`src/ad-version-gate.ts`, b.jg5 SRJ-204;
 * injectable) and answers UNCLASSIFIED with the re-check's answer; any other
 * value answers its pure class with no re-check. A stop the re-check decides
 * ends the process as the re-check defines. Its callers: the resume path of
 * `resumeOrFreshSpawn` (`src/session-manager.ts`), the kill sites
 * (`recheckKillOnInvalidFlags`, `src/session-manager.ts`) and the `decide`
 * branch of the click handler (`src/permission-click-handler.ts`).
 *
 * {@link unclassifiedClassificationOf} is the UNCLASSIFIED classification,
 * reported name and rendered message included, of a value a site takes as
 * UNCLASSIFIED although the classifier gives it another class (b.jg5 SRJ-110:
 * a class a kill has no row for). Pure; never throws.
 *
 * {@link describeAgentDirectorFailure} renders a failed call for a log line by
 * the same name rule: the `errName` when it is a safe identifier, then the
 * redacted description.
 *
 * Verbs (b.jg5 glossary, SRJ-307, SRJ-310). Every agent-director call made
 * through the outage wrappers (`src/outage-state.ts`) declares its verb
 * (`AdCall`): one of `AD_VERBS`, and for `kill` whether the site kills a row
 * it read live (`AdKillCall`). The tmux-touching verbs are
 * `TMUX_TOUCHING_VERBS` (`spawn`, plain or reuse, `resume`, `read-pane`,
 * `send-keys`, `pause`, and `kill` of a live row); {@link isTmuxTouchingCall}
 * answers for a declared call, a `kill` counting only when declared as a kill
 * of a row read live. The launch verbs (`spawn`, plain or reuse, and
 * `resume`) are `AD_LAUNCH_VERBS` ({@link isLaunchCall}). The read verbs
 * (`status`, `get`, `list`) are `AD_READ_VERBS`. `find-missing`, `delete`, `get-permission` and `decide`
 * are neither.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  DIFFERENT_TMUX_SERVER_PHRASE,
  LAUNCH_TIMEOUT_PHRASE,
  UNUSABLE_RECORDED_NAME_PHRASE,
} from './ad-description-phrases.ts'
import {
  RECHECK_OUTCOME_COULD_NOT_RUN,
  triggerAdVersionRecheck,
  type AdVersionRecheckTriggerAnswer,
} from './ad-version-gate.ts'
import {
  AgentDirectorError,
  ERR_INTERNAL_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  STORE_OPEN_ERR_NAMES,
} from './agent-director-errors.ts'
import {
  describeLogMessage,
  describeThrownValue,
  isSafeIdentifier,
  renderLogMessageText,
} from './persona-connection-errors.ts'

// ---------------------------------------------------------------------------
// Verbs (b.jg5 glossary, SRJ-307, SRJ-310)
// ---------------------------------------------------------------------------

/** Every agent-director verb a wrapped call declares, as agent-director names it. */
export const AD_VERBS = [
  'spawn',
  'resume',
  'read-pane',
  'send-keys',
  'pause',
  'kill',
  'status',
  'get',
  'list',
  'find-missing',
  'delete',
  'get-permission',
  'decide',
] as const

/** One agent-director verb. */
export type AdVerb = (typeof AD_VERBS)[number]

/** The `kill` verb. */
export const AD_VERB_KILL = 'kill'

/**
 * The tmux-touching verbs (the b.jg5 glossary): `spawn` (plain or reuse),
 * `resume`, `read-pane`, `send-keys`, `pause`, and `kill` of a live row. A
 * `kill` call counts only when declared as a kill of a row read live
 * ({@link isTmuxTouchingCall}).
 */
export const TMUX_TOUCHING_VERBS: ReadonlySet<string> = new Set<AdVerb>([
  'spawn',
  'resume',
  'read-pane',
  'send-keys',
  'pause',
  AD_VERB_KILL,
])

/**
 * The launch verbs (b.jg5 SRJ-301, SRJ-305): `spawn` (plain or reuse) and
 * `resume`. A successful launch call leaves its row `pending`
 * ({@link isLaunchCall}).
 */
export const AD_LAUNCH_VERBS: ReadonlySet<string> = new Set<AdVerb>(['spawn', 'resume'])

/** True when the declared call is a launch (`AD_LAUNCH_VERBS`). Never throws. */
export function isLaunchCall(call: AdCall): boolean {
  const verb = adCallVerb(call)
  return verb !== undefined && AD_LAUNCH_VERBS.has(verb)
}

/** The read verbs (b.jg5 SRJ-301, SRJ-105): `status`, `get` and `list`. */
export const AD_READ_VERBS: ReadonlySet<string> = new Set<AdVerb>(['status', 'get', 'list'])

/**
 * A `kill` call as its site declares it: `rowReadLive` is true only when the
 * site kills a row it read in a live state (a live-row sequence's kill of the
 * row it read live); a kill after a `dead` reading, or a teardown's kill of a
 * row it did not read, declares false.
 */
export interface AdKillCall {
  readonly verb: typeof AD_VERB_KILL
  readonly rowReadLive: boolean
}

/** A wrapped call's declared verb: the verb itself, or a {@link AdKillCall} for `kill`. */
export type AdCall = Exclude<AdVerb, typeof AD_VERB_KILL> | AdKillCall

/** A kill of a row the site read live. */
export const AD_CALL_KILL_ROW_READ_LIVE: AdKillCall = Object.freeze({ verb: AD_VERB_KILL, rowReadLive: true })

/** A kill of a row the site did not read live. */
export const AD_CALL_KILL_ROW_NOT_READ_LIVE: AdKillCall = Object.freeze({ verb: AD_VERB_KILL, rowReadLive: false })

/** The kill declaration for a site that knows whether it read the row live. */
export function adKillCall(rowReadLive: boolean): AdKillCall {
  return rowReadLive ? AD_CALL_KILL_ROW_READ_LIVE : AD_CALL_KILL_ROW_NOT_READ_LIVE
}

/**
 * The verb of a declared call, as agent-director names it, or `undefined`
 * when `call` is not a declared call. Never throws.
 */
export function adCallVerb(call: AdCall): AdVerb | undefined {
  try {
    const verb: unknown = typeof call === 'string' ? call : call.verb
    return typeof verb === 'string' && (AD_VERBS as readonly string[]).includes(verb) ? (verb as AdVerb) : undefined
  } catch {
    return undefined
  }
}

/**
 * True when the declared call is tmux-touching (the b.jg5 glossary): its verb
 * is in `TMUX_TOUCHING_VERBS`, and a `kill` only when declared as a kill of a
 * row read live (`rowReadLive` exactly true). Never throws.
 */
export function isTmuxTouchingCall(call: AdCall): boolean {
  try {
    const verb = adCallVerb(call)
    if (verb === undefined || !TMUX_TOUCHING_VERBS.has(verb)) return false
    if (verb !== AD_VERB_KILL) return true
    return typeof call === 'object' && call !== null && call.rowReadLive === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Class labels
// ---------------------------------------------------------------------------

/** GONE: the tmux session is gone. */
export const AD_ERROR_CLASS_GONE = 'GONE'
/** UNAVAILABLE: agent-director or tmux could not answer; nothing destructive follows. */
export const AD_ERROR_CLASS_UNAVAILABLE = 'UNAVAILABLE'
/** CONFLICT: a tmux session conflict. */
export const AD_ERROR_CLASS_CONFLICT = 'CONFLICT'
/** UNUSABLE NAME: the row's recorded tmux session name cannot be used. */
export const AD_ERROR_CLASS_UNUSABLE_NAME = 'UNUSABLE_NAME'
/** CONFIG: agent-director's config file is malformed. */
export const AD_ERROR_CLASS_CONFIG = 'CONFIG'
/** ENVIRONMENT: tmux is not available. */
export const AD_ERROR_CLASS_ENVIRONMENT = 'ENVIRONMENT'
/** LAUNCH FAILURE: tmux could not create the session. */
export const AD_ERROR_CLASS_LAUNCH_FAILURE = 'LAUNCH_FAILURE'
/** STATE: the row's state refused the verb; its meaning is set per call site. */
export const AD_ERROR_CLASS_STATE = 'STATE'
/** DIRECTORY: the persona's working directory is missing or not a directory. */
export const AD_ERROR_CLASS_DIRECTORY = 'DIRECTORY'
/** UNCLASSIFIED: an agent-director error CSCB gives no handling. */
export const AD_ERROR_CLASS_UNCLASSIFIED = 'UNCLASSIFIED'

/** Every class label, in the order of b.jg5 SRJ-104's table. */
export const AD_ERROR_CLASSES = [
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_UNCLASSIFIED,
] as const

/** One class label. */
export type AdErrorClass = (typeof AD_ERROR_CLASSES)[number]

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `errName` of the client's error for an `err_name` it has no class for. */
const ERR_UNKNOWN_ERROR_NAME = 'ErrUnknownErrorName'

/** The agent-director error names the table classes GONE; the one source of them. */
export const AD_GONE_ERR_NAMES = ['ErrTmuxSendKeys', 'ErrTmuxCaptureFailed'] as const

/** `unknownName` of a malformed agent-director config (no class in any client). */
const ERR_CONFIG_MALFORMED_NAME = 'ErrConfigMalformed'

/** `unknownName`s of a store agent-director cannot open (A-32; Q-15): UNCLASSIFIED. */
const STORE_OPEN_NAMES: ReadonlySet<unknown> = new Set<unknown>(STORE_OPEN_ERR_NAMES)

/** `errName` of CSCB's own wrapper around a thrown value that was not an agent-director error. */
export const CSCB_UNKNOWN_ERROR_NAME = 'UnknownError'

/** `errName` of the client's own per-call timeout (any verb). */
const ERR_CALL_TIMEOUT_NAME = 'ErrCallTimeout'

/** `errName` of the error agent-director returns for flags this binary does not accept. */
const ERR_INVALID_FLAGS_NAME = 'ErrInvalidFlags'

/**
 * The class of each agent-director error name the table names directly.
 * `ErrInternal`, `ErrConfigMalformed`, the three store-open names,
 * `ErrUnknownErrorName` and CSCB's `UnknownError` are decided in
 * {@link classifyAdError}; any other name is UNCLASSIFIED.
 */
const CLASS_BY_ERR_NAME: ReadonlyMap<string, AdErrorClass> = new Map<string, AdErrorClass>([
  ...AD_GONE_ERR_NAMES.map((name): [string, AdErrorClass] => [name, AD_ERROR_CLASS_GONE]),
  [ERR_TMUX_UNRESPONSIVE_NAME, AD_ERROR_CLASS_UNAVAILABLE],
  [ERR_TMUX_KILL_FAILED_NAME, AD_ERROR_CLASS_UNAVAILABLE],
  [ERR_CALL_TIMEOUT_NAME, AD_ERROR_CLASS_UNAVAILABLE],
  [ERR_TMUX_SESSION_CONFLICT_NAME, AD_ERROR_CLASS_CONFLICT],
  ['ErrTmuxNotAvailable', AD_ERROR_CLASS_ENVIRONMENT],
  ['ErrTmuxSessionCreate', AD_ERROR_CLASS_LAUNCH_FAILURE],
  [ERR_SPAWN_NOT_FOUND_NAME, AD_ERROR_CLASS_STATE],
  ['ErrInstanceIdCollision', AD_ERROR_CLASS_STATE],
  ['ErrSpawnNotResumable', AD_ERROR_CLASS_STATE],
  ['ErrSpawnNotInteractive', AD_ERROR_CLASS_STATE],
  ['ErrSpawnNotPausable', AD_ERROR_CLASS_STATE],
  ['ErrNoSessionId', AD_ERROR_CLASS_STATE],
  ['ErrJsonlMissing', AD_ERROR_CLASS_STATE],
  ['ErrJsonlNeverWritten', AD_ERROR_CLASS_STATE],
  [ERR_INVALID_FLAGS_NAME, AD_ERROR_CLASS_STATE],
  ['ErrCwdNotFound', AD_ERROR_CLASS_DIRECTORY],
  ['ErrCwdNotADirectory', AD_ERROR_CLASS_DIRECTORY],
])

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** What {@link classifyAdError} answers for one thrown value. */
export interface AdErrorClassification {
  /** The value's class. */
  readonly errorClass: AdErrorClass
  /**
   * UNCLASSIFIED, UNUSABLE_NAME and CONFIG only: the reported name
   * (`unknownName` of an `ErrUnknownErrorName`, else `errName`), present only
   * when `isSafeIdentifier` accepts it.
   */
  readonly reportedName?: string
  /**
   * UNCLASSIFIED, UNUSABLE_NAME and CONFIG only: the message (the envelope's
   * `err_description` of an `ErrUnknownErrorName`, else `errDescription`)
   * rendered by `renderLogMessageText`, present only when that is not empty.
   */
  readonly message?: string
}

/**
 * The class of any value thrown by an agent-director call (b.jg5 SRJ-104);
 * see the module comment. Pure; never throws.
 */
export function classifyAdError(value: unknown): AdErrorClassification {
  try {
    if (!isAgentDirectorError(value)) return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }
    const errName = readProp(value, 'errName')
    if (errName === ERR_UNKNOWN_ERROR_NAME) {
      return classifyUnknownName(readProp(value, 'unknownName'), readProp(readProp(value, 'envelope'), 'err_description'))
    }
    if (errName === ERR_INTERNAL_NAME || errName === ERR_CONFIG_MALFORMED_NAME || STORE_OPEN_NAMES.has(errName)) {
      return classifyUnknownName(errName, readProp(value, 'errDescription'))
    }
    if (errName === CSCB_UNKNOWN_ERROR_NAME) return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }
    const errorClass = typeof errName === 'string' ? CLASS_BY_ERR_NAME.get(errName) : undefined
    if (errorClass !== undefined) return { errorClass }
    return reported(AD_ERROR_CLASS_UNCLASSIFIED, errName, readProp(value, 'errDescription'))
  } catch {
    return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }
  }
}

/**
 * The description of a value that {@link classifyAdError} classifies as
 * CONFLICT: its `errDescription`, read by name (b.jg5 SRJ-101 interim rule),
 * raw as agent-director wrote it, when it is a string. `undefined` for a value
 * of any other class (an `ErrUnknownErrorName` included, whatever its
 * `unknownName`: SRJ-104 classes it by that name, never as CONFLICT), for a
 * value that is not an agent-director error, and when the read throws or
 * finds no string. The caller redacts it before it reaches a log line, a
 * stored record or a notice. Pure; never throws.
 */
export function conflictDescriptionOf(value: unknown): string | undefined {
  try {
    if (classifyAdError(value).errorClass !== AD_ERROR_CLASS_CONFLICT) return undefined
    const description = readProp(value, 'errDescription')
    return typeof description === 'string' ? description : undefined
  } catch {
    return undefined
  }
}

/**
 * The description of a value that is an `ErrTmuxKillFailed` by name (b.jg5
 * SRJ-101 interim rule): for a value whose own `errName` is
 * `ErrTmuxKillFailed`, its `errDescription`; for an `ErrUnknownErrorName`
 * whose `unknownName` is `ErrTmuxKillFailed` (a client that has no class of
 * that name), the envelope's `err_description`. Raw, as agent-director wrote
 * it, when it is a string. `undefined` for a value of any other name, for a
 * value that is not an agent-director error, and when a read throws or finds
 * no string. The kill outcome (`src/checked-kill.ts`) carries it; the caller
 * redacts it before it reaches a log line, a stored record or a notice. A
 * classification never carries it, so `describeAdErrorClassification` never
 * logs the raw text. Pure; never throws.
 */
export function killFailedDescriptionOf(value: unknown): string | undefined {
  try {
    if (!isAgentDirectorError(value)) return undefined
    const errName = readProp(value, 'errName')
    let description: unknown
    if (errName === ERR_TMUX_KILL_FAILED_NAME) {
      description = readProp(value, 'errDescription')
    } else if (errName === ERR_UNKNOWN_ERROR_NAME && readProp(value, 'unknownName') === ERR_TMUX_KILL_FAILED_NAME) {
      description = readProp(readProp(value, 'envelope'), 'err_description')
    }
    return typeof description === 'string' ? description : undefined
  } catch {
    return undefined
  }
}

/** An agent-director error whose `errName` is `ErrInvalidFlags`. */
export type InvalidFlagsError = AgentDirectorError & { readonly errName: typeof ERR_INVALID_FLAGS_NAME }

/**
 * True when `value` is an agent-director `ErrInvalidFlags`, recognised by its
 * `errName`. Never throws.
 */
export function isInvalidFlagsError(value: unknown): value is InvalidFlagsError {
  return hasAdErrorName(value, ERR_INVALID_FLAGS_NAME)
}

/**
 * True when `value` is an agent-director error whose `errName` is `name`
 * (b.jg5 SRJ-101 interim rule: recognition by name). The one way a site tells
 * one agent-director error name from another; pass a name constant from
 * `src/agent-director-errors.ts`. Never throws: a value that is not an
 * agent-director error, or whose `errName` cannot be read, answers false.
 */
export function hasAdErrorName(value: unknown, name: string): boolean {
  try {
    return isAgentDirectorError(value) && readProp(value, 'errName') === name
  } catch {
    return false
  }
}

/** A launch timeout's form: the client's own `ErrCallTimeout` for the launch call (b.jg5 SRJ-407). */
export const LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT = ERR_CALL_TIMEOUT_NAME
/** A launch timeout's form: agent-director's `ErrTmuxUnresponsive` carrying `LAUNCH_TIMEOUT_PHRASE` (b.jg5 SRJ-407). */
export const LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE = ERR_TMUX_UNRESPONSIVE_NAME

/** The two forms of a launch timeout. */
export type LaunchTimeoutForm = typeof LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT | typeof LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE

/**
 * The form in which `value` ends the declared launch call `call` as a launch
 * timeout (b.jg5 SRJ-407), or `undefined` when it does not: `call` is a
 * launch call ({@link isLaunchCall}: `spawn`, plain or reuse, or `resume`),
 * and either the client threw `ErrCallTimeout` for it
 * ({@link LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT}), or agent-director answered
 * `ErrTmuxUnresponsive` whose description contains `LAUNCH_TIMEOUT_PHRASE`
 * ("the session may have been created"; `src/ad-description-phrases.ts`;
 * {@link LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE}). Recognition is by name
 * ({@link hasAdErrorName}; b.jg5 SRJ-101 interim rule); an
 * `ErrUnknownErrorName` whose `unknownName` is `ErrTmuxUnresponsive` (a client
 * with no class of that name) is read the same way, its description taken
 * from the envelope's `err_description`. The value's class is unchanged:
 * both forms stay UNAVAILABLE. Pure; never throws.
 */
export function launchTimeoutFormOf(value: unknown, call: AdCall): LaunchTimeoutForm | undefined {
  try {
    if (!isLaunchCall(call)) return undefined
    if (hasAdErrorName(value, ERR_CALL_TIMEOUT_NAME)) return LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT
    let description: unknown
    if (hasAdErrorName(value, ERR_TMUX_UNRESPONSIVE_NAME)) {
      description = readProp(value, 'errDescription')
    } else if (
      hasAdErrorName(value, ERR_UNKNOWN_ERROR_NAME) &&
      readProp(value, 'unknownName') === ERR_TMUX_UNRESPONSIVE_NAME
    ) {
      description = readProp(readProp(value, 'envelope'), 'err_description')
    }
    return typeof description === 'string' && description.includes(LAUNCH_TIMEOUT_PHRASE)
      ? LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE
      : undefined
  } catch {
    return undefined
  }
}

/**
 * True when `value` ends the declared launch call `call` as a launch timeout
 * (b.jg5 SRJ-407), in either form ({@link launchTimeoutFormOf}). Pure; never
 * throws.
 */
export function isLaunchTimeoutError(value: unknown, call: AdCall): boolean {
  return launchTimeoutFormOf(value, call) !== undefined
}

/**
 * True when `value` is the re-bound-socket form of ENVIRONMENT (b.jg5
 * SRJ-311, SRJ-1021): it classifies as ENVIRONMENT by {@link classifyAdError}
 * and its `errDescription` contains `DIFFERENT_TMUX_SERVER_PHRASE`.
 * Recognition is by class and phrase only. A missing or non-string description
 * answers false. Pure; never throws.
 */
export function isDifferentTmuxServerError(value: unknown): boolean {
  try {
    if (classifyAdError(value).errorClass !== AD_ERROR_CLASS_ENVIRONMENT) return false
    const description = readProp(value, 'errDescription')
    return typeof description === 'string' && description.includes(DIFFERENT_TMUX_SERVER_PHRASE)
  } catch {
    return false
  }
}

/**
 * One line for a log: `class=<class>[ name=<reported name>][ message="<message>"]`,
 * from the classification's own fields only (the message JSON-quoted, as
 * `describeLogMessage` quotes it). Never throws.
 */
export function describeAdErrorClassification(classification: AdErrorClassification): string {
  const parts = [`class=${classification.errorClass}`]
  if (classification.reportedName !== undefined) parts.push(`name=${classification.reportedName}`)
  if (classification.message !== undefined) parts.push(`message=${JSON.stringify(classification.message)}`)
  return parts.join(' ')
}

/**
 * Token-safe description of a failed agent-director call, for a log line: a
 * typed agent-director error's `errName` when it is a short identifier, then
 * its `errDescription` as `message="…"` (`describeLogMessage`: through
 * `redactSlackLogText`, on one line, capped at `MAX_LOGGED_MESSAGE_LENGTH`
 * characters) when it has one; else `describeThrownValue(err)`, which renders
 * the message the same way. Never the raw `errName` or error object. Never
 * throws.
 */
export function describeAgentDirectorFailure(err: unknown): string {
  try {
    if (isAgentDirectorError(err) && isSafeIdentifier(err.errName)) {
      const message = describeLogMessage(err.errDescription)
      return message === '' ? err.errName : `${err.errName} ${message}`
    }
  } catch {
    /* a throwing property read falls back to the generic describer */
  }
  return describeThrownValue(err)
}

/**
 * Token-safe description of a failed agent-director call that names what
 * agent-director reported (b.jg5 SRJ-104): for a value {@link classifyAdError}
 * gives a reported name or message (an UNCLASSIFIED, UNUSABLE NAME or CONFIG
 * error), `<reported name>[ message="<message>"]` in
 * {@link describeAgentDirectorFailure}'s form, so an `ErrUnknownErrorName`
 * shows its `unknownName` and the envelope's `err_description` rather than
 * the client's own text; for any other value,
 * {@link describeAgentDirectorFailure}'s description. Never throws.
 */
export function describeReportedAdFailure(err: unknown): string {
  const { reportedName, message } = classifyAdError(err)
  if (reportedName === undefined && message === undefined) return describeAgentDirectorFailure(err)
  const parts: string[] = []
  if (reportedName !== undefined) parts.push(reportedName)
  if (message !== undefined) parts.push(`message=${JSON.stringify(message)}`)
  return parts.join(' ')
}

/**
 * The UNCLASSIFIED classification of `value`, for a site that takes a value
 * of another class as UNCLASSIFIED because it gives that class no meaning
 * (b.jg5 SRJ-104, SRJ-110: at a kill, a STATE name other than
 * `ErrSpawnNotFound`, LAUNCH FAILURE or DIRECTORY): class UNCLASSIFIED, with
 * the reported name (`errName`, or `unknownName` of an `ErrUnknownErrorName`)
 * when it is a safe identifier and the rendered message (`errDescription`,
 * or the envelope's `err_description` of an `ErrUnknownErrorName`) when it
 * is not empty. For a value that is not an agent-director error, class
 * UNCLASSIFIED alone. Pure; never throws.
 */
export function unclassifiedClassificationOf(value: unknown): AdErrorClassification {
  try {
    if (!isAgentDirectorError(value)) return { errorClass: AD_ERROR_CLASS_UNCLASSIFIED }
    const errName = readProp(value, 'errName')
    if (errName === ERR_UNKNOWN_ERROR_NAME) {
      return reported(
        AD_ERROR_CLASS_UNCLASSIFIED,
        readProp(value, 'unknownName'),
        readProp(readProp(value, 'envelope'), 'err_description'),
      )
    }
    return reported(AD_ERROR_CLASS_UNCLASSIFIED, errName, readProp(value, 'errDescription'))
  } catch {
    return { errorClass: AD_ERROR_CLASS_UNCLASSIFIED }
  }
}

/** The class of an `ErrUnknownErrorName` (or an A-13 value) by `unknownName` and description. */
function classifyUnknownName(unknownName: unknown, description: unknown): AdErrorClassification {
  if (unknownName === ERR_INTERNAL_NAME) {
    const unusable = typeof description === 'string' && description.includes(UNUSABLE_RECORDED_NAME_PHRASE)
    return reported(unusable ? AD_ERROR_CLASS_UNUSABLE_NAME : AD_ERROR_CLASS_UNCLASSIFIED, unknownName, description)
  }
  if (unknownName === ERR_CONFIG_MALFORMED_NAME) return reported(AD_ERROR_CLASS_CONFIG, unknownName, description)
  if (STORE_OPEN_NAMES.has(unknownName)) return reported(AD_ERROR_CLASS_UNCLASSIFIED, unknownName, description)
  return { errorClass: AD_ERROR_CLASS_UNAVAILABLE }
}

/** A classification carrying the reported name (when safe) and the rendered message (when not empty). */
function reported(errorClass: AdErrorClass, name: unknown, description: unknown): AdErrorClassification {
  const message = renderLogMessageText(description)
  return {
    errorClass,
    ...(isSafeIdentifier(name) ? { reportedName: name } : {}),
    ...(message !== '' ? { message } : {}),
  }
}

/** True when `value` is an instance of the client's base error class. Never throws. */
function isAgentDirectorError(value: unknown): value is AgentDirectorError {
  try {
    return value instanceof AgentDirectorError
  } catch {
    return false
  }
}

/** `obj[prop]`, or `undefined` when `obj` is not an object or the read throws. */
function readProp(obj: unknown, prop: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined
  try {
    return (obj as Record<string, unknown>)[prop]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The ErrInvalidFlags step
// ---------------------------------------------------------------------------

/** An immediate version re-check: `triggerAdVersionRecheck`'s shape. */
export type AdVersionRecheckTrigger = () => Promise<AdVersionRecheckTriggerAnswer>

/** The could-not-run description of a re-check whose trigger threw or rejected (token-free, fixed text). */
export const TRIGGER_FAILED_DESCRIPTION = 'the version re-check trigger failed'

/** What {@link classifyWithInvalidFlagsRecheck} answers. */
export interface AdErrorStepAnswer {
  /** UNCLASSIFIED for an `ErrInvalidFlags`; otherwise {@link classifyAdError}'s answer. */
  readonly classification: AdErrorClassification
  /**
   * The re-check's answer (pass, stop, could not run, not running); present
   * only for an `ErrInvalidFlags`. A trigger that throws or rejects counts as
   * could not run.
   */
  readonly recheck?: AdVersionRecheckTriggerAnswer
}

/** What {@link classifyWithInvalidFlagsRecheck} answers for an `ErrInvalidFlags`: the re-check's answer is always present. */
export interface AdInvalidFlagsStepAnswer extends AdErrorStepAnswer {
  readonly recheck: AdVersionRecheckTriggerAnswer
}

/**
 * The `ErrInvalidFlags` step for a site that gives `ErrInvalidFlags` no
 * meaning (b.jg5 SRJ-104, SRJ-204): for an `ErrInvalidFlags`, await exactly
 * one immediate version re-check through `trigger` (default: the installed
 * re-check's `triggerAdVersionRecheck`) and answer UNCLASSIFIED with the
 * re-check's answer, whatever it is; for any other value, answer its pure
 * class with no re-check. Never throws or rejects.
 */
export async function classifyWithInvalidFlagsRecheck(
  value: InvalidFlagsError,
  trigger?: AdVersionRecheckTrigger,
): Promise<AdInvalidFlagsStepAnswer>
export async function classifyWithInvalidFlagsRecheck(
  value: unknown,
  trigger?: AdVersionRecheckTrigger,
): Promise<AdErrorStepAnswer>
export async function classifyWithInvalidFlagsRecheck(
  value: unknown,
  trigger: AdVersionRecheckTrigger = triggerAdVersionRecheck,
): Promise<AdErrorStepAnswer> {
  if (!isInvalidFlagsError(value)) return { classification: classifyAdError(value) }
  let recheck: AdVersionRecheckTriggerAnswer
  try {
    recheck = await trigger()
  } catch {
    recheck = { kind: RECHECK_OUTCOME_COULD_NOT_RUN, description: TRIGGER_FAILED_DESCRIPTION }
  }
  // UNCLASSIFIED carries the reported name (`errName`) and the rendered `errDescription`.
  return {
    classification: reported(AD_ERROR_CLASS_UNCLASSIFIED, readProp(value, 'errName'), readProp(value, 'errDescription')),
    recheck,
  }
}
