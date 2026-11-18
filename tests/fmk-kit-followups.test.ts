/** Execute the harness assertions with synthetic observations; no real AD or tmux. */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  conflictLatchSetLine, latchRowStateRead, LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_LEFTOVER, REFUSED_OPERATION_NONE,
} from '../src/conflict-latch.ts'

const integration = join(import.meta.dir, 'integration')
const scenario = readFileSync(join(integration, 'lib/scenario.sh'), 'utf8')
const declaration = (source: string, name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

function run(script: string) {
  const root = mkdtempSync('/tmp/fmk-kit-followups-')
  try {
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'SCENARIO_ROOT="$1"',
      'fail() { echo "$*" >&2; exit 1; }',
      script,
    ].join('\n'), 'fmk-kit-followups', root], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'mkdir', 'cp', 'awk', 'sed', 'date', 'cut', 'tail', 'grep', 'head'] }), encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test.each([
  { release: '0.18.0', count: 1, status: 0 },
  { release: '0.17.4', count: 2, status: 0 },
  { release: '0.18.0', count: 2, status: 1 },
  { release: '0.17.4', count: 1, status: 1 },
])('stub stop-line total on $release is version-specific ($count)', ({ release, count, status }) => {
  const source = readFileSync(join(integration, 'test-0-fmk-harness-self-check.sh'), 'utf8')
  const result = run([
    `ad_release_at_least() { [[ '${release}' == 0.18.0 ]]; }`,
    'SCENARIO_AD_SHIM_LOG="$SCENARIO_ROOT/ad.log"',
    'SCENARIO_TMUX_SHIM_LOG="$SCENARIO_ROOT/tmux.log"',
    'REFIRE_AD_BEFORE=0 REFIRE_CSCB_BEFORE=0',
    `for (( i=0; i<${count}; i++ )); do printf 'stop\\t1.000000\\t100\\t99\\tparent\\tstop\\n'; done > "$SCENARIO_AD_SHIM_LOG"`,
    'line_count() { echo 1; }',
    'window_copy() { mkdir -p "$1"; cp "$SCENARIO_AD_SHIM_LOG" "$1/agent-director-shim.log"; }',
    'on_files() { [[ "$2" != cscb_ad_count ]] || echo 0; }',
    'cscb_ad_count() { echo 0; }',
    'expect_on_files() { :; }',
    ...['_scenario_to_us', '_scenario_split_line'].map(name => declaration(scenario, name)),
    declaration(source, 'leg_stub_lines_not_cscb'),
    'leg_stub_lines_not_cscb',
  ].join('\n'))
  expect(result.status).toBe(status)
})

