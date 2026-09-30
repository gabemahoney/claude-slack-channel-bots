#!/usr/bin/env bun
/**
 * scripts/ad-version-check.ts — `/publish`'s agent-director host check, the
 * check `scripts/preflight.sh` gate SR-2.5 runs (b.jg5 SRJ-211).
 *
 * Usage:  bun scripts/ad-version-check.ts <patch|minor|major>
 *
 * Resolves the host's agent-director binary with the client's
 * `resolveSystemBinary()` and judges it with the one host-version decision,
 * `decideHostAdVersion` in `src/ad-version-gate.ts`: against the installed
 * client's minimum (`readClientMinVersion` in `src/install-check.ts`), then
 * CSCB's Phase 1 floor.
 *
 *   - pass: one stdout line naming the binary and its version; exit 0;
 *   - pass below the floor: the same line, plus the Phase 1 note as an
 *     `SR-2.5 (preflight) NOTE` block on stderr; exit 0;
 *   - fail (not found, version unreadable, below the client minimum, the
 *     client minimum unreadable, other): one `SR-2.5 (preflight)` diagnostic
 *     on stderr, naming the switch-over runbook section; exit
 *     {@link AD_VERSION_CHECK_FAIL_EXIT_CODE}.
 *
 * No output advises upgrading agent-director or editing `package.json`'s
 * agent-director version: the switch-over runbook is the one way to change
 * the host's agent-director.
 *
 * {@link runAdVersionCheck} holds the logic with its resolver injected (no
 * default), so tests drive it in process with a stub; it neither writes nor
 * exits. Only {@link main} passes the client's `resolveSystemBinary`, writes
 * the lines and exits.
 *
 * Publish-time only: not in `package.json` `files`, never shipped.
 *
 * SPDX-License-Identifier: MIT
 */

import { resolveSystemBinary } from 'agent-director'
import type { ResolveSystemBinaryResult } from 'agent-director'

import {
  buildPhase1HostNote,
  decideHostAdVersion,
  HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM,
  HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE,
  HOST_VERSION_FAIL_NOT_FOUND,
  HOST_VERSION_FAIL_OTHER,
  HOST_VERSION_FAIL_VERSION_UNREADABLE,
  HOST_VERSION_OUTCOME_FAIL,
  HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR,
  PHASE1_FLOOR_VERSION,
  PHASE1_RUNBOOK_SECTION_TITLE,
  settleHostVersionCall,
  type HostVersionFailure,
} from '../src/ad-version-gate.ts'
import { readClientMinVersion, type InstallCheckFailure } from '../src/install-check.ts'

/** The prefix of every SR-2.5 line: the pass line and each failure diagnostic. */
export const SR25_PREFIX = 'SR-2.5 (preflight)'

/** The prefix of the Phase 1 note block on stderr. */
export const SR25_NOTE_PREFIX = `${SR25_PREFIX} NOTE`

/**
 * The exit status of a failed check: the same code `scripts/preflight.sh`
 * exits with for SR-2.5, so the gate can tell the check's own failure from a
 * crash.
 */
export const AD_VERSION_CHECK_FAIL_EXIT_CODE = 15

/** The rerun hint's bump kind when none is given. */
const BUMP_KIND_PLACEHOLDER = '<patch|minor|major>'

/** Where every failure diagnostic points the operator. */
const RUNBOOK_POINTER = `the switch-over runbook in the README (section "${PHASE1_RUNBOOK_SECTION_TITLE}")`

/** Where the installed client keeps its minimum. */
const CLIENT_MINIMUM_FIELD = `'min_binary_version' in agent-director/dist/version-floor.json`

/** Dependencies of {@link runAdVersionCheck}. */
export interface AdVersionCheckDeps {
  /** agent-director's `resolveSystemBinary`; no default (only {@link main} passes the client's). */
  resolveSystemBinary: () => Promise<ResolveSystemBinaryResult>
  /** The installed client's minimum, or its read failure; default `readClientMinVersion` from `src/install-check.ts`. */
  readClientMinVersion?: () => string | InstallCheckFailure
  /** The bump kind the rerun hint names (`/publish <bump>`); a placeholder when absent. */
  bumpKind?: string
}

