/**
 * invalid-flags-hold.ts — The per-persona `ErrInvalidFlags` hold (b.jg5
 * SRJ-207), its alert's text (b.jg5 SRJ-1008) and its episode's kind
 * (b.jg5 SRJ-1016).
 *
 * What holds. When a reuse spawn of persona P's id answers `ErrInvalidFlags`
 * and the immediate version re-check passes or cannot run, P is held: every
 * launch path for P makes no agent-director call and reports `held`, and the
 * health tick and the retry timer make no attempt for P. CSCB never falls
 * back to a plain spawn or to any tmux command. {@link decideInvalidFlagsHold}
 * decides it from the re-check's answer: a pass, a could-not-run and a
 * not-running answer (none installed, disposed or already stopped) hold; a
 * stop does not (the server stops, b.jg5 SRJ-205). It also answers the
 * version the hold begins under: the pass's version, else the re-check's
 * last version seen as given, else none.
 *
 * The hold ({@link createInvalidFlagsHold}): one instance per server, built
 * in `main()`, in server memory only, so a server restart ends every hold.
 * `set` holds a persona with the version it began under (absent when
 * unknown) and calls each set observer once; setting a persona already held
 * changes nothing, logs nothing and calls no observer. `versionChanged(new)`
 * ends every hold whose version differs from `new`, or that began under none,
 * and answers the keys it ended; a hold whose version equals `new` stays.
 * `forget(key)` ends one persona's hold silently (its teardown: no post and
 * no retry) and `forgetAll()` every hold (shutdown). Each end calls each end
 * observer once, with its reason ({@link INVALID_FLAGS_HOLD_END_VERSION_CHANGED}
 * or {@link INVALID_FLAGS_HOLD_END_FORGOTTEN}). A set after an end begins a
 * new hold, and so a new episode. `isHeld`, `heldKeys` and `beganUnder` read
 * it.
 *
 * The hold's reactions are built here and bound in `main()` (`src/server.ts`):
 * the set reaction ({@link bindInvalidFlagsHoldSetReaction}) stops P's retry
 * timer through the retry controller's stop entry, then posts
 * {@link INVALID_FLAGS_HOLD_ALERT_TEXT} at most once in P's `ErrInvalidFlags`
 * hold episode (`src/persona-episodes.ts`); the runtime re-check's
 * version-changed signal (`onAdVersionChanged`, `src/ad-version-gate.ts`)
 * runs the version-change reaction ({@link endInvalidFlagsHoldsOnVersionChange}),
 * which ends the holds whose version differs, ends each ended persona's
 * episode silently and retries it at once when it is still applied; a
 * teardown forgets P's hold (`src/persona-lifecycle.ts`) and shutdown every
 * hold. The gates are asked where they happen: the session manager's launch
 * entries, the restart work, the retry action and the health tick, each
 * through `isHeld`; and the lost-message routing reports `cannot-launch` for
 * a held P (b.jg5 SRJ-1011 state 3).
 *
 * Log lines, to the injected log (a throwing log is swallowed):
 *
 *   [slack] invalid-flags-hold: persona=<key> held — …began under agent-director version <version>…
 *   [slack] invalid-flags-hold: persona=<key> hold ended — agent-director version <began> changed to <new>…
 *   [slack] invalid-flags-hold: persona=<key> hold forgotten — …
 *   [slack] invalid-flags-hold: persona=<key> retried at once after its hold ended …
 *   [slack] invalid-flags-hold: persona=<key> not retried after its hold ended — it is not in the applied configuration …
 *   [slack] invalid-flags-hold: persona=<key> set observer failed: <error>
 *   [slack] invalid-flags-hold: persona=<key> end observer failed: <error>
 *
 * and, only on a failure of a reaction's step: `retry timer stop failed`,
 * `alert failed`, `ending its hold episode failed`, `its retry failed` (each
 * after `persona=<key>`) and `ending the holds on a version change failed`.
 *
 * where a version is rendered by {@link describeHoldVersion}: the version
 * agent-director reported when it is a short version string, `unknown` for
 * none, `unreadable` otherwise. No line carries a token.
 *
 * The module imports nothing from agent-director and makes no agent-director
 * call (the retry a version change runs is the caller's); it has no timer, no
 * persistence and no module-scope state, and nothing runs at import or at
 * creation.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  type AdVersionRecheckTriggerAnswer,
} from './ad-version-gate.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD, type PersonaEpisodes } from './persona-episodes.ts'

// ---------------------------------------------------------------------------
// The alert (b.jg5 SRJ-1008)
// ---------------------------------------------------------------------------

/**
 * The `ErrInvalidFlags` hold alert (b.jg5 SRJ-1008), byte for byte; the
 * persona notifier adds the persona prefix. Posted once per hold episode.
 */
