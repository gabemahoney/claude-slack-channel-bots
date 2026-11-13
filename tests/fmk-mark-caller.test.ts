/** Attribution must not let an unrelated permission list hide a harness mark. */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const source = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const declaration = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? ''
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const call = (us: number, parent: number, args: string) => `call\t1700000000.${us.toString().padStart(6, '0')}\t100\t${parent}\tparent\t${args}`
const tick = JSON.stringify({ instance_id: 'row', prior_state: 'waiting', source: 'ad_recovery', ts: '2023-11-14T22:13:20.010Z' })

function probe(calls: string[], labels: Record<string, string> = { service: 'cscb' }) {
  const root = mkdtempSync('/tmp/fmk-mark-caller-')
  const script = [
    'set -euo pipefail',
    'fail() { echo "$*" >&2; exit 1; }',
    'require_ci_image() { :; }',
    'require_scenario_home() { :; }',
    '_scenario_query_prep() { :; }',
    '_scenario_read_log() { local -n out="$3"; out=("${fixture_lines[@]}"); }',
    '_scenario_role_at() { [[ "$1" == 42 ]]; }',
    `ad_store_peek() { printf '%s\\n' ${quote(JSON.stringify({ labels }))}; }`,
    'SCENARIO_AD_SHIM_LOG=fixture',
    `fixture_lines=(${calls.map(quote).join(' ')})`,
    ...['_scenario_check_mark', '_scenario_in_window', '_scenario_to_us', '_scenario_split_line',
      '_scenario_eval_words', '_scenario_decode_words', '_scenario_ad_verb', '_scenario_ad_id',
      '_scenario_us_text', '_scenario_mark_list_selects', 'ad_mark_caller'].map(declaration),
    `ad_mark_caller ${quote(tick)} 0`,
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

test('a permission list cannot take credit for a waiting row mark', () => {
  const result = probe([call(1000, 99, 'get --instance-id row'), call(2000, 42, 'list --state check_permission --label service=cscb')])
  expect(result.status).toBe(0)
  expect(result.stdout.trim().split('\t').slice(2)).toEqual(['99', 'get', 'other'])
})

test.each(['list --state=waiting --label=service=other', 'list --state pending,working', 'get --instance-id other'])('%s cannot select the marked row', args => {
  const result = probe([call(1000, 99, 'get --instance-id row'), call(2000, 42, args)])
  expect(result.status).toBe(0)
  expect(result.stdout.trim().split('\t').at(-1)).toBe('other')
})

test('matching state and every label allow list attribution', () => {
  const result = probe([call(1000, 42, 'list --state=waiting --label service=cscb --label mode=test')], { service: 'cscb', mode: 'test' })
  expect(result.status).toBe(0)
  expect(result.stdout.trim().split('\t').slice(2)).toEqual(['42', 'list', 'cscb'])
})

test.each([false, true])('eligible harness and CSCB calls are ambiguous (harness later: %s)', later => {
  const result = probe([call(1000, later ? 42 : 99, 'get --instance-id row'), call(2000, later ? 99 : 42, 'status --instance-id row')])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ambiguous')
  expect(result.stdout).toBe('')
})
