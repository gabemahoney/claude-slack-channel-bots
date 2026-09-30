/**
 * install-check.ts — the agent-director install check (b.jg5 SRJ-212).
 *
 * Answers "is agent-director installed on this host at a version this CSCB
 * release can be installed beside?" for:
 *   - the `bun run install-check` script (`scripts/install-check.ts`);
 *   - the install-cscb skill (`skills/install-cscb`);
 *   - the npm postinstall's agent-director probe (`src/postinstall.ts`).
 *
 * {@link runInstallCheck} reads the installed client's minimum binary version
 * ({@link readClientMinVersion}), makes one call to the injected resolver
 * (default: the client's own `resolveSystemBinary`; tests pass a stub,
 * b.jg5 SRJ-121) and applies the one host-version decision,
 * `decideHostAdVersion` in `src/ad-version-gate.ts`, which `/publish`'s
 * check `scripts/ad-version-check.ts` shares (b.jg5 SRJ-211). The decision
 * classifies agent-director errors by name, never `instanceof`:
 *   - a missing binary, a version that cannot be read (every
 *     `ErrSystemInstallUnreachable` reason, or a resolved version that does
 *     not parse, reported with reason `unparseable-version`), a binary below
 *     the client's minimum, or any other failure fails with its class label;
 *     the too-old message names the switch-over runbook section and no
 *     message advises upgrading agent-director;
 *   - a binary the client accepts but below CSCB's Phase 1 floor (`0.10.0`,
 *     `0.0.0-dev`) passes with the Phase 1 `note`: the server refuses to start
 *     on it until agent-director Phase 1 is installed;
 *   - a binary that meets the floor passes with no note.
 *
 * The startup gate (`src/agent-director-startup.ts`) does not call
 * `runInstallCheck()`; it builds the client with `Client.create()` and applies
 * CSCB's Phase 1 floor itself, so a binary that passes this check with its
 * note is still refused at start. The class labels live in the leaf module
 * `install-check-labels.ts` and are re-exported here. The not-found, too-old
 * and unreachable labels are shared with the startup gate;
 * `AD_BELOW_PHASE1_FLOOR` and `AD_SHIM_CATALOG_INCOMPLETE` are written only by
 * the startup gate, and this check never reports either.
 *
 * {@link readClientMinVersion} (the installed client's `min_binary_version`)
 * is also read by `/publish`'s check.
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
import { resolveSystemBinary } from 'agent-director'
import type { ResolveSystemBinaryResult, UnreachableReason } from 'agent-director'

import {
  buildInstallCheckPhase1Note,
  buildSystemInstallTooOldMessage,
  decideHostAdVersion,
  HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
  HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE,
  HOST_VERSION_FAIL_NOT_FOUND,
  HOST_VERSION_FAIL_OTHER,
  HOST_VERSION_FAIL_VERSION_UNREADABLE,
  HOST_VERSION_OUTCOME_FAIL,
  HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
  type HostVersionCallResult,
  type HostVersionFailure,
} from './ad-version-gate.ts'
import {
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
  type InstallCheckClassLabel,
} from './install-check-labels.ts'

export {
  AD_BELOW_PHASE1_FLOOR,
  AD_SHIM_CATALOG_INCOMPLETE,
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
} from './install-check-labels.ts'
export type { InstallCheckClassLabel } from './install-check-labels.ts'

/**
 * Success arm: agent-director is installed at or above the client's minimum
 * (`floor`). `note` is present only when the binary is below CSCB's Phase 1
 * floor: the Phase 1 note naming the switch-over runbook section.
 */
