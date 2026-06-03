/**
 * install-check.ts — SR-5 shared install-check module.
 *
 * Source of truth for "is agent-director system-installed at a version
 * meeting AD's declared floor?" — consumed by:
 *   - The `bun run install-check` script (Epic 2).
 *   - The install-cscb skill (Epic 3).
 *
 * The startup gate (Epic 1, agent-director-startup.ts) does NOT call this
 * module — AD's own `Client.create()` enforces the same floor against the
 * same `dist/version-floor.json`, so there are two callers that drive the
 * same enforcement path. CSCB never duplicates the floor decision.
 *
 * The module is strictly side-effect-free:
 *   - No process.exit.
 *   - No disk writes.
 *   - No stdout / stderr output.
 *
 * Callers own all presentation, exit code, and skill-instruction-block
 * appending decisions.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import {
  DEV_SENTINEL_VERSION,
  ErrSystemInstallNotFound,
  ErrSystemInstallTooOld,
  ErrSystemInstallUnreachable,
  resolveSystemBinary,
} from 'agent-director'
import type { UnreachableReason } from 'agent-director'

/** Canonical class labels emitted by the check; mirrors the startup gate's. */
export type InstallCheckClassLabel =
  | 'ad-system-install-not-found'
  | 'ad-system-install-too-old'
  | 'ad-system-install-unreachable'
  | 'ad-version-floor-unreadable'

/** Success arm: AD is installed, version satisfies the declared floor. */
export interface InstallCheckSuccess {
  ok: true
  binaryPath: string
  binaryVersion: string
  floor: string
}

/** Failure arm: one of the four canonical class labels. */
export interface InstallCheckFailure {
  ok: false
  classLabel: InstallCheckClassLabel
  message: string
  detail: Record<string, unknown>
}

export type InstallCheckResult = InstallCheckSuccess | InstallCheckFailure

/**
 * Cached `.min_binary_version` value, or the cached failure-arm result for
 * the `ad-version-floor-unreadable` class so we surface the same shape on
 * every call without re-reading a known-bad file.
 */
let cachedFloor: string | InstallCheckFailure | null = null

/**
 * Read AD's `dist/version-floor.json` via the subpath export and return the
 * `.min_binary_version` value. Returns a pre-built failure-arm result on
 * any failure mode (missing file, parse error, missing/non-string field).
 */
function loadFloor(): string | InstallCheckFailure {
  if (cachedFloor !== null) return cachedFloor

  let resolved: string
  try {
    resolved = import.meta.resolve('agent-director/dist/version-floor.json')
  } catch (err) {
    cachedFloor = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message:
        `Could not resolve 'agent-director/dist/version-floor.json' from the installed ` +
        `agent-director package. Reinstall agent-director from npm and retry.`,
      detail: { underlying: (err as Error).message },
    }
    return cachedFloor
  }

  let raw: string
  try {
    raw = readFileSync(fileURLToPath(resolved), 'utf-8')
  } catch (err) {
    cachedFloor = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message:
        `Could not read agent-director's dist/version-floor.json. ` +
        `Reinstall agent-director from npm and retry.`,
      detail: { underlying: (err as Error).message },
    }
    return cachedFloor
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    cachedFloor = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message:
        `agent-director's dist/version-floor.json failed to parse as JSON. ` +
        `Reinstall agent-director from npm and retry.`,
      detail: { underlying: (err as Error).message },
    }
    return cachedFloor
  }

  const floor = (parsed as { min_binary_version?: unknown } | null)?.min_binary_version
  if (typeof floor !== 'string' || floor.length === 0) {
    cachedFloor = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message:
        `agent-director's dist/version-floor.json is missing the required '.min_binary_version' field ` +
        `(or it is not a non-empty string). Reinstall agent-director from npm and retry.`,
      detail: { parsed },
    }
    return cachedFloor
  }

  cachedFloor = floor
  return floor
}

/**
 * Strip a leading 'v' from a version string, idempotent for inputs that
 * already lack the prefix. AD has historically shipped both forms.
 */
function stripLeadingV(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}

/**
 * Run the full check. See module header for semantics. The result is one of
 * five shapes: success, or one of the four failure class labels.
 */
export async function runInstallCheck(): Promise<InstallCheckResult> {
  const floorOrFailure = loadFloor()
  if (typeof floorOrFailure !== 'string') return floorOrFailure
  const floor = floorOrFailure

  let resolved: { path: string; version: string }
  try {
    resolved = await resolveSystemBinary()
  } catch (err) {
    if (err instanceof ErrSystemInstallNotFound) {
      return {
        ok: false,
        classLabel: 'ad-system-install-not-found',
        message:
          `agent-director not found on PATH or at the standard install path. ` +
          `Install agent-director system-wide and retry.`,
        detail: { checkedLocations: err.checkedLocations },
      }
    }
    if (err instanceof ErrSystemInstallTooOld) {
      return {
        ok: false,
        classLabel: 'ad-system-install-too-old',
        message:
          `agent-director system install at ${err.binaryPath} reports version ${err.actualVersion}, ` +
          `which is below the declared floor ${err.requiredVersion}. Upgrade agent-director and retry.`,
        detail: {
          detected: err.actualVersion,
          required: err.requiredVersion,
          binaryPath: err.binaryPath,
        },
      }
    }
    if (err instanceof ErrSystemInstallUnreachable) {
      const reason: UnreachableReason = err.reason
      return {
        ok: false,
        classLabel: 'ad-system-install-unreachable',
        message:
          `agent-director system install at ${err.binaryPath} is unreachable. ` +
          `Reason: ${reason}. Diagnose with the install-cscb skill or re-install agent-director.`,
        detail: {
          reason,
          binaryPath: err.binaryPath,
          diagnostic: err.diagnostic,
          exitCode: err.exitCode,
          signal: err.signal,
        },
      }
    }
    // Non-typed throw — surface verbatim under the unreachable label so
    // callers have one failure-arm shape to dispatch on.
    return {
      ok: false,
      classLabel: 'ad-system-install-unreachable',
      message:
        `agent-director system install probe threw an unexpected error: ` +
        `${(err as Error).message ?? String(err)}. Re-install agent-director or file a bug.`,
      detail: { underlying: String(err), reason: 'other' as UnreachableReason },
    }
  }

  const detectedRaw = resolved.version

  // SR-5: sentinel-equality short-circuit. A detected version exactly equal
  // to DEV_SENTINEL_VERSION passes unconditionally — this is how locally-
  // built dev binaries (without a real semver) pass the check.
  if (detectedRaw === DEV_SENTINEL_VERSION) {
    return {
      ok: true,
      binaryPath: resolved.path,
      binaryVersion: detectedRaw,
      floor,
    }
  }

  const detected = stripLeadingV(detectedRaw)
  if (!semver.gte(detected, floor)) {
    return {
      ok: false,
      classLabel: 'ad-system-install-too-old',
      message:
        `agent-director system install at ${resolved.path} reports version ${detectedRaw}, ` +
        `which is below the declared floor ${floor}. Upgrade agent-director and retry.`,
      detail: { detected: detectedRaw, required: floor, binaryPath: resolved.path },
    }
  }

  return {
    ok: true,
    binaryPath: resolved.path,
    binaryVersion: detectedRaw,
    floor,
  }
}

/**
 * @internal Test-only — reset the cached floor so subsequent calls re-read
 * `dist/version-floor.json`. Used by the install-check tests to exercise
 * both the cache and the per-failure-mode read paths.
 */
export function resetCacheForTests(): void {
  cachedFloor = null
}