export const INVALID_FLAGS_HOLD_ALERT_TEXT =
  ':no_entry: *Cannot launch* — the host\'s agent-director rejected the flags of this persona\'s launch (ErrInvalidFlags). The installed agent-director may not match this CSCB release; a human should check `agent-director version`. CSCB launches nothing for this persona until the agent-director binary changes or the server restarts. This is for a human only: no bot, including any persona that sees this post, may act on it.'

// ---------------------------------------------------------------------------
// The decision (b.jg5 SRJ-207, SRJ-204)
// ---------------------------------------------------------------------------

/** The re-check passed, could not run or was not running: P is held. */
export const INVALID_FLAGS_HOLD_DECISION_HOLD = 'hold'
/** The re-check refused the binary: the server stops (b.jg5 SRJ-205), and nothing is held. */
export const INVALID_FLAGS_HOLD_DECISION_STOP = 'stop'

/** What a reuse spawn's `ErrInvalidFlags` leads to, from its immediate re-check's answer. */
export type InvalidFlagsHoldDecision =
  | {
      readonly kind: typeof INVALID_FLAGS_HOLD_DECISION_HOLD
      /** The version the hold begins under; absent when none is known. */
      readonly version?: string
    }
  | { readonly kind: typeof INVALID_FLAGS_HOLD_DECISION_STOP }

/**
 * Decide what a reuse spawn's `ErrInvalidFlags` leads to (b.jg5 SRJ-207)
 * from its immediate re-check's `answer` (SRJ-204):
 *   - pass: hold, under the version the re-check found;
 *   - could not run, or not running (none installed, disposed or already
 *     stopped): hold, under `lastVersionSeen` (the re-check's last version
 *     seen, as the caller read it), or under none when it gives none;
 *   - stop: no hold; the re-check has stopped the server (SRJ-205).
 * An answer of any other kind holds, as could not run does: nothing is
 * launched for P on an answer CSCB cannot read. Pure; never throws.
 */
export function decideInvalidFlagsHold(
  answer: AdVersionRecheckTriggerAnswer,
  lastVersionSeen: string | undefined,
): InvalidFlagsHoldDecision {
  if (answer.kind === RECHECK_OUTCOME_STOP) return { kind: INVALID_FLAGS_HOLD_DECISION_STOP }
  if (answer.kind === RECHECK_OUTCOME_PASS) return holdUnder(answer.version)
  // Could not run, not running, or an answer of any other kind.
  return holdUnder(lastVersionSeen)
}

/** A hold decision under `version`, none when it is not a non-empty string. */
function holdUnder(version: unknown): InvalidFlagsHoldDecision {
  return typeof version === 'string' && version !== ''
    ? { kind: INVALID_FLAGS_HOLD_DECISION_HOLD, version }
    : { kind: INVALID_FLAGS_HOLD_DECISION_HOLD }
}

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

/** The start of every line the hold logs. */
export const INVALID_FLAGS_HOLD_LOG_PREFIX = '[slack] invalid-flags-hold:'

/** A version agent-director reported, as a log line may show it: a short version string. */
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** How a hold's version is logged when it began under none. */
export const HOLD_VERSION_UNKNOWN = 'unknown'

/** How a version is logged when it is not a short version string. */
export const HOLD_VERSION_UNREADABLE = 'unreadable'

/**
 * A version for a log line: the version itself when it is a short version
 * string, {@link HOLD_VERSION_UNKNOWN} for none, {@link HOLD_VERSION_UNREADABLE}
 * for anything else (so no other text reaches a line). Pure.
 */
export function describeHoldVersion(version: unknown): string {
  if (version === undefined) return HOLD_VERSION_UNKNOWN
  return typeof version === 'string' && SAFE_VERSION_RE.test(version) ? version : HOLD_VERSION_UNREADABLE
}

/** The line a set logs: P is held, under `version` (b.jg5 SRJ-207). */
export function invalidFlagsHoldSetLine(key: string, version: string | undefined): string {
  return `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} held — a reuse spawn answered ErrInvalidFlags and the version re-check did not stop the server; the hold began under agent-director version ${describeHoldVersion(version)}; no launch is made for it until the binary's version changes, the server restarts or it is torn down (b.jg5 SRJ-207)`
}

