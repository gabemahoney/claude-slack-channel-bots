/**
 * ad-version-gate.ts — CSCB's own Phase 1 floor for the agent-director binary.
 *
 * Role: holds the one named Phase 1 floor constant (b.jg5 SRJ-201), the floor
 * comparison over a version string (b.jg5 SRJ-202), the title of the README
 * switch-over runbook section that CSCB's gate messages point the operator to,
 * the `ad-below-phase1-floor` message (b.jg5 SRJ-203, SRJ-208, SRJ-1013)
 * and the `ad-system-install-too-old` message for the client's own too-old
 * refusal (b.jg5 SRJ-208), each in a startup and a runtime form, and the
 * runtime re-check of the host binary (b.jg5 SRJ-204, SRJ-205).
 *
 * This check sits beside the agent-director client's own too-old refusal
 * (client minimum 0.7.0) and gates on the version alone. The 0.10.0 client
 * ranks its `0.0.0-dev` sentinel above every version, so `Client.create()`
 * admits it; this module has no such special case and refuses it on its own.
 *
 * Parse rule mirrors the 0.10.0 client's strict SemVer parser (which the
 * client does not export): `major.minor.patch`, optional `-prerelease`, no
 * leading `v`, no `+build` metadata, no whitespace trimming. A version that
 * does not parse never passes (fail closed). There is no development override.
 *
 * Runtime re-check (b.jg5 SRJ-204): every {@link AD_VERSION_RECHECK_INTERVAL_MS}
 * on its own serialized, self-re-arming timer (the `src/reload-timer.ts`
 * pattern; never `setInterval`), whatever `health_check_interval` is, the
 * server calls the injected `resolveSystemBinary()` once, bounded by
 * {@link AD_VERSION_RECHECK_TIME_LIMIT_MS} on the injected clock, and
 * {@link decideAdVersionRecheckOutcome} maps the settled call to one outcome:
 * pass (the version becomes the last version seen), stop (below the floor or
 * unparseable: `ad-below-phase1-floor`; the client's too-old refusal:
 * `ad-system-install-too-old`) or could not run (nothing changes). A stop
 * ends the chain, records one startup-errors entry and calls the stop
 * callback with {@link AD_VERSION_RECHECK_STOP_EXIT_CODE} (b.jg5 SRJ-205).
 * After each timed re-check that did not stop, the tick listeners run (the
 * hook agent-director's timing settings are re-read from; b.jg5 SRJ-209).
 * `main()` (`src/server.ts`) installs it through {@link installAdVersionRecheck}
 * right after the startup gate passes, and `shutdown()` disposes it through
 * {@link disposeAdVersionRecheck}.
 *
 * agent-director errors are classified by name (their `errName`, else `name`,
 * read as a string) and their fields are read structurally: no `instanceof`
 * and no value import from `agent-director`. The module starts no process and
 * reads no file of its own (the too-old stop's install-skill block comes from
 * `install-skill-pointer.ts`, which reads CSCB's own `package.json` once, at
 * its first render). Nothing is armed, read or logged at import or at
 * {@link createAdVersionRecheck}; the module-level state is a handle, a
 * disposed flag and the tick-listener registry, cleared by
 * {@link resetAdVersionRecheckForTests}.
 *
 * Later Epics extend this module: E5 adds the host-version decision.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ResolveSystemBinaryResult } from 'agent-director'

import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD } from './install-check.ts'
import { renderInstallSkillInstructions } from './install-skill-pointer.ts'
import { describeThrownValue, isSafeIdentifier } from './persona-connection-errors.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

/**
 * CSCB's Phase 1 floor: the Phase 1 agent-director release's version.
 *
 * b.jg5 SRJ-201 RESEARCH NEEDED: the value below is the working default (the
 * minor bump over 0.10.x). E37 confirms it from the release candidate and E51 from
 * the release.
 */
export const PHASE1_FLOOR_VERSION = '0.11.0'

/**
 * Title of the README runbook section for switching over to agent-director
 * Phase 1. Every message, test, doc and later Epic that names the section
 * takes the title from this constant.
 */
export const PHASE1_RUNBOOK_SECTION_TITLE = 'Switching over to agent-director Phase 1'

