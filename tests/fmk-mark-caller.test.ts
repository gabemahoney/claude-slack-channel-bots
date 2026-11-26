/** Attribution returns every call that could have made a mark, never one picked call. */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX, sentinelInMessage } from './test-helpers/credentials.ts'
import { textHash } from './integration/fixtures/stub-submission-audit.ts'

const source = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const test23 = readFileSync(join(import.meta.dir, 'integration/test-23-fmk-latch-recheck.sh'), 'utf8')
const pnDeclaration = (name: string) => test23.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
const declaration = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const call = (us: number, parent: number, args: string) => `call\t1700000000.${us.toString().padStart(6, '0')}\t100\t${parent}\tparent\t${args}`
// Stamped in millisecond .010: eligible calls start before 1700000000.011000.
const tickOf = (tickSource: string) => JSON.stringify({ instance_id: 'row', prior_state: 'waiting', source: tickSource, ts: '2023-11-14T22:13:20.010Z' })
const pnClearingEvent = () => pnDeclaration('p2_clearing_schedule').split('ROUND_END_MARK[${OI_KEY}]="$(ad_shim_mark)"')[1]
  ?.split('    free_snapshot "${PN_KEY}"')[0] ?? ''

// 42 is the bot server and 43 another CSCB process; any other parent is not CSCB's.
function probe(calls: string[], labels: Record<string, string> = { service: 'cscb' }, extra: string[] = [], tickSource = 'ad_recovery', panegone = false,
  pn: { sameMs?: boolean, validateRound?: boolean, reference?: number, roundEnd?: number,
    ends?: (calls: string[]) => string, from?: number, check?: string, unreadableEnds?: boolean } = {}) {
  const root = mkdtempSync('/tmp/fmk-mark-caller-')
  const log = join(root, 'shim')
  writeFileSync(log, calls.join('\n') + '\n')
  if (pn.ends) writeFileSync(log + '.ends', pn.ends(calls))
  if (pn.unreadableEnds) mkdirSync(log + '.ends') // cannot be read as completion records
  // Execute the real clearing-event block with only native scheduling stubbed.
  // Lines 1/2 are R4's completed status/probe; the pre-end reference includes
  // every line except the clearing status. The old pre-wait mark would be 0.
  const script = [
    'set -euo pipefail',
    'fail() { echo "$*" >&2; exit 1; }',
    'require_ci_image() { :; }',
    'require_scenario_home() { :; }',
    '_scenario_query_prep() { :; }',
    '_scenario_role_at() { [[ "$1" == 42 || "$1" == 43 ]]; }',
    `ad_store_peek() { printf '%s\\n' ${quote(JSON.stringify({ labels }))}; }`,
    `SCENARIO_AD_SHIM_LOG=${quote(log)}`,
    ...['_scenario_check_mark', '_scenario_in_window', '_scenario_to_us', '_scenario_split_line',
      '_scenario_read_log', '_scenario_shim_diagnostic',
      '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id',
      '_scenario_us_text', '_scenario_mark_list_selects', 'ad_mark_caller', '_scenario_cscb_ad_rows', 'ad_cscb_calls'].map(declaration),
    ...(panegone ? [
      declaration('ad_missing_tick'), ...['state_writes_of', 'us_of', 'check_pn_marked', 'pn_attribution_start',
        'check_latched_rounds', 'latch_rounds', 'rows_count', 'round_call_is'].map(pnDeclaration),
      `ad_trail_events() { [[ "$1" != ad.find_missing.tick ]] || printf '%s\\n' ${quote(JSON.stringify({ ...JSON.parse(tickOf(tickSource)),
        ts: pn.sameMs ? '2023-11-14T22:13:20.020Z' : '2023-11-14T22:13:20.010Z', event: 'ad.find_missing.tick', new_state: 'missing' }))}; }`,
      'TEST_NAME=test-23; PN_KEY=panegone; MIN_LATCHED_ROUNDS=2; STUB_MODE_AT_ONCE=at-once; PN_FIXTURE_READY=0',
      'declare -A PERSONA_ID=([panegone]=row) LATCH_MARK=([panegone]=0) STILL_LINE=([panegone]=still) ROUND_HEAD=([panegone]=round)',
      'declare -A PERSONA_WORK=([panegone]=work) SEED_SID=([panegone]=session)',
      'wait_rounds() { PN_FIXTURE_READY=1; }; count_log() { echo 4; }; stub_mode() { :; }; end_session() { :; }; ad_release_at_least() { return 0; }',
      `ad_shim_mark() { if (( PN_FIXTURE_READY )); then echo ${pn.reference ?? calls.length - 1}; else echo 0; fi; }`,
      pnClearingEvent(),
      'echo "panegone window: ${PN_END_MARK}; R4 status: ${PN_R4_STATUS:-unset}"',
      ...(pn.validateRound ? [
        'MIN_LATCHED_ROUNDS=1; CALL_NONE=none; CALL_PROBE=probe; CALL_RESUME=resume; CALL_PLAIN_SPAWN=spawn; CALL_REUSE_SPAWN=reuse; CALL_PENDING_READ=pending',
        `declare -A FREE_ROUNDS=([panegone]=1) FREE_MARK=([panegone]=${pn.roundEnd ?? 2}) FREE_POSTS=([panegone]=1) POSTS_BEFORE=([panegone]=0)`,
        'declare -A LATCH_US=([panegone]=1700000000000000) PREV_US=() CALL_OF=([panegone]=probe) READ_OF=()',
        'check_cadence() { :; }; latch_lines_of() { :; }; calls_of() { :; }',
        'check_latched_rounds panegone',
      ] : []),
      'PN_CLEAR_MS=1700000000005',
      `check_pn_marked "part 2: panegone clear" row ${calls.length} ${pn.sameMs ? '1700000000.020200' : '1700000000.020000'} 1700000000.021000`,
    ] : pn.check ? [pn.check] : [
      `candidates="$(ad_mark_caller ${[tickOf(tickSource), String(pn.from ?? 0), ...extra].map(quote).join(' ')})" || exit $?`,
      'printf "%s\\n" "$candidates"',
    ]),
  ].join('\n')
  try {
    const result = spawnSync('bash', ['-c', script], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'date', 'wc', 'tr', 'awk', 'python3'] }), encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    assertNoLeak([result.stdout, result.stderr])
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('test-23 keeps the wide mark and derives only R4 status from the pre-end reference', () => {
  const schedule = pnDeclaration('p2_clearing_schedule')
  expect(pnClearingEvent()).not.toBe('')
  expect(schedule.indexOf('PN_END_MARK=')).toBeLessThan(schedule.indexOf('wait_rounds "part 2" "${PN_KEY}"'))
  expect(schedule).toContain('PN_R4_STATUS="$(pn_attribution_start "${pn_end_reference}")" || exit 1')
  expect(schedule.match(/PN_END_MARK=/g)).toHaveLength(1)
  expect(pnDeclaration('pn_attribution_start')).toContain('[[ "${last}" =~ ^[0-9]+$ ]]')
  expect(schedule.indexOf('pn_end_reference="$(ad_shim_mark)"')).toBeGreaterThan(schedule.indexOf('stub_mode "${PERSONA_WORK[${PN_KEY}]}"'))
  expect(schedule.indexOf('pn_end_reference="$(ad_shim_mark)"')).toBeLessThan(schedule.indexOf('PN_R4_STATUS='))
  expect(schedule.indexOf('PN_CLEAR_MS=')).toBeGreaterThan(schedule.indexOf('stub_mode "${PERSONA_WORK[${PN_KEY}]}"'))
  expect(schedule.indexOf('PN_CLEAR_MS=')).toBeLessThan(schedule.indexOf('end_session "${SEED_SID[${PN_KEY}]}"'))
})