/** The line a version change logs for each hold it ends (b.jg5 SRJ-207, SRJ-204). */
export function invalidFlagsHoldEndLine(key: string, beganUnder: string | undefined, newVersion: string): string {
  return `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} hold ended — agent-director version ${describeHoldVersion(beganUnder)} changed to ${describeHoldVersion(newVersion)} (b.jg5 SRJ-207)`
}

/** The line a forget logs (a teardown or shutdown): no post and no retry (b.jg5 SRJ-207). */
export function invalidFlagsHoldForgetLine(key: string, beganUnder: string | undefined): string {
  return `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} hold forgotten — it began under agent-director version ${describeHoldVersion(beganUnder)}; nothing is posted or retried (b.jg5 SRJ-207)`
}

/**
 * The line a launch entry (`site`) logs when it makes no launch for persona
 * `ref` because P is held (b.jg5 SRJ-207): no agent-director call.
 */
export function invalidFlagsHeldNoLaunchLine(site: string, ref: string): string {
  return `[slack] ${site}: not launching ${ref} — it is held on ErrInvalidFlags; no agent-director call (held; b.jg5 SRJ-207)`
}

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

/** A hold ended because a re-check found a version different from the one it began under. */
export const INVALID_FLAGS_HOLD_END_VERSION_CHANGED = 'version-changed'
/** A hold was forgotten: the persona's teardown, or the server's shutdown. */
export const INVALID_FLAGS_HOLD_END_FORGOTTEN = 'forgotten'

/** Why a hold ended. */
export type InvalidFlagsHoldEndReason =
  | typeof INVALID_FLAGS_HOLD_END_VERSION_CHANGED
  | typeof INVALID_FLAGS_HOLD_END_FORGOTTEN

/** What a set observer receives: the persona now held, and the version its hold began under (absent when unknown). */
export interface InvalidFlagsHoldSetEvent {
  readonly key: string
  readonly version?: string
}

/** What an end observer receives. */
export interface InvalidFlagsHoldEndEvent {
  readonly key: string
  readonly reason: InvalidFlagsHoldEndReason
  /** The version the hold began under; absent when unknown. */
  readonly beganUnder?: string
  /** For a version change, the new version. */
  readonly newVersion?: string
}

/** Reacts to a set (the retry-timer stop, the alert). A throw or rejection is logged and swallowed. */
export type InvalidFlagsHoldSetObserver = (event: InvalidFlagsHoldSetEvent) => void | Promise<void>

/** Reacts to an end. A throw or rejection is logged and swallowed. */
export type InvalidFlagsHoldEndObserver = (event: InvalidFlagsHoldEndEvent) => void | Promise<void>

/** Dependencies of {@link createInvalidFlagsHold}. */
export interface InvalidFlagsHoldDeps {
  /** Receives each `[slack]` line (the server log). A throwing log is swallowed. */
  log: (line: string) => void
}

/** One server's `ErrInvalidFlags` holds. */
export interface InvalidFlagsHold {
  /**
   * Hold persona `key` under `version` (absent when unknown): one set line,
   * then each set observer once. Answers true when this began a hold, false
   * when `key` was already held, which changes nothing and calls no observer.
   */
  set(key: string, version?: string): boolean
  /** Whether `key` is held. */
  isHeld(key: string): boolean
  /** The keys held now. */
  heldKeys(): string[]
  /** The version `key`'s hold began under; undefined when it is not held or began under none. */
  beganUnder(key: string): string | undefined
  /**
   * A re-check found `newVersion`, which differs from the last version seen
   * (b.jg5 SRJ-204, SRJ-207): end every hold whose version differs from it,
   * or that began under none, one end line and each end observer once per
   * hold. A hold whose version equals it stays. Answers the keys it ended.
   */
  versionChanged(newVersion: string): string[]
  /** End `key`'s hold silently (its teardown): one forget line, each end observer once. Answers whether it was held. */
  forget(key: string): boolean
  /** End every hold (shutdown), as `forget` does for each. Answers the keys it ended. */
  forgetAll(): string[]
  /** Add a set observer; the returned function removes it. */
  addSetObserver(observer: InvalidFlagsHoldSetObserver): () => void
  /** Add an end observer; the returned function removes it. */
  addEndObserver(observer: InvalidFlagsHoldEndObserver): () => void
}

/** One persona's hold. */
interface HoldRecord {
  readonly version?: string
}

