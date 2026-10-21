/** b.pb8: run the real scenario assertions over synthetic AD/receipt evidence.
 * No scenario is sourced, no native process is launched, and clocks are fake. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { percentile } from './integration/fixtures/transcript-receipts.ts'

const integration = join(import.meta.dir, 'integration')
const source = (file: string) => readFileSync(join(integration, file), 'utf8')
const scenario = source('lib/scenario.sh'), real = source('lib/real-scenario.sh')
function declaration(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`Missing shell function ${name}`)
  return match[0]
}
function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start), to = text.indexOf(end, from)
  if (from < 0 || to < from) throw new Error(`Missing shell block ${start}`)
  return text.slice(from, to)
}
function shell(program: string, files: Record<string, string> = {}) {
  const root = mkdtempSync('/tmp/cscb-timing-control-')
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents)
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'SCENARIO_ROOT="$HOME"', 'SCENARIO_AD_ROOT="$HOME"', 'SLACK_STATE_DIR="$HOME"',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }', program,
    ].join('\n')], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'tail', 'grep', 'cat', 'wc'] }),
      encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
    assertNoLeak({ stdout: result.stdout, stderr: result.stderr })
    return result
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const instance = 'cscb_control', session = 'resumed-session'
const event = (name: string, seconds: number, fields = {}) => ({
  event: name, instance_id: instance, ts: new Date(seconds * 1000).toISOString(), ...fields,
})
const polling = [
  declaration(scenario, '_scenario_poll_until'), declaration(scenario, '_scenario_check_timeout'), declaration(scenario, 'wait_until'),
  'SCENARIO_POLL_S=1', 'LEG_B_WAIT_S=3', 'ROW_WAIT_S=3', 'printf "0\\n" > "$HOME/clock"',
  '_scenario_now_ms() { cat "$HOME/clock"; }',
  'sleep() { local now; read -r now < "$HOME/clock"; printf "%s\\n" "$((now+1000))" > "$HOME/clock"; }',
].join('\n')

describe('retained timing regressions', () => {
  test.each(['late-hook', 'late-transition', 'delayed-publication', 'wrong-session', 'wrong-instance', 'unapplied', 'missing-hook', 'missing-transition', 'missing-pending', 'stale-hook', 'second-resume'])('test-13 correlates applied hook/transition without cross-observer ordering: %s', mode => {
    const text = source('test-13-fmk-switch-over.sh')
    const proof = block(text, '    # It read pending until', '    for verb in read-pane send-keys; do')
    const events = [
      event('ad.resume.moved_to_pending', 2),
      event('ad.spawn.state_transition', mode === 'late-transition' ? 6 : 3, { prior_state: 'pending', new_state: 'waiting', triggering_event_name: 'SessionStart' }),
      event('ad.hook.fired', mode === 'stale-hook' ? 0 : 5, { event_name: 'SessionStart', session_id: mode === 'wrong-session' ? 'other' : session, upsert_outcome: mode === 'unapplied' ? 'no_change' : 'updated' }),
    ]
    if (mode === 'wrong-instance') events[2]!.instance_id = 'cscb_other'
    if (mode === 'missing-hook') events.splice(2, 1)
    if (mode === 'missing-transition') events.splice(1, 1)
    if (mode === 'missing-pending') events.splice(0, 1)
    if (mode === 'second-resume') events.push(event('ad.resume.moved_to_pending', 4))
    const late = mode === 'delayed-publication' ? events.splice(1) : []
    const result = shell([
      polling, declaration(text, 'lines_after'), declaration(text, 't13_resume_reported'),
      ...(late.length ? ['sleep() { cat "$HOME/late.jsonl" >> "$HOME/trail.jsonl"; : > "$HOME/late.jsonl"; }'] : []),
      'AD_TRAIL="$HOME/trail.jsonl"', 'LEG_B_TRAIL_FROM=0', 'LEG_B_READS="$HOME/reads.tsv"',
      `id=${instance}`, 'last_resume_us=1000000', `declare -A SID_OF=([${instance}]=${session})`, proof,
    ].join('\n'), {
      'trail.jsonl': jsonl(events), 'late.jsonl': jsonl(late),
      'reads.tsv': `2100000 2200000 ${instance} pending launch-start\n3500000 4000000 ${instance} waiting -\n`,
    })
    expect(result.status).toBe(['late-hook', 'late-transition', 'delayed-publication'].includes(mode) ? 0 : 1)
  })

  test.each(['missed-window', 'delayed-publication', 'wrong-session', 'wrong-instance', 'unapplied', 'missing-transition', 'stale-transition', 'stale-hook', 'no-waiting', 'no-session'])('test-19 durable pending evidence when observer misses the window: %s', mode => {
    const text = source('test-19-fmk-reuse.sh')
    const events = [
      event('ad.spawn.state_transition', mode === 'stale-transition' ? 0 : 2, { prior_state: 'pending', new_state: 'waiting', triggering_event_name: 'SessionStart' }),
      event('ad.hook.fired', mode === 'stale-hook' ? 0 : 3, { event_name: 'SessionStart', session_id: mode === 'wrong-session' ? 'other' : session, upsert_outcome: mode === 'unapplied' ? 'no_change' : 'updated' }),
    ]
    if (mode === 'wrong-instance') events[0]!.instance_id = 'cscb_other'
    if (mode === 'missing-transition') events.shift()
    const result = shell([
      polling, declaration(text, 't19_check_pending_then_waiting'), declaration(text, 't19_reported'), declaration(scenario, 'ad_trail_events'),
      ...(mode === 'delayed-publication' ? ['sleep() { cat "$HOME/late.jsonl" > "$HOME/ad-trail.jsonl"; }'] : []),
      'require_ci_image() { :; }', 'require_scenario_home() { :; }',
      'TEST_NAME=control', 'POLL_PERIOD_S=0.05', 'MARK_TIME=1',
      't19_lines() { wc -l < "$1"; }',
      `t19_check_pending_then_waiting "$HOME/poll.jsonl" ${instance} control`,
    ].join('\n'), {
      'poll.jsonl': jsonl([{ t: '4', state: mode === 'no-waiting' ? 'working' : 'waiting', launch_started_at: '', session_id: mode === 'no-session' ? '' : session }]),
      'ad-trail.jsonl': mode === 'delayed-publication' ? '' : jsonl(events), 'late.jsonl': jsonl(events),
    })
    expect(result.status).toBe(['missed-window', 'delayed-publication'].includes(mode) ? 0 : 1)
  })

  test.each(['progressing', 'stalled', 'repeated', 'regressed', 'unreadable', 'never-ready'])('test-32 progress watchdog: %s', mode => {
    const result = shell([
      declaration(real, 'real_wait_delivery'), declaration(scenario, '_scenario_poll_until'), declaration(scenario, '_scenario_check_timeout'),
      'REAL_DELIVERY_WAIT_S=180', 'REAL_DELIVERY_MAX_WAIT_S=300', 'SCENARIO_POLL_S=1',
      'REAL_RECEIPTS=receipts', 'SCENARIO_AD_SHIM_LOG=shim', 'printf "0\\n" > "$HOME/clock"',
      '_scenario_now_ms() { cat "$HOME/clock"; }',
      'sleep() { local now; read -r now < "$HOME/clock"; printf "%s\\n" "$((now+60000))" > "$HOME/clock"; }',
      `mode=${mode}`,
      'bun() { local now; read -r now < "$HOME/clock"; if [[ "$2" == progress ]]; then case "$mode" in stalled) echo 0;; repeated) echo 1;; regressed) ((now == 0)) && echo 2 || echo 1;; unreadable) return 1;; *) echo "$((now/60000))";; esac; else [[ "$mode" == progressing ]] && ((now >= 240000)); fi; }',
      '_real_delivery_diagnostic() { echo diagnostic; }',
      'real_wait_delivery control 4',
    ].join('\n'))
    expect(result.status).toBe(mode === 'progressing' ? 0 : 1)
    if (mode !== 'progressing') {
      expect(result.stdout).toContain('diagnostic')
      expect(result.stderr).toContain(mode === 'never-ready' ? 'overall watchdog' : 'no-progress watchdog')
    }
  })

  test('test-35 rejects an old connection for a same-session resume', () => {
    const result = shell([
      declaration(real, '_real_connected'),
      `real_instance() { echo ${instance}; }`,
      `real_ad() { echo '{"state":"waiting","instance_id":"${instance}","session_id":"${session}","labels":{"tag_prompt":"1"}}'; }`,
      '_real_connected control "" 1',
    ].join('\n'), { 'server.log': '[slack] Session connected: persona "control" (key=control)\n' })
    expect(result.status).toBe(1)
  })

  test.each(['restart', 'resume', 'fresh', 'upgrade'])('test-35 %s captures connection cursor after stop and requires a new own connection', mode => {
    const text = source('test-35-fmk-real-restarts.sh')
    const restart = block(text, '    OLD_SESSION=', '    NEW_SESSION=')
    for (const evidence of ['new', 'stale', 'foreign', 'old-row']) {
      const result = shell([
        polling, declaration(real, 'real_wait_launch'), declaration(real, '_real_connected'),
        `mode=${mode}`, `evidence=${evidence}`, 'REAL_KEY=control', 'REAL_LAUNCH_WAIT_S=3', 'started=0',
        `real_instance() { echo ${instance}; }`, 'real_wait_idle() { :; }', 'ad_store_edit() { :; }',
        'stop_server() { echo \'[slack] Session connected: persona "control" (key=control)\' >> "$HOME/server.log"; }',
        'start_server() { started=1; if [[ "$evidence" == new || "$evidence" == old-row ]]; then echo \'[slack] Session connected: persona "control" (key=control)\' >> "$HOME/server.log"; elif [[ "$evidence" == foreign ]]; then echo \'[slack] Session connected: persona "other" (key=other)\' >> "$HOME/server.log"; fi; }',
        `real_ad() { local sid=${session}; if [[ "$started" == 1 && "$evidence" != old-row && ( "$mode" == fresh || "$mode" == upgrade ) ]]; then sid=new-session; fi; printf '{"state":"waiting","instance_id":"${instance}","session_id":"%s","labels":{"tag_prompt":"1"}}\\n' "$sid"; }`,
        restart,
      ].join('\n'), { 'server.log': '' })
      const pass = evidence === 'new' || (evidence === 'old-row' && ['restart', 'resume'].includes(mode))
      expect({ mode, evidence, status: result.status }).toEqual({ mode, evidence, status: pass ? 0 : 1 })
    }
  })

  test.each([
    [20, 2000, 10000, true], [19, 2000, 10000, false],
    [20, 2000.001, 10000, false], [20, 2000, 10000.001, false],
  ] as const)('AC76 retains 20 samples and exact p95 bounds: %s/%s/%s', (samples, typing, delivery, passes) => {
    const text = source('fixtures/transcript-receipts.ts')
    const check = new Function('result', 'count', 'percentile', 'console', block(text, '        const n = Number(count)', '\n      }'))
    const timings = Array.from({ length: samples }, () => ({ typing_ms: typing, delivery_ms: delivery }))
    const run = () => check({ timings }, '20', percentile, { log() {} })
    if (passes) expect(run).not.toThrow()
    else expect(run).toThrow(samples < 20 ? 'Insufficient latency samples' : 'AC76 latency exceeded')
    const script = source('test-32-fmk-real-order.sh')
    expect(script).toContain('for n in {1..20}; do')
    expect(script).toContain('real_assert_latency "${REAL_KEY}" 20')
  })

  test('AC76 rejects the observed 18-fast/two-slow sample shape without dropping either slow trial', () => {
    // Numeric-only projection of run 20261021t182831z-lmk9ayre's final 20
    // originals. This tests the oracle, not the cause of either slow sample.
    const timings = [
      [37.5419921875, 1608], [36.427978515625, 1607],
      [2467.921142578125, 4043], [4574.385009765625, 6148],
      [38.985107421875, 1612], [38.656005859375, 1612],
      [34.611083984375, 1614], [37.096923828125, 1613],
      [36.7958984375, 1611], [39.1708984375, 1616],
      [38.442138671875, 1612], [37.265869140625, 1610],
      [39.580078125, 1613], [39.427001953125, 1615],
      [39.4990234375, 1617], [38.7509765625, 1618],
      [39.678955078125, 1614], [41.306884765625, 1622],
      [41.284912109375, 1622], [40.635009765625, 1615],
    ].map(([typing_ms, delivery_ms]) => ({ typing_ms: typing_ms!, delivery_ms: delivery_ms! }))
    expect(timings.filter(t => t.typing_ms <= 2000)).toHaveLength(18)
    expect(percentile(timings.map(t => t.typing_ms), .95)).toBe(2467.921142578125)
    expect(percentile(timings.map(t => t.delivery_ms), .95)).toBe(4043)
    const check = new Function('result', 'count', 'percentile', 'console',
      block(source('fixtures/transcript-receipts.ts'), '        const n = Number(count)', '\n      }'))
    const recorded: string[] = []
    expect(() => check({ timings }, '20', percentile, { log: (line: string) => recorded.push(line) })).toThrow('AC76 latency exceeded')
    expect(recorded).toEqual(['recorded: p95 typing_start_ms=2467.921142578125 delivery_ms=4043 samples=20'])
  })
})
