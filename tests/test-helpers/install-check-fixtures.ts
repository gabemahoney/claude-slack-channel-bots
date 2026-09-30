/**
 * install-check-fixtures.ts — Test helpers + fixture loaders for
 * src/install-check.ts (the install check, b.jg5 SRJ-212) and its callers
 * (`scripts/install-check.ts`, `src/postinstall.ts`).
 *
 * Centralizes:
 *   - Version-string constants for the install check, placed against the
 *     installed client's minimum (`CLIENT_MIN_VERSION`) and CSCB's Phase 1
 *     floor (`PHASE1_FLOOR_VERSION`); checked when this module loads.
 *   - The re-export of `DEV_SENTINEL_VERSION` from agent-director (tests
 *     MUST import the sentinel from here, never hardcode the string).
 *   - Every `ErrSystemInstallUnreachable` reason (`UNREACHABLE_REASONS`),
 *     held complete by the compiler.
 *   - Factory functions for synthetic version-floor JSON documents and
 *     for canned check-result arms. The canned results have the shapes and
 *     texts `runInstallCheck` returns: the success note comes from
 *     `buildInstallCheckPhase1Note` and the too-old message from
 *     `buildSystemInstallTooOldMessage` (startup form), both in
 *     `src/ad-version-gate.ts`; labels come from `src/install-check-labels.ts`.
 *     The not-found, unreachable and floor-unreadable messages are copies of
 *     `src/install-check.ts`'s text, pinned by `tests/install-check.test.ts`,
 *     which compares real results whole with these canned ones.
 *   - A fixture loader that reads files from tests/fixtures/version-floor/.
 *
 * This module has no top-level mock.module() calls — the pretest gate
 * scripts/check-no-toplevel-mock-module.ts must pass against it — and no
 * value import of `Client` or `resolveSystemBinary` (host-safety audit,
 * b.jg5 SRJ-1301): it imports `src/install-check.ts` for types only.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEV_SENTINEL_VERSION } from 'agent-director'
import type { UnreachableReason } from 'agent-director'

import {
  buildInstallCheckPhase1Note,
  buildSystemInstallTooOldMessage,
  compareAdVersions,
  meetsPhase1Floor,
} from '../../src/ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from '../../src/install-check-labels.ts'
import type {
  InstallCheckClassLabel,
  InstallCheckFailure,
  InstallCheckResult,
  InstallCheckSuccess,
} from '../../src/install-check.ts'
import { CLIENT_MIN_VERSION, PHASE1_RC_VERSION } from './agent-director-versions.ts'

// ---------------------------------------------------------------------------
// Canonical constants
// ---------------------------------------------------------------------------

/**
 * A version at or above the installed client's minimum (`CLIENT_MIN_VERSION`)
 * but below CSCB's Phase 1 floor: the install check passes it with the
 * Phase 1 note, and the startup gate refuses it.
 */
export const SATISFYING_VERSION = '0.7.5'

/** A version below the installed client's minimum (`CLIENT_MIN_VERSION`): the install check fails it as too old. */
export const STALE_VERSION = '0.5.0'

/** Re-export of DEV_SENTINEL_VERSION from agent-director for test convenience. */
export const SENTINEL_VERSION: typeof DEV_SENTINEL_VERSION = DEV_SENTINEL_VERSION

/** Re-export of the constant itself — tests that need the AD-side symbol. */
export { DEV_SENTINEL_VERSION }

/**
 * The binary path every canned result reports by default. Same value as the
 * stub resolver's default (`STUB_RESOLVE_DEFAULT_PATH` in
 * `agent-director-stub.ts`, not imported here to keep this helper light: the
 * stub imports the session manager and the persona modules); a case in
 * `tests/agent-director-stub-resolve.test.ts` pins the two equal.
 */
export const CANNED_BINARY_PATH = '/usr/local/bin/agent-director'

/** Every `ErrSystemInstallUnreachable` reason; the `Record` makes the compiler hold the set complete. */
const UNREACHABLE_REASON_SET: Record<UnreachableReason, true> = {
  'not-executable': true,
  'not-a-regular-file': true,
  'probe-timeout': true,
  'probe-nonzero-exit': true,
  'probe-killed-by-signal': true,
  'unparseable-version': true,
  'spawn-failed': true,
  other: true,
}

