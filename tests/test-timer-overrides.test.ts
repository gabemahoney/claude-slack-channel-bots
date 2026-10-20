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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { describeKillOutcome, KILL_OUTCOME_KILLED } from '../src/checked-kill.ts'
import { stuckLaunchAbortKillLine, STUCK_LAUNCH_ABORT_KILL_SUCCEEDED } from '../src/pending-row.ts'
import { doublingBackoffDelay } from '../src/backoff.ts'
import { afterEach, describe, expect, test } from 'bun:test'
import { adLaunchBoundMs, DEFAULT_AD_SETTINGS_IN_EFFECT, pendingGraceMinimumSeconds, adLaunchBoundMsInEffect, DIALOG_READY_TIMEOUT_MS, resetAdSettingsForTests } from '../src/ad-settings.ts'
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
import { unavailableRetryRetryLine, unavailableRetryReArmedLine, UNAVAILABLE_RETRY_BASE_S, UNAVAILABLE_RETRY_CEILING_S } from '../src/unavailable-retry.ts'
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

// Exercise the actual shell oracle without sourcing or running a scenario.
// Rows/hooks/checked-kill outcomes here are modeled AD records, not CI proof.
describe('b.acu CI round 3: test-26 recovery observation deadline', () => {
  const source = readFileSync(join(import.meta.dir, 'integration/test-26-fmk-timing-settings.sh'), 'utf8')
  const declaration = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
  const input = (name: string) => Number(source.match(new RegExp(`^${name}=(\\d+)`, 'm'))![1])
  const createMs = input('CREATE_RAISED_MS')
  const settings = {
    ...DEFAULT_AD_SETTINGS_IN_EFFECT,
    tmux: {
      ...DEFAULT_AD_SETTINGS_IN_EFFECT.tmux,
      create_timeout_ms: BigInt(createMs),
      pending_grace_seconds: pendingGraceMinimumSeconds(BigInt(createMs), DEFAULT_AD_SETTINGS_IN_EFFECT.tmux.pipe_close_wait_ms),
    },
  }
  const boundMs = adLaunchBoundMs(settings, input('OVR_DIALOG_READY_MS'))
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  function probe(completed: number, command: string, options: { boundMs?: number; base?: number; ceiling?: number; launchAt?: number } = {}) {
    const root = mkdtempSync('/tmp/timing-bound-control-')
    const base = options.base ?? input('OVR_RETRY_BASE_S'), ceiling = options.ceiling ?? input('OVR_RETRY_CEILING_S')
    let due = 0
    const retryCases = Array.from({ length: 100 }, (_, attempt) => {
      due += doublingBackoffDelay(base, attempt, ceiling)
      return `${attempt + 1}) echo ${due};;`
    }).join('\n')
    writeFileSync(join(root, 'calls.tsv'), '')
    writeFileSync(join(root, 'outcomes.tsv'), '')
    writeFileSync(join(root, 'row.json'), JSON.stringify({ state: 'waiting', session_id: 'fresh-session' }))
    const script = [
      'set -euo pipefail', `fixture=${quote(root)}`,
      `B_CT_MS=${options.boundMs ?? boundMs}`, `OVR_RETRY_BASE_S=${base}`, `OVR_RETRY_CEILING_S=${ceiling}`,
      ...['LOG_WAIT_S', 'LAUNCH_WAIT_S', 'REPORT_WAIT_S'].map(name => `${name}=${input(name)}`),
      'fail() { echo "$*" >&2; exit 1; }',
      // Match the printer contract, calculating every returned due time with
      // production backoff arithmetic in the parent, over the supplied set.
      `printed() { [[ "$1 $3 $4" == "unavailableRetryDueS unavailable_retry_base_s=${base} unavailable_retry_ceiling_s=${ceiling}" ]] || exit 9; case "$2" in ${retryCases} *) exit 9;; esac; }`,
      ...['time_before', 'time_plus', 'seconds_between', 'call_timeout_observation_deadline', 'call_timeout_recovery_started', 'hooks_brought_up', 'expect_checked_kill_before_launch'].map(declaration),
      'NOW=0; now_s() { echo "$NOW"; }',
      `CT_LAUNCH_AT=${options.launchAt ?? 0}; call_timeout_observation_deadline "$CT_LAUNCH_AT" ${completed}`,
      'declare -A ID=([t2]=cscb_fixture) KEY=([t2]=fixture)', 'SCENARIO_TAG=fixture', 'AD_OUT="$fixture/row.json"',
      'ad_capture() { [[ "$*" == "get --instance-id cscb_fixture" ]] || exit 9; AD_RC=0; }',
      `ad_trail_events() { [[ "$*" == 'ad.hook.fired cscb_fixture' ]] || exit 9; echo '{"event_name":"SessionStart","session_id":"fresh-session","upsert_outcome":"updated"}'; }`,
      'cscb_calls_between() { echo 0; }',
      'wait_until() { [[ "$3 $4 $5" == "row_state_is cscb_fixture waiting" ]] || exit 9; time_before "$READY" "$(time_plus "$NOW" "$1")" || fail "never reported in"; NOW="$READY"; }',
      command,
    ].join('\n')
    try {
      const result = spawnSync('bash', ['-c', script], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'awk', 'jq', 'wc', 'grep', 'cat'] }), encoding: 'utf8', timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
      return result
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  test('the written 40-second create timeout raises G to 61 seconds and B to 121 seconds', () => {
    expect([createMs, Number(settings.tmux.pending_grace_seconds), boundMs]).toEqual([40_000, 61, 121_000])
    expect(source).toContain('B_CT_MS="$(printed adLaunchBoundMs "${TABLE_CT[@]}" "dialog_ready_timeout_ms=${OVR_DIALOG_READY_MS}")"')
    expect(declaration('leg_call_timeout_high')).toContain('call_timeout_observation_deadline "${CT_LAUNCH_AT}" "${T_END}"')
    expect(declaration('leg_call_timeout_low')).toContain('call_timeout_observation_deadline "${CT_LAUNCH_AT}" "${T_END}" "${RETRY_CEILING_S}"')
  })

  test.each([
    [30, 5, 165], [40.059, 5, 175.059],
    [45.999, 5, 180.999], [46, 4, 121], [46.001, 4, 121.001],
  ])('error completed at +%s: retry %s at +%s is the first at/after B', (completed, retry, eligible) => {
    const result = probe(completed, 'echo "$CT_ELIGIBLE_RETRY $CT_ELIGIBLE_AT $CT_DEADLINE"')
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split(' ').map(Number)).toEqual([
      retry, eligible, Number((eligible + input('LOG_WAIT_S') + input('LAUNCH_WAIT_S') + input('REPORT_WAIT_S')).toFixed(3)),
    ])
  })

  test.each([
    { base: 10, ceiling: 20, boundMs: 121_000, retry: 5, eligible: 130.059 },
    { base: 5, ceiling: 60, boundMs: 200_000, retry: 6, eligible: 235.059 },
  ])('the actual oracle responds to changed retry settings and B: %p', options => {
    const result = probe(40.059, 'echo "$CT_ELIGIBLE_RETRY $CT_ELIGIBLE_AT"', options)
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split(' ').map(Number)).toEqual([options.retry, options.eligible])
  })

  test.each([30, 40.059])('error +%s: SessionStart has its own bounded phase after the actual recovery launch', completed => {
    const ready = completed + 136
    expect(ready).toBeGreaterThan(completed + input('REPORT_WAIT_S'))
    const result = probe(completed, `NOW=${completed + 135}; READY=${ready}; hooks_brought_up control t2 0; echo recovered`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('recovered')
  })

  test('a SessionStart beyond its own report phase still fails', () => {
    const result = probe(40.059, 'NOW=175.059; READY=296; hooks_brought_up control t2 0')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('never reported in')
  })

  type RetryRecord = { start: number; end?: number; get: number; kill?: number; beforeB?: boolean }
  function recoveryProbe(completed: number, records: RetryRecord[], options: { launchAt?: number; now?: number } = {}) {
    const logs: Array<[string, number]> = []
    const calls = { get: [] as string[], kill: [] as string[] }
    let due = 0
    const dueCases = Array.from({ length: 10 }, (_, i) => {
      due += doublingBackoffDelay(input('OVR_RETRY_BASE_S'), i, input('OVR_RETRY_CEILING_S'))
      return `${i + 1}) echo ${due};;`
    }).join('\n')
    records.forEach((r, i) => {
      logs.push([unavailableRetryRetryLine('fixture', i + 1, false), r.start])
      if (r.end !== undefined) logs.push([unavailableRetryReArmedLine('fixture', i + 1, false, 'fixture-marker', undefined, 0), r.end])
      calls.get.push(`shim\t${r.get}\tcscb_fixture`)
      if (r.kill !== undefined) calls.kill.push(`shim\t${r.kill}\tcscb_fixture`)
    })
    const commands = [
      'REFUSED_MARKER=fixture-marker; declare -A REF=([t2]=fixture)',
      `NOW=${options.now ?? records.at(-1)!.kill ?? records.at(-1)!.end ?? records.at(-1)!.start}`,
      // These are the production retry builders. The printer itself is a
      // Docker-only entry point; execute the extracted audit, not the scenario.
      `printed() { case "$1" in unavailableRetryDueS) case "$2" in ${dueCases} esac;; unavailableRetryRetryLine) case "$3" in ${Array.from({length: 11}, (_, i) => `${i + 1}) echo ${quote(unavailableRetryRetryLine('fixture', i + 1, false))};;`).join('\n')} esac;; unavailableRetryReArmedLine) case "$3" in ${Array.from({length: 10}, (_, i) => `${i + 1}) echo ${quote(unavailableRetryReArmedLine('fixture', i + 1, false, 'fixture-marker', undefined, 0))};;`).join('\n')} esac;; pendingRowRuleRoundLineHead) echo fixture-round;; *) exit 9;; esac; }`,
      // log_lines uses substring matching, as the scenario's log reader does.
      `log_lines() { while IFS=$'\t' read -r at line; do [[ "$line" == *"$1"* ]] && printf '%s\t%s\n' "$at" "$line"; done < "$fixture/retries.tsv"; return 0; }`,
      `log_time() { echo "\${1%%$'\t'*}"; }`,
      `cscb_ad_calls() { [[ "$2 $3" == '--instance-id cscb_fixture' ]] || exit 9; case "$1" in get) cat "$fixture/gets.tsv";; kill) cat "$fixture/kills.tsv";; *) exit 9;; esac; }`,
      `first_cscb_call_at_or_after() { local a="$1"; shift; cscb_ad_calls "$@" | awk -F'\t' -v a="$a" '$2 >= a { print; exit }'; }`,
      `call_fields() { CALL_T="$(awk -F'\t' '{print $2}' <<< "$2")"; }`,
      `log_lines_from() { local a="$1" b="$2"; log_lines "$3" | awk -F'\t' -v a="$a" -v b="$b" '$1 >= a && $1 < b'; }`,
      `printf '%s\n' ${quote(logs.map(([line, at]) => `${at}\t${line}`).join('\n'))} > "$fixture/retries.tsv"`,
      `printf '%s\n' ${quote(calls.get.join('\n'))} > "$fixture/gets.tsv"`,
      `printf '%s\n' ${quote(calls.kill.join('\n'))} > "$fixture/kills.tsv"`,
      ...records.filter(r => r.beforeB).map(r => `printf '%s\n' ${quote(`${r.end! - 0.001}\tfixture-round before B: nothing more this round`)} >> "$fixture/retries.tsv"`),
      'for ((i=0; i<10; i++)); do if call_timeout_recovery_started control t2; then echo "recovered $CT_RECOVERY_RETRY $CT_RECOVERY_AT"; exit 0; fi; done; fail "no recovery"',
    ].join('\n')
    return probe(completed, commands, options)
  }

  function retries(completed: number, recovery: number): RetryRecord[] {
    let due = completed
    return Array.from({ length: recovery }, (_, i) => {
      due += doublingBackoffDelay(input('OVR_RETRY_BASE_S'), i, input('OVR_RETRY_CEILING_S'))
      return { start: due, get: due + 0.01, ...(i + 1 === recovery ? { kill: due + 0.02 } : { end: due + 0.03 }) }
    })
  }

  test.each([30, 40.059])('actual retry audit accepts retry five at error +%s, rejects a one-retry delay still inside the global deadline', completed => {
    const positive = recoveryProbe(completed, retries(completed, 5))
    expect(positive.status).toBe(0)
    expect(positive.stdout).toContain('recovered 5')
    const delayed = retries(completed, 6)
    expect(delayed.at(-1)!.kill!).toBeLessThan(completed + 135 + input('LOG_WAIT_S') + input('LAUNCH_WAIT_S') + input('REPORT_WAIT_S'))
    const negative = recoveryProbe(completed, delayed)
    expect(negative.status).toBe(1)
    expect(negative.stderr).toContain('first eligible retry 5 ended without a CSCB checked kill')
  })

  test('AD launch start +1 moves B from +121 to +122 and eligibility from retry four to five', () => {
    const noOffset = probe(46, 'echo "$CT_ELIGIBLE_RETRY $CT_BOUND_AT"')
    const offset = probe(46, 'echo "$CT_ELIGIBLE_RETRY $CT_BOUND_AT"', { launchAt: 1 })
    expect(noOffset.stdout.trim()).toBe('4 121.000000')
    expect(offset.stdout.trim()).toBe('5 122.000000')
    expect(recoveryProbe(46, retries(46, 5), { launchAt: 1 }).status).toBe(0)
    const early = recoveryProbe(46, retries(46, 4), { launchAt: 1 })
    expect(early.status).toBe(1)
    expect(early.stderr).toContain('CSCB kill before B')
  })

  test.each(['read-crossing', 'return-crossing', 'before-B-answer'])('a retry beginning before B uses actual AD observations across B: %s', mode => {
    const records = retries(45.99, mode === 'before-B-answer' ? 5 : 4)
    records[3] = mode === 'before-B-answer'
      ? { start: 120.99, get: 120.995, end: 121.01, beforeB: true }
      : { start: 120.99, get: mode === 'read-crossing' ? 121.005 : 120.995, kill: 121.01 }
    const result = recoveryProbe(45.99, records)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`recovered ${mode === 'before-B-answer' ? 5 : 4}`)
  })

  test('a retry crossing B cannot silently defer recovery without a production before-B answer', () => {
    const records = retries(45.99, 5)
    records[3] = { start: 120.99, get: 120.995, end: 121.01 }
    const result = recoveryProbe(45.99, records)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('crossed B without recovery or a production before-B answer')
  })

  test.each(['pending', 'late-kill'])('an eligible retry has its own row-check phase bound: %s', mode => {
    const records = retries(40.059, 5)
    records[4] = { start: 175.059, get: 175.069, ...(mode === 'late-kill' ? { kill: 205.06 } : {}) }
    const result = recoveryProbe(40.059, records, { now: 205.06 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(mode === 'pending' ? 'retry 5 exceeded its bounded recovery phase' : 'retry 5 kill exceeded its bounded recovery phase')
  })

  test('the low leg additionally bounds the following retry that stops its timer', () => {
    const result = probe(30, 'first="$CT_DEADLINE"; call_timeout_observation_deadline 0 30 "$OVR_RETRY_CEILING_S"; seconds_between "$first" "$CT_DEADLINE"')
    expect(result.status).toBe(0)
    expect(Number(result.stdout)).toBe(input('OVR_RETRY_CEILING_S'))
  })

  test.each(['complete', 'early-kill', 'no-kill', 'wrong-instance', 'duplicate-kill', 'no-outcome', 'refused-outcome', 'outcome-after-launch', 'outcome-before-previous'])('a fresh launch requires an actual CSCB kill and successful checked outcome: %s', mode => {
    const marker = 'fixture-follows'
    const head = stuckLaunchAbortKillLine('fixture', {
      kind: STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, killSent: true,
      description: describeKillOutcome({ kind: KILL_OUTCOME_KILLED, killSent: true }),
    }, marker).split(marker)[0]!
    const commands = [
      'T_CALL=-107; CT_LAUNCH_AT=-106',
      `printf '%s\\n' ${quote(mode === 'no-kill' ? '' : `${mode === 'early-kill' ? 14.999 : 15}\tcscb_${mode === 'wrong-instance' ? 'other' : 'fixture'}${mode === 'duplicate-kill' ? '\n16\tcscb_fixture' : ''}`)} > "$fixture/calls.tsv"`,
      `printf '%s\\n' ${quote(mode === 'no-outcome' ? '' : `${mode === 'outcome-after-launch' ? 21 : mode === 'outcome-before-previous' ? 9 : 16}\t${mode === 'refused-outcome' ? 'refused checked kill' : head}sequence follows`)} > "$fixture/outcomes.tsv"`,
      // The real helper must ask for this persona's successful outcome.
      `printed() { [[ "$*" == 'stuckLaunchAbortKillSucceededHead fixture' ]] || exit 9; echo ${quote(head)}; }`,
      `cscb_calls_between() { [[ "$3 $4" == "kill --instance-id" ]] || exit 9; awk -F "\\t" -v a="$1" -v b="$2" -v id="$5" '$1 >= a && $1 < b && $2 == id { n++ } END { print n+0 }' "$fixture/calls.tsv"; }`,
      `count_log_from() { awk -F "\\t" -v a="$1" -v b="$2" -v head="$3" '$1 >= a && $1 < b && index($2, head) { n++ } END { print n+0 }' "$fixture/outcomes.tsv"; }`,
      'expect_checked_kill_before_launch control t2 10 20',
    ].join('\n')
    const result = probe(40.059, commands)
    expect(result.status).toBe(mode === 'complete' ? 0 : 1)
    if (mode === 'early-kill') expect(result.stderr).toContain('CSCB kill before B')
    else if (mode !== 'complete') expect(result.stderr).toContain(mode.includes('kill') || mode === 'wrong-instance' ? 'CSCB checked kill' : 'successful checked-kill outcome')
  })

})
