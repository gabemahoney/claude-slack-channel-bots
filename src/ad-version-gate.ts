/**
 * ad-version-gate.ts — CSCB's own Phase 1 floor for the agent-director binary.
 *
 * Role: holds the one named Phase 1 floor constant (b.jg5 SRJ-201), the floor
 * comparison over a version string (b.jg5 SRJ-202), the title of the README
 * switch-over runbook section that CSCB's gate messages point the operator to,
 * the `ad-below-phase1-floor` message (b.jg5 SRJ-203, SRJ-208, SRJ-1013)
 * and the `ad-system-install-too-old` message for the client's own too-old
 * refusal (b.jg5 SRJ-208), each in a startup and a runtime form, the
 * runtime re-check of the host binary (b.jg5 SRJ-204, SRJ-205), the
 * host-version decision (b.jg5 SRJ-211, SRJ-212) and the Phase 1 notes its
 * callers build: {@link buildPhase1HostNote} for `/publish` and
 * {@link buildInstallCheckPhase1Note} for the install check.
 *
 * The floor check sits beside the agent-director client's own too-old refusal
 * (client minimum 0.7.0) and gates on the version alone. The 0.10.0 client
 * ranks its `0.0.0-dev` sentinel above every version, so `Client.create()`
 * admits it; the floor has no such special case and refuses it on its own.
 *
 * Parse rule mirrors the 0.10.0 client's strict SemVer parser (which the
 * client does not export): `major.minor.patch`, optional `-prerelease`, no
 * leading `v`, no `+build` metadata, no whitespace trimming. A version that
 * does not parse never passes (fail closed). There is no development override.
 * {@link compareAdVersions} mirrors the client's version order (which it does
 * not export either), including its sentinel {@link CLIENT_DEV_SENTINEL_VERSION}.
 *
 * Host-version decision (b.jg5 SRJ-211, SRJ-212): {@link decideHostAdVersion}
 * judges one settled `resolveSystemBinary()` call against the installed
 * client's minimum (supplied by the caller) and then CSCB's floor: pass,
 * pass below the floor with a Phase 1 note naming the switch-over runbook
 * section ({@link buildPhase1HostNote} for `/publish`,
 * {@link buildInstallCheckPhase1Note} for the install check), or fail (not found, version
 * unreadable, below the client minimum, client minimum unreadable, other).
 * Its two callers are `/publish`'s preflight check `scripts/ad-version-check.ts`
 * (gate SR-2.5) and the install check in `src/install-check.ts`. Each
 * reads the client minimum and makes its own resolver call, settled by
 * {@link settleHostVersionCall}; the decision itself does neither. A version
 * that cannot be read fails with a short reason word:
 * agent-director's own reason, {@link UNREACHABLE_REASON_UNPARSEABLE_VERSION}
 * for a resolved version that does not parse, or
 * {@link UNREACHABLE_REASON_UNKNOWN} for a reason that is absent or not a
 * short safe word. The install check copies a thrown error's text fields into
 * its detail only through {@link redactToOneLine}.
 *
 * Runtime re-check (b.jg5 SRJ-204): every {@link AD_VERSION_RECHECK_INTERVAL_MS}
 * on its own serialized, self-re-arming timer (the `src/reload-timer.ts`
 * pattern; never `setInterval`), whatever `health_check_interval` is, the
 * server calls the injected `resolveSystemBinary()` once, bounded by
 * {@link AD_VERSION_RECHECK_TIME_LIMIT_MS} on the injected clock, and
 * {@link decideAdVersionRecheckOutcome} maps the settled call to one outcome:
 * pass (the version becomes the last version seen), stop (below the floor or
 * unparseable: `ad-below-phase1-floor`; the client's too-old refusal:
 * `ad-system-install-too-old`) or could not run (nothing changes; the first
 * of each run of them writes one server-log line, b.jg5 SRJ-206). A stop
 * ends the chain, records one startup-errors entry and calls the stop
 * callback with {@link AD_VERSION_RECHECK_STOP_EXIT_CODE} (b.jg5 SRJ-205).
 * After each timed re-check that did not stop, the tick listeners run
 * (b.jg5 SRJ-209: `installAdSettings` in `src/ad-settings.ts` re-reads
 * agent-director's timing settings from this hook).
 * {@link triggerAdVersionRecheck} re-checks at once and answers with the
 * outcome (b.jg5 SRJ-204). Its caller is the `ErrInvalidFlags` step in
 * `src/ad-error-class.ts` (SRJ-104), which the reuse spawn
 * (`reuseSpawnForPersona`, `src/session-manager.ts`; its answer decides the
 * `ErrInvalidFlags` hold, SRJ-207), the resume path of `resumeOrFreshSpawn`
 * (`src/session-manager.ts`) and the click handler's `decide`
 * (`src/permission-click-handler.ts`) run on an `ErrInvalidFlags`.
 * {@link onAdVersionChanged} listeners hear of each passing re-check whose
 * version differs from the last version seen; the `ErrInvalidFlags` hold
 * (`src/invalid-flags-hold.ts`, SRJ-207) is its consumer: `main()` ends every
 * hold whose version differs on it. {@link lastAdVersionSeen} answers the
 * installed re-check's last version seen, under which a hold begins when the
 * immediate re-check could not run.
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
 * disposed flag and the tick- and version-changed-listener registries, cleared by
 * {@link resetAdVersionRecheckForTests}.
 *
 * SPDX-License-Identifier: MIT
 */