/** Every `ErrSystemInstallUnreachable` reason agent-director defines, in a fixed order. */
export const UNREACHABLE_REASONS: readonly UnreachableReason[] = Object.keys(UNREACHABLE_REASON_SET) as UnreachableReason[]

// The constants above must sit where their comments say, against the
// installed client's minimum and CSCB's floor; fail loudly at load otherwise.
const satisfyingVsClientMin = compareAdVersions(SATISFYING_VERSION, CLIENT_MIN_VERSION)
if (satisfyingVsClientMin === null || satisfyingVsClientMin < 0) {
  throw new Error(`install-check-fixtures: SATISFYING_VERSION ${SATISFYING_VERSION} is below the client minimum ${CLIENT_MIN_VERSION}`)
}
if (meetsPhase1Floor(SATISFYING_VERSION)) {
  throw new Error(`install-check-fixtures: SATISFYING_VERSION ${SATISFYING_VERSION} meets CSCB's Phase 1 floor`)
}
if (compareAdVersions(STALE_VERSION, CLIENT_MIN_VERSION) !== -1) {
  throw new Error(`install-check-fixtures: STALE_VERSION ${STALE_VERSION} is not below the client minimum ${CLIENT_MIN_VERSION}`)
}

// ---------------------------------------------------------------------------
// JSON document factories
// ---------------------------------------------------------------------------

/** Build a synthetic version-floor JSON document with the supplied min_binary_version. */
export function makeVersionFloorJson(min: string): string {
  return JSON.stringify({ min_binary_version: min }, null, 2) + '\n'
}

/** Build a known-malformed JSON string — intentional trailing comma + unclosed brace. */
export function makeMalformedFloorJson(): string {
  return `{ "min_binary_version": "${SATISFYING_VERSION}",\n`
}

/** Build a JSON document missing the .min_binary_version field. */
export function makeMissingFieldFloorJson(): string {
  return JSON.stringify({ unrelated_field: 'value' }, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'version-floor')

/** Known fixture names under tests/fixtures/version-floor/. */
export type FixtureName =
  | 'floor-matched'
  | 'floor-low'
  | 'floor-high'
  | 'malformed'
  | 'missing-field'

/**
 * Load a fixture's raw bytes. Tests that want parsed JSON should `JSON.parse`
 * the result themselves; the malformed fixture intentionally throws on parse.
 */
export function loadFixtureRaw(name: FixtureName): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')
}

/**
 * Absolute filesystem path to a fixture, for tests that need to point a stub
 * at a real file path on disk.
 */
export function fixturePath(name: FixtureName): string {
  return join(FIXTURES_DIR, `${name}.json`)
}

// ---------------------------------------------------------------------------
// Canned result-arm factories
// ---------------------------------------------------------------------------

/** Options of {@link cannedSuccessResult}: any success field, plus the note switch. */
export interface CannedSuccessOptions extends Partial<InstallCheckSuccess> {
  /**
   * Whether the result carries the install check's Phase 1 note
   * (`buildInstallCheckPhase1Note(binaryVersion)`). Default: as
   * `runInstallCheck` decides it — present exactly when `binaryVersion` is
   * below CSCB's Phase 1 floor (`meetsPhase1Floor` false). An explicit
   * `note` string wins over this switch.
   */
  phase1Note?: boolean
}

/**
 * Build a canned InstallCheckSuccess result, shaped as `runInstallCheck`
 * returns it. Defaults: `binaryPath` {@link CANNED_BINARY_PATH},
 * `binaryVersion` `PHASE1_RC_VERSION` (meets the floor), `floor`
 * `CLIENT_MIN_VERSION`, and so no note. A `binaryVersion` below the floor
 * (e.g. `OLD_AD_VERSION`, `DEV_PLACEHOLDER_VERSION`, {@link SATISFYING_VERSION})
 * carries the Phase 1 note unless `phase1Note: false` is passed.
 */
