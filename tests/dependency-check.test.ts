/**
 * dependency-check.test.ts — SR-5.1 startup-gate sub-case matrix.
 *
 * Exercises src/agent-director-startup.ts via the dep-injection seam — never
 * touches the real Bun FFI or the real ~/.agent-director/state.db, and never
 * calls the production `createClient`. Covers:
 *
 *   1. ErrBunVersionTooOld at Client construction (Bun-version gate).
 *   2. ErrSystemInstallNotFound / ErrSystemInstallTooOld /
 *      ErrSystemInstallUnreachable from `Client.create` (the client's
 *      system-install discovery errors).
 *   3. Non-typed construct-step throws surface verbatim.
 *   4. CSCB's Phase 1 floor on the client's `binaryVersion` (b.jg5 SRJ-203,
 *      SRJ-1513), the refusal kind every failure carries, and the
 *      floor-exempt `skipPhase1Floor` option.
 *   4a. The floor and too-old refusal messages (b.jg5 SRJ-208): the runbook
 *      section title, no upgrade instruction, the install-skill block only on
 *      the too-old message.
 *   5. API-surface probes (getPermission / error catalog / decide argv).
 *   5a. The error-catalogue check (b.jg5 SRJ-102): the pure
 *      `checkErrorCatalog` over dist text built in the test from
 *      `REQUIRED_ERR_NAMES`, never the installed client's dist, and a
 *      probe built from it through the gate and its wrapper.
 *   5b. The 0.10.0 error classes `src/agent-director-errors.ts`
 *      re-exports for the classifier (the four tmux-side and unknown-name
 *      classes and ErrSendKeysWhileRelayed) are the client's own (b.jg5
 *      SRJ-103).
 *   6. Same-user mismatch on ~/.agent-director/state.db.
 *   7. Happy path: gate passes silently and installs the Client into the
 *      module-level singleton via setClient(...).
 *   8. `runAgentDirectorStartupGate`: one record call and one exit per
 *      refusal, none on a pass.
 *   9. The call timeout (b.jg5 SRJ-213, SRJ-121): `runStartupGate`'s
 *      `callTimeoutMs` option reaches the client's options (absent without
 *      it), and the server's persona client (`buildPersonaClient`, exiting
 *      form `buildPersonaClientOrExit`) is built with the value, passes the
 *      floor, replaces the gate's client and closes it once.
 *
 * Every agent-director version comes from
 * tests/test-helpers/agent-director-versions.ts (or `STALE_VERSION` from
 * install-check-fixtures.ts); labels and kinds come from `src/`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ErrSendKeysWhileRelayed as AdErrSendKeysWhileRelayed,
  ErrTmuxCaptureFailed as AdErrTmuxCaptureFailed,
  ErrTmuxSendKeys as AdErrTmuxSendKeys,
  ErrTmuxSessionCreate as AdErrTmuxSessionCreate,
  ErrUnknownErrorName as AdErrUnknownErrorName,
} from 'agent-director'

import {
  runStartupGate,
  runAgentDirectorStartupGate,
  buildPersonaClient,
  buildPersonaClientOrExit,
  checkErrorCatalog,
  DEFAULT_STATE_DB_PATH,
  REFUSAL_KIND_BELOW_PHASE1_FLOOR,
  REFUSAL_KIND_CLIENT_TOO_OLD,
  REFUSAL_KIND_OTHER,
  REQUIRED_ERR_NAMES,
} from '../src/agent-director-startup.ts'
import type { StartupGateDeps } from '../src/agent-director-startup.ts'
import {
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrSendKeysWhileRelayed,
  ErrTmuxCaptureFailed,
  ErrTmuxSendKeys,
  ErrTmuxSessionCreate,
  ErrUnknownErrorName,
  PHASE1_ONLY_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import { DEFAULT_STORE_PATH, getClient, resetClientForTests } from '../src/agent-director-client.ts'
import {
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
} from '../src/config.ts'
import {
  AD_BELOW_PHASE1_FLOOR,
  AD_SHIM_CATALOG_INCOMPLETE,
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
} from '../src/install-check.ts'
import { PHASE1_FLOOR_VERSION, PHASE1_RUNBOOK_SECTION_TITLE, RUNTIME_RECHECK_PHRASE } from '../src/ad-version-gate.ts'
import { renderInstallSkillInstructions } from '../src/install-skill-pointer.ts'
import { recordStartupError } from '../src/startup-errors.ts'
import {
  cannedVersion,
  errBunVersionTooOld,
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
  makeStubClient,
  makeStubCreateClient,
} from './test-helpers/agent-director-stub.ts'
import type { StubClient, StubClientOptions, StubCreateClientOptions } from './test-helpers/agent-director-stub.ts'
import {
  CLIENT_MIN_VERSION,
  DEV_PLACEHOLDER_VERSION,
  DEV_UNPARSEABLE_VERSION,
  OLD_AD_VERSION,
  PHASE1_RC_VERSION,
} from './test-helpers/agent-director-versions.ts'
import { STALE_VERSION } from './test-helpers/install-check-fixtures.ts'
import { flat } from './test-helpers/markdown.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'

// ---------------------------------------------------------------------------
// Helpers for SR-5.1 sub-cases
// ---------------------------------------------------------------------------

/**
 * Build the dep-injection points that every sub-case needs to override:
 *   - `createClient` (async factory — throws for construct-step failures,
 *     resolves with a stub Client for everything past step 2)
 *   - `statSync` (rarely reached, default → ENOENT)
 *   - `geteuid` (UID source for the same-user check)
 *   - `recordStartupError` capture (never invoked by runStartupGate in
 *     non-exit mode, but the production wrapper would call it on failure;
 *     leave a no-op stub here)
 */
function defaultStat(): { uid: number } {
  // Default path: ENOENT — same-user check passes silently.
  const err: NodeJS.ErrnoException = new Error('ENOENT')
  err.code = 'ENOENT'
  throw err
}

const noopRecord = () => { /* swallow */ }
const noopExit = (_code: number) => { throw new Error('exit should not be reached in non-failing runStartupGate path') }

/**
 * The three API-surface probes (Step 3.5) run after the version gate. For any
 * test that flows past the version step (same-user, happy-path, and the new
 * probe sub-cases below), inject these passing-by-default overrides — the
 * production defaults read live node_modules and would otherwise short-circuit
 * the gate before the same-user / happy-path branches under test.
 */
const passingProbes = {
  probeGetPermission: () => true,
  probeErrorCatalog: () => ({ ok: true as const }),
  probeDecideArgv: async () => ({ ok: true as const }),
}

