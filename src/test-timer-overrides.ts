/**
 * The test-only timer override block (b.2nr). Undocumented for users; OFF by
 * default. It lets a `/ci` scenario shorten production timers so it does
 * not wait them out, without changing any of them for a real configuration.
 *
 * The block is the top-level `test_timer_overrides` object of `config.json`
 * (`TEST_TIMER_OVERRIDE_KEYS`, validated by `src/config.ts`), each key
 * optional:
 *
 *   latch_recheck_interval_ms       ms   `LATCH_RECHECK_INTERVAL_MS` (src/conflict-latch.ts),
 *                                          fed through `LatchRecheckInput.intervalMs`
 *   ad_version_recheck_interval_ms  ms   `AD_VERSION_RECHECK_INTERVAL_MS` (src/ad-version-gate.ts),
 *                                          fed through `setAdVersionRecheckIntervalMs`; it also
 *                                          paces the re-read of agent-director's settings file
 *   dialog_ready_timeout_ms         ms   B's floor, `DIALOG_READY_TIMEOUT_MS` (src/ad-settings.ts),
 *                                          fed through `installLaunchBoundFloorMs`
 *   unavailable_retry_base_s        s    `UNAVAILABLE_RETRY_BASE_S` (src/unavailable-retry.ts),
 *                                          fed through `UnavailableRetryDeps.baseS`
 *   unavailable_retry_ceiling_s     s    `UNAVAILABLE_RETRY_CEILING_S`, through `.ceilingS`
 *
 * It is read once, at server start, from the start-time configuration (the
 * last-applied record when there is one, else `config.json`): `main()` calls
 * {@link installTestTimerOverrides} right after the start resolves. A change
 * of the block in a later reload is recorded but never applied live; it takes
 * effect at the next start, and the reload preview does not list it (it is
 * not one of the documented server-wide settings). The exported constants
 * stay the defaults and are never mutated.
 *
 * Whenever any override is active, one loud line at start names every
 * overridden value ({@link buildTestTimerOverridesLine}).
 */

import { DELIVERY_STUCK_AFTER_MS } from './delivery-constants.ts'
import { TEST_TIMER_OVERRIDE_KEYS, type TestTimerOverrideKey, type TestTimerOverrides } from './config.ts'
import { installLaunchBoundFloorMs, DIALOG_READY_TIMEOUT_MS } from './ad-settings.ts'
import { AD_VERSION_RECHECK_INTERVAL_MS, setAdVersionRecheckIntervalMs } from './ad-version-gate.ts'
import { LATCH_RECHECK_INTERVAL_MS } from './conflict-latch.ts'
import { UNAVAILABLE_RETRY_BASE_S, UNAVAILABLE_RETRY_CEILING_S } from './unavailable-retry.ts'

/** The head of the one line written at start when any override is active. */
export const TEST_TIMER_OVERRIDES_LOG_PREFIX = '[slack] TEST TIMER OVERRIDES ACTIVE'

/** The timers in effect: each the override when the block gives one, else the production default. */
export interface EffectiveTestTimers {
  readonly deliveryStuckAfterMs: number
  /** The latch re-check interval, ms. */
  readonly latchRecheckIntervalMs: number
  /** The agent-director version re-check interval, ms. */
  readonly adVersionRecheckIntervalMs: number
  /** B's floor (the stuck-launch bound's lower limit), ms. */
  readonly dialogReadyTimeoutMs: number
  /** The UNAVAILABLE retry timer's first wait, seconds. */
  readonly unavailableRetryBaseS: number
  /** The UNAVAILABLE retry timer's longest wait, seconds. */
  readonly unavailableRetryCeilingS: number
}

/** The production default of each override key. */
function defaultOf(key: TestTimerOverrideKey): number {
  switch (key) {
    case 'latch_recheck_interval_ms':
      return LATCH_RECHECK_INTERVAL_MS
    case 'ad_version_recheck_interval_ms':
      return AD_VERSION_RECHECK_INTERVAL_MS
    case 'delivery_stuck_after_ms':
      return DELIVERY_STUCK_AFTER_MS
    case 'dialog_ready_timeout_ms':
      return DIALOG_READY_TIMEOUT_MS
    case 'unavailable_retry_base_s':
      return UNAVAILABLE_RETRY_BASE_S
    case 'unavailable_retry_ceiling_s':
      return UNAVAILABLE_RETRY_CEILING_S
  }
}

/** The keys the block overrides, in `TEST_TIMER_OVERRIDE_KEYS` order. */
function overriddenKeys(overrides: TestTimerOverrides | undefined): TestTimerOverrideKey[] {
  if (overrides === undefined) return []
  return TEST_TIMER_OVERRIDE_KEYS.filter((key) => overrides[key] !== undefined)
}

/** The value of `key` in effect: the override, else the production default. */
export function effectiveTestTimer(key: TestTimerOverrideKey, overrides?: TestTimerOverrides): number {
  return overrides?.[key] ?? defaultOf(key)
}

/** The timers in effect for `overrides` (none: the production defaults). Pure. */
export function effectiveTestTimers(overrides?: TestTimerOverrides): EffectiveTestTimers {
  return {
    deliveryStuckAfterMs: effectiveTestTimer('delivery_stuck_after_ms', overrides),
    latchRecheckIntervalMs: effectiveTestTimer('latch_recheck_interval_ms', overrides),
    adVersionRecheckIntervalMs: effectiveTestTimer('ad_version_recheck_interval_ms', overrides),
    dialogReadyTimeoutMs: effectiveTestTimer('dialog_ready_timeout_ms', overrides),
    unavailableRetryBaseS: effectiveTestTimer('unavailable_retry_base_s', overrides),
    unavailableRetryCeilingS: effectiveTestTimer('unavailable_retry_ceiling_s', overrides),
  }
}

/**
 * The loud line written at start when any override is active, naming every
 * overridden value with its production default; `undefined` when none is.
 * Pure.
 */
export function buildTestTimerOverridesLine(overrides: TestTimerOverrides | undefined): string | undefined {
  const keys = overriddenKeys(overrides)
  if (keys.length === 0) return undefined
  const named = keys.map((key) => `${key}=${effectiveTestTimer(key, overrides)} (default ${defaultOf(key)})`)
  return (
    `${TEST_TIMER_OVERRIDES_LOG_PREFIX}: ${named.join(', ')}; ` +
    'test-only shortened timers from config.json test_timer_overrides, read once at this start; not for production use'
  )
}

/**
 * Apply the block at server start and answer the timers in effect. With no
 * override (the block absent or empty) it changes nothing, logs nothing and
 * answers the production defaults. Otherwise it writes the one loud line
 * ({@link buildTestTimerOverridesLine}), moves the installed version
 * re-check's interval, sets B's floor, and answers the timers for the caller
 * to hand to the latch re-check and the retry timers. Call once, after the
 * start resolves its configuration and before those are built.
 */
export function installTestTimerOverrides(
  overrides: TestTimerOverrides | undefined,
  log: (line: string) => void,
): EffectiveTestTimers {
  const line = buildTestTimerOverridesLine(overrides)
  if (line === undefined) return effectiveTestTimers(undefined)
  log(line)
  const effective = effectiveTestTimers(overrides)
  if (overrides?.ad_version_recheck_interval_ms !== undefined) setAdVersionRecheckIntervalMs(effective.adVersionRecheckIntervalMs)
  if (overrides?.dialog_ready_timeout_ms !== undefined) installLaunchBoundFloorMs(effective.dialogReadyTimeoutMs)
  return effective
}