/**
 * The operator instruction every `ad-below-phase1-floor` entry carries
 * (b.jg5 SRJ-1013). It names the switch-over runbook and gives no instruction
 * to upgrade agent-director (b.jg5 SRJ-208).
 */
export const PHASE1_SWITCH_OVER_INSTRUCTION =
  'this CSCB release requires agent-director Phase 1 or later: follow the switch-over runbook in the README'

/** Strict SemVer rule, identical to the 0.10.0 client's parser regex. */
const STRICT_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

interface VersionCore {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * Parse `input` with the client's strict rule and return its
 * major.minor.patch, or `null` when it does not parse. Any pre-release suffix
 * is dropped. Unlike the client, `0.0.0-dev` gets no sentinel treatment: it
 * parses as `0.0.0`.
 */
function parseCore(input: string): VersionCore | null {
  const m = STRICT_SEMVER_RE.exec(input)
  if (m === null) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }
  return { major, minor, patch }
}

const FLOOR_CORE: VersionCore = (() => {
  const core = parseCore(PHASE1_FLOOR_VERSION)
  if (core === null) {
    throw new Error(`ad-version-gate: PHASE1_FLOOR_VERSION ${JSON.stringify(PHASE1_FLOOR_VERSION)} is not a strict SemVer version`)
  }
  return core
})()

/**
 * True when `version` meets CSCB's Phase 1 floor (b.jg5 SRJ-202).
 *
 * The version's major.minor.patch is compared numerically, part by part,
 * against the floor's; a pre-release suffix is ignored, so
 * `<floor>-rc.N` counts as `<floor>`. A version that does not parse under the
 * client's strict rule returns false. `0.0.0-dev` compares as `0.0.0` and is
 * refused.
 */
export function meetsPhase1Floor(version: string): boolean {
  const core = parseCore(version)
  if (core === null) return false
  if (core.major !== FLOOR_CORE.major) return core.major > FLOOR_CORE.major
  if (core.minor !== FLOOR_CORE.minor) return core.minor > FLOOR_CORE.minor
  return core.patch >= FLOOR_CORE.patch
}

/**
 * The phrase every runtime re-check refusal carries (b.jg5 SRJ-205,
 * SRJ-1013): the binary was found by the runtime re-check while the server
 * ran, not by the startup check. The startup forms never contain it.
 */
export const RUNTIME_RECHECK_PHRASE = 'found by a runtime re-check while the server was running'

/** A refusal found by the startup gate (the messages' default form). */
export const FOUND_BY_STARTUP_CHECK = 'startup-check'

/** A refusal found by the runtime re-check (b.jg5 SRJ-205). */
export const FOUND_BY_RUNTIME_RECHECK = 'runtime-recheck'

/** Which check found a refused binary; selects a refusal message's form. */
export type RefusalFoundBy = typeof FOUND_BY_STARTUP_CHECK | typeof FOUND_BY_RUNTIME_RECHECK

/** Token-free parts of a floor refusal. */
export interface BelowPhase1FloorParts {
  /** The binary's version as the client reported it (`binaryVersion`, or the re-check's `version`). */
  readonly foundVersion: string
  /** The resolved binary path the client runs. */
  readonly binaryPath: string
}

/**
 * The `ad-below-phase1-floor` message (b.jg5 SRJ-203, SRJ-205, SRJ-1013): the
 * version found, the version required (the floor or later, its release
 * candidates included), the binary path, which check found it,
 * {@link PHASE1_SWITCH_OVER_INSTRUCTION} and the runbook section's title.
 * The startup form (the default) says the startup check found it; the runtime
 * form carries {@link RUNTIME_RECHECK_PHRASE} and says the server stopped.
 * Neither carries an instruction to upgrade agent-director, an install or
 * upgrade command or an install-skill block (b.jg5 SRJ-208). Built from
 * versions, a path and fixed text only.
 */
export function buildBelowPhase1FloorMessage(
  parts: BelowPhase1FloorParts,
  foundBy: RefusalFoundBy = FOUND_BY_STARTUP_CHECK,
): string {
  return (
    `agent-director version ${parts.foundVersion} is below CSCB's Phase 1 floor: ` +
    `version ${PHASE1_FLOOR_VERSION} or later is required ` +
    `(release candidates ${PHASE1_FLOOR_VERSION}-rc.N included). ` +
    `Binary at ${parts.binaryPath}; ${foundBySentence(foundBy)}. ` +
    `Note: ${PHASE1_SWITCH_OVER_INSTRUCTION} (section "${PHASE1_RUNBOOK_SECTION_TITLE}").`
  )
}