import type { ResolveSystemBinaryResult, UnreachableReason } from 'agent-director'

import { AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD } from './install-check-labels.ts'
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

/**
 * The agent-director client's development sentinel version. Mirrors the
 * client's `DEV_SENTINEL_VERSION` (held here as a value so this module keeps
 * no value import from `agent-director`). The client ranks it above every
 * version ({@link compareAdVersions}); CSCB's Phase 1 floor refuses it
 * ({@link meetsPhase1Floor}).
 */
export const CLIENT_DEV_SENTINEL_VERSION = '0.0.0-dev'

interface VersionCore {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** A version under the client's strict rule: its core and its pre-release tag, if any. */
interface StrictVersion extends VersionCore {
  readonly prerelease: string | null
}

/**
 * Parse `input` with the client's strict rule, or return `null` when it does
 * not parse. Unlike the client, `0.0.0-dev` gets no sentinel treatment: it
 * parses as `0.0.0` with the pre-release tag `dev`.
 */
function parseStrict(input: string): StrictVersion | null {
  const m = STRICT_SEMVER_RE.exec(input)
  if (m === null) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }
  return { major, minor, patch, prerelease: m[4] ?? null }
}

/** A version as the client orders it: its sentinel, or a strictly parsed version. */
type ClientOrderedVersion = { readonly sentinel: true } | ({ readonly sentinel: false } & StrictVersion)

/** Parse `input` as the client does: exactly {@link CLIENT_DEV_SENTINEL_VERSION} is the sentinel. */
function parseClientVersion(input: string): ClientOrderedVersion | null {
  if (input === CLIENT_DEV_SENTINEL_VERSION) return { sentinel: true }
  const parsed = parseStrict(input)
  return parsed === null ? null : { sentinel: false, ...parsed }
}

/**
 * Compare two versions in the agent-director client's own order (the order
 * its too-old refusal applies against its minimum, b.jg5 SRJ-211): -1, 0 or
 * 1 as `a` is below, equal to or above `b`, or `null` when either does not
 * parse under the client's strict rule (a leading `v` included).
 *
 * - {@link CLIENT_DEV_SENTINEL_VERSION} ranks above every other version and
 *   equals itself;
 * - otherwise major, minor and patch compare numerically, part by part;
 * - with equal cores, a release ranks above its own pre-release, and two
 *   pre-release tags compare as strings.
 */
export function compareAdVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseClientVersion(a)
  const pb = parseClientVersion(b)
  if (pa === null || pb === null) return null
  if (pa.sentinel || pb.sentinel) {
    if (pa.sentinel && pb.sentinel) return 0
    return pa.sentinel ? 1 : -1
  }
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (pa[part] !== pb[part]) return pa[part] > pb[part] ? 1 : -1
  }
  if (pa.prerelease === pb.prerelease) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  return pa.prerelease > pb.prerelease ? 1 : -1
}

