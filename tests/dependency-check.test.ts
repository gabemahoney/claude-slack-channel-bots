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
 *   6. Same-user mismatch on ~/.agent-director/state.db.
 *   7. Happy path: gate passes silently and installs the Client into the
 *      module-level singleton via setClient(...).
 *   8. `runAgentDirectorStartupGate`: one record call and one exit per
 *      refusal, none on a pass.
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
  runStartupGate,
  runAgentDirectorStartupGate,
  DEFAULT_STATE_DB_PATH,
  REFUSAL_KIND_BELOW_PHASE1_FLOOR,
  REFUSAL_KIND_CLIENT_TOO_OLD,
  REFUSAL_KIND_OTHER,
} from '../src/agent-director-startup.ts'
import type { StartupGateDeps } from '../src/agent-director-startup.ts'
import { getClient, resetClientForTests } from '../src/agent-director-client.ts'
import {
  AD_BELOW_PHASE1_FLOOR,
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
} from '../src/install-check.ts'
import { PHASE1_FLOOR_VERSION, PHASE1_RUNBOOK_SECTION_TITLE } from '../src/ad-version-gate.ts'
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
import type { StubClientOptions } from './test-helpers/agent-director-stub.ts'
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
  // Probe 2 — error catalog is missing required err_names
  // -------------------------------------------------------------------------

  test('probeErrorCatalog reports a single missing name → ad-shim-catalog-incomplete', async () => {
    const stub = makeStubClient()
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: false, missing: ['ErrInvalidFlags'] }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('api-surface')
      expect(outcome.classLabel).toBe('ad-shim-catalog-incomplete')
      expect(outcome.message).toContain('ErrInvalidFlags')
      expect(outcome.message).toContain('reinstall a matching')
      // SR-4.5: ad-shim-* branches do NOT append the manual-skill-install block.
      expect(outcome.message).not.toContain('skills/install-cscb/SKILL.md')
    }
  })

  test('probeErrorCatalog reports all three missing → message lists each', async () => {
    const stub = makeStubClient()
    const allMissing = ['ErrInvalidFlags', 'ErrPermissionRequestNotFound', 'ErrAmbiguousRequest']
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: false, missing: allMissing }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-shim-catalog-incomplete')
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
  test('ErrSystemInstallNotFound → ad-system-install-not-found', async () => {
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

  test("ErrSystemInstallUnreachable reason='not-executable' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('not-executable') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('not-executable')
      // SR-4.5: appends the manual-skill-install instructions block.
      expect(outcome.message).toContain('skills/install-cscb/SKILL.md')
    }
  })

  test("ErrSystemInstallUnreachable reason='not-a-regular-file' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('not-a-regular-file') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('not-a-regular-file')
    }
  })

  test("ErrSystemInstallUnreachable reason='probe-timeout' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-timeout') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('probe-timeout')
    }
  })

  test("ErrSystemInstallUnreachable reason='probe-nonzero-exit' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-nonzero-exit') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('probe-nonzero-exit')
    }
  })

  test("ErrSystemInstallUnreachable reason='probe-killed-by-signal' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('probe-killed-by-signal') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('probe-killed-by-signal')
    }
  })

  test("ErrSystemInstallUnreachable reason='unparseable-version' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('unparseable-version') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('unparseable-version')
    }
  })

  test("ErrSystemInstallUnreachable reason='spawn-failed' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('spawn-failed') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
      expect(outcome.message).toContain('spawn-failed')
    }
  })

  test("ErrSystemInstallUnreachable reason='other' → ad-system-install-unreachable", async () => {
    const outcome = await runStartupGate({
      createClient: makeStubCreateClient({ error: errSystemInstallUnreachable('other') }),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.classLabel).toBe('ad-system-install-unreachable')
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
      classLabel: 'ad-system-install-unreachable',
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
// passed through.

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
  ])('$name names the runbook section, the versions (incl. the Phase 1 floor) and the path, and no upgrade form', async ({ name, createClient, named, carriesSkillBlock }) => {
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
    ['ad-system-install-unreachable', { createClient: makeStubCreateClient({ error: errSystemInstallUnreachable() }) }],
    ['ad-client-construct', { createClient: makeStubCreateClient({ error: new Error('boom') }) }],
    ['ad-shim-missing-get-permission', { probeGetPermission: () => false }],
    ['ad-shim-catalog-incomplete', { probeErrorCatalog: () => ({ ok: false, missing: ['ErrInvalidFlags'] }) }],
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
