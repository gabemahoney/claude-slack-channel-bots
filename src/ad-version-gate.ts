/**
 * ad-version-gate.ts — CSCB's own Phase 1 floor for the agent-director binary.
 *
 * Role: holds the one named Phase 1 floor constant (b.jg5 SRJ-201), the floor
 * comparison over a version string (b.jg5 SRJ-202), the title of the README
 * switch-over runbook section that CSCB's gate messages point the operator to,
 * and the startup gate's `ad-below-phase1-floor` message (b.jg5 SRJ-203,
 * SRJ-208, SRJ-1013).
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
 * Pure module: no value import from `agent-director`, no child process, no
 * file read, no timer.
 *
 * Later Epics extend this module: E3 adds the runtime re-check and E5 the
 * host-version decision.
 *
 * SPDX-License-Identifier: MIT
 */

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

/** Token-free parts of a startup-gate floor refusal. */
export interface BelowPhase1FloorParts {
  /** The binary's version as the client reported it (`binaryVersion`). */
  readonly foundVersion: string
  /** The resolved binary path the client runs. */
  readonly binaryPath: string
}

/**
 * The startup gate's `ad-below-phase1-floor` message (b.jg5 SRJ-203,
 * SRJ-1013): the version found, the version required (the floor or later,
 * its release candidates included), the binary path, that the startup check
 * found it, {@link PHASE1_SWITCH_OVER_INSTRUCTION} and the runbook section's
 * title. It carries no instruction to upgrade agent-director, no install or
 * upgrade command and no install-skill block (b.jg5 SRJ-208). Built from
 * versions, a path and fixed text only.
 */
export function buildBelowPhase1FloorMessage(parts: BelowPhase1FloorParts): string {
  return (
    `agent-director version ${parts.foundVersion} is below CSCB's Phase 1 floor: ` +
    `version ${PHASE1_FLOOR_VERSION} or later is required ` +
    `(release candidates ${PHASE1_FLOOR_VERSION}-rc.N included). ` +
    `Binary at ${parts.binaryPath}; found by the startup check. ` +
    `Note: ${PHASE1_SWITCH_OVER_INSTRUCTION} (section "${PHASE1_RUNBOOK_SECTION_TITLE}").`
  )
}