export function cannedSuccessResult(opts: CannedSuccessOptions = {}): InstallCheckSuccess {
  const { phase1Note, note, ...fields } = opts
  const result: InstallCheckSuccess = {
    ok: true,
    binaryPath: CANNED_BINARY_PATH,
    binaryVersion: PHASE1_RC_VERSION,
    floor: CLIENT_MIN_VERSION,
    ...fields,
  }
  if (note !== undefined) {
    result.note = note
  } else if (phase1Note ?? !meetsPhase1Floor(result.binaryVersion)) {
    result.note = buildInstallCheckPhase1Note(result.binaryVersion)
  }
  return result
}

/** The unreachable reason the canned unreachable failure reports by default. */
const DEFAULT_UNREACHABLE_REASON: UnreachableReason = 'other'

/** A detail field as a string, else the fallback. */
function detailString(detail: Record<string, unknown>, key: string, fallback: string): string {
  const value = detail[key]
  return typeof value === 'string' ? value : fallback
}

/** Default detail of each failure class label, as `runInstallCheck` shapes it. */
function defaultDetail(classLabel: InstallCheckClassLabel): Record<string, unknown> {
  switch (classLabel) {
    case AD_SYSTEM_INSTALL_NOT_FOUND:
      return { checkedLocations: [] }
    case AD_SYSTEM_INSTALL_TOO_OLD:
      return { detected: STALE_VERSION, required: CLIENT_MIN_VERSION, binaryPath: CANNED_BINARY_PATH }
    case AD_SYSTEM_INSTALL_UNREACHABLE:
      return { reason: DEFAULT_UNREACHABLE_REASON, binaryPath: CANNED_BINARY_PATH, diagnostic: null, exitCode: null, signal: null }
    case AD_VERSION_FLOOR_UNREADABLE:
      return { underlying: 'ENOENT' }
  }
}

/** Default message of each failure class label, built from the (effective) detail. */
function defaultMessage(classLabel: InstallCheckClassLabel, detail: Record<string, unknown>): string {
  switch (classLabel) {
    case AD_SYSTEM_INSTALL_NOT_FOUND:
      return (
        `agent-director not found on PATH or at the standard install path. ` +
        `Install agent-director system-wide and retry.`
      )
    case AD_SYSTEM_INSTALL_TOO_OLD:
      // The builder runInstallCheck uses (startup form): names the runbook
      // section, no instruction to upgrade agent-director.
      return buildSystemInstallTooOldMessage({
        foundVersion: detailString(detail, 'detected', STALE_VERSION),
        requiredVersion: detailString(detail, 'required', CLIENT_MIN_VERSION),
        binaryPath: detailString(detail, 'binaryPath', CANNED_BINARY_PATH),
      })
    case AD_SYSTEM_INSTALL_UNREACHABLE:
      return (
        `agent-director system install at ${detailString(detail, 'binaryPath', CANNED_BINARY_PATH)} is unreachable. ` +
        `Reason: ${detailString(detail, 'reason', DEFAULT_UNREACHABLE_REASON)}. Diagnose with the install-cscb skill or re-install agent-director.`
      )
    case AD_VERSION_FLOOR_UNREADABLE:
      return (
        `Could not read agent-director's dist/version-floor.json. ` +
        `Reinstall agent-director from npm and retry.`
      )
  }
}

/**
 * Build a canned InstallCheckFailure result for the supplied class label,
 * shaped as `runInstallCheck` returns it. `opts.detail` replaces the default
 * detail; `opts.message` replaces the default message, which is otherwise
 * built from the effective detail. Too-old defaults: detected
 * {@link STALE_VERSION}, required `CLIENT_MIN_VERSION`, binary
 * {@link CANNED_BINARY_PATH}; message from `buildSystemInstallTooOldMessage`.
 */
export function cannedFailureResult(
  classLabel: InstallCheckClassLabel,
  opts: Partial<Omit<InstallCheckFailure, 'ok' | 'classLabel'>> = {},
): InstallCheckFailure {
  const detail = opts.detail ?? defaultDetail(classLabel)
  return {
    ok: false,
    classLabel,
    message: opts.message ?? defaultMessage(classLabel, detail),
    detail,
  }
}

/** Type alias re-exported for convenience. */
export type { InstallCheckResult, InstallCheckSuccess, InstallCheckFailure, InstallCheckClassLabel }