test('test-23 candidate checker differs from HEAD only by the exact guarded R4 skip line', () => {
  const body = pnDeclaration('check_pn_marked')
  const skip = '        [[ -n "${PN_R4_STATUS:-}" && "${pos}" == "${PN_R4_STATUS}" ]] && { [[ "${caller}" == *$\'\\n\'* ]] || fail "${step}: no candidate remains after excluding the proven-finished R4 status at shim line ${PN_R4_STATUS}"; continue; }\n'
  expect(body.split(skip)).toHaveLength(2)
  expect(textHash(body.replace(skip, ''))).toBe('8f64d406809a15255a57224b0920f7024b3e60752c5cecf3aaac391e7bd3a9db')
})

test.each([
  ['e06627: selecting list in flight before the old mark', 'list --state waiting --label service=cscb', 42, true],
  ['non-CSCB selecting read inside the widened window', 'list --state waiting', 99, false],
  ['wrong-state list inside the widened window', 'list --state check_permission', 42, false],
  ['wrong-label list inside the widened window', 'list --label service=other', 42, false],
] as const)('test-23 %s', (_, args, parent, succeeds) => {
  const result = probe([call(500, 42, 'status --instance-id row'), call(1000, 42, 'read-pane --instance-id row --n-lines 1'), call(2000, parent, args),
    call(6000, 42, 'get --instance-id other'), call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true)
  expect(result.status).toBe(succeeds ? 0 : 1)
  if (succeeds) expect(result.stdout).toContain('list at shim line 3 marked row missing')
  else expect(result.stderr).toMatch(/no agent-director call|no candidate remains|not a CSCB active read/)
})

test('test-23 passing-run list after the old mark keeps its attribution', () => {
  const result = probe([call(500, 42, 'status --instance-id row'), call(1000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(2000, 42, 'get --instance-id other'), call(6000, 42, 'list --state waiting --label service=cscb'),
    call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true, { reference: 3 })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('list at shim line 4 marked row missing')
})

test('test-23 completed R4 status is excluded beside the in-flight list', () => {
  const result = probe([call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'list --state waiting'), call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true, { validateRound: true })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('panegone window: 0; R4 status: 1')
  expect(result.stdout).toContain('round 1: status at shim line 1')
  expect(result.stdout).toContain('list at shim line 3 marked row missing')
})

test('test-23 keeps non-CSCB ambiguity inside the widened window', () => {
  const result = probe([call(500, 42, 'status --instance-id row'), call(1000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(2000, 99, 'get --instance-id row'), call(6000, 42, 'list --state waiting'),
    call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
})

test('test-23 reviewer counterexample: completed R4 status cannot defeat the sole clearing status in its tick millisecond', () => {
  const result = probe([call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'get --instance-id other'), call(20200, 42, 'status --instance-id row')], undefined, [], undefined, true,
  { sameMs: true, validateRound: true })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('panegone window: 0; R4 status: 1')
  expect(result.stdout).toContain('status at shim line 4 marked row missing')
})

test.each([
  ['CSCB list remains eligible', 42, 'get --instance-id other', true],
  ['non-CSCB list remains ambiguous beside a later CSCB list', 99, 'list --state waiting', false],
] as const)('test-23 reviewer 2: before-R4 %s', (_, parent, later, succeeds) => {
  const result = probe([call(500, parent, 'list --label service=cscb'), call(1000, 42, 'status --instance-id row'),
    call(2000, 42, 'read-pane --instance-id row --n-lines 1'), call(6000, 42, later),
    call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true, { validateRound: true, roundEnd: 3 })
  expect(result.status).toBe(succeeds ? 0 : 1)
  if (succeeds) {
    expect(result.stdout).toContain('panegone window: 0; R4 status: 2')
    expect(result.stdout).toContain('list at shim line 1 marked row missing')
  } else expect(result.stderr).toMatch(/not a CSCB active read|ambiguous/)
})

test('test-23 skipping the only candidate fails instead of printing an empty successful caller', () => {
  const result = probe([call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'get --instance-id other'), call(20000, 42, 'status --instance-id row')], undefined, [], undefined, true)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('no candidate remains after excluding the proven-finished R4 status at shim line 1')
  expect(result.stdout).not.toContain("CSCB's  marked")
})

test('test-23 skips only the exact R4 position, retaining an earlier CSCB status', () => {
  const result = probe([call(500, 42, 'status --instance-id row'), call(1000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(2000, 42, 'status --instance-id row'), call(3000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'get --instance-id other'), call(20200, 42, 'status --instance-id row')], undefined, [], undefined, true, { sameMs: true })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('panegone window: 0; R4 status: 3')
  expect(result.stderr).toContain('shim line 1 (status at 1700000000.000500) could have made it beside the status')
})

test('test-23 no panegone status before the reference fails loudly instead of widening', () => {
  const result = probe([call(1000, 42, 'status --instance-id other'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'get --instance-id row'), call(20200, 42, 'status --instance-id row')], undefined, [], undefined, true, { sameMs: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('no CSCB status of row at or before shim line 3')
  expect(result.stdout).not.toContain('panegone window:')
})

test('test-23 a derived status disagreeing with the completed round fails loudly', () => {
  const result = probe([call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'status --instance-id row'), call(20200, 42, 'status --instance-id row')], undefined, [], undefined, true,
  { sameMs: true, validateRound: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('panegone R4 status')
  expect(result.stderr).toContain('disagrees with last still-latched round')
})

test('test-23 residual: an unproven selecting list in the gap still defeats the sole-status branch conservatively', () => {
  const result = probe([call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'list --state waiting'), call(20200, 42, 'status --instance-id row')], undefined, [], undefined, true,
  { sameMs: true, validateRound: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('shim line 3 (list at 1700000000.006000) could have made it beside the status')
})

// The sidecar keys the byte after the original call's newline, not its PID
// alone or its position among calls. Calculate that independently of bash.
const endOf = (calls: string[], index: number, us: number) => {
  const fields = calls[index]!.split('\t')
  return ['end-v1', `1700000000.${String(us).padStart(6, '0')}`,
    Buffer.byteLength(calls.slice(0, index + 1).join('\n') + '\n'), fields[2], fields[3], fields[1]].join('\t') + '\n'
}

// Exercise the real event schedule and checker. Only process existence and
// scenario actions are synthetic; the probe's Python and attribution run as-is.
function relabelProbe(calls: string[], mark: number, alive: Record<string, string>, options: {
  source?: string, ends?: (calls: string[]) => string, ticks?: number[], legacy?: boolean,
} = {}) {
  const tick = (ms: number) => JSON.stringify({ event: 'ad.find_missing.tick', instance_id: 'cscb_relabelone',
    prior_state: 'waiting', new_state: 'missing', source: options.source ?? 'ad_recovery', ts: new Date(ms).toISOString() })
  const fakePidSource = [
    'import errno, os, sys', `states = ${JSON.stringify(alive)}`,
    'def probe_pid(pid, signal):', '    assert signal == 0', '    state = states.get(str(pid), "dead")',
    '    if state == "dead": raise ProcessLookupError(errno.ESRCH, "absent")',
    '    if state == "unknown": raise PermissionError(errno.EPERM, "unavailable")',
    '    assert state in ("alive", "zombie", "reused")',
    'os.kill = probe_pid', 'exec(compile(sys.stdin.read(), "relabel-probe", "exec"))',
  ].join('\n')
  return probe(calls, undefined, [], undefined, false, { ends: options.ends, check: [
    declaration('ad_missing_tick'), pnDeclaration('p2_relabel_events'), pnDeclaration('check_relabel_marked'),
    '_scenario_role_at() { [[ "$1" == 42 || "$1" == 43 || "$1" == 199810 ]]; }',
    'TEST_NAME=test-23 R1_KEY=relabelone R2_KEY=relabeltwo FIND_MISSING_LOOP_PID=216977 FIND_MISSING_LOOP_INTERVAL_S=30',
    'P2_RELABEL_KEYS=(relabelone relabeltwo)',
    'declare -A PERSONA_ID=([relabelone]=cscb_relabelone [relabeltwo]=cscb_relabeltwo)',
    'declare -A STILL_LINE=([relabelone]=one [relabeltwo]=two) PERSONA_NAMED=([relabeltwo]=two)',
    'declare -A SEED_PANE=([relabelone]=pane) SEED_SID=([relabelone]=one [relabeltwo]=two) EVENT_TMUX_MARK=()',
    'declare -A MISSING_MARK=([relabelone]=999)',
    `ad_release_at_least() { return ${options.legacy ? 1 : 0}; }`,
    `ad_shim_mark() { echo ${mark}; }; tmux_shim_mark() { echo 0; }`,
    'count_log() { echo "${ROUND_READY:-0}"; }; wait_rounds() { ROUND_READY=1; }; free_snapshot() { :; }',
    'respawn_worker_pane() { echo "pane 216937"; }; end_session() { :; }; has_session_id() { :; }',
    'find_missing_loop_runs() { echo 0; }; run_find_missing_loop() { :; }',
    'date() { if [[ "$*" == +%s%3N ]]; then echo 1795629214320; else command date "$@"; fi; }',
    `python3() { [[ "$1" == -I && "$2" == - ]] || exit 90; shift 2; command python3 -I -c ${quote(fakePidSource)} "$@"; }`,
    `ad_trail_events() { printf '%s\n' ${(options.ticks ?? [1795629214350]).map(ms => quote(tick(ms))).join(' ')}; }`,
    ...(options.legacy ? [
      'check_no_cscb_find_missing() { [[ "$2" == 758 && "$3" == 999 ]] || exit 91; }',
      `shim_verb_rows() { printf '759\t1795629214.390305\t216977\t-\n'; }`,
    ] : []),
    'p2_relabel_events', 'echo "relabel bound=${RELABEL_CALLERS_MARK:-unset}"', 'check_relabel_marked relabelone',
  ].join('\n') })
}

// Times, invocation PIDs and parents are the kept job's records 751–760.
// The unretained argv, tick, ends and prefix are explicitly synthetic.
const relabelCalls = () => [
  ...Array.from({ length: 750 }, () => 'call\t1795629200.000000\t10\t199810\tparent\tversion'),
  ...[
    ['1795629213.297158', 216797, 199810, 'list --label service=cscb'],
    ['1795629213.899532', 216820, 199810, 'status --instance-id cscb_badname'],
    ['1795629214.072224', 216830, 199810, 'status --instance-id cscb_relabelone'],
    ['1795629214.099212', 216835, 199810, 'status --instance-id cscb_relabeltwo'],
    ['1795629214.125388', 216840, 199810, 'status --instance-id cscb_nostart'],
    ['1795629214.133279', 216846, 199810, 'get --instance-id cscb_nostart'],
    ['1795629214.140210', 216859, 199810, 'resume --instance-id cscb_nostart'],
    ['1795629214.296983', 216914, 199810, 'list --label service=cscb'],
    ['1795629214.390305', 216986, 216977, 'find-missing'],
    ['1795629215.297420', 217065, 199810, 'list --label service=cscb'],
  ].map(([time, pid, parent, args]) => `call\t${time}\t${pid}\t${parent}\tparent\t${args}`),
]
const relabelEnd = (calls: string[], index: number, time: string) => {
  const fields = calls[index]!.split('\t')
  return ['end-v1', time, Buffer.byteLength(calls.slice(0, index + 1).join('\n') + '\n'),
    fields[2], fields[3], fields[1]].join('\t') + '\n'
}
const relabelCall = (pid: number, parent: number, verb: string, time = '1795629214.296983') =>
  `call\t${time}\t${pid}\t${parent}\tparent\t${verb}`

function expectRelabelDiagnostic(stdout: string, mark: number, bound: number, firstPid?: number) {
  const prefix = "test-23: part 2: the relabelled legs' events: relabel probe: "
  const first = firstPid === undefined ? '' : ` first_retained_line=${bound + 1} first_retained_pid=${firstPid}`
  expect(stdout.split('\n').filter(line => line.startsWith(prefix))).toEqual([
    `${prefix}RELABEL_EVENTS_MARK=${mark} RELABEL_CALLERS_MARK=${bound} widened_by=${mark - bound} RELABEL_EVENTS_MS=1795629214320${first}`,
  ])
}

test.each([false, true])('relabel regression: recorded pre-mark list 758 still in flight (late end=%p)', late => {
  const result = relabelProbe(relabelCalls(), 758, { 216914: 'alive' }, {
    ...(late ? { ends: (calls: string[]) => relabelEnd(calls, 757, '1795629214.360000') } : {}),
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('relabel bound=757')
  expectRelabelDiagnostic(result.stdout, 758, 757, 216914)
  expect(result.stdout).toContain("marked by cscb's list (parent 199810, shim line 758, 1795629214.296983)")
})

test('relabel control: paired early end excludes the same pre-mark list despite a reused PID', () => {
  const result = relabelProbe(relabelCalls(), 758, { 216914: 'reused' },
    { ends: calls => relabelEnd(calls, 757, '1795629214.349999') })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('no unambiguous eligible caller made the mark')
})

test.each(['alive', 'zombie', 'reused', 'unknown'])('relabel probe retains a pre-mark %s PID', state => {
  const result = relabelProbe([relabelCall(100, 42, 'list')], 1, { 100: state })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('relabel bound=0')
  expectRelabelDiagnostic(result.stdout, 1, 0, 100)
  expect(result.stdout).toContain("marked by cscb's list")
})

test('relabel probe excludes an absent PID without requiring observer evidence', () => {
  const result = relabelProbe([relabelCall(100, 42, 'list')], 1, {})
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('relabel bound=1')
  expectRelabelDiagnostic(result.stdout, 1, 1)
})

test('relabel probe is bounded by the event mark and finishes before either worker ends', () => {
  const body = pnDeclaration('p2_relabel_events')
  const mark = body.indexOf('RELABEL_EVENTS_MARK="$(ad_shim_mark)"')
  const stamp = body.indexOf('RELABEL_EVENTS_MS="$(date +%s%3N)"')
  const probe = body.indexOf('out="$(python3')
  expect(mark).toBeGreaterThan(0)
  expect(stamp).toBeGreaterThan(mark)
  expect(probe).toBeGreaterThan(stamp)
  expect(probe).toBeLessThan(body.indexOf('out="$(respawn_worker_pane'))
  expect(probe).toBeLessThan(body.indexOf('end_session "${SEED_SID[${R2_KEY}]}"'))
})

test('relabel refuses an invalid PID rather than probing a process group or running the events', () => {
  const result = relabelProbe([relabelCall(0, 42, 'list')], 1, {})
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('cannot bound the calls in flight')
  expect(result.stdout).not.toContain('the harness respawned')
})

test('relabel retains the owner rule for a sole foreign call after the bound', () => {
  const result = relabelProbe([relabelCall(100, 98, 'list')], 0, {})
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('belongs to neither CSCB nor the harness loop')
})

test('relabel retains same-source ambiguity across the event mark', () => {
  const result = relabelProbe([relabelCall(100, 98, 'get --instance-id cscb_relabelone'), relabelCall(101, 42, 'list')], 1, { 100: 'alive' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous mark')
})

test.each(['ad_find_missing', 'ad_recovery'])('relabel preserves the post-mark %s pass beside an early-ended same-source call', tickSource => {
  const verb = tickSource === 'ad_find_missing' ? 'find-missing' : 'list'
  const result = relabelProbe([relabelCall(100, 42, verb), relabelCall(101, tickSource === 'ad_find_missing' ? 216977 : 42, verb)],
    1, { 100: 'alive' }, { source: tickSource, ends: calls => relabelEnd(calls, 0, '1795629214.349999') })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain(`shim line 2,`)
  expect(result.stdout).not.toContain('shim line 1,')
})

test.each([false, true])('relabel excludes dead Part 1 find-missing before the bound (late end=%p)', late => {
  const calls = [relabelCall(100, 98, 'find-missing'), relabelCall(101, 42, 'list'), relabelCall(102, 216977, 'find-missing')]
  const result = relabelProbe(calls, 2, { 101: 'alive' }, { source: 'ad_find_missing',
    ...(late ? { ends: (lines: string[]) => relabelEnd(lines, 0, '1795629214.360000') } : {}) })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('relabel bound=1')
  expect(result.stdout).toContain("marked by other's find-missing (parent 216977, shim line 3,")
})

test('relabel still rejects a dead harness call inside the widened bound without end proof', () => {
  const calls = [relabelCall(100, 42, 'sweep'), relabelCall(101, 98, 'find-missing'), relabelCall(102, 216977, 'find-missing')]
  const result = relabelProbe(calls, 2, { 100: 'alive' }, { source: 'ad_find_missing',
    ends: lines => relabelEnd(lines, 0, '1795629214.349999') })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous mark')
})

test('relabel ignores ticks before the unchanged event timestamp', () => {
  const calls = [relabelCall(100, 42, 'list')]
  const result = relabelProbe(calls, 0, {}, { ticks: [1795629214319, 1795629214350] })
  expect(result.status, result.stderr).toBe(0)
  expectRelabelDiagnostic(result.stdout, 0, 0)
  const onlyOld = relabelProbe(calls, 0, {}, { ticks: [1795629214319] })
  expect(onlyOld.status).toBe(1)
  expect(onlyOld.stderr).toContain('no missing tick after the relabel events')
})

test('relabel legacy branch keeps the original event-mark window and no native probe', () => {
  const result = relabelProbe(relabelCalls(), 758, {}, { legacy: true })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('relabel bound=unset')
  expect(result.stdout).not.toContain('relabel probe:')
  expect(result.stdout).toContain('marked missing by the harness\'s loop')
})

const pnEndCalls = (parent = 42) => [call(1000, 42, 'status --instance-id row'),
  call(2000, 42, 'read-pane --instance-id row --n-lines 1'), call(6000, parent, 'list --state waiting'),
  call(20200, 42, 'status --instance-id row')]

test('call ends regression: a selecting list proven ended before the tick permits the real PN sole-status branch', () => {
  const result = probe(pnEndCalls(), undefined, [], undefined, true,
    { sameMs: true, validateRound: true, ends: calls => endOf(calls, 2, 19999) })
  // On the old helper this reports the real conservative attribution failure.
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('status at shim line 4 marked row missing')
  expect(result.stdout).not.toContain('list at shim line 3 marked')
})

test.each([20000, 20001, 20999, 21000])('call ends control: upper end %i retains the PN list at/after the tick boundary', end => {
  const result = probe(pnEndCalls(), undefined, [], undefined, true,
    { sameMs: true, validateRound: true, ends: calls => endOf(calls, 2, end) })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('shim line 3 (list at 1700000000.006000) could have made it beside the status')
})

test.each([undefined, 20000, 21000])('call ends control: non-CSCB pre-R4 list stays ambiguous with end %s', end => {
  const calls = [call(500, 99, 'list --state waiting'), ...pnEndCalls()]
  const result = probe(calls, undefined, [], undefined, true, { sameMs: true, validateRound: true, roundEnd: 3,
    ...(end === undefined ? {} : { ends: (lines: string[]) => endOf(lines, 0, end) }) })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
})

test('call ends regression: a proven pre-tick non-CSCB read no longer causes ambiguity', () => {
  const result = probe([call(1000, 99, 'get --instance-id row'), M], undefined, [], undefined, false,
    { ends: calls => endOf(calls, 0, 9999) })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([['2', ...MROW.slice(1)]])
})

test('call ends regression: offsets distinguish reused PID calls and out-of-order completions', () => {
  const result = probe([call(1000, 42, 'list --state waiting'), call(2000, 43, 'status --instance-id row'), M],
    undefined, [], undefined, false,
    { ends: calls => endOf(calls, 1, 21000) + endOf(calls, 0, 9999) + endOf(calls, 2, 22000) })
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(row => [row[0], row[2]])).toEqual([['2', '43'], ['3', '42']])
})

test('call ends regression: byte offsets include Unicode, stop and fault records without changing physical marks', () => {
  const calls = [call(100, 42, 'get --instance-id other --label note=🙂'),
    'stop\t1700000000.000200\t200\t42\tparent\tstub-claude stopped',
    'fault\t1700000000.000300\t100\t42\tparent\tget * swallow 1',
    call(1000, 42, 'get --instance-id row'), M]
  const result = probe(calls, undefined, [MISSING_TE], undefined, false,
    { from: 3, ends: lines => endOf(lines, 3, 9999) })
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([['5', ...MROW.slice(1)]])
})

test('call ends regression: a sole proven-ended call leaves no candidate', () => {
  const result = probe([call(1000, 42, 'get --instance-id row')], undefined, [], undefined, false,
    { ends: calls => endOf(calls, 0, 9999) })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

test.each(['ad_find_missing', 'ad_recovery'])('call ends regression: source %s keeps only an in-flight fitting verb', source => {
  const verbs = source === 'ad_find_missing' ? ['sweep', 'find-missing'] : ['pause --instance-id row', 'get --instance-id row']
  const result = probe([call(1000, 42, verbs[0]!), call(10200, 43, verbs[1]!)], undefined, [], source, false,
    { ends: calls => endOf(calls, 0, 9999) })
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(row => [row[0], row[2], row[3]])).toEqual([['2', '43', verbs[1]!.split(' ')[0]]])
})

test('call ends control: by is still a bound on starts, even when the later call has ended', () => {
  const result = probe([M, call(10800, 99, 'get --instance-id row')], undefined, [MISSING_TE], undefined, false,
    { ends: calls => endOf(calls, 1, 22000) })
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([MROW])
})

test('call ends control: an in-flight list keeps the real list-first PN pass and R4 exclusion', () => {
  const calls = [call(1000, 42, 'status --instance-id row'), call(2000, 42, 'read-pane --instance-id row --n-lines 1'),
    call(6000, 42, 'list --state waiting'), call(20000, 42, 'status --instance-id row')]
  const result = probe(calls, undefined, [], undefined, true,
    { validateRound: true, ends: lines => endOf(lines, 0, 11000) + endOf(lines, 2, 12000) })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('list at shim line 3 marked row missing')
})

const unusableEnds: Array<[string, (calls: string[]) => string]> = [
  ['empty', () => ''],
  ['unterminated', calls => endOf(calls, 2, 19999).trimEnd()],
  ['malformed complete record', () => 'end-v1\tinvalid\n'],
  ['overflowing end', calls => endOf(calls, 2, 19999).replace('1700000000.019999', '9999999999999999999999.019999')],
  ...([2, 3, 4, 5] as const).map(index => [`wrong pairing field ${index}`, (calls: string[]) => {
    const fields = endOf(calls, 2, 19999).trimEnd().split('\t')
    fields[index] = index === 5 ? '1700000000.005000' : '999'
    return fields.join('\t') + '\n'
  }] as [string, (calls: string[]) => string]),
  ['end before start', calls => endOf(calls, 2, 5000)],
  ['duplicate conflicting ends', calls => endOf(calls, 2, 19999) + endOf(calls, 2, 21000)],
  ['duplicate earlier end', calls => endOf(calls, 2, 21000) + endOf(calls, 2, 19999)],
]
test.each(unusableEnds)('call ends control: %s supplies no PN completion proof', (_, ends) => {
  const result = probe(pnEndCalls(), undefined, [], undefined, true, { sameMs: true, validateRound: true, ends })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('could have made it beside the status')
})

test('call ends control: an unreadable sidecar retains every candidate', () => {
  const result = probe(pnEndCalls(), undefined, [], undefined, true,
    { sameMs: true, validateRound: true, unreadableEnds: true })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('could have made it beside the status')
})

test('end sidecars do not change main-log physical marks, call counters or row projections', () => {
  const calls = [call(1000, 42, 'list --state waiting'),
    'fault\t1700000000.001100\t100\t42\tparent\tlist * swallow 1',
    'stop\t1700000000.001200\t200\t42\tparent\tstub-claude stopped', M]
  const check = [
    ...['_scenario_cscb_ad_scan', 'cscb_ad_count', '_scenario_log_mark', 'ad_shim_mark'].map(declaration),
    'SCENARIO_FMK=1', 'ad_shim_mark', 'cscb_ad_count ""', 'ad_cscb_calls row',
  ].join('\n')
  const without = probe(calls, undefined, [], undefined, false, { check })
  const withEnds = probe(calls, undefined, [], undefined, false, { check, ends: lines => endOf(lines, 0, 9999) })
  expect(without.status).toBe(0)
  expect(withEnds.status).toBe(0)
  expect(without.stdout).toStartWith('4\n2\n4\t1700000000.010200\t42\tstatus\trow\t')
  expect(withEnds.stdout).toBe(without.stdout)
  expect(withEnds.stderr).toBe('')
})

function consumerCheck(name: string) {
  const path = name === '17' ? 'test-17-fmk-launch-pending.sh' : name === '21' ? 'test-21-fmk-teardown.sh'
    : name === '28' ? 'test-28-fmk-provenance.sh' : 'test-23-fmk-latch-recheck.sh'
  const script = readFileSync(join(import.meta.dir, 'integration', path), 'utf8')
  const fn = (name: string) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))![0]
  const setup = [
    `ad_missing_tick() { printf '%s\\n' ${quote(tickOf('ad_recovery'))}; }`,
    'ad_release_at_least() { return 0; }', 'TEST_NAME=fixture SERVER_PID=42',
  ]
  if (name === '17') return [...setup, 'F_ID=row G_S=0 FC_POLL_S=1', fn('seconds_between'), fn('fc_marked_by_server'),
    'fc_marked_by_server fixture 1700000000000 1700000000 1700000000 1700000001 0 42 ""'].join('\n')
  if (name === '21') return [...setup, 'D_ID=row', fn('t21_check_missing_mark'),
    't21_check_missing_mark fixture 1700000000 0'].join('\n')
  if (name === '28') {
    const start = script.lastIndexOf('if ad_release_at_least 0.18.0; then', script.indexOf('tick="$(ad_missing_tick "${ID_B}"'))
    return [...setup, 'ID_B=row EDIT_MS_P=1700000000000 MARK_P=0 STEP=fixture',
      script.slice(start, script.indexOf('\n    sleep "${SETTLE_S}"', start)), 'fi'].join('\n')
  }
  return [...setup, 'RELABEL_EVENTS_MS=1700000000000 RELABEL_EVENTS_MARK=0 RELABEL_CALLERS_MARK=0 FIND_MISSING_LOOP_PID=99',
    'declare -A PERSONA_ID=([fixture]=row)', fn('check_relabel_marked'), 'check_relabel_marked fixture'].join('\n')
}

test.each(['17', '21', '28', 'relabel'].flatMap(name => [42, 43, 99, 98].map(parent => [name, parent] as const)))(
  'real consumer %s retains its owner rule for sole eligible parent %i beside a proven-finished read', (name, parent) => {
    const result = probe([call(1000, 42, 'get --instance-id row'), call(10200, parent, 'get --instance-id row')],
      undefined, [], undefined, false, { check: consumerCheck(name), ends: calls => endOf(calls, 0, 9999) })
    const passes = name === 'relabel' ? [42, 43, 99].includes(parent) : parent === 42
    expect(result.status).toBe(passes ? 0 : 1)
    if (passes) expect(result.stderr).toBe('')
    else expect(result.stderr).toMatch(/not the bot server|belongs to neither/)
  })

const shimSource = readFileSync(join(import.meta.dir, 'integration/fixtures/agent-director-shim.sh'), 'utf8')
const admittedVerbs = ['list', 'status', 'get', 'pause', 'sweep', 'find-missing']
const skippedVerbs = ['version', 'spawn', 'resume', 'send-keys', 'read-pane', 'hook', 'serve', 'kill', 'get-many', 'delete', 'kill-finished']
const selectorCases: Array<[string[], string, boolean]> = [
  ...admittedVerbs.map(verb => [[verb], verb, true] as [string[], string, boolean]),
  ...skippedVerbs.map(verb => [[verb], verb, false] as [string[], string, boolean]),
  [['--store-path', '/inert', 'list', '--home=/inert', '--tmux-command', '/inert'], 'list', true],
  [['--home=/inert', 'status', '--store-path', '/inert'], 'status', true],
  [['--store-path', 'list', 'version'], 'version', false],
  [['send-keys', '--text', 'list'], 'send-keys', false],
  [['--home', '/inert', 'spawn', '--label', 'get'], 'spawn', false],
  [['version', '--home'], 'version', true],
  [['--home=', 'version'], 'version', true],
  [['--create-if-missing', 'true', 'get'], '--create-if-missing', true],
  [['--unknown', 'list'], '--unknown', true],
  [['', 'version'], '', true],
  [[], '', true],
]
test.each(selectorCases)('observer selector %j agrees with decoder verb %s (observe %s)', (args, verb, observed) => {
  const root = mkdtempSync('/tmp/fmk-end-selector-')
  try {
    const selector = shimSource.match(/^call_needs_end\(\) \{[\s\S]*?^\}/m)?.[0]
    expect(selector).toBeDefined()
    const script = ['set -euo pipefail', selector!, declaration('_scenario_ad_verb'),
      `_L_WORDS=(${args.map(quote).join(' ')})`, '_scenario_ad_verb',
      'observed=0; if call_needs_end "${_L_WORDS[@]}"; then observed=1; fi',
      'printf "%s\\t%s\\n" "$_L_VERB" "$observed"'].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: hostSafeChildEnv(root, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${verb}\t${Number(observed)}\n`)
    assertNoLeak([result.stdout, result.stderr])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Run the real EXIT cleanup and its failure registration, including nested
// failures, against only files owned by this test. No native AD, panes or server.
function failureEvidence(calls: string[], trail: unknown[], mode: 'schedule' | 'attribution' | 'tick' | 'pass' | 'derived-pass' | 'missing' | 'mismatch' | 'reader' = 'schedule', free = '10') {
  const root = mkdtempSync('/tmp/fmk-pn-evidence-')
  const deriving = ['derived-pass', 'missing', 'mismatch', 'reader'].includes(mode)
  try {
    writeFileSync(join(root, 'shim'), calls.join('\n') + '\n')
    writeFileSync(join(root, 'roles'), 'proc\tserver\t42\t1\t1700000000.000000\ngone\t42\t1\t1700000000.030000\n')
    writeFileSync(join(root, 'ad-trail.jsonl'), trail.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
    const script = [
      'set -euo pipefail',
      `fail() { echo "$*" >&2; exit ${deriving ? 23 : 1}; }`,
      'require_ci_image() { :; }', 'require_scenario_home() { :; }', '_scenario_query_prep() { _scenario_record_load "${SCENARIO_CSCB_RECORD}"; }',
      'ad_store_peek() { echo \'{"labels":{"service":"cscb"}}\'; }',
      ...['_scenario_cleanup', 'on_failure', '_scenario_record_load', '_scenario_role_at',
        '_scenario_check_mark', '_scenario_in_window', '_scenario_to_us', '_scenario_split_line', '_scenario_read_log',
        '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id', '_scenario_us_text',
        '_scenario_mark_list_selects', 'ad_mark_caller', 'ad_missing_tick', 'ad_trail_events', '_scenario_shim_diagnostic',
        '_scenario_cscb_ad_rows', 'ad_cscb_calls'].map(declaration),
      ...['pn_evidence_rows', 'latch_failure_evidence', 'pn_failure_evidence', 'check_pn_marked', 'us_of', 'state_writes_of', 'pn_attribution_start',
        'check_latched_rounds', 'latch_rounds', 'rows_count', 'round_call_is'].map(pnDeclaration),
      '_SCENARIO_BEFORE_CLEANUP_HOOKS=(); _SCENARIO_STATE_DIRS=(); _SCENARIO_SERVER_PIDS=(); _SCENARIO_TRACKED_PIDS=(); _SCENARIO_EXIT_HOOKS=(); _SCENARIO_FAILURE_HOOKS=()',
      `SCENARIO_FMK=0; PN_KEY=panegone; ${deriving ? '' : `PN_END_MARK=${mode === 'attribution' ? 0 : 10}; PN_CLEAR_MS=1700000000005; PN_R4_STATUS=1`}`,
      `declare -A ROUND_END_MARK=([panegone]=14) FREE_MARK=([panegone]=${free}) PERSONA_ID=([panegone]=cscb_panegone)`,
      // Extract the actual registration, so losing it breaks the contract.
      test23.match(/^on_failure pn_failure_evidence$/m)?.[0] ?? 'false',
      'trap _scenario_cleanup EXIT',
      ...(deriving ? [
        'TEST_NAME=test-23; MIN_LATCHED_ROUNDS=2; STUB_MODE_AT_ONCE=at-once; PN_FIXTURE_READY=0',
        'declare -A LATCH_MARK=([panegone]=0) STILL_LINE=([panegone]=still) ROUND_HEAD=([panegone]=round)',
        'declare -A PERSONA_WORK=([panegone]=work) SEED_SID=([panegone]=session)',
        'wait_rounds() { PN_FIXTURE_READY=1; }; count_log() { echo 4; }; stub_mode() { :; }; end_session() { :; }; ad_release_at_least() { return 0; }',
        `ad_shim_mark() { if (( PN_FIXTURE_READY )); then echo ${calls.length - 1}; else echo 0; fi; }`,
        pnClearingEvent(),
        'MIN_LATCHED_ROUNDS=1; CALL_NONE=none; CALL_PROBE=probe; CALL_RESUME=resume; CALL_PLAIN_SPAWN=spawn; CALL_REUSE_SPAWN=reuse; CALL_PENDING_READ=pending',
        'declare -A FREE_ROUNDS=([panegone]=1) FREE_POSTS=([panegone]=1); FREE_MARK[panegone]=2',
        'declare -A POSTS_BEFORE=([panegone]=0) LATCH_US=([panegone]=1700000000000000) PREV_US=() CALL_OF=([panegone]=probe) READ_OF=()',
        'check_cadence() { :; }; latch_lines_of() { :; }; calls_of() { :; }',
        'check_latched_rounds panegone',
        'exit 0',
      ] : [mode === 'pass' ? 'exit 0' : mode === 'schedule' ? 'fail "clearing round failed"' :
        'check_pn_marked "part 2: panegone clear" cscb_panegone 14 1700000000.020000 1700000000.021000',
      ]),
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'bun', 'jq', 'date', 'rm', 'wc', 'tr'], extras: {
        SCENARIO_ROOT: root, SCENARIO_AD_ROOT: root, SCENARIO_AD_SHIM_LOG: join(root, 'shim'),
        SCENARIO_CSCB_RECORD: join(root, 'roles'), SCENARIO_FIXTURES: join(import.meta.dir, 'integration/fixtures'),
        CSCB_PKG_DIR: join(import.meta.dir, '..'),
      } }), encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    assertNoLeak([result.stdout, result.stderr])
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const pnTick = { event: 'ad.find_missing.tick', instance_id: 'cscb_panegone', source: 'ad_recovery',
  prior_state: 'waiting', new_state: 'missing', ts: '2023-11-14T22:13:20.010Z' }
const evidenceRows = (stderr: string) => stderr.split('\n').filter(line => line.startsWith('panegone-evidence: '))
  .map(line => JSON.parse(line.slice('panegone-evidence: '.length)))
const pnCalls = () => Array.from({ length: 16 }, (_, i) => call(i * 1000, i === 11 ? 99 : 42,
  i === 13 ? 'status --instance-id cscb_panegone' : 'list --state waiting'))

test('test-23 failure retains the numbered margin through round end, status and every state-write event', () => {
  const events = ['ad.find_missing.tick', 'ad.spawn.state_transition', 'ad.resume.observed', 'ad.resume.moved_to_pending',
    'ad.resume.restored', 'ad.spawn.reused', 'ad.spawn.reuse_restored']
  const sources = ['ad_recovery', 'ad_spawn_store', 'ad_polling', 'ad_resume', 'ad_resume', 'ad_spawn', 'ad_spawn']
  const calls = pnCalls()
  calls[5] = calls[5]!.replace(/^call/, 'stop')
  const result = failureEvidence(calls, events.map((event, i) => ({ ...pnTick, event, source: sources[i] })))
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  const rows = evidenceRows(result.stderr)
  expect(rows[0]).toEqual({ PN_CLEAR_MS: '1700000000005', PN_END_MARK: '10', PN_R4_STATUS: '1', through: '14',
    clearing_status_line: { line: '14', time: '1700000000.013000', kind: 'call', pid: '100', ppid: '42',
      verb: 'status', id: 'cscb_panegone', role: 'cscb' } })
  expect(rows.filter(r => r.shim).map(r => Number(r.shim.line))).toEqual(Array.from({ length: 13 }, (_, i) => i + 2))
  expect(rows.find(r => r.shim?.line === '12').shim.role).toBe('other')
  expect(rows.find(r => r.shim?.line === '6').shim).toMatchObject({ kind: 'stop', verb: null, id: null })
  expect(rows.filter(r => r.event).map(r => r.event)).toEqual(events)
  expect(rows.filter(r => r.event).map(r => r.source)).toEqual(sources)
  expect(rows.filter(r => r.event).every(r => r.prior_state === 'waiting' &&
    r.new_state === 'missing' && r.ts === pnTick.ts)).toBe(true)
})

test('test-23 failure before the clearing snapshot does not name an earlier status as the clearing status', () => {
  const result = failureEvidence(pnCalls(), [pnTick], 'schedule', '')
  expect(result.status).toBe(1)
  expect(evidenceRows(result.stderr)[0].clearing_status_line).toBeNull()
})

test.each(['missing', 'mismatch', 'reader'] as const)('test-23 %s derivation failure retains real EXIT evidence and its original failing exit', mode => {
  const token = fakeToken(BOT_TOKEN_PREFIX, `pn-${mode}`), url = sentinelInMessage(`pn-${mode}`)
  const calls = [call(1000, 42, `status --instance-id ${mode === 'missing' ? 'cscb_other' : 'cscb_panegone'}`),
    call(2000, 42, 'read-pane --instance-id cscb_panegone --n-lines 1'),
    mode === 'reader' ? 'malformed shim line' : call(3000, 42,
      mode === 'mismatch' ? 'status --instance-id cscb_panegone' : 'list --label service=cscb'),
    call(6000, 42, `list --label ${quote(token)}`), call(20200, 42, 'status --instance-id cscb_panegone')]
  const result = failureEvidence(calls, [{ ...pnTick, source: token, prior_state: url }], mode, '')
  // The real schedule normalizes a failed substitution to 1; the round
  // checker calls fail directly (23 here). Cleanup must preserve both.
  expect(result.status).toBe(mode === 'mismatch' ? 23 : 1)
  expect(result.stderr).toContain(mode === 'missing' ? 'no CSCB status of cscb_panegone at or before shim line 4' :
    mode === 'mismatch' ? 'disagrees with last still-latched round' : "is not in the shims' line format")
  const rows = evidenceRows(result.stderr)
  expect(rows[0]).toMatchObject({ PN_END_MARK: '0', PN_R4_STATUS: mode === 'mismatch' ? '3' : null,
    PN_CLEAR_MS: mode === 'mismatch' ? expect.stringMatching(/^[0-9]+$/) : null,
    // The mismatch fixture deliberately puts the unexpected status after
    // FREE_MARK=2; the unchanged diagnostic projection must retain it.
    clearing_status_line: mode === 'mismatch' ? { line: '3', time: '1700000000.003000', kind: 'call',
      pid: '100', ppid: '42', verb: 'status', id: 'cscb_panegone', role: 'cscb' } : null })
  expect(rows.filter(r => r.shim).map(r => r.shim.line)).toEqual(['1', '2', '3', '4', '5'])
  expect(rows.find(r => r.event)?.event).toBe('ad.find_missing.tick')
  expect(result.stdout).not.toContain('marked cscb_panegone missing')
})

test.each(['attribution', 'tick'] as const)('test-23 EXIT evidence survives a failure inside %s', mode => {
  const calls = pnCalls()
  // With FREE_MARK=0, the status is also visible to the diagnostic projection.
  calls[0] = call(1000, 99, 'get --instance-id cscb_panegone')
  calls[1] = call(2000, 42, 'list --state waiting')
  const result = failureEvidence(calls, [{ ...pnTick, source: mode === 'tick' ? 'ad_find_missing' : 'ad_recovery' }], mode, '0')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(mode === 'attribution' ? 'ambiguous' : 'not an active read')
  expect(evidenceRows(result.stderr).some(r => r.event === 'ad.find_missing.tick')).toBe(true)
})

test('test-23 failure evidence rejects secret-bearing metadata, invalid records and unknown enum words', () => {
  const token = fakeToken(BOT_TOKEN_PREFIX, 'pn-evidence'), url = sentinelInMessage('pn-evidence')
  const calls = pnCalls()
  calls[2] = call(2000, 42, `unknown-verb --instance-id ${quote(token)}`)
  calls[3] = call(3000, 42, `${quote(url)} --instance-id cscb_panegone`)
  calls[4] = token
  const result = failureEvidence(calls, [{ ...pnTick, source: token, prior_state: url, new_state: 'invented', ts: token },
    token, { ...pnTick, instance_id: 'cscb_other' }])
  expect(result.status).toBe(1)
  const rows = evidenceRows(result.stderr)
  const invalid = (value: string) => `invalid:sha256:${textHash(value)}:bytes:${Buffer.byteLength(value)}`
  expect(rows.find(r => r.shim?.line === '3').shim).toMatchObject({ verb: invalid('unknown-verb'), id: invalid(token) })
  expect(rows.find(r => r.shim?.line === '4').shim.verb).toBe(invalid(url))
  expect(rows.find(r => r.shim?.line === '5').shim.invalid).toBe(invalid(token))
  expect(rows.find(r => r.event)?.source).toBe(invalid(token))
  expect(rows.find(r => r.event)?.prior_state).toBe(invalid(url))
  expect(rows.find(r => r.event)?.new_state).toBe(invalid('invented'))
  expect(rows.filter(r => r.event)).toHaveLength(1)
  expect(rows.find(r => r.trail_line === 2).invalid).toBe(invalid(token))
})

test('test-23 passing exit emits no failure evidence', () => {
  const result = failureEvidence(pnCalls(), [pnTick], 'pass')
  expect(result.status).toBe(0)
  expect(result.stdout + result.stderr).toBe('')
})

test('test-23 successful derivation and exact round cross-check exit without a dump', () => {
  const result = failureEvidence([call(1000, 42, 'status --instance-id cscb_panegone'),
    call(2000, 42, 'read-pane --instance-id cscb_panegone --n-lines 1'), call(6000, 42, 'get --instance-id cscb_other'),
    call(20200, 42, 'status --instance-id cscb_panegone')], [pnTick], 'derived-pass', '')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('round 1: status at shim line 1, probe at 2')
  expect(result.stderr).toBe('')
})

/** The printed candidates, one array of fields per line. */
const rows = (stdout: string) => stdout.split('\n').filter(Boolean).map(line => line.split('\t'))

test('a permission list cannot take credit for a waiting row mark', () => {
  const result = probe([call(1000, 99, 'get --instance-id row'), call(2000, 42, 'list --state check_permission --label service=cscb')])
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([['1', '1700000000.001000', '99', 'get', 'other']])
})

test.each(['list --state=waiting --label=service=other', 'list --state pending,working', 'get --instance-id other'])('%s cannot select the marked row', args => {
  const result = probe([call(1000, 99, 'get --instance-id row'), call(2000, 42, args)])
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(r => r.at(-1))).toEqual(['other'])
})

test('matching state and every label allow list attribution', () => {
  const result = probe([call(1000, 42, 'list --state=waiting --label service=cscb --label mode=test')], { service: 'cscb', mode: 'test' })
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(r => r.slice(2))).toEqual([['42', 'list', 'cscb']])
})

test.each([false, true])('eligible harness and CSCB calls are ambiguous (harness later: %s)', later => {
  const result = probe([call(1000, later ? 42 : 99, 'get --instance-id row'), call(2000, later ? 99 : 42, 'status --instance-id row')])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
  expect(result.stdout).toBe('')
})

// b.mve: AD commits the mark (~.010500 here) and only then stamps the tick, so
// a call that starts after the marking call M (the bot server's status at
// .010200) but inside the tick's millisecond is no less eligible than M.
const M = call(10200, 42, 'status --instance-id row')
const MROW = ['1', '1700000000.010200', '42', 'status', 'cscb']
// The first read that saw the row missing returned at .010700 (test-19 leg G's missing_te).
const MISSING_TE = '1700000000.010700'

test('control: a call after the tick millisecond is no candidate', () => {
  const result = probe([M, call(11000, 42, 'get --instance-id row')])
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([MROW])
})

test.each([
  ['a same-server get', 42, 'get'],
  ['another CSCB process status', 43, 'status'],
  ['a CSCB pause', 42, 'pause'],
] as const)('%s started after the commit is returned with the marking call, not in its place', (_, parent, verb) => {
  const result = probe([M, call(10800, parent, `${verb} --instance-id row`)])
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([MROW, ['2', '1700000000.010800', String(parent), verb, 'cscb']])
})

test.each([
  ['a same-server get', 42, 'get'],
  ['another CSCB process status', 43, 'status'],
  ['a CSCB pause', 42, 'pause'],
  ['a harness get', 99, 'get'],
] as const)('by drops %s started after an observation of the mark', (_, parent, verb) => {
  const result = probe([M, call(10800, parent, `${verb} --instance-id row`)], { service: 'cscb' }, [MISSING_TE])
  expect(result.status).toBe(0)
  expect(rows(result.stdout)).toEqual([MROW])
})

test('by keeps a call started exactly at it', () => {
  const result = probe([M, call(10800, 43, 'get --instance-id row')], { service: 'cscb' }, ['1700000000.010800'])
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(r => r[0])).toEqual(['1', '2'])
})

test('by before every eligible call leaves no candidate', () => {
  const result = probe([M, call(10800, 42, 'get --instance-id row')], { service: 'cscb' }, ['1700000000.010100'])
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

test.each(['1700000000.0107', '-1', 'soon'])('by %s is not a six-decimal time', by => {
  const result = probe([M], { service: 'cscb' }, [by])
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain(`<by> '${by}'`)
})

test('a harness call after the commit still fails as ambiguous without a by', () => {
  const result = probe([M, call(10800, 99, 'get --instance-id row')])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
  expect(result.stdout).toBe('')
})

test('ambiguity is judged over every candidate, not against the last one', () => {
  const result = probe([call(10100, 99, 'get --instance-id row'), M, call(10800, 43, 'get --instance-id row')])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
})

test('a later CSCB find-missing in the millisecond is returned beside the marking one', () => {
  const result = probe([call(10200, 42, 'find-missing'), call(10800, 43, 'find-missing')], { service: 'cscb' }, [], 'ad_find_missing')
  expect(result.status).toBe(0)
  expect(rows(result.stdout).map(r => r.slice(0, 4))).toEqual([
    ['1', '1700000000.010200', '42', 'find-missing'],
    ['2', '1700000000.010800', '43', 'find-missing'],
  ])
})