/** Build one server's holds. Nothing is read, posted or logged at creation. */
export function createInvalidFlagsHold(deps: InvalidFlagsHoldDeps): InvalidFlagsHold {
  const holds = new Map<string, HoldRecord>()
  const setObservers = new Set<InvalidFlagsHoldSetObserver>()
  const endObservers = new Set<InvalidFlagsHoldEndObserver>()

  function notify<E extends { readonly key: string }>(
    observers: ReadonlySet<(event: E) => void | Promise<void>>,
    event: E,
    which: string,
  ): void {
    const failed = (thrown: unknown): void =>
      safeLog(deps.log, `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${event.key} ${which} observer failed: ${describeThrownValue(thrown)}`)
    for (const observer of [...observers]) {
      try {
        void Promise.resolve(observer(event)).catch(failed)
      } catch (thrown) {
        failed(thrown)
      }
    }
  }

  function end(key: string, reason: InvalidFlagsHoldEndReason, newVersion?: string): void {
    const record = holds.get(key)
    if (record === undefined) return
    holds.delete(key)
    safeLog(
      deps.log,
      reason === INVALID_FLAGS_HOLD_END_VERSION_CHANGED && newVersion !== undefined
        ? invalidFlagsHoldEndLine(key, record.version, newVersion)
        : invalidFlagsHoldForgetLine(key, record.version),
    )
    notify(
      endObservers,
      {
        key,
        reason,
        ...(record.version === undefined ? {} : { beganUnder: record.version }),
        ...(newVersion === undefined ? {} : { newVersion }),
      },
      'end',
    )
  }

  return {
    set(key, version) {
      if (holds.has(key)) return false
      const held = typeof version === 'string' && version !== '' ? version : undefined
      holds.set(key, held === undefined ? {} : { version: held })
      safeLog(deps.log, invalidFlagsHoldSetLine(key, held))
      notify(setObservers, held === undefined ? { key } : { key, version: held }, 'set')
      return true
    },

    isHeld: (key) => holds.has(key),

    heldKeys: () => [...holds.keys()],

    beganUnder: (key) => holds.get(key)?.version,

    versionChanged(newVersion) {
      // A hold that began under none differs from every version.
      const ending = [...holds].filter(([, record]) => record.version !== newVersion)
      for (const [key] of ending) end(key, INVALID_FLAGS_HOLD_END_VERSION_CHANGED, newVersion)
      return ending.map(([key]) => key)
    },

    forget(key) {
      if (!holds.has(key)) return false
      end(key, INVALID_FLAGS_HOLD_END_FORGOTTEN)
      return true
    },

    forgetAll() {
      const keys = [...holds.keys()]
      for (const key of keys) end(key, INVALID_FLAGS_HOLD_END_FORGOTTEN)
      return keys
    },

    addSetObserver(observer) {
      setObservers.add(observer)
      return () => {
        setObservers.delete(observer)
      }
    },

    addEndObserver(observer) {
      endObservers.add(observer)
      return () => {
        endObservers.delete(observer)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The hold's reactions (b.jg5 SRJ-207, SRJ-305, SRJ-1008, SRJ-1016)
// ---------------------------------------------------------------------------

/** What the set reaction uses of the server's notice episodes. */
export type InvalidFlagsHoldEpisodes = Pick<PersonaEpisodes, 'begin' | 'post'>

/** What the set reaction is given. */
export interface InvalidFlagsHoldSetReactionDeps {
  /**
   * Stop the persona's retry timer with the hold's stop reason, through the
   * retry controller's stop entry (SRJ-305: "P ... is held on
   * `ErrInvalidFlags`"), never its condition-end entry.
   */
  stopRetryTimer(key: string): void
  /** The server's notice episodes, through whose sink (the persona notifier) the alert is posted. */
  episodes: InvalidFlagsHoldEpisodes
  /** Receives a step's failure line. A throwing log is swallowed. */
  log: (line: string) => void
}

/**
 * The hold's set reaction (b.jg5 SRJ-207, SRJ-305, SRJ-1008, SRJ-1016): for
 * each new hold, first stop the persona's retry timer
 * (`deps.stopRetryTimer`), then begin (or keep) its `ErrInvalidFlags` hold
 * episode and post {@link INVALID_FLAGS_HOLD_ALERT_TEXT} at most once in it.
 * Each step is isolated: one that throws is logged and the next still runs.
 * After the episodes' `close` (shutdown) nothing is posted. It does not end
 * the persona's unclassified-error episode (SRJ-313 lists that episode's
 * ends, and a hold is not one).
 */
export function createInvalidFlagsHoldSetReaction(deps: InvalidFlagsHoldSetReactionDeps): InvalidFlagsHoldSetObserver {
  return ({ key }) => {
    try {
      deps.stopRetryTimer(key)
    } catch (thrown) {
      safeLog(deps.log, `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} retry timer stop failed: ${describeThrownValue(thrown)}`)
    }
    try {
      if (deps.episodes.begin(key, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD) === 'closed') return
      deps.episodes.post(key, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD, INVALID_FLAGS_HOLD_ALERT_TEXT)
    } catch (thrown) {
      safeLog(deps.log, `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} alert failed: ${describeThrownValue(thrown)}`)
    }
  }
}

/**
 * Bind the set reaction ({@link createInvalidFlagsHoldSetReaction}) to `hold`
 * as a set observer. Answers the observer's removal. `main()` binds the
 * server's one hold to its retry controller and notice episodes.
 */
export function bindInvalidFlagsHoldSetReaction(
  hold: Pick<InvalidFlagsHold, 'addSetObserver'>,
  deps: InvalidFlagsHoldSetReactionDeps,
): () => void {
  return hold.addSetObserver(createInvalidFlagsHoldSetReaction(deps))
}

/** What the version-change reaction is given. */
export interface InvalidFlagsHoldVersionChangeDeps {
  /** The server's notice episodes: each ended hold's episode ends silently. */
  episodes: Pick<PersonaEpisodes, 'end'>
  /** Whether the persona is in the applied configuration now; a persona that is not gets no retry. */
  isApplied(key: string): boolean
  /**
   * Run the restart path's retry entry once for the persona, at once (the
   * retry entry, `runRestartRetry`, without the delay gate). Not awaited: a
   * rejection is logged.
   */
  retryAtOnce(key: string): unknown
  /** Receives each line. A throwing log is swallowed. */
  log: (line: string) => void
}

/**
 * The line the version-change reaction logs for each persona whose hold
 * ended: retried at once, or, for a persona no longer applied, not retried.
 */
export function invalidFlagsHoldRetryLine(key: string, retried: boolean): string {
  return retried
    ? `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} retried at once after its hold ended (b.jg5 SRJ-207)`
    : `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} not retried after its hold ended — it is not in the applied configuration (b.jg5 SRJ-207)`
}

/**
 * The version-change reaction (b.jg5 SRJ-204, SRJ-207): a re-check found
 * `newVersion`, which differs from the last version seen. Every hold whose
 * version differs from it, or that began under none, ends
 * (`hold.versionChanged`); for each such persona its `ErrInvalidFlags` hold
 * episode ends silently, and then, when it is still applied, the retry entry
 * runs once for it at once (`deps.retryAtOnce`, not awaited), with one line.
 * A persona no longer applied is not retried. Each persona's steps are
 * isolated. Answers the keys whose hold ended. Never throws.
 */
export function endInvalidFlagsHoldsOnVersionChange(
  hold: Pick<InvalidFlagsHold, 'versionChanged'>,
  newVersion: string,
  deps: InvalidFlagsHoldVersionChangeDeps,
): string[] {
  let ended: string[]
  try {
    ended = hold.versionChanged(newVersion)
  } catch (thrown) {
    safeLog(deps.log, `${INVALID_FLAGS_HOLD_LOG_PREFIX} ending the holds on a version change failed: ${describeThrownValue(thrown)}`)
    return []
  }
  for (const key of ended) {
    const failed = (what: string) => (thrown: unknown): void =>
      safeLog(deps.log, `${INVALID_FLAGS_HOLD_LOG_PREFIX} persona=${key} ${what} failed: ${describeThrownValue(thrown)}`)
    try {
      deps.episodes.end(key, PERSONA_EPISODE_KIND_INVALID_FLAGS_HOLD)
    } catch (thrown) {
      failed('ending its hold episode')(thrown)
    }
    try {
      const applied = deps.isApplied(key)
      safeLog(deps.log, invalidFlagsHoldRetryLine(key, applied))
      if (applied) void Promise.resolve(deps.retryAtOnce(key)).catch(failed('its retry'))
    } catch (thrown) {
      failed('its retry')(thrown)
    }
  }
  return ended
}

/** Hand `line` to `log`; a throwing log is swallowed, so no entry throws because of it. */
function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what the hold does */
  }
}