/** The release after the floor's minor, built from the floor constant. */
const LATER_RELEASE = (() => {
  const [major, minor] = PHASE1_FLOOR_VERSION.split('.').map(Number)
  return `${major}.${minor + 1}.0`
})()

/**
 * Deps for a run that reaches the gate's end when nothing is overridden:
 * a default stub (`PHASE1_RC_VERSION`), passing probes, ENOENT state.db,
 * UID 1000. Each case overrides the step under test.
 */
function passingDeps(overrides: Partial<StartupGateDeps> = {}): Partial<StartupGateDeps> {
  return {
    createClient: makeStubCreateClient(),
    ...passingProbes,
    statSync: defaultStat,
    geteuid: () => 1000,
    recordStartupError: noopRecord,
    exit: noopExit,
    ...overrides,
  }
}

/** A client factory resolving with a default stub reporting `binaryVersion`. */
function clientAt(binaryVersion: string): StartupGateDeps['createClient'] {
  return makeStubCreateClient({ client: makeStubClient({ binaryVersion }) })
}

/** The options each create call was given, as `makeStubCreateClient` records them. */
type RecordedClientOptions = NonNullable<StubCreateClientOptions['calls']>

/** The call timeouts the cases pass: the setting's bounds and its default. */
const CALL_TIMEOUTS_MS = [
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
]

/**
 * A recorded client's options without `callTimeoutMs`, with the logger
 * reduced to its method names (each build makes a new filtered logger).
 */
function optionsBesideCallTimeout(opts: RecordedClientOptions[number]): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...opts }
  delete rest.callTimeoutMs
  rest.logger = opts.logger === undefined ? undefined : Object.keys(opts.logger).sort()
  return rest
}

/** A stub client whose `close()` counts its calls. */
function closeCountingStub(binaryVersion?: string): { client: StubClient; closes: () => number } {
  let count = 0
  const client = makeStubClient(binaryVersion === undefined ? {} : { binaryVersion })
  client.close = () => { count += 1 }
  return { client, closes: () => count }
}

// ---------------------------------------------------------------------------
// SR-5.1 — construct-step failure modes
// ---------------------------------------------------------------------------

describe('SR-5.1: Client constructor failure modes', () => {
  test('ErrBunVersionTooOld → ok=false, classLabel=ad-bun-version-too-old', async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errBunVersionTooOld('0.9.0', '1.0.21') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-bun-version-too-old')
      expect(outcome.message).toContain('Bun >= 1.0.21')
      // SR-4.5: ad-bun-version-too-old does NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  test('non-typed throw surfaces verbatim → classLabel=ad-client-construct', async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: new Error('some unexpected boom') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-client-construct')
      expect(outcome.message).toContain('some unexpected boom')
    }
  })
})

// ---------------------------------------------------------------------------
// SR-5.1 — same-user check
// ---------------------------------------------------------------------------