test.each(['latched', 'relatched', 'leftover', 'other-persona'] as const)('test 23 launch-start guard detects %s using real latch lines', kind => {
  const source = readFileSync(join(integration, 'test-23-fmk-latch-recheck.sh'), 'utf8')
  const key = 'nostart'
  const record = {
    sessionName: `slack_bot_${key}`, latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
    refusedOperation: REFUSED_OPERATION_NONE, rowState: latchRowStateRead('pending'),
  } as const
  const latched = conflictLatchSetLine(key, record)
  const relatched = conflictLatchSetLine(key, record, LATCH_CASE_LEFTOVER)
  const line = kind === 'latched' ? latched : kind === 'relatched' ? relatched
    : kind === 'leftover' ? conflictLatchSetLine(key, { ...record, latchCase: LATCH_CASE_LEFTOVER })
    : conflictLatchSetLine('someone_else', record)
  assertNoLeak({ line, latched, relatched })
  const result = run([
    'TEST_NAME=fixture SLACK_STATE_DIR="$SCENARIO_ROOT"',
    `NS_KEY=${key} CASE_LAUNCH_START=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}`,
    `declare -A PERSONA_ID=([${key}]=cscb_${key}) PERSONA_CHANNEL=([${key}]=channel) POSTS_BEFORE=([${key}]=0)`,
    'LATCH_LIFE_MS=1 LATCH_LIFE_MARK=0 LAUNCH_START_HEAD=notice SCENARIO_SEP=$\'\\034\'',
    `HEAD_LATCHED=${quote(latched.slice(0, latched.indexOf('case=') + 5))}`,
    `HEAD_RELATCHED=${quote(relatched.slice(0, relatched.indexOf('case=') + 5))}`,
    `printf '%s\\n' ${quote(line)} > "$SLACK_STATE_DIR/server.log"`,
    `ad_missing_tick() { printf '%s\\n' '{"source":"ad_recovery"}'; }`,
    `ad_mark_caller() { printf '1\\t1.000000\\t42\\tget\\tcscb\\n'; }`,
    'fmk_text() { [[ "$1" == conflictLatchSetLineHead ]] || exit 1; if [[ "$3" == latched ]]; then echo "$HEAD_LATCHED"; else echo "$HEAD_RELATCHED"; fi; }',
    'latch_lines_of() { :; }',
    'posts_holding() { HOLDING=(); }',
    ...['matcher', '_scenario_scan', 'count_log'].map(name => declaration(scenario, name)),
    declaration(source, 'check_launch_start_marked'),
    'check_launch_start_marked',
  ].join('\n'))
  if (kind === 'latched' || kind === 'relatched') {
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${key} ${kind} on a missing launch start`)
  } else {
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  }
})

type SweepGetFault = 'none' | 'missing' | 'duplicate' | 'before-list' | 'position-before-list' | 'wrong-parent' | 'wrong-id' | 'at-list' | 'at-latch' | 'only-after-latch' | 'other-call-before-latch'

/** Execute only the real ordering assertion over synthetic shim rows; no scenario/AD/tmux execution. */
function sweepLatchOrdering(key: 'labelnote' | 'nostart', fault: SweepGetFault) {
  const source = readFileSync(join(integration, 'test-23-fmk-latch-recheck.sh'), 'utf8')
  const id = `cscb_${key}`
  const row = (pos: number, time: string, parent = 42, verb = 'get', args = `--instance-id ${id}`) => [pos, time, parent, verb, id, args].join('\t')
  const early = row(fault === 'before-list' || fault === 'position-before-list' ? 9 : 11,
    fault === 'before-list' ? '1.900000' : fault === 'at-list' ? '2.000000' : fault === 'at-latch' ? '3.000000' : '2.500000',
    fault === 'wrong-parent' ? 99 : 42, 'get', `--instance-id ${fault === 'wrong-id' ? `${id}_other` : id}`)
  const rows = [
    ...(['missing', 'only-after-latch'].includes(fault) ? [] : [early]),
    ...(fault === 'duplicate' ? [row(12, '2.600000')] : []),
    ...(fault === 'other-call-before-latch' ? [row(12, '2.700000', 42, 'send-keys')] : []),
    ...(fault === 'missing' ? [] : [row(13, '3.500000')]),
  ].join('\n')
  return run([
    'TEST_NAME=fixture SLACK_STATE_DIR="$SCENARIO_ROOT" LATCH_PID=42 LATCH_LIFE_MARK=0',
    `CASE_LAUNCH_START=${quote(LATCH_CASE_LAUNCH_START_NOT_RECORDED)}`,
    `declare -A PERSONA_ID=([${key}]=${id}) CASE_OF=([${key}]=${key === 'nostart' ? quote(LATCH_CASE_LAUNCH_START_NOT_RECORDED) : 'conflicting-labels'})`,
    `declare -A SESSION_OF=([${key}]=session) OP_OF=([${key}]=none) LATCH_ROW_OF=([${key}]=pending) LATCH_MARK=([${key}]=20) LATCH_US=() PERSONA_NAME=([${key}]=${key})`,
    'printf "%s\\n" SET-LATCH > "$SLACK_STATE_DIR/server.log"',
    'fmk_text() { printf "%s\\n" SET-LATCH; }',
    'log_line_us() { echo 3000000; }',
    `ad_cscb_verb_between() { printf '%s\\n' ${quote('10\t2.000000\t42\tlist\t-\t--label service=cscb')}; }`,
    '_scenario_store_read() { printf ""; }',
    ...['us_of', 'secs_of', 'check_sweep_latch'].map(name => declaration(source, name)),
    `check_sweep_latch fixture ${key} ${quote(rows)}`,
    `echo "anchor=\${LATCH_US[${key}]}"`,
  ].join('\n'))
}

test.each(['labelnote', 'nostart'] as const)('test 23 %s sweep latch requires one Full Row get and retains the list timer', key => {
  const result = sweepLatchOrdering(key, 'none')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('accepted Full Row get')
  expect(result.stdout).toContain('shim line 11 (2.500), parent 42')
  expect(result.stdout).toContain('anchor=2000000')
})

const SWEEP_GET_FAULTS: ReadonlyArray<readonly [SweepGetFault, string]> = [
  ['missing', 'no bot-server Full Row get'],
  ['duplicate', 'more than one CSCB get'],
  ['before-list', 'not strictly after its sweep list'],
  ['position-before-list', 'not strictly after its sweep list'],
  ['wrong-parent', "not the bot server's one Full Row get"],
  ['wrong-id', "not the bot server's one Full Row get"],
  ['at-list', 'not strictly after its sweep list'],
  ['at-latch', 'not strictly after its sweep list'],
  ['only-after-latch', 'no bot-server Full Row get'],
  ['other-call-before-latch', "not the bot server's one Full Row get"],
]

test.each((['labelnote', 'nostart'] as const).flatMap(key => SWEEP_GET_FAULTS.map(([fault, reason]) => [key, fault, reason] as const)))('test 23 %s sweep latch rejects %s', (key, fault, reason) => {
  const result = sweepLatchOrdering(key, fault)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(reason)
})

test.each(['0.18.0', '0.17.4'])('test 19 leg G reads its pending launch without contaminating attribution on %s', release => {
  const source = readFileSync(join(integration, 'test-19-fmk-reuse.sh'), 'utf8')
  const leg = declaration(source, 't19_leg_missing_row')
  const reads = leg.slice(leg.indexOf('    wait_until "${ROW_WAIT_S}"'), leg.indexOf('    launch_s='))
  const row = JSON.stringify({ state: 'pending', launch_started_at: '2026-11-10T23:00:00.000Z' })
  const result = run([
    `ad_release_at_least() { [[ '${release}' == 0.18.0 ]]; }`,
    'AD_OUT="$SCENARIO_ROOT/read.json" AD_RC=0 ROW_WAIT_S=1 id=fixture step=fixture',
    `ad_store_peek() { printf '%s\\n' ${quote(row)}; }`,
    `ad_capture() { printf '%s\\n' "$1" >> "$SCENARIO_ROOT/calls"; printf '%s\\n' ${quote(row)} > "$AD_OUT"; }`,
    'wait_until() { shift 2; "$@"; }',
    ...['t19_row_state', 't19_row_is', 't19_row_get', 't19_row_pending_launched'].map(name => declaration(source, name)),
    reads,
    't19_row_is "$id" pending',
    '[[ "$launch_start" == 2026-11-10T23:00:00.000Z ]] || fail "lost launch timestamp"',
    release === '0.18.0' ? '[[ ! -s "$SCENARIO_ROOT/calls" ]] || fail "active harness read contaminated attribution"'
      : '[[ -s "$SCENARIO_ROOT/calls" ]] || fail "legacy reads changed"',
  ].join('\n'))
  expect(result.status).toBe(0)
})

test('test 19 mark window retains epoch milliseconds under mawk', () => {
  const source = readFileSync(join(integration, 'test-19-fmk-reuse.sh'), 'utf8')
  const tickRead = source.split('\n').find(line => line.includes('tick="$(ad_missing_tick'))!.trim().replace(/\\$/, '')
  const result = run([
    'id=fixture MARK_TIME=1794351500.0001',
    `ad_missing_tick() { [[ "$2" == 1794351500000 ]] || fail "wrong epoch bound: $2"; echo '{}'; }`,
    tickRead,
  ].join('\n'))
  expect(result.status).toBe(0)
})

test.each([
  { kind: 'direct-status', error: '' },
  { kind: 'rule', error: '' },
  { kind: 'late-rule', error: "pending-row rule's missing line came after" },
  { kind: 'missing-get', error: 'no bot-server get' },
  { kind: 'harness-mark', error: "not the bot server's" },
  { kind: 'late-mark', error: "not from G" },
  { kind: 'early-mark', error: "not from G" },
])('test 17 scenario 11 accepts authoritative read recovery: $kind', ({ kind, error }) => {
  const source = readFileSync(join(integration, 'test-17-fmk-launch-pending.sh'), 'utf8')
  const leg = declaration(source, 'leg_fail_create')
  const start = leg.indexOf('        fc_marked_by_server "${step}"')
  const block = leg.slice(start, leg.indexOf('\n    else', start))
  const launch = 1794351500, next = launch + 90.064
  const mark = kind === 'late-mark' ? next + 1 : kind === 'early-mark' ? launch + 59 : launch + 90.05
  const ruleAt = kind === 'late-rule' ? next + 1 : next - 0.002
  const tick = JSON.stringify({ instance_id: 'row', source: 'ad_recovery', ts: new Date(mark * 1000).toISOString() })
  const hasRule = ['rule', 'late-rule', 'missing-get'].includes(kind)
  const result = run([
    'step=fixture TEST_NAME=fixture F_ID=row G_S=60 FC_POLL_S=1 F_REF=persona PENDING_ROW_HEAD=rule',
    `l_ms=${launch * 1000} l_s=${launch} g_at=${launch + 60} next_at=${next} spawn0=${launch}`,
    'srv=42 mark0=0 first_missing="" table=fixture log0=0',
    `ad_missing_tick() { printf '%s\\n' ${quote(tick)}; }`,
    `ad_mark_caller() { printf '290\\t${mark.toFixed(6)}\\t${kind === 'harness-mark' ? 99 : 42}\\tstatus\\t${kind === 'harness-mark' ? 'other' : 'cscb'}\\n'; }`,
    'calls() { :; }', // The observed direct-read path has no find-missing.
    `first_call_at() { ${kind === 'missing-get' ? ':' : `echo ${mark + 0.001}`}; }`,
    `log_hits() { ${hasRule ? `printf '1\\t${ruleAt}\\tget: missing\\n'` : ':'}; }`,
    declaration(source, 'seconds_between'),
    declaration(source, 'fc_marked_by_server'),
    block,
  ].join('\n'))
  if (error) {
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
  } else {
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("by the bot server's status")
  }
})

test.each(['14-fmk-kill-fails', '21-fmk-teardown'])('test-%s passive pending read publishes its launch timestamp', name => {
  const source = readFileSync(join(integration, `test-${name}.sh`), 'utf8')
  const helper = `t${name.slice(0, 2)}_row_pending_launched`
  const result = run([
    'ad_release_at_least() { return 0; }',
    'AD_OUT="$SCENARIO_ROOT/stale.json"',
    `printf '%s\\n' '{"state":"pending","launch_started_at":"stale"}' > "$AD_OUT"`,
    `ad_store_peek() { printf '%s\\n' '{"state":"pending","launch_started_at":"2026-11-10T23:00:00.000Z"}'; }`,
    'ad_capture() { fail "a passive read called AD"; }',
    declaration(source, helper),
    `${helper} fixture`,
    `jq -e '.launch_started_at == "2026-11-10T23:00:00.000Z"' "$AD_OUT" > /dev/null`,
  ].join('\n'))
  expect(result.status).toBe(0)
})

test.each([
  { verb: 'status', parent: 42, role: 'cscb', status: 0 },
  { verb: 'get', parent: 42, role: 'cscb', status: 0 },
  { verb: 'list', parent: 42, role: 'cscb', status: 0 },
  { verb: 'find-missing', parent: 42, role: 'cscb', status: 0 },
  { verb: 'get', parent: 99, role: 'other', status: 1 },
  { verb: 'get', parent: 43, role: 'cscb', status: 1 },
  { verb: 'ambiguous', parent: 42, role: 'cscb', status: 1 },
])('pending-persona mark requires this server: $verb parent=$parent role=$role', ({ verb, parent, role, status }) => {
  const source = readFileSync(join(integration, 'test-21-fmk-teardown.sh'), 'utf8')
  const result = run([
    'D_ID=row SERVER_PID=42 TEST_NAME=fixture',
    `ad_missing_tick() {
      [[ "$1" == row && "$2" == 1794351500000 ]] || fail 'wrong tick window or id'
      printf '%s\\n' '{"instance_id":"row","prior_state":"pending","new_state":"missing"}'
    }`,
    `ad_mark_caller() {
      [[ "$2" == 7 ]] || fail 'wrong shim window'
      ${verb === 'ambiguous' ? 'return 1' : `printf '8\\t1.100000\\t${parent}\\t${verb}\\t${role}\\n'`}
    }`,
    declaration(source, 't21_check_missing_mark'),
    't21_check_missing_mark fixture 1794351500.0001 7',
  ].join('\n'))
  expect(result.status).toBe(status)
})