/** The floor message's "which check found it" clause. */
function foundBySentence(foundBy: RefusalFoundBy): string {
  return foundBy === FOUND_BY_RUNTIME_RECHECK
    ? `${RUNTIME_RECHECK_PHRASE}, so the server stopped`
    : 'found by the startup check'
}

/** Token-free parts of the client's own too-old refusal (`ErrSystemInstallTooOld`). */
export interface SystemInstallTooOldParts {
  /** The binary's version as the error reports it (`actualVersion`). */
  readonly foundVersion: string
  /** The agent-director client's minimum as the error reports it (`requiredVersion`). */
  readonly requiredVersion: string
  /** The resolved binary path the error reports. */
  readonly binaryPath: string
}

/**
 * The `ad-system-install-too-old` message (b.jg5 SRJ-208): the version found,
 * the version the client requires (its minimum, taken from the error), that
 * this CSCB release needs {@link PHASE1_FLOOR_VERSION} or later (release
 * candidates included) so the operator does not install a version between
 * the two and meet the floor refusal next, the binary path, that this CSCB
 * release and agent-director Phase 1 are installed together, and the
 * switch-over runbook section's title as the way to install agent-director. It carries no
 * instruction to upgrade agent-director and no install or upgrade command,
 * because the runbook's `state.db` backup and `serve` restarts must come with
 * the install. The startup form (the default) names no check; the runtime
 * form adds {@link RUNTIME_RECHECK_PHRASE} and that the server stopped
 * (b.jg5 SRJ-205). The install-skill block is not part of this text: the
 * startup gate and the runtime re-check each append it. Built from versions,
 * a path and fixed text only.
 */
export function buildSystemInstallTooOldMessage(
  parts: SystemInstallTooOldParts,
  foundBy: RefusalFoundBy = FOUND_BY_STARTUP_CHECK,
): string {
  const found = foundBy === FOUND_BY_RUNTIME_RECHECK ? `; ${RUNTIME_RECHECK_PHRASE}, so the server stopped` : ''
  return (
    `agent-director system install is too old: version ${parts.foundVersion} is below ` +
    `the agent-director client's minimum; version ${parts.requiredVersion} or later is required ` +
    `by the client, and this CSCB release needs ${PHASE1_FLOOR_VERSION} or later ` +
    `(release candidates included). ` +
    `Binary at ${parts.binaryPath}${found}. ` +
    `This CSCB release and agent-director Phase 1 are installed together: ` +
    `install agent-director by following the switch-over runbook in the README ` +
    `(section "${PHASE1_RUNBOOK_SECTION_TITLE}").`
  )
}

// ---------------------------------------------------------------------------
// Runtime re-check: the outcome of one call (b.jg5 SRJ-204)
// ---------------------------------------------------------------------------

/** The agent-director client's too-old refusal, by name. */
const ERR_SYSTEM_INSTALL_TOO_OLD = 'ErrSystemInstallTooOld'

/** The agent-director client's unreachable-binary refusal, by name. */
const ERR_SYSTEM_INSTALL_UNREACHABLE = 'ErrSystemInstallUnreachable'

/** Placeholder for a field an error or result does not carry as a string. */
const UNKNOWN_FIELD = 'unknown'

/** An `ErrSystemInstallUnreachable` reason: a short lowercase, hyphenated word. */
const SAFE_REASON_RE = /^[a-z][a-z0-9-]{0,63}$/

/** The re-check found a passing binary. */
export const RECHECK_OUTCOME_PASS = 'pass'

/** The re-check refused the binary: the server stops (b.jg5 SRJ-205). */
export const RECHECK_OUTCOME_STOP = 'stop'

/** The re-check could not run: nothing changes (b.jg5 SRJ-206). */
export const RECHECK_OUTCOME_COULD_NOT_RUN = 'could-not-run'

/** The settled result of one `resolveSystemBinary()` call under the time limit. */
export type AdVersionRecheckCallResult =
  | { readonly kind: 'resolved'; readonly value: ResolveSystemBinaryResult }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timed-out'; readonly timeLimitMs: number }