const FLOOR_CORE: VersionCore = (() => {
  const core = parseStrict(PHASE1_FLOOR_VERSION)
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
  const core = parseStrict(version)
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

/**
 * The reason word that stands for an `ErrSystemInstallUnreachable` reason
 * that is absent or is not a short safe word. Not one of agent-director's own
 * reasons, so it never passes for one (agent-director's `other` is a reason
 * the binary check itself gave).
 */
export const UNREACHABLE_REASON_UNKNOWN = UNKNOWN_FIELD

/**
 * The reason word of a version that does not parse: agent-director's own
 * `unparseable-version` reason, which the host-version decision also gives a
 * resolved version that does not parse under the client's strict rule.
 */
export const UNREACHABLE_REASON_UNPARSEABLE_VERSION: UnreachableReason = 'unparseable-version'

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

/**
 * Read one property of any value without throwing (a getter may throw):
 * `undefined` for a non-object, a missing property or a throwing getter.
 * Shared with the install check (`src/install-check.ts`), which reads a thrown
 * error's structural fields with it.
 */
export function readField(value: unknown, key: string): unknown {
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

/**
 * `text` as one token-free line: token- and URL-like text redacted
 * (`redactSlackLogText`), each run of line breaks collapsed to one space.
 * Shared with the install check (`src/install-check.ts`), which passes every
 * text it copies from a thrown error into its detail through it.
 */
export function redactToOneLine(text: string): string {
  return redactSlackLogText(text).replace(/[\r\n\u2028\u2029]+/g, ' ')
}

/** A string field (a path or a version) as one token-free line ({@link redactToOneLine}), else {@link UNKNOWN_FIELD}. */
function safeLine(value: unknown): string {
  return typeof value === 'string' && value !== '' ? redactToOneLine(value) : UNKNOWN_FIELD
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
  return `${name} (reason ${safeReason(error)}, binary at ${safeLine(readField(error, 'binaryPath'))})`
}

/** An `ErrSystemInstallUnreachable`'s reason when it is a short safe word, else {@link UNREACHABLE_REASON_UNKNOWN}. */
function safeReason(error: unknown): string {
  const reason = readField(error, 'reason')
  return typeof reason === 'string' && SAFE_REASON_RE.test(reason) ? reason : UNREACHABLE_REASON_UNKNOWN
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
    const binaryPath = safeLine(readField(result.value, 'path'))
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
            binaryPath: safeLine(readField(error, 'binaryPath')),
          },
          FOUND_BY_RUNTIME_RECHECK,
        ) + installSkillBlock(),
    }
  }
  return { kind: RECHECK_OUTCOME_COULD_NOT_RUN, description: describeCouldNotRun(error) }
}

// ---------------------------------------------------------------------------
// Host-version decision: /publish's preflight and the install check (b.jg5 SRJ-211, SRJ-212)
// ---------------------------------------------------------------------------

/** The agent-director client's no-binary-found refusal, by name. */
const ERR_SYSTEM_INSTALL_NOT_FOUND = 'ErrSystemInstallNotFound'

/** The host binary passes: at or above the client's minimum and CSCB's Phase 1 floor. */
export const HOST_VERSION_OUTCOME_PASS = 'pass'

/**
 * The host binary passes with the Phase 1 note: at or above the client's
 * minimum but below CSCB's Phase 1 floor (`0.10.0`, `0.0.0-dev`).
 */
export const HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR = 'pass-below-floor'

/** The host binary fails; the outcome's `failure` says why. */
export const HOST_VERSION_OUTCOME_FAIL = 'fail'

/** No agent-director binary was found (`ErrSystemInstallNotFound`). */
export const HOST_VERSION_FAIL_NOT_FOUND = 'not-found'

/**
 * The binary's version cannot be read: an `ErrSystemInstallUnreachable` of
 * any reason, or a resolved version the client's strict rule cannot parse (a
 * leading `v` included).
 */
export const HOST_VERSION_FAIL_VERSION_UNREADABLE = 'version-unreadable'

/**
 * The binary is below the client's minimum: an `ErrSystemInstallTooOld`, or
 * a resolved version below the supplied minimum.
 */
export const HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM = 'below-client-minimum'

/** The supplied client minimum does not parse under the client's strict rule, so nothing can be judged. */
export const HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE = 'client-minimum-unreadable'

/** Any other failure: another named error or a non-error throw. */
export const HOST_VERSION_FAIL_OTHER = 'other'

/** One settled `resolveSystemBinary()` call: the resolved path and version, or the thrown value. */
export type HostVersionCallResult = Exclude<AdVersionRecheckCallResult, { readonly kind: 'timed-out' }>

/** Why the host binary fails the host-version decision. Every field is token-free. */
export type HostVersionFailure =
  | { readonly kind: typeof HOST_VERSION_FAIL_NOT_FOUND }
  | {
      readonly kind: typeof HOST_VERSION_FAIL_VERSION_UNREADABLE
      /** The resolved binary path. */
      readonly binaryPath: string
      /**
       * One short safe word: the unreachable error's reason
       * ({@link UNREACHABLE_REASON_UNKNOWN} when it is absent or not a safe
       * word), or {@link UNREACHABLE_REASON_UNPARSEABLE_VERSION} for a
       * resolved version that does not parse.
       */
      readonly reason: string
      /** What was read: the unreachable error's reason, or the version that does not parse. */
      readonly detail: string
    }
  | {
      readonly kind: typeof HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM
      /** The binary's version. */
      readonly foundVersion: string
      /** The client's minimum (the error's `requiredVersion`, else the supplied minimum). */
      readonly requiredVersion: string
      /** The resolved binary path. */
      readonly binaryPath: string
    }
  | {
      readonly kind: typeof HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE
      /** The supplied minimum, as one token-free line. */
      readonly clientMinimum: string
    }
  | {
      readonly kind: typeof HOST_VERSION_FAIL_OTHER
      /** The thrown value's name, or its type when it has no readable name. */
      readonly description: string
    }