/** What one check run produced: the exit status and the lines for stdout and stderr, in order. */
export interface AdVersionCheckRun {
  readonly exitCode: number
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

/** The client minimum, or `undefined` when it cannot be read (a read failure or a throwing reader). */
function readMinimum(read: () => string | InstallCheckFailure): string | undefined {
  try {
    const minimum = read()
    return typeof minimum === 'string' ? minimum : undefined
  } catch {
    return undefined
  }
}

/**
 * The one SR-2.5 failure diagnostic for `failure`: what was found, the
 * operator's recovery and the switch-over runbook section. It never advises
 * upgrading agent-director or editing `package.json`.
 */
export function buildAdVersionCheckFailure(failure: HostVersionFailure, bumpKind: string = BUMP_KIND_PLACEHOLDER): string {
  const rerun = `rerun '/publish ${bumpKind}'`
  switch (failure.kind) {
    case HOST_VERSION_FAIL_NOT_FOUND:
      return (
        `${SR25_PREFIX}: no agent-director binary was found on this host (PATH or the standard install path). ` +
        `This CSCB release needs agent-director Phase 1 on the host. ` +
        `Operator recovery: install agent-director by following ${RUNBOOK_POINTER}, then ${rerun}.`
      )
    case HOST_VERSION_FAIL_VERSION_UNREADABLE:
      return (
        `${SR25_PREFIX}: the host's agent-director at ${failure.binaryPath} did not give a version that can be read ` +
        `(${failure.detail}). ` +
        `Operator recovery: check that the binary at ${failure.binaryPath} runs and reports its version; ` +
        `the host's agent-director is installed by following ${RUNBOOK_POINTER}; then ${rerun}.`
      )
    case HOST_VERSION_FAIL_BELOW_CLIENT_MINIMUM:
      return (
        `${SR25_PREFIX}: the host's agent-director ${failure.foundVersion} at ${failure.binaryPath} is below ` +
        `the agent-director client's minimum ${failure.requiredVersion}, so the client refuses it. ` +
        `This CSCB release needs agent-director Phase 1 (${PHASE1_FLOOR_VERSION} or later, release candidates included). ` +
        `Operator recovery: install agent-director by following ${RUNBOOK_POINTER}, then ${rerun}.`
      )
    case HOST_VERSION_FAIL_CLIENT_MINIMUM_UNREADABLE:
      return clientMinimumUnreadable(`${CLIENT_MINIMUM_FIELD} is ${JSON.stringify(failure.clientMinimum)}, which is not a version`, bumpKind)
    case HOST_VERSION_FAIL_OTHER:
      return (
        `${SR25_PREFIX}: checking the host's agent-director failed: ${failure.description}. ` +
        `Operator recovery: check the host's agent-director install against ${RUNBOOK_POINTER}, then ${rerun}.`
      )
  }
}

/**
 * The client-minimum-unreadable diagnostic, with the file, the field and what
 * was found. SR-2.2 has already installed what `bun.lock` pins before SR-2.5
 * runs, so it names no command to run: the operator assesses before any rerun.
 */
function clientMinimumUnreadable(found: string, bumpKind: string): string {
  return (
    `${SR25_PREFIX}: the installed agent-director client's minimum binary version could not be read: ${found}, ` +
    `so the host's agent-director cannot be checked. ` +
    `SR-2.2 has already installed what bun.lock pins, so rerunning as is will not change this. ` +
    `Operator recovery: report this output verbatim; the operator assesses the installed agent-director client ` +
    `before any rerun of '/publish ${bumpKind}'. ` +
    `The host's agent-director is covered by ${RUNBOOK_POINTER}.`
  )
}

/**
 * Run SR-2.5's check once (b.jg5 SRJ-211): read the client minimum, make one
 * resolver call and apply `decideHostAdVersion`. Returns the exit status and
 * the lines; never writes, exits or rejects. A client minimum that cannot be
 * read fails before the resolver is called.
 */
export async function runAdVersionCheck(deps: AdVersionCheckDeps): Promise<AdVersionCheckRun> {
  const bumpKind = deps.bumpKind ?? BUMP_KIND_PLACEHOLDER
  const minimum = readMinimum(deps.readClientMinVersion ?? readClientMinVersion)
  if (minimum === undefined) {
    return {
      exitCode: AD_VERSION_CHECK_FAIL_EXIT_CODE,
      stdout: [],
      stderr: [
        clientMinimumUnreadable(
          `${CLIENT_MINIMUM_FIELD} is missing, or the file cannot be found, read or parsed`,
          bumpKind,
        ),
      ],
    }
  }
  const outcome = decideHostAdVersion(await settleHostVersionCall(deps.resolveSystemBinary), minimum)
  if (outcome.kind === HOST_VERSION_OUTCOME_FAIL) {
    return {
      exitCode: AD_VERSION_CHECK_FAIL_EXIT_CODE,
      stdout: [],
      stderr: [buildAdVersionCheckFailure(outcome.failure, bumpKind)],
    }
  }
  const passLine =
    `${SR25_PREFIX}: host agent-director ${outcome.version} at ${outcome.binaryPath} ` +
    `meets the agent-director client's minimum ${minimum}.`
  const stderr =
    outcome.kind === HOST_VERSION_OUTCOME_PASS_BELOW_FLOOR
      ? [`${SR25_NOTE_PREFIX}: ${buildPhase1HostNote({ foundVersion: outcome.version, binaryPath: outcome.binaryPath })}`]
      : []
  return { exitCode: 0, stdout: [passLine], stderr }
}

/** Run the check against the host's real binary, write its lines and exit with its status. */
export async function main(): Promise<void> {
  const run = await runAdVersionCheck({ resolveSystemBinary, bumpKind: process.argv[2] })
  for (const line of run.stdout) process.stdout.write(line + '\n')
  for (const line of run.stderr) process.stderr.write(line + '\n')
  process.exit(run.exitCode)
}

if (import.meta.main) {
  void main()
}