describe('SR-5.1: same-user check', () => {
  test('UID mismatch → ok=false, classLabel=ad-same-user', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: (_p) => ({ uid: 7777 }),
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('same-user')
      expect(outcome.classLabel).toBe('ad-same-user')
      expect(outcome.message).toContain('UID 7777')
      expect(outcome.message).toContain('UID 1000')
      expect(outcome.message).toContain(DEFAULT_STATE_DB_PATH)
      // SR-4.5: same-user mismatch does NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  test('ENOENT on state.db → silent pass (first-run case)', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: defaultStat, // throws ENOENT
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
  })

  test('non-ENOENT stat error → ok=false, classLabel=ad-same-user-stat', async () => {
    const stub = makeStubClient()
    const eacces = (): { uid: number } => {
      const err: NodeJS.ErrnoException = new Error('EACCES')
      err.code = 'EACCES'
      throw err
    }
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: eacces,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-same-user-stat')
      expect(outcome.message).toContain('EACCES')
      // SR-4.5: same-user-stat does NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  test('geteuid undefined → defensive warning + pass (no exit)', async () => {
    const stub = makeStubClient()
    const warnings: { classLabel: string; message: string }[] = []
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: (_p) => ({ uid: 7777 }),
      geteuid: () => undefined,
      recordStartupError: (classLabel: string, message: string) => {
        warnings.push({ classLabel, message })
      },
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    expect(warnings.find((w) => w.classLabel === 'ad-same-user-unenforced')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// SR-5.1 — happy path
// ---------------------------------------------------------------------------

describe('SR-5.1: happy path', () => {
  test('valid binary + ENOENT state.db → ok=true', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(PHASE1_RC_VERSION)
    }
  })

  test('UID match on state.db → ok=true', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: (_p) => ({ uid: 1000 }),
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SR-5.1 — API surface probes (b.avw)
// ---------------------------------------------------------------------------
//
// `Client.create()` confirms the AD binary meets its declared
// `min_binary_version`, but the shipped TS shim has historically lagged
// the binary — dropping methods
// (getPermission), dropping CLI flags (--request-token in buildDecide), and
// missing err_names from the catalog. Each silently breaks CSCB at click-
// handling time. The probes run 1 → 2 → 3 and short-circuit on first failure.
//
// All sub-cases below flow past the construct step, so each runStartupGate
// call must inject a successful createClient (via makeStubCreateClient)
// plus override the specific probe(s) under test. Same-user deps default to
// a passing config (geteuid=1000, statSync=ENOENT).

describe('SR-5.1: API surface probes', () => {
  /** Stage the deps shared by every probe sub-case. The caller overrides the
   *  probe under test plus any additional knobs. */
  function probeRunDeps(stub: ReturnType<typeof makeStubClient>) {
    return {
      createClient: makeStubCreateClient({ client: stub }),
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    }
  }

  // -------------------------------------------------------------------------
  // Probe 1 — getPermission missing on the Client
  // -------------------------------------------------------------------------

  test('probeGetPermission returns false → ad-shim-missing-get-permission', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => false,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('api-surface')
      expect(outcome.classLabel).toBe('ad-shim-missing-get-permission')
      expect(outcome.message).toContain('getPermission')
      // Generic remediation points operators at re-installing a matching shim.
      expect(outcome.message).toContain('reinstall a matching')
      // SR-4.5: ad-shim-* branches do NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  // -------------------------------------------------------------------------
  // Probe 2 — error catalog is missing required err_names (one missing name
  // through the pure check: the b.jg5 SRJ-102 describe below)
  // -------------------------------------------------------------------------

  test('probeErrorCatalog reports every required name missing → message lists each', async () => {
    const stub = makeStubClient()
    const allMissing = [...REQUIRED_ERR_NAMES]
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: false, missing: allMissing }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SHIM_CATALOG_INCOMPLETE)
      for (const name of allMissing) {
        expect(outcome.message).toContain(name)
      }
    }
  })

  // -------------------------------------------------------------------------
  // Probe 3 — buildDecide drops --request-token
  // -------------------------------------------------------------------------

  test('probeDecideArgv reports drop → ad-shim-decide-drops-token', async () => {
    const stub = makeStubClient()
    const detail = "dist (node_modules/agent-director/dist/index.js) does not include the literal '--request-token'"
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: false, detail }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('api-surface')
      expect(outcome.classLabel).toBe('ad-shim-decide-drops-token')
      expect(outcome.message).toContain('--request-token')
      expect(outcome.message).toContain(detail)
      // SR-4.5: ad-shim-* branches do NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  // -------------------------------------------------------------------------
  // Short-circuit ordering: probes run 1 → 2 → 3, stop at first failure
  // -------------------------------------------------------------------------

  test('probe-1 failure short-circuits before probes 2 and 3', async () => {
    const stub = makeStubClient()
    const calls: string[] = []
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => {
        calls.push('p1')
        return false
      },
      probeErrorCatalog: () => {
        calls.push('p2')
        return { ok: true }
      },
      probeDecideArgv: async () => {
        calls.push('p3')
        return { ok: true }
      },
    })
    expect(outcome.ok).toBe(false)
    expect(calls).toEqual(['p1'])
  })

  test('probe-2 failure short-circuits before probe 3', async () => {
    const stub = makeStubClient()
    const calls: string[] = []
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => {
        calls.push('p1')
        return true
      },
      probeErrorCatalog: () => {
        calls.push('p2')
        return { ok: false, missing: ['ErrInvalidFlags'] }
      },
      probeDecideArgv: async () => {
        calls.push('p3')
        return { ok: true }
      },
    })
    expect(outcome.ok).toBe(false)
    expect(calls).toEqual(['p1', 'p2'])
  })

  // -------------------------------------------------------------------------
  // Client cleanup: closeClient must be called exactly once on probe failure
  // -------------------------------------------------------------------------

  test('probe-1 failure closes client exactly once', async () => {
    const stub = makeStubClient()
    let closeCount = 0
    await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      closeClient: () => {
        closeCount += 1
      },
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
      probeGetPermission: () => false,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(closeCount).toBe(1)
  })

  test('probe-2 failure closes client exactly once', async () => {
    const stub = makeStubClient()
    let closeCount = 0
    await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      closeClient: () => {
        closeCount += 1
      },
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: false, missing: ['ErrInvalidFlags'] }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(closeCount).toBe(1)
  })

  test('probe-3 failure closes client exactly once', async () => {
    const stub = makeStubClient()
    let closeCount = 0
    await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      closeClient: () => {
        closeCount += 1
      },
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: false, detail: 'flag missing' }),
    })
    expect(closeCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Happy path: all three probes pass → flow continues to same-user step
  // -------------------------------------------------------------------------

  test('all three probes pass + ENOENT state.db → ok=true', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(PHASE1_RC_VERSION)
    }
  })

  // -------------------------------------------------------------------------
  // Production-default integration probe — regression lock for b.avw
  // -------------------------------------------------------------------------
  //
  // This test calls runStartupGate WITHOUT overriding probeDecideArgv, so the
  // production default reads node_modules/agent-director/dist/index.js and
  // greps for the literal '--request-token'. With the stale shipped shim
  // (0.6.0) buildDecide() drops the flag, so the grep misses and the gate
  // rejects. The skip-gate below mirrors the production probe exactly — read
  // the resolved dist file and look for the same literal. When the upstream
  // ships the fix, the literal appears, `shimDecideDropsToken()` returns
  // false, and the test self-disables. Using the same indicator as the
  // assertion (not a `Client.prototype` shape check) keeps the canary and the
  // assertion guaranteed to agree: any future release that fixes
  // `getPermission` but still drops `--request-token` will keep this test
  // active, preserving the regression-pin for the exact bug b.avw was filed
  // for.
  //
  // FAILS-BEFORE-FIX / PASSES-AFTER-FIX: this is the test that locks in the
  // regression. Removing it would silently re-allow CSCB to boot against a
  // stale shim.

  function shimDecideDropsToken(): boolean {
    try {
      const distPath = fileURLToPath(import.meta.resolve('agent-director'))
      const src = fs.readFileSync(distPath, 'utf-8')
      return !src.includes('--request-token')
    } catch {
      // If the dist file can't be resolved or read, we can't prove the shim
      // is stale — fail closed by skipping rather than asserting against a
      // missing file (would surface as a misleading test failure).
      return false
    }
  }

  test.skipIf(!shimDecideDropsToken())(
    'production-default probeDecideArgv rejects stale shipped shim (FAILS-BEFORE-FIX)',
    async () => {
      const stub = makeStubClient()
      const outcome = await runStartupGate({
        createClient: makeStubCreateClient({ client: stub }),
        statSync: defaultStat,
        geteuid: () => 1000,
        recordStartupError: noopRecord,
        exit: noopExit,
        // Bypass probes 1 + 2 so this test isolates the dist-file grep
        // against the real installed package. probeDecideArgv is the
        // PRODUCTION DEFAULT — no override.
        probeGetPermission: () => true,
        probeErrorCatalog: () => ({ ok: true }),
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.phase).toBe('api-surface')
        expect(outcome.classLabel).toBe('ad-shim-decide-drops-token')
        expect(outcome.message).toContain('--request-token')
      }
    },
  )
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-102 — the error-catalogue check over supplied dist text
// ---------------------------------------------------------------------------
//
// The dist text is built here in the shape the shipped client has: a
// metadata array naming every error, then one class declaration per error.
// No case reads the installed client's dist or calls the production probe.
// The three Phase-1-only names are written out once, as the SRD's
// requirement; every other value comes from `src/`.

/** The Phase-1-only names b.jg5 SRJ-102 requires, as the SRD writes them. */
const SRD_PHASE1_ONLY_NAMES = ['ErrTmuxKillFailed', 'ErrTmuxUnresponsive', 'ErrTmuxSessionConflict']

/** The Phase-1-only names as `src/` exports them. */
const PHASE1_ONLY_NAMES = [ERR_TMUX_KILL_FAILED_NAME, ERR_TMUX_UNRESPONSIVE_NAME, ERR_TMUX_SESSION_CONFLICT_NAME]

/**
 * Dist text declaring a class for every required name except `undeclared`.
 * With `metadata`, a metadata entry names every required name, declared or
 * not.
 */
function distText(undeclared: readonly string[] = [], { metadata = false } = {}): string {
  const entries = metadata ? REQUIRED_ERR_NAMES.map((name) => `  { name: "${name}", exitCode: 1 },`) : []
  const classes = REQUIRED_ERR_NAMES
    .filter((name) => !undeclared.includes(name))
    .map((name) => `class ${name} extends AgentDirectorError {\n}`)
  return ['const ERROR_CATALOG = [', ...entries, '];', ...classes].join('\n')
}