export interface InstallCheckSuccess {
  ok: true
  binaryPath: string
  binaryVersion: string
  floor: string
  note?: string
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
 * The installed agent-director client's minimum binary version: read AD's
 * `dist/version-floor.json` via the subpath export and return the
 * `.min_binary_version` value. Returns a pre-built
 * `ad-version-floor-unreadable` failure-arm result on any failure mode
 * (missing file, parse error, missing/non-string field). The value or the
 * failure is cached; {@link resetCacheForTests} and {@link setFloorForTests}
 * reset and seed the cache.
 */
export function readClientMinVersion(): string | InstallCheckFailure {
  if (cachedFloor !== null) return cachedFloor

  let resolved: string
  try {
    resolved = import.meta.resolve('agent-director/dist/version-floor.json')
  } catch (err) {
    cachedFloor = {
      ok: false,
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
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
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
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
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
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
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
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

/** agent-director's `resolveSystemBinary`, or a stand-in with its shape. */
export type InstallCheckResolveSystemBinary = () => Promise<ResolveSystemBinaryResult>

/** Dependencies of {@link runInstallCheck}. */
export interface InstallCheckDeps {
  /**
   * Resolves the host's agent-director binary; default: the client's own
   * `resolveSystemBinary`. Tests pass a stub (b.jg5 SRJ-121, SRJ-1301).
   */
  resolveSystemBinary?: InstallCheckResolveSystemBinary
}

/** One settled resolver call; a synchronous throw counts as a rejection. Never rejects. */
async function settleResolve(resolve: InstallCheckResolveSystemBinary): Promise<HostVersionCallResult> {
  try {
    return { kind: 'resolved', value: await resolve() }
  } catch (error) {
    return { kind: 'rejected', error }
  }
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

/** An `ErrSystemInstallUnreachable` reason: a short lowercase, hyphenated word. */
const SAFE_REASON_RE = /^[a-z][a-z0-9-]{0,63}$/

/** The reason of a resolved version that does not parse. */
const UNPARSEABLE_VERSION_REASON: UnreachableReason = 'unparseable-version'

/** The reason of any failure the decision classes as other. */
const OTHER_REASON: UnreachableReason = 'other'

/** A thrown `ErrSystemInstallUnreachable`'s reason when it is a short safe word, else `other`. */
function unreachableReason(error: unknown): string {
  const reason = readField(error, 'reason')
  return typeof reason === 'string' && SAFE_REASON_RE.test(reason) ? reason : OTHER_REASON
}

/** A nullable field of a thrown error, as the error carries it, else `null`. */
function nullableField(error: unknown, key: string): unknown {
  return readField(error, key) ?? null
}

/** The `ad-system-install-unreachable` message, built from a path, a reason word and fixed text. */
function unreachableMessage(binaryPath: string, reason: string): string {
  return (
    `agent-director system install at ${binaryPath} is unreachable. ` +
    `Reason: ${reason}. Diagnose with the install-cscb skill or re-install agent-director.`
  )
}

/**
 * Map the host-version decision's failure to the install check's failure arm.
 * `settled` is the resolver call the decision judged; a thrown value's
 * structural fields fill the detail.
 */
function failureResult(failure: HostVersionFailure, settled: HostVersionCallResult): InstallCheckFailure {
  const thrown = settled.kind === 'rejected'
  const error = thrown ? settled.error : undefined
  switch (failure.kind) {
    case HOST_VERSION_FAIL_NOT_FOUND:
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_NOT_FOUND,
        message:
          `agent-director not found on PATH or at the standard install path. ` +
          `Install agent-director system-wide and retry.`,
        detail: { checkedLocations: readField(error, 'checkedLocations') },
      }
    case HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM:
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_TOO_OLD,
        message: buildSystemInstallTooOldMessage({
          foundVersion: failure.foundVersion,
          requiredVersion: failure.requiredVersion,
          binaryPath: failure.binaryPath,
        }),
        detail: {
          detected: failure.foundVersion,
          required: failure.requiredVersion,
          binaryPath: failure.binaryPath,
        },
      }
    case HOST_VERSION_FAIL_VERSION_UNREADABLE: {
      // Thrown: an ErrSystemInstallUnreachable of any reason. Resolved: a
      // version the client's strict rule cannot parse (a leading `v` included).
      const reason = thrown ? unreachableReason(error) : UNPARSEABLE_VERSION_REASON
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
        message: unreachableMessage(failure.binaryPath, reason),
        detail: {
          reason,
          binaryPath: failure.binaryPath,
          diagnostic: thrown ? nullableField(error, 'diagnostic') : failure.detail,
          exitCode: thrown ? nullableField(error, 'exitCode') : null,
          signal: thrown ? nullableField(error, 'signal') : null,
        },
      }
    }
    case HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE:
      return {
        ok: false,
        classLabel: AD_VERSION_FLOOR_UNREADABLE,
        message:
          `agent-director's dist/version-floor.json '.min_binary_version' field is ` +
          `${JSON.stringify(failure.clientMinimum)}, which is not a version, so the host's ` +
          `agent-director cannot be checked. Check the agent-director npm package installed with CSCB.`,
        detail: { minBinaryVersion: failure.clientMinimum },
      }
    case HOST_VERSION_FAIL_OTHER:
      // Token-free: the thrown value's name or type, never its own message.
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
        message:
          `agent-director system install probe failed unexpectedly: ${failure.description}. ` +
          `Re-install agent-director or file a bug.`,
        detail: { underlying: failure.description, reason: OTHER_REASON },
      }
  }
}

/**
 * Run the full check (b.jg5 SRJ-212); see the module header. Reads the
 * client minimum (cached), makes one resolver call and applies the shared
 * host-version decision. The result is success (with the Phase 1 `note` when
 * the binary is below CSCB's floor) or one of the four failure class labels.
 * Never throws.
 */
export async function runInstallCheck(deps: InstallCheckDeps = {}): Promise<InstallCheckResult> {
  const floorOrFailure = readClientMinVersion()
  if (typeof floorOrFailure !== 'string') return floorOrFailure
  const floor = floorOrFailure

  const settled = await settleResolve(deps.resolveSystemBinary ?? resolveSystemBinary)
  const outcome = decideHostAdVersion(settled, floor)
  if (outcome.kind === HOST_VERSION_OUTCOME_FAIL) {
    return failureResult(outcome.failure, settled)
  }

  const success: InstallCheckSuccess = {
    ok: true,
    binaryPath: outcome.binaryPath,
    binaryVersion: outcome.version,
    floor,
  }
  if (outcome.kind === HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR) {
    success.note = buildInstallCheckPhase1Note(outcome.version)
  }
  return success
}

/**
 * @internal Test-only — reset the cached floor so subsequent calls re-read
 * `dist/version-floor.json`. Used by the install-check tests to exercise
 * both the cache and the per-failure-mode read paths.
 */
export function resetCacheForTests(): void {
  cachedFloor = null
}

/**
 * @internal Test-only — pre-populate the floor cache with a synthetic value
 * (or a pre-built failure-arm result) so tests can drive every code path
 * without mocking `node:fs`. Tests must call `resetCacheForTests()` in
 * teardown to leave the module in a clean state for the next test file.
 *
 * Pass a `string` to simulate a successful read of `dist/version-floor.json`
 * with that `.min_binary_version` value. Pass an `InstallCheckFailure` to
 * simulate a malformed-JSON / missing-field / unresolvable-subpath read.
 */
export function setFloorForTests(value: string | InstallCheckFailure): void {
  cachedFloor = value
}