/** What the host-version decision decides (b.jg5 SRJ-211). */
export type HostVersionOutcome =
  | {
      readonly kind: typeof HOST_VERSION_OUTCOME_PASS | typeof HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR
      /** The binary's version (it parses under the client's strict rule). */
      readonly version: string
      /** The resolved binary path, as one token-free line. */
      readonly binaryPath: string
    }
  | { readonly kind: typeof HOST_VERSION_OUTCOME_FAIL; readonly failure: HostVersionFailure }

/**
 * Make one `resolveSystemBinary()` call and settle it for
 * {@link decideHostAdVersion}: the resolved value, or the thrown value (a
 * synchronous throw counts as a rejection). Never rejects. The one settle
 * step of both of the decision's callers (`scripts/ad-version-check.ts` and
 * `src/install-check.ts`).
 */
export async function settleHostVersionCall(
  resolve: () => Promise<ResolveSystemBinaryResult>,
): Promise<HostVersionCallResult> {
  try {
    return { kind: 'resolved', value: await resolve() }
  } catch (error) {
    return { kind: 'rejected', error }
  }
}

/** A failing outcome. */
function hostVersionFail(failure: HostVersionFailure): HostVersionOutcome {
  return { kind: HOST_VERSION_OUTCOME_FAIL, failure }
}

/** What one thrown or rejected `resolveSystemBinary()` value means, read by name. */
function hostVersionThrownFailure(error: unknown, clientMinimum: string): HostVersionFailure {
  const name = thrownName(error)
  if (name === ERR_SYSTEM_INSTALL_NOT_FOUND) return { kind: HOST_VERSION_FAIL_NOT_FOUND }
  if (name === ERR_SYSTEM_INSTALL_TOO_OLD) {
    return {
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: safeLine(readField(error, 'actualVersion')),
      requiredVersion: safeLine(stringField(error, 'requiredVersion') ?? clientMinimum),
      binaryPath: safeLine(readField(error, 'binaryPath')),
    }
  }
  if (name === ERR_SYSTEM_INSTALL_UNREACHABLE) {
    const reason = safeReason(error)
    return {
      kind: HOST_VERSION_FAIL_VERSION_UNREADABLE,
      binaryPath: safeLine(readField(error, 'binaryPath')),
      reason,
      detail: `reason ${reason}`,
    }
  }
  return { kind: HOST_VERSION_FAIL_OTHER, description: describeCouldNotRun(error) }
}

/**
 * The one host-version decision (b.jg5 SRJ-211; SRJ-212 reuses it): judge one
 * settled `resolveSystemBinary()` call against the installed client's
 * minimum (`min_binary_version`, supplied by the caller, never hard-coded
 * here), in the client's own order ({@link compareAdVersions}), then against
 * CSCB's Phase 1 floor ({@link meetsPhase1Floor}):
 *
 * - rejected, read by name: `ErrSystemInstallNotFound` fails not found;
 *   `ErrSystemInstallTooOld` fails below the client minimum, from its
 *   `actualVersion`, `requiredVersion` and `binaryPath`;
 *   `ErrSystemInstallUnreachable` (any reason) fails version unreadable,
 *   carrying the reason as a safe word;
 *   any other named error or non-error throw fails other;
 * - resolved, with a minimum that does not parse: fails client minimum
 *   unreadable;
 * - resolved with a version the client's strict rule cannot parse (a leading
 *   `v` included): fails version unreadable, reason
 *   {@link UNREACHABLE_REASON_UNPARSEABLE_VERSION};
 * - resolved below the minimum: fails below the client minimum;
 * - resolved at or above the minimum and meeting the floor: pass;
 * - resolved at or above the minimum but below the floor (`0.10.0`, the
 *   client's sentinel `0.0.0-dev`): pass below the floor; each caller
 *   builds its own Phase 1 note ({@link buildPhase1HostNote} for `/publish`,
 *   {@link buildInstallCheckPhase1Note} for the install check).
 *
 * Pure: classifies by name, reads fields structurally, never throws.
 */
