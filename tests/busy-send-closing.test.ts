/** Extracted closing assertions and cleanup with synthetic recording stand-ins;
 * never the full integration shims, real AD, tmux or the integration driver. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const entry = readFileSync(join(import.meta.dir, 'integration/test-68-fmk-busy-send.sh'), 'utf8')
function declaration(source: string, name: string) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  expect(match).not.toBeNull()
  return match![0]
}
function closing(options: { before?: string; after?: string; old?: boolean; omit?: boolean; subshell?: boolean;
  covered?: boolean; noTmux?: boolean; killFails?: boolean } = {}) {
  const root = mkdtempSync('/tmp/busy-send-closing-')
  const selection = (options.old ? scenario : entry).match(/^SCENARIO_CLOSING_ASSERTIONS=\(.*\)$/m)![0]
  let tail = entry.slice(entry.lastIndexOf(options.covered ? '\nrm -f "${control}"' : '\nassert_no_server_tmux') + 1)
  if (options.old) tail = tail.replace(/^assert_busy_send_no_finished$/m, 'assert_no_cscb_include_finished')
  const names = ['fail', '_scenario_add', '_scenario_to_us', '_scenario_record_load', '_scenario_role_at', '_scenario_query_prep',
    '_scenario_split_line', '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_finished_kill_words',
    '_scenario_shim_diagnostic', '_scenario_read_log', '_scenario_offending', '_scenario_closing_ran', '_scenario_closing_passed',
    '_scenario_closing_check', '_scenario_closing_recheck', 'assert_no_server_tmux', 'assert_no_cscb_include_finished', 'assert_no_cscb_delete',
    '_scenario_proc_starttime', '_scenario_record_append', '_scenario_record_proc', '_scenario_cscb_exec', 'cscb_run']
  try {
    writeFileSync(join(root, 'agent-director-shim.log'), [
      'call\t1.000000\t100\t90\t/usr/bin/bun /tests/integration/fixtures/busy-send-driver.ts root own cwd fallback\tget --instance-id own',
      'call\t2.000000\t101\t90\t/usr/bin/bun /tests/integration/fixtures/busy-send-driver.ts root own cwd fallback\tsend-keys --instance-id own --key Enter',
    ].join('\n') + '\n')
    writeFileSync(join(root, 'tmux-shim.log'), options.covered ? '' : 'call\t2.001000\t110\t101\t/scratch/agent-director.real send-keys\tsend-keys\n')
    writeFileSync(join(root, 'record'), 'proc\tcli\t90\t1\t0.000000\n')
    writeFileSync(join(root, 'control'), 'synthetic custody enabled\n')
    // This inert stand-in records the actual cleanup caller's PID and emits
    // synthetic AD/tmux log facts. It runs no other executable. Full logging
    // shims and the native AD -> tmux chain belong to the container rerun.
    writeFileSync(join(root, 'recording-ad'), [
      '#!/bin/bash', 'root="${0%/*}"',
      '[[ "$*" == "kill --instance-id fixture" && ! -e "${root}/control" ]] || exit 65',
      'printf -v words "%q " "$@"',
      'printf "call\\t%s\\t%s\\t%s\\tfixture-kill\\t%s\\n" "$EPOCHREALTIME" "$$" "$PPID" "$words" >> "${root}/agent-director-shim.log"',
      options.killFails ? 'exit 1' : options.noTmux ? ':' :
        'printf "call\\t%s\\t300\\t%s\\t/synthetic/agent-director.real kill\\tkill-session -t fixture\\n" "$EPOCHREALTIME" "$$" >> "${root}/tmux-shim.log"',
    ].join('\n') + '\n', { mode: 0o755 })
    const script = [
      'set -euo pipefail', 'TEST_NAME=test-68-fmk-busy-send', names.map(name => declaration(scenario, name)).join('\n'),
      declaration(entry, 'assert_busy_send_no_finished'), selection,
      'SCENARIO_FMK=1', '_SCENARIO_START_COUNT=0', '_SCENARIO_CLOSED=()', 'SCENARIO_SHELL_CMDLINE=synthetic-shell',
      'SCENARIO_AD_SHIM_LOG="$1/agent-director-shim.log"', 'SCENARIO_TMUX_SHIM_LOG="$1/tmux-shim.log"', 'SCENARIO_CSCB_RECORD="$1/record"',
      '_SCENARIO_REAL_AD_SHIM_LOG="$SCENARIO_AD_SHIM_LOG"', '_SCENARIO_REAL_TMUX_SHIM_LOG="$SCENARIO_TMUX_SHIM_LOG"',
      '_SCENARIO_REAL_CSCB_RECORD="$SCENARIO_CSCB_RECORD"', '_scenario_cscb_after() { :; }',
      'SCENARIO_TMUX_SHIM_BIN="$1/unused-tmux-bin"', 'SCENARIO_AD_BIN="$1/recording-ad"',
      'control="$1/control"', 'instance=fixture',
      // Old harness cleanup never put tmux on the CSCB log's PATH.
      'ad_capture() { AD_RC=0; }',
      // Match cleanup's set +e and status propagation, without its process work.
      'trap \'rc=$?; set +e; _scenario_closing_check "$rc" || rc=1; exit "$rc"\' EXIT', options.before ?? '',
      options.omit ? ':' : options.subshell ? `( ${tail} )` : tail,
      options.after ?? '',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script, 'synthetic-closure', root], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'grep', 'sed', 'rm', 'flock'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('pre-repair test-68 closure fails its impossible server positive control', () => {
  const result = closing({ old: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('assert_no_cscb_include_finished: positive control:')
  expect(result.stderr).toContain('no call CSCB made')
})
test('test-68 closes and passes the EXIT recheck using packed-driver evidence without a server', () => {
  expect(closing()).toEqual({ status: 0, stdout: 'PASS: test-68-fmk-busy-send\n', stderr: '' })
})
test('covered runtime closes through the entry-script fixture-kill command without legacy tmux evidence', () => {
  expect(closing({ covered: true })).toEqual({ status: 0, stdout: 'PASS: test-68-fmk-busy-send\n', stderr: '' })
})
test('covered cleanup still fails the positive control when AD makes no tmux call', () => {
  const result = closing({ covered: true, noTmux: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('assert_no_server_tmux: positive control:')
})
test('fixture-kill failure prevents successful closure', () => {
  const result = closing({ covered: true, killFails: true })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('fixture kill failed')
})
test('covered cleanup positive evidence does not excuse a direct bot-server tmux call', () => {
  const result = closing({ covered: true, before: [
    'printf "proc\\tserver\\t200\\t1\\t0.000000\\n" >> "$SCENARIO_CSCB_RECORD"',
    'printf "call\\t3.000000\\t111\\t200\\t/usr/bin/bun server.ts\\tdisplay-message\\n" >> "$SCENARIO_TMUX_SHIM_LOG"',
  ].join('\n') })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('have a bot server the scenario started as their parent')
})
test.each([
  ['empty AD log', ': > "$SCENARIO_AD_SHIM_LOG"'], ['empty tmux log', ': > "$SCENARIO_TMUX_SHIM_LOG"'],
  ['missing get', 'sed -i "/get --instance-id/d" "$SCENARIO_AD_SHIM_LOG"'],
  ['missing send', 'sed -i /send-keys/d "$SCENARIO_AD_SHIM_LOG"'],
  ['wrong driver', 'sed -i s/busy-send-driver/other-driver/g "$SCENARIO_AD_SHIM_LOG"'],
  ['started server', '_SCENARIO_START_COUNT=1'],
  ['direct tmux', 'sed -i s/agent-director.real/bun/ "$SCENARIO_TMUX_SHIM_LOG"'],
  ['malformed log', 'echo invalid >> "$SCENARIO_AD_SHIM_LOG"'],
  ...['kill-finished', 'kill --include-finished', 'kill --include-finished=true', 'delete'].map(verb =>
    [verb, `printf 'call\\t3.000000\\t102\\t90\\t/usr/bin/bun /tests/integration/fixtures/busy-send-driver.ts\\t${verb}\\n' >> "$SCENARIO_AD_SHIM_LOG"`]),
])('%s prevents successful closure', (_label, before) => {
  const result = closing({ before })
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('FAIL:')
})
test.each(['omit', 'subshell'] as const)('%s does not satisfy own-shell closing enforcement', mode => {
  const result = closing({ [mode]: true })
  expect(result.status).toBe(1); expect(result.stderr).toContain('without the closing assertions')
})
test('late forbidden input is detected by the EXIT recheck after PASS', () => {
  const result = closing({ after: 'printf "call\\t3.000000\\t102\\t90\\tsynthetic-shell\\tkill-finished\\n" >> "$SCENARIO_AD_SHIM_LOG"' })
  expect(result.status).toBe(1); expect(result.stdout).toContain('PASS:')
  expect(result.stderr).toContain('after the closing assertions:')
})
