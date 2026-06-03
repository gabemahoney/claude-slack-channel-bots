/**
 * install-check-fixtures.ts — Test helpers + fixture loaders for
 * src/install-check.ts (SR-12.2 / SR-12.4).
 *
 * Centralizes:
 *   - Canonical version-string constants used across install-check tests.
 *   - The re-export of `DEV_SENTINEL_VERSION` from agent-director (tests
 *     MUST import the sentinel from here, never hardcode the string).
 *   - Factory functions for synthetic version-floor JSON documents and
 *     for canned check-result arms.
 *   - A fixture loader that reads files from tests/fixtures/version-floor/.
 *
 * This module has no top-level mock.module() calls — the pretest gate
 * scripts/check-no-toplevel-mock-module.ts must pass against it.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEV_SENTINEL_VERSION } from 'agent-director'

import type {
  InstallCheckClassLabel,
  InstallCheckFailure,
  InstallCheckResult,
  InstallCheckSuccess,
} from '../../src/install-check.ts'

// ---------------------------------------------------------------------------
// Canonical constants
// ---------------------------------------------------------------------------

/** A version that satisfies a typical 0.7.x floor — chosen above 0.7.0. */
export const SATISFYING_VERSION = '0.7.5'

/** A version below any realistic 0.7.x floor — chosen below 0.7.0. */
export const STALE_VERSION = '0.5.0'

/** Re-export of DEV_SENTINEL_VERSION from agent-director for test convenience. */
export const SENTINEL_VERSION: typeof DEV_SENTINEL_VERSION = DEV_SENTINEL_VERSION

/** Re-export of the constant itself — tests that need the AD-side symbol. */
export { DEV_SENTINEL_VERSION }

// ---------------------------------------------------------------------------
// JSON document factories
// ---------------------------------------------------------------------------

/** Build a synthetic version-floor JSON document with the supplied min_binary_version. */
export function makeVersionFloorJson(min: string): string {
  return JSON.stringify({ min_binary_version: min }, null, 2) + '\n'
}

/** Build a known-malformed JSON string — intentional trailing comma + unclosed brace. */
export function makeMalformedFloorJson(): string {
  return '{ "min_binary_version": "0.7.5",\n'
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

/** Build a canned InstallCheckSuccess result. */
export function cannedSuccessResult(
  opts: Partial<InstallCheckSuccess> = {},
): InstallCheckSuccess {
  return {
    ok: true,
    binaryPath: '/usr/local/bin/agent-director',
    binaryVersion: SATISFYING_VERSION,
    floor: '0.7.0',
    ...opts,
  }
}

/** Build a canned InstallCheckFailure result for the supplied class label. */
export function cannedFailureResult(
  classLabel: InstallCheckClassLabel,
  opts: Partial<Omit<InstallCheckFailure, 'ok' | 'classLabel'>> = {},
): InstallCheckFailure {
  const defaults: Record<InstallCheckClassLabel, { message: string; detail: Record<string, unknown> }> = {
    'ad-system-install-not-found': {
      message: 'agent-director not found on PATH or at the standard install path.',
      detail: { checkedLocations: [] },
    },
    'ad-system-install-too-old': {
      message: `agent-director system install at /usr/local/bin/agent-director reports version ${STALE_VERSION}, which is below the declared floor 0.7.0.`,
      detail: { detected: STALE_VERSION, required: '0.7.0', binaryPath: '/usr/local/bin/agent-director' },
    },
    'ad-system-install-unreachable': {
      message: 'agent-director system install at /usr/local/bin/agent-director is unreachable. Reason: other.',
      detail: { reason: 'other', binaryPath: '/usr/local/bin/agent-director' },
    },
    'ad-version-floor-unreadable': {
      message: `agent-director's dist/version-floor.json could not be read. Reinstall agent-director from npm and retry.`,
      detail: { underlying: 'ENOENT' },
    },
  }
  const d = defaults[classLabel]
  return {
    ok: false,
    classLabel,
    message: opts.message ?? d.message,
    detail: opts.detail ?? d.detail,
  }
}

/** Type alias re-exported for convenience. */
export type { InstallCheckResult, InstallCheckSuccess, InstallCheckFailure, InstallCheckClassLabel }
