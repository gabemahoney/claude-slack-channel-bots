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
      statSync: (_p) => ({ uid: 1000 }),
      geteuid: () => 1000,
      recordStartupError: noopRecord,
      exit: noopExit,
    })
    expect(outcome.ok).toBe(true)
  })
})