/** The class label of a re-check stop's startup-errors entry. */
export type AdVersionRecheckStopClass = typeof AD_BELOW_PHASE1_FLOOR | typeof AD_SYSTEM_INSTALL_TOO_OLD

/** What one re-check decides (b.jg5 SRJ-204's table). */
export type AdVersionRecheckOutcome =
  | {
      readonly kind: typeof RECHECK_OUTCOME_PASS
      /** The version the binary reported; it becomes the last version seen. */
      readonly version: string
      /** The resolved binary path. */
      readonly binaryPath: string
    }
  | {
      readonly kind: typeof RECHECK_OUTCOME_STOP
      readonly classLabel: AdVersionRecheckStopClass
      /** The runtime form of the class's message (token-free). */
      readonly message: string
    }
  | {
      readonly kind: typeof RECHECK_OUTCOME_COULD_NOT_RUN
      /**
       * One token-free line: the error's name (for `ErrSystemInstallUnreachable`
       * also its reason and binary path), the thrown value's type, or the
       * time limit.
       */
      readonly description: string
    }

/** Read one property of any value without throwing (a getter may throw). */
function readField(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** A string field, or `undefined` when absent, empty or not a string. */
function stringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' && field !== '' ? field : undefined
}

/**
 * A thrown value's class name, read as a string: agent-director's canonical
 * `errName` when it has one, else its `name`. Never `instanceof`.
 */
function thrownName(value: unknown): string | undefined {
  return stringField(value, 'errName') ?? stringField(value, 'name')
}

/** A path as one token-free line: token- and URL-like text redacted, line breaks collapsed. */
function safePath(value: unknown): string {
  return typeof value === 'string' && value !== ''
    ? redactSlackLogText(value).replace(/[\r\n]+/g, ' ')
    : UNKNOWN_FIELD
}

/** The install-skill block the too-old entry ends with; empty if it cannot be rendered. */
function installSkillBlock(): string {
  try {
    return renderInstallSkillInstructions()
  } catch {
    // A CSCB packaging bug; the stop must still happen, with the rest of the message.
    return ''
  }
}

/** The could-not-run description of a thrown or rejected value. */
function describeCouldNotRun(error: unknown): string {
  const name = thrownName(error)
  if (name === undefined || !isSafeIdentifier(name)) {
    if (error === null) return 'a thrown null'
    return typeof error === 'object' ? 'an error with no readable name' : `a thrown ${typeof error}`
  }
  if (name !== ERR_SYSTEM_INSTALL_UNREACHABLE) return name
  const reason = readField(error, 'reason')
  const safeReason = typeof reason === 'string' && SAFE_REASON_RE.test(reason) ? reason : UNKNOWN_FIELD
  return `${name} (reason ${safeReason}, binary at ${safePath(readField(error, 'binaryPath'))})`
}

/**
 * Decide what one settled `resolveSystemBinary()` call means (b.jg5 SRJ-204):
 *
 * - resolved with a version that meets {@link meetsPhase1Floor}: pass, with
 *   the version and path;
 * - resolved with a version below the floor or one CSCB cannot parse
 *   (`0.0.0-dev` included; fail closed): stop as `ad-below-phase1-floor`,
 *   with the runtime floor message;
 * - rejected with an error named `ErrSystemInstallTooOld`: stop as
 *   `ad-system-install-too-old`, with the runtime too-old message built from
 *   the error's `actualVersion`, `requiredVersion` and `binaryPath`, ending
 *   with the install-skill block;
 * - anything else (`ErrSystemInstallUnreachable`, `ErrSystemInstallNotFound`,
 *   any other named error, a non-error throw, the time limit expiring): could
 *   not run (b.jg5 SRJ-206).
 *
 * Pure: classifies by name, reads fields structurally, never throws.
 */
