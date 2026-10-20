/** The timeout recovery scenario awaits its exact AD get result before checking hooks. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { thisLaunchRowLiveLine } from '../src/session-manager.ts'
import { TMUX_UNRESPONSIVE_END_TEXT, tmuxUnresponsiveEndedLine, TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE } from '../src/persona-episodes.ts'
import { unavailableRetryRetryLine } from '../src/unavailable-retry.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

describe('test-17 ends launch-timeout recovery on its own first retry read', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'tests/integration/test-17-fmk-launch-pending.sh'), 'utf8')
  const declaration = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
  const key = 't17_spawn', id = `cscb_${key}`, server = '42001'
  const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  // Actual full and isolated CI clock shapes: the harness observes waiting
  // before the 30-second retry, which then ends the condition synchronously.
  const runs = [
    { label: 'full', harness: 1792496132.408312, retry: 1792496139.143, read: 1792496139.145602, end: 1792496139.151, get: 1792496139.153146 },
    { label: 'confirmation', harness: 1792499794.527237, retry: 1792499801.255, read: 1792499801.259309, end: 1792499801.265, get: 1792499801.267546 },
  ]
  function probe(kind = 'complete', run = runs[1]!) {
    const root = mkdtempSync('/tmp/pending-retry-control-')
    const stamp = (at: number, text: string) => `[${new Date(at * 1000).toISOString()}] ${text}`
    let readServer = server, readId = id, endKey = key, waitingKey = key
    let end = run.end, waiting = run.end, retry = run.retry
    if (kind === 'wrong-server') readServer = '42002'
    if (kind === 'wrong-persona-read') readId += '_other'
    if (kind === 'wrong-persona-end') endKey += '_other'
    if (kind === 'wrong-persona-waiting') waitingKey += '_other'
    if (kind === 'late-end' || kind === 'late-both') end = run.read + 6.738
    if (kind === 'late-waiting' || kind === 'late-both') waiting = run.read + 6.738
    if (kind === 'already-ended') end = run.retry - 1
    if (kind === 'wrong-retry') retry = run.retry - 10
    if (kind === 'late-read') retry = run.read - 6.738
    const verb = kind === 'get-recovery' ? 'get' : 'status'
    // The five columns are call_table's real CI projection: timestamp,
    // CSCB PPID, AD verb, instance ID and decoded argument list.
    const row = (at: number, ppid: string, instance: string, v: string) => `${at}\t${ppid}\t${v}\t${instance}\t--instance-id ${instance}`
    const calls = [
      row(run.retry - 30, server, id, 'get'), // A pending get in an earlier retry is not the waiting observation.
      row(run.harness, '42099', id, 'get'), // A harness read never satisfies the CSCB oracle.
      ...(kind === 'harness-only' ? [] : [row(run.read, readServer, readId, verb), row(run.get, readServer, readId, 'get')]),
      ...(kind === 'late-both' ? [row(run.read + 6.7, server, id, verb)] : []),
    ]
    const logs = [
      ...(kind === 'earlier-pending-retry' ? [stamp(run.retry - 30.01, unavailableRetryRetryLine(key, 1, true))] : []),
      ...(kind === 'missing-retry' ? [] : [stamp(retry, unavailableRetryRetryLine(kind === 'wrong-persona-retry' ? `${key}_other` : key, 1, false))]),
      // A re-arm starts the same way but is not the start of another retry.
      stamp(run.read, `${unavailableRetryRetryLine(key, 1, false)}: re-armed`),
      ...(kind === 'next-retry' ? [stamp(run.end - 0.001, unavailableRetryRetryLine(key, 2, false))] : []),
      ...(kind === 'missing-end' ? [] : [stamp(end, tmuxUnresponsiveEndedLine(endKey, TMUX_UNRESPONSIVE_END_LAUNCH_ROW_LIVE))]),
      ...(kind === 'missing-waiting' ? [] : [stamp(waiting, thisLaunchRowLiveLine({ site: 'isSessionAlive', what: kind === 'wrong-read-verb' ? 'get' : verb }, `persona=${waitingKey}`, 'waiting', true))]),
    ]
    writeFileSync(join(root, 'calls.tsv'), calls.sort((a, b) => Number(a.split('\t')[0]) - Number(b.split('\t')[0])).join('\n') + '\n')
    writeFileSync(join(root, 'server.log'), logs.sort().join('\n') + '\n')
    writeFileSync(join(root, 'ended.txt'), Object.keys(TMUX_UNRESPONSIVE_END_TEXT).map(reason => tmuxUnresponsiveEndedLine(key, reason)).join('\n') + '\n')
    const full = unavailableRetryRetryLine(key, 1, false).match(/^(.*retry )1(.*)$/)!
    const pending = unavailableRetryRetryLine(key, 1, true).match(/^(.*retry )1(.*)$/)!
    const bound = source.match(/^LT_RETRY_READ_S=(\d+)/m)![1]!
    const script = [
      'set -euo pipefail', 'fixture_root="$1"', 'SLACK_STATE_DIR="$fixture_root"', `LT_RETRY_READ_S=${bound}`,
      `declare -A RT_RETRY_HEAD=([${key}]=${shellQuote(full[1]!)} )`,
      `declare -A RT_RETRY_FULL=([${key}]=${shellQuote(full[2]!)} )`,
      `declare -A RT_RETRY_PENDING=([${key}]=${shellQuote(pending[2]!)} )`,
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'fmk_text() { cat "$fixture_root/ended.txt"; }',
      ...['calls', 'retry_hits', 'log_hits', 'lt_expect_recovery_ended'].map(declaration),
      `lt_expect_recovery_ended "$fixture_root/calls.tsv" ${server} ${id} ${key} 0 control`,
    ].join('\n')
    try {
      const result = spawnSync('bash', ['-c', script, 'pending-retry-control', root], {
        env: hostSafeChildEnv(root, { tools: ['bash', 'awk', 'python3', 'grep', 'head', 'cut', 'cat'] }), encoding: 'utf8', timeout: 10000,
      })
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
      assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
      return result
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  test.each(runs)('$label CI recovery passes despite the harness observing waiting earlier', run => {
    expect(run.end - run.harness).toBeGreaterThan(6.7)
    expect(probe('complete', run).status).toBe(0)
  })
  test.each([
    { label: 'with a later owned get', harness: runs[1]!.end + 0.001 },
    { label: 'with no later owned read', harness: runs[1]!.end + 0.1 },
  ])('CSCB observes waiting before the harness, $label', ({ harness }) => {
    const run = { ...runs[1]!, harness }
    expect(run.end).toBeLessThan(run.harness)
    expect(probe('complete', run).status).toBe(0)
  })
  test('an earlier retry that still read pending does not become the recovery anchor', () => {
    expect(probe('earlier-pending-retry').status).toBe(0)
  })
  test('get recovery uses the same ownership and deadline checks', () => {
    expect(probe('get-recovery').status).toBe(0)
  })
  test.each(['missing-end', 'missing-waiting', 'missing-retry', 'late-end', 'late-waiting', 'late-both', 'late-read', 'harness-only', 'wrong-server', 'wrong-persona-read', 'wrong-persona-end', 'wrong-persona-waiting', 'wrong-persona-retry', 'wrong-read-verb', 'already-ended', 'wrong-retry', 'next-retry'])('%s cannot satisfy the first recovery-read oracle', kind => {
    expect(probe(kind).status).toBe(1)
  })
})

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
      'recovery_awaited=0',
      'await_call_timeout_recovery() { [[ "$1 $2" == "synthetic t2" ]] || fail wrong-recovery; recovery_awaited=1; }',
      'hooks_brought_up() { [[ "$recovery_awaited" == 1 ]] || fail recovery-not-awaited; echo hooks-verified; }',
      'declare -A WORK=([t2]=synthetic_work)',
      'tmux_shim_mode() { [[ "$1" == log ]] || fail wrong-mode; echo fixture-released; }',
      'stub_report_delay() { [[ "$1 $2" == "synthetic_work 0" ]] || fail wrong-delay; }',
      declaration(scenario, '_scenario_poll_until'), declaration(scenario, '_scenario_check_timeout'),
      declaration(scenario, 'wait_until'), declaration(scenario, '_scenario_log_has'), actualHelper,
      declaration(source, 'release_timed_out_launch_fixture'), actualBlock,
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
    expect(current.stdout).toContain('fixture-released')
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
    expect(current.stdout).not.toContain('fixture-released')
  })
})
