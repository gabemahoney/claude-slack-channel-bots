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
 * Mocking strategy:
 *   - The real `agent-director` module is captured into `realAd` at top of file.
 *     mock.module('agent-director', ...) inside beforeEach returns a spread of
 *     `realAd` with `resolveSystemBinary` overridden — preserving the typed
 *     error classes, DEV_SENTINEL_VERSION, and everything else.
 *   - `node:fs`'s `readFileSync` is intercepted only for paths ending in
 *     `version-floor.json`. Everything else passes through.
 *
 * No top-level mock.module — all mocks live inside beforeEach/afterEach
 * (pretest gate enforces this).
 *
 * All AD-side error construction uses Epic 1's stub factories.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import * as realAd from 'agent-director'
import * as realFs from 'node:fs'

import {
  errSystemInstallNotFound,
  errSystemInstallTooOld,
  errSystemInstallUnreachable,
} from './test-helpers/agent-director-stub.ts'
import {
  DEV_SENTINEL_VERSION,
  SATISFYING_VERSION,
  STALE_VERSION,
  makeMalformedFloorJson,
  makeMissingFieldFloorJson,
  makeVersionFloorJson,
} from './test-helpers/install-check-fixtures.ts'
import type { UnreachableReason } from 'agent-director'

let resolveStub: () => Promise<{ path: string; version: string }>
let floorJson: string

beforeEach(() => {
  resolveStub = async () => ({ path: '/usr/local/bin/agent-director', version: SATISFYING_VERSION })
  floorJson = makeVersionFloorJson('0.7.0')

  mock.module('agent-director', () => ({
    ...realAd,
    resolveSystemBinary: () => resolveStub(),
  }))

  mock.module('node:fs', () => ({
    ...realFs,
    readFileSync: (path: string | URL, ...rest: unknown[]): string | Buffer => {
      const pathStr = typeof path === 'string' ? path : path.toString()
      if (pathStr.endsWith('version-floor.json')) {
        return floorJson
      }
      return (realFs.readFileSync as (...a: unknown[]) => string | Buffer)(path, ...rest)
    },
  }))
})

afterEach(() => {
  mock.restore()
})

/**
 * Dynamic import each test so the module is re-evaluated under the current
 * mocks. Resets the floor cache to exercise the read path every time.
 */
async function loadCheckModule(): Promise<typeof import('../src/install-check.ts')> {
  const mod = await import('../src/install-check.ts')
  mod.resetCacheForTests()
  return mod
}

describe('SR-5: runInstallCheck — passing path', () => {
  test('valid path + version meeting floor → success arm', async () => {
    const { runInstallCheck } = await loadCheckModule()
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
    const { runInstallCheck } = await loadCheckModule()
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
    const { runInstallCheck } = await loadCheckModule()
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
      const { runInstallCheck } = await loadCheckModule()
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
    floorJson = makeVersionFloorJson('99.0.0')
    resolveStub = async () => ({ path: '/dev/builds/agent-director', version: DEV_SENTINEL_VERSION })
    const { runInstallCheck } = await loadCheckModule()
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
    floorJson = makeVersionFloorJson('0.7.0')
    const { runInstallCheck } = await loadCheckModule()
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
    floorJson = makeVersionFloorJson('0.7.0')
    const { runInstallCheck } = await loadCheckModule()
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-system-install-too-old')
    }
  })
})

describe('SR-5: ad-version-floor-unreadable', () => {
  test('malformed JSON → ad-version-floor-unreadable', async () => {
    floorJson = makeMalformedFloorJson()
    const { runInstallCheck } = await loadCheckModule()
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-version-floor-unreadable')
    }
  })

  test('missing .min_binary_version field → ad-version-floor-unreadable', async () => {
    floorJson = makeMissingFieldFloorJson()
    const { runInstallCheck } = await loadCheckModule()
    const result = await runInstallCheck()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classLabel).toBe('ad-version-floor-unreadable')
    }
  })
})
