/**
 * dependency-check.test.ts — SR-5.1 startup-gate sub-case matrix.
 *
 * Exercises src/agent-director-startup.ts via the dep-injection seam — never
 * touches the real Bun FFI or the real ~/.agent-director/state.db. Covers:
 *
 *   1. ErrPlatformPackageMissing at Client construction.
 *   2. ErrUnsupportedPlatform at Client construction.
 *   3. ErrBunVersionTooOld at Client construction.
 *   4. Stale version (sub-MIN_AD_VERSION) from version() probe, including
 *      the leading-'v' stripping path.
 *   5. Same-user mismatch on ~/.agent-director/state.db.
 *   6. Happy path: gate passes silently.
 *
 * Also covers the pure semverGte() helper in isolation.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  runStartupGate,
  semverGte,
  MIN_AD_VERSION,
  DEFAULT_STATE_DB_PATH,
} from '../src/agent-director-startup.ts'
import {
  cannedVersion,
  errBunVersionTooOld,
  errCallTimeout,
  errCliNotExecutable,
  errPlatformPackageMissing,
  errUnsupportedPlatform,
  errGeneric,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// semverGte
// ---------------------------------------------------------------------------

describe('semverGte', () => {
  test('returns true when equal', () => {
    expect(semverGte('1.2.3', '1.2.3')).toBe(true)
  })

  test('returns true when greater (major)', () => {
    expect(semverGte('2.0.0', '1.99.99')).toBe(true)
  })

  test('returns true when greater (minor)', () => {
    expect(semverGte('1.5.0', '1.4.99')).toBe(true)
  })

  test('returns true when greater (patch)', () => {
    expect(semverGte('1.2.4', '1.2.3')).toBe(true)
  })

  test('returns false when less (patch)', () => {
    expect(semverGte('1.2.2', '1.2.3')).toBe(false)
  })

  test('returns false when less (minor)', () => {
    expect(semverGte('1.1.99', '1.2.0')).toBe(false)
  })

  test('treats missing trailing segments as zero', () => {
    expect(semverGte('1', '1.0.0')).toBe(true)
    expect(semverGte('1.0', '1.0.1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Helpers for SR-5.1 sub-cases
// ---------------------------------------------------------------------------

/**
 * Build the four dep-injection points that every sub-case needs to override:
 *   - `getClient` (often a thrower)
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

// ---------------------------------------------------------------------------
// SR-5.1 — construct-step failure modes
// ---------------------------------------------------------------------------

describe('SR-5.1: Client constructor failure modes', () => {
  test('ErrPlatformPackageMissing → ok=false, classLabel=ad-platform-package-missing', async () => {
    const outcome = await runStartupGate({
      getClient: () => { throw errPlatformPackageMissing() },
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-platform-package-missing')
      expect(outcome.message).toContain('platform-native peer dependency missing')
      expect(outcome.message).toContain('linux-x64')
      expect(outcome.message).toContain('darwin-arm64')
    }
  })

  test('ErrUnsupportedPlatform → ok=false, classLabel=ad-unsupported-platform', async () => {
    const outcome = await runStartupGate({
      getClient: () => { throw errUnsupportedPlatform('win32-x64') },
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-unsupported-platform')
      expect(outcome.message).toContain('does not support this platform')
    }
  })

  test('ErrBunVersionTooOld → ok=false, classLabel=ad-bun-version-too-old', async () => {
    const outcome = await runStartupGate({
      getClient: () => { throw errBunVersionTooOld('0.9.0', '1.0.21') },
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-bun-version-too-old')
      expect(outcome.message).toContain('Bun >= 1.0.21')
    }
  })

  test('ErrCliNotExecutable → ok=false, classLabel=ad-cli-not-executable', async () => {
    const outcome = await runStartupGate({
      getClient: () => { throw errCliNotExecutable('/path/to/agent-director-bin') },
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('construct')
      expect(outcome.classLabel).toBe('ad-cli-not-executable')
      expect(outcome.message).toContain('/path/to/agent-director-bin')
      expect(outcome.message).toContain('chmod +x')
    }
  })

  test('non-typed throw surfaces verbatim → classLabel=ad-client-construct', async () => {
    const outcome = await runStartupGate({
      getClient: () => { throw new Error('some unexpected boom') },
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
// SR-5.1 — version-step failure modes
// ---------------------------------------------------------------------------

describe('SR-5.1: version-probe failure modes', () => {
  test("stale version returned as 'v0.4.2' is rejected (leading-v strip + semver-gte)", async () => {
    const stub = makeStubClient({ versionResult: cannedVersion('v0.4.2') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe('ad-version-stale')
      expect(outcome.message).toContain('0.4.2')
      expect(outcome.message).toContain(MIN_AD_VERSION)
    }
  })

  test("AD 0.5.1 is rejected", async () => {
    const stub = makeStubClient({ versionResult: cannedVersion('0.5.1') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe('ad-version-stale')
      expect(outcome.message).toContain('0.5.1')
      expect(outcome.message).toContain('0.6.3')
    }
  })

  test("AD 0.6.3 is accepted", async () => {
    const stub = makeStubClient({ versionResult: cannedVersion('0.6.3') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe('0.6.3')
    }
  })

  test("version returned as '0.5.99' is rejected (just-below-pin sanity)", async () => {
    const stub = makeStubClient({ versionResult: cannedVersion('0.5.99') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe('ad-version-stale')
      expect(outcome.message).toContain('0.5.99')
      expect(outcome.message).toContain(MIN_AD_VERSION)
    }
  })

  test(`version returned as '${MIN_AD_VERSION}' passes the version gate (paired release minimum)`, async () => {
    // Note: the same-user check downstream may still fail in the test env; we only assert the
    // version step passes by checking the outcome is either ok=true OR ok=false with a phase
    // OTHER than 'version'.
    const stub = makeStubClient({ versionResult: cannedVersion(MIN_AD_VERSION) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    if (!outcome.ok) {
      expect(outcome.phase).not.toBe('version')
    }
    // outcome.ok=true is also acceptable; depends on defaultStat shape.
  })

  test('version() rejection surfaces as ad-version-probe', async () => {
    const stub = makeStubClient({ versionError: errGeneric('version', 'ErrSomething', 'oops') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe('ad-version-probe')
      expect(outcome.message).toContain('ErrSomething')
    }
  })

  test('ErrCallTimeout at version step → ok=false, classLabel=ad-call-timeout', async () => {
    const stub = makeStubClient({ versionError: errCallTimeout('version', 35000, 30000) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      statSync: defaultStat,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.phase).toBe('version')
      expect(outcome.classLabel).toBe('ad-call-timeout')
      expect(outcome.message).toContain('version')
      expect(outcome.message).toContain('35000')
      expect(outcome.message).toContain('30000')
    }
  })
})

// ---------------------------------------------------------------------------
// SR-5.1 — same-user check
// ---------------------------------------------------------------------------

describe('SR-5.1: same-user check', () => {
  test('UID mismatch → ok=false, classLabel=ad-same-user', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
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
    }
  })

  test('ENOENT on state.db → silent pass (first-run case)', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      ...passingProbes,
      statSync: defaultStat, // throws ENOENT
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
  })

  test('non-ENOENT stat error → ok=false, classLabel=ad-same-user-stat', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const eacces = (): { uid: number } => {
      const err: NodeJS.ErrnoException = new Error('EACCES')
      err.code = 'EACCES'
      throw err
    }
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
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
    }
  })

  test('geteuid undefined → defensive warning + pass (no exit)', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const warnings: { classLabel: string; message: string }[] = []
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
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
  test('valid version + ENOENT state.db → ok=true', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(MIN_AD_VERSION)
    }
  })

  test('version() string without leading v still parses + passes', async () => {
    // Future-proof: AD has historically shipped 'v0.4.3' but the contract
    // only requires the version field be a parseable semver string.
    const stub = makeStubClient({ versionResult: cannedVersion(MIN_AD_VERSION) })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
      ...passingProbes,
      statSync: defaultStat,
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
  })

  test('version newer than MIN_AD_VERSION → ok=true', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion('v99.99.99') })
    const outcome = await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
      closeClient: (c) => (c as typeof stub).close(),
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
// The version gate confirms the AD binary meets MIN_AD_VERSION, but the
// shipped TS shim has historically lagged the binary — dropping methods
// (getPermission), dropping CLI flags (--request-token in buildDecide), and
// missing err_names from the catalog. Each silently breaks CSCB at click-
// handling time. The probes run 1 → 2 → 3 and short-circuit on first failure.
//
// All sub-cases below flow past the version gate, so each runStartupGate call
// must pass the version stub plus override the specific probe(s) under test.
// Same-user deps default to a passing config (geteuid=1000, statSync=ENOENT).

describe('SR-5.1: API surface probes', () => {
  /** Stage the deps shared by every probe sub-case. The caller overrides the
   *  probe under test plus any additional knobs. */
  function probeRunDeps(stub: ReturnType<typeof makeStubClient>) {
    return {
      getClient: () => stub,
      callVersion: (c: unknown) => (c as typeof stub).version({}),
      closeClient: (c: unknown) => (c as typeof stub).close(),
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
      // Remediation must point at the version pin so operators know what to do.
      expect(outcome.message).toContain(MIN_AD_VERSION)
    }
  })

  // -------------------------------------------------------------------------
  // Probe 2 — error catalog is missing required err_names
  // -------------------------------------------------------------------------

  test('probeErrorCatalog reports a single missing name → ad-shim-catalog-incomplete', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
      expect(outcome.message).toContain(MIN_AD_VERSION)
    }
  })

  test('probeErrorCatalog reports all three missing → message lists each', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
    }
  })

  // -------------------------------------------------------------------------
  // Short-circuit ordering: probes run 1 → 2 → 3, stop at first failure
  // -------------------------------------------------------------------------

  test('probe-1 failure short-circuits before probes 2 and 3', async () => {
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    let closeCount = 0
    await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    let closeCount = 0
    await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    let closeCount = 0
    await runStartupGate({
      getClient: () => stub,
      callVersion: (c) => (c as typeof stub).version({}),
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
    const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
    const outcome = await runStartupGate({
      ...probeRunDeps(stub),
      probeGetPermission: () => true,
      probeErrorCatalog: () => ({ ok: true }),
      probeDecideArgv: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.adVersion).toBe(MIN_AD_VERSION)
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
      const stub = makeStubClient({ versionResult: cannedVersion(`v${MIN_AD_VERSION}`) })
      const outcome = await runStartupGate({
        getClient: () => stub,
        callVersion: (c) => (c as typeof stub).version({}),
        closeClient: (c) => (c as typeof stub).close(),
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