export function decideHostAdVersion(result: HostVersionCallResult, clientMinimum: string): HostVersionOutcome {
  if (result.kind === 'rejected') return hostVersionFail(hostVersionThrownFailure(result.error, clientMinimum))
  if (parseClientVersion(clientMinimum) === null) {
    return hostVersionFail({ kind: HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE, clientMinimum: safeLine(clientMinimum) })
  }
  const version = readField(result.value, 'version')
  const binaryPath = safeLine(readField(result.value, 'path'))
  const order = typeof version === 'string' ? compareAdVersions(version, clientMinimum) : null
  if (typeof version !== 'string' || order === null) {
    const detail =
      typeof version === 'string'
        ? `version ${JSON.stringify(safeLine(version))} does not parse as a strict SemVer version`
        : 'no version string'
    return hostVersionFail({
      kind: HOST_VERSION_FAIL_VERSION_UNREADABLE,
      binaryPath,
      reason: UNREACHABLE_REASON_UNPARSEABLE_VERSION,
      detail,
    })
  }
  if (order < 0) {
    return hostVersionFail({
      kind: HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
      foundVersion: version,
      requiredVersion: clientMinimum,
      binaryPath,
    })
  }
  return {
    kind: meetsPhase1Floor(version) ? HOST_VERSION_OUTCOME_PASS : HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
    version,
    binaryPath,
  }
}

/**
 * The fixed phrase every Phase 1 host note carries (b.jg5 SRJ-211): this
 * CSCB release needs agent-director Phase 1 on the host.
 */
export const PHASE1_HOST_NOTE_PHRASE = 'this CSCB release needs agent-director Phase 1 on the host'

/**
 * The Phase 1 note for a host binary that passes below the floor (b.jg5
 * SRJ-211): the version found and its path, the floor, that
 * {@link PHASE1_HOST_NOTE_PHRASE}, that the binary meets the client's
 * minimum so it is accepted, and the switch-over runbook section's title
 * ({@link PHASE1_RUNBOOK_SECTION_TITLE}). No upgrade instruction, no command
 * and no link. Built from a version, a path and fixed text only.
 */
export function buildPhase1HostNote(parts: BelowPhase1FloorParts): string {
  return (
    `The host's agent-director ${parts.foundVersion} (binary at ${parts.binaryPath}) is below ` +
    `CSCB's Phase 1 floor ${PHASE1_FLOOR_VERSION} (release candidates ${PHASE1_FLOOR_VERSION}-rc.N included): ` +
    `${PHASE1_HOST_NOTE_PHRASE}. It meets the agent-director client's minimum, so it is accepted for now; ` +
    `the host switches over to Phase 1 by the README's runbook section "${PHASE1_RUNBOOK_SECTION_TITLE}".`
  )
}

/**
 * The fixed phrase every install-check Phase 1 note carries (b.jg5 SRJ-212):
 * the server refuses to start on the binary until agent-director Phase 1 is
 * installed.
 */
export const INSTALL_CHECK_PHASE1_NOTE_PHRASE =
  'the server refuses to start on it until agent-director Phase 1 is installed'

/**
 * The install check's Phase 1 note for a host binary that passes below the
 * floor (b.jg5 SRJ-212): the version found, CSCB's floor, that
 * {@link INSTALL_CHECK_PHASE1_NOTE_PHRASE}, and the switch-over runbook
 * section's title ({@link PHASE1_RUNBOOK_SECTION_TITLE}). No upgrade
 * instruction, no command and no link. Built from a version and fixed text
 * only. `runInstallCheck` (`src/install-check.ts`) carries it on its success
 * result; `/publish`'s check uses {@link buildPhase1HostNote} instead.
 */
