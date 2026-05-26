/**
 * agent-director-startup.ts — SR-5.1 startup gate for the agent-director
 * library dependency.
 *
 * Runs the four-step boot sequence the SRD requires before any other CSCB
 * work:
 *
 *   1. import { Client } from 'agent-director'   — covered at module load
 *      time; module-not-found surfaces as a top-level import error caught
 *      by callers' try/catch (see runAgentDirectorStartupGate's
 *      module-load-error branch below).
 *   2. new Client(opts)                          — typed catches for
 *      ErrPlatformPackageMissing, ErrUnsupportedPlatform,
 *      ErrBunVersionTooOld; other throws surface verbatim.
 *   3. await client.version({})                  — strip leading 'v',
 *      compare to MIN_AD_VERSION via semverGte.
 *   4. stat ~/.agent-director/state.db           — compare st_uid to
 *      geteuid(). ENOENT passes (the row is created on first verb call);
 *      other stat errors are fatal.
 *
 * Each failure mode records to startup-errors.log + stderr via
 * recordStartupError, then exits non-zero. The gate is tested through the
 * `deps` injection seam — production callers omit it, tests pass overrides.
 *
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

import {
  ErrBunVersionTooOld,
  ErrCallTimeout,
  ErrCliNotExecutable,
  ErrPlatformPackageMissing,
  ErrUnsupportedPlatform,
  AgentDirectorError,
} from 'agent-director'
import type { VersionResult } from 'agent-director'

import { recordStartupError } from './startup-errors.ts'
import {
  MIN_AD_VERSION,
  DEFAULT_STORE_PATH,
  getClient,
  setClientForTests,
} from './agent-director-client.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where AD persists its store; tilde-expanded for the same-user stat probe. */
const AD_STATE_DB_PATH = join(os.homedir(), '.agent-director', 'state.db')

/** Supported platforms surfaced in operator-facing remediation text. */
const SUPPORTED_PLATFORMS = ['linux-x64', 'darwin-arm64'] as const

// ---------------------------------------------------------------------------
// Pure helper: semver-gte for the three-segment versions AD ships
// ---------------------------------------------------------------------------

/**
 * Compare two `MAJOR.MINOR.PATCH` strings (no pre-release/build suffix
 * handling needed: AD ships canonical three-segment numerics).
 *
 * Returns true when `a` is greater than or equal to `b`. Inputs must parse
 * as integers — any non-numeric segment makes the comparison treat the
 * value as below `b` (i.e. fail closed).
 *
 * Exported for direct testing.
 */
