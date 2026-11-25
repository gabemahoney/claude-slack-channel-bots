/** Execute the harness assertions with synthetic observations; no real AD or tmux. */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import {
  conflictLatchSetLine, latchRowStateRead, LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_LEFTOVER, REFUSED_OPERATION_NONE, LATCH_CASE_ANOTHER_STORE, REFUSED_OPERATION_RESUME,
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
    `ad_mark_caller() { printf '1\\t1.000000\\t42\\tget\\tcscb\\n2\\t1.000500\\t43\\tstatus\\tcscb\\n'; }`,
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

type SweepGetFault = 'none' | 'missing' | 'duplicate' | 'before-list' | 'position-before-list' | 'wrong-parent' | 'wrong-id' | 'at-list' | 'at-latch' | 'only-after-latch' | 'other-call-before-latch' | 'list-after-latch'

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
    'INTERVAL_US=45000000 INTERVAL_S=45 SETTLE_S=30',
    `CASE_LAUNCH_START=${quote(LATCH_CASE_LAUNCH_START_NOT_RECORDED)}`,
    `declare -A PERSONA_ID=([${key}]=${id}) CASE_OF=([${key}]=${key === 'nostart' ? quote(LATCH_CASE_LAUNCH_START_NOT_RECORDED) : 'conflicting-labels'})`,
    `declare -A SESSION_OF=([${key}]=session) OP_OF=([${key}]=none) LATCH_ROW_OF=([${key}]=pending) LATCH_MARK=([${key}]=20) LATCH_US=() PERSONA_NAME=([${key}]=${key})`,
    `declare -A LATCH_SET_US=([${key}]=${fault === 'list-after-latch' ? 1900000 : 3000000})`,
    'printf "%s\\n" SET-LATCH > "$SLACK_STATE_DIR/server.log"',
    'fmk_text() { printf "%s\\n" SET-LATCH; }',
    `log_line_us() { echo ${fault === 'list-after-latch' ? 1900000 : 3000000}; }`,
    `ad_cscb_verb_between() { printf '%s\\n' ${quote('10\t2.000000\t42\tlist\t-\t--label service=cscb')}; }`,
    '_scenario_store_read() { printf ""; }',
    ...['us_of', 'secs_of', 'check_sweep_latch', 'check_cadence'].map(name => declaration(source, name)),
    `check_sweep_latch fixture ${key} ${quote(rows)}`,
    `echo "anchor=\${LATCH_US[${key}]}"`,
    `check_cadence fixture "\${LATCH_US[${key}]}" 47000000 47000000 none`,
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
  ['list-after-latch', 'no CSCB list of the bot server'],
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
  { kind: 'server-candidates', error: '' },
  { kind: 'other-server-candidate', error: "not the bot server's" },
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
    // Every candidate is printed; a second one started after the first but inside the tick's millisecond.
    `ad_mark_caller() { printf '290\\t${mark.toFixed(6)}\\t${kind === 'harness-mark' ? 99 : 42}\\tstatus\\t${kind === 'harness-mark' ? 'other' : 'cscb'}\\n'; ${
      kind === 'server-candidates' || kind === 'other-server-candidate'
        ? `printf '291\\t${(mark + 0.0005).toFixed(6)}\\t${kind === 'other-server-candidate' ? 43 : 42}\\tget\\tcscb\\n';` : ''} }`,
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
  { verb: 'status', parent: 42, role: 'cscb', status: 0, second: 42 },
  { verb: 'status', parent: 42, role: 'cscb', status: 1, second: 43 },
  { verb: 'status', parent: 42, role: 'cscb', status: 1, second: 99 },
].map(c => ({ second: 'none' as number | 'none', ...c })))('pending-persona mark requires this server: $verb parent=$parent role=$role, second candidate $second', ({ verb, parent, role, status, second }) => {
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
      ${second === 'none' ? '' : `printf '9\\t1.100500\\t${second}\\tget\\t${second === 99 ? 'other' : 'cscb'}\\n'`}
    }`,
    declaration(source, 't21_check_missing_mark'),
    't21_check_missing_mark fixture 1794351500.0001 7',
  ].join('\n'))
  expect(result.status).toBe(status)
})

// b.mve: the tick is stamped in millisecond .010 (it ends at .011000); the
// marking call M is the bot server's status at .010200.
const markTick = JSON.stringify({ instance_id: 'row', prior_state: 'waiting', source: 'ad_recovery', ts: '2023-11-14T22:13:20.010Z' })
const candidate = (pos: number, us: number, parent: number, verb: string, role = 'cscb') =>
  [pos, `1700000000.${us.toString().padStart(6, '0')}`, parent, verb, role].join('\t')

test.each([
  { parent: 42, role: 'cscb', status: 0 },
  { parent: 43, role: 'cscb', status: 1 },
  { parent: 99, role: 'other', status: 1 },
])('test 28 missing mark requires every candidate to be this server: second parent=$parent role=$role', ({ parent, role, status }) => {
  const source = readFileSync(join(integration, 'test-28-fmk-provenance.sh'), 'utf8')
  const start = source.lastIndexOf('if ad_release_at_least 0.18.0; then', source.indexOf('tick="$(ad_missing_tick "${ID_B}"'))
  const block = `${source.slice(start, source.indexOf('\n    sleep "${SETTLE_S}"', start))}\nfi`
  const rows = [candidate(5, 10200, 42, 'status'), candidate(6, 10600, parent, 'get', role)]
  const result = run([
    'ad_release_at_least() { return 0; }',
    'ID_B=row EDIT_MS_P=1700000000000 MARK_P=3 SERVER_PID=42 STEP=fixture TEST_NAME=fixture',
    `ad_missing_tick() {
      [[ "$1" == "$ID_B" && "$2" == "$EDIT_MS_P" ]] || fail 'wrong tick window or id'
      printf '%s\\n' ${quote(markTick)}
    }`,
    `ad_mark_caller() {
      [[ "$1" == ${quote(markTick)} && "$2" == "$MARK_P" ]] || fail 'wrong tick or shim window'
      printf '%s\\n' ${rows.map(quote).join(' ')}
    }`,
    block,
  ].join('\n'))
  expect(result.status).toBe(status)
  if (status === 1) {
    expect(result.stderr).toContain(`shim line 6, get at 1700000000.010600, parent ${parent}`)
    expect(result.stderr).toContain("not the bot server 42's")
  } else {
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('marked row missing')
  }
})

test.each([
  { name: 'the marking call alone', rows: [candidate(5, 10200, 42, 'status')], error: '', named: 'status at 1700000000.010200' },
  { name: 'two CSCB candidates', rows: [candidate(5, 10200, 42, 'status'), candidate(6, 10600, 43, 'get')], error: '', named: 'status or get at 1700000000.010200 or 1700000000.010600' },
  { name: 'a harness candidate', rows: [candidate(5, 10200, 99, 'status', 'other')], error: "is not CSCB's" },
  { name: 'a candidate after te', rows: [candidate(5, 10200, 42, 'status'), candidate(6, 10800, 42, 'get')], error: 'before a call that could have marked it (get at 1700000000.010800)' },
])('test 19 leg G bounds every candidate by the first missing read\'s return: $name', ({ rows, error, named }) => {
  const source = readFileSync(join(integration, 'test-19-fmk-reuse.sh'), 'utf8')
  const leg = declaration(source, 't19_leg_missing_row')
  const start = leg.lastIndexOf('    if ad_release_at_least 0.18.0; then', leg.indexOf('tick="$(ad_missing_tick "${id}"'))
  const block = `${leg.slice(start, leg.indexOf('\n    else', start))}\n    fi`
  const result = run([
    'ad_release_at_least() { return 0; }',
    'id=row step=fixture MARK_TIME=1700000000.000100 MARK_AD=3 missing_t=1700000000.010300 missing_te=1700000000.010700',
    `ad_missing_tick() { printf '%s\\n' ${quote(markTick)}; }`,
    `ad_mark_caller() {
      [[ "$2" == 3 && "\${3:-}" == "$missing_te" ]] || fail "ad_mark_caller: not bounded by te: $*"
      printf '%s\\n' ${rows.map(quote).join(' ')}
    }`,
    declaration(source, 't19_at_or_before'),
    block,
    'echo "named: $verb at $fm_t"',
  ].join('\n'))
  if (error) {
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
  } else {
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`named: ${named}`)
  }
})

test.each([
  // The tick's millisecond ends by the status's start (.011000): every candidate must precede the status.
  { name: 'a read before the status', status: 11000, rows: [candidate(5, 10200, 42, 'list')], error: '' },
  { name: 'two reads before the status', status: 11000, rows: [candidate(5, 10200, 42, 'list'), candidate(6, 10600, 42, 'get')], error: '' },
  { name: 'a candidate logged after the status', status: 11000, rows: [candidate(5, 10200, 42, 'list'), candidate(10, 10600, 42, 'get')], error: 'is not before its clearing round\'s status (shim line 9)' },
  // The status began inside the tick's millisecond (.010900): it must be the only candidate.
  { name: 'the status alone', status: 10900, rows: [candidate(9, 10900, 42, 'status')], error: '' },
  { name: 'a read beside the status', status: 10900, rows: [candidate(5, 10200, 42, 'list'), candidate(9, 10900, 42, 'status')], error: 'shim line 5 (list at 1700000000.010200) could have made it beside the status' },
  { name: 'a read after the status', status: 10900, rows: [candidate(9, 10900, 42, 'status'), candidate(10, 10950, 42, 'get')], error: 'shim line 10 (get at 1700000000.010950) could have made it beside the status' },
  { name: 'one read that is not the status', status: 10900, rows: [candidate(5, 10200, 42, 'list')], error: 'not proven written before' },
  { name: 'a pause', status: 11000, rows: [candidate(5, 10200, 42, 'pause')], error: 'is not a CSCB active read' },
  { name: 'a harness read', status: 11000, rows: [candidate(5, 10200, 99, 'get', 'other')], error: 'is not a CSCB active read' },
])('test 23 pane-not-found mark holds for every candidate: $name', ({ status, rows, error }) => {
  const source = readFileSync(join(integration, 'test-23-fmk-latch-recheck.sh'), 'utf8')
  const result = run([
    'TEST_NAME=fixture PN_CLEAR_MS=1700000000000 PN_END_MARK=4',
    `ad_missing_tick() { [[ "$1" == row && "$2" == "$PN_CLEAR_MS" ]] || fail 'wrong tick window or id'; printf '%s\\n' ${quote(markTick)}; }`,
    `ad_mark_caller() {
      [[ "$2" == "$PN_END_MARK" && -z "\${3:-}" ]] || fail "ad_mark_caller: wrong window: $*"
      printf '%s\\n' ${rows.map(quote).join(' ')}
    }`,
    'state_writes_of() { :; }',
    declaration(source, 'us_of'),
    declaration(source, 'check_pn_marked'),
    `check_pn_marked fixture row 9 1700000000.${status.toString().padStart(6, '0')} 1700000000.012000`,
  ].join('\n'))
  if (error) {
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
  } else {
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('read it missing')
  }
})

// Preserve the cadence fixtures' helper names and contracts in their own scope.
{
/** Real test-23 assertions over synthetic records; no AD, server or timers. */
const integration = join(import.meta.dir, 'integration')
const script = readFileSync(join(integration, 'test-23-fmk-latch-recheck.sh'), 'utf8')
const scenario = readFileSync(join(integration, 'lib/scenario.sh'), 'utf8')
const declaration = (source: string, name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const shim = (time: string, verb: string) => `call\t${time}\t100\t42\tparent\t${verb} --instance-id cscb_otherstore`
const decoder = ['_scenario_to_us', '_scenario_record_load', '_scenario_role_at', '_scenario_split_line', '_scenario_eval_words',
  '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id', '_scenario_us_text', '_scenario_read_log',
  '_scenario_shim_diagnostic', '_scenario_check_mark', '_scenario_in_window', '_scenario_cscb_ad_rows', 'ad_cscb_calls',
  '_scenario_log_mark', 'ad_shim_mark'].map(name => declaration(scenario, name))

function run(root: string, body: string[]) {
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail', 'fail() { echo "$*" >&2; exit 23; }',
    'require_ci_image() { :; }; require_scenario_home() { :; }',
    ...decoder,
    '_scenario_query_prep() { _scenario_record_load "$SCENARIO_CSCB_RECORD"; }',
    ...body,
  ].join('\n')], {
    env: hostSafeChildEnv(root, { tools: ['bash', 'awk', 'date', 'tail', 'cut', 'wc', 'tr', 'grep', 'sed', 'head', 'bun', 'rm'], extras: {
      SCENARIO_ROOT: join(root, 'scenario'), SCENARIO_AD_SHIM_LOG: join(root, 'scenario', 'shim'),
      SCENARIO_CSCB_RECORD: join(root, 'scenario', 'roles'), SCENARIO_FMK: '0',
      SCENARIO_FIXTURES: join(integration, 'fixtures'), CSCB_PKG_DIR: join(import.meta.dir, '..'),
      LATCH_EVIDENCE_DIR: join(root, 'results'),
    } }), encoding: 'utf8', timeout: 10000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  assertNoLeak([result.stdout, result.stderr])
  return result
}

function fixture() {
  const root = mkdtempSync('/tmp/fmk-latch-cadence-')
  mkdirSync(join(root, 'scenario'))
  writeFileSync(join(root, 'scenario', 'roles'), 'proc\tserver\t42\t1\t0.000000\n')
  return root
}

const latch = (session: string) => conflictLatchSetLine('otherstore', {
  sessionName: session, latchCase: LATCH_CASE_ANOTHER_STORE,
  refusedOperation: REFUSED_OPERATION_RESUME, rowState: latchRowStateRead('ended'),
})

function bringup({ late = false, read = '145.000000', noAnchor = false, stamp = '1970-01-01T00:01:40.000Z', mode = 'rounds' }: {
  late?: boolean, read?: string, noAnchor?: boolean, stamp?: string, mode?: 'rounds' | 'startup',
} = {}) {
  const root = fixture()
  try {
    const before = [shim(noAnchor ? '100.010000' : '99.990000', 'resume'), ...(late ? [shim('100.016000', 'get')] : [])]
    writeFileSync(join(root, 'scenario', 'shim'), before.join('\n') + '\n')
    writeFileSync(join(root, 'scenario', 'server.log'), `[${stamp}] ${latch('session')}\n`)
    return run(root, [
      'TEST_NAME=fixture LATCH_PID=42 LATCH_LIFE_MARK=0 START_WAIT_S=1 INTERVAL_US=45000000 INTERVAL_S=45 SETTLE_S=30',
      'SLACK_STATE_DIR="$SCENARIO_ROOT" SCENARIO_SEP=$\'\\034\' OI_KEY=ownid PN_KEY=panegone MIN_LATCHED_ROUNDS=2 CALL_NONE=none',
      'CALL_RESUME=resume CALL_PLAIN_SPAWN=plain-spawn CALL_REUSE_SPAWN=reuse-spawn CALL_PROBE=probe CALL_PENDING_READ=pending-read',
      'declare -A PERSONA_ID=([otherstore]=cscb_otherstore) CASE_OF=([otherstore]=another-store) OP_OF=([otherstore]=resume)',
      'declare -A LATCH_ROW_OF=([otherstore]=ended) REFUSED_OF=([otherstore]=resume) LATCH_MARK=() LATCH_US=() LATCH_SET_US=() SESSION_OF=() ROUNDS_FROM=()',
      'declare -A FREE_ROUNDS=([otherstore]=2) FREE_MARK=([otherstore]=99) FREE_POSTS=([otherstore]=1) POSTS_BEFORE=([otherstore]=0)',
      'declare -A CALL_OF=([otherstore]=none) READ_OF=() PREV_US=()',
      ...['matcher', '_scenario_scan'].map(name => declaration(scenario, name)),
      ...['us_of', 'secs_of', 'rows_count', 'check_cadence', 'round_call_is', 'latch_rounds', 'wait_latch_set',
        'log_line_us', 'p2_check_bringup_refusal', 'check_latched_rounds', 'skip_early_reads'].map(name => declaration(script, name)),
      `_scenario_poll_until() { return 0; }; fmk_text() { printf '%s\\n' ${quote(latch('SESSIONSLOT'))}; }`,
      'latch_lines_of() { :; }; calls_of() { :; }',
      'SCENARIO_FMK=1; wait_latch_set otherstore',
      'rows="$(ad_cscb_calls cscb_otherstore 0 "${LATCH_MARK[otherstore]}")"',
      'p2_check_bringup_refusal fixture otherstore "$rows"',
      'echo "anchor=${LATCH_US[otherstore]}"',
      ...(mode === 'startup' ? [
        `printf '%s\\n' ${quote(shim('101.000000', 'get'))} ${quote(shim('145.000000', 'status'))} >> "$SCENARIO_AD_SHIM_LOG"`,
        'skip_early_reads fixture otherstore',
        'echo "from=${ROUNDS_FROM[otherstore]}"',
      ] : [
        `printf '%s\\n' ${quote(shim(read, 'status'))} ${quote(shim((Number(read) + 45).toFixed(6), 'status'))} >> "$SCENARIO_AD_SHIM_LOG"`,
        'check_latched_rounds otherstore',
      ]),
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('test 23 on-time round ignores a post-arm pre-mark get as an anchor', () => {
  const result = bringup({ late: true })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('anchor=99990000')
  expect(result.stdout).toContain('round 1: read 45.010 s')
})

test('test 23 no late call retains the original anchor and cadence margin', () => {
  const result = bringup()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('anchor=99990000')
  expect(result.stdout).toContain('round 1: read 45.010 s')
})

test.each([
  ['144.500000', 'less than the 45 s interval'],
  ['174.990001', 'more than the 45 s interval plus the 30 s settle'],
] as const)('test 23 first round at %s still fails its unchanged bound', (read, error) => {
  const result = bringup({ read })
  expect(result.status).toBe(23)
  expect(result.stderr).toContain(error)
})

test('test 23 first round just inside the original upper bound passes that round', () => {
  const result = bringup({ read: '174.989999' })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('round 1: read 74.999 s')
})

test.each([
  [{ noAnchor: true }, 'no CSCB call at or before the latch-set line'],
  [{ stamp: 'not-a-time' }, 'is not a time'],
] as const)('test 23 rejects missing pre-latch call or malformed latch time: %j', (options, error) => {
  const result = bringup(options)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(error)
})

test('test 23 startup exemption retains its boundary on a valid anchor', () => {
  const result = bringup({ mode: 'startup' })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('anchor=99990000')
  expect(result.stdout).toContain('from=2')
})

test.each(['failure', 'pass', 'missing-shim'] as const)('test 23 Part 2 %s keeps only redacted failure artifacts outside cleanup', mode => {
  const root = fixture()
  const results = join(root, 'results')
  const secret = fakeToken(BOT_TOKEN_PREFIX, 'latch-evidence')
  try {
    writeFileSync(join(root, 'scenario', 'shim'), [shim('99.990000', 'resume'), shim('100.016000', 'get'), secret,
      `call\t100.020000\t100\t42\tparent\tget --instance-id ${secret}`].join('\n') + '\n')
    writeFileSync(join(root, 'scenario', 'server.log'), `first ${sentinelInMessage('latch-evidence')}\n`)
    writeFileSync(join(root, 'scenario', 'server.log.1'), 'rotated latch line\n')
    mkdirSync(join(root, 'scenario', 'second'))
    writeFileSync(join(root, 'scenario', 'second', 'server.log'), 'second latch line\n')
    if (mode === 'missing-shim') rmSync(join(root, 'scenario', 'shim'))
    const result = run(root, [
      ...['_scenario_cleanup', 'on_failure'].map(name => declaration(scenario, name)),
      ...['pn_evidence_rows', 'latch_failure_evidence', 'pn_failure_evidence'].map(name => declaration(script, name)),
      'TEST_NAME=fixture SCENARIO_LOG_TAIL_LINES=0 LATCH_LIFE_MARK=0 LATCH_PID=42 INTERVAL_US=45000000',
      'SLACK_STATE_DIR="$SCENARIO_ROOT"; _scenario_stop_dir() { :; }',
      '_SCENARIO_BEFORE_CLEANUP_HOOKS=(); _SCENARIO_SERVER_PIDS=(); _SCENARIO_TRACKED_PIDS=(); _SCENARIO_EXIT_HOOKS=(); _SCENARIO_FAILURE_HOOKS=()',
      '_SCENARIO_STATE_DIRS=("$SCENARIO_ROOT" "$SCENARIO_ROOT/second")',
      'declare -A LATCH_MARK=([otherstore]=2) LATCH_US=([otherstore]=99990000) LATCH_SET_US=([otherstore]=100000000)',
      'declare -A PERSONA_ID=([otherstore]=cscb_otherstore)',
      `LATCH_US[unsafe]=${quote(secret)}; LATCH_MARK[${quote(secret)}]=3; PERSONA_ID[unsafe]=${quote(sentinelInMessage('latch-id'))}`,
      script.match(/^on_failure pn_failure_evidence$/m)?.[0] ?? 'false',
      'trap _scenario_cleanup EXIT',
      mode === 'pass' ? 'exit 0' : 'fail "part 2 cadence failed"',
    ])
    expect(result.status).toBe(mode === 'pass' ? 0 : 23)
    expect(existsSync(join(root, 'scenario'))).toBe(false)
    if (mode === 'pass') expect(existsSync(results)).toBe(false)
    else {
      expect(existsSync(join(results, 'latch-records.json'))).toBe(true)
      const records = JSON.parse(readFileSync(join(results, 'latch-records.json'), 'utf8'))
      expect(records).toMatchObject({ LATCH_MARK: { otherstore: '2' }, LATCH_US: { otherstore: '99990000' }, LATCH_SET_US: { otherstore: '100000000' } })
      expect(records.LATCH_US.unsafe).toMatch(/^invalid:sha256:[a-f0-9]{64}:bytes:[0-9]+$/)
      expect(records.PERSONA_ID.unsafe).toMatch(/^invalid:sha256:[a-f0-9]{64}:bytes:[0-9]+$/)
      expect(readFileSync(join(results, 'server-1.log'), 'utf8')).toContain('<redacted-token> <redacted-url>')
      expect(readFileSync(join(results, 'server-1.log.1'), 'utf8')).toBe('rotated latch line\n')
      expect(readFileSync(join(results, 'server-2.log'), 'utf8')).toBe('second latch line\n')
      const rows = readFileSync(join(results, 'agent-director-shim.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (mode === 'failure') {
        expect(rows[1]).toMatchObject({ line: '2', time: '100.016000', verb: 'get', id: 'cscb_otherstore', ppid: '42', role: 'cscb' })
        expect(rows[2].invalid).toMatch(/^invalid:sha256:[a-f0-9]{64}:bytes:[0-9]+$/)
        expect(rows[3].id).toMatch(/^invalid:sha256:[a-f0-9]{64}:bytes:[0-9]+$/)
      } else expect(rows).toEqual([])
      assertNoLeak(writtenFile(results))
    }
    expect(result.stderr).not.toContain('panegone-evidence:')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
}
