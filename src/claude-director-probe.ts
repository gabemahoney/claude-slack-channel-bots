/**
 * claude-director-probe.ts — Startup guards for the claude-director dependency.
 *
 * ## Injection shape: option (a) — optional `deps` argument
 *
 * Each exported helper accepts an optional `DepProbeDeps` bag as its last
 * argument. Production callers omit it; unit tests pass a full or partial
 * override bundle.
 *
 * ## Exports (for Test Writer / CTW1)
 *
 *   - `CLAUDE_DIRECTOR_INSTALL_DOCS_URL`     — install-docs URL constant
 *   - `DepProbeDeps`                          — injectable dependency interface
 *   - `VersionProbeResult`                   — structured result from runVersionProbe()
 *   - `runVersionProbe(deps?)`               — core probe, returns structured result
 *   - `assertClaudeDirectorPresentFatal(deps?)`      — CE1 fatal mode
 *   - `assertClaudeDirectorPresentBestEffort(deps?)` — CE1 best-effort mode (T-E)
 *   - `assertClaudeDirectorStateDbSameUserFatal(deps?)` — CE2 same-user check
 *   - `runStartupGates(deps)`                — ordered gate runner for main() + ordering tests
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { recordStartupError } from './startup-errors.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Install documentation URL for claude-director.
 * Points to the Install section of the upstream repo README, which is the
 * canonical install page (no separate install site exists at time of writing).
 */
export const CLAUDE_DIRECTOR_INSTALL_DOCS_URL =
  'https://github.com/gabemahoney/claude-director#install'

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * All injectable dependencies used by the probe helpers.
 * Production callers omit the `deps` argument; tests pass overrides here.
 */
export interface DepProbeDeps {
  /**
   * Argv-style exec function. Takes [cmd, ...args], returns { exitCode, stdout, stderr }.
   * May throw with a `code` property (e.g. ENOENT) to simulate spawn errors.
   */
  exec: (argv: [string, ...string[]]) => { exitCode: number | null; stdout: string; stderr: string; signal?: string | null }

  /** Stat a path — returns { uid }, may throw with a `code` property. */
  statSync: (path: string) => { uid: number }

  /** Returns the process effective UID, or undefined on platforms that lack geteuid. */
  geteuid: () => number | undefined

  /** Returns os.userInfo(). */
  userInfo: () => { uid: number }

  /** Replaces recordStartupError — receives (classLabel, message, cause?). */
  recordStartupError: (classLabel: string, message: string, cause?: unknown) => void

  /** Replaces process.exit. */
  exit: (code: number) => never

  /** Called after the two probe gates pass. Provided only by runStartupGates. */
  checkPidConflict?: (pidFile: string) => void

  /** Optional trace array for ordering tests. Each gate appends its name. */
  startupTrace?: string[]
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

function prodExec(argv: [string, ...string[]]): { exitCode: number | null; stdout: string; stderr: string; signal?: string | null } {
  const [cmd, ...args] = argv
  const result = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (result.error) {
    // Rethrow as a plain Error with a `code` property so the probe can classify it
    const err: NodeJS.ErrnoException = result.error as NodeJS.ErrnoException
    throw err
  }
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
  }
}

const prodDeps: DepProbeDeps = {
  exec: prodExec,
  statSync: (p) => fs.statSync(p),
  geteuid: () => process.geteuid?.(),
  userInfo: () => os.userInfo(),
  recordStartupError,
  exit: (code) => process.exit(code),
}

function mergeDeps(overrides?: Partial<DepProbeDeps>): DepProbeDeps {
  return overrides ? { ...prodDeps, ...overrides } : prodDeps
}

// ---------------------------------------------------------------------------
// CE1 — version probe core
// ---------------------------------------------------------------------------

export interface VersionProbeResult {
  ok: boolean
  reason?: 'missing' | 'nonzero-exit' | 'signal' | 'empty-output' | 'spawn-error'
  details?: string
}

/**
 * Run `claude-director version` and return a structured result.
 * Never throws; all error paths are captured in the result.
 */
