/**
 * test-timer-overrides.test.ts — Unit tests for the test-only timer override
 * block's start-time install (`src/test-timer-overrides.ts`, bug b.2nr).
 *
 * The block's validation is pinned in `tests/config.test.ts`, its feeds in
 * the tests of the modules they reach (`conflict-latch.test.ts`,
 * `unavailable-retry.test.ts`, `ad-version-gate.test.ts`,
 * `ad-settings.test.ts`), and `main()`'s call in
 * `tests/server-startup-wiring.test.ts`. This file pins the module itself:
 * the effective values, the one loud line, and what the install changes in
 * the process (the installed version re-check's interval, B's floor) and what
 * it leaves alone when the block is absent or empty. No real timer is armed;
 * the version re-check runs on the shared fake clock.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { adLaunchBoundMsInEffect, DIALOG_READY_TIMEOUT_MS, resetAdSettingsForTests } from '../src/ad-settings.ts'
import {
  AD_VERSION_RECHECK_INTERVAL_MS,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
} from '../src/ad-version-gate.ts'
import { TEST_TIMER_OVERRIDE_KEYS, type TestTimerOverrides } from '../src/config.ts'
import { LATCH_RECHECK_INTERVAL_MS } from '../src/conflict-latch.ts'
import { DELIVERY_STUCK_AFTER_MS } from '../src/delivery-constants.ts'
import {
  buildTestTimerOverridesLine,
  effectiveTestTimer,
  effectiveTestTimers,
  installTestTimerOverrides,
  TEST_TIMER_OVERRIDES_LOG_PREFIX,
} from '../src/test-timer-overrides.ts'
import { UNAVAILABLE_RETRY_BASE_S, UNAVAILABLE_RETRY_CEILING_S } from '../src/unavailable-retry.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeStubResolveSystemBinary } from './test-helpers/agent-director-stub.ts'
import { PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

/** The production default of each key, from the exported constants. */
const DEFAULTS = {
  latch_recheck_interval_ms: LATCH_RECHECK_INTERVAL_MS,
  ad_version_recheck_interval_ms: AD_VERSION_RECHECK_INTERVAL_MS,
  dialog_ready_timeout_ms: DIALOG_READY_TIMEOUT_MS,
  delivery_stuck_after_ms: DELIVERY_STUCK_AFTER_MS,
  unavailable_retry_base_s: UNAVAILABLE_RETRY_BASE_S,
  unavailable_retry_ceiling_s: UNAVAILABLE_RETRY_CEILING_S,
} as const

/** The override set test-26's refused legs run with. */
const REFUSED_LEG: TestTimerOverrides = {
  ad_version_recheck_interval_ms: 20_000,
  dialog_ready_timeout_ms: 120_000,
  unavailable_retry_base_s: 5,
  unavailable_retry_ceiling_s: 60,
}

afterEach(() => {
  resetAdVersionRecheckForTests()
  resetAdSettingsForTests()
})

/** Install a version re-check on a fake clock, as `main()` does before it reads the block. */
function installedRecheck(): { clock: ReturnType<typeof createFakeClock>; calls: Array<object | undefined> } {
  const clock = createFakeClock()
  const calls: Array<object | undefined> = []
  installAdVersionRecheck({
    resolveSystemBinary: makeStubResolveSystemBinary({ calls }),
    baselineVersion: PHASE1_RC_VERSION,
    recordStartupError: () => {},
    stop: () => {},
    log: () => {},
    clock,
  })
  return { clock, calls }
}