export function decideAdVersionRecheckOutcome(result: AdVersionRecheckCallResult): AdVersionRecheckOutcome {
  if (result.kind === 'timed-out') {
    return {
      kind: RECHECK_OUTCOME_COULD_NOT_RUN,
      description: `no answer within the ${result.timeLimitMs / 1000} s time limit`,
    }
  }
  if (result.kind === 'resolved') {
    const version = readField(result.value, 'version')
    const binaryPath = safePath(readField(result.value, 'path'))
    if (typeof version === 'string' && meetsPhase1Floor(version)) {
      return { kind: RECHECK_OUTCOME_PASS, version, binaryPath }
    }
    return {
      kind: RECHECK_OUTCOME_STOP,
      classLabel: AD_BELOW_PHASE1_FLOOR,
      message: buildBelowPhase1FloorMessage(
        { foundVersion: typeof version === 'string' ? version : UNKNOWN_FIELD, binaryPath },
        FOUND_BY_RUNTIME_RECHECK,
      ),
    }
  }
  const { error } = result
  if (thrownName(error) === ERR_SYSTEM_INSTALL_TOO_OLD) {
    return {
      kind: RECHECK_OUTCOME_STOP,
      classLabel: AD_SYSTEM_INSTALL_TOO_OLD,
      message:
        buildSystemInstallTooOldMessage(
          {
            foundVersion: stringField(error, 'actualVersion') ?? UNKNOWN_FIELD,
            requiredVersion: stringField(error, 'requiredVersion') ?? UNKNOWN_FIELD,
            binaryPath: safePath(readField(error, 'binaryPath')),
          },
          FOUND_BY_RUNTIME_RECHECK,
        ) + installSkillBlock(),
    }
  }
  return { kind: RECHECK_OUTCOME_COULD_NOT_RUN, description: describeCouldNotRun(error) }
}

// ---------------------------------------------------------------------------
// Runtime re-check: the 120 s timer (b.jg5 SRJ-204, SRJ-205, SRJ-209)
// ---------------------------------------------------------------------------

/**
 * Time from the end of one timed re-check to the start of the next, and from
 * the startup gate passing to the first (b.jg5 SRJ-204). Independent of
 * `health_check_interval`.
 */
export const AD_VERSION_RECHECK_INTERVAL_MS = 120_000

/**
 * The time limit on one `resolveSystemBinary()` call, on the injected clock.
 * Well above the client's own 5 s version probe plus its 2 s grace and well
 * below the interval. A call past it counts as could not run, and its later
 * answer is ignored.
 */
export const AD_VERSION_RECHECK_TIME_LIMIT_MS = 30_000

/** The exit code of a server stopped by the runtime re-check (b.jg5 SRJ-205). */
export const AD_VERSION_RECHECK_STOP_EXIT_CODE = 1

/** The timers the re-check arms (the shared fake clock satisfies it in tests). */
export type AdVersionRecheckClock = Pick<PersonaConnectionClock, 'setTimeout' | 'clearTimeout'>

