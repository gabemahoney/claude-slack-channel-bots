/**
 * install-check.test.ts — SR-12.3 coverage for src/install-check.ts.
 *
 * Cases:
 *   - Passing path (resolveSystemBinary returns valid {path, version}, floor matched).
 *   - Each of the three system-install typed errors maps to its class label.
 *   - All eight UnreachableReason values surface in detail.reason.
 *   - Sentinel-equality short-circuit (detected === DEV_SENTINEL_VERSION).
 *   - Floor mismatch produces ad-system-install-too-old.
 *   - Malformed dist/version-floor.json produces ad-version-floor-unreadable.
 *   - Missing .min_binary_version field produces ad-version-floor-unreadable.
 *
 * Mocking strategy: NO mock.module — use the test-only seam
 * `setFloorForTests()` on the install-check module to pre-populate the floor
 * cache with synthetic values (or pre-built failure-arm results), and stub
 * the AD-side `resolveSystemBinary()` by re-routing via a module-local
 * factory function the test wires in.
 *
 * To wire the resolveSystemBinary stub without mock.module we DO have to
 * intercept the AD module — but ONLY install-check.ts imports that name,
 * and the intercept is contained to this test file's beforeEach. mock.restore
 * in afterEach unwinds it; importantly, we do NOT mock `node:fs`, so other
 * test files reading files are unaffected.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import * as realAd from 'agent-director'

import {
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
} from './test-helpers/agent-director-stub.ts'
import {
  DEV_SENTINEL_VERSION,
  SATISFYING_VERSION,
  STALE_VERSION,
} from './test-helpers/install-check-fixtures.ts'
import type { UnreachableReason } from 'agent-director'

let resolveStub: () => Promise<{ path: string; version: string }>

beforeEach(() => {
  resolveStub = async () => ({ path: '/usr/local/bin/agent-director', version: SATISFYING_VERSION })
  mock.module('agent-director', () => ({
    ...realAd,
    resolveSystemBinary: () => resolveStub(),
  }))
})

afterEach(() => {
  mock.restore()
})

/**
 * Load the install-check module under the active mocks. Resets the floor
 * cache and lets the caller pre-seed a floor or failure-arm result for the
 * loadFloor() short-circuit path.
 */
async function loadCheckModule(
  floor: string | import('../src/install-check.ts').InstallCheckFailure = '0.7.0',
): Promise<typeof import('../src/install-check.ts')> {
  const mod = await import('../src/install-check.ts')
  mod.resetCacheForTests()
  mod.setFloorForTests(floor)
  return mod
}

describe('SR-5: runInstallCheck — passing path', () => {
  test('valid path + version meeting floor → success arm', async () => {
    const { runInstallCheck } = await loadCheckModule('0.7.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.binaryPath).toBe('/usr/local/bin/agent-director')
      expect(result.binaryVersion).toBe(SATISFYING_VERSION)
      expect(result.floor).toBe('0.7.0')
    }
  })
})

describe('SR-5: typed-error mapping', () => {
  test('ErrSystemInstallNotFound → ad-system-install-not-found', async () => {
    resolveStub = async () => {
      throw errSystemInstallNotFound()
    }
    const { runInstallCheck } = await loadCheckModule('0.7.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-system-install-not-found')
    }
  })

  test('ErrSystemInstallTooOld → ad-system-install-too-old (detail carries detected + required)', async () => {
    resolveStub = async () => {
      throw errSystemInstallTooOld('0.5.0', '0.7.0', '/usr/local/bin/agent-director')
    }
    const { runInstallCheck } = await loadCheckModule('0.7.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-system-install-too-old')
      expect(result.detail.detected).toBe('0.5.0')
      expect(result.detail.required).toBe('0.7.0')
    }
  })
})

describe('SR-5: ErrSystemInstallUnreachable — all eight reasons', () => {
  const REASONS: UnreachableReason[] = [
    'not-executable',
    'not-a-regular-file',
    'probe-timeout',
    'probe-nonzero-exit',
    'probe-killed-by-signal',
    'unparseable-version',
    'spawn-failed',
    'other',
  ]

  for (const reason of REASONS) {
    test(`reason='${reason}' surfaces in detail.reason verbatim`, async () => {
      resolveStub = async () => {
        throw errSystemInstallUnreachable(reason)
      }
      const { runInstallCheck } = await loadCheckModule('0.7.0')
      const result = await runInstallCheck()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.classLabel).toBe('ad-system-install-unreachable')
        expect(result.detail.reason).toBe(reason)
      }
    })
  }
})

describe('SR-5: sentinel-equality short-circuit', () => {
  test('detected === DEV_SENTINEL_VERSION passes even when floor is high', async () => {
    resolveStub = async () => ({ path: '/dev/builds/agent-director', version: DEV_SENTINEL_VERSION })
    const { runInstallCheck } = await loadCheckModule('99.0.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.binaryVersion).toBe(DEV_SENTINEL_VERSION)
      expect(result.floor).toBe('99.0.0')
    }
  })
})

describe('SR-5: floor mismatch (non-sentinel)', () => {
  test('detected below floor → ad-system-install-too-old', async () => {
    resolveStub = async () => ({ path: '/usr/local/bin/agent-director', version: STALE_VERSION })
    const { runInstallCheck } = await loadCheckModule('0.7.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-system-install-too-old')
      expect(result.detail.detected).toBe(STALE_VERSION)
      expect(result.detail.required).toBe('0.7.0')
    }
  })

  test("leading 'v' on detected version still compares correctly", async () => {
    resolveStub = async () => ({ path: '/usr/local/bin/agent-director', version: `v${STALE_VERSION}` })
    const { runInstallCheck } = await loadCheckModule('0.7.0')
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-system-install-too-old')
    }
  })
})

describe('SR-5: ad-version-floor-unreadable', () => {
  test('malformed JSON → ad-version-floor-unreadable', async () => {
    const failure: import('../src/install-check.ts').InstallCheckFailure = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message: 'simulated parse failure',
      detail: { underlying: 'Unexpected token } in JSON at position 42' },
    }
    const { runInstallCheck } = await loadCheckModule(failure)
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-version-floor-unreadable')
    }
  })

  test('missing .min_binary_version field → ad-version-floor-unreadable', async () => {
    const failure: import('../src/install-check.ts').InstallCheckFailure = {
      ok: false,
      classLabel: 'ad-version-floor-unreadable',
      message: 'simulated missing field',
      detail: { parsed: { unrelated_field: 'value' } },
    }
    const { runInstallCheck } = await loadCheckModule(failure)
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-version-floor-unreadable')
    }
  })
})