export function buildInstallCheckPhase1Note(foundVersion: string): string {
  return (
    `agent-director ${foundVersion} meets the agent-director client's minimum but is below ` +
    `CSCB's Phase 1 floor ${PHASE1_FLOOR_VERSION} (release candidates ${PHASE1_FLOOR_VERSION}-rc.N included): ` +
    `${INSTALL_CHECK_PHASE1_NOTE_PHRASE}. ` +
    `See the README's switch-over runbook section "${PHASE1_RUNBOOK_SECTION_TITLE}".`
  )
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

/**
 * The start of the one server-log line a run of could-not-run re-checks
 * writes (b.jg5 SRJ-206, SRJ-1014). {@link buildAdVersionRecheckCouldNotRunLine}
 * builds the whole line.
 */
export const AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX =
  '[slack] agent-director version re-check: the runtime re-check could not run: '

/**
 * The one server-log line written at the first could-not-run re-check after
 * start or after a passing re-check (b.jg5 SRJ-206): it names the runtime
 * re-check, the failure's token-free `description` (from
 * {@link decideAdVersionRecheckOutcome}) and that the server keeps running and
 * checks again at the next {@link AD_VERSION_RECHECK_INTERVAL_MS} re-check.
 * Built from the description and fixed text only.
 */
export function buildAdVersionRecheckCouldNotRunLine(description: string): string {
  return (
    `${AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX}${description}; ` +
    `the server keeps running and checks again at the next ${AD_VERSION_RECHECK_INTERVAL_MS / 1000} s re-check`
  )
}

/** A trigger's answer when no re-check is running: none installed, not started, disposed or already stopped. */
export const RECHECK_OUTCOME_NOT_RUNNING = 'not-running'

/**
 * What a triggered re-check answers (b.jg5 SRJ-204, SRJ-104, SRJ-207): the
 * outcome it acted on (passed with the version, stopped, could not run), or
 * {@link RECHECK_OUTCOME_NOT_RUNNING} when no call was made or, at once, when
 * the re-check was disposed while the check it joined was in flight.
 */
export type AdVersionRecheckTriggerAnswer =
  | AdVersionRecheckOutcome
  | { readonly kind: typeof RECHECK_OUTCOME_NOT_RUNNING }

/** The one not-running answer. */
const NOT_RUNNING_ANSWER: AdVersionRecheckTriggerAnswer = Object.freeze({ kind: RECHECK_OUTCOME_NOT_RUNNING })

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

/**
 * Runs when a passing re-check (timed or triggered) finds a version that
 * differs from the last version seen, with that previous version and the new
 * one (b.jg5 SRJ-204's first row, SRJ-207). Not awaited: a returned promise's
 * rejection is logged.
 */
export type AdVersionChangedListener = (previousVersion: string, newVersion: string) => void | Promise<void>

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
  /** The version-changed listeners, read at each version change; none by default. */
  versionChangedListeners?: () => readonly AdVersionChangedListener[]
}