describe('effectiveTestTimer and effectiveTestTimers', () => {
  test('pin: the production delivery-stuck wait is five minutes (b.omv SR-8.2)', () => {
    expect(DELIVERY_STUCK_AFTER_MS).toBe(300_000)
  })

  test.each([undefined, {}])('with %p every key is its production default', (overrides) => {
    for (const key of TEST_TIMER_OVERRIDE_KEYS) expect(effectiveTestTimer(key, overrides)).toBe(DEFAULTS[key])
    expect(effectiveTestTimers(overrides)).toEqual({
      latchRecheckIntervalMs: DEFAULTS.latch_recheck_interval_ms,
      adVersionRecheckIntervalMs: DEFAULTS.ad_version_recheck_interval_ms,
      dialogReadyTimeoutMs: DEFAULTS.dialog_ready_timeout_ms,
      deliveryStuckAfterMs: DEFAULTS.delivery_stuck_after_ms,
      unavailableRetryBaseS: DEFAULTS.unavailable_retry_base_s,
      unavailableRetryCeilingS: DEFAULTS.unavailable_retry_ceiling_s,
    })
  })

  test('a key the block gives is its value, and every other key stays its default', () => {
    for (const key of TEST_TIMER_OVERRIDE_KEYS) {
      for (const other of TEST_TIMER_OVERRIDE_KEYS) {
        expect(effectiveTestTimer(other, { [key]: 7 })).toBe(other === key ? 7 : DEFAULTS[other])
      }
    }
  })

  test('the refused leg\'s set maps onto the named timers', () => {
    expect(effectiveTestTimers(REFUSED_LEG)).toEqual({
      latchRecheckIntervalMs: LATCH_RECHECK_INTERVAL_MS,
      adVersionRecheckIntervalMs: 20_000,
      dialogReadyTimeoutMs: 120_000,
      deliveryStuckAfterMs: DELIVERY_STUCK_AFTER_MS,
      unavailableRetryBaseS: 5,
      unavailableRetryCeilingS: 60,
    })
  })
})

describe('buildTestTimerOverridesLine', () => {
  test.each([undefined, {}])('with %p there is no line', (overrides) => {
    expect(buildTestTimerOverridesLine(overrides)).toBeUndefined()
  })

  test('one override: the head, the key with its value and default, the test-only note', () => {
    expect(buildTestTimerOverridesLine({ latch_recheck_interval_ms: 45_000 })).toBe(
      '[slack] TEST TIMER OVERRIDES ACTIVE: latch_recheck_interval_ms=45000 (default 120000); ' +
        'test-only shortened timers from config.json test_timer_overrides, read once at this start; not for production use',
    )
  })

  test('several overrides: every overridden key, with its default, in key order whatever the object\'s order', () => {
    const reordered: TestTimerOverrides = {
      unavailable_retry_ceiling_s: 60,
      unavailable_retry_base_s: 5,
      dialog_ready_timeout_ms: 120_000,
    }
    expect(buildTestTimerOverridesLine(reordered)).toBe(
      '[slack] TEST TIMER OVERRIDES ACTIVE: dialog_ready_timeout_ms=120000 (default 300000), unavailable_retry_base_s=5 (default 30), unavailable_retry_ceiling_s=60 (default 300); ' +
        'test-only shortened timers from config.json test_timer_overrides, read once at this start; not for production use',
    )
  })

  test('all six keys are named, each once, and the line starts with the exported head', () => {
    const line = buildTestTimerOverridesLine({
      latch_recheck_interval_ms: 45_000,
      ad_version_recheck_interval_ms: 20_000,
      dialog_ready_timeout_ms: 120_000,
      delivery_stuck_after_ms: 7_000,
      unavailable_retry_base_s: 5,
      unavailable_retry_ceiling_s: 60,
    })!
    expect(line.startsWith(`${TEST_TIMER_OVERRIDES_LOG_PREFIX}: `)).toBe(true)
    for (const key of TEST_TIMER_OVERRIDE_KEYS) expect(line.split(`${key}=`)).toHaveLength(2)
    expect(line.indexOf('latch_recheck_interval_ms=')).toBeLessThan(line.indexOf('ad_version_recheck_interval_ms='))
    expect(line.indexOf('dialog_ready_timeout_ms=')).toBeLessThan(line.indexOf('delivery_stuck_after_ms='))
    expect(line.indexOf('delivery_stuck_after_ms=')).toBeLessThan(line.indexOf('unavailable_retry_base_s='))
    expect(line.indexOf('unavailable_retry_base_s=')).toBeLessThan(line.indexOf('unavailable_retry_ceiling_s='))
    expect(line.split('\n')).toHaveLength(1)
    assertNoLeak(line, 'the overrides line')
  })
})

