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
 *     the too-old message names the switch-over runbook section, the
 *     not-found message its publishing-host block, the client-package texts
 *     {@link CLIENT_PACKAGE_REMEDY}, and no message advises installing,
 *     reinstalling or upgrading agent-director (b.jg5 SRJ-208, SRJ-1101);
 *   - a binary the client accepts but below CSCB's Phase 1 floor (`0.10.0`,
 *     `0.0.0-dev`) passes with the Phase 1 `note`: the server refuses to start
 *     on it until agent-director Phase 1 is installed;
 *   - a binary that meets the floor passes with no note.
 *
 * A failure's `detail` keeps the thrown error's structural fields, but every
 * text in it (a binary's diagnostic output, a signal, a checked location, a
 * failed read's error message) is one token-free line: token- and URL-like
 * text redacted and line breaks collapsed by `redactToOneLine`
 * (`src/ad-version-gate.ts`). The reason word comes from the decision.
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
import type { ResolveSystemBinaryResult } from 'agent-director'

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
  PHASE1_RUNBOOK_SECTION_TITLE,
  PUBLISHING_HOST_BLOCK_HEADING,
  readField,
  redactToOneLine,
  settleHostVersionCall,
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
 * The README's switch-over runbook section, named by its title
 * (`PHASE1_RUNBOOK_SECTION_TITLE`), as the install check's and the startup
 * gate's texts point to it. No text that carries it advises installing,
 * reinstalling, upgrading or removing anything (b.jg5 SRJ-208, SRJ-212,
 * SRJ-1101).
 */
export const RUNBOOK_SECTION_POINTER = `the README's switch-over runbook section "${PHASE1_RUNBOOK_SECTION_TITLE}"`

/**
 * The publishing-host block (`PUBLISHING_HOST_BLOCK_HEADING`) inside the
 * switch-over runbook section: where the install check's not-found text
 * points, since that block covers a host with no agent-director (b.jg5
 * SRJ-1108, SRJ-212). The startup gate's not-found text points at
 * `RUNBOOK_SECTION_POINTER` instead (it runs on a bot host).
 */
export const PUBLISHING_HOST_BLOCK_POINTER = `the block "${PUBLISHING_HOST_BLOCK_HEADING}" in ${RUNBOOK_SECTION_POINTER}`

/**
 * The remedy every text about the agent-director client package carries (the
 * `ad-version-floor-unreadable` texts here and the startup gate's three
 * `ad-shim-*` probes; b.jg5 SRJ-208): check the package installed with CSCB,
 * and the runbook section. It names no reinstall, upgrade, `@latest` or
 * package-manager command.
 */
export const CLIENT_PACKAGE_REMEDY = `Check the agent-director npm package installed with CSCB; see ${RUNBOOK_SECTION_POINTER}.`

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

/** The client's floor file as agent-director's package exports it. */
const FLOOR_FILE_SPECIFIER = 'agent-director/dist/version-floor.json'

/**
 * Dependencies of {@link readClientMinVersion}. Tests inject them to reach
 * each failure path without module mocks.
 */
export interface ClientMinVersionDeps {
  /**
   * Resolves the floor file's `file:` URL; default: `import.meta.resolve` of
   * `agent-director/dist/version-floor.json` from this module. A throw is the
   * could-not-resolve failure; a non-`file:` URL is a read failure.
   */
  resolveFloorUrl?: () => string
  /**
   * Reads the floor file at a filesystem path as UTF-8 text; default:
   * `readFileSync(path, 'utf-8')`. A throw is the could-not-read failure.
   */
  readFile?: (path: string) => string
}

/**
 * The installed agent-director client's minimum binary version: read AD's
 * `dist/version-floor.json` via the subpath export and return the
 * `.min_binary_version` value. Returns a pre-built
 * `ad-version-floor-unreadable` failure-arm result on any failure mode
 * (unresolvable subpath, unreadable file, parse error, missing/non-string
 * field); a thrown error's message is its `detail.underlying`, as one
 * token-free line.
 *
 * Cache: with no deps (or an empty deps object) the value or the failure is
 * cached, and later calls return it without re-reading;
 * {@link resetCacheForTests} and {@link setFloorForTests} reset and seed the
 * cache. When any dep is injected the call bypasses the cache entirely: it
 * neither returns a cached value nor stores its own result.
 */
export function readClientMinVersion(deps: ClientMinVersionDeps = {}): string | InstallCheckFailure {
  if (deps.resolveFloorUrl === undefined && deps.readFile === undefined) {
    if (cachedFloor === null) cachedFloor = readFloorFile({})
    return cachedFloor
  }
  return readFloorFile(deps)
}

/** One uncached read of the floor file; see {@link readClientMinVersion}. */
function readFloorFile(deps: ClientMinVersionDeps): string | InstallCheckFailure {
  const resolveFloorUrl = deps.resolveFloorUrl ?? (() => import.meta.resolve(FLOOR_FILE_SPECIFIER))
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'))

  let resolved: string
  try {
    resolved = resolveFloorUrl()
  } catch (err) {
    return {
      ok: false,
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
      message:
        `Could not resolve '${FLOOR_FILE_SPECIFIER}' from the installed ` +
        `agent-director package. ${CLIENT_PACKAGE_REMEDY}`,
      detail: { underlying: underlyingMessage(err) },
    }
  }

  let raw: string
  try {
    raw = readFile(fileURLToPath(resolved))
  } catch (err) {
    return {
      ok: false,
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
      message:
        `Could not read agent-director's dist/version-floor.json. ` +
        CLIENT_PACKAGE_REMEDY,
      detail: { underlying: underlyingMessage(err) },
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
      message:
        `agent-director's dist/version-floor.json failed to parse as JSON. ` +
        CLIENT_PACKAGE_REMEDY,
      detail: { underlying: underlyingMessage(err) },
    }
  }

  const floor = (parsed as { min_binary_version?: unknown } | null)?.min_binary_version
  if (typeof floor !== 'string' || floor.length === 0) {
    return {
      ok: false,
      classLabel: AD_VERSION_FLOOR_UNREADABLE,
      message:
        `agent-director's dist/version-floor.json is missing the required '.min_binary_version' field ` +
        `(or it is not a non-empty string). ${CLIENT_PACKAGE_REMEDY}`,
      detail: { parsed },
    }
  }

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

/** A text field of a thrown error as one token-free line ({@link redactToOneLine}), else `null`. */
function safeText(value: unknown): string | null {
  return typeof value === 'string' ? redactToOneLine(value) : null
}

/** A thrown error's `exitCode` when it is a number, else `null`. */
function safeExitCode(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * An `ErrSystemInstallNotFound`'s `checkedLocations` with each entry's text
 * as one token-free line (an entry's `detail` is a path or the whole PATH);
 * an empty list when the field is not a list or cannot be read.
 */
function safeCheckedLocations(value: unknown): Array<{ kind: string | null; detail: string | null }> {
  if (!Array.isArray(value)) return []
  try {
    return value.map((entry: unknown) => ({
      kind: safeText(readField(entry, 'kind')),
      detail: safeText(readField(entry, 'detail')),
    }))
  } catch {
    return []
  }
}

/** The `underlying` detail of a failed read: the thrown value's message as one token-free line, else `null`. */
function underlyingMessage(err: unknown): string | null {
  return safeText(readField(err, 'message'))
}

/** The `ad-system-install-unreachable` message, built from a path, a reason word and fixed text. */
function unreachableMessage(binaryPath: string, reason: string): string {
  return (
    `agent-director system install at ${binaryPath} is unreachable. ` +
    `Reason: ${reason}. Diagnose with the install-cscb skill; see ${RUNBOOK_SECTION_POINTER}.`
  )
}

/**
 * Map the host-version decision's failure to the install check's failure arm.
 * `settled` is the resolver call the decision judged; a thrown value's
 * structural fields fill the detail, each text one token-free line
 * (`redactToOneLine`). The reason word comes from the decision.
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
          `See ${PUBLISHING_HOST_BLOCK_POINTER}, which covers a host with no agent-director.`,
        detail: { checkedLocations: safeCheckedLocations(readField(error, 'checkedLocations')) },
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
      const { reason } = failure
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
        message: unreachableMessage(failure.binaryPath, reason),
        detail: {
          reason,
          binaryPath: failure.binaryPath,
          diagnostic: thrown ? safeText(readField(error, 'diagnostic')) : failure.detail,
          exitCode: thrown ? safeExitCode(readField(error, 'exitCode')) : null,
          signal: thrown ? safeText(readField(error, 'signal')) : null,
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
          `agent-director cannot be checked. ${CLIENT_PACKAGE_REMEDY}`,
        detail: { minBinaryVersion: failure.clientMinimum },
      }
    case HOST_VERSION_FAIL_OTHER:
      // Token-free: the thrown value's name or type, never its own message.
      return {
        ok: false,
        classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
        message:
          `agent-director system install probe failed unexpectedly: ${failure.description}. ` +
          `See ${RUNBOOK_SECTION_POINTER}, or file a bug.`,
        detail: { underlying: failure.description, reason: HOST_VERSION_FAIL_OTHER },
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

  const settled = await settleHostVersionCall(deps.resolveSystemBinary ?? resolveSystemBinary)
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
