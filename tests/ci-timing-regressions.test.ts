/** run the real scenario assertions over synthetic AD/receipt evidence.
 * No scenario is sourced, no native process is launched, and clocks are fake. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { assertNoLeak, fakeToken, BOT_TOKEN_PREFIX } from './test-helpers/credentials.ts'
import { test29ClosingFixture, test29EvidencePrinter, test29PrinterFixture, test29PrinterBindings, test29SwitchBindings, test29SwitchCallOrder } from './test-helpers/test29-controls.ts'
import { TEST29_ROOT, test29RestartFixture, test29CompactionFixture, test29DiagnosticFixture, test29WatchdogFixture, test29DiagnosticExpectedItem } from './test-helpers/test29-queue.ts'
import { percentile } from './integration/fixtures/transcript-receipts.ts'
import { SR8_DISPATCH_ALLOWANCE_MS, SR8_ACK_LIMIT_MS, SR8_STORE_LIMIT_MS, ackVerdict, storeVerdict, postHoldVerdict,
  n4Verdict, n2Verdict, n2Samples, sealVerdict, requireSeedPopulation, startupVerdict, compactionVerdict, joinsVerdict,
  windowsVerdict, resultLine, summary, evidenceExit, printResults, type Measurement, type Times, type Result,
  SR8_PENDING_POST_MS, SR8_LARGE_BYTES, SR8_SHARED_CHANNELS, pendingPostVerdicts, sharedListVerdicts,
  scanDiagnostics, membershipFaultVerdicts, membershipRepairVerdict, membershipLateVerdict, zeroAckVerdict,
  accountingVerdicts, personaStoreVerdicts, lookupFaultVerdicts, orderedWriteVerdicts,
  faultLoadVerdicts, faultWaves, postHoldOverlapVerdicts, concurrentOverlapVerdicts, envelopeTimings, type FaultPlan, type FaultPush, type FaultLoadEvidence,
  type SharedListEvidence, type PendingProbe, type AccountedEvent, type LookupProbe,
} from './integration/fixtures/sr8-evidence.ts'
import { THREAD_REPLY_HOLD_MS, DELIVERY_MAX_AD_CALLS_PER_S } from '../src/delivery-constants.ts'
import { NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { buildThreadMemoryChangedWhileStoppedLine } from '../src/thread-memory-reports.ts'
import { THREAD_MEMORY_CHANGED_WHILE_STOPPED, THREAD_MEMORY_JOINS_LOST } from '../src/persona-diagnostics.ts'
import { MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS, membershipRetryDelay } from '../src/channel-membership-retry.ts'
import { MEMBERSHIP_INVENTORY_INCOMPLETE, MEMBERSHIP_INVENTORY_COMPLETE, membershipScanDiagnostic } from '../src/channel-membership-scan.ts'
import { MEMBERSHIP_STORAGE_FAILED, membershipDiagnostic } from '../src/channel-membership.ts'
import { burstSpec, sr8Personas, sr8Combinations, SR8_BURST_JOINS, SR8_BURST_REPLIES, SR8_BURST_DROPPED } from './test-helpers/thread-memory.ts'
import { makeQueue, slackInput, heldSlackInput, postHold, queuePath } from './test-helpers/delivery-queue.ts'

const integration = join(import.meta.dir, 'integration')
const source = (file: string) => readFileSync(join(integration, file), 'utf8')
const scenario = source('lib/scenario.sh'), real = source('lib/real-scenario.sh')
function sharedPrinterControl(root: string, printerPath = join(root, 'printer.ts')) {
  // Declaration-only printer harness, as in sharedPrinterControl. Execute the
  // real entry, including its production parser/merger; no image entrypoint.
  const ast = ts.createSourceFile('printer.ts', source('fixtures/fmk-texts.ts'), ts.ScriptTarget.Latest, true)
  const declarations = ast.statements.filter(n => ts.isImportDeclaration(n) || ts.isFunctionDeclaration(n)
    || ts.isVariableStatement(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n))
    .map(n => n.getText(ast)).join('\n')
    .replace("process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'", JSON.stringify(join(import.meta.dir, '..')))
    .replace("return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))", "throw new Error('native client forbidden in declaration control')")
    .replace('process.exit(code)', 'throw new PrinterFailure(reason, code)')
  writeFileSync(printerPath, declarations + '\nprocess.stdout.write(await entryValue(process.argv[2], process.argv.slice(3)))\n')
  return (name: string, ...args: string[]) => {
    const child = spawnSync(process.execPath, [printerPath, name, ...args], {
      env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 1000,
    })
    assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' })
    return child.stdout
  }
}
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
  mkdirSync('/tmp/c9', { recursive: true })
  const root = mkdtempSync('/tmp/c9/cscb-timing-control-')
  try {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), contents.replaceAll(TEST29_ROOT, root))
    }
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'SCENARIO_ROOT="$HOME"', 'SCENARIO_AD_ROOT="$HOME"', 'SLACK_STATE_DIR="$HOME"',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }', program,
    ].join('\n')], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'jq', 'tail', 'grep', 'cat', 'wc', 'python3', 'bun', 'realpath', 'mv', 'mkdir'] }),
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
  '_scenario_now_ms() { local now; read -r now < "$HOME/clock"; printf "%s\\n" "$now"; }',
  'sleep() { local now; read -r now < "$HOME/clock"; printf "%s\\n" "$((now+1000))" > "$HOME/clock"; }',
].join('\n')

const test29 = source('test-29-invited-channels.sh')
const receiptPrinter = test29EvidencePrinter()
const queueControls = [
  'export SCENARIO_ROOT SLACK_STATE_DIR="$HOME/state"', 'SCENARIO_FIXTURES="$HOME"',
  'mkdir -p "$SLACK_STATE_DIR/queue"', 'require_ci_image() { :; }',
  ...['_scenario_scratch_file', 'shared_queue_snapshot', 'shared_queue_receipts', 'shared_wait_queue_drained'].map(name => declaration(scenario, name)),
  ...['snapshot_queue', 'wait_queue_drained', 'queue_drain_snapshot'].map(name => declaration(test29, name)),
].join('\n')
// Include only this continued command and its failure branch; later scenario
// assertions are independent of the printer's append-open stdout regression.
const restartAssertion = block(test29, 'bun "${SCENARIO_FIXTURES}/fmk-texts.ts" sharedAuthorityPreserved', '\npreserved_four_values')

describe('retained timing regressions', () => {
  test('test-29 compaction preserves both consumer drains and diagnostics across restart', async () => {
    const fixture = await test29CompactionFixture()
    const result = shell([
      polling, queueControls, ...fixture.bindings,
      'DELIVERY_IDLE_WAIT_S=2', 'DELIVERY_MAX_WAIT_S=8',
      'queue_drain_snapshot before-restart',
      'wait_queue_drained "$ALPHA_DIR"', 'wait_queue_drained "$BRAVO_DIR"',
      // Replace the live journal with production startup's compacted bytes;
      // snapshot_queue must carry the earlier evidence across the boundary.
      'cat "$HOME/compacted/alpha.jsonl" > "$SLACK_STATE_DIR/queue/alpha.jsonl"',
      'cat "$HOME/compacted/bravo.jsonl" > "$SLACK_STATE_DIR/queue/bravo.jsonl"',
      'wait_queue_drained "$ALPHA_DIR"', 'wait_queue_drained "$BRAVO_DIR"',
      'queue_drain_snapshot after-restart',
      // Retain another completed original without losing the first archive.
      'for key in alpha bravo; do',
      '  cat "$HOME/next-work/$key.jsonl" > "$SLACK_STATE_DIR/queue/$key.jsonl"',
      '  wait_queue_drained "$key"',
      '  cat "$HOME/compacted-again/$key.jsonl" > "$SLACK_STATE_DIR/queue/$key.jsonl"',
      '  wait_queue_drained "$key"',
      'done',
      'queue_drain_snapshot after-second-restart',
      'printf "clock="; cat "$HOME/clock"',
    ].join('\n'), { ...fixture.files, 'fmk-texts.ts': receiptPrinter })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const snapshots = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    // Two personas, each with a two-part Slack original and a cron original.
    expect(snapshots).toEqual([
      ...Array(4).fill({ accepted: 2, complete: true, progress: 3,
        incomplete: 0, first_incomplete: [], incomplete_items_omitted: 0 }),
      ...Array(2).fill({ accepted: 3, complete: true, progress: 4,
        incomplete: 0, first_incomplete: [], incomplete_items_omitted: 0 }),
    ])
    expect(result.stdout).toEndWith('clock=0\n')
    expect(result.stdout).not.toContain(fixture.body)
  })

  test.each([
    ['absent-history', 'original workload unavailable'],
    ...['missing-receipt', 'altered-receipt', 'wrong-transcript-text', 'wrong-transcript-session']
      .map(mode => [mode, 'archived item lacks complete observed receipts']),
    ...['missing-key', 'wrong-key', 'wrong-received-at', 'wrong-delivered-at', 'missing-allocation', 'wrong-allocation', 'foreign-original', 'stale-original']
      .map(mode => [mode, 'archived item lacks matching live compaction evidence']),
    ['incomplete-work', ''],
  ])('test-29 compaction consumers reject insufficient evidence: %s', async (mode, reason) => {
    const fixture = await test29CompactionFixture(mode)
    const result = shell([
      polling, queueControls, ...fixture.bindings,
      'DELIVERY_IDLE_WAIT_S=2', 'DELIVERY_MAX_WAIT_S=8',
      // Start from the archived pre-restart evidence, with only alpha damaged.
      'for key in alpha bravo; do',
      '  cat "$HOME/archive/$key.jsonl" > "$HOME/queue-evidence-$key.jsonl"',
      '  cat "$HOME/compacted/$key.jsonl" > "$SLACK_STATE_DIR/queue/$key.jsonl"',
      'done',
      // Keep the real reader and its authority checks; intentionally drop only
      // the history argument to distinguish it from the original workload.
      ...(mode === 'absent-history' ? [
        declaration(scenario, 'shared_queue_receipts').replace('shared_queue_receipts()', '_audit_queue_receipts()'),
        'shared_queue_receipts() { _audit_queue_receipts "$1" "$2"; }',
      ] : []),
      'set +e', '( set -e; queue_drain_snapshot after-restart )', 'diagnostic=$?',
      '( set -e; wait_queue_drained "$ALPHA_DIR" )', 'drain=$?', 'set -e',
      'printf "diagnostic=%s drain=%s clock=" "$diagnostic" "$drain"; cat "$HOME/clock"',
    ].join('\n'), { ...fixture.files, 'fmk-texts.ts': receiptPrinter })
    expect(result.status).toBe(0)
    expect(result.stdout).toEndWith(`diagnostic=${mode === 'incomplete-work' ? 0 : 1} drain=1 clock=2000\n`)
    expect(result.stderr).toContain(`incomplete receipts for alpha (progress=${mode === 'incomplete-work' ? 3 : 0}, idle=2s, overall=8s)`)
    expect(result.stdout).not.toContain(fixture.body)
    expect(result.stderr).not.toContain(fixture.body)
    if (mode === 'incomplete-work') {
      const snapshots = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]).toEqual({ accepted: 3, complete: false, progress: 3, incomplete: 1,
        first_incomplete: [{ seq: 3, received_at: 400, parts: 0, receipted_parts: 0, complete: false, recent: [] }],
        incomplete_items_omitted: 0 })
      expect(snapshots[1].complete).toBe(true)
      expect(result.stdout).toContain('recorded: queue receipt evidence ' + JSON.stringify(snapshots[0]))
    } else {
      expect(result.stderr).toContain(reason!)
      expect(result.stdout).not.toContain('"complete":true')
    }
  })

  test.each(['complete', 'accepted-only', 'missing-part', 'duplicate-part', 'foreign-seq', 'empty'])('test-29 restart still requires every receipt: %s', async mode => {
    const text = source('test-29-invited-channels.sh')
    const fixture = await test29RestartFixture(mode)
    const result = shell([
      polling, queueControls,
      declaration(scenario, 'shared_queue_receipts').replace('shared_queue_receipts()', '_audit_queue_receipts()'),
      'shared_queue_receipts() { printf "reader:%s\\n" "$1" >&2; _audit_queue_receipts "$@"; }',
      ...fixture.bindings, 'DELIVERY_IDLE_WAIT_S=2', 'DELIVERY_MAX_WAIT_S=8', 'EVENT_WAIT_S=2',
      'thread_joins_saved() { return 0; }',
      block(text, 'queue_drain_snapshot before-restart', 'STORE_BEFORE_RESTART='),
    ].join('\n'), { ...fixture.files, 'fmk-texts.ts': receiptPrinter })
    expect(result.status).toBe(mode === 'complete' ? 0 : 1)
    const readers = [...result.stderr.matchAll(/^reader:(\w+)$/gm)].map(match => match[1])
    const snapshots = result.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    if (mode === 'empty') {
      expect(snapshots).toEqual([])
      expect(readers).toEqual(['alpha'])
      expect(result.stderr).toContain('original workload unavailable')
      return
    }
    expect(snapshots).toHaveLength(mode === 'complete' ? 4 : 2)
    expect(readers.slice(0, 2)).toEqual(['alpha', 'bravo'])
    if (mode === 'complete') expect(readers).toEqual(['alpha', 'bravo', 'alpha', 'bravo', 'alpha', 'bravo'])
    expect(snapshots[0].accepted).toBe(1)
    expect(snapshots.every(s => s.complete === (mode === 'complete'))).toBe(true)
    if (mode !== 'complete') expect(result.stderr).toContain('incomplete receipts for alpha')
  })

  test('test-29 drain diagnostics bound detail and omit content and raw failures', async () => {
    const text = source('test-29-invited-channels.sh')
    const secret = fakeToken(BOT_TOKEN_PREFIX)
    const fixture = await test29DiagnosticFixture(secret)
    const result = shell([
      queueControls,
      ...fixture.bindings,
      'queue_drain_snapshot restart-timeout',
    ].join('\n'), { ...fixture.files, 'fmk-texts.ts': receiptPrinter })
    // Keep the valid persona's bounded evidence before the other persona's
    // torn, acceptance-less journal fails closed.
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain(fixture.body)
    expect(result.stderr).not.toContain(fixture.body)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const snapshot = JSON.parse(lines[0]!)
    expect(snapshot.accepted).toBe(70)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.incomplete).toBe(70)
    expect(snapshot.incomplete_items_omitted).toBe(62)
    expect(snapshot.first_incomplete).toHaveLength(8)
    expect(snapshot.first_incomplete[0]).toEqual(test29DiagnosticExpectedItem())
    expect(result.stderr).toContain('original workload unavailable')
  })

  test.each(['progressing', 'stalled', 'repeated', 'regressed', 'foreign', 'new-work', 'reminders', 'attempts', 'stale', 'malformed', 'unreadable', 'changed-identity', 'overall-limit'])('test-29 exact-workload progress watchdog: %s', async mode => {
    const text = source('test-29-invited-channels.sh')
    const fixture = await test29WatchdogFixture(mode)
    const result = shell([
      polling, queueControls,
      block(text, 'DELIVERY_IDLE_WAIT_S=', '# --- Prerequisites'),
      ...(mode === 'overall-limit' ? ['DELIVERY_MAX_WAIT_S=300'] : []),
      `mode=${mode}`,
      ...fixture.bindings,
      'cat "${TEST29_STAGE_PREFIX}0" > "$TEST29_CURRENT"',
      'sleep() { local now; read -r now < "$HOME/clock"; now=$((now+60000)); printf "%s\\n" "$now" > "$HOME/clock"; cat "$TEST29_STAGE_PREFIX$((now/60000))" > "$TEST29_CURRENT"; if [[ "$mode" == unreadable ]]; then mv "$TEST29_CURRENT" "$TEST29_MISSING"; fi; }',
      'set +e', '( set -e; wait_queue_drained "$TEST29_QUEUE_KEY" control )',
      'status=$?', 'set -e', 'printf "clock="; cat "$HOME/clock"', 'exit "$status"',
    ].join('\n'), { ...fixture.files, 'fmk-texts.ts': receiptPrinter })
    expect(result.status).toBe(mode === 'progressing' ? 0 : 1)
    if (mode === 'progressing') expect(result.stdout.trim()).toBe('clock=240000')
    else {
      expect(result.stderr).toContain('incomplete receipts for alpha')
      // At the overall deadline the sampled fifth receipt is retained in the
      // diagnostic, but cannot renew progress or bypass the absolute bound.
      const progress = ['repeated', 'regressed'].includes(mode) ? 1 : mode === 'overall-limit' ? 4 : 0
      expect(result.stderr).toContain(`progress=${progress}, idle=180s, overall=${mode === 'overall-limit' ? 300 : 1800}s`)
      expect(result.stdout).toContain(`clock=${mode === 'overall-limit' ? 300000 : 180000}`)
      if (mode === 'overall-limit') expect(result.stdout).toContain('"progress":5')
    }
  })

  test.each(['valid', 'missing', 'duplicate', 'wrong-name', 'wrong-key', 'wrong-source', 'wrong-channel', 'wrong-ts', 'wrong-sender', 'missing-thread', 'extra-thread', 'unknown-suffix', 'trailing-junk'])('test-29 closing received set: %s', mode => {
    const text = source('test-29-invited-channels.sh')
    const fixture = test29ClosingFixture(mode)
    const result = shell([
      'export SCENARIO_ROOT', 'SCENARIO_FIXTURES="$HOME"', 'require_ci_image() { :; }',
      declaration(scenario, 'shared_assert_accounting'), ...fixture.bindings,
      block(text, 'shared_assert_accounting "${EXPECTED_ALL}"', '\n# Compare every original'),
    ].join('\n'), { 'fmk-texts.ts': receiptPrinter, ...fixture.files })
    expect(result.status).toBe(mode === 'valid' ? 0 : 1)
    if (mode === 'valid') expect(JSON.parse(result.stdout)).toEqual({ accepted: 2, received: 2 })
    else expect(result.stderr).toContain('exact received diagnostic set mismatch')
  })

  test.each(['kept', 'unredirected-control', 'assertion-fails'])('test-29 assertion printer retains earlier diagnostics: %s', mode => {
    const text = source('test-29-invited-channels.sh')
    let call = restartAssertion
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
      restartAssertion,
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

  /** real_wait_delivery's optional `-- <case assertion...>` (b.p9r): every
   * receipt/progress/diagnostic call, the assertion and each poll trace to
   * stderr. Synthetic bounds: 3 s without progress, 5 s overall. */
  function caseWait(call: string, statuses: number[], { ready = 'always', progress = 'stalled' } = {}) {
    const result = shell([
      declaration(real, 'real_wait_delivery'), declaration(scenario, '_scenario_poll_until'), declaration(scenario, '_scenario_check_timeout'),
      'REAL_DELIVERY_WAIT_S=3', 'REAL_DELIVERY_MAX_WAIT_S=5', 'SCENARIO_POLL_S=1',
      'REAL_RECEIPTS=receipts', 'SCENARIO_AD_SHIM_LOG=shim', 'clock="$HOME/clock"', 'printf "0\\n" > "$clock"',
      // Fixed paths keep the traced receipt arguments exact.
      'SLACK_STATE_DIR=state', 'HOME=/home/control',
      '_scenario_now_ms() { cat "$clock"; }',
      'sleep() { local now; read -r now < "$clock"; printf "sleep\\n" >&2; printf "%s\\n" "$((now+1000))" > "$clock"; }',
      `ready_mode=${ready} progress_mode=${progress} statuses=(${statuses.join(' ')}) asserted=0`,
      'bun() { local now; read -r now < "$clock"; printf "bun %s\\n" "$*" >&2; if [[ "$2" == progress ]]; then [[ "$progress_mode" == advancing ]] && echo "$((now/1000+1))" || echo 1; else [[ "$ready_mode" == always ]] || { [[ "$ready_mode" == later ]] && ((now > 0)); }; fi; }',
      'check_case() { local s="${statuses[asserted]:-${statuses[-1]}}"; asserted=$((asserted+1)); printf "assert %s\\n" "$*" >&2; return "$s"; }',
      '_real_delivery_diagnostic() { printf "diagnostic %s\\n" "$*" >&2; }',
      call,
    ].join('\n'))
    return { status: result.status, trace: result.stderr.trimEnd().split('\n') }
  }
  const ready = 'bun receipts ready state control shim /home/control/.claude/projects 4 no-retype'
  const progress = 'bun receipts progress state control shim /home/control/.claude/projects 4 no-retype'
  const withCase = 'real_wait_delivery control 4 no-retype -- check_case a b'

  test.each(['always', 'never'] as const)('real_wait_delivery without -- keeps its receipt calls and verdict when ready is %s', mode => {
    const without = caseWait('real_wait_delivery control 4 no-retype', [0], { ready: mode })
    expect(without).toEqual(mode === 'always' ? { status: 0, trace: [ready] } : { status: 1, trace: [
      ready, progress, 'sleep', ready, progress, 'sleep', ready, progress, 'sleep', ready, progress,
      'diagnostic control 4 no-retype',
      'real persona control has open/unconfirmed deliveries (no-progress watchdog; receipts=1; idle bound=3s; overall bound=5s)'] })
    // A case assertion runs only after a passing ready audit, so a wait that
    // never gets one is identical with it, diagnostic arguments included.
    if (mode === 'never') expect(caseWait(withCase, [0], { ready: mode })).toEqual(without)
  })

  test.each([
    ['receipts pending twice, then complete', [75, 75, 0], 0, 3],
    ['case proof fails', [1], 1, 1],
    ['receipts pending, then the case proof fails', [75, 1], 1, 2],
    ['case assertion exits with another status', [3], 3, 1],
  ] as const)('real_wait_delivery -- case assertion: %s', (_name, statuses, status, asserted) => {
    const pending = [ready, 'assert a b', progress, 'sleep']
    expect(caseWait(withCase, [...statuses])).toEqual({ status,
      trace: [...Array.from({ length: asserted - 1 }, () => pending).flat(), ready, 'assert a b'] })
  })

  test('real_wait_delivery -- runs its case assertion only after a passing ready audit', () => {
    expect(caseWait(withCase, [0], { ready: 'later' })).toEqual({ status: 0, trace: [ready, progress, 'sleep', ready, 'assert a b'] })
  })

  test.each([
    ['stalled', 'no-progress', 4, 1],
    ['advancing', 'overall', 6, 5],
  ] as const)('real_wait_delivery -- receipts pending with %s progress ends at the %s watchdog', (progressMode, reason, asserted, receipts) => {
    const result = caseWait(withCase, [75], { progress: progressMode })
    expect(result.status).toBe(1)
    expect(result.trace.filter(line => line === 'assert a b')).toHaveLength(asserted)
    // The diagnostic receives only the wait's own arguments.
    expect(result.trace.slice(-2)).toEqual(['diagnostic control 4 no-retype',
      `real persona control has open/unconfirmed deliveries (${reason} watchdog; receipts=${receipts}; idle bound=3s; overall bound=5s)`])
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

  // Each evidence run gets its own default timeout, including negative polling.
  test.each(['restart', 'resume', 'fresh', 'upgrade'].flatMap(mode =>
    ['new', 'stale', 'foreign', 'old-row'].map(evidence => [mode, evidence] as const),
  ))('test-35 %s/%s captures connection cursor after stop and requires a new own connection', (mode, evidence) => {
    const text = source('test-35-fmk-real-restarts.sh')
    const restart = block(text, '    OLD_SESSION=', '    NEW_SESSION=')
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

describe('SR-8 additional cases (synthetic evidence only)', () => {
  const c = { scenario: 'test-cases', mode: 'strict', population: 100000, recipients: 2 } as const
  const key = 'alpha', channel = 'CEXAMPLE', operation = 'new-post'
  const token = fakeToken(BOT_TOKEN_PREFIX, 'case-evidence')
  const clock = 1_800_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const timing = (id: string, ms = SR8_ACK_LIMIT_MS): Times => ({ envelope_id: id,
    push: { sent_mono_ms: 1, connection_id: 'socket' }, acks: [{ ack_mono_ms: 1 + ms, connection_id: 'socket' }] })
  const measure = (seq: number, store = 'accepted', ms = 1, persona = key): Measurement =>
    ({ v: 1, kind: 'store', key: persona, seq, store, store_ms: ms, at_mono_ms: 1 })
  function output(rows: Result[], exit: number) {
    const lines: string[] = []
    expect(printResults(c, rows, l => lines.push(l))).toBe(exit)
    expect(lines).toHaveLength(rows.length + 1)
    expect(lines.at(-1)).toBe(summary(c, rows))
    for (const line of lines.slice(0, -1)) expect(line).toMatch(/^recorded: sr8 [\w-]+ scenario=test-cases mode=strict population=100000 recipients=2 samples=\d+ .+ limit=\S+ verdict=(pass|fail|missing)$/)
    assertNoLeak(lines)
  }
  function pending() {
    const before: any[] = [{ kind: 'post-intent', operationId: operation, channel, stamp: { incarnation: 'life', threadHybridSince: 'stamp' }, at: 0, digest: token }]
    const after = structuredClone(before)
    const probes: PendingProbe[] = ['other', 'bot', 'none'].map((parent, i) => ({ parent, channel, ts: String(i), envelope_id: `pending-${i}` }))
    const queue: any[] = probes.map((p, i) => ({ kind: 'accepted', channel, ts: p.ts, seq: i + 1, text: token }))
    const rows = probes.flatMap((p, i) => p.parent === 'other' ? [measure(i + 1)] : [measure(i + 1, 'post-hold'),
      { v: 1, kind: 'resolution-store', key, seqs: [i + 1], store_ms: 2, at_mono_ms: 100 },
      { v: 1, kind: 'post-hold-resolved', key, seq: i + 1, held_ms: THREAD_REPLY_HOLD_MS + 2 + SR8_DISPATCH_ALLOWANCE_MS, at_mono_ms: 100 }])
    return { before, after, probes, queue, rows, times: probes.map(p => timing(p.envelope_id)), end: SR8_PENDING_POST_MS,
      run() { return pendingPostVerdicts(key, operation, 0, this.end, this.before, this.after, this.probes, this.queue, this.times, this.rows, THREAD_REPLY_HOLD_MS) } }
  }
  test('pins the scenario-only population and duration boundaries', () => {
    expect(SR8_PENDING_POST_MS).toBe(120000); expect(SR8_LARGE_BYTES).toBe(65536); expect(SR8_SHARED_CHANNELS).toBe(1000)
  })
  test.each([0, -1])('pending post at duration boundary %+d', delta => {
    const p = pending(); p.end += delta
    const rows = p.run(); expect(rows[0].verdict).toBe(delta ? 'fail' : 'pass'); output(rows, delta ? 1 : 0)
  })
  test.each(['other-store', 'other-resolution', 'outcome', 'parent-root', 'hold-limit', 'ack-limit'] as const)
  ('pending post rejects %s', defect => {
    const p = pending()
    if (defect === 'other-store') p.rows[0].store = 'post-hold'
    if (defect === 'other-resolution') p.rows.push({ ...p.rows.at(-1)!, seq: 1 })
    if (defect === 'outcome') p.after.push({ kind: 'post-outcome', operationId: operation, outcome: 'none' })
    if (defect === 'parent-root') { p.before[0].root = 'thread'; p.after[0].root = 'thread' }
    if (defect === 'hold-limit') p.rows.at(-1)!.held_ms!++
    if (defect === 'ack-limit') p.times[0].acks[0].ack_mono_ms++
    expect(p.run().some(r => r.verdict === 'fail')).toBe(true); output(p.run(), 1)
  })
  test.each(['intent', 'class', 'hold-store', 'resolution', 'own-append', 'measurement', 'times'] as const)
  ('pending post missing %s never passes', absent => {
    const p = pending()
    if (absent === 'intent') p.before = []
    if (absent === 'class') p.probes.pop()
    if (absent === 'hold-store') p.rows.splice(1, 1)
    if (absent === 'resolution') p.rows.pop()
    if (absent === 'own-append') p.rows[p.rows.length - 2].seqs = [99]
    if (absent === 'measurement') p.rows = []
    if (absent === 'times') p.times = []
    expect(p.run().some(r => r.verdict === 'missing')).toBe(true); output(p.run(), 1)
  })
  test('other-parent drop needs no acceptance and still gets its N1 ACK', () => {
    const p = pending(); p.queue.shift(); p.rows.shift(); output(p.run(), 0)
  })
  function shared(count = SR8_SHARED_CHANNELS): SharedListEvidence {
    const channels = Array.from({ length: count }, (_, i) => ({ id: `C${i}`, delivery: 'thread_hybrid' }))
    const facts = [{ key, mode: 'strict', incarnation: 'life', assignments: Object.fromEntries(channels.map(ch => [ch.id, { delivery: ch.delivery, order: 1, threadHybridSince: 'stamp' }])) }]
    const grown = structuredClone(facts); Object.assign(grown[0].assignments, { CNEW: { delivery: 'off', order: 2 } })
    const prepared = JSON.stringify({ personas: [{ name: key, channels }], ignoredSentinel: token }, null, 2)
    return { prepared, preview: 'ordinary\n'.repeat(SR8_LARGE_BYTES / 4), growth: [{ key, channel: 'CNEW', delivery: 'off' }],
      phases: [facts, facts, grown, grown, grown].map(f => ({ facts: structuredClone(f), input: prepared })),
      failureBefore: JSON.stringify({ saved: token }, null, 2), failureAfter: JSON.stringify({ saved: token }, null, 2), probeExit: 1,
      failureLog: membershipDiagnostic(key, channel, 'event-not-durable'), failureExpected: membershipDiagnostic(key, channel, 'event-not-durable') }
  }
  test('large ordinary preview, config and all five state reads preserve choices/input', () => {
    const e = shared(), rows = sharedListVerdicts(e, [key], MEMBERSHIP_STORAGE_FAILED)
    expect(rows[0].stats.initial).toBe(SR8_SHARED_CHANNELS); expect(rows[0].stats.grown).toBe(SR8_SHARED_CHANNELS + 1)
    output(rows, 0)
  })
  test('a consistently preserved list below the required count still fails', () => {
    const rows = sharedListVerdicts(shared(SR8_SHARED_CHANNELS - 1), [key], MEMBERSHIP_STORAGE_FAILED)
    expect(rows[0].verdict).toBe('fail'); output(rows, 1)
  })
  test.each(['config-boundary', 'preview-boundary', 'count', 'choice', 'stamp', 'growth', 'input', 'probe', 'bytes'] as const)
  ('shared list rejects %s', defect => {
    const e = shared()
    if (defect === 'config-boundary') {
      const compact = JSON.stringify(JSON.parse(e.prepared!)); e.prepared = compact.padEnd(SR8_LARGE_BYTES, ' ')
      e.phases.forEach(p => p.input = e.prepared)
    }
    if (defect === 'preview-boundary') e.preview = 'p'.repeat(SR8_LARGE_BYTES)
    if (defect === 'count') delete e.phases[0].facts![0].assignments.C1
    if (defect === 'choice') e.phases[1].facts![0].assignments.C1.delivery = 'off'
    if (defect === 'stamp') e.phases[2].facts![0].assignments.C1.threadHybridSince = 'changed'
    if (defect === 'growth') delete e.phases[2].facts![0].assignments.CNEW
    if (defect === 'input') e.phases[3].input += ' '
    if (defect === 'probe') e.probeExit = 0
    if (defect === 'bytes') e.failureAfter += ' '
    const rows = sharedListVerdicts(e, [key], MEMBERSHIP_STORAGE_FAILED)
    expect(rows.some(r => r.verdict === 'fail')).toBe(true); output(rows, 1)
  })
  test.each(['preview', 'phase', 'readable-state', 'failure-line', 'actionable-line', 'probe', 'growth'] as const)
  ('shared list missing %s', absent => {
    const e = shared()
    if (absent === 'preview') delete e.preview
    if (absent === 'phase') delete e.phases[1].facts
    if (absent === 'readable-state') e.failureAfter = ''
    if (absent === 'failure-line') e.failureLog = token
    if (absent === 'actionable-line') e.failureLog = `[slack] ${MEMBERSHIP_STORAGE_FAILED} persona=${key}: failure`
    if (absent === 'probe') e.probeExit = NaN
    if (absent === 'growth') e.growth = []
    const rows = sharedListVerdicts(e, [key], MEMBERSHIP_STORAGE_FAILED)
    expect(rows.some(r => r.verdict === 'missing')).toBe(true); output(rows, 1)
  })
  test.each([0, 100000])('measured seal rejects lost joins at population %d', population => {
    const keys = population ? [key] : []
    const r = sealVerdict('measured', keys, [`${THREAD_MEMORY_JOINS_LOST} ${token}`], THREAD_MEMORY_CHANGED_WHILE_STOPPED, [], THREAD_MEMORY_JOINS_LOST)
    expect(r.verdict).toBe('fail'); output([r], 1)
  })

  function scanLine(at: number, complete = false, pages = 0, problem = 'deadline', retryAfterSeconds?: number, deadline = clock + MEMBERSHIP_ATTEMPT_TIMEOUT_MS) {
    return `[${iso(at)}] ${membershipScanDiagnostic(key, { state: complete ? 'complete' : 'incomplete', pages, positives: pages,
      problem: complete ? undefined : problem as any, deadline, nextAttemptAt: complete ? undefined : at + membershipRetryDelay(0, retryAfterSeconds), retryAfterSeconds,
      slackError: problem === 'access' ? 'missing_scope' : problem === 'authentication' ? 'invalid_auth' : problem === 'transport' && retryAfterSeconds === undefined ? 'internal_error' : undefined })}`
  }
  const diag = (log: string) => scanDiagnostics(log, key, MEMBERSHIP_INVENTORY_INCOMPLETE, MEMBERSHIP_INVENTORY_COMPLETE)
  function member(kind = 'hang', page = 'first') {
    const after = kind === 'rate' ? 70 : 0, wait = membershipRetryDelay(0, kind === 'rate' ? after : undefined)
    const duration = kind === 'hang' ? MEMBERSHIP_REQUEST_TIMEOUT_MS : 0, gap = duration + wait
    const outcome = kind === 'hang' ? 'hang' : kind === 'rate' ? 'rate_limit' : 'error'
    const answer = { transient: 'internal_error', scope: 'missing_scope', denied: 'invalid_auth', rate: 'ratelimited' }[kind]
    const problem = { hang: 'deadline', transient: 'transport', scope: 'access', denied: 'authentication', rate: 'transport' }[kind]!
    const faults: any[] = [0, 1].map(i => ({ seq: i * 2 + 1, event: 'fault', control: 'faults', method: 'users.conversations', label: key,
      request_id: `request-${i}`, outcome, arrival_mono_ms: 100 + i * gap, arrival_epoch_ms: clock + i * gap, ts: iso(clock + i * gap), text: token }))
    if (kind !== 'hang') faults.push(...[0, 1].map(i => ({ event: 'api', request_id: `request-${i}`, ts: iso(clock + i * gap), answer, status: kind === 'rate' ? 429 : 200 })))
    else faults.push(...[0, 1].map(i => ({ seq: i * 2 + 2, event: 'fault-settled', request_id: `request-${i}`, resolution: 'abort', ts: iso(clock + i * gap + duration) })))
    const log = [0, 1].map(i => scanLine(clock + i * gap + duration, false, page === 'later' ? 1 : 0, problem,
      kind === 'rate' ? after : undefined, clock + i * gap + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)).join('\n')
    return { kind, page, faults, log, before: '{"assignment":"kept"}', after: '{"assignment":"kept"}', retryAfter: after, wait,
      run() { return membershipFaultVerdicts(this.kind, this.page, key, this.faults, diag(this.log), this.before, this.after, this.retryAfter, this.wait, MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS) } }
  }
  test.each(['hang', 'transient', 'scope', 'denied', 'rate'])('membership %s first and later page published outcomes', kind => {
    for (const page of ['first', 'later']) { const f = member(kind, page); output(f.run(), 0) }
  })
  test.each(['early-start', 'early-429', 'early-after-deadline', 'state-changed', 'false-complete', 'wrong-page', 'wrong-outcome'] as const)
  ('membership fails %s without an allowance', defect => {
    const f = member(defect === 'early-429' ? 'rate' : defect === 'early-start' ? 'transient' : 'hang')
    if (defect === 'early-start') f.faults[1].arrival_mono_ms -= .01
    if (defect === 'early-after-deadline') f.faults[1].arrival_epoch_ms = clock + MEMBERSHIP_REQUEST_TIMEOUT_MS + f.wait - 1
    if (defect === 'early-429') {
      f.faults[1].arrival_epoch_ms = clock + f.wait - 1
      // A wrong published next-attempt time cannot override the real 429.
      f.log = f.log.replace(`next_attempt_at=${clock + f.wait}`, `next_attempt_at=${clock + membershipRetryDelay(0)}`)
    }
    if (defect === 'state-changed') f.after = '{"assignment":"lost"}'
    if (defect === 'false-complete') f.log += '\n' + scanLine(clock + 1, true)
    if (defect === 'wrong-page') f.page = 'later'
    if (defect === 'wrong-outcome') f.log = scanLine(clock + 1, false, 0, 'storage')
    expect(f.run().some(r => r.verdict === 'fail')).toBe(true); output(f.run(), 1)
  })
  test.each(['fault', 'arrival', 'diagnostic', 'state', 'answer', 'retry-after'] as const)
  ('membership missing %s', absent => {
    const f = member(absent === 'answer' || absent === 'retry-after' ? 'rate' : 'hang')
    if (absent === 'fault') f.faults.shift()
    if (absent === 'arrival') delete f.faults[0].arrival_mono_ms
    if (absent === 'diagnostic') f.log = token
    if (absent === 'state') f.before = ''
    if (absent === 'answer') f.faults.pop()
    if (absent === 'retry-after') f.retryAfter++
    expect(f.run()[0].verdict).toBe('missing'); output(f.run(), 1)
  })
  test.each(['first', 'later'])('membership measured deadlines on %s pages, including the 900000 ms regression', page => {
    for (const elapsed of [MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_REQUEST_TIMEOUT_MS + 1, 900_000]) {
      const f = member('hang', page), gap = elapsed + f.wait
      for (const [i, r] of f.faults.slice(0, 2).entries()) {
        r.arrival_epoch_ms = clock + i * gap; r.arrival_mono_ms = 100 + i * gap; r.ts = iso(clock + i * gap)
        f.faults[i + 2].ts = iso(clock + i * gap + elapsed)
      }
      f.log = [0, 1].map(i => scanLine(clock + i * gap + elapsed, false, page === 'first' ? 0 : 1,
        'deadline', undefined, clock + i * gap + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)).join('\n')
      expect(f.run().map(r => r.verdict)).toEqual(elapsed > MEMBERSHIP_REQUEST_TIMEOUT_MS ? ['fail', 'fail'] : ['pass', 'pass'])
      expect(f.run()[0].stats.max_request_ms).toBe(elapsed)
    }
  })
  test.each(['epoch', 'settlement', 'settlement-id', 'diagnostic-endpoint', 'reversed-clock', 'attempt-bound'] as const)
  ('membership measured deadline rejects %s', absent => {
    const f = member()
    if (absent === 'epoch') delete f.faults[0].arrival_epoch_ms
    if (absent === 'settlement') f.faults.pop()
    if (absent === 'settlement-id') f.faults[2].request_id = 'foreign'
    if (absent === 'diagnostic-endpoint') f.log = f.log.replace(/^\[[^\]]+\]/, '[invalid]')
    if (absent === 'reversed-clock') f.faults[0].arrival_epoch_ms += MEMBERSHIP_REQUEST_TIMEOUT_MS + 1
    if (absent === 'attempt-bound') f.log = f.log.replace(`deadline_at=${clock + MEMBERSHIP_ATTEMPT_TIMEOUT_MS}`, `deadline_at=${clock + MEMBERSHIP_REQUEST_TIMEOUT_MS - 1}`)
    expect(f.run()[0].verdict).toBe(absent === 'attempt-bound' ? 'fail' : 'missing')
    output(f.run(), 1)
  })
  test.each(['first', 'later'])('membership deadline uses arrival rather than later fault recording on %s page', page => {
    const f = member('hang', page)
    f.faults[0].ts = iso(clock + 50)
    f.faults[2].ts = iso(clock + MEMBERSHIP_REQUEST_TIMEOUT_MS + 1)
    f.log = scanLine(clock + MEMBERSHIP_REQUEST_TIMEOUT_MS + 1, false, page === 'first' ? 0 : 1) + '\n' + f.log.split('\n')[1]
    expect(f.run()[0].verdict).toBe('fail')
    expect(f.run()[0].stats.max_request_ms).toBe(MEMBERSHIP_REQUEST_TIMEOUT_MS + 1)
  })
  test.each([0, 1])('idle repair at published bound +%d', extra => {
    const clear = clock + MEMBERSHIP_ATTEMPT_TIMEOUT_MS, start = clear + MEMBERSHIP_RETRY_MAX_MS + extra, done = start + 20
    const log = scanLine(clear - 1) + '\n' + scanLine(done, true, 2, 'none', undefined, start + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)
    const r = membershipRepairVerdict(clear, diag(log), MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS)
    expect(r.stats.scan_ms).toBe(20); expect(r.verdict).toBe(extra ? 'fail' : 'pass'); output([r], extra ? 1 : 0)
  })
  test('idle repair includes Retry-After beyond local maximum and refuses absent completion', () => {
    const clear = clock + MEMBERSHIP_ATTEMPT_TIMEOUT_MS, retry = MEMBERSHIP_RETRY_MAX_MS * 2, start = clear + retry
    const log = scanLine(clear - 1, false, 0, 'transport', retry / 1000)
    const r = membershipRepairVerdict(clear, diag(log + '\n' + scanLine(start + 10, true, 1, 'none', undefined, start + MEMBERSHIP_ATTEMPT_TIMEOUT_MS)), MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS)
    expect(r.stats.retry_ms).toBe(retry); output([r], 0)
    const missing = membershipRepairVerdict(clear, diag(log), MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MAX_MS)
    expect(missing.verdict).toBe('missing'); output([missing], 1)
  })
  function late() {
    const stub: any[] = [{ seq: 1, event: 'fault', control: 'faults', method: 'users.conversations', label: key, request_id: 'late', outcome: 'late', arrival_mono_ms: 1 },
      { seq: 5, event: 'fault-settled', request_id: 'late', resolution: 'late', socket_open: false },
      { seq: 4, event: 'api', method: 'users.conversations', label: key, request_id: 'late', answer: 'ok', status: 200 }]
    return { stub, mark: 3, log: scanLine(clock, true), before: JSON.stringify({ facts: token }), after: JSON.stringify({ facts: token }),
      run() { return membershipLateVerdict(key, 'late', this.stub, this.mark, diag(this.log), this.before, this.after) } }
  }
  test('abandoned late answer after replacement completion leaves state equal', () => output([late().run()], 0))
  test.each(['fault', 'settlement', 'api', 'complete', 'state', 'too-early', 'abort', 'changed', 'incomplete-after'] as const)
  ('late answer rejects %s', defect => {
    const f = late()
    if (defect === 'fault') f.stub.shift()
    if (defect === 'settlement') f.stub.splice(1, 1)
    if (defect === 'api') f.stub.pop()
    if (defect === 'complete') f.log = ''
    if (defect === 'state') f.before = ''
    if (defect === 'too-early') f.mark = 6
    if (defect === 'abort') f.stub[1].resolution = 'abort'
    if (defect === 'changed') f.after += ' '
    if (defect === 'incomplete-after') f.log += '\n' + scanLine(clock + 1)
    expect(f.run().verdict).toBe(['abort', 'changed', 'incomplete-after'].includes(defect) ? 'fail' : 'missing'); output([f.run()], 1)
  })
  test.each(['pass', 'ack', 'probe', 'push', 'interval', 'diagnostic'] as const)('zero ACK %s', defect => {
    const times = [timing('undurable')]; times[0].acks = []
    if (defect === 'ack') times[0].acks = timing('undurable').acks
    const r = zeroAckVerdict('undurable', defect === 'push' ? [] : times, 0, defect === 'interval' ? 0 : 4000,
      defect === 'probe' ? 0 : 1, defect === 'diagnostic' ? token : membershipDiagnostic(key, channel, 'event-not-durable'), MEMBERSHIP_STORAGE_FAILED, key)
    expect(r.verdict).toBe(defect === 'pass' ? 'pass' : ['ack', 'probe'].includes(defect) ? 'fail' : 'missing'); output([r], defect === 'pass' ? 0 : 1)
  })
  function accounted() {
    const items: AccountedEvent[] = ['stored', 'withheld', 'dropped'].map((kind, i) => ({ kind, key, channel, ts: String(i), envelope_id: `event-${i}`, recovered_id: kind === 'withheld' ? 'replay' : '-' }))
    const pushes = items.map((i, n) => ({ event: 'push', seq: n + 1, label: key, channel, event_ts: i.ts, envelope_id: i.envelope_id }))
    const stub: any[] = [...pushes, { ...pushes[1], envelope_id: 'replay', seq: 8 },
      { event: 'redelivery', seq: 9, envelope_id: 'replay', original_envelope_id: 'event-1' }]
    const held: Times = { ...timing('event-1'), acks: [] }
    const queues: Record<string, any[] | undefined> = { [key]: items.slice(0, 2).map((i, n) => ({ kind: 'accepted', channel, ts: i.ts, seq: n + 1, text: token })) }
    return { items, stub, during: [held], final: [timing('event-0'), held, timing('event-2'), timing('replay')], queues,
      run() { return accountingVerdicts(this.items, this.stub, this.during, this.final, this.queues, 5) } }
  }
  test('every pushed envelope is accounted, including withheld originals and linked new envelopes', () => output(accounted().run(), 0))
  test.each(['unlisted', 'duplicate', 'lost-work', 'early-ack', 'early-replay', 'wrong-replay', 'stored-drop', 'missing-time', 'slow-recovery'] as const)
  ('accounting refuses %s', defect => {
    const f = accounted()
    if (defect === 'unlisted') f.stub.push({ ...f.stub[0], envelope_id: 'forgotten' })
    if (defect === 'duplicate') f.queues[key]!.push({ ...f.queues[key]![0], seq: 99 })
    if (defect === 'lost-work') f.queues[key]!.pop()
    if (defect === 'early-ack') f.final[1].acks = timing('event-1').acks
    if (defect === 'early-replay') f.stub[3].seq = 4
    if (defect === 'wrong-replay') f.stub[4].original_envelope_id = 'event-0'
    if (defect === 'stored-drop') f.queues[key]!.push({ kind: 'accepted', channel, ts: '2', seq: 3 })
    if (defect === 'missing-time') f.during = []
    if (defect === 'slow-recovery') f.final[3].acks[0].ack_mono_ms++
    expect(f.run().some(r => ['missing', 'fail'].includes(r.verdict))).toBe(true); output(f.run(), 1)
  })
  test('combined p99 cannot hide the second persona, and fixed appends cannot fill acceptance gaps', () => {
    const accepted = Array.from({ length: 1000 }, (_, i) => ({ key: i ? key : 'beta', seq: i + 1 }))
    const rows = accepted.map(a => measure(a.seq, 'accepted', a.key === 'beta' ? SR8_STORE_LIMIT_MS : 1, a.key))
    const got = personaStoreVerdicts(rows, accepted, [key, 'beta'], percentile)
    expect(got.map(r => r.verdict)).toEqual(['pass', 'pass', 'fail']); expect(got[2].stats.persona).toBe(2); output(got, 1)
    rows[0].store = 'fixed'
    expect(personaStoreVerdicts(rows, accepted, [key, 'beta'], percentile)[2].verdict).toBe('missing')
  })
  function lookups() {
    const probes: LookupProbe[] = ['users.info', 'conversations.info'].flatMap(method => ['hang', 'late'].map(outcome =>
      ({ key, method, outcome, match: `${method}-${outcome}`, envelope_id: `${method}-${outcome}` })))
    const stub: any[] = probes.map(p => ({ event: 'fault', control: 'faults', label: key, method: p.method, match: p.match, outcome: p.outcome, arrival_mono_ms: 1, text: token }))
    return { probes, stub, times: probes.map(p => timing(p.envelope_id)), run() { return lookupFaultVerdicts(this.probes, this.stub, this.times) } }
  }
  test('all four lookup cases fire and all ACKs meet N1 without N2', () => output(lookups().run(), 0))
  test.each([0, 1, 2, 3])('lookup probe %d must fire', n => {
    const f = lookups(); f.stub.splice(n, 1); expect(f.run()[0].verdict).toBe('missing'); output(f.run(), 1)
  })
  test('lookup ACK over N1 fails and a missing ACK is missing', () => {
    const f = lookups(); f.times[3].acks[0].ack_mono_ms++; expect(f.run()[1].verdict).toBe('fail'); output(f.run(), 1)
    f.times[3].acks = []; expect(f.run()[1].verdict).toBe('missing'); output(f.run(), 1)
  })
  function writes() {
    const before = [{ channel, delivery: 'all', startedOrder: 1, resolvedOrder: 2 }]
    const expected = [{ channel: 'COTHER', delivery: 'off' }, { channel: 'COTHER', delivery: 'all' }]
    const after = [...before, ...expected.map((e, i) => ({ ...e, startedOrder: 3 + i * 2, resolvedOrder: 4 + i * 2 }))]
    const stub = [{ event: 'push', seq: 1, envelope_id: 'burst' }, { event: 'ws-message', seq: 8, envelope_id: 'burst' }]
    return { before, after, reopened: structuredClone(after), expected, results: expected.map(() => ({ isError: false, text: token })), stub, submit: 2, done: 4, times: [timing('burst')],
      run() { return orderedWriteVerdicts(this.before, this.after, this.reopened, this.expected, this.results, this.stub, this.submit, this.done, this.times) } }
  }
  test('overlapping ordered writes preserve prior and reopened durable order', () => output(writes().run(), 0))
  test.each(['order', 'choice', 'reopen', 'overlap', 'result', 'ack', 'missing'] as const)('ordered writes reject %s', defect => {
    const f = writes()
    if (defect === 'order') { f.after[2].startedOrder = 2; f.reopened = structuredClone(f.after) }
    if (defect === 'choice') f.expected.reverse()
    if (defect === 'reopen') f.reopened.pop()
    if (defect === 'overlap') f.submit = 9
    if (defect === 'result') f.results[0].isError = true
    if (defect === 'ack') f.times[0].acks[0].ack_mono_ms++
    if (defect === 'missing') f.after.pop()
    expect(f.run().some(r => r.verdict === (defect === 'missing' ? 'missing' : 'fail'))).toBe(true); output(f.run(), 1)
  })
  function cli(command: string, args: string[], files: Record<string, string> = {}, recipients = 2) {
    const root = mkdtempSync(join(tmpdir(), 'sr8-case-cli-'))
    try {
      const dir = join(root, 'tests/integration/fixtures'), marker = join(root, 'image')
      mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'tests/test-helpers'), { recursive: true })
      writeFileSync(marker, '')
      writeFileSync(join(dir, 'sr8-evidence.ts'), source('fixtures/sr8-evidence.ts').replace("existsSync('/etc/cscb-ci-image')", `existsSync(${JSON.stringify(marker)})`))
      writeFileSync(join(dir, 'transcript-receipts.ts'), source('fixtures/transcript-receipts.ts'))
      writeFileSync(join(root, 'tests/test-helpers/thread-populations.ts'), readFileSync(join(import.meta.dir, 'test-helpers/thread-populations.ts')))
      // Only the package-value printer is substituted. The actual command
      // dispatcher, file readers, verdicts, formatting and exit path execute.
      const values = { THREAD_REPLY_HOLD_MS, THREAD_MEMORY_CHANGED_WHILE_STOPPED, THREAD_MEMORY_JOINS_LOST, MEMBERSHIP_STORAGE_FAILED,
        MEMBERSHIP_INVENTORY_INCOMPLETE, MEMBERSHIP_INVENTORY_COMPLETE, MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS,
        MEMBERSHIP_RETRY_MAX_MS, membershipRetryDelay: membershipRetryDelay(0), buildThreadMemoryChangedWhileStoppedLine: 'unused-first-phase' }
      writeFileSync(join(dir, 'fmk-texts.ts'), `const values=${JSON.stringify(values)}; console.log(values[process.argv[2]]);`)
      for (const [name, bytes] of Object.entries(files)) { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
      const child = spawnSync(process.execPath, [join(dir, 'sr8-evidence.ts'), command, ...(command === 'seal' ? ['measured'] : []),
        'test-cli', 'strict', '100000', String(recipients), ...args.map(arg => arg.startsWith('@/') ? join(root, arg.slice(2)) : arg)],
      { env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 3000 })
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
      expect(child.stderr).toBe('')
      return child
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const noFile = '@/absent'
  test.each([
    ['pending-post', [key, operation, '0', String(SR8_PENDING_POST_MS), noFile, noFile, noFile, noFile, noFile, noFile, '0', channel], 3],
    ['shared-list', [noFile, '1'], 2],
    ['membership-fault', ['hang', 'first', key, noFile, noFile, noFile, noFile, '0', '0'], 2],
    ['membership-repair', [key, '100', noFile], 1],
    ['membership-late', [key, 'late', noFile, '3', noFile, noFile, noFile], 1],
    ['zero-ack', [key, 'undurable', noFile, '0', '4000', '1', noFile], 1],
    ['accounting', [noFile, noFile, noFile, noFile, noFile, '5'], 1],
    ['stores', [noFile, noFile, '0'], 3],
    ['lookup-faults', [noFile, noFile, noFile], 2],
    ['ordered-writes', [noFile, noFile, '2', '4', noFile], 2],
  ] as [string, string[], number][])('CLI %s prints every missing line before exiting', (command, args, count) => {
    const child = cli(command, args), lines = child.stdout.trim().split('\n')
    expect(child.status).toBe(1); expect(lines).toHaveLength(count + 1)
    expect(lines.slice(0, -1).every(l => l.endsWith('verdict=missing'))).toBe(true)
    expect(lines.at(-1)).toContain(`measures=${count} pass=0 fail=0 missing=${count}`)
  })
  test('CLI pending-post reads its actual journal, queue, timing and measurement files', () => {
    const p = pending(), args = [key, operation, '0', String(p.end), '@/before', '@/after', '@/probes', '@/queue', '@/times', '@/measurements', '0', channel]
    const files = { before: jsonl(p.before), after: jsonl(p.after), probes: p.probes.map(p => [p.parent, p.channel, p.ts, p.envelope_id].join('\t')).join('\n') + '\n',
      queue: jsonl(p.queue), times: jsonl(p.times), measurements: jsonl(p.rows) }
    expect(cli('pending-post', args, files).status).toBe(0)
    expect(cli('pending-post', args, { ...files, measurements: token }).status).toBe(1)
  })
  test('CLI shared-list reads every phase and refuses a successful real-probe status', () => {
    const e = shared(), files: Record<string, string> = { 'e/prepared.input': e.prepared!, 'e/ordinary.preview': e.preview!,
      'e/growth.tsv': `${key}\tCNEW\toff\n`, 'e/failure-before.state': e.failureBefore!, 'e/failure-after.state': e.failureAfter!, 'e/failure.log': e.failureLog!, 'e/failure.expected': e.failureExpected! }
    for (const [i, phase] of ['applied', 'restarted', 'grown', 'reopened', 'failed'].entries()) {
      files[`e/${phase}.facts.jsonl`] = jsonl(e.phases[i].facts!); files[`e/${phase}.input`] = e.phases[i].input!
    }
    expect(cli('shared-list', ['@/e', '1'], files, 1).status).toBe(0)
    const refused = cli('shared-list', ['@/e', '0'], files, 1)
    expect(refused.status).toBe(1); expect(refused.stdout).toContain('probe_failed=no')
  })
  test('CLI membership adapters consume actual diagnostic text and late-settlement order', () => {
    const f = member(), args = ['hang', 'first', key, '@/stub', '@/log', '@/before', '@/after', '0', '0']
    expect(cli('membership-fault', args, { stub: jsonl(f.faults), log: f.log, before: f.before, after: f.after }).status).toBe(0)
    const l = late()
    expect(cli('membership-late', [key, 'late', '@/stub', String(l.mark), '@/log', '@/before', '@/after'],
      { stub: jsonl(l.stub), log: l.log, before: l.before, after: l.after }).status).toBe(0)
    const clear = clock + MEMBERSHIP_ATTEMPT_TIMEOUT_MS, start = clear + MEMBERSHIP_RETRY_MAX_MS
    expect(cli('membership-repair', [key, String(clear), '@/log'], { log: scanLine(clear - 1) + '\n' + scanLine(start + 10, true, 2, 'none', undefined, start + MEMBERSHIP_ATTEMPT_TIMEOUT_MS) }).status).toBe(0)
  })
  test('CLI zero ACK keeps an observed empty ACK array distinct from an absent read', () => {
    const t = timing('undurable'); t.acks = []
    const args = [key, 'undurable', '@/times', '0', '4000', '1', '@/log']
    const files = { times: jsonl([t]), log: membershipDiagnostic(key, channel, 'event-not-durable') }
    expect(cli('zero-ack', args, files).status).toBe(0)
    const bad = cli('zero-ack', args, { ...files, times: jsonl([{ ...t, push: null }]) })
    expect(bad.status).toBe(1); expect(bad.stdout).toContain('verdict=missing')
  })
  test('CLI accounting joins original and replay envelopes to real reader shapes', () => {
    const f = accounted(), manifest = f.items.map(i => [i.kind, i.key, i.channel, i.ts, i.envelope_id, i.recovered_id].join('\t')).join('\n') + '\n'
    const child = cli('accounting', ['@/manifest', '@/stub', '@/during', '@/final', '@/e', '5'], {
      manifest, stub: jsonl(f.stub), during: jsonl(f.during), final: jsonl(f.final), 'e/alpha.queue.jsonl': jsonl(f.queues[key]!) })
    expect(child.status).toBe(0); expect(child.stdout).toContain('samples=4 expected=4 stored=2 withheld=1')
  })
  test('CLI lookup faults preserve all four required fired records', () => {
    const f = lookups(), probes = f.probes.map(p => [p.key, p.method, p.outcome, p.match, p.envelope_id].join('\t')).join('\n') + '\n'
    const child = cli('lookup-faults', ['@/probes', '@/stub', '@/times'], { probes, stub: jsonl(f.stub), times: jsonl(f.times) })
    expect(child.status).toBe(0); expect(child.stdout).toContain('fired=4 required=4')
  })
  test('CLI ordered writes reads retained order and results, with a burst still in flight', () => {
    const f = writes(), child = cli('ordered-writes', ['@/e', '@/stub', String(f.submit), String(f.done), '@/times'], {
      'e/before.jsonl': jsonl(f.before), 'e/after.jsonl': jsonl(f.after), 'e/reopened.jsonl': jsonl(f.reopened),
      'e/expected.tsv': f.expected.map(e => [e.channel, e.delivery].join('\t')).join('\n') + '\n',
      'e/results.jsonl': jsonl(f.results), stub: jsonl(f.stub), times: jsonl(f.times) })
    expect(child.status).toBe(0); expect(child.stdout).toContain('overlap=yes retained=yes ordered=yes')
  })
  test('CLI stores emits combined plus both personas, independently failing Q', () => {
    const items = [{ key, phase: 'roots', channel, ts: '1' }, { key: 'beta', phase: 'roots', channel, ts: '2' }]
    const rows = [measure(1), measure(2, 'accepted', SR8_STORE_LIMIT_MS, 'beta')]
    const child = cli('stores', ['@/e', '@/measurements', '0'], { 'e/burst.jsonl': jsonl(items), measurements: jsonl(rows),
      'e/alpha.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '1', seq: 1 }]), 'e/beta.queue.jsonl': jsonl([{ kind: 'accepted', channel, ts: '2', seq: 2 }]) })
    expect(child.status).toBe(1); expect(child.stdout).toContain('persona=1 limit=50 verdict=pass'); expect(child.stdout).toContain('persona=2 limit=50 verdict=fail')
  })
  test('CLI seal passes the printer lost-join marker into the measured verdict', () => {
    const child = cli('seal', ['@/log', '0', '@/config'], { log: THREAD_MEMORY_JOINS_LOST + ' ' + token,
      config: JSON.stringify({ personas: [key, 'beta'].map(name => ({ name, channels: [] })) }) })
    expect(child.status).toBe(1); expect(child.stdout).toContain('reports=1 loaded=0 limit=0 verdict=fail')
  })
})

describe('SR-8 fault-aware composition and hold overlap (synthetic only)', () => {
  const counts = { roots: SR8_BURST_JOINS, replies: SR8_BURST_REPLIES, dropped: SR8_BURST_DROPPED }
  const epoch = 1800000000000, iso = (t: number) => new Date(epoch + t).toISOString()
  function composed(denied = false): FaultLoadEvidence {
    const keys = sr8Personas(2), spec = burstSpec({ mode: 'strict', population: 0, recipients: 2 }, ['CONE', 'CTWO'], epoch / 1000)
    const plan: FaultPlan = { kind: denied ? 'denied' : 'hang', key: keys[0], keys, all: denied, channels: denied ? [] : ['CONE'], items: [] }
    for (const [phase, messages] of [['roots', spec.rootMentions], ['replies', spec.replies], ['dropped', spec.dropped]] as const)
      for (const message of messages) for (const key of keys) plan.items.push({ ordinal: plan.items.length, key, phase,
        channel: message.channel, ts: message.ts, root: message.threadTs ?? '-', sender: 'sender', dependent: key === plan.key && (denied || message.channel === 'CONE') })
    plan.items.push({ ordinal: plan.items.length, key: keys[1], phase: 'held', channel: 'CTWO', ts: 'held', root: 'own', sender: 'sender', dependent: false })
    const e: FaultLoadEvidence = { plan, ledger: [], stub: [{ event: 'fault', seq: 0, control: 'faults', method: 'users.conversations',
      request_id: 'hung-request', outcome: denied ? 'error' : 'hang', label: keys[0], ts: iso(0) }], during: [], times: [],
      queues: Object.fromEntries(keys.map(k => [k, []])), duringQueues: Object.fromEntries(keys.map(k => [k, []])), rows: [], clearMark: 0, clearAt: epoch + 100000 }
    let seq = 0
    const push = (i: FaultPlan['items'][number], id: string, at: number, ack: boolean) => {
      e.stub!.push({ event: 'push', seq: ++seq, label: i.key, channel: i.channel, event_ts: i.ts, envelope_id: id, ts: iso(at) })
      const t: Times = { envelope_id: id, push: { sent_mono_ms: at, connection_id: 'connection' }, acks: ack ? [{ ack_mono_ms: at + SR8_ACK_LIMIT_MS, connection_id: 'connection' }] : [] }
      if (ack) e.stub!.push({ event: 'ws-message', seq: ++seq, envelope_id: id, ts: iso(at + SR8_ACK_LIMIT_MS) })
      e.times!.push(t); return t
    }
    for (const i of plan.items) {
      if (denied && i.dependent) {
        e.ledger!.push({ ordinal: i.ordinal, stage: 'original', refusal: 'no-open-socket' })
        e.stub!.push({ event: 'push-refused', seq: ++seq, label: i.key, reason: 'no-open-socket', ts: iso(i.ordinal + 10) })
      } else {
        const id = `original-${i.ordinal}`
        e.ledger!.push({ ordinal: i.ordinal, stage: 'original', envelope_id: id })
        e.during!.push(structuredClone(push(i, id, i.ordinal + 10, !i.dependent)))
      }
      if (i.phase !== 'dropped') {
        const a = { kind: 'accepted', key: i.key, seq: i.ordinal + 1, channel: i.channel, ts: i.ts, ...(i.phase === 'held' ? { hold: { on: 'post' } } : {}) }
        e.queues[i.key]!.push(a)
        if (!i.dependent) e.duringQueues[i.key]!.push(structuredClone(a))
        e.rows!.push({ v: 1, kind: 'store', store: i.phase === 'held' ? 'post-hold' : 'accepted', key: i.key, seq: a.seq, store_ms: 1, at_mono_ms: i.phase === 'held' ? 100 : 1000 })
        if (i.phase === 'held') e.rows!.push({ v: 1, kind: 'resolution-store', key: i.key, seqs: [a.seq], store_ms: 1, at_mono_ms: 100 + THREAD_REPLY_HOLD_MS },
          { v: 1, kind: 'post-hold-resolved', key: i.key, seq: a.seq, held_ms: THREAD_REPLY_HOLD_MS + 1, at_mono_ms: 101 + THREAD_REPLY_HOLD_MS })
      }
    }
    if (!denied) e.stub!.push({ event: 'fault-settled', request_id: 'hung-request', resolution: 'abort', seq: ++seq, ts: iso(90000) })
    e.clearMark = ++seq
    for (const i of plan.items.filter(i => i.dependent)) {
      const id = `replay-${i.ordinal}`
      e.ledger!.push({ ordinal: i.ordinal, stage: 'replay', envelope_id: id }); push(i, id, 100001 + i.ordinal, true)
      if (!denied) e.stub!.push({ event: 'redelivery', seq: ++seq, envelope_id: id, original_envelope_id: `original-${i.ordinal}` })
    }
    return e
  }
  const run = (e: FaultLoadEvidence) => faultLoadVerdicts(e, counts, THREAD_REPLY_HOLD_MS, percentile)
  test.each([false, true])('complete P/Q composition, closed-socket denial=%s, retains every attempt', denied => {
    const e = composed(denied), rows = run(e)
    expect(rows.every(r => r.verdict === 'pass')).toBe(true)
    expect(evidenceExit(rows)).toBe(0)
    expect(rows.find(r => r.measure === 'accounting')!.stats.expected).toBe(e.stub!.filter(r => r.event === 'push').length)
    expect(rows.find(r => r.measure === 'fault-workload')!.stats.roots).toBe(SR8_BURST_JOINS)
    expect(rows.find(r => r.measure === 'fault-workload')!.stats.replies).toBe(SR8_BURST_REPLIES)
    expect(rows.filter(r => r.measure === 'store')).toHaveLength(3)
    assertNoLeak(rows)
  })
  test.each(['never-replayed', 'stored-twice', 'late-replay', 'late-q', 'nondependent-p-withheld', 'stored-while-withheld', 'no-overlap',
    'q-root-missing', 'unlisted-envelope', 'q-store-slow', 'q-drop-slow', 'dependency-changed', 'held-unresolved', 'original-ack-after-clear'] as const)
  ('fault-aware composition rejects %s', defect => {
    const e = composed(), dep = e.plan.items.find(i => i.dependent && i.phase === 'roots')!, q = e.plan.items.find(i => i.key !== e.plan.key && i.phase === 'roots')!
    const nondependent = e.plan.items.find(i => i.key === e.plan.key && !i.dependent && i.phase === 'roots')!
    const findTime = (id: string) => e.times!.find(t => t.envelope_id === id)!
    if (defect === 'never-replayed') e.ledger = e.ledger!.filter(l => !(l.ordinal === dep.ordinal && l.stage === 'replay'))
    if (defect === 'stored-twice') e.queues[dep.key]!.push({ ...e.queues[dep.key]!.find(a => a.ts === dep.ts), seq: 999999 })
    if (defect === 'late-replay') findTime(`replay-${dep.ordinal}`).acks[0].ack_mono_ms++
    if (defect === 'late-q') findTime(`original-${q.ordinal}`).acks[0].ack_mono_ms++
    if (defect === 'nondependent-p-withheld') findTime(`original-${nondependent.ordinal}`).acks = []
    if (defect === 'stored-while-withheld') e.duringQueues[dep.key]!.push(e.queues[dep.key]!.find(a => a.ts === dep.ts))
    if (defect === 'no-overlap') e.stub![0].ts = iso(80000)
    if (defect === 'q-root-missing') {
      e.plan.items = e.plan.items.filter(i => i !== q)
      e.ledger = e.ledger!.filter(l => l.ordinal !== q.ordinal)
      e.stub = e.stub!.filter(r => r.envelope_id !== `original-${q.ordinal}`)
      e.queues[q.key] = e.queues[q.key]!.filter(a => a.ts !== q.ts)
      e.rows = e.rows!.filter(r => !(r.key === q.key && r.seq === q.ordinal + 1))
    }
    if (defect === 'unlisted-envelope') e.stub!.push({ event: 'push', envelope_id: 'hidden' })
    if (defect === 'q-store-slow') {
      const qStores = e.rows!.filter(r => r.key === q.key && r.kind === 'store')
      for (const r of qStores.slice(0, Math.floor(qStores.length / 100) + 1)) r.store_ms = SR8_STORE_LIMIT_MS
    }
    if (defect === 'q-drop-slow') findTime(`original-${e.plan.items.find(i => i.key === q.key && i.phase === 'dropped')!.ordinal}`).acks[0].ack_mono_ms++
    if (defect === 'dependency-changed') nondependent.dependent = true
    if (defect === 'held-unresolved') e.rows = e.rows!.filter(r => r.kind !== 'post-hold-resolved')
    if (defect === 'original-ack-after-clear') findTime(`original-${dep.ordinal}`).acks = [{ connection_id: 'connection', ack_mono_ms: 100001 }]
    const rows = run(e)
    expect(evidenceExit(rows)).toBe(1)
    if (defect === 'never-replayed') expect(rows.find(r => r.measure === 'accounting')!.verdict).toBe('missing')
    if (defect === 'stored-twice') expect(rows.find(r => r.measure === 'accounting')!.verdict).toBe('fail')
    if (defect === 'original-ack-after-clear') expect(rows.find(r => r.measure === 'accounting')!.verdict).toBe('fail')
    if (defect === 'late-replay') expect(rows.find(r => r.measure === 'recovered-ack')!.verdict).toBe('fail')
    if (defect === 'late-q') expect(rows.find(r => r.measure === 'ack-accepted' && r.stats.persona === 2)!.verdict).toBe('fail')
    if (defect === 'nondependent-p-withheld') expect(rows.find(r => r.measure === 'ack-accepted' && r.stats.persona === 1)!.verdict).toBe('missing')
    if (defect === 'q-root-missing') expect(rows.find(r => r.measure === 'fault-workload')!.verdict).toBe('missing')
    if (defect === 'q-store-slow') {
      expect(rows.find(r => r.measure === 'store' && r.stats.persona === 2)!.verdict).toBe('fail')
      expect(rows.find(r => r.measure === 'store' && r.stats.persona === undefined)!.verdict).toBe('pass')
    }
    if (defect === 'no-overlap') expect(rows.find(r => r.measure === 'fault-overlap')!.verdict).toBe('missing')
    if (defect === 'stored-while-withheld') expect(rows.find(r => r.measure === 'fault-withheld')!.verdict).toBe('fail')
    assertNoLeak(rows)
  })
  test('fault waves admit held probes first, wait only expected ACKs and send withheld-root replies with Q', async () => {
    const items = composed().plan.items.filter(i => i.ordinal < 4 || (i.phase === 'replies' && i.ordinal < 2 * SR8_BURST_JOINS + 4) || i.phase === 'held')
    const calls: string[] = [], sent = new Set<number>()
    const good = await faultWaves(items, async i => { sent.add(i.ordinal); calls.push(`send:${i.phase}:${i.ordinal}`) }, async batch => {
      expect(batch.every(i => !i.dependent && sent.has(i.ordinal))).toBe(true)
      calls.push(`wait:${batch[0]?.phase ?? 'empty'}`); return true
    }, async held => { expect(held).toHaveLength(1); calls.push('admitted'); return true })
    expect(good).toBe(true); expect(sent.size).toBe(items.length); expect(calls.includes('admitted')).toBe(true)
    expect(calls.indexOf('admitted')).toBeLessThan(calls.findIndex(s => s.startsWith('send:roots:')))
    expect(calls.filter(s => s.startsWith('send:replies:'))).toHaveLength(4)
    expect(calls.findIndex(s => s.startsWith('wait:replies'))).toBeGreaterThan(Math.max(...calls.map((s, i) => s.startsWith('send:replies:') ? i : -1)))
  })
  test.each(['during', 'before', 'after', 'slow-ack', 'missing-admission', 'missing-resolution'] as const)('Post Hold overlap %s', where => {
    const hold = { key: 'alpha', seq: 1 }, ordinary = [{ key: 'alpha', seq: 2, envelope_id: 'ordinary' }]
    const rows: Measurement[] = [{ v: 1, kind: 'store', store: 'post-hold', ...hold, at_mono_ms: 100 },
      { v: 1, kind: 'post-hold-resolved', ...hold, at_mono_ms: 200 },
      { v: 1, kind: 'store', store: 'accepted', key: 'alpha', seq: 2, at_mono_ms: where === 'before' ? 99 : where === 'after' ? 201 : 150 }]
    if (where === 'missing-admission') rows.shift()
    if (where === 'missing-resolution') rows.splice(1, 1)
    const times: Times[] = [{ envelope_id: 'ordinary', push: { sent_mono_ms: 1, connection_id: 'c' }, acks: [{ ack_mono_ms: 1 + SR8_ACK_LIMIT_MS + (where === 'slow-ack' ? 1 : 0), connection_id: 'c' }] }]
    const got = postHoldOverlapVerdicts(rows, [hold], ordinary, times)
    expect(evidenceExit(got)).toBe(where === 'during' ? 0 : 1)
    expect(got[0].samples).toBe(['before', 'after', 'missing-admission', 'missing-resolution'].includes(where) ? 0 : 1)
  })
  test.each(['unknown-refusal', 'refusal-record-missing', 'refusal-replay-ack', 'partial-denial', 'unlisted-refusal'] as const)('closed-socket accounting rejects %s', defect => {
    const e = composed(true), refused = e.ledger!.find(l => l.refusal)!
    if (defect === 'unknown-refusal') refused.refusal = 'unrecognized'
    if (defect === 'refusal-record-missing') e.stub = e.stub!.filter(r => r.event !== 'push-refused')
    if (defect === 'refusal-replay-ack') e.times!.find(t => t.envelope_id === `replay-${refused.ordinal}`)!.acks[0].ack_mono_ms++
    if (defect === 'partial-denial') e.plan.all = false
    if (defect === 'unlisted-refusal') e.stub!.push({ event: 'push-refused', label: e.plan.key, reason: 'not-json', seq: 999999 })
    const rows = run(e)
    expect(evidenceExit(rows)).toBe(1)
    if (defect === 'refusal-record-missing') expect(rows.find(r => r.measure === 'accounting')!.verdict).toBe('fail')
  })
  test.each(['pass', 'beta-after', 'beta-slow-ack', 'beta-missing-ack'] as const)('Post Hold overlap requires both personas: %s', defect => {
    const holds = sr8Personas(2).map(key => ({ key, seq: 1 }))
    const ordinary = holds.map(h => ({ key: h.key, seq: 2, envelope_id: h.key }))
    const rows: Measurement[] = holds.flatMap(h => [
      { v: 1, kind: 'store', store: 'post-hold', ...h, at_mono_ms: 100 },
      { v: 1, kind: 'post-hold-resolved', ...h, at_mono_ms: 200 },
      { v: 1, kind: 'store', store: 'accepted', key: h.key, seq: 2, at_mono_ms: h.key === holds[1].key && defect === 'beta-after' ? 201 : 150 },
    ])
    const times: Times[] = ordinary.map((a, i) => ({ envelope_id: a.envelope_id, push: { sent_mono_ms: 1, connection_id: a.key },
      acks: i === 1 && defect === 'beta-missing-ack' ? [] : [{ ack_mono_ms: 1 + SR8_ACK_LIMIT_MS + (i === 1 && defect === 'beta-slow-ack' ? 1 : 0), connection_id: a.key }] }))
    const got = postHoldOverlapVerdicts(rows, holds, ordinary, times)
    expect(evidenceExit(got)).toBe(defect === 'pass' ? 0 : 1)
    expect(got[0].verdict).toBe(defect === 'beta-after' ? 'missing' : 'pass')
    expect(got[1].verdict).toBe(defect === 'beta-slow-ack' ? 'fail' : defect === 'beta-missing-ack' ? 'missing' : 'pass')
  })
  test('Post Hold overlap requires every declared probe even for the same persona', () => {
    const key = sr8Personas(1)[0], holds = [{ key, seq: 1 }, { key, seq: 2 }]
    const rows: Measurement[] = holds.flatMap((h, i) => [
      { v: 1, kind: 'store', store: 'post-hold', ...h, at_mono_ms: 100 + i * 200 },
      { v: 1, kind: 'post-hold-resolved', ...h, at_mono_ms: 200 + i * 200 },
    ])
    rows.push({ v: 1, kind: 'store', store: 'accepted', key, seq: 3, at_mono_ms: 150 })
    const got = postHoldOverlapVerdicts(rows, holds, [{ key, seq: 3, envelope_id: 'ordinary' }], [
      { envelope_id: 'ordinary', push: { sent_mono_ms: 1, connection_id: 'c' }, acks: [{ ack_mono_ms: 2, connection_id: 'c' }] },
    ])
    expect(got[0].verdict).toBe('missing'); expect(evidenceExit(got)).toBe(1)
  })
  test('held admission archive survives repeated polls and retains observed resolution across compaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sr8-admission-')), state = join(root, 'state'), key = 'alpha'
    const q = await makeQueue(state, { now: () => 100 })
    try {
      const printer = sharedPrinterControl(root)
      const input = heldSlackInput(postHold(100)), journal = queuePath(state, key)
      expect((await q.accept(key, input)).status).toBe('accepted')
      const original = printer('sharedQueueSnapshot', journal)
      const originalRows = original.trim().split('\n').map(l => JSON.parse(l))
      const acceptance = originalRows.find(r => r.kind === 'accepted' && !('compact' in r))
      const resolution = [{ seq: acceptance.seq, outcome: 'released' as const, at: 150 }]
      expect(await q.resolveHolds(key, resolution)).toEqual(resolution)
      const resolved = printer('sharedQueueSnapshot', journal)
      const resolvedRows = resolved.trim().split('\n').map(l => JSON.parse(l))
      const release = resolvedRows.find(r => r.kind === 'released')
      expect(release).toBeDefined()
      await q.compact(key)
      const compacted = printer('sharedQueueSnapshot', journal)
      expect(compacted.trim().split('\n').map(l => JSON.parse(l)).some(r => r.kind === 'released')).toBe(false)
      await q.stop()
      // Two identical polls, then an observed resolution, then a compacted live
      // journal. Delay measurement visibility until the fourth poll, without a
      // real polling sleep. Each poll's synchronous printer is still the real entry.
      const observations = [original, original, resolved, compacted]
      let polls = 0
      const measurements = () => {
        writeFileSync(journal, observations[Math.min(polls, observations.length - 1)])
        return ++polls < observations.length ? [] : [{ key, seq: acceptance.seq, kind: 'store', store: 'post-hold' }]
      }
      const sr8 = source('fixtures/sr8-evidence.ts'), holdPath = join(root, 'hold.ts')
      writeFileSync(holdPath, [
        "import { existsSync, appendFileSync, writeFileSync } from 'node:fs'", "import { join } from 'node:path'",
        'export async function run(deps, ...args) { const { printer, measurements, setTimeout } = deps',
        block(sr8, 'const acceptedFor =', '\nconst namedLines ='),
        block(sr8, 'async function holdAdmission(', '\nasync function readFaultPlan('),
        'return holdAdmission(...args) }',
      ].join('\n'))
      const hold = await import(holdPath)
      expect(await hold.run({ printer, measurements, setTimeout: (resume: () => void) => resume() },
        [{ key, phase: 'held', channel: input.channel, ts: input.ts }], state, 'controlled-measurements', 0, 2000, root)).toBe(true)
      expect(polls).toBe(observations.length)
      // Consume exactly the header's documented current+prior inputs. The
      // archive itself must be valid, not merely repairable by the consumer.
      const archive = join(root, `${key}.held-admission.jsonl`)
      const archived = printer('sharedQueueSnapshot', archive).trim().split('\n').map(l => JSON.parse(l))
      const combined = printer('sharedQueueSnapshot', journal, archive).trim().split('\n').map(l => JSON.parse(l))
      for (const rows of [archived, combined]) {
        expect(rows.filter(r => r.kind === 'accepted' && !('compact' in r))).toEqual([acceptance])
        expect(rows.filter(r => r.kind === 'released')).toEqual([release])
      }
    } finally { await q.stop(); rmSync(root, { recursive: true, force: true }) }
  })
  async function withCLI(body: (root: string, cli: (command: string, args: string[]) => ReturnType<typeof spawnSync>) => void | Promise<void>, prefix = '') {
    const root = mkdtempSync(join(tmpdir(), 'sr8-cli-'))
    try {
      const dir = join(root, 'tests/integration/fixtures'), marker = join(root, 'image')
      mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'tests/test-helpers'), { recursive: true }); writeFileSync(marker, '')
      writeFileSync(join(dir, 'sr8-evidence.ts'), prefix + source('fixtures/sr8-evidence.ts').replace("existsSync('/etc/cscb-ci-image')", `existsSync(${JSON.stringify(marker)})`))
      writeFileSync(join(dir, 'transcript-receipts.ts'), source('fixtures/transcript-receipts.ts'))
      writeFileSync(join(root, 'tests/test-helpers/thread-populations.ts'), readFileSync(join(import.meta.dir, 'test-helpers/thread-populations.ts')))
      writeFileSync(join(dir, 'fmk-texts.ts'), `import {readFileSync} from 'node:fs'; if(process.argv[2]==='sharedQueueSnapshot') console.log(readFileSync(process.argv[3],'utf8')); else console.log(${JSON.stringify({ THREAD_REPLY_HOLD_MS, DELIVERY_MAX_AD_CALLS_PER_S, NAME_LOOKUP_TIMEOUT_MS })}[process.argv[2]]);`)
      const cli = (command: string, args: string[]) => {
        const child = spawnSync(process.execPath, [join(dir, 'sr8-evidence.ts'), command,
          ...(['envelope-times', 'combinations'].includes(command) ? [] : ['test-fault', 'strict', '0', '2']), ...args],
          { env: hostSafeChildEnv(root, { extras: { SCENARIO_ROOT: root } }), encoding: 'utf8', timeout: 3000 })
        expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
        return child
      }
      await body(root, cli)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const lines = (rows: any[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  test.each(['valid', 'mismatched-sender'] as const)('N4 CLI matches production Slack acceptance through the real shared snapshot: %s', defect => withCLI(async (root, cli) => {
    const key = sr8Personas(1)[0], state = join(root, 'state'), q = await makeQueue(state, { now: () => 100 })
    const samples = ['hung', 'delayed'].map((user, i) => slackInput({ user, ts: `${1700000000 + i}.000001`,
      key: { chat_id: 'C0TEST001', ts: `${1700000000 + i}.000001` }, via: 'thread', thread_ts: '1699999999.000001' }))
    try {
      for (const [i, input] of samples.entries()) expect((await q.accept(key, { ...input,
        ...(i === 0 && defect === 'mismatched-sender' ? { user: 'different-user' } : {}) })).status).toBe('accepted')
      const printer = sharedPrinterControl(root, join(root, 'tests/integration/fixtures/fmk-texts.ts'))
      const snapshot = printer('sharedQueueSnapshot', queuePath(state, key))
      writeFileSync(join(root, 'queue'), snapshot)
      const accepted = snapshot.trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'accepted' && !r.compact)
      expect(accepted).toHaveLength(samples.length)
      expect(accepted.every(r => r.source === 'slack' && typeof r.user === 'string' && !Object.hasOwn(r, 'sender'))).toBe(true)
      writeFileSync(join(root, 'measurements'), lines([
        { v: 1, kind: 'store', store: 'accepted', key, seq: accepted[0].seq, at_mono_ms: 100, store_ms: 1 },
        { v: 1, kind: 'store', store: 'fixed', key, seq: accepted[0].seq, at_mono_ms: 101 + NAME_LOOKUP_TIMEOUT_MS, store_ms: 1 },
      ]))
      writeFileSync(join(root, 'stub'), lines(samples.flatMap((s, i) => [
        { event: 'push', label: key, channel: s.channel, event_ts: s.ts, envelope_id: `sample-${i}` },
        { event: 'fault', control: 'faults', method: 'users.info', label: key, match: s.user, outcome: i ? 'delay' : 'hang', arrival_mono_ms: 1 },
      ])))
      writeFileSync(join(root, 'times'), lines(samples.map((_, i) => ({ envelope_id: `sample-${i}`,
        push: { sent_mono_ms: 1, connection_id: 'c' }, acks: [{ ack_mono_ms: 2, connection_id: 'c' }] }))))
      writeFileSync(join(root, 'n2'), accepted.map((a, i) => `recorded: sr8 n2-sample key=${key} seq=${a.seq} name=${i ? 'resolved' : 'fallback'} verdict=pass\n`).join(''))
      const child = cli('n4', [join(root, 'measurements'), '0', key, join(root, 'queue'), join(root, 'times'), join(root, 'stub'), join(root, 'n2'),
        samples[0].ts!, samples[0].user!, samples[1].ts!, samples[1].user!])
      expect(child.status).toBe(defect === 'valid' ? 0 : 1)
      expect(child.stdout).toContain(`verdict=${defect === 'valid' ? 'pass' : 'missing'}`)
    } finally { await q.stop() }
  }))
  test('combinations CLI prints the declared population, mode, recipients order as TSV', () => withCLI((_root, cli) => {
    const child = cli('combinations', [])
    expect(child.status).toBe(0); expect(child.stderr).toBe('')
    expect(child.stdout).toBe(sr8Combinations().map(c => `${c.population}\t${c.mode}\t${c.recipients}\n`).join(''))
  }))
  test.each(['pass', 'empty-active', 'missing-instance', 'wrong-phase', 'foreign-instance', 'missing-active', 'empty-idle', 'malformed-call'] as const)
  ('N3 CLI requires declared active windows and complete instance coverage: %s', defect => withCLI((root, cli) => {
    const ids = sr8Personas(2).map(key => `cscb_${key}`)
    const calls = defect === 'empty-active' ? [] : ids.slice(0, defect === 'missing-instance' ? 1 : 2)
      .map((id, i) => `${i + 1}\t${defect === 'wrong-phase' ? 0.5 : 1.5}\t100\tget\t${defect === 'foreign-instance' ? 'other-phase-instance' : id}\t--instance-id`)
    writeFileSync(join(root, 'calls'), defect === 'malformed-call' ? 'incomplete\n' : calls.length ? calls.join('\n') + '\n' : '')
    writeFileSync(join(root, 'empty'), defect === 'empty-idle' ? '' : ids.map(id => `${id}\t3\t4\n`).join(''))
    if (defect !== 'missing-active') writeFileSync(join(root, 'active'), ids.map(id => `${id}\t1\t2\n`).join(''))
    const child = cli('windows', [join(root, 'calls'), join(root, 'empty'), join(root, 'active')])
    expect(child.status).toBe(defect === 'pass' ? 0 : 1)
    expect(child.stdout).toContain(`verdict=${defect === 'pass' ? 'pass' : 'missing'}`)
  }))
  // Samples are [admission, delivery) = [100, 200) and [300, 400); each kind's
  // operation is shifted by 200 ms per kind. Recorded ends are poll-bounded, so
  // only a start inside a sample is credited.
  const spans: Record<string, [number, number]> = { before: [10, 50], after: [500, 550], 'start-at-delivery': [200, 220],
    'start-before-admission': [60, 130], 'start-at-admission': [100, 180], 'start-inside-end-after': [150, 450] }
  test.each(['pass', 'start-at-admission', 'start-inside-end-after', 'before', 'after', 'start-before-admission', 'start-at-delivery',
    'membership-only', 'write-only', 'unmeasured-sample', 'missing-endpoint', 'missing-n2'] as const)
  ('concurrent overlap pure and CLI credit only operation starts inside a measured sample: %s', defect => withCLI((root, cli) => {
    const epoch = 1700000000000, key = sr8Personas(1)[0], passes = ['pass', 'start-at-admission', 'start-inside-end-after'].includes(defect)
    const measured = [{ key, seq: 1, name: 'resolved' }, { key, seq: 2, name: 'fallback' }]
    const samples = measured.map((s, i) => ({ key: s.key, seq: s.seq,
      start_epoch_ms: epoch + 100 + i * 200, end_epoch_ms: epoch + 200 + i * 200 }))
    if (defect === 'unmeasured-sample') samples[1].seq++
    const [start, end] = spans[defect] ?? [150, 180]
    const operations = ['membership', 'write'].map((kind, i) => ({ kind, id: `operation-${i}`,
      start_epoch_ms: epoch + start + i * 200, end_epoch_ms: epoch + end + i * 200 }))
    if (defect === 'membership-only') operations.splice(1, 1)
    if (defect === 'write-only') operations.splice(0, 1)
    if (defect === 'missing-endpoint') operations[0].end_epoch_ms = NaN
    const verdicts = concurrentOverlapVerdicts(operations, samples, defect === 'missing-n2' ? undefined : measured)
    expect(evidenceExit(verdicts)).toBe(passes ? 0 : 1)
    if (passes) expect(verdicts.map(r => r.verdict)).toEqual(['pass', 'pass'])
    else if (defect in spans) expect(verdicts.map(r => r.verdict)).toEqual(['missing', 'missing'])
    else expect(verdicts.some(r => r.verdict === 'missing')).toBe(true)
    writeFileSync(join(root, 'operations'), operations.map(o => `${o.kind}\t${o.id}\t${o.start_epoch_ms}\t${o.end_epoch_ms}\n`).join(''))
    writeFileSync(join(root, 'samples'), samples.map(s => `${s.key}\t${s.seq}\t${s.start_epoch_ms}\t${s.end_epoch_ms}\n`).join(''))
    if (defect !== 'missing-n2') writeFileSync(join(root, 'n2'), measured.map(s => `recorded: sr8 n2-sample key=${s.key} seq=${s.seq} name=${s.name} verdict=pass\n`).join(''))
    const child = cli('concurrent-overlap', [join(root, 'operations'), join(root, 'samples'), join(root, 'n2')])
    expect(child.status).toBe(passes ? 0 : 1)
    expect(child.stdout).toContain('thread-membership-overlap'); expect(child.stdout).toContain('thread-write-overlap')
    expect(child.stdout).toContain(`verdict=${passes ? 'pass' : 'missing'}`)
  }))
  test('bulk timings exactly match the scenario.sh reader for ordered zero, duplicate and replay ACK observations', () => withCLI((root, cli) => {
    const push = (id: string, at: number, connection?: string) => ({ event: 'push', envelope_id: id, sent_mono_ms: at, ...(connection ? { connection_id: connection } : {}) })
    const ack = (id: string, at: number, connection?: string) => ({ event: 'ws-message', envelope_id: id, ack_mono_ms: at, ...(connection ? { connection_id: connection } : {}) })
    const rows = [push('zero', 1, 'a'), push('duplicate', 2, 'a'), ack('duplicate', 4, 'a'), ack('duplicate', 5, 'b'),
      push('original', 6, 'old'), push('replay', 7, 'new'), { event: 'redelivery', original_envelope_id: 'original', envelope_id: 'replay' },
      ack('replay', 8, 'new'), push('nullable', 9), ack('nullable', 10), { event: 'api', answer: 'ignored' }]
    const ids = ['replay', 'zero', 'duplicate', 'original', 'nullable', 'replay'], requested = ids.join('\n') + '\n'
    // Execute the actual helper and its actual JSONL/count dependencies, using
    // the same declaration harness and scratch guard as the existing shell cases.
    const single = shell([
      'require_ci_image() { :; }',
      ...['_scenario_scratch_file', '_scenario_complete_jsonl', 'slack_stub_records', 'slack_stub_record_count', 'slack_envelope_times'].map(n => declaration(scenario, n)),
      'SCENARIO_SLACK_RECORD="$HOME/stub"',
      'while IFS= read -r envelope; do slack_envelope_times "$envelope"; done < "$HOME/ids"',
    ].join('\n'), { stub: lines(rows), ids: requested })
    expect(single.status).toBe(0)
    writeFileSync(join(root, 'stub'), lines(rows)); writeFileSync(join(root, 'ids'), requested)
    const bulk = cli('envelope-times', [join(root, 'ids'), join(root, 'stub')])
    expect(bulk.status).toBe(0); expect(bulk.stdout).toBe(single.stdout)
    expect(String(bulk.stdout).trim().split('\n').map(l => JSON.parse(l))).toEqual(envelopeTimings(ids, rows))
  }))
  test.each(['missing-push', 'duplicate-push', 'malformed-record', 'non-object', 'partial-line', 'missing-monotonic', 'invalid-id'] as const)
  ('bulk timings rejects %s without partial output or leaked input', defect => withCLI((root, cli) => {
    const rows: any[] = [{ event: 'push', envelope_id: 'first', sent_mono_ms: 1 }, { event: 'push', envelope_id: 'second', sent_mono_ms: 2 }]
    let requested = 'first\nsecond\n', reason = 'stub-record-invalid'
    if (defect === 'missing-push') { rows.pop(); reason = 'timing-push-missing' }
    if (defect === 'duplicate-push') { rows.push(rows[1]); reason = 'timing-push-duplicate' }
    if (defect === 'non-object') rows.push([])
    if (defect === 'missing-monotonic') { rows.push({ event: 'ws-message', envelope_id: 'second' }); reason = 'timing-monotonic-missing' }
    if (defect === 'invalid-id') { requested += '\n'; reason = 'timing-ids-invalid' }
    const sentinel = fakeToken(BOT_TOKEN_PREFIX, 'bulk-error')
    writeFileSync(join(root, 'stub'), lines(rows) + (defect === 'malformed-record' ? sentinel + '\n' : defect === 'partial-line' ? '{' : ''))
    writeFileSync(join(root, 'ids'), requested)
    const child = cli('envelope-times', [join(root, 'ids'), join(root, 'stub')])
    expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).toContain(reason)
  }))
  const recoveryTransport = `
// Synthetic transport in this copied CLI only; no socket, server or native client.
let recoveryPlan, recordSeq, active = 0;
globalThis.fetch = async (_url, init) => {
  const base = resolve(import.meta.dir, '../../..'), dir = join(base, 'e'), file = join(base, 'stub');
  const read = () => readFileSync(file, 'utf8').trim().split('\\n').filter(Boolean).map(l => JSON.parse(l));
  recoveryPlan ??= JSON.parse(readFileSync(join(dir, 'fault-plan.json'), 'utf8')).plan;
  recordSeq ??= Math.max(...read().map(r => r.seq));
  const mode = readFileSync(join(base, 'mode'), 'utf8'), body = JSON.parse(init.body);
  const item = body.redeliver ? recoveryPlan.items[Number(body.redeliver.envelope_id.split('-').at(-1))]
    : recoveryPlan.items.find(i => i.key === body.label && i.ts === body.event.ts && i.channel === body.event.channel);
  const record = row => { row.seq = ++recordSeq; appendFileSync(file, JSON.stringify(row)+'\\n'); };
  const trace = row => appendFileSync(join(base,'transport'),JSON.stringify(row)+'\\n');
  const parent = recoveryPlan.items.find(i => i.phase === 'roots' && i.key === item.key && i.channel === item.channel && i.ts === item.root);
  if (parent && !read().some(r => r.event === 'ws-message' && r.envelope_id === 'replay-' + parent.ordinal)) {
    trace({ early_reply: true }); return Response.json({ok:false}, {status:409});
  }
  trace({ ordinal: item.ordinal, active: ++active });
  await new Promise(r => setTimeout(r, 5)); active--;
  const id = mode === 'duplicate-return' && item.ordinal === 1 ? 'replay-0' : 'replay-' + item.ordinal;
  if (mode === 'dropped-replay' && item.ordinal === 0) return Response.json({ok:true,envelope_id:id});
  record({event:'push',label:item.key,channel:item.channel,event_ts:item.ts,envelope_id:id,connection_id:'recovered',
    sent_mono_ms: mode === 'reply-before-root-ack' && parent ? 0 : recordSeq + 1});
  if (body.redeliver) record({event:'redelivery',envelope_id:id,original_envelope_id:body.redeliver.envelope_id});
  if (mode === 'unrecorded-envelope' && item.ordinal === 0)
    record({event:'push',envelope_id:'unrecorded',sent_mono_ms:recordSeq+1,connection_id:'recovered'});
  setTimeout(() => record({event:'ws-message',envelope_id:id,ack_mono_ms:recordSeq+1,connection_id:'recovered'}), item.phase === 'roots' ? 30 : 5);
  return Response.json({ok:true,envelope_id:id});
};
`
  test.each(['pass', 'dropped-replay', 'reply-before-root-ack', 'recorded-twice', 'duplicate-return', 'unrecorded-envelope'] as const)
  ('batched recovery %s preserves ledger identities and root ACK ordering', mode => withCLI((root, cli) => {
    const e = composed(true), key = e.plan.key, dir = join(root, 'e'); mkdirSync(dir)
    const roots = e.plan.items.filter(i => i.key === key && i.phase === 'roots').slice(0, 3)
    const replies = e.plan.items.filter(i => i.key === key && i.phase === 'replies' && roots.some(r => r.channel === i.channel && r.ts === i.root))
    e.plan.items = [...roots, ...replies, e.plan.items.find(i => i.key === key && i.phase === 'dropped')!,
      e.plan.items.find(i => i.key !== key && i.phase === 'roots')!].map((i, ordinal) => ({ ...i, ordinal }))
    const originals: FaultPush[] = e.plan.items.map(i => ({ ordinal: i.ordinal, stage: 'original',
      ...(i.ordinal === 0 ? { refusal: 'no-open-socket' } : { envelope_id: `original-${i.ordinal}` }) }))
    const stub: any[] = [], queues: Record<string, any[]> = Object.fromEntries(e.plan.keys.map(k => [k, []]))
    let seq = 0
    for (const i of e.plan.items) {
      if (i.ordinal === 0) stub.push({ event: 'push-refused', label: i.key, reason: 'no-open-socket', seq: ++seq })
      else {
        stub.push({ event: 'push', label: i.key, channel: i.channel, event_ts: i.ts, envelope_id: `original-${i.ordinal}`, sent_mono_ms: ++seq, seq, connection_id: 'original' })
        if (!i.dependent) stub.push({ event: 'ws-message', envelope_id: `original-${i.ordinal}`, ack_mono_ms: ++seq, seq, connection_id: 'original' })
      }
      if (i.phase !== 'dropped') queues[i.key].push({ kind: 'accepted', seq: i.ordinal + 1, channel: i.channel, ts: i.ts })
    }
    writeFileSync(join(dir, 'fault-plan.json'), JSON.stringify({ context: { scenario: 'test-fault', mode: 'strict', population: 0, recipients: 2 }, plan: e.plan }))
    writeFileSync(join(dir, 'fault-ledger.jsonl'), lines(mode === 'recorded-twice' ? [...originals,
      { ordinal: 0, stage: 'replay', envelope_id: 'duplicate' }, { ordinal: 0, stage: 'replay', envelope_id: 'duplicate' }] : originals))
    writeFileSync(join(dir, 'payloads.jsonl'), lines(e.plan.items.map(i => ({ label: i.key, event: { channel: i.channel, ts: i.ts, user: i.sender,
      ...(i.root !== '-' ? { thread_ts: i.root } : {}) } }))))
    writeFileSync(join(root, 'stub'), lines(stub)); writeFileSync(join(root, 'mode'), mode); writeFileSync(join(root, 'transport'), '')
    const child = cli('fault-recover', [dir, 'http://127.0.0.1:1', join(root, 'stub'), '500', '2'])
    expect(child.status).toBe(mode === 'pass' ? 0 : 1)
    const ledger = readFileSync(join(dir, 'fault-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ledger.filter(l => l.stage === 'original')).toEqual(originals)
    if (mode !== 'pass') {
      expect(child.stderr).toContain({ 'dropped-replay': 'recovery-deadline', 'reply-before-root-ack': 'recovery-root-order',
        'recorded-twice': 'recovery-ledger-invalid', 'duplicate-return': 'recovery-duplicate-envelope', 'unrecorded-envelope': 'recovery-unrecorded-envelope' }[mode])
      return
    }
    const replay = ledger.filter(l => l.stage === 'replay'), dependent = e.plan.items.filter(i => i.dependent)
    expect(replay).toHaveLength(dependent.length)
    expect(new Set(replay.map(l => l.ordinal)).size).toBe(dependent.length)
    expect(new Set(replay.map(l => l.envelope_id)).size).toBe(dependent.length)
    const trace = readFileSync(join(root, 'transport'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(trace.some(t => t.early_reply)).toBe(false); expect(Math.max(...trace.map(t => t.active))).toBe(2)
    const records = readFileSync(join(root, 'stub'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const during = envelopeTimings(originals.flatMap(o => o.envelope_id ? [o.envelope_id] : []), stub)
    const final = envelopeTimings(ledger.flatMap(l => l.envelope_id ? [l.envelope_id] : []), records)
    const accounts = e.plan.items.map(i => ({ key: i.key, channel: i.channel, ts: i.ts,
      kind: !i.dependent ? 'stored' : i.ordinal === 0 ? 'refused' : i.phase === 'dropped' ? 'withheld-dropped' : 'withheld',
      envelope_id: originals[i.ordinal].envelope_id ?? '-', refusal: originals[i.ordinal].refusal,
      recovered_id: replay.find(l => l.ordinal === i.ordinal)?.envelope_id ?? '-' }))
    expect(accountingVerdicts(accounts, records, during, final, queues, seq).every(r => r.verdict === 'pass')).toBe(true)
  }, recoveryTransport))
  test('fault CLI check reads every original, replay, snapshot and unchanged ordinary predicate', () => withCLI((root, cli) => {
    const e = composed(), dir = join(root, 'e'); mkdirSync(join(dir, 'during'), { recursive: true })
    writeFileSync(join(dir, 'fault-plan.json'), JSON.stringify({ context: { scenario: 'test-fault', mode: 'strict', population: 0, recipients: 2 }, plan: e.plan }))
    writeFileSync(join(dir, 'fault-ledger.jsonl'), lines(e.ledger!))
    writeFileSync(join(dir, 'during-times.jsonl'), lines(e.during!)); writeFileSync(join(dir, 'times.jsonl'), lines(e.times!))
    writeFileSync(join(dir, 'compactions.jsonl'), '')
    writeFileSync(join(root, 'stub'), lines(e.stub!)); writeFileSync(join(root, 'measurements'), lines(e.rows!))
    for (const key of e.plan.keys) {
      writeFileSync(join(dir, `${key}.queue.jsonl`), lines(e.queues[key]!))
      writeFileSync(join(dir, 'during', `${key}.queue.jsonl`), lines(e.duringQueues[key]!))
      writeFileSync(join(dir, `${key}.before.jsonl`), '')
      writeFileSync(join(dir, `${key}.after.jsonl`), lines(e.plan.items.filter(i => i.key === key && i.phase === 'roots').map(i => ({ channel: i.channel, root: i.ts }))))
    }
    const args = [dir, join(root, 'stub'), String(e.clearMark), String(e.clearAt), join(root, 'measurements'), '0', '0', '1']
    const pass = cli('fault-check', args)
    expect(pass.status).toBe(0); expect(String(pass.stdout)).toContain('fault-overlap'); expect(String(pass.stdout)).toContain('post-hold-overlap')
    const q = e.plan.items.find(i => i.key !== e.plan.key)!
    e.times!.find(t => t.envelope_id === `original-${q.ordinal}`)!.acks[0].ack_mono_ms++
    writeFileSync(join(dir, 'times.jsonl'), lines(e.times!))
    const fail = cli('fault-check', args)
    expect(fail.status).toBe(1); expect(String(fail.stdout)).toContain('verdict=fail'); expect(String(fail.stdout)).toContain('recorded: sr8 summary')
  }))
  test('fault CLI declares plan-derived dependencies and sends both waves without withheld ACKs', () => withCLI((root, cli) => {
    const e = composed(), batch = join(root, 'batches'), out = join(root, 'e'), state = join(root, 'state')
    mkdirSync(batch); mkdirSync(join(state, 'queue'), { recursive: true })
    const payloads = e.plan.items.map(i => ({ label: i.key, event: { channel: i.channel, ts: i.ts, user: i.sender, ...(i.root === '-' ? {} : { thread_ts: i.root }) } }))
    for (const phase of ['roots', 'replies', 'dropped', 'held']) writeFileSync(join(batch, `${phase}.batch.jsonl`), lines(payloads.filter((_, n) => e.plan.items[n].phase === phase)))
    const planned = e.plan.items.filter(i => i.key === e.plan.key && i.phase !== 'held').map(i => [i.phase, i.channel, i.ts, i.root, '-'].join('\t')).join('\n') + '\n'
    writeFileSync(join(root, 'plan.tsv'), planned); writeFileSync(join(root, 'stub'), ''); writeFileSync(join(root, 'measurements'), '')
    expect(cli('fault-plan', [batch, join(root, 'plan.tsv'), 'hang', '1', '1', out]).status).toBe(0)
    const declared = JSON.parse(readFileSync(join(out, 'fault-plan.json'), 'utf8')).plan
    expect(declared.items.map((i: any) => i.dependent)).toEqual(e.plan.items.map(i => i.dependent))
    expect(cli('fault-burst', [out, 'http://127.0.0.1:1', join(root, 'stub'), state, join(root, 'measurements'), '0', '100']).status).toBe(0)
    const ledger = readFileSync(join(out, 'fault-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ledger).toHaveLength(e.plan.items.length)
    expect(ledger[0].ordinal).toBe(e.plan.items.find(i => i.phase === 'held')!.ordinal)
    const pending = cli('fault-pending', [out]); expect(pending.status).toBe(0)
    expect(String(pending.stdout).trim().split('\n')).toHaveLength(e.plan.items.filter(i => i.dependent).length)
    expect(cli('fault-ids', [out]).status).toBe(0)
    expect(cli('fault-body', [out, '0']).status).toBe(0)
    expect(cli('fault-replayed', [out, '0', 'new-envelope']).status).toBe(0)
    expect(cli('fault-replayed', [out, '0', 'new-envelope']).status).toBe(64)
    // The retained original has not been replaced by the replay mapping.
    const final = readFileSync(join(out, 'fault-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(final.filter(l => l.ordinal === 0)).toHaveLength(2)
    const control = JSON.parse(readFileSync(join(out, 'fault-plan.json'), 'utf8'))
    for (const i of control.plan.items) i.dependent = false
    writeFileSync(join(out, 'fault-plan.json'), JSON.stringify(control))
    writeFileSync(join(root, 'measurements'), '')
    writeFileSync(join(state, 'queue', `${e.plan.keys[1]}.jsonl`), '')
    const healthy = join(root, 'healthy')
    expect(cli('burst', [batch, 'http://127.0.0.1:1', join(root, 'stub'), state, healthy, '100', join(root, 'measurements'), '0']).status).toBe(0)
    const ordinary = readFileSync(join(healthy, 'burst.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ordinary[0].phase).toBe('held')
    expect(ordinary.filter(i => i.phase === 'roots')).toHaveLength(2 * SR8_BURST_JOINS)
    rmSync(join(batch, 'held.batch.jsonl'))
    expect(cli('burst', [batch, 'http://127.0.0.1:1', join(root, 'stub'), state, join(root, 'healthy-no-held'), '100']).status).toBe(0)
  }, `
// Synthetic transport only in this copied CLI. No server or network is used.
let transportPlan;
globalThis.fetch = async (_url, init) => {
  const base = resolve(import.meta.dir, '../../..'), dir = join(base, 'e');
  const plan = transportPlan ??= JSON.parse(readFileSync(join(dir, 'fault-plan.json'), 'utf8')).plan;
  const b = JSON.parse(init.body), i = plan.items.find(i => i.key === b.label && i.channel === b.event.channel && i.ts === b.event.ts);
  const id = 'original-' + i.ordinal;
  appendFileSync(join(base,'stub'), JSON.stringify({event:'push',label:i.key,channel:i.channel,event_ts:i.ts,envelope_id:id})+'\\n');
  if (!i.dependent) appendFileSync(join(base,'stub'),JSON.stringify({event:'ws-message',envelope_id:id})+'\\n');
  if (i.phase === 'held') {
    appendFileSync(join(base,'state/queue',i.key+'.jsonl'),JSON.stringify({kind:'accepted',channel:i.channel,ts:i.ts,seq:i.ordinal+1})+'\\n');
    appendFileSync(join(base,'measurements'),JSON.stringify({v:1,kind:'store',store:'post-hold',key:i.key,seq:i.ordinal+1,at_mono_ms:1,store_ms:1})+'\\n');
  }
  return Response.json({ok:true,envelope_id:id});
};
`))
})

describe('SR-8 evidence verdicts (synthetic evidence, no runtime performance claim)', () => {
  const context = { scenario: 'test-control', mode: 'strict', population: 100_000, recipients: 1 } as const
  const key = 'alpha', other = 'beta'
  const item = (seq = 1) => ({ key, seq })
  const store = (seq = 1, ms = 5, kind = 'accepted', at = 100): Measurement =>
    ({ v: 1, kind: 'store', key, seq, store: kind, store_ms: ms, at_mono_ms: at })
  const times = (ms = SR8_ACK_LIMIT_MS, id = 'sample'): Times =>
    ({ envelope_id: id, push: { sent_mono_ms: 10, connection_id: 'connection' }, acks: [{ ack_mono_ms: 10 + ms, connection_id: 'connection' }] })
  const hold = (excess = SR8_DISPATCH_ALLOWANCE_MS, seq = 1, append = 5): Measurement[] => [
    { v: 1, kind: 'post-hold-resolved', at_mono_ms: 100, key, seq, outcome: 'released', cause: 'timer', held_ms: THREAD_REPLY_HOLD_MS + append + excess },
    { v: 1, kind: 'resolution-store', at_mono_ms: 100, key, seqs: [seq], store_ms: append },
  ]
  function n4(excess = SR8_DISPATCH_ALLOWANCE_MS) {
    const rows = [store(), store(1, 80, 'fixed', 100 + NAME_LOOKUP_TIMEOUT_MS + excess + 80)]
    const hung = { ...item(), sender: 'hung', envelope_id: 'sample' }, delayed = { ...item(2), sender: 'delayed', envelope_id: 'delayed-sample' }
    const samples = [{ ...item(), name: 'fallback' }, { ...item(2), name: 'resolved' }]
    const faults = [hung, delayed].map((s, i) => ({ event: 'fault', control: 'faults', method: 'users.info', label: key, match: s.sender, outcome: i === 0 ? 'hang' : 'delay', arrival_mono_ms: 1 }))
    return { rows, hung, delayed, samples, faults, times: [times()], run() {
      return n4Verdict(this.rows, this.hung, this.delayed, this.times, this.samples, this.faults, NAME_LOOKUP_TIMEOUT_MS)
    } }
  }
  function missing(r: Result) {
    expect(r.verdict).toBe('missing')
    const output: string[] = []
    expect(printResults(context, [r], line => output.push(line))).toBe(1)
    expect(output).toHaveLength(2)
    expect(output[0]).toContain('verdict=missing')
    expect(output[1]).toContain('missing=1')
  }
  test('pins the MI dispatch allowance and SRD-only verification bounds once', () => {
    expect(SR8_DISPATCH_ALLOWANCE_MS).toBe(100)
    expect(SR8_ACK_LIMIT_MS).toBe(3000)
    expect(SR8_STORE_LIMIT_MS).toBe(50)
  })
  test.each(['ack-accepted', 'ack-dropped'])('%s uses the maximum, inclusive N1', measure => {
    expect(ackVerdict(measure, ['sample'], [times()]).verdict).toBe('pass')
    expect(ackVerdict(measure, ['sample', 'slow'], [times(1), times(SR8_ACK_LIMIT_MS + 1, 'slow')]).verdict).toBe('fail')
    missing(ackVerdict(measure, ['sample'], [{ ...times(), acks: [] }]))
    missing(ackVerdict(measure, ['sample'], undefined))
    expect(ackVerdict(measure, ['sample'], [{ ...times(), acks: [times().acks[0], times().acks[0]] }]).verdict).toBe('fail')
  })
  test('store p99 is nearest rank over 1000 acceptances, strictly below the bound', () => {
    const accepts = Array.from({ length: 1000 }, (_, i) => item(i + 1))
    const rows = accepts.map((a, i) => store(a.seq, i < 989 ? 1 : i === 989 ? SR8_STORE_LIMIT_MS - .1 : 100))
    const got = storeVerdict(rows, accepts, percentile)
    expect(got.stats.p99_ms).toBe(SR8_STORE_LIMIT_MS - .1)
    expect(got.verdict).toBe('pass')
    rows[989].store_ms = SR8_STORE_LIMIT_MS
    expect(storeVerdict(rows, accepts, percentile).verdict).toBe('fail')
    rows[989].store_ms = SR8_STORE_LIMIT_MS + .1
    expect(storeVerdict(rows, accepts, percentile).verdict).toBe('fail')
  })
  test('fixation is excluded both from p99 and from completeness; identity matters', () => {
    expect(storeVerdict([store(), store(1, 10000, 'fixed')], [item()], percentile).verdict).toBe('pass')
    missing(storeVerdict([store(1, 1, 'fixed')], [item()], percentile))
    missing(storeVerdict([store(2)], [item()], percentile))
    missing(storeVerdict([{ ...store(), key: other }], [item()], percentile))
    missing(storeVerdict(undefined, [item()], percentile))
    missing(storeVerdict([], [item()], percentile))
    missing(storeVerdict([store()], [item(), item(2)], percentile))
  })
  test.each([[-20, 'pass'], [0, 'pass'], [SR8_DISPATCH_ALLOWANCE_MS, 'pass'], [SR8_DISPATCH_ALLOWANCE_MS + 1, 'fail']] as const)
  ('Post Hold excess %s: %s, signed excess and allowance always printed', (excess, verdict) => {
    const r = postHoldVerdict(hold(excess), [item()], THREAD_REPLY_HOLD_MS)
    expect(r.verdict).toBe(verdict)
    expect(resultLine(context, r)).toContain(`excess_ms=${excess} allowance_ms=${SR8_DISPATCH_ALLOWANCE_MS} limit=hold_ms+own_append verdict=${verdict}`)
  })
  test('Post Hold matches its own key and seqs member, never the largest append', () => {
    const rows = [...hold(SR8_DISPATCH_ALLOWANCE_MS + 1), ...hold(-1, 2, 1000)]
    rows[1].seqs = [7, 1, 8]
    expect(postHoldVerdict(rows, [item(), item(2)], THREAD_REPLY_HOLD_MS).verdict).toBe('fail')
    rows[1].key = other
    missing(postHoldVerdict(rows, [item()], THREAD_REPLY_HOLD_MS))
  })
  test('a parked hold uses its first resolution append, before its later Memory Hold append', () => {
    const rows = hold(SR8_DISPATCH_ALLOWANCE_MS + 1)
    rows[0].outcome = 'parked'
    rows.push({ ...rows[1], at_mono_ms: 200, store_ms: 1000 })
    expect(postHoldVerdict(rows, [item()], THREAD_REPLY_HOLD_MS).verdict).toBe('fail')
  })
  test.each(['resolution', 'append', 'seq', 'restart'] as const)('Post Hold missing %s cannot pass', what => {
    const rows = hold()
    if (what === 'resolution') rows.shift()
    if (what === 'append') rows.pop()
    if (what === 'seq') rows[1].seqs = [2]
    if (what === 'restart') { delete rows[0].held_ms; rows[0].cause = 'restart' }
    missing(postHoldVerdict(rows, [item()], THREAD_REPLY_HOLD_MS))
  })
  test.each([[0, 'pass'], [SR8_DISPATCH_ALLOWANCE_MS, 'pass'], [SR8_DISPATCH_ALLOWANCE_MS + 1, 'fail']] as const)
  ('N4 excess %s: %s from fixed START, with fields printed', (excess, verdict) => {
    const r = n4(excess).run()
    expect(r.verdict).toBe(verdict)
    expect(r.stats.fallback_ms).toBe(NAME_LOOKUP_TIMEOUT_MS + excess)
    expect(resultLine(context, r)).toContain(`excess_ms=${excess} allowance_ms=${SR8_DISPATCH_ALLOWANCE_MS}`)
  })
  test('N4 excludes a tempting faster fixed/accepted record of another seq or key', () => {
    const f = n4(SR8_DISPATCH_ALLOWANCE_MS + 1)
    f.rows.unshift(store(2, 1, 'fixed', 150), store(2, 1, 'accepted', 120))
    f.rows.unshift({ ...store(1, 1, 'fixed', 150), key: other })
    expect(f.run().verdict).toBe('fail')
  })
  test('N4 rejects resolved hung names and an ACK exceeding N1', () => {
    const f = n4()
    f.samples[0].name = 'resolved'
    expect(f.run().verdict).toBe('fail')
    f.samples[0].name = 'fallback'; f.times = [times(SR8_ACK_LIMIT_MS + 1)]
    expect(f.run().verdict).toBe('fail')
  })
  test.each(['n2', 'accepted', 'fixed', 'wrong-fixed-seq', 'hung-fault', 'delayed-fault', 'ack'] as const)
  ('N4 missing %s remains missing with allowance fields and nonzero exit', what => {
    const f = n4()
    if (what === 'n2') f.samples.shift()
    if (what === 'accepted') f.rows.shift()
    if (what === 'fixed') f.rows.pop()
    if (what === 'wrong-fixed-seq') f.rows[1].seq = 2
    if (what === 'hung-fault') f.faults.shift()
    if (what === 'delayed-fault') f.faults.pop()
    if (what === 'ack') f.times[0].acks = []
    const r = f.run(); missing(r)
    expect(resultLine(context, r)).toContain('excess_ms=')
    expect(resultLine(context, r)).toContain(`allowance_ms=${SR8_DISPATCH_ALLOWANCE_MS}`)
  })
  const report = buildThreadMemoryChangedWhileStoppedLine(key, [], 'entry-missing', 'changed')
  test('seal first requires exactly one report per seeded persona; measured rejects every report', () => {
    expect(sealVerdict('first', [key], [report], THREAD_MEMORY_CHANGED_WHILE_STOPPED, [report]).verdict).toBe('pass')
    for (const lines of [[], [report, report]]) expect(sealVerdict('first', [key], lines, THREAD_MEMORY_CHANGED_WHILE_STOPPED, [report]).verdict).toBe('fail')
    expect(sealVerdict('measured', [key], [], THREAD_MEMORY_CHANGED_WHILE_STOPPED, []).verdict).toBe('pass')
    expect(sealVerdict('measured', [key], [report], THREAD_MEMORY_CHANGED_WHILE_STOPPED, []).verdict).toBe('fail')
    missing(sealVerdict('measured', [key], undefined, THREAD_MEMORY_CHANGED_WHILE_STOPPED, []))
  })
  test('population zero has no seed/first start and measured rejects even a foreign report', () => {
    expect(() => requireSeedPopulation(0)).toThrow('usage')
    expect(() => sealVerdict('first', [], [], THREAD_MEMORY_CHANGED_WHILE_STOPPED, [])).toThrow('usage')
    expect(sealVerdict('measured', [], [], THREAD_MEMORY_CHANGED_WHILE_STOPPED, []).verdict).toBe('pass')
    expect(sealVerdict('measured', [], [report], THREAD_MEMORY_CHANGED_WHILE_STOPPED, []).verdict).toBe('fail')
  })
  test('external startup time is recorded without an upper bound; missing timestamps stay missing', () => {
    expect(startupVerdict(1, 1_000_001, 100000).verdict).toBe('recorded')
    expect(startupVerdict(10, 11, 0).stats.start_to_ready_ms).toBe(1)
    missing(startupVerdict(NaN, 11, 100000))
  })
  describe('startup-load CLI', () => {
    function startup(args: string[], mode = 'strict', population = 100_000, recipients = 1) {
      const root = mkdtempSync(join(tmpdir(), 'sr8-startup-control-'))
      try {
        // Run the actual dispatcher/entry point in a scratch copy. Only its image
        // marker is redirected; no host marker, packed server or burst files exist.
        const marker = join(root, 'ci-image'), script = join(root, 'sr8-evidence.ts')
        const original = source('fixtures/sr8-evidence.ts')
        const guard = "existsSync('/etc/cscb-ci-image')"
        expect(original).toContain(guard)
        writeFileSync(marker, '')
        writeFileSync(script, original.replace(guard, `existsSync(${JSON.stringify(marker)})`))
        const child = spawnSync(process.execPath, [script, 'startup-load', 'test-startup', mode, String(population), String(recipients), ...args], {
          env: hostSafeChildEnv(root), encoding: 'utf8', timeout: 3000,
        })
        expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
        assertNoLeak({ stdout: child.stdout, stderr: child.stderr })
        return child
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
    test.each([
      ['strict', 100_000, 1, '10', '1010', 1000, 100_000],
      ['open', 100_000, 2, '10.25', '1000010.75', 1000000.5, 200_000],
      ['strict', 0, 1, '0', '0', 0, 0],
    ] as const)('records %s population=%s recipients=%s without burst evidence', (mode, population, recipients, start, ready, elapsed, joined) => {
      const child = startup([start, ready], mode, population, recipients)
      expect(child.status).toBe(0)
      expect(child.stderr).toBe('')
      expect(child.stdout).toBe(
        `recorded: sr8 startup-load scenario=test-startup mode=${mode} population=${population} recipients=${recipients} samples=${joined} joined=${joined} start_to_ready_ms=${elapsed} limit=none verdict=recorded\n`
        + 'recorded: sr8 summary scenario=test-startup measures=1 pass=0 fail=0 missing=0\n')
    })
    test.each([
      ['missing start', ['', '1010']], ['missing ready', ['10', '']],
      ['omitted both', []], ['omitted ready', ['10']],
      ['blank start', [' ', '1010']], ['blank ready', ['10', ' ']],
      ['malformed start', ['invalid', '1010']], ['malformed ready', ['10', 'invalid']],
      ['nonfinite start', ['NaN', '1010']], ['nonfinite ready', ['10', 'Infinity']],
      ['negative start', ['-1', '1010']], ['reversed times', ['1010', '10']],
    ])('%s prints missing and exits 1', (_label, args) => {
      const child = startup(args as string[])
      expect(child.status).toBe(1)
      expect(child.stderr).toBe('')
      const lines = child.stdout.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^recorded: sr8 startup-load scenario=test-startup mode=strict population=100000 recipients=1 samples=100000 joined=100000 start_to_ready_ms=\S+ limit=none verdict=missing$/)
      expect(lines[1]).toBe('recorded: sr8 summary scenario=test-startup measures=1 pass=0 fail=0 missing=1')
    })
    test.each([0, 1])('malformed timestamp %s never echoes sentinel text', index => {
      const args = ['10', '1010']
      args[index] = fakeToken(BOT_TOKEN_PREFIX)
      const child = startup(args)
      expect(child.status).toBe(1)
      expect(child.stderr).toBe('')
      expect(child.stdout).toContain('start_to_ready_ms=missing limit=none verdict=missing\n')
    })
  })
  test('both compactions need distinct existing file identities INSIDE the burst', () => {
    const rows = ['queue', 'threads'].map(kind => ({ key, kind, before: '1:1', after: '1:2', inside: true }))
    expect(compactionVerdict(rows, [key], true).verdict).toBe('pass')
    missing(compactionVerdict(undefined, [key], true))
    missing(compactionVerdict(rows.slice(1), [key], true))
    for (const change of [{ inside: false }, { after: '1:1' }, { before: '' }]) missing(compactionVerdict([{ ...rows[0], ...change }, rows[1]], [key], true))
  })
  test('joins preserve each oldest identity, not only the count', () => {
    const old = [{ channel: 'channel', root: '1' }], added = [{ channel: 'channel', root: '2' }]
    expect(joinsVerdict(old, [...old, ...added], old, added, 1).verdict).toBe('pass')
    expect(joinsVerdict(old, [...added, { channel: 'channel', root: '3' }], old, added, 1).verdict).toBe('fail')
    missing(joinsVerdict(undefined, [...old, ...added], old, added, 1))
  })
  test('N2 sample counts are distinct and all required samples remain present', () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ ...item(i + 1), name: 'fallback' }))
    expect(n2Verdict(samples, 20).verdict).toBe('pass')
    missing(n2Verdict(samples.slice(1), 20))
    missing(n2Verdict([...samples.slice(1), samples[1]], 20))
    missing(n2Verdict(undefined, 20))
    expect(n2Samples(`recorded: sr8 n2-sample key=${key} seq=1 name=fallback typing_ms=1`)).toEqual([samples[0]])
  })
  test('N3 exactly 40 versus 41 calls, sliding boundaries and per-persona accounting', () => {
    const budget = DELIVERY_MAX_AD_CALLS_PER_S * 10, empty = [{ instance: key, start: 30000, end: 40000 }]
    const active = [{ instance: key, start: 0, end: 30000 }]
    expect(budget).toBe(40)
    const calls = Array.from({ length: budget }, () => ({ instance: key, ms: 9999 }))
    expect(windowsVerdict(calls, empty, DELIVERY_MAX_AD_CALLS_PER_S, active).verdict).toBe('pass')
    expect(windowsVerdict([...calls, { instance: key, ms: 10000 }], empty, DELIVERY_MAX_AD_CALLS_PER_S, active).verdict).toBe('fail')
    expect(windowsVerdict([...calls, { instance: key, ms: 19999 }], empty, DELIVERY_MAX_AD_CALLS_PER_S, active).verdict).toBe('pass')
    expect(windowsVerdict([...calls, ...calls.map(c => ({ ...c, instance: other }))], [...empty, { ...empty[0], instance: other }], DELIVERY_MAX_AD_CALLS_PER_S, [...active, { ...active[0], instance: other }]).verdict).toBe('pass')
    expect(windowsVerdict([...calls, { instance: key, ms: 30000 }], empty, DELIVERY_MAX_AD_CALLS_PER_S, active).verdict).toBe('fail')
    missing(windowsVerdict(calls, undefined, DELIVERY_MAX_AD_CALLS_PER_S, active))
  })
  test.each(['pass', 'empty-active', 'missing-instance', 'wrong-phase'] as const)('N3 requires declared active instance coverage: %s', defect => {
    const active = [key, other].map(instance => ({ instance, start: 1000, end: 2000 }))
    const empty = active.map(a => ({ instance: a.instance, start: 3000, end: 4000 }))
    const calls = defect === 'empty-active' ? [] : active.slice(0, defect === 'missing-instance' ? 1 : 2)
      .map(a => ({ instance: a.instance, ms: defect === 'wrong-phase' ? 500 : 1500 }))
    const got = windowsVerdict(calls, empty, DELIVERY_MAX_AD_CALLS_PER_S, active)
    expect(got.verdict).toBe(defect === 'pass' ? 'pass' : 'missing')
    expect(evidenceExit([got])).toBe(defect === 'pass' ? 0 : 1)
  })
  test('all result lines precede failure, summary counts exclude recorded from pass, and raw evidence never leaks', () => {
    const sentinel = fakeToken(BOT_TOKEN_PREFIX)
    const good = { ...store(), text: sentinel }, failed = postHoldVerdict(hold(SR8_DISPATCH_ALLOWANCE_MS + 1), [item()], THREAD_REPLY_HOLD_MS)
    const rows = [storeVerdict([good], [item()], percentile), failed, storeVerdict(undefined, [item()], percentile), startupVerdict(1, 2, 100000)]
    const lines: string[] = []
    expect(printResults(context, rows, line => lines.push(line))).toBe(1)
    expect(lines).toHaveLength(5)
    expect(summary(context, rows)).toBe('recorded: sr8 summary scenario=test-control measures=4 pass=1 fail=1 missing=1')
    expect(evidenceExit([rows[0], rows[3]])).toBe(0)
    expect(lines[0]).toMatch(/^recorded: sr8 store scenario=test-control mode=strict population=100000 recipients=1 samples=1 p99_ms=5 accepted=1 limit=50 verdict=pass$/)
    assertNoLeak(lines.join('\n'), sentinel)
  })
})
