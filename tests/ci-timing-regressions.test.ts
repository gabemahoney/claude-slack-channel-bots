/** run the real scenario assertions over synthetic AD/receipt evidence.
 * No scenario is sourced, no native process is launched, and clocks are fake. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
import { test29ClosingFixture, test29PrinterFixture, test29PrinterBindings, test29SwitchBindings, test29SwitchCallOrder } from './test-helpers/test29-controls.ts'
import { test29RestartFixture, test29DiagnosticFixture, test29WatchdogFixture, test29DiagnosticExpectedItem } from './test-helpers/test29-queue.ts'
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
  const root = mkdtempSync(join(tmpdir(), 'cscb-timing-control-'))
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents)
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'SCENARIO_ROOT="$HOME"', 'SCENARIO_AD_ROOT="$HOME"', 'SLACK_STATE_DIR="$HOME"',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }', program,
    ].join('\n')], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'tail', 'grep', 'cat', 'wc', 'python3', 'bun'] }),
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
  test.each(['complete', 'accepted-only', 'missing-part', 'duplicate-part', 'foreign-seq', 'empty'])('test-29 restart still requires every receipt: %s', async mode => {
    const text = source('test-29-invited-channels.sh')
    const fixture = await test29RestartFixture(mode)
    const result = shell([
      polling, ...['queue_drained', 'queue_receipt_progress', 'wait_queue_drained', 'queue_drain_snapshot'].map(name => declaration(text, name)),
      ...fixture.bindings, 'DELIVERY_IDLE_WAIT_S=2', 'DELIVERY_MAX_WAIT_S=8', 'EVENT_WAIT_S=2',
      'thread_joins_saved() { return 0; }',
      block(text, 'queue_drain_snapshot before-restart', 'STORE_BEFORE_RESTART='),
    ].join('\n'), fixture.files)
    expect(result.status).toBe(mode === 'complete' ? 0 : 1)
    const snapshots = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(snapshots.map(s => [s.phase, s.persona])).toEqual(fixture.expectedSnapshots)
    expect(snapshots[0].accepted).toBe(mode === 'empty' ? 0 : 1)
    expect(snapshots[0].complete).toBe(mode === 'complete' ? 1 : 0)
    if (mode !== 'complete') expect(result.stderr).toContain('no-progress watchdog')
  })

  test('test-29 drain diagnostics bound detail and omit content and raw failures', async () => {
    const text = source('test-29-invited-channels.sh')
    const secret = fakeToken(BOT_TOKEN_PREFIX)
    const fixture = await test29DiagnosticFixture(secret)
    const result = shell([
      declaration(text, 'queue_drain_snapshot'),
      ...fixture.bindings,
      'queue_drain_snapshot restart-timeout',
    ].join('\n'), fixture.files)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(fixture.body)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(2)
    const snapshot = JSON.parse(lines[0]!)
    expect(snapshot.accepted).toBe(70)
    expect(snapshot.complete).toBe(0)
    expect(snapshot.incomplete).toBe(70)
    expect(snapshot.incomplete_items_omitted).toBe(62)
    expect(snapshot.first_incomplete).toHaveLength(8)
    expect(snapshot.first_incomplete[0]).toEqual(test29DiagnosticExpectedItem())
    expect(lines[1]).toBe('recorded: queue snapshot unavailable')
  })

  test.each(['progressing', 'stalled', 'repeated', 'regressed', 'foreign', 'new-work', 'reminders', 'attempts', 'stale', 'malformed', 'unreadable', 'changed-identity', 'overall-limit'])('test-29 exact-workload progress watchdog: %s', async mode => {
    const text = source('test-29-invited-channels.sh')
    const fixture = await test29WatchdogFixture(mode)
    const result = shell([
      polling, ...['queue_drained', 'queue_receipt_progress', 'wait_queue_drained'].map(name => declaration(text, name)),
      block(text, 'DELIVERY_IDLE_WAIT_S=', '# --- Prerequisites'),
      ...(mode === 'overall-limit' ? ['DELIVERY_MAX_WAIT_S=300'] : []),
      `mode=${mode}`,
      ...fixture.bindings,
      'cat "${TEST29_STAGE_PREFIX}0" > "$TEST29_CURRENT"',
      'sleep() { local now; read -r now < "$HOME/clock"; now=$((now+60000)); printf "%s\\n" "$now" > "$HOME/clock"; cat "$TEST29_STAGE_PREFIX$((now/60000))" > "$TEST29_CURRENT"; if [[ "$mode" == unreadable ]]; then DELIVERIES_FILE[$TEST29_QUEUE_KEY]="$TEST29_MISSING"; fi; }',
      'queue_drain_snapshot() { printf "diagnostic clock="; cat "$HOME/clock"; }',
      'wait_queue_drained "$TEST29_QUEUE_KEY" control', 'cat "$HOME/clock"',
    ].join('\n'), fixture.files)
    expect(result.status).toBe(mode === 'progressing' ? 0 : 1)
    if (mode === 'progressing') expect(result.stdout.trim()).toBe('240000')
    else {
      expect(result.stderr).toContain(mode === 'overall-limit' ? 'overall watchdog' : 'no-progress watchdog')
      expect(result.stdout.trim()).toBe(`diagnostic clock=${mode === 'overall-limit' ? 300000 : 180000}`)
    }
  })

  test.each(['valid', 'missing', 'duplicate', 'wrong-name', 'wrong-key', 'wrong-source', 'wrong-channel', 'wrong-ts', 'wrong-sender', 'missing-thread', 'extra-thread', 'unknown-suffix', 'trailing-junk'])('test-29 closing received set: %s', mode => {
    const text = source('test-29-invited-channels.sh')
    const check = block(text, 'import collections, glob, json, os, re, sys', '\nEOF')
    const fixture = test29ClosingFixture(mode)
    const result = shell(`python3 "$HOME/check.py" "$HOME" "$HOME" ${fixture.argv}`, {
      'check.py': check, ...fixture.files,
    })
    expect(result.status).toBe(mode === 'valid' ? 0 : 1)
    if (mode === 'valid') expect(result.stdout).toContain('2 exact acceptances')
  })

  test.each(['kept', 'unredirected-control', 'assertion-fails'])('test-29 assertion printer retains earlier diagnostics: %s', mode => {
    const text = source('test-29-invited-channels.sh')
    let call = block(text, 'bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sharedAuthorityPreserved', '\nfor dir in')
    if (mode === 'unredirected-control') call = call.replace(' > /dev/null', '')
    // Exercise the printer's actual output operation without its image-only
    // imports. A regular append-open stdout reproduces the runner's log sink.
    const output = source('fixtures/fmk-texts.ts').match(/^  await Bun.write\(Bun.stdout, value\)$/m)![0]
    const result = shell([
      ...test29PrinterBindings(),
      mode === 'assertion-fails' ? 'bun() { return 1; }' : 'bun() { command bun "$HOME/printer.ts"; }',
      '( printf "before-restart\\n";', call, 'printf "after-restart\\n" ) >> "$HOME/retained.log" 2>&1',
      'cat "$HOME/retained.log"',
    ].join('\n'), test29PrinterFixture(output))
    expect(result.status).toBe(mode === 'assertion-fails' ? 1 : 0)
    if (mode !== 'assertion-fails') expect(result.stdout).toBe(mode === 'kept' ? 'before-restart\nafter-restart\n' : 'after-restart\n')
  })

  test.each([
    ['switch-off', 'kept', ''], ['fungible', 'kept', ''],
    ...['configuration_request', 'configuration_application_preserved', 'configuration_record_matches'].map(helper => ['switch-off', 'unredirected', helper]),
    ...['operatorReviewPending', 'sharedApplicationPreserved', 'sharedConfigurationMatches'].map(printer => ['switch-off', 'fails', printer]),
  ])('test-29 switch retains restart diagnostics: %s %s %s', (shape, mode, target) => {
    const text = source('test-29-invited-channels.sh')
    let confirm = declaration(text, 'confirm_switch')
    if (mode === 'unredirected') {
      // Restore one reviewed defect at a time, leaving the other calls protected.
      confirm = confirm.replace(new RegExp(`^(\\s*${target} [^\\n]*) > /dev/null`, 'gm'), '$1')
    }
    const output = source('fixtures/fmk-texts.ts').match(/^  await Bun.write\(Bun.stdout, value\)$/m)![0]
    const result = shell([
      polling, confirm,
      ...['configuration_request', 'configuration_application_preserved', 'configuration_record_matches'].map(name => declaration(scenario, name)),
      // Only the assertion call chain and printer output are live. No scenario
      // is sourced; configuration, server and file-move dependencies are inert.
      ...['require_ci_image', 'require_scenario_state', 'cp', 'mv', 'write_persona_config', 'wait_for_file', 'wait_for_count', 'pending_has_line', 'check_pending_layout'].map(name => `${name}() { :; }`),
      'launch_counts() { printf "0"; }', 'count_log() { printf "0"; }',
      'sleep() { printf "30000\\n" > "$HOME/clock"; }',
      ...test29PrinterBindings(true),
      ...test29SwitchBindings(),
      `FAIL_PRINTER=${mode === 'fails' ? target : 'none'}`,
      'bun() { printf "%s\\n" "$2" >> "$HOME/calls"; command bun "$HOME/printer.ts" "$2" "$FAIL_PRINTER"; }',
      // Collect the failed log without invoking the subshell in an if/|| list:
      // that would disable errexit inside confirm_switch and hide a failure.
      'set +e', '( set -e; printf "before-restart\\n";',
      block(text, 'bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sharedAuthorityPreserved', '\nfor dir in'),
      'printf "after-restart\\n"',
      block(text, `confirm_switch ${shape} "`, '\n'),
      'printf "after-switch\\n" ) >> "$HOME/retained.log" 2>&1',
      'status=$?', 'set -e', 'cat "$HOME/retained.log"', 'printf "calls:\\n"', 'cat "$HOME/calls"', 'exit "$status"',
    ].join('\n'), test29PrinterFixture(output, true))
    expect(result.status).toBe(mode === 'fails' ? 1 : 0)
    const [log, calls] = result.stdout.split('calls:\n')
    const order = test29SwitchCallOrder()
    expect([...new Set(calls!.trim().split('\n'))]).toEqual(mode === 'fails' ? order.slice(0, order.indexOf(target!) + 1) : order)
    if (mode === 'unredirected') expect(log).toBe('after-switch\n')
    else {
      expect(log).toStartWith('before-restart\nafter-restart\n')
      if (mode === 'fails') {
        expect(log).toContain(`assertion failed: ${target}\n`)
        expect(log).not.toContain('after-switch')
      } else expect(log).toBe('before-restart\nafter-restart\nafter-switch\n')
    }
  })

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
  ] as const)('retains 20 samples and exact p95 bounds: %s/%s/%s', (samples, typing, delivery, passes) => {
    const text = source('fixtures/transcript-receipts.ts')
    const check = new Function('result', 'count', 'percentile', 'console', block(text, '        const n = Number(count)', '\n      }'))
    const timings = Array.from({ length: samples }, () => ({ typing_ms: typing, delivery_ms: delivery }))
    const run = () => check({ timings }, '20', percentile, { log() {} })
    if (passes) expect(run).not.toThrow()
    else expect(run).toThrow(samples < 20 ? 'Insufficient latency samples' : 'latency exceeded')
    const script = source('test-32-fmk-real-order.sh')
    expect(script).toContain('for n in {1..20}; do')
    expect(script).toContain('real_assert_latency "${REAL_KEY}" 20')
  })

  test('rejects the observed 18-fast/two-slow sample shape without dropping either slow trial', () => {
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
    expect(() => check({ timings }, '20', percentile, { log: (line: string) => recorded.push(line) })).toThrow('latency exceeded')
    expect(recorded).toEqual(['recorded: p95 typing_start_ms=2467.921142578125 delivery_ms=4043 samples=20'])
  })
})
