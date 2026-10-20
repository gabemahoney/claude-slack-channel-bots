/** The timeout recovery scenario awaits its exact AD get result before checking hooks. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

describe('test-26 waits for its exact asynchronous recovery-get result', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'tests/integration/test-26-fmk-timing-settings.sh'), 'utf8')
  const scenario = readFileSync(resolve(REPO_ROOT, 'tests/integration/lib/scenario.sh'), 'utf8')
  const declaration = (text: string, name: string) => text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
  const helper = declaration(source, 'expect_get_after_timeout_line')
  const leg = declaration(source, 'leg_call_timeout_high')
  const block = leg.slice(leg.indexOf('    expect_get_after_timeout_line'), leg.indexOf('\n    # No ErrCallTimeout'))
  // Execute the actual helper and actual high-leg call order. Dependencies
  // provide synthetic logs at controlled poll times; no scenario is sourced.
  function probe(kind: string, beforeFix = false) {
    const root = mkdtempSync('/tmp/timing-recovery-control-'), clock = join(root, 'clock')
    writeFileSync(clock, '0\n')
    const waitLine = helper.split('\n').find(line => line.includes('wait_until'))!
    const actualHelper = beforeFix ? helper.replace(waitLine, '') : helper
    const actualBlock = beforeFix ? block.replace(/^    expect_get_after_timeout_line.*\n/m, '')
      + '\nexpect_get_after_timeout_line "${step}" "${x}" ErrTmuxUnresponsive "${start_raw}"\n' : block
    const script = [
      'set -euo pipefail', 'declare -A REF=([t2]=synthetic_persona) ID=([t2]=synthetic_instance)',
      'SCENARIO_TAG=synthetic', 'PLAIN_SPAWN_WHAT=spawn', 'LOG_WAIT_S=30', 'SCENARIO_POLL_S=1',
      'T_CALL=1', 'step=synthetic', 'x=t2', 'start_raw=123',
      'clock="$1"', 'kind="$2"',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      '_scenario_now_ms() { cat "$clock"; }',
      'sleep() { local t; read -r t < "$clock"; printf "%s\\n" "$((t + 1000))" > "$clock"; }',
      'printed() { printf "%s\\n" "exact recovery-get pending 123 COVERED_NO_STARTUP_KEYS"; }',
      // Only the exact existing expected line can satisfy this dependency.
      'count_log() { local t; read -r t < "$clock"; if [[ "$1" == "exact recovery-get pending 123 COVERED_NO_STARTUP_KEYS" && "$kind" != missing-call && "$kind" != wrong-outcome ]] && { [[ "$kind" == complete || "$kind" == duplicate ]] || (( t >= 2000 )); }; then [[ "$kind" == duplicate ]] && echo 2 || echo 1; else echo 0; fi; }',
      'log_lines() { :; }',
      'first_cscb_call_at_or_after() { local t; read -r t < "$clock"; if [[ "$kind" != missing-call ]] && { [[ "$kind" != delayed-call ]] || (( t >= 1000 )); }; then echo matching-get; fi; }',
      'call_fields() { [[ "$2" == matching-get ]] || fail wrong-call; CALL_T=2; }',
      'hooks_brought_up() { echo hooks-verified; }',
      declaration(scenario, '_scenario_poll_until'), declaration(scenario, '_scenario_check_timeout'),
      declaration(scenario, 'wait_until'), declaration(scenario, '_scenario_log_has'), actualHelper, actualBlock,
      'printf "elapsed-ms=%s\\n" "$(cat "$clock")"',
    ].join('\n')
    try {
      const result = spawnSync('bash', ['-c', script, 'synthetic-recovery', clock, kind], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'cat', 'cut', 'sed'] }), encoding: 'utf8', timeout: 10000,
      })
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
      assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, clock: Number(readFileSync(clock, 'utf8')) }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  test.each(['delayed-call', 'delayed-result'])('%s fails the old immediate assertion and passes the exact-result barrier', kind => {
    const old = probe(kind, true), current = probe(kind)
    expect(old.status).toBe(1); expect(current.status).toBe(0)
    expect(current.stdout).toContain('hooks-verified'); expect(current.clock).toBe(2000)
  })
  test('already completed recovery passes without waiting', () => {
    for (const old of [true, false]) {
      const result = probe('complete', old)
      expect(result.status).toBe(0); expect(result.clock).toBe(0)
    }
  })
  test.each(['missing-call', 'wrong-outcome', 'duplicate'])('%s still fails the same exact count/outcome oracle', kind => {
    expect(probe(kind, true).status).toBe(1)
    const current = probe(kind)
    expect(current.status).toBe(1)
    expect(current.clock).toBe(kind === 'duplicate' ? 0 : 30000)
    expect(current.stdout).not.toContain('hooks-verified')
  })
})