/** A runtime re-check built by {@link createAdVersionRecheck}. */
export interface AdVersionRecheck {
  /** Arm the first re-check, one interval from now; runs nothing at once. Single-use. */
  start(): void
  /**
   * End the chain: clear every timer; a call in flight is never acted on and
   * every trigger waiting on it answers {@link RECHECK_OUTCOME_NOT_RUNNING} at
   * once, without waiting for the call. Idempotent.
   */
  dispose(): void
  /** The version of the last passing re-check, else the baseline. */
  lastVersionSeen(): string
  /** True from `start` until `dispose` or a stop ends the chain. */
  isRunning(): boolean
  /**
   * Re-check at once (b.jg5 SRJ-204) and answer with the outcome acted on.
   * Joins a call in flight (timed or triggered) instead of making a second
   * one; leaves the next timed re-check's due time alone; runs no tick
   * listener. Answers {@link RECHECK_OUTCOME_NOT_RUNNING} with no call before
   * `start`, after `dispose` or after a stop. Never rejects.
   */
  trigger(): Promise<AdVersionRecheckTriggerAnswer>
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
 *   pending between re-checks and no two checks are acted on at once: at
 *   most one call is awaited. A call past its time limit is abandoned (it
 *   may still be running when a later check makes the next call) and its
 *   answer is ignored.
 * - `trigger` runs one re-check at once through the same call, decision,
 *   failure run and stop path (b.jg5 SRJ-204). It and the timer share one
 *   check in flight: a trigger during a timed or triggered check joins it,
 *   and a timed re-check that comes due during a triggered check joins it
 *   too (then arms the next and runs the tick listeners as usual). Either way
 *   one call is made and its outcome is acted on once. A trigger never moves
 *   the pending timer and runs no tick listener.
 * - Pass: the failure run ends; when the version differs from the last
 *   version seen, it becomes the last version seen and then each
 *   version-changed listener runs once, in order, with the previous and the
 *   new version (b.jg5 SRJ-207's signal); a listener that throws or rejects
 *   is logged as one token-free line and the rest still run.
 * - Could not run: nothing changes, except that the first one after start or
 *   after a pass writes {@link buildAdVersionRecheckCouldNotRunLine} to the
 *   server log (b.jg5 SRJ-206). The rest of the run write nothing. Never a
 *   startup-errors entry.
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
  /** Set by the first could-not-run after start or after a pass; cleared by every pass (b.jg5 SRJ-206). */
  let inFailureRun = false
  let timer: TimerBox | undefined
  let limitTimer: TimerBox | undefined
  /** The one check in flight (call, decision and action), shared by the timer and every trigger. */
  let inFlight: Promise<AdVersionRecheckTriggerAnswer> | undefined
  /** Answers the check in flight not-running at once; set while {@link inFlight} is. */
  let answerInFlightNotRunning: (() => void) | undefined

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

  /**
   * End the chain: no timer pending, nothing re-armed, and a check in flight
   * answers not-running to every waiter at once, without waiting for its
   * call, whose later answer is never acted on.
   */
  function endChain(): void {
    ended = true
    clearTimer(timer)
    timer = undefined
    clearTimer(limitTimer)
    limitTimer = undefined
    const answerNotRunning = answerInFlightNotRunning
    inFlight = undefined
    answerInFlightNotRunning = undefined
    answerNotRunning?.()
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
   * One `resolveSystemBinary()` call, settled at the latest at the time
   * limit. Never rejects. Only {@link runCheck} calls it, so at most one call
   * is awaited at a time. A call past its time limit is abandoned, not ended:
   * it may still be running when a later check makes the next call, and its
   * answer is ignored.
   */
  function callUnderTimeLimit(): Promise<AdVersionRecheckCallResult> {
    return new Promise<AdVersionRecheckCallResult>((resolve) => {
      const box: TimerBox = { handle: undefined }
      let settled = false
      const finish = (result: AdVersionRecheckCallResult): void => {
        if (settled) return // a call past its time limit: its answer is ignored
        settled = true
        if (limitTimer === box) {
          limitTimer = undefined
          clock.clearTimeout(box.handle)
        }
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
  }

  /**
   * The check in flight, started if there is none: one call, then its
   * outcome decided and acted on once. Answers not-running at once when the
   * chain ends while the call runs (see {@link endChain}); the call's later
   * answer is then ignored. Never rejects.
   */
  function runCheck(): Promise<AdVersionRecheckTriggerAnswer> {
    if (inFlight !== undefined) return inFlight
    let answer: (value: AdVersionRecheckTriggerAnswer) => void = () => {}
    const check = new Promise<AdVersionRecheckTriggerAnswer>((resolve) => {
      answer = resolve
    })
    inFlight = check
    answerInFlightNotRunning = () => answer(NOT_RUNNING_ANSWER)
    void callUnderTimeLimit().then((result) => {
      if (inFlight === check) {
        inFlight = undefined
        answerInFlightNotRunning = undefined
      }
      if (ended) {
        answer(NOT_RUNNING_ANSWER) // already answered by endChain; a no-op
        return
      }
      const outcome = decideAdVersionRecheckOutcome(result)
      actOnOutcome(outcome)
      answer(outcome)
    })
    return check
  }

  /** Act on one decided outcome: pass, could not run or stop (see {@link createAdVersionRecheck}). Never throws. */
  function actOnOutcome(outcome: AdVersionRecheckOutcome): void {
    if (outcome.kind === RECHECK_OUTCOME_STOP) {
      stopServer(outcome.classLabel, outcome.message)
      return
    }
    if (outcome.kind === RECHECK_OUTCOME_COULD_NOT_RUN) {
      if (inFailureRun) return
      inFailureRun = true
      log(buildAdVersionRecheckCouldNotRunLine(outcome.description))
      return
    }
    inFailureRun = false
    if (outcome.version === lastVersionSeen) return
    const previousVersion = lastVersionSeen
    lastVersionSeen = outcome.version
    runVersionChangedListeners(previousVersion, outcome.version)
  }

  /** Log a version-changed listener that threw or rejected, as one token-free line. */
  function logVersionChangedListenerFailure(err: unknown): void {
    log(`[slack] agent-director version re-check: a version-changed listener failed: ${describeThrownValue(err)}; the re-check carries on`)
  }

  function runVersionChangedListeners(previousVersion: string, newVersion: string): void {
    const listeners = deps.versionChangedListeners?.() ?? []
    for (const listener of listeners) {
      if (ended) return
      try {
        const returned = listener(previousVersion, newVersion)
        if (returned !== undefined && typeof (returned as { then?: unknown }).then === 'function') {
          ;(returned as Promise<void>).then(undefined, (err: unknown) => logVersionChangedListenerFailure(err))
        }
      } catch (err) {
        logVersionChangedListenerFailure(err)
      }
    }
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

  /**
   * One timed re-check (joining a triggered check in flight), then the next
   * arm and the tick listeners unless it stopped or was disposed. Never rejects.
   */
  async function runTimedRecheck(): Promise<void> {
    await runCheck()
    if (ended) return
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
    isRunning() {
      return started && !ended
    },
    trigger() {
      if (!started || ended) return Promise.resolve(NOT_RUNNING_ANSWER)
      return runCheck()
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

/** Registered version-changed listeners, in registration order; one entry per registration. */
const versionChangedListenerEntries = new Set<{ readonly listener: AdVersionChangedListener }>()

function registeredVersionChangedListeners(): readonly AdVersionChangedListener[] {
  return [...versionChangedListenerEntries].map((entry) => entry.listener)
}

/**
 * Build and start the server's runtime re-check with the registered tick and
 * version-changed listeners (b.jg5 SRJ-204). `main()` calls it once, right
 * after the startup gate passes. A second install, or one after
 * {@link disposeAdVersionRecheck}, is a logged no-op returning the installed
 * handle (or `undefined`).
 */
export function installAdVersionRecheck(
  deps: Omit<AdVersionRecheckDeps, 'tickListeners' | 'versionChangedListeners'>,
): AdVersionRecheck | undefined {
  if (recheckDisposed) {
    deps.log('[slack] agent-director version re-check: install after dispose — ignoring (the server is shutting down)')
    return undefined
  }
  if (installedRecheck !== undefined) {
    deps.log('[slack] agent-director version re-check: already installed — ignoring the second install')
    return installedRecheck
  }
  const recheck = createAdVersionRecheck({
    ...deps,
    tickListeners: registeredTickListeners,
    versionChangedListeners: registeredVersionChangedListeners,
  })
  installedRecheck = recheck
  recheck.start()
  return recheck
}

/**
 * Dispose the installed re-check (`shutdown()` calls it): its timers are
 * cleared, a call in flight is never acted on, a trigger waiting on it
 * answers not-running at once and no later install arms anything.
 * Idempotent; a no-op when nothing is installed.
 */
export function disposeAdVersionRecheck(): void {
  recheckDisposed = true
  installedRecheck?.dispose()
}

/**
 * Register a listener run after each timed re-check that did not stop
 * (b.jg5 SRJ-209: `installAdSettings` in `src/ad-settings.ts` re-reads
 * agent-director's timing settings from it). Independent of install order.
 * Returns its unsubscribe.
 */
export function onAdVersionRecheckTick(listener: AdVersionRecheckTickListener): () => void {
  const entry = { listener }
  tickListenerEntries.add(entry)
  return () => {
    tickListenerEntries.delete(entry)
  }
}

/**
 * Re-check the host binary at once on the installed re-check (b.jg5 SRJ-204)
 * and answer with the outcome it acted on. Called by the `ErrInvalidFlags`
 * step in `src/ad-error-class.ts` (SRJ-104) for an `ErrInvalidFlags` from the
 * reuse spawn (`reuseSpawnForPersona`, `src/session-manager.ts`, whose hold
 * it decides, SRJ-207), from the resume path of `resumeOrFreshSpawn` and from
 * the click handler's `decide` (`src/permission-click-handler.ts`). The answer:
 * passed (with the version), stopped, could not run, or
 * {@link RECHECK_OUTCOME_NOT_RUNNING} when none is installed, it was disposed
 * or it already stopped. Joins a check in flight; leaves the 120 s timer's
 * due time alone; runs no tick listener. Never throws or rejects.
 */
export function triggerAdVersionRecheck(): Promise<AdVersionRecheckTriggerAnswer> {
  if (installedRecheck === undefined) return Promise.resolve(NOT_RUNNING_ANSWER)
  return installedRecheck.trigger()
}

/**
 * Register a listener run when a passing re-check (timed or triggered) finds
 * a version that differs from the last version seen, with the previous and
 * the new version (b.jg5 SRJ-204's first row). Its consumer is the
 * `ErrInvalidFlags` hold (`src/invalid-flags-hold.ts`, SRJ-207): `main()`
 * registers one listener that ends every hold whose version differs from the
 * new one and retries each ended persona at once.
 * Listeners run in registration order. Independent of install order. Returns
 * its unsubscribe.
 */
export function onAdVersionChanged(listener: AdVersionChangedListener): () => void {
  const entry = { listener }
  versionChangedListenerEntries.add(entry)
  return () => {
    versionChangedListenerEntries.delete(entry)
  }
}

/**
 * The installed re-check's last version seen (b.jg5 SRJ-204, SRJ-207): the
 * version of its last passing re-check, else its baseline (the version the
 * startup gate read). `undefined` when none is installed, it was disposed or
 * a stop ended it. The reuse spawn's `ErrInvalidFlags` hold begins under it
 * when the immediate re-check could not run or was not running. Never throws.
 */
export function lastAdVersionSeen(): string | undefined {
  const recheck = installedRecheck
  if (recheck === undefined || recheckDisposed || !recheck.isRunning()) return undefined
  return recheck.lastVersionSeen()
}

/**
 * @internal Test-only: dispose any installed re-check (a trigger waiting on
 * its check in flight answers not-running) and clear the module-level state
 * (the handle, the disposed flag, every tick and version-changed listener).
 */
export function resetAdVersionRecheckForTests(): void {
  installedRecheck?.dispose()
  installedRecheck = undefined
  recheckDisposed = false
  tickListenerEntries.clear()
  versionChangedListenerEntries.clear()
}