describe('b.jg5 SRJ-102: checkErrorCatalog over supplied dist text', () => {
  test('the required names include the SRD\'s three Phase-1-only names, as src/ exports them', () => {
    expect(PHASE1_ONLY_NAMES).toEqual(SRD_PHASE1_ONLY_NAMES)
    expect<readonly string[]>(PHASE1_ONLY_ERR_NAMES).toEqual(SRD_PHASE1_ONLY_NAMES)
    expect(REQUIRED_ERR_NAMES).toEqual(expect.arrayContaining(SRD_PHASE1_ONLY_NAMES))
  })

  test.each([false, true])('every required name declared (metadata entries: %p) → ok', (metadata) => {
    expect(checkErrorCatalog(distText([], { metadata }))).toEqual({ ok: true })
  })

  test.each([...REQUIRED_ERR_NAMES])('%s left out → not ok, missing exactly it', (name) => {
    expect(checkErrorCatalog(distText([name]))).toEqual({ ok: false, missing: [name] })
  })

  test.each(PHASE1_ONLY_NAMES)('%s named only in a metadata entry → counts as missing', (name) => {
    const text = distText([name], { metadata: true })
    expect(text).toContain(name)
    expect(checkErrorCatalog(text)).toEqual({ ok: false, missing: [name] })
  })

  test('all three Phase-1-only names left out → all three listed', () => {
    expect(checkErrorCatalog(distText(PHASE1_ONLY_NAMES, { metadata: true }))).toEqual({
      ok: false,
      missing: PHASE1_ONLY_NAMES,
    })
  })

  test('a probe built from the check over text lacking a Phase-1-only name fails the gate at api-surface', async () => {
    const outcome = await runStartupGate(passingDeps({
      probeErrorCatalog: () => checkErrorCatalog(distText([ERR_TMUX_SESSION_CONFLICT_NAME], { metadata: true })),
    }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('api-surface')
      expect(outcome.classLabel).toBe(AD_SHIM_CATALOG_INCOMPLETE)
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_OTHER)
      expect(outcome.message).toContain(ERR_TMUX_SESSION_CONFLICT_NAME)
      expect(outcome.message).toContain('reinstall a matching')
      // SR-4.5: ad-shim-* branches do NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain(renderInstallSkillInstructions())
    }
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-103 — the 0.10.0 error classes are the client's own
// ---------------------------------------------------------------------------
//
// The three Phase-1-only classes are recognised by name only and get their
// identity checks once the Phase 1 client is adopted (E37).

describe('b.jg5 SRJ-103: re-exported error classes', () => {
  test.each([
    [AdErrTmuxSendKeys.name, ErrTmuxSendKeys, AdErrTmuxSendKeys],
    [AdErrTmuxCaptureFailed.name, ErrTmuxCaptureFailed, AdErrTmuxCaptureFailed],
    [AdErrTmuxSessionCreate.name, ErrTmuxSessionCreate, AdErrTmuxSessionCreate],
    [AdErrUnknownErrorName.name, ErrUnknownErrorName, AdErrUnknownErrorName],
    [AdErrSendKeysWhileRelayed.name, ErrSendKeysWhileRelayed, AdErrSendKeysWhileRelayed],
  ])('%s from src/agent-director-errors.ts is the client\'s own class', (_name, reExported, own) => {
    expect(reExported).toBe(own)
  })
})

// ---------------------------------------------------------------------------
// SR-4.2 — system-install discovery typed-error branches
// ---------------------------------------------------------------------------
//
// `Client.create()` (production) / `makeStubCreateClient(...)` (tests) is the
// async factory that surfaces the client's three system-install typed
// errors: ErrSystemInstallNotFound (no binary on PATH or in standard install
// path), ErrSystemInstallTooOld (detected binary below the client's minimum), and
// ErrSystemInstallUnreachable (binary exists but cannot be invoked
// successfully — eight reason values). Each must surface as its own
// classLabel on the construct phase so the startup-errors.log entry tells the
// operator exactly which install action to take.

describe('SR-4.2: system-install typed-error branches', () => {
  test(`ErrSystemInstallNotFound → ${AD_SYSTEM_INSTALL_NOT_FOUND}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallNotFound() }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_NOT_FOUND)
      expect(outcome.message).toContain('agent-director')
      // SR-4.5: appends the manual-skill-install instructions block.
      expect(outcome.message).toContain('skills/install-cscb/SKILL.md')
    }
  })

  // ErrSystemInstallTooOld's label, phase and message are covered in the
  // b.jg5 SRJ-203 floor matrix and the SRJ-208 refusal-message cases below.

  // ErrSystemInstallUnreachable: one test per reason value. The 8 reasons are
  // the full closed-with-escape-hatch enum from AD's UnreachableReason type;
  // each is a distinct failure signature that translates directly into the
  // operator-facing remediation step.

  test(`ErrSystemInstallUnreachable reason='not-executable' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('not-executable') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('not-executable')
      // SR-4.5: appends the manual-skill-install instructions block.
      expect(outcome.message).toContain('skills/install-cscb/SKILL.md')
    }
  })

  test(`ErrSystemInstallUnreachable reason='not-a-regular-file' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('not-a-regular-file') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('not-a-regular-file')
    }
  })

  test(`ErrSystemInstallUnreachable reason='probe-timeout' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-timeout') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('probe-timeout')
    }
  })

  test(`ErrSystemInstallUnreachable reason='probe-nonzero-exit' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-nonzero-exit') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('probe-nonzero-exit')
    }
  })

  test(`ErrSystemInstallUnreachable reason='probe-killed-by-signal' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-killed-by-signal') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('probe-killed-by-signal')
    }
  })

  test(`ErrSystemInstallUnreachable reason='unparseable-version' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('unparseable-version') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('unparseable-version')
    }
  })

  test(`ErrSystemInstallUnreachable reason='spawn-failed' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('spawn-failed') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('spawn-failed')
    }
  })

  test(`ErrSystemInstallUnreachable reason='other' → ${AD_SYSTEM_INSTALL_UNREACHABLE}`, async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('other') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_UNREACHABLE)
      expect(outcome.message).toContain('other')
    }
  })
})

// ---------------------------------------------------------------------------
// SR-4.1 — async createClient injection seam
// ---------------------------------------------------------------------------
//
// The startup gate calls `await d.createClient(opts)` exactly once and (on
// success) installs the resolved Client into the agent-director-client
// singleton via `setClient(client)`. These tests pin three contracts: the
// factory is awaited exactly once, the resulting Client is installed into the
// module-level singleton (identity-equal to `getClient()`), and the success
// arm's `outcome.adVersion` is sourced directly from `client.binaryVersion`.
// The final test pins the catch-all path for an unknown (non-typed) error.