export function semverGte(a: string, b: string): boolean {
  const split = (s: string): number[] =>
    s.split('.').map((seg) => {
      const n = parseInt(seg, 10)
      return Number.isFinite(n) ? n : -1
    })
  const av = split(a)
  const bv = split(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i++) {
    const ai = av[i] ?? 0
    const bi = bv[i] ?? 0
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Injectable dependency surface
// ---------------------------------------------------------------------------

export interface StartupGateDeps {
  /**
   * Hook that resolves to the singleton Client. Construction failures
   * surface as throws here (the synchronous construction path) — production code
   * passes getClient from src/agent-director-client.ts; tests pass either
   * `() => makeStubClient(...)` or a thrower that simulates the typed
   * Err* constructor failure modes.
   */
  getClient: () => unknown
  /** Hook that returns the client's `version()` result. */
  callVersion: (client: unknown) => Promise<VersionResult>
  /** Hook that returns the client's `close()` for the failure-path cleanup. */
  closeClient: (client: unknown) => void
  /** Stat hook for the SR-5.1 same-user check. */
  statSync: (path: string) => { uid: number }
  /** Effective UID hook. Returns undefined on platforms without geteuid. */
  geteuid: () => number | undefined
  /** Append to startup-errors.log + stderr; signature mirrors recordStartupError. */
  recordStartupError: typeof recordStartupError
  /** Process exit hook (terminates by default). */
  exit: (code: number) => never
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

const prodDeps: StartupGateDeps = {
  getClient: () => getClient(),
  callVersion: async (client) => {
    // Cast: production getClient returns the real Client; tests inject a stub
    // with the same structural shape. Either way, .version({}) exists.
    return await (client as { version: (p: object) => Promise<VersionResult> }).version({})
  },
  closeClient: (client) => {
    try {
      ;(client as { close: () => void }).close()
    } catch {
      // close() never throws per the library contract; defensive in tests.
    }
  },
  statSync: (path) => fs.statSync(path),
  geteuid: () => process.geteuid?.(),
  recordStartupError,
  exit: (code) => process.exit(code),
}

function mergeDeps(overrides?: Partial<StartupGateDeps>): StartupGateDeps {
  return overrides ? { ...prodDeps, ...overrides } : prodDeps
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

/**
 * Per-step result tag used by the gate to drive a single switch at the call
 * site (production code never inspects this; tests assert on it).
 */
export type StartupGateOutcome =
  | { ok: true; client: unknown; adVersion: string }
  | { ok: false; phase: 'construct' | 'version' | 'same-user' | 'unexpected'; classLabel: string; message: string }

/**
 * Run the SR-5.1 startup sequence without exiting. The dispatcher
 * (runAgentDirectorStartupGate) wraps this with the recordStartupError +
 * exit() side effects so tests can inspect both the raw outcome and the
 * exit-vs-no-exit decision.
 *
 * Construction failures (step 2) come back via thrown errors caught here;
 * if the constructor is the real `Client` and the module-load itself fails
 * (e.g. `node_modules/agent-director` was wiped), the surrounding cli.ts
 * try/catch at import time handles that branch — module-not-found cannot
 * be observed from inside this function because the import resolved at
 * top-of-file load time.
 */
export async function runStartupGate(
  deps?: Partial<StartupGateDeps>,
): Promise<StartupGateOutcome> {
  const d = mergeDeps(deps)

  // Step 2: construct Client (synchronous construction path).
  let client: unknown
  try {
    client = d.getClient()
  } catch (err) {
    if (err instanceof ErrPlatformPackageMissing) {
      return {
        ok: false,
        phase: 'construct',
        classLabel: 'ad-platform-package-missing',
        message:
          `agent-director platform-native peer dependency missing — ` +
          `your host is unsupported by agent-director. ` +
          `Supported: ${SUPPORTED_PLATFORMS.join(', ')}. ` +
          `Detected: ${process.platform}-${process.arch}. ` +
          `Detail: ${err.errDescription}`,
      }
    }
    if (err instanceof ErrUnsupportedPlatform) {
      return {
        ok: false,
        phase: 'construct',
        classLabel: 'ad-unsupported-platform',
        message:
          `agent-director does not support this platform. ` +
          `Detected: ${process.platform}-${process.arch}. ` +
          `Supported: ${SUPPORTED_PLATFORMS.join(', ')}. ` +
          `Detail: ${err.errDescription}`,
      }
    }
    if (err instanceof ErrBunVersionTooOld) {
      return {
        ok: false,
        phase: 'construct',
        classLabel: 'ad-bun-version-too-old',
        message:
          `agent-director requires Bun >= 1.0.21 but the running runtime is older. ` +
          `Upgrade Bun (https://bun.sh) and retry. Detail: ${err.errDescription}`,
      }
    }
    if (err instanceof ErrCliNotExecutable) {
      return {
        ok: false,
        phase: 'construct',
        classLabel: 'ad-cli-not-executable',
        message:
          `agent-director CLI binary is not executable. ` +
          `Detail: ${err.errDescription}. ` +
          `Remediation: chmod +x the binary referenced above, then retry.`,
      }
    }
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      phase: 'construct',
      classLabel: 'ad-client-construct',
      message: `Unexpected error constructing agent-director Client. Detail: ${detail}`,
    }
  }

  // Step 3: version probe.
  let versionResult: VersionResult
  try {
    versionResult = await d.callVersion(client)
  } catch (err) {
    if (err instanceof ErrCallTimeout) {
      d.closeClient(client)
      return {
        ok: false,
        phase: 'version',
        classLabel: 'ad-call-timeout',
        message:
          `agent-director ${err.verb}() timed out after ${err.elapsedMs}ms ` +
          `(configured callTimeoutMs: ${err.timeoutMs}ms). ` +
          `Either the subprocess hung or the timeout is set too low; ` +
          `set ClientOptions.callTimeoutMs higher (default 30000) or investigate the agent-director subprocess.`,
      }
    }
    d.closeClient(client)
    const detail =
      err instanceof AgentDirectorError
        ? `${err.errName}: ${err.errDescription}`
        : err instanceof Error
        ? err.message
        : String(err)
    return {
      ok: false,
      phase: 'version',
      classLabel: 'ad-version-probe',
      message: `agent-director version probe failed. Detail: ${detail}`,
    }
  }

  const adVersion = versionResult.version.replace(/^v/, '')
  if (!semverGte(adVersion, MIN_AD_VERSION)) {
    d.closeClient(client)
    return {
      ok: false,
      phase: 'version',
      classLabel: 'ad-version-stale',
      message:
        `agent-director version ${adVersion} is below the required minimum ${MIN_AD_VERSION}. ` +
        `Run: bun add agent-director@^${MIN_AD_VERSION}`,
    }
  }

  // Step 4: same-user check on ~/.agent-director/state.db.
  let expectedUid = d.geteuid()
  if (expectedUid === undefined || expectedUid === -1) {
    // No platform UID — defensive log, continue. CSCB targets Linux; this
    // branch is reachable only on exotic environments.
    d.recordStartupError(
      'ad-same-user-unenforced',
      `Skipping ${AD_STATE_DB_PATH} same-user check: process.geteuid() unavailable on this platform.`,
    )
    return { ok: true, client, adVersion }
  }

  try {
    const stat = d.statSync(AD_STATE_DB_PATH)
    if (stat.uid !== expectedUid) {
      d.closeClient(client)
      return {
        ok: false,
        phase: 'same-user',
        classLabel: 'ad-same-user',
        message:
          `${AD_STATE_DB_PATH} is owned by UID ${stat.uid} but this process is running as UID ${expectedUid}. ` +
          `agent-director's state DB must be owned by the same user running claude-slack-channel-bots. ` +
          `Re-install agent-director as the correct user or remove the mismatched file.`,
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // First-run case — file will be created on first verb call.
      return { ok: true, client, adVersion }
    }
    d.closeClient(client)
    return {
      ok: false,
      phase: 'same-user',
      classLabel: 'ad-same-user-stat',
      message:
        `Failed to stat ${AD_STATE_DB_PATH}: OS error ${code ?? 'unknown'}. ` +
        `Cannot verify same-user invariant on agent-director state.db.`,
    }
  }

  return { ok: true, client, adVersion }
}

/**
 * Production entry point: run the gate, log failures, exit non-zero on any
 * non-`ok` outcome. Returns the live `Client` and detected AD version on
 * success.
 *
 * Tests should call `runStartupGate(...)` directly so they can inspect the
 * raw outcome without mocking `exit`.
 */
export async function runAgentDirectorStartupGate(
  deps?: Partial<StartupGateDeps>,
): Promise<{ client: unknown; adVersion: string }> {
  const d = mergeDeps(deps)
  const outcome = await runStartupGate(deps)
  if (!outcome.ok) {
    d.recordStartupError(outcome.classLabel, outcome.message)
    d.exit(1) // never returns; the cast below silences TS narrowing
    // unreachable; satisfies TS when exit() is mocked in tests
    return { client: null, adVersion: '' }
  }
  return { client: outcome.client, adVersion: outcome.adVersion }
}

// ---------------------------------------------------------------------------
// Re-exports for callers / tests
// ---------------------------------------------------------------------------

export {
  MIN_AD_VERSION,
  DEFAULT_STORE_PATH,
  AD_STATE_DB_PATH as DEFAULT_STATE_DB_PATH,
  SUPPORTED_PLATFORMS,
  setClientForTests,
}