/** The real timers. */
const REAL_TIMER_CLOCK: AdVersionRecheckClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Runs after each timed re-check that did not stop (b.jg5 SRJ-209's hook).
 * Not awaited: a returned promise's rejection is logged.
 */
export type AdVersionRecheckTickListener = () => void | Promise<void>

/** Dependencies of {@link createAdVersionRecheck}. */
export interface AdVersionRecheckDeps {
  /** agent-director's `resolveSystemBinary`; no default here (`main()` passes it in). */
  resolveSystemBinary: () => Promise<ResolveSystemBinaryResult>
  /** The version the startup gate read (its result's `adVersion`): the first last version seen. */
  baselineVersion: string
  /** Records a stop's startup-errors entry (and its server-log line); shaped like `recordStartupError`. */
  recordStartupError: (classLabel: string, message: string) => void
  /** Stops the server with the given exit code (`main()`: `shutdown`). */
  stop: (exitCode: number) => void
  /** Receives each `[slack]` line the re-check logs (the server log). */
  log: (line: string) => void
  /** Timers; the real ones by default. */
  clock?: AdVersionRecheckClock
  /** The tick listeners, read at each tick; none by default. */
  tickListeners?: () => readonly AdVersionRecheckTickListener[]
}

/** A runtime re-check built by {@link createAdVersionRecheck}. */
export interface AdVersionRecheck {
  /** Arm the first re-check, one interval from now; runs nothing at once. Single-use. */
  start(): void
  /** End the chain: clear every timer; a call in flight is never acted on. Idempotent. */
  dispose(): void
  /** The version of the last passing re-check, else the baseline. */
  lastVersionSeen(): string
}

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/**
 * Build the runtime re-check (b.jg5 SRJ-204); see the module comment.
 *
 * - `start` arms one timer and runs nothing at once. Each timed re-check makes
 *   one call under {@link AD_VERSION_RECHECK_TIME_LIMIT_MS} and feeds
 *   {@link decideAdVersionRecheckOutcome}; the next is armed
 *   {@link AD_VERSION_RECHECK_INTERVAL_MS} after it ends, so one timer is
 *   pending between re-checks and two calls are never in flight.
 * - Pass: the version becomes the last version seen. Could not run: nothing
 *   changes and nothing is logged.
 * - Stop: the chain ends, then `recordStartupError` is called once with the
 *   class and message, then `stop` once with
 *   {@link AD_VERSION_RECHECK_STOP_EXIT_CODE}. Nothing more runs.
 * - After each timed re-check that did not stop, the next timer is armed and
 *   then each tick listener runs; a listener that throws or rejects is logged
 *   as one token-free line. Never on a stopping tick or after `dispose`.
 *
 * Nothing is armed, read or logged here.
 */
export function createAdVersionRecheck(deps: AdVersionRecheckDeps): AdVersionRecheck {
  const clock = deps.clock ?? REAL_TIMER_CLOCK
  let lastVersionSeen = deps.baselineVersion
  let started = false
  let ended = false
  let timer: TimerBox | undefined
  let limitTimer: TimerBox | undefined
  let inFlight: Promise<AdVersionRecheckCallResult> | undefined

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not break the chain */
    }
  }

  function clearTimer(box: TimerBox | undefined): void {
    if (box !== undefined) clock.clearTimeout(box.handle)
  }

  /** End the chain: no timer pending, no call in flight acted on, nothing re-armed. */
  function endChain(): void {
    ended = true
    clearTimer(timer)
    timer = undefined
    clearTimer(limitTimer)
    limitTimer = undefined
    inFlight = undefined
  }

  function arm(): void {
    const box: TimerBox = { handle: undefined }
    timer = box
    box.handle = clock.setTimeout(() => {
      if (timer !== box) return
      timer = undefined
      void runTimedRecheck()
    }, AD_VERSION_RECHECK_INTERVAL_MS)
  }

  /**
   * The one `resolveSystemBinary()` call in flight, started if there is none,
   * settled at the latest at the time limit. Never rejects.
   */
  function callUnderTimeLimit(): Promise<AdVersionRecheckCallResult> {
    if (inFlight !== undefined) return inFlight
    const call = new Promise<AdVersionRecheckCallResult>((resolve) => {
      const box: TimerBox = { handle: undefined }
      let settled = false
      const finish = (result: AdVersionRecheckCallResult): void => {
        if (settled) return // a call past its time limit: its answer is ignored
        settled = true
        if (limitTimer === box) {
          limitTimer = undefined
          clock.clearTimeout(box.handle)
        }
        if (inFlight === call) inFlight = undefined
        resolve(result)
      }
      limitTimer = box
      box.handle = clock.setTimeout(() => {
        if (limitTimer === box) limitTimer = undefined
        finish({ kind: 'timed-out', timeLimitMs: AD_VERSION_RECHECK_TIME_LIMIT_MS })
      }, AD_VERSION_RECHECK_TIME_LIMIT_MS)
      let pending: Promise<ResolveSystemBinaryResult>
      try {
        pending = Promise.resolve(deps.resolveSystemBinary())
      } catch (thrown) {
        pending = Promise.reject(thrown)
      }
      pending.then(
        (value) => finish({ kind: 'resolved', value }),
        (rejected: unknown) => finish({ kind: 'rejected', error: rejected }),
      )
    })
    inFlight = call
    return call
  }

  function stopServer(classLabel: AdVersionRecheckStopClass, message: string): void {
    endChain()
    try {
      deps.recordStartupError(classLabel, message)
    } catch (err) {
      log(`[slack] agent-director version re-check: recording the refusal failed: ${describeThrownValue(err)}; stopping the server anyway`)
    }
    try {
      deps.stop(AD_VERSION_RECHECK_STOP_EXIT_CODE)
    } catch (err) {
      log(`[slack] agent-director version re-check: the stop callback threw: ${describeThrownValue(err)}`)
    }
  }

  /** Log a tick listener that threw or rejected, as one token-free line. */
  function logTickListenerFailure(err: unknown): void {
    log(`[slack] agent-director version re-check: a tick listener failed: ${describeThrownValue(err)}; the re-check carries on`)
  }

  function runTickListeners(): void {
    const listeners = deps.tickListeners?.() ?? []
    for (const listener of listeners) {
      if (ended) return
      try {
        const returned = listener()
        if (returned !== undefined && typeof (returned as { then?: unknown }).then === 'function') {
          ;(returned as Promise<void>).then(undefined, (err: unknown) => logTickListenerFailure(err))
        }
      } catch (err) {
        logTickListenerFailure(err)
      }
    }
  }

  /** One timed re-check, then the next arm and the tick listeners unless it stopped or was disposed. Never rejects. */
  async function runTimedRecheck(): Promise<void> {
    const result = await callUnderTimeLimit()
    if (ended) return
    const outcome = decideAdVersionRecheckOutcome(result)
    if (outcome.kind === RECHECK_OUTCOME_STOP) {
      stopServer(outcome.classLabel, outcome.message)
      return
    }
    if (outcome.kind === RECHECK_OUTCOME_PASS) lastVersionSeen = outcome.version
    arm()
    runTickListeners()
  }

  return {
    start() {
      if (started) {
        log('[slack] agent-director version re-check: start() called more than once — ignoring (the re-check is single-use)')
        return
      }
      if (ended) {
        log('[slack] agent-director version re-check: start() called after dispose() — ignoring (the re-check is single-use)')
        return
      }
      started = true
      arm()
    },
    dispose() {
      endChain()
    },
    lastVersionSeen() {
      return lastVersionSeen
    },
  }
}

