/** Attribution returns every call that could have made a mark, never one picked call. */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const source = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const declaration = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const call = (us: number, parent: number, args: string) => `call\t1700000000.${us.toString().padStart(6, '0')}\t100\t${parent}\tparent\t${args}`
// Stamped in millisecond .010: eligible calls start before 1700000000.011000.
const tickOf = (tickSource: string) => JSON.stringify({ instance_id: 'row', prior_state: 'waiting', source: tickSource, ts: '2023-11-14T22:13:20.010Z' })

// 42 is the bot server and 43 another CSCB process; any other parent is not CSCB's.
function probe(calls: string[], labels: Record<string, string> = { service: 'cscb' }, extra: string[] = [], tickSource = 'ad_recovery') {
  const root = mkdtempSync('/tmp/fmk-mark-caller-')
  const script = [
    'set -euo pipefail',
    'fail() { echo "$*" >&2; exit 1; }',
    'require_ci_image() { :; }',
    'require_scenario_home() { :; }',
    '_scenario_query_prep() { :; }',
    '_scenario_read_log() { local -n out="$3"; out=("${fixture_lines[@]}"); }',
    '_scenario_role_at() { [[ "$1" == 42 || "$1" == 43 ]]; }',
    `ad_store_peek() { printf '%s\\n' ${quote(JSON.stringify({ labels }))}; }`,
    'SCENARIO_AD_SHIM_LOG=fixture',
    `fixture_lines=(${calls.map(quote).join(' ')})`,
    ...['_scenario_check_mark', '_scenario_in_window', '_scenario_to_us', '_scenario_split_line',
      '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id',
      '_scenario_us_text', '_scenario_mark_list_selects', 'ad_mark_caller'].map(declaration),
    `ad_mark_caller ${[tickOf(tickSource), '0', ...extra].map(quote).join(' ')}`,
  ].join('\n')
  try {
    const result = spawnSync('bash', ['-c', script], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'date'] }), encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}

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
