/** Synthetic concurrent-append boundaries; no agent, tmux or Docker process. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readShimLog, shimSends } from './integration/fixtures/transcript-receipts.ts'
import { codexShimCalls } from './real-agent/codex-gate.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(log: string) {
  const root = mkdtempSync(join(tmpdir(), 'shim-log-reader-')); roots.push(root)
  const path = join(root, 'shim.log'); writeFileSync(path, log)
  return { root, path }
}
const call = 'call\t1.000000\t20\t10\tbun\tsend-keys --instance-id synthetic --text hello\n'
const malformed = 'call\t2.000000\t21'
const boundaries = [
  { name: 'unterminated malformed tail', log: call + malformed, complete: call },
  { name: 'empty log', log: '', complete: '' },
  { name: 'no newline', log: malformed, complete: '' },
  { name: 'well-formed unterminated tail', log: call + call.trimEnd(), complete: call },
  { name: 'complete last line', log: call + call, complete: call + call },
]

describe('shared shim-log reader', () => {
  test.each(boundaries)('$name preserves exactly the complete prefix', ({ log, complete }) => {
    const { path } = fixture(log), captured = readShimLog(path)
    expect(captured).toBe(complete)
    expect(shimSends(captured).map(s => s.text)).toEqual(complete ? complete.split('\n').filter(Boolean).map(() => 'hello') : [])
  })
  test.each([
    { name: 'same malformed tail with newline', log: call + malformed + '\n', error: 'Malformed shim record' },
    { name: 'malformed middle before partial tail', log: malformed + '\n' + call + malformed, error: 'Malformed shim record' },
    { name: 'complete call with bad quoting', log: call.replace('--text hello', () => "--text $'unclosed"), error: 'Unclosed shim quote' },
  ])('$name still fails with the existing parser error', ({ log, error }) => {
    const { path } = fixture(log)
    expect(() => shimSends(readShimLog(path))).toThrow(error)
  })
})

describe('Codex shim call parser', () => {
  test.each(boundaries)('$name consumes only complete records from a captured string', ({ log, complete }) => {
    expect(codexShimCalls(log).map(c => c.text)).toEqual(complete ? complete.split('\n').filter(Boolean).map(() => 'hello') : [])
  })
  test.each([call + malformed + '\n', malformed + '\n' + call + malformed])('complete malformed call still fails', log => {
    expect(() => codexShimCalls(log)).toThrow('invalid shim call')
  })
})

const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
function readShellLog(log: string) {
  const { root, path } = fixture(log)
  // Extract only the real reader and its pure parsing dependencies. Sourcing
  // scenario.sh would run setup that is restricted to the CI image.
  const names = ['_scenario_to_us', '_scenario_split_line', '_scenario_eval_words', '_scenario_decode_words', '_scenario_read_log']
  const declarations = names.map(name => {
    const source = scenario.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0]
    if (!source) throw new Error(`Missing shell function ${name}`)
    return source
  }).join('\n')
  const script = ['set -euo pipefail', declarations,
    'fail() { printf "%s\\n" "$1" >&2; exit 1; }', '_scenario_shim_diagnostic() { :; }',
    'lines=()', '_scenario_read_log boundary "$1" lines', 'if (( ${#lines[@]} )); then printf "%s\\n" "${lines[@]}"; fi',
  ].join('\n')
  const child = spawnSync('bash', ['-c', script, 'shim-log-control', path], {
    env: hostSafeChildEnv(root, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000,
  })
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}
describe('scenario shim-log reader', () => {
  test.each(boundaries)('$name preserves exactly the complete prefix', ({ log, complete }) => {
    expect(readShellLog(log)).toEqual({ status: 0, stdout: complete, stderr: '' })
  })
  test.each([
    { name: 'same malformed tail with newline', log: call + malformed + '\n', line: 2 },
    { name: 'malformed middle before partial tail', log: malformed + '\n' + call + malformed, line: 1 },
    { name: 'complete call with bad quoting', log: call.replace('--text hello', () => "--text $'unclosed"), line: 1 },
    ...['fault', 'stop'].map(kind => ({ name: `complete malformed ${kind}`, log: call + kind + '\t2.000000\n', line: 2 })),
  ])('$name still fails with the existing format error', ({ log, line }) => {
    const result = readShellLog(log)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`line ${line} is not in the shims' line format`)
  })
})

describe('scenario complete-line output', () => {
  const cases = [
    ...boundaries,
    { name: 'same malformed tail with newline', log: call + malformed + '\n', complete: call + malformed + '\n' },
    { name: 'empty complete line before partial tail', log: '\n' + malformed, complete: '\n' },
  ]
  test.each(cases.flatMap(boundary => ['count', 'output'].map(projection => ({ ...boundary, projection }))))('$name: $projection includes only complete lines', ({ log, complete, projection }) => {
    const { root, path } = fixture(log)
    const declaration = scenario.match(/^_scenario_complete_log\(\) \{[\s\S]*?^\}/m)?.[0]
    if (!declaration) throw new Error('Missing shell function _scenario_complete_log')
    const child = spawnSync('bash', ['-c', [
      'set -euo pipefail', declaration,
      'mapfile -t lines < <(_scenario_complete_log "$1")',
      'printf "%s\\n" "${#lines[@]}"',
      'if (( ${#lines[@]} )); then printf "%s\\n" "${lines[@]}"; fi',
    ].join('\n'), 'complete-line-control', path], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'awk'] }), encoding: 'utf8', timeout: 5000,
    })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect(child.status).toBe(0); expect(child.stderr).toBe('')
    const newline = child.stdout.indexOf('\n')
    if (projection === 'count') expect(Number(child.stdout.slice(0, newline))).toBe(complete.split('\n').length - 1)
    else expect(child.stdout.slice(newline + 1)).toBe(complete)
  })
})