// ---------------------------------------------------------------------------
// Runtime re-check: the module-level install (server.ts)
// ---------------------------------------------------------------------------

/** The installed re-check, if any. */
let installedRecheck: AdVersionRecheck | undefined

/** Set by {@link disposeAdVersionRecheck}: no later install arms anything. */
let recheckDisposed = false

/** Registered tick listeners; one entry per registration, so each unsubscribe removes only its own. */
const tickListenerEntries = new Set<{ readonly listener: AdVersionRecheckTickListener }>()

function registeredTickListeners(): readonly AdVersionRecheckTickListener[] {
  return [...tickListenerEntries].map((entry) => entry.listener)
}

/**
 * Build and start the server's runtime re-check with the registered tick
 * listeners (b.jg5 SRJ-204). `main()` calls it once, right after the startup
 * gate passes. A second install, or one after {@link disposeAdVersionRecheck},
 * is a logged no-op returning the installed handle (or `undefined`).
 */
export function installAdVersionRecheck(
  deps: Omit<AdVersionRecheckDeps, 'tickListeners'>,
): AdVersionRecheck | undefined {
  if (recheckDisposed) {
    deps.log('[slack] agent-director version re-check: install after dispose — ignoring (the server is shutting down)')
    return undefined
  }
  if (installedRecheck !== undefined) {
    deps.log('[slack] agent-director version re-check: already installed — ignoring the second install')
    return installedRecheck
  }
  const recheck = createAdVersionRecheck({ ...deps, tickListeners: registeredTickListeners })
  installedRecheck = recheck
  recheck.start()
  return recheck
}

/**
 * Dispose the installed re-check (`shutdown()` calls it): its timers are
 * cleared, a call in flight is never acted on and no later install arms
 * anything. Idempotent; a no-op when nothing is installed.
 */
export function disposeAdVersionRecheck(): void {
  recheckDisposed = true
  installedRecheck?.dispose()
}

/**
 * Register a listener run after each timed re-check that did not stop
 * (b.jg5 SRJ-209). Independent of install order. Returns its unsubscribe.
 */
export function onAdVersionRecheckTick(listener: AdVersionRecheckTickListener): () => void {
  const entry = { listener }
  tickListenerEntries.add(entry)
  return () => {
    tickListenerEntries.delete(entry)
  }
}

/**
 * @internal Test-only: dispose any installed re-check and clear the
 * module-level state (the handle, the disposed flag, every tick listener).
 */
export function resetAdVersionRecheckForTests(): void {
  installedRecheck?.dispose()
  installedRecheck = undefined
  recheckDisposed = false
  tickListenerEntries.clear()
}