export function runVersionProbe(deps?: Partial<DepProbeDeps>): VersionProbeResult {
  const d = mergeDeps(deps)

  let result: { exitCode: number | null; stdout: string; stderr: string; signal?: string | null }

  try {
    result = d.exec(['claude-director', 'version'])
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const details = code === 'ENOENT'
      ? 'binary not found on PATH (ENOENT)'
      : `spawn error: ${code ?? String(err)}`
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'spawn-error', details }
  }

  if (result.signal) {
    return { ok: false, reason: 'signal', details: `terminated by signal ${result.signal}` }
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim().slice(0, 300)
    return {
      ok: false,
      reason: 'nonzero-exit',
      details: `exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ''}`,
    }
  }

  if (!result.stdout.trim()) {
    return { ok: false, reason: 'empty-output', details: 'stdout was empty or whitespace' }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// CE1 — fatal wrapper (used by main())
// ---------------------------------------------------------------------------

/**
 * Assert that `claude-director` is present and working.
 * On failure: record a dep-probe startup error and exit(1).
 * On success: returns silently.
 */
export function assertClaudeDirectorPresentFatal(deps?: Partial<DepProbeDeps>): void {
  const d = mergeDeps(deps)
  const probe = runVersionProbe(deps)
  if (probe.ok) return

  let message: string
  if (probe.reason === 'missing') {
    message =
      `claude-director binary not found on PATH. ` +
      `Install it and ensure it is executable before starting claude-slack-channel-bots. ` +
      `Install docs: ${CLAUDE_DIRECTOR_INSTALL_DOCS_URL}`
  } else if (probe.reason === 'nonzero-exit') {
    message =
      `claude-director was found but returned a non-zero exit code — the binary may be corrupt or misconfigured. ` +
      `Details: ${probe.details ?? 'unknown'}. ` +
      `Install docs: ${CLAUDE_DIRECTOR_INSTALL_DOCS_URL}`
  } else if (probe.reason === 'signal') {
    message =
      `claude-director was found but was terminated by a signal during the version check. ` +
      `Details: ${probe.details ?? 'unknown'}. ` +
      `Install docs: ${CLAUDE_DIRECTOR_INSTALL_DOCS_URL}`
  } else if (probe.reason === 'empty-output') {
    message =
      `claude-director returned empty output for 'version' — the binary may be corrupt or a wrong executable is on PATH. ` +
      `Install docs: ${CLAUDE_DIRECTOR_INSTALL_DOCS_URL}`
  } else {
    message =
      `claude-director spawn error. Details: ${probe.details ?? 'unknown'}. ` +
      `Install docs: ${CLAUDE_DIRECTOR_INSTALL_DOCS_URL}`
  }

  d.recordStartupError('dep-probe', message)
  d.exit(1)
}

// ---------------------------------------------------------------------------
// CE1 — best-effort wrapper (used by T-E / postinstall)
// ---------------------------------------------------------------------------

/**
 * Best-effort version of the presence probe.
 * Returns the structured result; never records a startup error or exits.
 * The caller (T-E) is responsible for logging failures via console.error only.
 */
export function assertClaudeDirectorPresentBestEffort(deps?: Partial<DepProbeDeps>): VersionProbeResult {
  return runVersionProbe(deps)
}

// ---------------------------------------------------------------------------
// CE2 — state.db same-user check
// ---------------------------------------------------------------------------

/**
 * Assert that ~/.claude-director/state.db (if present) is owned by the
 * current effective UID. On UID mismatch or unexpected stat error: record
 * a dep-probe-same-user startup error and exit(1). ENOENT is a silent pass.
 * When the platform does not expose a UID, record dep-probe-same-user-unenforced
 * and continue.
 */
export function assertClaudeDirectorStateDbSameUserFatal(deps?: Partial<DepProbeDeps>): void {
  const d = mergeDeps(deps)

  const dbPath = join(os.homedir(), '.claude-director', 'state.db')

  // Resolve effective UID
  let expectedUid: number | undefined = d.geteuid()
  if (expectedUid === undefined) {
    try {
      expectedUid = d.userInfo().uid
    } catch {
      // userInfo() can throw on some platforms
    }
  }

  // Platform fallback: UID concept not available (Windows / exotic environments)
  // Same-user invariant is unenforced on this platform.
  if (expectedUid === undefined || expectedUid === -1) {
    d.recordStartupError(
      'dep-probe-same-user-unenforced',
      `claude-director state.db same-user check skipped: ` +
      `process.geteuid() and os.userInfo().uid are both unavailable on this platform. ` +
      `The same-user invariant is unenforced here (CSCB targets Linux; this path is defensive only).`,
    )
    return
  }

  let stat: { uid: number }
  try {
    stat = d.statSync(dbPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // First-run case: file does not exist yet — pass silently.
      return
    }
    // Any other stat error (EACCES, EIO, ELOOP, …) is fatal.
    d.recordStartupError(
      'dep-probe-same-user',
      `Failed to stat ${dbPath}: OS error ${code ?? 'unknown'}. ` +
      `Cannot verify that claude-director state.db is owned by the current user.`,
      err,
    )
    d.exit(1)
    return // unreachable but satisfies the type-checker when exit is mocked
  }

  const observedUid = stat.uid
  if (observedUid !== expectedUid) {
    d.recordStartupError(
      'dep-probe-same-user',
      `${dbPath} is owned by UID ${observedUid} but this process is running as UID ${expectedUid}. ` +
      `Invariant: claude-director state.db must be owned by the user running claude-slack-channel-bots. ` +
      `Re-install claude-director as the correct user or remove the mismatched state file.`,
    )
    d.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Ordered gate runner — used by main() and ordering tests (CTW1)
// ---------------------------------------------------------------------------

/**
 * Runs all startup gates in the required order:
 *   1. assertClaudeDirectorPresentFatal   (CE1)
 *   2. assertClaudeDirectorStateDbSameUserFatal (CE2)
 *   3. checkPidConflict(pidFile)          (existing guard)
 *
 * The optional `startupTrace` array receives the name of each gate as it
 * completes, enabling CTW1 ordering assertions without mocking process.exit.
 *
 * Production callers pass only `{ checkPidConflict, pidFile }`.
 */
export function runStartupGates(deps: Partial<DepProbeDeps> & {
  checkPidConflict: (pidFile: string) => void
  pidFile: string
}): void {
  const { checkPidConflict: cpf, pidFile, startupTrace, ...probeDeps } = deps

  assertClaudeDirectorPresentFatal(probeDeps)
  startupTrace?.push('dep-probe')

  assertClaudeDirectorStateDbSameUserFatal(probeDeps)
  startupTrace?.push('dep-probe-same-user')

  cpf(pidFile)
  startupTrace?.push('checkPidConflict')
}