describe('SR-4.1: async createClient injection', () => {
  beforeEach(() => {
    // Each test installs (or fails to install) its own Client into the
    // module-level singleton; reset between tests so identity-equality
    // assertions cannot leak across test boundaries.
    resetClientForTests()
  })

  test('createClient is awaited exactly once on success', async () => {
    const stub = makeStubClient()
    const calls: object[] = []
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub, calls }),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  test('stub Client is installed into singleton post-createClient', async () => {
    // Tag the stub with a sentinel field so we can prove identity-equality
    // against whatever getClient() returns post-gate. The structural-typed
    // StubClient permits extra fields at the use site.
    const stub = makeStubClient()
    const taggedStub = stub as typeof stub & { __sentinel: 'unique' }
    taggedStub.__sentinel = 'unique'
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: taggedStub }),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    // getClient() returns the installed singleton (typed Client); the cast is
    // safe because the gate hands the same object reference to setClient(...).
    expect(getClient() as unknown).toBe(taggedStub)
  })

  test('success-arm adVersion sourced from client.binaryVersion', async () => {
    // A later release than the floor's candidate, so the pass-through value
    // differs from the stub's default.
    const stub = makeStubClient({ binaryVersion: LATER_RELEASE })
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ client: stub }),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(LATER_RELEASE)
    }
  })

  test('unknown (non-typed) error type → classLabel=ad-client-construct', async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: new Error('boom') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-client-construct')
      expect(outcome.message).toContain('boom')
    }
  })

  // b.jg5 SRJ-213 / SRJ-121: the CLI's client carries the call timeout through
  // the gate's option; the server's gate passes none (the client's default).
  test.each(CALL_TIMEOUTS_MS)('callTimeoutMs %d reaches the one create call; without it the options have no callTimeoutMs key and are otherwise the same', async (ms) => {
    const withCalls: RecordedClientOptions = []
    const withoutCalls: RecordedClientOptions = []
    const withOutcome = await runStartupGate(
      passingDeps({ createClient: makeStubCreateClient({ calls: withCalls }) }),
      { callTimeoutMs: ms },
    )
    const withoutOutcome = await runStartupGate(passingDeps({ createClient: makeStubCreateClient({ calls: withoutCalls }) }))
    expect(withOutcome.ok).toBe(true)
    expect(withoutOutcome.ok).toBe(true)
    expect(withCalls.length).toBe(1)
    expect(withoutCalls.length).toBe(1)
    expect(withCalls[0]!.callTimeoutMs).toBe(ms)
    expect(Object.hasOwn(withoutCalls[0]!, 'callTimeoutMs')).toBe(false)
    expect(optionsBesideCallTimeout(withCalls[0]!)).toEqual(optionsBesideCallTimeout(withoutCalls[0]!))
    expect(withoutCalls[0]!.storePath).toBe(DEFAULT_STORE_PATH)
    expect(withoutCalls[0]!.logger).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Epic AC #7 — non-TTY behavior is identical to TTY behavior
// ---------------------------------------------------------------------------
//
// The gate does NOT branch on `process.stdin.isTTY` (there is no readline
// anywhere in the startup path). This test pins that invariant: forcing
// isTTY=false and running a known-failing scenario yields the exact same
// outcome.message and outcome.classLabel as the interactive (default) case.
// Any future change that adds a TTY-conditional branch (e.g. interactive
// prompts) would fail this test and force an explicit design decision.

describe('SR-4.4 / Epic AC #7: non-TTY behavior identical to TTY', () => {
  test('failure outcome identical with process.stdin.isTTY=false', async () => {
    // Interactive (TTY=true) reference run.
    const interactiveOutcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallNotFound() }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })

    // Force non-TTY for the second run.
    const originalIsTTY = process.stdin.isTTY
    try {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
        writable: true,
      })
      const nonTtyOutcome = await runStartupGate({
        createClient: makeStubCreateClient({ error: errSystemInstallNotFound() }),
        statSync: defaultStat,
        recordStartupError: noopRecord,
        exit: noopExit,
      })

      expect(nonTtyOutcome.ok).toBe(false)
      expect(interactiveOutcome.ok).toBe(false)
      if (!nonTtyOutcome.ok && !interactiveOutcome.ok) {
        expect(nonTtyOutcome.classLabel).toBe(interactiveOutcome.classLabel)
        expect(nonTtyOutcome.message).toBe(interactiveOutcome.message)
      }
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
        writable: true,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-203 / SRJ-1513 — CSCB's Phase 1 floor in runStartupGate
// ---------------------------------------------------------------------------
//
// The floor runs after construction, on the client's `binaryVersion`, and
// before the client is installed as the singleton. The client's own too-old
// refusal and its unparseable-version refusal stay construction failures with
// their own labels and kinds.

describe('b.jg5 SRJ-203 / SRJ-1513: Phase 1 floor in runStartupGate', () => {
  beforeEach(() => {
    resetClientForTests()
  })

  test.each([
    {
      name: 'OLD_AD_VERSION passes construction, fails the floor',
      createClient: clientAt(OLD_AD_VERSION),
      phase: 'version',
      classLabel: AD_BELOW_PHASE1_FLOOR,
      refusalKind: REFUSAL_KIND_BELOW_PHASE1_FLOOR,
      named: [OLD_AD_VERSION, PHASE1_FLOOR_VERSION],
    },
    {
      name: 'DEV_PLACEHOLDER_VERSION is refused by CSCB\'s own comparison',
      createClient: clientAt(DEV_PLACEHOLDER_VERSION),
      phase: 'version',
      classLabel: AD_BELOW_PHASE1_FLOOR,
      refusalKind: REFUSAL_KIND_BELOW_PHASE1_FLOOR,
      named: [DEV_PLACEHOLDER_VERSION, PHASE1_FLOOR_VERSION],
    },
    {
      name: 'the client\'s own too-old refusal',
      createClient: makeStubCreateClient({ error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION) }),
      phase: 'construct',
      classLabel: AD_SYSTEM_INSTALL_TOO_OLD,
      refusalKind: REFUSAL_KIND_CLIENT_TOO_OLD,
      named: [STALE_VERSION, CLIENT_MIN_VERSION],
    },
    {
      name: 'the client\'s unparseable-version refusal (DEV_UNPARSEABLE_VERSION)',
      createClient: makeStubCreateClient({
        error: errSystemInstallUnreachable('unparseable-version', DEV_UNPARSEABLE_VERSION),
      }),
      phase: 'construct',
      classLabel: AD_SYSTEM_INSTALL_UNREACHABLE,
      refusalKind: REFUSAL_KIND_OTHER,
      named: ['unparseable-version'],
    },
  ])('$name → label and refusal kind', async ({ createClient, phase, classLabel, refusalKind, named }) => {
    const outcome = await runStartupGate(passingDeps({ createClient }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe(phase)
      expect(outcome.classLabel).toBe(classLabel)
      expect(outcome.refusalKind).toBe(refusalKind)
      for (const text of named) {
        expect(outcome.message).toContain(text)
      }
    }
  })

  test('PHASE1_RC_VERSION passes and adVersion equals it', async () => {
    const outcome = await runStartupGate(passingDeps({ createClient: clientAt(PHASE1_RC_VERSION) }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(PHASE1_RC_VERSION)
    }
  })

  test('floor refusal: no probe, no stat, closeClient once, no singleton installed', async () => {
    const stub = makeStubClient({ binaryVersion: OLD_AD_VERSION })
    const calls: string[] = []
    const closed: unknown[] = []
    const outcome = await runStartupGate(passingDeps({
      createClient: makeStubCreateClient({ client: stub }),
      closeClient: (client) => { closed.push(client) },
      probeGetPermission: () => { calls.push('p1'); return true },
      probeErrorCatalog: () => { calls.push('p2'); return { ok: true } },
      probeDecideArgv: async () => { calls.push('p3'); return { ok: true } },
      statSync: () => { calls.push('stat'); return defaultStat() },
    }))
    expect(outcome.ok).toBe(false)
    expect(calls).toEqual([])
    expect(closed).toEqual([stub])
    expect(() => getClient()).toThrow()
  })

  test('the floor reads binaryVersion, never version()', async () => {
    const versionCalls: NonNullable<StubClientOptions['versionCalls']> = []
    const stub = makeStubClient({
      binaryVersion: OLD_AD_VERSION,
      versionResult: cannedVersion(PHASE1_RC_VERSION),
      versionCalls,
    })
    const outcome = await runStartupGate(passingDeps({ createClient: makeStubCreateClient({ client: stub }) }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_BELOW_PHASE1_FLOOR)
    }
    expect(versionCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-208 — the two version refusal messages
// ---------------------------------------------------------------------------
//
// Both name the switch-over runbook section by its title and carry none of
// the shared upgrade forms (tests/test-helpers/upgrade-forms.ts): no
// instruction to upgrade agent-director and no upgrade or install command.
// Both name the Phase 1 floor; the too-old message also names the client's
// required version. The too-old message keeps the install-skill block; the
// floor message has none. Each binary path is a non-default value, so the message shows it is
// passed through. The startup gate's message is the startup form: it never
// carries the runtime re-check phrase (b.jg5 SRJ-1013). `outcome.message` is
// the text runAgentDirectorStartupGate records unchanged.

describe('b.jg5 SRJ-208: version refusal messages', () => {
  beforeEach(() => {
    resetClientForTests()
  })

  const binaryPath = join(tmpdir(), 'cscb-dependency-check', 'agent-director')
  const floorStub = makeStubClient({ binaryVersion: OLD_AD_VERSION, binaryPath })
  const tooOld = errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION, binaryPath)

  test.each([
    {
      name: AD_BELOW_PHASE1_FLOOR,
      createClient: makeStubCreateClient({ client: floorStub }),
      named: [floorStub.binaryVersion, PHASE1_FLOOR_VERSION, floorStub.binaryPath],
      carriesSkillBlock: false,
    },
    {
      name: AD_SYSTEM_INSTALL_TOO_OLD,
      createClient: makeStubCreateClient({ error: tooOld }),
      named: [tooOld.actualVersion, tooOld.requiredVersion, PHASE1_FLOOR_VERSION, tooOld.binaryPath],
      carriesSkillBlock: true,
    },
  ])('$name names the runbook section, the versions (incl. the Phase 1 floor) and the path, and no upgrade form or runtime re-check phrase', async ({ name, createClient, named, carriesSkillBlock }) => {
    const outcome = await runStartupGate(passingDeps({ createClient }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(name)
      expect(outcome.message).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
      for (const [, pattern] of UPGRADE_FORMS) expect(flat(outcome.message)).not.toMatch(pattern)
      for (const text of named) {
        expect(outcome.message).toContain(text)
      }
      if (carriesSkillBlock) {
        expect(outcome.message).toContain(renderInstallSkillInstructions())
      } else {
        expect(outcome.message).not.toContain(renderInstallSkillInstructions())
      }
      expect(outcome.message).not.toContain(RUNTIME_RECHECK_PHRASE)
    }
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-203 / SRJ-1513 — every other failure carries refusal kind `other`
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-203 / SRJ-1513: refusal kind of every other failure branch', () => {
  beforeEach(() => {
    resetClientForTests()
  })

  const eacces = (): { uid: number } => {
    const err: NodeJS.ErrnoException = new Error('EACCES')
    err.code = 'EACCES'
    throw err
  }

  test.each<[string, Partial<StartupGateDeps>]>([
    ['ad-bun-version-too-old', { createClient: makeStubCreateClient({ error: errBunVersionTooOld() }) }],
    [AD_SYSTEM_INSTALL_NOT_FOUND, { createClient: makeStubCreateClient({ error: errSystemInstallNotFound() }) }],
    [AD_SYSTEM_INSTALL_UNREACHABLE, { createClient: makeStubCreateClient({ error: errSystemInstallUnreachable() }) }],
    ['ad-client-construct', { createClient: makeStubCreateClient({ error: new Error('boom') }) }],
    ['ad-shim-missing-get-permission', { probeGetPermission: () => false }],
    [AD_SHIM_CATALOG_INCOMPLETE, { probeErrorCatalog: () => ({ ok: false, missing: ['ErrInvalidFlags'] }) }],
    ['ad-shim-decide-drops-token', { probeDecideArgv: async () => ({ ok: false, detail: 'flag missing' }) }],
    ['ad-same-user', { statSync: () => ({ uid: 7777 }) }],
    ['ad-same-user-stat', { statSync: eacces }],
  ])('%s → refusal kind other', async (classLabel, overrides) => {
    const outcome = await runStartupGate(passingDeps(overrides))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(classLabel)
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_OTHER)
    }
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-203 / SRJ-1513 — the floor-exempt option
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-203 / SRJ-1513: skipPhase1Floor option', () => {
  beforeEach(() => {
    resetClientForTests()
  })

  test.each([OLD_AD_VERSION, DEV_PLACEHOLDER_VERSION])('with the option set, %s passes', async (version) => {
    const outcome = await runStartupGate(passingDeps({ createClient: clientAt(version) }), { skipPhase1Floor: true })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(version)
    }
  })

  test('with the option set, the client\'s too-old refusal still fails with client-too-old', async () => {
    const outcome = await runStartupGate(
      passingDeps({ createClient: makeStubCreateClient({ error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION) }) }),
      { skipPhase1Floor: true },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe(AD_SYSTEM_INSTALL_TOO_OLD)
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_CLIENT_TOO_OLD)
    }
  })

  test('with the option set, a probe failure still fails', async () => {
    const outcome = await runStartupGate(
      passingDeps({ createClient: clientAt(OLD_AD_VERSION), probeGetPermission: () => false }),
      { skipPhase1Floor: true },
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-shim-missing-get-permission')
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_OTHER)
    }
  })

  test.each([
    ['no options', undefined],
    ['empty options', {}],
    ['skipPhase1Floor false', { skipPhase1Floor: false }],
  ])('without the option (%s) the floor applies', async (_label, options) => {
    const outcome = await runStartupGate(passingDeps({ createClient: clientAt(OLD_AD_VERSION) }), options)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_BELOW_PHASE1_FLOOR)
    }
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-203 / SRJ-1513 — runAgentDirectorStartupGate records and exits
// ---------------------------------------------------------------------------
//
// The wrapper always runs the floor. The exit hook throws to stop control,
// as production's `process.exit` does.

describe('b.jg5 SRJ-203 / SRJ-1513: runAgentDirectorStartupGate', () => {
  class ExitCalled extends Error {
    constructor(readonly code: number) {
      super(`exit(${code})`)
    }
  }

  let records: { classLabel: string; message: string }[]
  let exits: number[]
  let tempDirs: string[]

  beforeEach(() => {
    resetClientForTests()
    records = []
    exits = []
    tempDirs = []
  })

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  const capture: Pick<StartupGateDeps, 'recordStartupError' | 'exit'> = {
    recordStartupError: (classLabel: string, message: string) => { records.push({ classLabel, message }) },
    exit: (code: number) => {
      exits.push(code)
      throw new ExitCalled(code)
    },
  }

  test('OLD_AD_VERSION → one record naming the floor label and both versions, one non-zero exit', async () => {
    await expect(
      runAgentDirectorStartupGate(passingDeps({ createClient: clientAt(OLD_AD_VERSION), ...capture })),
    ).rejects.toBeInstanceOf(ExitCalled)
    expect(records.length).toBe(1)
    expect(records[0]!.classLabel).toBe(AD_BELOW_PHASE1_FLOOR)
    expect(records[0]!.message).toContain(OLD_AD_VERSION)
    expect(records[0]!.message).toContain(PHASE1_FLOOR_VERSION)
    expect(exits.length).toBe(1)
    expect(exits[0]).not.toBe(0)
  })

  test('client too old → one record with the too-old label', async () => {
    await expect(
      runAgentDirectorStartupGate(passingDeps({
        createClient: makeStubCreateClient({ error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION) }),
        ...capture,
      })),
    ).rejects.toBeInstanceOf(ExitCalled)
    expect(records.map((r) => r.classLabel)).toEqual([AD_SYSTEM_INSTALL_TOO_OLD])
    expect(exits.length).toBe(1)
  })

  test.each([...REQUIRED_ERR_NAMES])('dist text lacking %s → one catalogue record naming it, one non-zero exit', async (name) => {
    await expect(
      runAgentDirectorStartupGate(passingDeps({
        probeErrorCatalog: () => checkErrorCatalog(distText([name], { metadata: true })),
        ...capture,
      })),
    ).rejects.toBeInstanceOf(ExitCalled)
    expect(records.map((r) => r.classLabel)).toEqual([AD_SHIM_CATALOG_INCOMPLETE])
    expect(records[0]!.message).toContain(name)
    expect(exits.length).toBe(1)
    expect(exits[0]).not.toBe(0)
  })

  test('PHASE1_RC_VERSION → no record, no exit', async () => {
    const result = await runAgentDirectorStartupGate(passingDeps({ createClient: clientAt(PHASE1_RC_VERSION), ...capture }))
    expect(result.adVersion).toBe(PHASE1_RC_VERSION)
    expect(records).toEqual([])
    expect(exits).toEqual([])
  })

  test('real recordStartupError writes one startup-errors.log entry with the floor label and both versions', async () => {
    const logDir = fs.mkdtempSync(join(tmpdir(), 'cscb-dependency-check-'))
    tempDirs.push(logDir)
    await expect(
      runAgentDirectorStartupGate(passingDeps({
        createClient: clientAt(OLD_AD_VERSION),
        recordStartupError: (classLabel, message) => recordStartupError(classLabel, message, undefined, { logDir }),
        exit: capture.exit,
      })),
    ).rejects.toBeInstanceOf(ExitCalled)
    const lines = fs.readFileSync(join(logDir, 'startup-errors.log'), 'utf-8').split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain(`[${AD_BELOW_PHASE1_FLOOR}]`)
    expect(lines[0]).toContain(OLD_AD_VERSION)
    expect(lines[0]).toContain(PHASE1_FLOOR_VERSION)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-213 / SRJ-121 — the server's persona client
// ---------------------------------------------------------------------------
//
// The server's gate builds its client before the configuration is read, so
// it has the client's default call timeout. Once the start has resolved its
// configuration, `buildPersonaClient` builds a second client with the
// configured value through the gate's own construction and Phase 1 floor
// (no API-surface probe, no same-user stat), installs it as the singleton and
// closes the gate's client once. Each case first runs the real gate over a
// close-counting stub, then the builder over a different stub, so a closed
// client is never reinstalled.

describe('b.jg5 SRJ-213 / SRJ-121: buildPersonaClient and buildPersonaClientOrExit', () => {
  class ExitCalled extends Error {
    constructor(readonly code: number) {
      super(`exit(${code})`)
    }
  }

  let gate: ReturnType<typeof closeCountingStub>
  let gateCalls: RecordedClientOptions
  let steps: string[]
  let closedBySeam: unknown[]
  let records: { classLabel: string; message: string }[]
  let exits: number[]

  beforeEach(async () => {
    resetClientForTests()
    gate = closeCountingStub()
    gateCalls = []
    steps = []
    closedBySeam = []
    records = []
    exits = []
    const outcome = await runStartupGate(passingDeps({ createClient: makeStubCreateClient({ client: gate.client, calls: gateCalls }) }))
    expect(outcome.ok).toBe(true)
    expect(getClient() as unknown).toBe(gate.client)
  })

  afterEach(() => {
    resetClientForTests()
  })

  /**
   * The builder's deps: `createClient` plus recording seams. The probes and
   * the stat are not the builder's seams; they are passed anyway (as a
   * non-literal, so the type allows it) so a builder that reached them
   * would record the step.
   */
  function personaDeps(createClient: StartupGateDeps['createClient']): Partial<StartupGateDeps> {
    const deps: Partial<StartupGateDeps> = {
      createClient,
      closeClient: (client) => { closedBySeam.push(client) },
      probeGetPermission: () => { steps.push('probe-get-permission'); return true },
      probeErrorCatalog: () => { steps.push('probe-error-catalog'); return { ok: true } },
      probeDecideArgv: async () => { steps.push('probe-decide-argv'); return { ok: true } },
      statSync: (path) => { steps.push(`stat ${path}`); return defaultStat() },
      geteuid: () => { steps.push('geteuid'); return 1000 },
      recordStartupError: (classLabel: string, message: string) => { records.push({ classLabel, message }) },
      exit: (code: number) => {
        exits.push(code)
        throw new ExitCalled(code)
      },
    }
    return deps
  }

  test.each(CALL_TIMEOUTS_MS)('callTimeoutMs %d: built with it, installed, the gate\'s client closed once, no probe and no stat', async (ms) => {
    const persona = closeCountingStub(LATER_RELEASE)
    const calls: RecordedClientOptions = []
    const outcome = await buildPersonaClient(ms, personaDeps(makeStubCreateClient({ client: persona.client, calls })))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.client).toBe(persona.client)
      expect(outcome.adVersion).toBe(LATER_RELEASE)
    }
    expect(calls.length).toBe(1)
    expect(calls[0]!.callTimeoutMs).toBe(ms)
    expect(optionsBesideCallTimeout(calls[0]!)).toEqual(optionsBesideCallTimeout(gateCalls[0]!))
    expect(getClient() as unknown).toBe(persona.client)
    expect(gate.closes()).toBe(1)
    expect(persona.closes()).toBe(0)
    expect(closedBySeam).toEqual([])
    expect(steps).toEqual([])
  })

  test.each([
    { name: 'OLD_AD_VERSION', version: OLD_AD_VERSION },
    { name: 'DEV_PLACEHOLDER_VERSION', version: DEV_PLACEHOLDER_VERSION },
  ])('$name: the gate\'s floor refusal; the built client closed once, nothing installed, the gate\'s client kept open', async ({ version }) => {
    const persona = closeCountingStub(version)
    const outcome = await buildPersonaClient(
      DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
      personaDeps(makeStubCreateClient({ client: persona.client })),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe(AD_BELOW_PHASE1_FLOOR)
      expect(outcome.refusalKind).toBe(REFUSAL_KIND_BELOW_PHASE1_FLOOR)
    }
    expect(closedBySeam).toEqual([persona.client])
    expect(getClient() as unknown).toBe(gate.client)
    expect(gate.closes()).toBe(0)
    expect(outcome).toEqual(await runStartupGate(passingDeps({ createClient: makeStubCreateClient({ client: persona.client }) })))
    expect(steps).toEqual([])
  })

  test.each([
    { classLabel: 'ad-bun-version-too-old', refusalKind: REFUSAL_KIND_OTHER, error: errBunVersionTooOld() },
    { classLabel: AD_SYSTEM_INSTALL_NOT_FOUND, refusalKind: REFUSAL_KIND_OTHER, error: errSystemInstallNotFound() },
    { classLabel: AD_SYSTEM_INSTALL_TOO_OLD, refusalKind: REFUSAL_KIND_CLIENT_TOO_OLD, error: errSystemInstallTooOld(STALE_VERSION, CLIENT_MIN_VERSION) },
    { classLabel: AD_SYSTEM_INSTALL_UNREACHABLE, refusalKind: REFUSAL_KIND_OTHER, error: errSystemInstallUnreachable() },
    { classLabel: 'ad-client-construct', refusalKind: REFUSAL_KIND_OTHER, error: new Error('boom') },
  ])('construct error $classLabel: the gate\'s outcome; nothing built, nothing installed, the gate\'s client kept open', async ({ classLabel, refusalKind, error }) => {
    const outcome = await buildPersonaClient(
      DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
      personaDeps(makeStubCreateClient({ error })),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe(classLabel)
      expect(outcome.refusalKind).toBe(refusalKind)
    }
    expect(outcome).toEqual(await runStartupGate(passingDeps({ createClient: makeStubCreateClient({ error }) })))
    expect(getClient() as unknown).toBe(gate.client)
    expect(gate.closes()).toBe(0)
    expect(closedBySeam).toEqual([])
    expect(steps).toEqual([])
  })

  test('OrExit, below the floor: one record with the floor label and version, one non-zero exit, the gate\'s client kept', async () => {
    const persona = closeCountingStub(OLD_AD_VERSION)
    await expect(
      buildPersonaClientOrExit(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, personaDeps(makeStubCreateClient({ client: persona.client }))),
    ).rejects.toBeInstanceOf(ExitCalled)
    expect(records.map((r) => r.classLabel)).toEqual([AD_BELOW_PHASE1_FLOOR])
    expect(records[0]!.message).toContain(OLD_AD_VERSION)
    expect(records[0]!.message).toContain(PHASE1_FLOOR_VERSION)
    expect(exits.length).toBe(1)
    expect(exits[0]).not.toBe(0)
    expect(getClient() as unknown).toBe(gate.client)
    expect(gate.closes()).toBe(0)
  })

  test('OrExit, construct error: one record with the gate\'s label, one non-zero exit', async () => {
    await expect(
      buildPersonaClientOrExit(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS, personaDeps(makeStubCreateClient({ error: errSystemInstallNotFound() }))),
    ).rejects.toBeInstanceOf(ExitCalled)
    expect(records.map((r) => r.classLabel)).toEqual([AD_SYSTEM_INSTALL_NOT_FOUND])
    expect(exits.length).toBe(1)
    expect(exits[0]).not.toBe(0)
  })

  test('OrExit, a pass: no record, no exit; the persona client installed with the call timeout and returned', async () => {
    const persona = closeCountingStub()
    const calls: RecordedClientOptions = []
    const result = await buildPersonaClientOrExit(
      MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
      personaDeps(makeStubCreateClient({ client: persona.client, calls })),
    )
    expect(result.client).toBe(persona.client)
    expect(result.adVersion).toBe(PHASE1_RC_VERSION)
    expect(calls.map((c) => c.callTimeoutMs)).toEqual([MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS])
    expect(getClient() as unknown).toBe(persona.client)
    expect(gate.closes()).toBe(1)
    expect(records).toEqual([])
    expect(exits).toEqual([])
  })
})
