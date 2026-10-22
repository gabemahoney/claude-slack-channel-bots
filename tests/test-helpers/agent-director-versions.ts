/**
 * agent-director-versions.ts — the shared agent-director versions tests check
 * against CSCB's Phase 1 floor, and the minimum Claude Code version
 * CSCB supports with agent-director.
 *
 * Tests import every agent-director version they check from here or from
 * `src/`, never as a literal, so a change to the floor constant
 * (`PHASE1_FLOOR_VERSION` in `src/ad-version-gate.ts`) moves every case with
 * it.
 *
 * Against the floor:
 *   - passes: `PHASE1_RC_VERSION` (the version the Phase 1 release
 *     candidate reports, built from the floor; a pre-release suffix is
 *     ignored, so it counts as the floor);
 *   - refused: `OLD_AD_VERSION` (the release before Phase 1, which the released client
 *     rejects first; resolved old fixtures are defensive injections), `DEV_PLACEHOLDER_VERSION` (the client's development
 *     sentinel, which the client ranks above every version) and
 *     `DEV_UNPARSEABLE_VERSION` (not strict SemVer, so it fails closed).
 *
 * `CLIENT_MIN_VERSION` is the installed client's own minimum, read once from
 * its `dist/version-floor.json` through the package's subpath export
 * (`FLOOR_SUBPATH`, the file `src/install-check.ts` reads), never written
 * here.
 * `BELOW_CLIENT_MIN_VERSION` is the plain release one step below it, which the
 * client refuses as too old; it is checked against the minimum when this
 * module loads.
 *
 * `MIN_CLAUDE_CODE_VERSION` is CSCB's supported minimum with agent-director
 * 0.12.0, and the version the fleet runs. This helper is its one definition: no `src/` module defines or
 * reads a Claude Code version, and every test that needs it (a fixture's
 * recorded version, the runbook and supported-minimum docs)
 * imports it from here. `tests/ad-version-gate.test.ts` checks that no other
 * `tests/` TypeScript file, and no `src/` TypeScript file, writes its value
 * in code (comments stripped).
 *
 * Starts no process and holds no value import of `Client` or
 * `resolveSystemBinary` (host-safety audit). It imports only
 * `src/ad-version-gate.ts` and the client's sentinel, so the agent-director
 * stub can import it without a cycle.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEV_SENTINEL_VERSION } from 'agent-director'

import { compareAdVersions, PHASE1_FLOOR_VERSION } from '../../src/ad-version-gate.ts'

/** The floor RC passes CSCB's numeric comparison; the released native client rejects it first. */
export const PHASE1_RC_VERSION = `${PHASE1_FLOOR_VERSION}-rc.1`

/** The last agent-director release before Phase 1; the released client rejects it before CSCB's floor. */
export const OLD_AD_VERSION = '0.10.0'

/** The client's development sentinel (`0.0.0-dev`); CSCB's floor refuses it. */
export const DEV_PLACEHOLDER_VERSION: string = DEV_SENTINEL_VERSION

/** An injected non-SemVer value; native resolution reports unreachable, CSCB fails closed. */
export const DEV_UNPARSEABLE_VERSION = 'dev'

/**
 * CSCB's supported minimum with agent-director 0.12.0, verified by its
 * install, spawn, reuse and resume checks, and the version the fleet runs
 * Exec-form hooks
 * (`command` with `args`) need Claude Code 2.1.139 or later. The one place
 * this value is written in `tests/` or `src/` code.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.280'

/** The independent /ci-live target, not the supported minimum. */
export const LIVE_CLAUDE_CODE_VERSION = '2.1.296'

/** The frozen 0.11.0 runbooks' Claude Code version, independent of today's supported floor. */
export const HISTORICAL_PHASE1_CLAUDE_CODE_VERSION = '2.1.280'

/** The installed client's floor file, as its package exports it. */
export const FLOOR_SUBPATH = 'agent-director/dist/version-floor.json'

function readClientMinVersion(): string {
  let path: string
  try {
    path = fileURLToPath(import.meta.resolve(FLOOR_SUBPATH))
  } catch (err) {
    throw new Error(`agent-director-versions: cannot resolve '${FLOOR_SUBPATH}' from the installed client: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`agent-director-versions: cannot read '${FLOOR_SUBPATH}' at ${path}: ${(err as Error).message}`)
  }
  const min = (parsed as { min_binary_version?: unknown } | null)?.min_binary_version
  if (typeof min !== 'string' || min.length === 0) {
    throw new Error(`agent-director-versions: '${FLOOR_SUBPATH}' at ${path} holds no string 'min_binary_version'`)
  }
  return min
}

/** The installed client's `min_binary_version`, from its `dist/version-floor.json`. */
export const CLIENT_MIN_VERSION: string = readClientMinVersion()

/** The part a lower part takes when the part above it steps down: high enough to sit above any real release. */
const HIGH_PART = 999

/**
 * The plain release one step below `version`'s core: one patch below, else
 * the previous minor's (major's) {@link HIGH_PART} release.
 */
function releaseOneStepBelow(version: string): string {
  const core = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (core === null) throw new Error(`agent-director-versions: ${JSON.stringify(version)} has no major.minor.patch core`)
  const [major, minor, patch] = [Number(core[1]), Number(core[2]), Number(core[3])]
  if (patch > 0) return `${major}.${minor}.${patch - 1}`
  if (minor > 0) return `${major}.${minor - 1}.${HIGH_PART}`
  return `${major - 1}.${HIGH_PART}.${HIGH_PART}`
}

/** A plain release one step below the installed client's minimum: the client refuses it as too old. */
export const BELOW_CLIENT_MIN_VERSION: string = releaseOneStepBelow(CLIENT_MIN_VERSION)

// BELOW_CLIENT_MIN_VERSION must sit below the client's minimum in the client's
// own order; fail loudly at load otherwise.
if (compareAdVersions(BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION) !== -1) {
  throw new Error(`agent-director-versions: BELOW_CLIENT_MIN_VERSION ${BELOW_CLIENT_MIN_VERSION} is not below the client minimum ${CLIENT_MIN_VERSION}`)
}