describe('installTestTimerOverrides', () => {
  test.each([undefined, {}])('with %p it logs nothing, changes nothing and answers the production timers', async (overrides) => {
    const { clock, calls } = installedRecheck()
    const lines: string[] = []

    const timers = installTestTimerOverrides(overrides, (line) => lines.push(line))

    expect(lines).toEqual([])
    expect(timers).toEqual(effectiveTestTimers(undefined))
    expect(adLaunchBoundMsInEffect()).toBe(DIALOG_READY_TIMEOUT_MS)
    // The re-check's pending timer is untouched: due at the production interval, not moved.
    expect(clock.pending().map((t) => t.delayMs)).toEqual([AD_VERSION_RECHECK_INTERVAL_MS])
    await clock.advance(AD_VERSION_RECHECK_INTERVAL_MS - 1)
    expect(calls).toHaveLength(0)
  })

  // Regression (b.2nr): before the fix nothing read the block, so B stayed 300 s and the re-check 120 s whatever the config said.
  test('the block shortens B\'s floor and the installed version re-check\'s interval, logs the one loud line once, and answers the timers in effect', async () => {
    const { clock, calls } = installedRecheck()
    const lines: string[] = []

    const timers = installTestTimerOverrides(REFUSED_LEG, (line) => lines.push(line))

    expect(lines).toEqual([buildTestTimerOverridesLine(REFUSED_LEG)!])
    expect(timers).toEqual(effectiveTestTimers(REFUSED_LEG))
    expect(adLaunchBoundMsInEffect()).toBe(120_000)
    expect(clock.pending().map((t) => t.delayMs)).toEqual([20_000])
    await clock.advance(20_000 - 1)
    expect(calls).toHaveLength(0)
    await clock.advance(1)
    expect(calls).toHaveLength(1)
  })

  test('B\'s floor moves only with dialog_ready_timeout_ms, and the re-check only with ad_version_recheck_interval_ms', () => {
    const { clock } = installedRecheck()
    installTestTimerOverrides({ unavailable_retry_base_s: 5, unavailable_retry_ceiling_s: 60, latch_recheck_interval_ms: 45_000 }, () => {})
    expect(adLaunchBoundMsInEffect()).toBe(DIALOG_READY_TIMEOUT_MS)
    expect(clock.pending().map((t) => t.delayMs)).toEqual([AD_VERSION_RECHECK_INTERVAL_MS])
  })

  test('the delivery-stuck override is captured at start and logged once without changing the defaults or other timers (b.omv SR-14.1)', () => {
    const { clock } = installedRecheck()
    const lines: string[] = []
    const overrides: TestTimerOverrides = { delivery_stuck_after_ms: 7_000 }

    const timers = installTestTimerOverrides(overrides, (line) => lines.push(line))

    expect(timers).toEqual({ ...effectiveTestTimers(undefined), deliveryStuckAfterMs: 7_000 })
    expect(lines).toEqual([buildTestTimerOverridesLine(overrides)!])
    expect(lines[0]).toContain(`${TEST_TIMER_OVERRIDES_LOG_PREFIX}: delivery_stuck_after_ms=7000 (default ${DELIVERY_STUCK_AFTER_MS})`)
    expect(lines[0]).toContain('read once at this start; not for production use')
    expect(adLaunchBoundMsInEffect()).toBe(DIALOG_READY_TIMEOUT_MS)
    expect(clock.pending().map((timer) => timer.delayMs)).toEqual([AD_VERSION_RECHECK_INTERVAL_MS])

    // A later config object cannot change the values the running server captured.
    overrides.delivery_stuck_after_ms = 9_000
    expect(timers.deliveryStuckAfterMs).toBe(7_000)
    expect(effectiveTestTimers(undefined).deliveryStuckAfterMs).toBe(DELIVERY_STUCK_AFTER_MS)
    expect(lines).toHaveLength(1)
    assertNoLeak(lines, 'the delivery-stuck override startup line')
  })

  test('the latch, base and ceiling overrides reach the caller through the answer, for the latch re-check and the retry timers', () => {
    const timers = installTestTimerOverrides(
      { latch_recheck_interval_ms: 45_000, unavailable_retry_base_s: 5, unavailable_retry_ceiling_s: 60 },
      () => {},
    )
    expect([timers.latchRecheckIntervalMs, timers.unavailableRetryBaseS, timers.unavailableRetryCeilingS]).toEqual([45_000, 5, 60])
  })

  test('with no version re-check installed it still applies the rest and does not throw', () => {
    expect(() => installTestTimerOverrides(REFUSED_LEG, () => {})).not.toThrow()
    expect(adLaunchBoundMsInEffect()).toBe(120_000)
  })
})
